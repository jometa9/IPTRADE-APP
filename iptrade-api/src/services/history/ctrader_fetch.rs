use super::model::HistoryDeal;
use super::symbols_cache::CtraderSymbolsCache;
use crate::services::ctrader::oauth;
use crate::services::proto_oa::{
    self, money_scale, parse_deal_list_res, ClosePositionDetail, ProtoOADeal,
};
use crate::state::AccountEntry;
use crate::timings::CTRADER_CONNECT_TIMEOUT_SECS;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const FETCH_PAGE_MAX_ROWS: i32 = 1000;
const REQ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const WAIT_MAX_MSGS: usize = 200;
const CTRADER_DEAL_LIST_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000 - 60_000;
const MAX_TOTAL_PAGES: usize = 200;

pub async fn fetch_ctrader_deals(
    entry: &AccountEntry,
    from_ms: i64,
    to_ms: i64,
    symbols_cache: &CtraderSymbolsCache,
) -> Result<Vec<HistoryDeal>, String> {
    let client_id = entry
        .client_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing client_id".to_string())?;
    let client_secret = entry
        .client_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing client_secret".to_string())?;
    let access_token = entry
        .access_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing access_token".to_string())?;
    let ctid = entry
        .ctid_trader_account_id
        .or_else(|| entry.account_id.parse().ok())
        .ok_or_else(|| "missing ctidTraderAccountId".to_string())?;
    let is_live = entry.is_live.unwrap_or(false);
    let host = oauth::protooa_host_for_account(is_live);
    let url = format!("wss://{}:{}", host, oauth::protooa_port());

    let connect_timeout = std::time::Duration::from_secs(CTRADER_CONNECT_TIMEOUT_SECS);

    tracing::info!(
        account_id = %entry.account_id,
        ctid,
        is_live,
        from_ms,
        to_ms,
        "ctrader history: connecting (isolated WS, separate from copy)"
    );

    let (ws_stream, _) = tokio::time::timeout(connect_timeout, connect_async(&url))
        .await
        .map_err(|_| "ctrader history: connect timeout".to_string())?
        .map_err(|e| format!("ctrader history: connect: {}", e))?;
    let (mut write, mut read) = ws_stream.split();

    let auth_body = proto_oa::encode_application_auth_req(client_id, client_secret);
    tokio::time::timeout(REQ_TIMEOUT, write.send(Message::Binary(auth_body)))
        .await
        .map_err(|_| "send app auth timeout".to_string())?
        .map_err(|e| format!("send app auth: {}", e))?;
    if !wait_for_payload_type(&mut read, proto_oa::PROTO_OA_APPLICATION_AUTH_RES).await? {
        return Err("app auth not confirmed".into());
    }

    let acc_auth = proto_oa::encode_account_auth_req(ctid, access_token);
    tokio::time::timeout(REQ_TIMEOUT, write.send(Message::Binary(acc_auth)))
        .await
        .map_err(|_| "send account auth timeout".to_string())?
        .map_err(|e| format!("send account auth: {}", e))?;
    if !wait_for_payload_type(&mut read, proto_oa::PROTO_OA_ACCOUNT_AUTH_RES).await? {
        return Err("account auth not confirmed".into());
    }

    let symbol_id_to_name = if let Some(cached) = symbols_cache.get(ctid).await {
        tracing::debug!(
            account_id = %entry.account_id,
            symbols = cached.len(),
            "ctrader history: symbol names loaded from cache"
        );
        cached
    } else {
        let map = load_symbol_names(ctid, &mut write, &mut read).await?;
        let stored = symbols_cache.set(ctid, map).await;
        tracing::debug!(
            account_id = %entry.account_id,
            symbols = stored.len(),
            "ctrader history: symbol names loaded from broker"
        );
        stored
    };

    let mut deals_by_id: HashMap<i64, ProtoOADeal> = HashMap::new();
    let mut window_to = to_ms;
    let mut total_pages = 0usize;
    while window_to > from_ms && total_pages < MAX_TOTAL_PAGES {
        let window_from = (window_to - CTRADER_DEAL_LIST_WINDOW_MS).max(from_ms);
        let mut current_to = window_to;
        let current_from = window_from;
        loop {
            total_pages += 1;
            if total_pages > MAX_TOTAL_PAGES {
                tracing::warn!(account_id = %entry.account_id, "ctrader history: hit page cap, stopping early");
                break;
            }
            let req = proto_oa::encode_deal_list_req(ctid, current_from, current_to, FETCH_PAGE_MAX_ROWS);
            tokio::time::timeout(REQ_TIMEOUT, write.send(Message::Binary(req)))
                .await
                .map_err(|_| "send deal list timeout".to_string())?
                .map_err(|e| format!("send deal list: {}", e))?;

            let (deals, has_more) = wait_for_deal_list_res(&mut read).await?;
            let received = deals.len();
            tracing::debug!(
                account_id = %entry.account_id,
                window_from = current_from,
                window_to = current_to,
                received,
                has_more,
                "ctrader history: deal list page received"
            );
            if deals.is_empty() {
                break;
            }
            let mut min_ts = i64::MAX;
            for d in deals {
                let ts = d.execution_timestamp_ms;
                if ts > 0 && ts < min_ts {
                    min_ts = ts;
                }
                deals_by_id.insert(d.deal_id, d);
            }
            if !has_more || min_ts == i64::MAX {
                break;
            }
            let next_to = min_ts - 1;
            if next_to <= current_from {
                break;
            }
            current_to = next_to;
        }
        if window_from <= from_ms {
            break;
        }
        window_to = window_from - 1;
    }

    tracing::info!(
        account_id = %entry.account_id,
        deals = deals_by_id.len(),
        pages = total_pages,
        "ctrader history: fetch complete"
    );

    let raw_deals: Vec<ProtoOADeal> = deals_by_id.into_values().collect();
    let mut grouped: HashMap<i64, Vec<ProtoOADeal>> = HashMap::new();
    for d in raw_deals {
        let key = if d.position_id != 0 { d.position_id } else { d.deal_id };
        grouped.entry(key).or_default().push(d);
    }

    let mut out: Vec<HistoryDeal> = Vec::new();
    for (_pos_id, mut deals) in grouped {
        deals.sort_by_key(|d| d.execution_timestamp_ms);
        let entry_deal = deals.iter().find(|d| !d.close_detail.has_close_detail).cloned();
        let close_deal = deals.iter().rev().find(|d| d.close_detail.has_close_detail).cloned();

        if let Some(ref close) = close_deal {
            out.push(make_history_deal_from_close(
                &entry_deal,
                close,
                symbol_id_to_name.as_ref(),
                &entry.account_id,
                &entry.platform,
                entry.server.clone(),
            ));
        } else if let Some(open) = entry_deal {
            out.push(make_history_deal_open(
                &open,
                symbol_id_to_name.as_ref(),
                &entry.account_id,
                &entry.platform,
                entry.server.clone(),
            ));
        }
    }

    let _ = write.close().await;

    Ok(out)
}

