use crate::app_state::AppState;
use crate::services::account_history::AccountInfoDto;
use crate::services::ctrader::oauth;
use crate::services::ctrader::symbols;
use crate::services::ctrader::snapshot::build_tcp_snapshot_message;
use crate::services::proto_oa::{self, build_master_snapshot};
use crate::services::pos_mapping;
use crate::state::AccountEntry;
use crate::timings::{CTRADER_CONNECT_TIMEOUT_SECS, CTRADER_HEARTBEAT_INTERVAL_SECS, CTRADER_SNAPSHOT_RECONNECT_DELAY_SECS};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;
use tracing::info;

const SNAPSHOT_POLL_INTERVAL_MS: u64 = 500;

pub async fn run_snapshot_connection(
    account_id: String,
    entry: AccountEntry,
    app_state: Option<Arc<AppState>>,
    mut disconnect_rx: watch::Receiver<u32>,
) {
    let client_id = match entry.client_id.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => c.to_string(),
        None => return,
    };
    let client_secret = match entry.client_secret.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => return,
    };
    let access_token = match entry.access_token.as_deref().filter(|s| !s.is_empty()) {
        Some(t) => t.to_string(),
        None => return,
    };
    let ctid = entry
        .ctid_trader_account_id
        .unwrap_or_else(|| account_id.parse().unwrap_or(0));
    let is_live = entry.is_live.unwrap_or(false);
    let host = oauth::protooa_host_for_account(is_live);
    let url = format!("wss://{}:{}", host, oauth::protooa_port());

    let timeout = std::time::Duration::from_secs(15);
    let connect_timeout = std::time::Duration::from_secs(CTRADER_CONNECT_TIMEOUT_SECS);

    loop {
        if let Some(ref state) = app_state {
            if let Some(ref mgr) = state.state_manager {
                let copier_on = mgr
                    .read(|s| s.preferences.as_ref().map_or(true, |p| p.global_copier_enabled))
                    .await;
                if !copier_on {
                    return;
                }
            }
        }
        match run_snapshot_loop(
            &account_id,
            ctid,
            &client_id,
            &client_secret,
            &access_token,
            &url,
            connect_timeout,
            timeout,
            app_state.as_ref(),
            &mut disconnect_rx,
        )
        .await
        {
            Ok(()) => return,
            Err(_e) => {
                tokio::time::sleep(std::time::Duration::from_secs(CTRADER_SNAPSHOT_RECONNECT_DELAY_SECS)).await;
            }
        }
    }
}

async fn run_snapshot_loop(
    account_id: &str,
    ctid: u64,
    client_id: &str,
    client_secret: &str,
    access_token: &str,
    url: &str,
    connect_timeout: std::time::Duration,
    timeout: std::time::Duration,
    app_state: Option<&Arc<AppState>>,
    disconnect_rx: &mut watch::Receiver<u32>,
) -> Result<(), String> {
    let (ws_stream, _) = tokio::time::timeout(connect_timeout, connect_async(url))
        .await
        .map_err(|_| format!("connect timeout after {:?}", connect_timeout))?
        .map_err(|e| format!("connect: {}", e))?;

    let (mut write, mut read) = ws_stream.split();

    let auth_body = proto_oa::encode_application_auth_req(client_id, client_secret);
    tokio::time::timeout(timeout, write.send(Message::Binary(auth_body)))
        .await
        .map_err(|_| "send app auth timeout")?
        .map_err(|e| format!("send app auth: {}", e))?;

    for _ in 0..10 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait app auth timeout")?
            .ok_or("connection closed before app auth")?
            .map_err(|e| format!("read: {}", e))?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_APPLICATION_AUTH_RES {
                    break;
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                    return Err(format!("app auth rejected: {} - {}", c, d));
                }
            }
        }
    }

    let acc_auth = proto_oa::encode_account_auth_req(ctid, access_token);
    tokio::time::timeout(timeout, write.send(Message::Binary(acc_auth)))
        .await
        .map_err(|_| "send account auth timeout")?
        .map_err(|e| format!("send account auth: {}", e))?;

    for _ in 0..10 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait account auth timeout")?
            .ok_or("connection closed before account auth")?
            .map_err(|e| format!("read: {}", e))?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, _)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_ACCOUNT_AUTH_RES {
                    break;
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    return Err("account auth rejected".into());
                }
            }
        }
    }

    info!(account_id = %account_id, "ctrader snapshot connection established (isolated from copy)");

    let (asset_id_to_name, symbol_lot_sizes, symbol_digits, symbol_id_to_name) =
        load_symbols_for_snapshot(ctid, &mut write, &mut read, timeout).await?;

    let mut heartbeat_interval =
        tokio::time::interval(std::time::Duration::from_secs(CTRADER_HEARTBEAT_INTERVAL_SECS));
    heartbeat_interval.tick().await;
    let mut poll_interval = tokio::time::interval(std::time::Duration::from_millis(SNAPSHOT_POLL_INTERVAL_MS));
    poll_interval.tick().await;

    let pos_id_to_ord_id = pos_mapping::load(account_id);

    loop {
        tokio::select! {
            biased;
            res = disconnect_rx.changed() => {
                let _ = res;
                return Ok(());
            }
            _ = heartbeat_interval.tick() => {
                let hb = proto_oa::encode_heartbeat();
                if tokio::time::timeout(timeout, write.send(Message::Binary(hb)))
                    .await
                    .map_err(|_| "heartbeat timeout")?
                    .is_err()
                {
                    return Err("heartbeat send failed".into());
                }
            }
            _ = poll_interval.tick() => {
                if let Err(e) = fetch_and_publish_snapshot(
                    account_id,
                    ctid,
                    &asset_id_to_name,
                    &symbol_lot_sizes,
                    &symbol_digits,
                    &symbol_id_to_name,
                    &pos_id_to_ord_id,
                    &mut write,
                    &mut read,
                    timeout,
                    app_state,
                )
                .await
                {
                    return Err(e);
                }
            }
        }
    }
}

