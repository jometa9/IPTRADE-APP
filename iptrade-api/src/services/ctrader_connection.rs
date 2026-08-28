
use crate::app_state::{AppState, CtraderRealtimeStats};
use crate::services::account_history::AccountInfoDto;
use crate::services::copy_command::CopyCommand;
use crate::services::proto_oa::{
    self, build_master_snapshot, diff_master_snapshots, MasterOrderRow, MasterPositionRow,
};
use crate::services::tcp_bridge::TcpServer;
use crate::state::LocalStateFileManager;
use crate::util;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, watch, RwLock, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;

use crate::timings::{
    COPY_MASTER_SNAPSHOT_INTERVAL_MS, CTRADER_ACCOUNT_INFO_POLL_SECS,
    CTRADER_CONNECT_TIMEOUT_SECS, CTRADER_HEARTBEAT_INTERVAL_SECS, CTRADER_IDLE_RECV_TIMEOUT_SECS,
    CTRADER_MANAGER_POLL_SECS, CTRADER_NO_TOKENS_SLEEP_SECS, CTRADER_PROTOOA_TIMEOUT_SECS,
    CTRADER_RECONNECT_TOTAL_TIMEOUT_SECS, CTRADER_RETRY_CREDENTIALS_BACKOFF_SECS,
    CTRADER_SERVER_MAINTENANCE_RETRY_SECS, CTRADER_CANT_ROUTE_RETRY_SECS,
};
use tracing::{info, warn};

use crate::services::ctrader::{
    account_loop,
    copy_executor,
    ctrader_temporary_broker_reconnect_type, is_ctrader_invalid_credentials_error,
    is_ctrader_temporary_broker_error, snapshot, symbols, DISCONNECT_REQUESTED,
};

async fn update_realtime_stats_cache(
    account_id: &str,
    app_state: Option<&Arc<AppState>>,
    positions_len: usize,
    orders_len: usize,
) {
    let Some(state) = app_state else { return };
    state.ctrader_realtime_stats_cache.write().await.insert(
        account_id.to_string(),
        CtraderRealtimeStats {
            open_positions: positions_len as u32,
            pending_orders: orders_len as u32,
            balance: None,
            unrealized_pnl: None,
        },
    );
    let _ = state.orders_ws_notify_tx.send(());
}

async fn try_update_live_account_info_cache(
    account_id: &str,
    trader_info: &mut Option<proto_oa::TraderInfo>,
    assets: &mut Option<std::collections::HashMap<i64, String>>,
    pnl_map: &mut Option<std::collections::HashMap<i64, f64>>,
    pending: &mut bool,
    pending_since: &mut Option<Instant>,
    app_state: Option<&Arc<AppState>>,
) {
    if !*pending || trader_info.is_none() || assets.is_none() || pnl_map.is_none() {
        return;
    }
    let info = trader_info.take().unwrap();
    let asset_map = assets.take().unwrap();
    let pnl = pnl_map.take().unwrap();

    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    let currency = info.currency_deposit_asset_id
        .and_then(|id| asset_map.get(&id).cloned());
    let balance = Some(info.balance);
    let equity = info.equity.or_else(|| balance.map(|b| b + pnl.values().sum::<f64>()));
    let unrealized_pnl = balance.and_then(|b| equity.map(|e| round2(e - b)));

    let dto = AccountInfoDto {
        account_id: account_id.to_string(),
        server: info.broker_name,
        currency,
        balance: balance.map(round2),
        equity: equity.map(round2),
        unrealized_pnl,
        leverage: info.leverage,
        margin: None,
    };
    if let Some(state) = app_state {
        state.account_info_cache.write().await.insert(account_id.to_string(), dto);
        let _ = state.orders_ws_notify_tx.send(());
    }
    *pending = false;
    *pending_since = None;
}