fn make_history_deal_from_close(
    entry_deal: &Option<ProtoOADeal>,
    close: &ProtoOADeal,
    symbol_id_to_name: &HashMap<u64, String>,
    account_id: &str,
    platform: &str,
    server: Option<String>,
) -> HistoryDeal {
    let scale = money_scale(close.money_digits);
    let detail: &ClosePositionDetail = &close.close_detail;
    let profit = (detail.gross_profit_raw as f64) / scale;
    let swap = (detail.swap_raw as f64) / scale;
    let commission = ((detail.commission_raw + entry_deal.as_ref().map(|d| d.commission_raw).unwrap_or(0)) as f64) / scale;
    let net = profit + swap + commission;
    let symbol = symbol_id_to_name
        .get(&close.symbol_id)
        .cloned()
        .unwrap_or_else(|| close.symbol_id.to_string());
    let side = match entry_deal.as_ref().map(|d| d.trade_side).unwrap_or(close.trade_side) {
        1 => "buy",
        2 => "sell",
        _ => "buy",
    }
    .to_string();
    let open_time_ms = entry_deal
        .as_ref()
        .map(|d| d.execution_timestamp_ms)
        .unwrap_or(close.execution_timestamp_ms);
    let close_time_ms = close.execution_timestamp_ms;
    let open_price = detail
        .entry_price
        .or_else(|| entry_deal.as_ref().and_then(|d| d.execution_price));
    let close_price = close.execution_price;
    let volume = (detail.closed_volume.max(close.filled_volume).max(close.volume) as f64) / 100.0;
    let position_id = if close.position_id != 0 {
        Some(close.position_id.to_string())
    } else {
        None
    };
    HistoryDeal {
        deal_id: format!("ct-{}-{}", account_id, close.deal_id),
        account_id: account_id.to_string(),
        platform: platform.to_string(),
        server,
        connection_type: Some("ctrader".to_string()),
        symbol,
        side,
        volume,
        open_price,
        close_price,
        open_time_ms,
        close_time_ms,
        sl: None,
        tp: None,
        commission,
        swap,
        profit,
        net_profit: net,
        position_id,
        ticket: Some(close.deal_id),
    }
}