async fn load_symbols_for_snapshot(
    ctid: u64,
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    read: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    timeout: std::time::Duration,
) -> Result<
    (
        HashMap<i64, String>,
        HashMap<u64, i64>,
        HashMap<u64, u32>,
        HashMap<u64, String>,
    ),
    String,
> {
    let mut asset_id_to_name: HashMap<i64, String> = HashMap::new();
    let asset_req = proto_oa::encode_asset_list_req(ctid);
    tokio::time::timeout(timeout, write.send(Message::Binary(asset_req)))
        .await
        .map_err(|_| "send asset list timeout")?
        .map_err(|e| e.to_string())?;

    for _ in 0..30 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait asset list timeout")?
            .ok_or("connection closed")?
            .map_err(|e| e.to_string())?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_ASSET_LIST_RES {
                    if let Ok(assets) = proto_oa::parse_asset_list_res(&pl) {
                        for (id, name) in assets {
                            asset_id_to_name.insert(id, name);
                        }
                        break;
                    }
                }
            }
        }
    }

    let mut symbols_by_name: HashMap<String, u64> = HashMap::new();
    let mut initial_id_to_name: HashMap<u64, String> = HashMap::new();
    let sym_req = proto_oa::encode_symbols_list_req(ctid);
    tokio::time::timeout(timeout, write.send(Message::Binary(sym_req)))
        .await
        .map_err(|_| "send symbols timeout")?
        .map_err(|e| e.to_string())?;

    for _ in 0..30 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait symbols timeout")?
            .ok_or("connection closed")?
            .map_err(|e| e.to_string())?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_SYMBOLS_LIST_RES {
                    if let Ok(result) = proto_oa::parse_symbols_list_res(&pl) {
                        symbols_by_name = result.by_name;
                        initial_id_to_name = result.id_to_name;
                        for (sym_id, base_aid, quote_aid) in &result.unnamed_asset_pairs {
                            let base_name = asset_id_to_name.get(base_aid).cloned().unwrap_or_default();
                            let quote_name = asset_id_to_name.get(quote_aid).cloned().unwrap_or_default();
                            if !base_name.is_empty() && !quote_name.is_empty() {
                                let constructed = format!("{}{}", base_name, quote_name);
                                if !symbols_by_name.contains_key(&constructed) {
                                    symbols_by_name.insert(constructed, *sym_id);
                                }
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    let known_ids: HashSet<u64> = symbols_by_name.values().copied().collect();
    let mut all_ids: Vec<u64> = known_ids.iter().copied().collect();
    let max_known = all_ids.iter().copied().max().unwrap_or(0);
    for id in 1..=(max_known + 50).max(200) {
        if !known_ids.contains(&id) {
            all_ids.push(id);
        }
    }
    let sym_by_id_req = proto_oa::encode_symbol_by_id_req(ctid, &all_ids);
    tokio::time::timeout(timeout, write.send(Message::Binary(sym_by_id_req)))
        .await
        .map_err(|_| "send symbol by id timeout")?
        .map_err(|e| e.to_string())?;

    let mut symbol_lot_sizes = HashMap::new();
    let mut symbol_digits = HashMap::new();
    let mut symbol_id_to_name = initial_id_to_name;
    for _ in 0..30 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait symbol by id timeout")?
            .ok_or("connection closed")?
            .map_err(|e| e.to_string())?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_SYMBOL_BY_ID_RES {
                    if let Ok(mut result) = proto_oa::parse_symbol_by_id_res_full(&pl) {
                        symbol_lot_sizes = std::mem::take(&mut result.lot_sizes);
                        symbol_digits = std::mem::take(&mut result.digits);
                        symbols::merge_symbol_by_id_result(&result, &mut symbols_by_name, &mut symbol_id_to_name);
                        break;
                    }
                }
            }
        }
    }

    Ok((asset_id_to_name, symbol_lot_sizes, symbol_digits, symbol_id_to_name))
}