async fn run_account_ws(
    account_id: String,
    state_manager: Option<Arc<LocalStateFileManager>>,
    tcp_server: Option<Arc<TcpServer>>,
    running: Arc<RwLock<HashSet<String>>>,
    app_state: Option<Arc<AppState>>,
    mut disconnect_rx: watch::Receiver<u32>,
) {
    let deadline = Instant::now() + std::time::Duration::from_secs(CTRADER_RECONNECT_TOTAL_TIMEOUT_SECS);
    let reconnect_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(CTRADER_RECONNECT_TOTAL_TIMEOUT_SECS);
    loop {
        let (entry, role) = match &state_manager {
            Some(mgr) => {
                let snap = mgr.read(|s| {
                    s.accounts.get(&account_id).cloned().map(|e| {
                        let r = e.role.as_deref().unwrap_or("").to_string();
                        (e, r)
                    })
                }).await;
                match snap {
                    Some((e, r)) => (e, r),
                    None => {
                        running.write().await.remove(&account_id);
                        if let Some(ref state) = app_state {
                            state.ctrader_running_since.write().await.remove(&account_id);
                            state.ctrader_connected_accounts.write().await.remove(&account_id);
                        }
                        return;
                    }
                }
            }
            None => {
                running.write().await.remove(&account_id);
                if let Some(ref state) = app_state {
                    state.ctrader_running_since.write().await.remove(&account_id);
                    state.ctrader_connected_accounts.write().await.remove(&account_id);
                }
                return;
            }
        };

        let can_try = entry.reconnect_type.as_deref() != Some("reauth_oauth");
        if entry.platform != "ctrader" || !can_try {
            if entry.reconnect_type.as_deref() == Some("reauth_oauth") {
                info!(account_id = %account_id, "ctrader ProtoOA: skipping account (reauth_oauth set)");
            }
            running.write().await.remove(&account_id);
            if let Some(ref state) = app_state {
                state.ctrader_running_since.write().await.remove(&account_id);
                state.ctrader_connected_accounts.write().await.remove(&account_id);
            }
            return;
        }
        let (client_id, client_secret, access_token) = match (
            entry.client_id.as_deref(),
            entry.client_secret.as_deref(),
            entry.access_token.as_deref(),
        ) {
            (Some(cid), Some(csec), Some(tok)) if !cid.is_empty() && !csec.is_empty() && !tok.is_empty() => {
                (cid.to_string(), csec.to_string(), tok.to_string())
            }
            _ => {
                tokio::time::sleep(std::time::Duration::from_secs(CTRADER_NO_TOKENS_SLEEP_SECS)).await;
                continue;
            }
        };

        let is_live = entry.is_live.unwrap_or(false);
        let host = crate::services::ctrader::oauth::protooa_host_for_account(is_live);
        let url = format!("wss://{}:{}", host, crate::services::ctrader::oauth::protooa_port());

        let (connected_tx, mut connected_rx) = oneshot::channel::<()>();
        let (copy_tx, copy_rx) = mpsc::channel::<CopyCommand>(64);
        if let Some(ref state) = app_state {
            state.copy_command_tx.write().await.insert(account_id.clone(), copy_tx);
        }
        let account_id_clone = account_id.clone();
        let role_clone = role.clone();
        let url_clone = url.to_string();
        let client_id_clone = client_id.to_string();
        let client_secret_clone = client_secret.to_string();
        let access_token_clone = access_token.to_string();
        let ctid = entry
            .ctid_trader_account_id
            .unwrap_or_else(|| account_id.parse().unwrap_or(0));
        let tcp_server_clone = tcp_server.clone();
        let app_state_clone = app_state.clone();
        let disconnect_rx_conn = disconnect_rx.clone();
        let mut run_handle = tokio::spawn(async move {
            run_one_connection(
                &account_id_clone,
                ctid,
                &role_clone,
                &url_clone,
                &client_id_clone,
                &client_secret_clone,
                &access_token_clone,
                tcp_server_clone.as_ref(),
                app_state_clone,
                Some(connected_tx),
                Some(copy_rx),
                disconnect_rx_conn,
                true,
            )
            .await
        });
        let connected_first = tokio::select! {
            _ = disconnect_rx.changed() => {
                run_handle.abort();
                running.write().await.remove(&account_id);
                if let Some(ref state) = app_state {
                    state.ctrader_running_since.write().await.remove(&account_id);
                    state.copy_command_tx.write().await.remove(&account_id);
                }
                return;
            }
            _ = tokio::time::sleep_until(reconnect_deadline) => {
                run_handle.abort();
                if let Some(ref mgr) = state_manager {
                    let rid = account_id.clone();
                    let now_secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    let retry_after = now_secs + CTRADER_RETRY_CREDENTIALS_BACKOFF_SECS as i64;
                    mgr.update(move |snap| {
                        if let Some(entry) = snap.accounts.get_mut(&rid) {
                            entry.tcp_url = None;
                            entry.reconnect_type = Some("retry_credentials".to_string());
                            entry.reconnect_retry_after_secs = Some(retry_after);
                        }
                    })
                    .await;
                }
                running.write().await.remove(&account_id);
                if let Some(ref state) = app_state {
                    state.ctrader_running_since.write().await.remove(&account_id);
                    state.ctrader_connected_accounts.write().await.remove(&account_id);
                    state.copy_command_tx.write().await.remove(&account_id);
                    if let Some(ref tx) = *state.ctrader_trigger_connect_tx.read().await {
                        let _ = tx.try_send(());
                    }
                }
                return;
            }
            _ = &mut connected_rx => {
                info!(account_id = %account_id, role = %role, "ctrader ProtoOA connected");
                if let Some(ref state) = app_state {
                    state.ctrader_connected_accounts.write().await.insert(account_id.clone());
                    state.conversion_ui_online_accounts.write().await.remove(&account_id);
                    if let Some(ref tx) = *state.copy_manager_trigger_tx.read().await {
                        let _ = tx.try_send(());
                    }
                }
                if let (Some(mgr), Some(state)) = (state_manager.as_ref(), app_state.as_ref()) {
                    let rid = account_id.clone();
                    let tcp_port = state.tcp_listening_port.read().await
                        .unwrap_or_else(|| util::tcp_port_from_base_url(&state.config.tcp_base_url).unwrap_or(18080));
                    let tcp_url = util::tcp_url_for_account(tcp_port, &account_id);
                    let set_tcp = role == "master";
                    mgr.update(move |snap| {
                        if let Some(e) = snap.accounts.get_mut(&rid) {
                            e.reconnect_type = None;
                            e.tcp_url = if set_tcp { Some(tcp_url.clone()) } else { None };
                        }
                        crate::state::recalc_slaves_master_tcp_urls(snap);
                    }).await;
                }
                true
            }
            res = &mut run_handle => {
                let run_result = match res {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(e)) => Err(e),
                    Err(join_err) => Err(join_err.to_string()),
                };
                match run_result {
                    Ok(()) => {}
                    Err(e) => {
                        if e.contains(DISCONNECT_REQUESTED) || e.contains("cancelled") || e.contains("aborted") {
                            running.write().await.remove(&account_id);
                            if let Some(ref state) = app_state {
                                state.ctrader_connected_accounts.write().await.remove(&account_id);
                                state.ctrader_running_since.write().await.remove(&account_id);
                                state.copy_command_tx.write().await.remove(&account_id);
                            }
                            return;
                        }
                        let is_temporary_broker = is_ctrader_temporary_broker_error(&e);
                        let is_auth_error = is_ctrader_invalid_credentials_error(&e);
                        let rtype = if let Some(t) = ctrader_temporary_broker_reconnect_type(&e) {
                            t
                        } else if is_auth_error {
                            "reauth_oauth"
                        } else {
                            "retry_credentials"
                        };
                        warn!(
                            account_id = %account_id,
                            role = %role,
                            error = %e,
                            reconnect_type = rtype,
                            "ctrader ProtoOA connection failed (before connected_rx), setting reconnect_type"
                        );
                        if let Some(ref state) = app_state {
                            state.ctrader_connected_accounts.write().await.remove(&account_id);
                        }
                        if let Some(ref mgr) = state_manager {
                            let rid = account_id.clone();
                            let now_secs = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs() as i64;
                            let retry_after = if rtype == "cant_route_request" {
                                Some(now_secs + CTRADER_CANT_ROUTE_RETRY_SECS as i64)
                            } else if is_temporary_broker {
                                Some(now_secs + CTRADER_SERVER_MAINTENANCE_RETRY_SECS as i64)
                            } else if rtype == "retry_credentials" {
                                Some(now_secs + CTRADER_RETRY_CREDENTIALS_BACKOFF_SECS as i64)
                            } else {
                                None
                            };
                            mgr.update(move |snap| {
                                if let Some(entry) = snap.accounts.get_mut(&rid) {
                                    entry.tcp_url = None;
                                    entry.reconnect_type = Some(rtype.to_string());
                                    entry.reconnect_retry_after_secs = retry_after;
                                }
                            }).await;
                        }
                        if is_auth_error || is_temporary_broker || Instant::now() > deadline {
                            running.write().await.remove(&account_id);
                            if let Some(ref state) = app_state {
                                state.ctrader_running_since.write().await.remove(&account_id);
                                state.copy_command_tx.write().await.remove(&account_id);
                            }
                            return;
                        }
                    }
                }
                false
            }
        };
        if !connected_first {
            if let Some(ref state) = app_state {
                state.copy_command_tx.write().await.remove(&account_id);
            }
            continue;
        }
        let run_result = match run_handle.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(join_err) => Err(join_err.to_string()),
        };
        match run_result {
            Ok(()) => {}
            Err(e) => {
                if e.contains(DISCONNECT_REQUESTED) || e.contains("cancelled") || e.contains("aborted") {
                    running.write().await.remove(&account_id);
                    if let Some(ref state) = app_state {
                        state.ctrader_running_since.write().await.remove(&account_id);
                        state.copy_command_tx.write().await.remove(&account_id);
                    }
                    return;
                }
                let is_temporary_broker = is_ctrader_temporary_broker_error(&e);
                let is_auth_error = is_ctrader_invalid_credentials_error(&e);
                let rtype = if let Some(t) = ctrader_temporary_broker_reconnect_type(&e) {
                    t
                } else if is_auth_error {
                    "reauth_oauth"
                } else {
                    "retry_credentials"
                };
                warn!(
                    account_id = %account_id,
                    role = %role,
                    error = %e,
                    reconnect_type = rtype,
                    "ctrader ProtoOA connection failed (after run), setting reconnect_type and cleaning up"
                );
                if let Some(ref state) = app_state {
                    state.ctrader_connected_accounts.write().await.remove(&account_id);
                }
                if let Some(ref mgr) = state_manager {
                    let rid = account_id.clone();
                    let now_secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    let retry_after = if rtype == "cant_route_request" {
                        Some(now_secs + CTRADER_CANT_ROUTE_RETRY_SECS as i64)
                    } else if is_temporary_broker {
                        Some(now_secs + CTRADER_SERVER_MAINTENANCE_RETRY_SECS as i64)
                    } else if rtype == "retry_credentials" {
                        Some(now_secs + CTRADER_RETRY_CREDENTIALS_BACKOFF_SECS as i64)
                    } else {
                        None
                    };
                    mgr.update(move |snap| {
                        if let Some(entry) = snap.accounts.get_mut(&rid) {
                            entry.tcp_url = None;
                            entry.reconnect_type = Some(rtype.to_string());
                            entry.reconnect_retry_after_secs = retry_after;
                        }
                    }).await;
                }
                running.write().await.remove(&account_id);
                if let Some(ref state) = app_state {
                    state.ctrader_running_since.write().await.remove(&account_id);
                    state.copy_command_tx.write().await.remove(&account_id);
                    if !is_temporary_broker {
                        ctrader_cleanup_and_reconnect(state, CtraderReconnectScope::Account(account_id.clone())).await;
                    } else if let Some(ref tx) = *state.ctrader_trigger_connect_tx.read().await {
                        let _ = tx.try_send(());
                    }
                }
                return;
            }
        }

        if let Some(ref state) = app_state {
            state.copy_command_tx.write().await.remove(&account_id);
        }
    }
}