fn make_history_deal_open(
    deal: &ProtoOADeal,
    symbol_id_to_name: &HashMap<u64, String>,
    account_id: &str,
    platform: &str,
    server: Option<String>,
) -> HistoryDeal {
    let symbol = symbol_id_to_name
        .get(&deal.symbol_id)
        .cloned()
        .unwrap_or_else(|| deal.symbol_id.to_string());
    let side = match deal.trade_side {
        1 => "buy",
        2 => "sell",
        _ => "buy",
    }
    .to_string();
    let scale = money_scale(deal.money_digits);
    let commission = (deal.commission_raw as f64) / scale;
    let volume = (deal.filled_volume.max(deal.volume) as f64) / 100.0;
    let position_id = if deal.position_id != 0 {
        Some(deal.position_id.to_string())
    } else {
        None
    };
    HistoryDeal {
        deal_id: format!("ct-{}-{}", account_id, deal.deal_id),
        account_id: account_id.to_string(),
        platform: platform.to_string(),
        server,
        connection_type: Some("ctrader".to_string()),
        symbol,
        side,
        volume,
        open_price: deal.execution_price,
        close_price: None,
        open_time_ms: deal.execution_timestamp_ms,
        close_time_ms: 0,
        sl: None,
        tp: None,
        commission,
        swap: 0.0,
        profit: 0.0,
        net_profit: commission,
        position_id,
        ticket: Some(deal.deal_id),
    }
}

async fn wait_for_payload_type(
    read: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    target: i32,
) -> Result<bool, String> {
    for _ in 0..WAIT_MAX_MSGS {
        let msg = tokio::time::timeout(REQ_TIMEOUT, read.next())
            .await
            .map_err(|_| "wait response timeout".to_string())?
            .ok_or_else(|| "connection closed".to_string())?
            .map_err(|e| format!("read: {}", e))?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == target {
                    return Ok(true);
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or_default();
                    return Err(format!("ctrader error: {} {}", c, d));
                }
            }
        }
    }
    Err(format!("payload type {} not received within {} messages", target, WAIT_MAX_MSGS))
}

async fn wait_for_deal_list_res(
    read: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
) -> Result<(Vec<ProtoOADeal>, bool), String> {
    for _ in 0..WAIT_MAX_MSGS {
        let msg = tokio::time::timeout(REQ_TIMEOUT, read.next())
            .await
            .map_err(|_| "wait deal list timeout".to_string())?
            .ok_or_else(|| "connection closed".to_string())?
            .map_err(|e| format!("read: {}", e))?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_DEAL_LIST_RES {
                    return parse_deal_list_res(&pl);
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or_default();
                    return Err(format!("ctrader deal list error: {} {}", c, d));
                }
            }
        }
    }
    Err("deal list response not received".into())
}

async fn load_symbol_names(
    ctid: u64,
    write: &mut futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    read: &mut futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
) -> Result<HashMap<u64, String>, String> {
    let req = proto_oa::encode_symbols_list_req(ctid);
    tokio::time::timeout(REQ_TIMEOUT, write.send(Message::Binary(req)))
        .await
        .map_err(|_| "send symbols list timeout".to_string())?
        .map_err(|e| format!("send symbols list: {}", e))?;

    for _ in 0..WAIT_MAX_MSGS {
        let msg = tokio::time::timeout(REQ_TIMEOUT, read.next())
            .await
            .map_err(|_| "wait symbols list timeout".to_string())?
            .ok_or_else(|| "connection closed".to_string())?
            .map_err(|e| format!("read: {}", e))?;
        if let Message::Binary(b) = &msg {
            if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(b) {
                if pt == proto_oa::PROTO_OA_SYMBOLS_LIST_RES {
                    if let Ok(result) = proto_oa::parse_symbols_list_res(&pl) {
                        return Ok(result.id_to_name);
                    }
                    return Ok(HashMap::new());
                }
                if pt == proto_oa::PROTO_OA_ERROR_RES {
                    let (c, d) = proto_oa::parse_error_res(&pl).unwrap_or_default();
                    return Err(format!("symbols list error: {} {}", c, d));
                }
            }
        }
    }
    Ok(HashMap::new())
}