async fn fetch_and_publish_snapshot(
    account_id: &str,
    ctid: u64,
    asset_id_to_name: &HashMap<i64, String>,
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_digits: &HashMap<u64, u32>,
    symbol_id_to_name: &HashMap<u64, String>,
    pos_id_to_ord_id: &HashMap<i64, i64>,
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    read: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    timeout: std::time::Duration,
    app_state: Option<&Arc<AppState>>,
) -> Result<(), String> {
    let reconcile_req = proto_oa::encode_reconcile_req(ctid);
    let pnl_req = proto_oa::encode_get_position_unrealized_pnl_req(ctid);
    let trader_req = proto_oa::encode_trader_req(ctid);

    tokio::time::timeout(timeout, write.send(Message::Binary(reconcile_req)))
        .await
        .map_err(|_| "send reconcile timeout")?
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(timeout, write.send(Message::Binary(pnl_req)))
        .await
        .map_err(|_| "send pnl timeout")?
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(timeout, write.send(Message::Binary(trader_req)))
        .await
        .map_err(|_| "send trader timeout")?
        .map_err(|e| e.to_string())?;

    let mut positions: Option<Vec<proto_oa::SlavePosition>> = None;
    let mut orders: Option<Vec<proto_oa::SlaveOrder>> = None;
    let mut pnl_map: Option<HashMap<i64, f64>> = None;
    let mut trader_info: Option<proto_oa::TraderInfo> = None;

    for _ in 0..40 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait snapshot responses timeout")?
            .ok_or("connection closed")?
            .map_err(|e| e.to_string())?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_RECONCILE_RES {
                    let (pos, ord) =
                        proto_oa::parse_reconcile_res(&pl, symbol_lot_sizes, symbol_digits)
                            .map_err(|e| format!("parse reconcile: {}", e))?;
                    positions = Some(pos);
                    orders = Some(ord);
                }
                if pt == proto_oa::PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES {
                    if let Ok(map) = proto_oa::parse_get_position_unrealized_pnl_res(&pl) {
                        pnl_map = Some(map);
                    }
                }
                if pt == proto_oa::PROTO_OA_TRADER_RES {
                    if let Ok(info) = proto_oa::parse_trader_res(&pl) {
                        trader_info = Some(info);
                    }
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                    return Err(format!("request rejected: {} - {}", c, d));
                }
            }
        }
        if positions.is_some() && pnl_map.is_some() && trader_info.is_some() {
            break;
        }
    }

    let positions = positions.unwrap_or_default();
    let orders = orders.unwrap_or_default();
    let pnl_map = pnl_map.unwrap_or_default();
    let trader_info = trader_info.ok_or("trader info not received")?;

    let (pos_map, ord_map) = build_master_snapshot(&positions, &orders, symbol_id_to_name);
    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    let unrealized_pnl: f64 = pnl_map.values().sum();
    let currency = trader_info
        .currency_deposit_asset_id
        .and_then(|id| asset_id_to_name.get(&id).cloned());
    let account = AccountInfoDto {
        account_id: account_id.to_string(),
        server: trader_info.broker_name,
        currency,
        balance: Some(round2(trader_info.balance)),
        equity: trader_info.equity.map(round2).or_else(|| {
            Some(round2(trader_info.balance + pnl_map.values().sum::<f64>()))
        }),
        unrealized_pnl: Some(round2(unrealized_pnl)),
        leverage: trader_info.leverage,
        margin: None,
    };

    let account_for_cache = account.clone();
    let local_now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let max_open_ms = pos_map.values().map(|p| p.open_timestamp_ms).max().unwrap_or(0);
    let server_now_ms = if max_open_ms > local_now_ms { max_open_ms } else { local_now_ms };
    let snapshot = build_tcp_snapshot_message(
        &pos_map,
        &ord_map,
        "snapshot",
        pos_id_to_ord_id,
        account,
        Some(&pnl_map),
        server_now_ms,
    );

    if let Some(state) = app_state {
        state
            .ctrader_snapshot_cache
        .write()
        .await
        .insert(account_id.to_string(), snapshot);
        state
            .account_info_cache
            .write()
            .await
            .insert(account_id.to_string(), account_for_cache);
        let _ = state.orders_ws_notify_tx.send(());
    }

    Ok(())
}