pub(crate) async fn run_one_connection(
    account_id: &str,
    ctid: u64,
    role: &str,
    url: &str,
    client_id: &str,
    client_secret: &str,
    access_token: &str,
    tcp_server: Option<&Arc<TcpServer>>,
    app_state: Option<Arc<AppState>>,
    connected_tx: Option<oneshot::Sender<()>>,
    mut copy_rx: Option<mpsc::Receiver<CopyCommand>>,
    mut disconnect_rx: watch::Receiver<u32>,
    enable_snapshot_background: bool,
) -> Result<(), String> {
    info!(account_id = %account_id, role = %role, "ctrader run_one_connection: connecting ProtoOA WebSocket");
    let supports_http_trade = matches!(role, "slave" | "master" | "pending");

    let connect_timeout = std::time::Duration::from_secs(CTRADER_CONNECT_TIMEOUT_SECS);
    let (ws_stream, _) = tokio::time::timeout(connect_timeout, connect_async(url))
        .await
        .map_err(|_| format!("connect timeout after {}s", CTRADER_CONNECT_TIMEOUT_SECS))?
        .map_err(|e| format!("connect: {}", e))?;
    let (mut write, mut read) = ws_stream.split();
    let timeout = std::time::Duration::from_secs(CTRADER_PROTOOA_TIMEOUT_SECS);

    let auth_body = proto_oa::encode_application_auth_req(client_id, client_secret);
    tokio::time::timeout(timeout, write.send(Message::Binary(auth_body)))
        .await
        .map_err(|_| "send app auth timeout")?
        .map_err(|e| format!("send app auth: {}", e))?;

    let mut auth_ok = false;
    for _ in 0..10 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait app auth timeout")?
            .ok_or("connection closed before app auth")?
            .map_err(|e| format!("read: {}", e))?;
        match &msg {
            Message::Binary(b) => {
                if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                    if pt == proto_oa::PROTO_OA_APPLICATION_AUTH_RES {
                        auth_ok = true;
                        break;
                    }
                    if pt == 2142 {
                        let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                        return Err(format!("app auth rejected: {} - {}", c, d));
                    }
                }
            }
            Message::Close(_) => return Err("connection closed".into()),
            _ => {}
        }
    }
    if !auth_ok {
        return Err("app auth response not received".into());
    }

    let acc_auth = proto_oa::encode_account_auth_req(ctid, access_token);
    tokio::time::timeout(timeout, write.send(Message::Binary(acc_auth)))
        .await
        .map_err(|_| "send account auth timeout")?
        .map_err(|e| format!("send account auth: {}", e))?;

    let mut account_auth_ok = false;
    for _ in 0..10 {
        let msg = tokio::time::timeout(timeout, read.next())
            .await
            .map_err(|_| "wait account auth timeout")?
            .ok_or("connection closed before account auth")?
            .map_err(|e| format!("read: {}", e))?;
        match &msg {
            Message::Binary(b) => {
                if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                    if pt == proto_oa::PROTO_OA_ACCOUNT_AUTH_RES {
                        account_auth_ok = true;
                        break;
                    }
                    if pt == 2142 {
                        let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                        return Err(format!("account auth rejected: {} - {}", c, d));
                    }
                }
            }
            Message::Close(_) => return Err("connection closed".into()),
            _ => {}
        }
    }
    if !account_auth_ok {
        return Err("account auth response not received".into());
    }

    let mut asset_id_to_name: HashMap<i64, String> = HashMap::new();
    if supports_http_trade {
        let asset_req = proto_oa::encode_asset_list_req(ctid);
        if tokio::time::timeout(timeout, write.send(Message::Binary(asset_req)))
            .await
            .map_err(|_| "send asset list timeout")?
            .is_ok()
        {
            for _ in 0..30 {
                let msg = tokio::time::timeout(timeout, read.next())
                    .await
                    .map_err(|_| "wait asset list timeout")?
                    .ok_or("connection closed before asset list")?
                    .map_err(|e| format!("read: {}", e))?;
                match &msg {
                    Message::Binary(b) => {
                        if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                            if pt == proto_oa::PROTO_OA_ASSET_LIST_RES {
                                if let Ok(assets) = proto_oa::parse_asset_list_res(&pl) {
                                    asset_id_to_name = assets;
                                    break;
                                }
                            }
                            if pt == 2142 {
                                let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                                return Err(format!("asset list rejected: {} - {}", c, d));
                            }
                        }
                    }
                    Message::Close(_) => return Err("connection closed".into()),
                    _ => {}
                }
            }
        }
    }

    let mut symbols_by_name: HashMap<String, u64> = HashMap::new();
    let mut initial_unnamed_ids: Vec<u64> = Vec::new();
    let mut initial_id_to_name: HashMap<u64, String> = HashMap::new();
    if supports_http_trade {
        let sym_req = proto_oa::encode_symbols_list_req(ctid);
        if tokio::time::timeout(timeout, write.send(Message::Binary(sym_req)))
            .await
            .map_err(|_| "send symbols list timeout")?
            .is_err()
        {
            return Err("send symbols list failed".into());
        }
        for _ in 0..30 {
            let msg = tokio::time::timeout(timeout, read.next())
                .await
                .map_err(|_| "wait symbols list timeout")?
                .ok_or("connection closed before symbols list")?
                .map_err(|e| format!("read: {}", e))?;
            match &msg {
                Message::Binary(b) => {
                    if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                        if pt == proto_oa::PROTO_OA_SYMBOLS_LIST_RES {
                            if let Ok(result) = proto_oa::parse_symbols_list_res(&pl) {
                                symbols_by_name = result.by_name;
                                initial_unnamed_ids = result.unnamed_ids;
                                initial_id_to_name = result.id_to_name;
                                for (sym_id, base_aid, quote_aid) in &result.unnamed_asset_pairs {
                                    let base_name = asset_id_to_name.get(base_aid).cloned().unwrap_or_default();
                                    let quote_name = asset_id_to_name.get(quote_aid).cloned().unwrap_or_default();
                                    if !base_name.is_empty() && !quote_name.is_empty() {
                                        let constructed = format!("{}{}", base_name, quote_name);
                                        if symbols_by_name.contains_key(&constructed) {
                                            continue;
                                        }
                                        symbols_by_name.insert(constructed, *sym_id);
                                    }
                                }
                                break;
                            }
                        }
                        if pt == 2142 {
                            let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                            return Err(format!("symbols list rejected: {} - {}", c, d));
                        }
                    }
                }
                Message::Close(_) => return Err("connection closed".into()),
                _ => {}
            }
        }
    }

    let mut symbol_lot_sizes: HashMap<u64, i64> = HashMap::new();
    let mut symbol_min_volumes: HashMap<u64, i64> = HashMap::new();
    let mut symbol_max_volumes: HashMap<u64, i64> = HashMap::new();
    let mut symbol_volume_steps: HashMap<u64, i64> = HashMap::new();
    let mut symbol_digits: HashMap<u64, u32> = HashMap::new();
    let mut symbol_id_to_name: HashMap<u64, String> = initial_id_to_name;
    if supports_http_trade && !symbols_by_name.is_empty() {
        let known_ids: HashSet<u64> = symbols_by_name.values().copied().collect();
        let mut all_ids: Vec<u64> = known_ids.iter().copied().collect();
        for uid in &initial_unnamed_ids {
            if !known_ids.contains(uid) {
                all_ids.push(*uid);
            }
        }
        let max_known = all_ids.iter().copied().max().unwrap_or(0);
        let probe_ceiling = (max_known + 50).max(200);
        for id in 1..=probe_ceiling {
            if !known_ids.contains(&id) {
                all_ids.push(id);
            }
        }
        let sym_by_id_req = proto_oa::encode_symbol_by_id_req(ctid, &all_ids);
        if tokio::time::timeout(timeout, write.send(Message::Binary(sym_by_id_req)))
            .await
            .map_err(|_| "send symbol by id timeout")?
            .is_ok()
        {
            for _ in 0..30 {
                let msg = tokio::time::timeout(timeout, read.next())
                    .await
                    .map_err(|_| "wait symbol by id timeout")?
                    .ok_or("connection closed before symbol by id")?
                    .map_err(|e| format!("read: {}", e))?;
                match &msg {
                    Message::Binary(b) => {
                        if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                            if pt == proto_oa::PROTO_OA_SYMBOL_BY_ID_RES {
                                if let Ok(mut result) = proto_oa::parse_symbol_by_id_res_full(&pl) {
                                    symbol_lot_sizes = std::mem::take(&mut result.lot_sizes);
                                    symbol_min_volumes = std::mem::take(&mut result.min_volumes);
                                    symbol_max_volumes = std::mem::take(&mut result.max_volumes);
                                    symbol_volume_steps = std::mem::take(&mut result.volume_steps);
                                    symbol_digits = std::mem::take(&mut result.digits);
                                    symbols::merge_symbol_by_id_result(&result, &mut symbols_by_name, &mut symbol_id_to_name);
                                    break;
                                }
                            }
                            if pt == 2142 {
                                let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or((String::new(), String::new()));
                                return Err(format!("symbol by id rejected: {} - {}", c, d));
                            }
                        }
                    }
                    Message::Close(_) => return Err("connection closed".into()),
                    _ => {}
                }
            }
        }
    }

    if supports_http_trade {
        let trader_req = proto_oa::encode_trader_req(ctid);
        let pnl_req = proto_oa::encode_get_position_unrealized_pnl_req(ctid);
        if tokio::time::timeout(timeout, write.send(Message::Binary(trader_req)))
            .await
            .is_ok()
            && tokio::time::timeout(timeout, write.send(Message::Binary(pnl_req)))
                .await
                .is_ok()
        {
            let mut prefetch_trader: Option<proto_oa::TraderInfo> = None;
            let mut prefetch_pnl: Option<HashMap<i64, f64>> = None;
            let prefetch_deadline =
                Instant::now() + std::time::Duration::from_secs(5);
            while (prefetch_trader.is_none() || prefetch_pnl.is_none())
                && Instant::now() < prefetch_deadline
            {
                let Ok(Some(Ok(msg))) = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    read.next(),
                )
                .await
                else {
                    break;
                };
                if let Message::Binary(b) = msg {
                    let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b.as_ref()) else {
                        continue;
                    };
                    if pt == proto_oa::PROTO_OA_TRADER_RES && prefetch_trader.is_none() {
                        if let Ok(info) = proto_oa::parse_trader_res(&pl) {
                            prefetch_trader = Some(info);
                        }
                    }
                    if pt == proto_oa::PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES
                        && prefetch_pnl.is_none()
                    {
                        if let Ok(map) =
                            proto_oa::parse_get_position_unrealized_pnl_res(&pl)
                        {
                            if let Some(ref state) = app_state {
                                state
                                    .position_pnl_cache
                                    .write()
                                    .await
                                    .insert(account_id.to_string(), map.clone());
                            }
                            prefetch_pnl = Some(map);
                        }
                    }
                }
            }
            if let (Some(info), Some(pnl)) = (prefetch_trader, prefetch_pnl) {
                let round2 = |x: f64| (x * 100.0).round() / 100.0;
                let currency = info
                    .currency_deposit_asset_id
                    .and_then(|id| asset_id_to_name.get(&id).cloned());
                let balance = Some(info.balance);
                let equity = info
                    .equity
                    .or_else(|| balance.map(|b| b + pnl.values().sum::<f64>()));
                let unrealized_pnl =
                    balance.and_then(|b| equity.map(|e| round2(e - b)));
                let dto = AccountInfoDto {
                    account_id: account_id.to_string(),
                    server: info.broker_name,
                    currency,
                    balance: balance.map(round2),
                    equity: equity.map(round2),
                    unrealized_pnl,
                    leverage: info.leverage,
                    margin: None,
                };
                if let Some(ref state) = app_state {
                    info!(
                        account_id = %account_id,
                        role = %role,
                        server = ?dto.server,
                        balance = ?dto.balance,
                        equity = ?dto.equity,
                        "prefetched account info at connect"
                    );
                    state
                        .account_info_cache
                        .write()
                        .await
                        .insert(account_id.to_string(), dto);
                }
            }
        }
    }

    let mut pending_reconcile_reply: Option<oneshot::Sender<crate::services::copy_command::ReconcileResult>> = None;
    let mut live_account_info_pending = false;
    let mut live_account_info_pending_since: Option<Instant> = None;
    let live_account_info_timeout = std::time::Duration::from_secs(10);
    let mut live_account_info_trader: Option<proto_oa::TraderInfo> = None;
    let mut live_account_info_assets: Option<std::collections::HashMap<i64, String>> = None;
    let mut live_account_info_pnl: Option<std::collections::HashMap<i64, f64>> = None;
    let mut pending_create_reply: Option<oneshot::Sender<Result<(), String>>> = None;
    let mut heartbeat_interval = tokio::time::interval(std::time::Duration::from_secs(CTRADER_HEARTBEAT_INTERVAL_SECS));
    heartbeat_interval.tick().await;

    let mut last_master_positions: HashMap<i64, MasterPositionRow> = HashMap::new();
    let mut last_master_orders: HashMap<i64, MasterOrderRow> = HashMap::new();
    let mut server_clock_offset_ms: i64 = 0;
    let mut server_clock_anchored: bool = false;
    let mut first_master_baseline_seeded: bool = false;
    let mut subscribed_spot_symbol_ids: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut pending_master_diff = false;
    let mut pending_mapping_refresh = false;
    let mut ctrader_reconcile_received = false;
    let mut pending_symbol_resolve_payload: Option<Vec<u8>> = None;
    let mut position_symbol_index: HashMap<i64, u64> = HashMap::new();
    let mut pos_id_to_ord_id: HashMap<i64, i64> = {
        let loaded = crate::services::pos_mapping::load(account_id);
        loaded
    };
    let mut last_ws_recv: Instant = Instant::now();

    enum Next {
        Msg(Option<Message>),
        Cmd(CopyCommand),
        Heartbeat,
        SnapshotTick,
        AccountInfoTick,
        PnlTick,
    }
    let idle_recv_timeout = std::time::Duration::from_secs(CTRADER_IDLE_RECV_TIMEOUT_SECS);
    let mut snapshot_interval = tokio::time::interval(std::time::Duration::from_millis(COPY_MASTER_SNAPSHOT_INTERVAL_MS));
    snapshot_interval.tick().await;
    let mut account_info_interval =
        tokio::time::interval(std::time::Duration::from_secs(CTRADER_ACCOUNT_INFO_POLL_SECS));
    account_info_interval.tick().await;
    let mut pnl_interval = tokio::time::interval(std::time::Duration::from_millis(500));
    pnl_interval.tick().await;

    let mut connected_signal_sent = false;
    let mut connected_tx_opt = connected_tx;

    loop {
        let next = match &mut copy_rx {
            Some(ref mut crx) => {
                tokio::select! {
                    biased;
                    _ = disconnect_rx.changed() => return Err(DISCONNECT_REQUESTED.into()),
                    cmd = crx.recv() => match cmd {
                        Some(c) => Next::Cmd(c),
                        None => return Err("copy channel closed".into()),
                    },
                    _ = heartbeat_interval.tick() => Next::Heartbeat,
                    _ = snapshot_interval.tick() => Next::SnapshotTick,
                    _ = account_info_interval.tick() => Next::AccountInfoTick,
                    _ = pnl_interval.tick() => Next::PnlTick,
                    res = async {
                        let msg = tokio::time::timeout(idle_recv_timeout, read.next()).await;
                        match msg {
                            Ok(Some(Ok(m))) => Ok(Next::Msg(Some(m))),
                            Ok(Some(Err(e))) => Err(format!("read: {}", e)),
                            Ok(None) => Err("connection closed".into()),
                            Err(_) => Err(format!("no data from server (idle timeout {}s)", CTRADER_IDLE_RECV_TIMEOUT_SECS)),
                        }
                    } => match res {
                        Ok(n) => n,
                        Err(e) => return Err(e),
                    },
                }
            }
            None => {
                tokio::select! {
                    _ = disconnect_rx.changed() => return Err(DISCONNECT_REQUESTED.into()),
                    res = async {
                        let msg = tokio::time::timeout(idle_recv_timeout, read.next()).await;
                        match msg {
                            Ok(Some(Ok(m))) => Ok(Next::Msg(Some(m))),
                            Ok(Some(Err(e))) => Err(format!("read: {}", e)),
                            Ok(None) => Err("connection closed".into()),
                            Err(_) => Err(format!("no data from server (idle timeout {}s)", CTRADER_IDLE_RECV_TIMEOUT_SECS)),
                        }
                    } => match res {
                        Ok(n) => n,
                        Err(e) => return Err(e),
                    },
                    _ = heartbeat_interval.tick() => Next::Heartbeat,
                    _ = snapshot_interval.tick() => Next::SnapshotTick,
                    _ = account_info_interval.tick() => Next::AccountInfoTick,
                    _ = pnl_interval.tick() => Next::PnlTick,
                }
            }
        };

        if !connected_signal_sent {
            if let Some(tx) = connected_tx_opt.take() {
                let _ = tx.send(());
            }
            connected_signal_sent = true;
        }

        match next {
            Next::Heartbeat => {
                if last_ws_recv.elapsed() > std::time::Duration::from_secs(CTRADER_IDLE_RECV_TIMEOUT_SECS) {
                    return Err(format!(
                        "no data from server (idle {}s, last recv {:.1}s ago)",
                        CTRADER_IDLE_RECV_TIMEOUT_SECS,
                        last_ws_recv.elapsed().as_secs_f64()
                    ));
                }
                let heartbeat_msg = proto_oa::encode_heartbeat();
                match tokio::time::timeout(timeout, write.send(Message::Binary(heartbeat_msg))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => return Err(format!("heartbeat send: {}", e)),
                    Err(_) => return Err("heartbeat send timeout".into()),
                }
            }
            Next::SnapshotTick => {
                if !enable_snapshot_background {
                    continue;
                }
                if ctrader_reconcile_received {
                    if role == "master" {
                        let master_tcp_enabled = match &app_state {
                            Some(s) => *s.tcp_enabled.read().await.get(account_id).unwrap_or(&true),
                            None => false,
                        };
                        snapshot::emit_master_snapshot_tcp(
                            account_id,
                            &last_master_positions,
                            &last_master_orders,
                            app_state.as_ref(),
                            if master_tcp_enabled { tcp_server } else { None },
                            &pos_id_to_ord_id,
                            server_clock_offset_ms,
                        )
                        .await;
                        if master_tcp_enabled
                            && pending_reconcile_reply.is_none()
                            && !pending_master_diff
                        {
                            let msg = proto_oa::encode_reconcile_req(ctid);
                            if tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                                .await
                                .is_ok()
                            {
                                pending_master_diff = true;
                            }
                        }
                    } else {
                        snapshot::update_ctrader_snapshot_cache(
                            account_id,
                            &last_master_positions,
                            &last_master_orders,
                            &pos_id_to_ord_id,
                            app_state.as_ref(),
                            server_clock_offset_ms,
                        )
                        .await;
                        if pending_reconcile_reply.is_none()
                            && !pending_mapping_refresh
                        {
                            let msg = proto_oa::encode_reconcile_req(ctid);
                            if tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                                .await
                                .is_ok()
                            {
                                pending_mapping_refresh = true;
                            }
                        }
                    }
                } else if pending_reconcile_reply.is_none()
                    && !pending_mapping_refresh
                {
                    let do_send = if role == "master" {
                        let master_tcp_enabled = match &app_state {
                            Some(s) => *s.tcp_enabled.read().await.get(account_id).unwrap_or(&true),
                            None => false,
                        };
                        master_tcp_enabled && !pending_master_diff
                    } else {
                        true
                    };
                    if do_send {
                        let msg = proto_oa::encode_reconcile_req(ctid);
                        if tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                            .await
                            .is_ok()
                        {
                            if role == "master" {
                                pending_master_diff = true;
                            } else {
                                pending_mapping_refresh = true;
                            }
                        }
                    }
                }
            }
            Next::AccountInfoTick => {
                if live_account_info_pending
                    && live_account_info_pending_since
                        .map(|t| t.elapsed() > live_account_info_timeout)
                        .unwrap_or(false)
                {
                    live_account_info_pending = false;
                    live_account_info_pending_since = None;
                    live_account_info_trader = None;
                    live_account_info_assets = None;
                    live_account_info_pnl = None;
                }
                if !live_account_info_pending
                    && tokio::time::timeout(timeout, write.send(Message::Binary(proto_oa::encode_trader_req(ctid))))
                        .await
                        .is_ok()
                    && tokio::time::timeout(timeout, write.send(Message::Binary(proto_oa::encode_asset_list_req(ctid))))
                        .await
                        .is_ok()
                    && tokio::time::timeout(
                        timeout,
                        write.send(Message::Binary(proto_oa::encode_get_position_unrealized_pnl_req(ctid))),
                    )
                    .await
                    .is_ok()
                {
                    live_account_info_pending = true;
                    live_account_info_pending_since = Some(Instant::now());
                }
            }
            Next::PnlTick => {
                if ctrader_reconcile_received && !live_account_info_pending {
                    let _ = tokio::time::timeout(
                        timeout,
                        write.send(Message::Binary(proto_oa::encode_get_position_unrealized_pnl_req(ctid))),
                    )
                    .await;
                }
            }
            Next::Cmd(cmd) => {
                let (cmd_type, symbol_opt, position_id_opt, order_id_opt): (_, Option<String>, _, _) = match &cmd {
                    CopyCommand::OpenMarket { symbol_name, .. } => ("OpenMarket", Some(symbol_name.clone()), None, None),
                    CopyCommand::PlacePendingOrder { symbol_name, .. } => ("PlacePendingOrder", Some(symbol_name.clone()), None, None),
                    CopyCommand::AmendOrder { symbol_name, order_id, .. } => ("AmendOrder", symbol_name.clone(), None, Some(*order_id)),
                    CopyCommand::ClosePosition { position_id, .. } => ("ClosePosition", None, Some(*position_id), None),
                    CopyCommand::CancelOrder { order_id } => ("CancelOrder", None, None, Some(*order_id)),
                    CopyCommand::AmendPositionSLTP { position_id, .. } => ("AmendPositionSLTP", None, Some(*position_id), None),
                    CopyCommand::GetReconcile { .. } => ("GetReconcile", None, None, None),
                };
                match copy_executor::execute_copy_command(
                    ctid,
                    &mut write,
                    &symbols_by_name,
                    &symbol_lot_sizes,
                    &symbol_volume_steps,
                    &position_symbol_index,
                    cmd,
                    &mut pending_reconcile_reply,
                    &mut pending_create_reply,
                    timeout,
                )
                .await
                {
                    Ok(()) => {
                        if cmd_type != "GetReconcile" {
                            tracing::info!(
                                slave_account_id = %account_id,
                                cmd_type = %cmd_type,
                                symbol = ?symbol_opt,
                                "copy → slave: executed OK"
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            slave_account_id = %account_id,
                            cmd_type = %cmd_type,
                            symbol = ?symbol_opt,
                            position_id = ?position_id_opt,
                            order_id = ?order_id_opt,
                            error = %e,
                            "copy → slave: FAILED (broker reject, symbol not found, or timeout)"
                        );
                    }
                }
            }
            Next::Msg(Some(msg)) => {
                last_ws_recv = Instant::now();
                match &msg {
                    Message::Binary(b) => {
                        let (payload_type, payload) = match proto_oa::parse_proto_message_wrapper(b.as_ref()) {
                            Some(p) => p,
                            None => continue,
                        };
                        if payload_type == proto_oa::PROTO_OA_SYMBOL_BY_ID_RES {
                            if let Some(reconcile_payload) = pending_symbol_resolve_payload.take() {
                                if let Ok(result) = proto_oa::parse_symbol_by_id_res_full(&payload) {
                                    for (id, ls) in &result.lot_sizes {
                                        symbol_lot_sizes.entry(*id).or_insert(*ls);
                                    }
                                    for (id, min_v) in &result.min_volumes {
                                        symbol_min_volumes.entry(*id).or_insert((*min_v).max(1));
                                    }
                                    for (id, max_v) in &result.max_volumes {
                                        if *max_v > 0 {
                                            symbol_max_volumes.entry(*id).or_insert(*max_v);
                                        }
                                    }
                                    for (id, step) in &result.volume_steps {
                                        symbol_volume_steps.entry(*id).or_insert((*step).max(1));
                                    }
                                    for (id, d) in &result.digits {
                                        symbol_digits.entry(*id).or_insert(*d);
                                    }
                                    symbols::merge_symbol_by_id_result(&result, &mut symbols_by_name, &mut symbol_id_to_name);
                                }
                                if let Ok((positions, orders)) = proto_oa::parse_reconcile_res(reconcile_payload.as_ref(), &symbol_lot_sizes, &symbol_digits) {
                                    symbols::refresh_position_symbol_index(&positions, &mut position_symbol_index);
                                    update_realtime_stats_cache(
                                        account_id,
                                        app_state.as_ref(),
                                        positions.len(),
                                        orders.len(),
                                    ).await;
                                    let (curr_positions, curr_orders) =
                                        build_master_snapshot(&positions, &orders, &symbol_id_to_name);
                                    let fills = proto_oa::detect_fills(
                                        &last_master_orders,
                                        &curr_orders,
                                        &curr_positions,
                                        &last_master_positions,
                                    );
                                    let had_changes = !fills.is_empty();
                                    for (pos_id, ord_id) in fills {
                                        pos_id_to_ord_id.entry(pos_id).or_insert(ord_id);
                                    }
                                    let before_len = pos_id_to_ord_id.len();
                                    pos_id_to_ord_id.retain(|pos_id, _| curr_positions.contains_key(pos_id));
                                    if had_changes || pos_id_to_ord_id.len() != before_len {
                                        crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                    }
                                    if role == "master" {
                                        pending_master_diff = false;
                                        let master_tcp_enabled = match &app_state {
                                            Some(s) => *s.tcp_enabled.read().await.get(account_id).unwrap_or(&true),
                                            None => false,
                                        };
                                        let can_emit_events = server_clock_anchored || first_master_baseline_seeded;
                                        let local_now_ms = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_millis() as i64;
                                        let server_now_ms = if server_clock_anchored {
                                            local_now_ms + server_clock_offset_ms
                                        } else {
                                            local_now_ms
                                        };
                                        let (events, mapping_changed) = if can_emit_events {
                                            diff_master_snapshots(
                                                &last_master_positions,
                                                &last_master_orders,
                                                &curr_positions,
                                                &curr_orders,
                                                &mut pos_id_to_ord_id,
                                                server_now_ms,
                                            )
                                        } else {
                                            tracing::info!(
                                                account_id = %account_id,
                                                "first master reconcile without spot anchor — seeding baseline, no events emitted until cTrader time is anchored"
                                            );
                                            (Vec::new(), false)
                                        };
                                        first_master_baseline_seeded = true;
                                        if mapping_changed {
                                            crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                        }
                                        let events_count = events.len();
                                        if !master_tcp_enabled {
                                            if events_count > 0 {
                                                tracing::warn!(
                                                    account_id = %account_id,
                                                    events_count,
                                                    "Master has events but TCP disabled for this account, NOT broadcasting"
                                                );
                                            }
                                        } else if let Some(ref tcp) = tcp_server {
                                            for evt in &events {
                                                tracing::info!(
                                                    master_account_id = %account_id,
                                                    event = %evt.event_summary_for_log(),
                                                    ticket = evt.ticket(),
                                                    volume = ?evt.volume(),
                                                    "master → TCP: broadcasting event (slaves will receive and copy)"
                                                );
                                                match evt.to_json_line() {
                                                    Ok(line) => {
                                                        tcp.broadcast(account_id, &line).await;
                                                    }
                                                    Err(e) => {
                                                        tracing::warn!(
                                                            account_id = %account_id,
                                                            error = %e,
                                                            "Master event to_json_line failed, NOT broadcast"
                                                        );
                                                    }
                                                }
                                            }
                                        } else if events_count > 0 {
                                            tracing::warn!(
                                                account_id = %account_id,
                                                events_count,
                                                "Master has events but tcp_server is None, NOT broadcasting"
                                            );
                                        }
                                        let mut new_symbol_ids: Vec<u64> = Vec::new();
                                        for p in &positions {
                                            if p.symbol_id != 0 && subscribed_spot_symbol_ids.insert(p.symbol_id) {
                                                new_symbol_ids.push(p.symbol_id);
                                            }
                                        }
                                        for o in &orders {
                                            if o.symbol_id != 0 && subscribed_spot_symbol_ids.insert(o.symbol_id) {
                                                new_symbol_ids.push(o.symbol_id);
                                            }
                                        }
                                        if !new_symbol_ids.is_empty() {
                                            let msg = proto_oa::encode_subscribe_spots_req(ctid, &new_symbol_ids);
                                            let _ = tokio::time::timeout(timeout, write.send(Message::Binary(msg))).await;
                                        }
                                    }
                                    pending_mapping_refresh = false;
                                    last_master_positions = curr_positions.clone();
                                    last_master_orders = curr_orders.clone();
                                    ctrader_reconcile_received = true;
                                    snapshot::update_ctrader_snapshot_cache(
                                        account_id,
                                        &last_master_positions,
                                        &last_master_orders,
                                        &pos_id_to_ord_id,
                                        app_state.as_ref(),
                                        server_clock_offset_ms,
                                    )
                                    .await;
                                    if let Some(reply) = pending_reconcile_reply.take() {
                                        let (symbol_min_lots, symbol_max_lots) =
                                            symbols::build_symbol_volume_limits_lots(
                                                &symbol_lot_sizes,
                                                &symbol_min_volumes,
                                                &symbol_max_volumes,
                                                &symbol_volume_steps,
                                            );
                                        let _ = reply.send(Ok((
                                            positions,
                                            orders,
                                            symbol_id_to_name.clone(),
                                            symbol_digits.clone(),
                                            symbol_min_lots,
                                            symbol_max_lots,
                                        )));
                                    }
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_EXECUTION_EVENT {
                            if let Some(tx) = pending_create_reply.take() {
                                let _ = tx.send(Ok(()));
                            }
                        }
                        if payload_type == proto_oa::PROTO_OA_SPOT_EVENT {
                            if let Some(server_ts) = proto_oa::parse_spot_event_timestamp(&payload) {
                                let local_now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as i64;
                                let was_anchored = server_clock_anchored;
                                server_clock_offset_ms = server_ts - local_now_ms;
                                server_clock_anchored = true;
                                if !was_anchored && role == "master" && first_master_baseline_seeded && !pending_master_diff {
                                    let msg = proto_oa::encode_reconcile_req(ctid);
                                    if tokio::time::timeout(timeout, write.send(Message::Binary(msg))).await.is_ok() {
                                        pending_master_diff = true;
                                    }
                                }
                            }
                            continue;
                        }
                        if role == "master"
                            && payload_type != proto_oa::PROTO_OA_RECONCILE_RES
                            && payload_type != proto_oa::PROTO_OA_SYMBOL_BY_ID_RES
                            && payload_type != proto_oa::PROTO_OA_SPOT_EVENT
                            && (pending_reconcile_reply.is_none()
                                || payload_type == proto_oa::PROTO_OA_EXECUTION_EVENT)
                        {
                            if !pending_master_diff {
                                let msg = proto_oa::encode_reconcile_req(ctid);
                                if tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                                    .await
                                    .is_ok()
                                {
                                    pending_master_diff = true;
                                }
                                continue;
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_ORDER_ERROR_EVENT {
                            if let Some((order_id, code, desc)) = proto_oa::parse_order_error_event(&payload) {
                                let msg = if desc.is_empty() { code.clone() } else { format!("{}: {}", code, desc) };
                                tracing::warn!(
                                    order_id = order_id,
                                    code = %code,
                                    description = %desc,
                                    "Broker rejected order (may affect SL/TP). Check entry/SL/TP values."
                                );
                                if let Some(tx) = pending_create_reply.take() {
                                    let _ = tx.send(Err(msg));
                                }
                            } else {
                                tracing::warn!("Broker rejected order (parse failed)");
                                if let Some(tx) = pending_create_reply.take() {
                                    let _ = tx.send(Err("order rejected by broker".to_string()));
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_ERROR_RES {
                            let (code, desc) = proto_oa::parse_error_res(&payload).unwrap_or((String::new(), String::new()));
                            if let Some(tx) = pending_create_reply.take() {
                                let err_msg = if desc.is_empty() { code.clone() } else { format!("{}: {}", code, desc) };
                                let _ = tx.send(Err(err_msg));
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_SYMBOLS_LIST_RES {
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_RECONCILE_RES {
                            if let Some(reply) = pending_reconcile_reply.take() {
                                match proto_oa::parse_reconcile_res(payload.as_ref(), &symbol_lot_sizes, &symbol_digits) {
                                    Ok((positions, orders)) => {
                                        symbols::refresh_position_symbol_index(&positions, &mut position_symbol_index);
                                        update_realtime_stats_cache(
                                            account_id,
                                            app_state.as_ref(),
                                            positions.len(),
                                            orders.len(),
                                        ).await;
                                        let missing = symbols::collect_missing_symbol_ids(
                                            &positions,
                                            &orders,
                                            &symbol_id_to_name,
                                            &symbol_lot_sizes,
                                        );
                                        if !missing.is_empty() && pending_symbol_resolve_payload.is_none() {
                                            pending_symbol_resolve_payload = Some(payload.to_vec());
                                            pending_reconcile_reply = Some(reply);
                                            let req_msg = proto_oa::encode_symbol_by_id_req(ctid, &missing);
                                            let _ = tokio::time::timeout(timeout, write.send(Message::Binary(req_msg))).await;
                                        } else {
                                            let (curr_positions, curr_orders) =
                                                build_master_snapshot(&positions, &orders, &symbol_id_to_name);
                                            let fills = proto_oa::detect_fills(
                                                &last_master_orders,
                                                &curr_orders,
                                                &curr_positions,
                                                &last_master_positions,
                                            );
                                            let had_changes = !fills.is_empty();
                                            for (pos_id, ord_id) in fills {
                                                pos_id_to_ord_id.entry(pos_id).or_insert(ord_id);
                                            }
                                            let before_len = pos_id_to_ord_id.len();
                                            pos_id_to_ord_id.retain(|pos_id, _| curr_positions.contains_key(pos_id));
                                            if had_changes || pos_id_to_ord_id.len() != before_len {
                                                crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                            }
                                            last_master_positions = curr_positions;
                                            last_master_orders = curr_orders;
                                            ctrader_reconcile_received = true;
                                            snapshot::update_ctrader_snapshot_cache(
                                                account_id,
                                                &last_master_positions,
                                                &last_master_orders,
                                                &pos_id_to_ord_id,
                                                app_state.as_ref(),
                                                server_clock_offset_ms,
                                            )
                                            .await;
                                            let (symbol_min_lots, symbol_max_lots) =
                                                symbols::build_symbol_volume_limits_lots(
                                                    &symbol_lot_sizes,
                                                    &symbol_min_volumes,
                                                    &symbol_max_volumes,
                                                    &symbol_volume_steps,
                                                );
                                            let _ = reply.send(Ok((
                                                positions,
                                                orders,
                                                symbol_id_to_name.clone(),
                                                symbol_digits.clone(),
                                                symbol_min_lots,
                                                symbol_max_lots,
                                            )));
                                        }
                                    }
                                    Err(e) => {
                                        tracing::warn!(account_id = %account_id, error = %e, "history fetch parse reconcile failed");
                                        let _ = reply.send(Err(e));
                                    }
                                }
                            }
                            if pending_mapping_refresh {
                                pending_mapping_refresh = false;
                                if let Ok((positions, orders)) = proto_oa::parse_reconcile_res(payload.as_ref(), &symbol_lot_sizes, &symbol_digits) {
                                    symbols::refresh_position_symbol_index(&positions, &mut position_symbol_index);
                                    update_realtime_stats_cache(
                                        account_id,
                                        app_state.as_ref(),
                                        positions.len(),
                                        orders.len(),
                                    ).await;
                                    let missing = symbols::collect_missing_symbol_ids(
                                        &positions,
                                        &orders,
                                        &symbol_id_to_name,
                                        &symbol_lot_sizes,
                                    );
                                    if !missing.is_empty() && pending_symbol_resolve_payload.is_none() {
                                        pending_symbol_resolve_payload = Some(payload.to_vec());
                                        pending_mapping_refresh = true;
                                        let req_msg = proto_oa::encode_symbol_by_id_req(ctid, &missing);
                                        let _ = tokio::time::timeout(timeout, write.send(Message::Binary(req_msg))).await;
                                        continue;
                                    }
                                    let (curr_positions, curr_orders) =
                                        build_master_snapshot(&positions, &orders, &symbol_id_to_name);
                                    let fills = proto_oa::detect_fills(
                                        &last_master_orders,
                                        &curr_orders,
                                        &curr_positions,
                                        &last_master_positions,
                                    );
                                    if !fills.is_empty() {
                                        for (pos_id, ord_id) in fills {
                                            pos_id_to_ord_id.entry(pos_id).or_insert(ord_id);
                                        }
                                        crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                    }
                                    let before_len = pos_id_to_ord_id.len();
                                    pos_id_to_ord_id.retain(|pos_id, _| curr_positions.contains_key(pos_id));
                                    if pos_id_to_ord_id.len() != before_len {
                                        crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                    }
                                    last_master_positions = curr_positions;
                                    last_master_orders = curr_orders;
                                    ctrader_reconcile_received = true;
                                    snapshot::update_ctrader_snapshot_cache(
                                        account_id,
                                        &last_master_positions,
                                        &last_master_orders,
                                        &pos_id_to_ord_id,
                                        app_state.as_ref(),
                                        server_clock_offset_ms,
                                    )
                                    .await;
                                }
                            }
                            if role == "master" && pending_master_diff {
                                let was_diff = pending_master_diff;
                                pending_master_diff = false;
                                let master_tcp_enabled = match &app_state {
                                    Some(s) => *s.tcp_enabled.read().await.get(account_id).unwrap_or(&true),
                                    None => false,
                                };
                                if let Ok((positions, orders)) = proto_oa::parse_reconcile_res(payload.as_ref(), &symbol_lot_sizes, &symbol_digits) {
                                    symbols::refresh_position_symbol_index(&positions, &mut position_symbol_index);
                                    update_realtime_stats_cache(
                                        account_id,
                                        app_state.as_ref(),
                                        positions.len(),
                                        orders.len(),
                                    ).await;
                                    let missing = symbols::collect_missing_symbol_ids(
                                        &positions,
                                        &orders,
                                        &symbol_id_to_name,
                                        &symbol_lot_sizes,
                                    );
                                    if !missing.is_empty() && pending_symbol_resolve_payload.is_none() {
                                        pending_symbol_resolve_payload = Some(payload.to_vec());
                                        pending_master_diff = was_diff;
                                        let req_msg = proto_oa::encode_symbol_by_id_req(ctid, &missing);
                                        let _ = tokio::time::timeout(timeout, write.send(Message::Binary(req_msg))).await;
                                        continue;
                                    }
                                    let (curr_positions, curr_orders) =
                                        build_master_snapshot(&positions, &orders, &symbol_id_to_name);
                                    if was_diff {
                                        let can_emit_events = server_clock_anchored || first_master_baseline_seeded;
                                        let local_now_ms = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_millis() as i64;
                                        let server_now_ms = if server_clock_anchored {
                                            local_now_ms + server_clock_offset_ms
                                        } else {
                                            local_now_ms
                                        };
                                        let (events, mapping_changed) = if can_emit_events {
                                            diff_master_snapshots(
                                                &last_master_positions,
                                                &last_master_orders,
                                                &curr_positions,
                                                &curr_orders,
                                                &mut pos_id_to_ord_id,
                                                server_now_ms,
                                            )
                                        } else {
                                            tracing::info!(
                                                account_id = %account_id,
                                                "first master reconcile without spot anchor — seeding baseline, no events emitted until cTrader time is anchored"
                                            );
                                            (Vec::new(), false)
                                        };
                                        first_master_baseline_seeded = true;
                                        if mapping_changed {
                                            crate::services::pos_mapping::save(account_id, &pos_id_to_ord_id);
                                        }
                                        let events_count = events.len();
                                        if !master_tcp_enabled && events_count > 0 {
                                            tracing::warn!(
                                                account_id = %account_id,
                                                "Master has events but TCP disabled, NOT broadcasting"
                                            );
                                        } else if master_tcp_enabled {
                                            match tcp_server {
                                                Some(ref tcp) => {
                                                    for evt in &events {
                                                        tracing::info!(
                                                            master_account_id = %account_id,
                                                            event = %evt.event_summary_for_log(),
                                                            ticket = evt.ticket(),
                                                            volume = ?evt.volume(),
                                                            "master → TCP: broadcasting event (slaves will receive and copy)"
                                                        );
                                                        match evt.to_json_line() {
                                                            Ok(line) => {
                                                                tcp.broadcast(account_id, &line).await;
                                                            }
                                                            Err(e) => {
                                                                tracing::warn!(
                                                                    account_id = %account_id,
                                                                    error = %e,
                                                                    "Master event serialize failed"
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                                None => {
                                                    if events_count > 0 {
                                                        tracing::warn!(
                                                            account_id = %account_id,
                                                            "Master has events but tcp_server is None"
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    let mut new_symbol_ids: Vec<u64> = Vec::new();
                                    for p in &positions {
                                        if p.symbol_id != 0 && subscribed_spot_symbol_ids.insert(p.symbol_id) {
                                            new_symbol_ids.push(p.symbol_id);
                                        }
                                    }
                                    for o in &orders {
                                        if o.symbol_id != 0 && subscribed_spot_symbol_ids.insert(o.symbol_id) {
                                            new_symbol_ids.push(o.symbol_id);
                                        }
                                    }
                                    if !new_symbol_ids.is_empty() {
                                        let msg = proto_oa::encode_subscribe_spots_req(ctid, &new_symbol_ids);
                                        let _ = tokio::time::timeout(timeout, write.send(Message::Binary(msg))).await;
                                    }
                                    last_master_positions = curr_positions;
                                    last_master_orders = curr_orders;
                                    ctrader_reconcile_received = true;
                                    snapshot::update_ctrader_snapshot_cache(
                                        account_id,
                                        &last_master_positions,
                                        &last_master_orders,
                                        &pos_id_to_ord_id,
                                        app_state.as_ref(),
                                        server_clock_offset_ms,
                                    )
                                    .await;
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_TRADER_RES {
                            if live_account_info_pending {
                                if let Ok(info) = proto_oa::parse_trader_res(payload.as_ref()) {
                                    live_account_info_trader = Some(info);
                                    try_update_live_account_info_cache(
                                        account_id,
                                        &mut live_account_info_trader,
                                        &mut live_account_info_assets,
                                        &mut live_account_info_pnl,
                                        &mut live_account_info_pending,
                                        &mut live_account_info_pending_since,
                                        app_state.as_ref(),
                                    )
                                    .await;
                                    if ctrader_reconcile_received {
                                        snapshot::update_ctrader_snapshot_cache(
                                            account_id,
                                            &last_master_positions,
                                            &last_master_orders,
                                            &pos_id_to_ord_id,
                                            app_state.as_ref(),
                                            server_clock_offset_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_ASSET_LIST_RES {
                            if live_account_info_pending {
                                if let Ok(map) = proto_oa::parse_asset_list_res(payload.as_ref()) {
                                    live_account_info_assets = Some(map);
                                    try_update_live_account_info_cache(
                                        account_id,
                                        &mut live_account_info_trader,
                                        &mut live_account_info_assets,
                                        &mut live_account_info_pnl,
                                        &mut live_account_info_pending,
                                        &mut live_account_info_pending_since,
                                        app_state.as_ref(),
                                    )
                                    .await;
                                    if ctrader_reconcile_received {
                                        snapshot::update_ctrader_snapshot_cache(
                                            account_id,
                                            &last_master_positions,
                                            &last_master_orders,
                                            &pos_id_to_ord_id,
                                            app_state.as_ref(),
                                            server_clock_offset_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES {
                            if let Ok(map) = proto_oa::parse_get_position_unrealized_pnl_res(payload.as_ref()) {
                                let should_update_cache = !(map.is_empty() && !last_master_positions.is_empty());
                                if should_update_cache {
                                    if let Some(ref state) = app_state {
                                        state
                                            .position_pnl_cache
                                            .write()
                                            .await
                                            .insert(account_id.to_string(), map.clone());
                                        let unrealized_pnl: f64 = map.values().sum();
                                        let round2 = |x: f64| (x * 100.0).round() / 100.0;
                                        let mut cache = state.account_info_cache.write().await;
                                        if let Some(ref mut dto) = cache.get_mut(account_id) {
                                            dto.unrealized_pnl = Some(round2(unrealized_pnl));
                                        } else {
                                            cache.insert(
                                                account_id.to_string(),
                                                AccountInfoDto {
                                                    account_id: account_id.to_string(),
                                                    unrealized_pnl: Some(round2(unrealized_pnl)),
                                                    ..Default::default()
                                                },
                                            );
                                        }
                                        let _ = state.orders_ws_notify_tx.send(());
                                    }
                                }
                                if ctrader_reconcile_received {
                                    snapshot::update_ctrader_snapshot_cache(
                                        account_id,
                                        &last_master_positions,
                                        &last_master_orders,
                                        &pos_id_to_ord_id,
                                        app_state.as_ref(),
                                        server_clock_offset_ms,
                                    )
                                    .await;
                                }
                            }
                            if live_account_info_pending {
                                if let Ok(map) = proto_oa::parse_get_position_unrealized_pnl_res(payload.as_ref()) {
                                    if let Some(ref state) = app_state {
                                        state
                                            .position_pnl_cache
                                            .write()
                                            .await
                                            .insert(account_id.to_string(), map.clone());
                                    }
                                    live_account_info_pnl = Some(map);
                                    try_update_live_account_info_cache(
                                        account_id,
                                        &mut live_account_info_trader,
                                        &mut live_account_info_assets,
                                        &mut live_account_info_pnl,
                                        &mut live_account_info_pending,
                                        &mut live_account_info_pending_since,
                                        app_state.as_ref(),
                                    )
                                    .await;
                                    if ctrader_reconcile_received {
                                        snapshot::update_ctrader_snapshot_cache(
                                            account_id,
                                            &last_master_positions,
                                            &last_master_orders,
                                            &pos_id_to_ord_id,
                                            app_state.as_ref(),
                                            server_clock_offset_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_HEARTBEAT_EVENT {
                            continue;
                        }
                        if payload_type == proto_oa::PROTO_OA_EXECUTION_EVENT {
if let Some(tx) = pending_create_reply.take() {
                                let _ = tx.send(Ok(()));
                            }
                        }
                        if payload_type != proto_oa::PROTO_OA_EXECUTION_EVENT {
                            continue;
                        }
                    }
                    Message::Close(_) => return Err("server closed".into()),
                    _ => {}
                }
            }
            Next::Msg(None) => return Err("connection closed".into()),
        }
    }
}

#[derive(Clone)]
pub enum CtraderReconnectScope {
    Full,
    Account(String),
}

pub async fn ctrader_cleanup_and_reconnect(state: &AppState, scope: CtraderReconnectScope) {
    match scope {
        CtraderReconnectScope::Full => {
            if let Some(ref tx) = *state.ctrader_disconnect_tx.read().await {
                let _ = tx.send_modify(|v| *v = v.wrapping_add(1));
            }
            let handles: Vec<_> = state.ctrader_account_handles.write().await.drain().collect();
            for (_account_id, handle) in handles {
                handle.abort();
            }
            let tcp_handles: Vec<_> = state.slave_tcp_handles.write().await.drain().collect();
            for (_id, handle) in tcp_handles {
                handle.abort();
            }
            state.ctrader_running_accounts.write().await.clear();
            state.ctrader_account_claimed.write().await.clear();
            state.ctrader_running_since.write().await.clear();
            state.ctrader_connected_accounts.write().await.clear();
            state.slave_tcp_connected_accounts.write().await.clear();
            state.copy_command_tx.write().await.clear();
            state.account_info_cache.write().await.clear();
            state.ctrader_realtime_stats_cache.write().await.clear();
            state.conversion_ui_online_accounts.write().await.clear();
            if let Some(ref mgr) = state.state_manager {
                let _ = mgr
                    .update(|snap| {
                        for entry in snap.accounts.values_mut() {
                            if entry.platform.eq_ignore_ascii_case("ctrader") {
                                entry.tcp_url = None;
                                entry.reconnect_type = Some("retry_credentials".to_string());
                            }
                        }
                    })
                    .await;
            }
            if let Some(handle) = state.ctrader_manager_handle.write().await.take() {
                handle.abort();
            }
            let (new_trigger_tx, new_trigger_rx) = tokio::sync::mpsc::channel(4);
            let (new_disconnect_tx, new_disconnect_rx) = tokio::sync::watch::channel(0u32);
            *state.ctrader_trigger_connect_tx.write().await = Some(new_trigger_tx.clone());
            *state.ctrader_disconnect_tx.write().await = Some(new_disconnect_tx);
            spawn_ctrader_ws_manager(
                state.ctrader_running_accounts.clone(),
                state.state_manager.clone(),
                state.tcp_server.clone(),
                Some(std::sync::Arc::new(state.clone())),
                Some(new_trigger_rx),
                new_disconnect_rx,
            );
            let _ = new_trigger_tx.try_send(());
        }
        CtraderReconnectScope::Account(account_id) => {
            state.conversion_ui_online_accounts.write().await.insert(account_id.clone());
            if let Some(handle) = state.ctrader_account_handles.write().await.remove(&account_id) {
                handle.abort();
            }
            if let Some(handle) = state.slave_tcp_handles.write().await.remove(&account_id) {
                handle.abort();
            }
            state.ctrader_running_accounts.write().await.remove(&account_id);
            state.ctrader_account_claimed.write().await.remove(&account_id);
            state.ctrader_running_since.write().await.remove(&account_id);
            state.ctrader_connected_accounts.write().await.remove(&account_id);
            state.slave_tcp_connected_accounts.write().await.remove(&account_id);
            state.copy_command_tx.write().await.remove(&account_id);
            state.account_info_cache.write().await.remove(&account_id);
            state.ctrader_realtime_stats_cache.write().await.remove(&account_id);
            if let Some(ref tx) = *state.ctrader_trigger_connect_tx.read().await {
                let _ = tx.try_send(());
            }
        }
    }
}

pub fn spawn_ctrader_ws_manager(
    running: Arc<RwLock<HashSet<String>>>,
    state_manager: Option<Arc<LocalStateFileManager>>,
    tcp_server: Option<Arc<TcpServer>>,
    app_state: Option<Arc<AppState>>,
    mut trigger_rx: Option<tokio::sync::mpsc::Receiver<()>>,
    disconnect_rx: watch::Receiver<u32>,
) {
    let mgr = state_manager.clone();
    let tcp = tcp_server.clone();
    let app = app_state.clone();
    let app_for_handle = app_state.clone();
    let mut disconnect_rx = disconnect_rx;

    let handle = tokio::spawn(async move {
        try_connect_pending_ctrader_accounts(mgr.as_ref(), &running, &tcp, &app, &mut disconnect_rx).await;

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(CTRADER_MANAGER_POLL_SECS));
        let mut trigger_closed = false;
        loop {
            if trigger_closed {
                trigger_rx = None;
                trigger_closed = false;
            }
            if let Some(ref mut rx) = trigger_rx {
                tokio::select! {
                    _ = interval.tick() => {
                        try_connect_pending_ctrader_accounts(mgr.as_ref(), &running, &tcp, &app, &mut disconnect_rx).await;
                    }
                    msg = rx.recv() => {
                        if msg.is_some() {
                            try_connect_pending_ctrader_accounts(mgr.as_ref(), &running, &tcp, &app, &mut disconnect_rx).await;
                        } else {
                            trigger_closed = true;
                        }
                    }
                }
            } else {
                interval.tick().await;
                try_connect_pending_ctrader_accounts(mgr.as_ref(), &running, &tcp, &app, &mut disconnect_rx).await;
            }
        }
    });
    if let Some(app) = app_for_handle {
        let app = app.clone();
        tokio::spawn(async move {
            *app.ctrader_manager_handle.write().await = Some(handle);
        });
    }
}

async fn try_connect_pending_ctrader_accounts(
    mgr: Option<&Arc<LocalStateFileManager>>,
    running: &Arc<RwLock<HashSet<String>>>,
    tcp: &Option<Arc<TcpServer>>,
    app: &Option<Arc<AppState>>,
    disconnect_rx: &mut watch::Receiver<u32>,
) {
    let Some(mgr) = mgr else { return };
    let global_copier_enabled = mgr
        .read(|s| s.preferences.as_ref().map_or(true, |p| p.global_copier_enabled))
        .await;
    if !global_copier_enabled {
        return;
    }
    let mgr_arc = mgr.clone();
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (master_ids, other_ids) = account_loop::get_eligible_ctrader_account_ids(mgr, true).await;

    let (masters_to_connect, others_to_connect): (Vec<String>, Vec<String>) = {
        let r = running.read().await;
        let masters: Vec<_> = master_ids.iter().filter(|id| !r.contains(*id)).cloned().collect();
        let others: Vec<_> = other_ids.iter().filter(|id| !r.contains(*id)).cloned().collect();
        (masters, others)
    };
    if !masters_to_connect.is_empty() || !others_to_connect.is_empty() {
        info!(
            masters = ?masters_to_connect,
            others = ?others_to_connect,
            "ctrader try_connect_pending: attempting ProtoOA connections"
        );
    }

    for account_id in master_ids {
        if let Some(ref state) = app {
            if state.ctrader_connected_accounts.read().await.contains(&account_id) {
                continue;
            }
            let mut claimed = state.ctrader_account_claimed.write().await;
            if !claimed.insert(account_id.clone()) {
                continue;
            }
            drop(claimed);
        }
        let mut r = running.write().await;
        if r.contains(&account_id) {
            if let Some(ref state) = app {
                state.ctrader_account_claimed.write().await.remove(&account_id);
            }
            continue;
        }
        r.insert(account_id.clone());
        if let Some(ref state) = app {
            state.ctrader_running_since.write().await.insert(account_id.clone(), now_secs);
        }
        drop(r);

        let state_mgr = Some(mgr_arc.clone());
        let tcp_srv = tcp.clone();
        let run = running.clone();
        let app_s = app.clone();
        let disc_rx = disconnect_rx.clone();
        let account_id_for_handle = account_id.clone();
        let account_id_for_spawn = account_id.clone();
        let app_for_handle = app.clone();
        let key_for_map = account_id.clone();
        let handle = tokio::spawn(async move {
            run_account_ws(account_id_for_spawn, state_mgr, tcp_srv, run, app_s, disc_rx).await;
            if let Some(ref state) = app_for_handle {
                state.ctrader_account_handles.write().await.remove(&account_id_for_handle);
                state.ctrader_account_claimed.write().await.remove(&account_id_for_handle);
            }
        });
        if let Some(ref state) = app {
            state.ctrader_account_handles.write().await.insert(key_for_map, handle);
        }
        let entry_opt = mgr_arc.read(|s| s.accounts.get(&account_id).cloned()).await;
        if let Some(entry) = entry_opt {
            let account_id_snap = account_id.clone();
            let app_snap = app.clone();
            let disc_snap = disconnect_rx.clone();
            tokio::spawn(async move {
                crate::services::ctrader_snapshot_connection::run_snapshot_connection(
                    account_id_snap, entry, app_snap, disc_snap,
                )
                .await;
            });
        }
    }

    for account_id in other_ids {
        if let Some(ref state) = app {
            if state.ctrader_connected_accounts.read().await.contains(&account_id) {
                continue;
            }
            let mut claimed = state.ctrader_account_claimed.write().await;
            if !claimed.insert(account_id.clone()) {
                continue;
            }
            drop(claimed);
        }
        let mut r = running.write().await;
        if r.contains(&account_id) {
            if let Some(ref state) = app {
                state.ctrader_account_claimed.write().await.remove(&account_id);
            }
            continue;
        }
        r.insert(account_id.clone());
        if let Some(ref state) = app {
            state.ctrader_running_since.write().await.insert(account_id.clone(), now_secs);
        }
        drop(r);

        let state_mgr = Some(mgr_arc.clone());
        let tcp_srv = tcp.clone();
        let run = running.clone();
        let app_s = app.clone();
        let disc_rx = disconnect_rx.clone();
        let account_id_for_handle = account_id.clone();
        let account_id_for_spawn = account_id.clone();
        let app_for_handle = app.clone();
        let key_for_map = account_id.clone();
        let handle = tokio::spawn(async move {
            run_account_ws(account_id_for_spawn, state_mgr, tcp_srv, run, app_s, disc_rx).await;
            if let Some(ref state) = app_for_handle {
                state.ctrader_account_handles.write().await.remove(&account_id_for_handle);
                state.ctrader_account_claimed.write().await.remove(&account_id_for_handle);
            }
        });
        if let Some(ref state) = app {
            state.ctrader_account_handles.write().await.insert(key_for_map, handle);
        }
        let entry_opt = mgr_arc.read(|s| s.accounts.get(&account_id).cloned()).await;
        if let Some(entry) = entry_opt {
            let account_id_snap = account_id.clone();
            let app_snap = app.clone();
            let disc_snap = disconnect_rx.clone();
            tokio::spawn(async move {
                crate::services::ctrader_snapshot_connection::run_snapshot_connection(
                    account_id_snap, entry, app_snap, disc_snap,
                )
                .await;
            });
        }
    }
}