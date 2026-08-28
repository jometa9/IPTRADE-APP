mod install;

pub use install::{execute_install, InstallBotsBody};

use crate::app_state::AppState;
use crate::config::{API_KEY_HEADER, API_SECRET_HEADER};
use crate::middleware::AuthState;
use urlencoding::encode;
use futures_util::StreamExt;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing;

type MtWsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

pub fn is_metatrader_platform(platform: &str) -> bool {
    let p = platform.to_lowercase();
    p == "metatrader4" || p == "metatrader5" || p == "mt4" || p == "mt5"
}

pub fn orders_ws_url(api_url: &str) -> Option<String> {
    let trimmed = api_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let with_ws = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else if trimmed.starts_with("wss://") || trimmed.starts_with("ws://") {
        trimmed.to_string()
    } else {
        return None;
    };
    if with_ws.ends_with("/orders") {
        Some(with_ws)
    } else {
        Some(format!("{}/orders", with_ws.trim_end_matches('/')))
    }
}

pub fn ws_url_candidates(ws_url: &str) -> Vec<String> {
    let trimmed = ws_url.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.contains("://localhost:") {
        let with_127 = trimmed.replacen("://localhost:", "://127.0.0.1:", 1);
        return vec![with_127, trimmed.to_string()];
    }
    vec![trimmed.to_string()]
}

fn parse_orders_from_tcp_snapshot(value: &serde_json::Value) -> Option<(u32, u32)> {
    let open_n = value
        .get("open_positions")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32);
    let pend_n = value
        .get("pending_orders")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32);
    if open_n.is_some() || pend_n.is_some() {
        Some((open_n.unwrap_or(0), pend_n.unwrap_or(0)))
    } else {
        None
    }
}

fn parse_orders_from_json(value: &serde_json::Value) -> (Option<u32>, Option<u32>) {
    let open = parse_u32_from_json(value, &["open_orders", "openOrders", "open_positions", "openPositions"]);
    let pending = parse_u32_from_json(
        value,
        &["pending_orders", "pendingOrders", "pending_positions", "pendingPositions"],
    );
    (open, pending)
}

fn parse_orders_from_json_with_nested(value: &serde_json::Value) -> (Option<u32>, Option<u32>) {
    let mut open = parse_u32_from_json(value, &["open_orders", "openOrders", "open_positions", "openPositions"]);
    let mut pending = parse_u32_from_json(
        value,
        &["pending_orders", "pendingOrders", "pending_positions", "pendingPositions"],
    );
    for nested_key in ["data", "payload", "result"] {
        if let Some(nested) = value.get(nested_key) {
            let (o, p) = parse_orders_from_json(nested);
            if open.is_none() {
                open = o;
            }
            if pending.is_none() {
                pending = p;
            }
        }
    }
    (open, pending)
}

fn parse_balance_pnl_from_json(value: &serde_json::Value) -> (Option<f64>, Option<f64>) {
    let mut balance = parse_f64_from_json(
        value,
        &["balance", "Balance", "accountBalance", "account_balance"],
    );
    let mut equity = parse_f64_from_json(
        value,
        &[
            "equity",
            "Equity",
            "accountEquity",
            "account_equity",
            "marginEquity",
            "margin_equity",
            "freeMargin",
            "free_margin",
        ],
    );
    let mut unrealized_pnl = parse_f64_from_json(
        value,
        &[
            "unrealized_pnl",
            "unrealizedPnl",
            "profit",
            "Profit",
            "floatingProfit",
            "floating_profit",
            "floatingPnl",
            "floating_pnl",
            "totalProfit",
            "total_profit",
        ],
    );

    for nested_key in [
        "data",
        "payload",
        "result",
        "accountInformation",
        "accountInfo",
        "account",
        "info",
        "account_data",
        "accountData",
    ] {
        if let Some(nested) = value.get(nested_key) {
            if balance.is_none() {
                balance = parse_f64_from_json(
                    nested,
                    &["balance", "Balance", "accountBalance", "account_balance"],
                );
            }
            if equity.is_none() {
                equity = parse_f64_from_json(
                    nested,
                    &[
                        "equity",
                        "Equity",
                        "accountEquity",
                        "account_equity",
                        "marginEquity",
                        "margin_equity",
                        "freeMargin",
                        "free_margin",
                    ],
                );
            }
            if unrealized_pnl.is_none() {
                unrealized_pnl = parse_f64_from_json(
                    nested,
                    &[
                        "unrealized_pnl",
                        "unrealizedPnl",
                        "profit",
                        "Profit",
                        "floatingProfit",
                        "floating_profit",
                        "floatingPnl",
                        "floating_pnl",
                        "totalProfit",
                        "total_profit",
                    ],
                );
            }
        }
    }
    let pnl = unrealized_pnl.or_else(|| balance.and_then(|b| equity.map(|e| e - b)));
    (balance, pnl)
}

fn parse_f64_from_json(value: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = value.get(*key) {
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            if let Some(n) = v.as_i64() {
                return Some(n as f64);
            }
            if let Some(n) = v.as_u64() {
                return Some(n as f64);
            }
            if let Some(s) = v.as_str() {
                if let Ok(parsed) = s.parse::<f64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn parse_u32_from_json(value: &serde_json::Value, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(v) = value.get(*key) {
            if let Some(n) = v.as_u64() {
                if let Ok(out) = u32::try_from(n) {
                    return Some(out);
                }
            } else if let Some(s) = v.as_str() {
                if let Ok(parsed) = s.parse::<u32>() {
                    return Some(parsed);
                }
            } else if let Some(arr) = v.as_array() {
                return u32::try_from(arr.len()).ok();
            }
        }
    }
    None
}

pub fn run_mt_orders_reader(
    state: Arc<AppState>,
    account_id: String,
    ws_url: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match connect_orders_ws(&state, &account_id, &ws_url).await {
                Ok(mut stream) => {
                    tracing::info!(account_id = %account_id, "MT orders WS connected");
                    loop {
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(60),
                            stream.next(),
                        )
                        .await
                        {
                            Err(_) => {
                                continue;
                            }
                            Ok(None) => break,
                            Ok(Some(Err(e))) => {
                                tracing::warn!(account_id = %account_id, error = %e, "MT orders WS stream error");
                                break;
                            }
                            Ok(Some(Ok(msg))) => {
                                let text = match msg {
                                    tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
                                    tokio_tungstenite::tungstenite::Message::Binary(b) => {
                                        String::from_utf8_lossy(&b).to_string()
                                    }
                                    _ => continue,
                                };
                                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                    let (open_opt, pending_opt) =
                                        match parse_orders_from_tcp_snapshot(&json) {
                                            Some((o, p)) => (Some(o), Some(p)),
                                            None => parse_orders_from_json_with_nested(&json),
                                        };
                                    let (balance_opt, pnl_opt) = parse_balance_pnl_from_json(&json);
                                    if let Ok(snapshot) = serde_json::from_value::<
                                        crate::services::account_history::TcpSnapshotMessage,
                                    >(json.clone())
                                    {
                                        state
                                            .mt_snapshot_cache
                                            .write()
                                            .await
                                            .insert(account_id.clone(), snapshot);
                                    }
                                    let has_any = open_opt.is_some()
                                        || pending_opt.is_some()
                                        || balance_opt.is_some()
                                        || pnl_opt.is_some();
                                    if has_any {
                                        let mut stats = state
                                            .mt_realtime_stats_cache
                                            .read()
                                            .await
                                            .get(&account_id)
                                            .cloned()
                                            .unwrap_or_default();
                                        if let Some(o) = open_opt {
                                            stats.open_positions = o;
                                        }
                                        if let Some(p) = pending_opt {
                                            stats.pending_orders = p;
                                        }
                                        if let Some(b) = balance_opt {
                                            stats.balance = Some(b);
                                        }
                                        if let Some(p) = pnl_opt {
                                            stats.unrealized_pnl = Some(p);
                                        }
                                        state
                                            .mt_realtime_stats_cache
                                            .write()
                                            .await
                                            .insert(account_id.clone(), stats);
                                        let _ = state.orders_ws_notify_tx.send(());
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(account_id = %account_id, error = %e, "MT orders WS connect failed");
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    })
}

async fn connect_orders_ws(
    state: &AppState,
    account_id: &str,
    ws_url: &str,
) -> Result<MtWsStream, String> {
    tracing::info!(account_id = %account_id, "MT orders WS connecting");
    let key_with_month = AuthState::key_with_month(&state.auth_state.api_key);
    let secret_with_month = AuthState::key_with_month(&state.auth_state.api_secret);
    let candidates = ws_url_candidates(ws_url);
    if candidates.is_empty() {
        return Err(format!("no ws candidates for {account_id}"));
    }
    let mut last_err = String::new();
    for candidate in candidates {
        let url_with_auth = if candidate.contains('?') {
            format!("{}&api_key={}&api_secret={}", candidate, encode(&key_with_month), encode(&secret_with_month))
        } else {
            format!("{}?api_key={}&api_secret={}", candidate, encode(&key_with_month), encode(&secret_with_month))
        };
        let mut req = url_with_auth
            .as_str()
            .into_client_request()
            .map_err(|e| format!("request build error for {account_id}: {e}"))?;
        let key_header = axum::http::HeaderValue::from_str(&key_with_month)
            .map_err(|e| format!("invalid api key header for {account_id}: {e}"))?;
        let secret_header = axum::http::HeaderValue::from_str(&secret_with_month)
            .map_err(|e| format!("invalid api secret header for {account_id}: {e}"))?;
        req.headers_mut().insert(API_KEY_HEADER, key_header);
        req.headers_mut().insert(API_SECRET_HEADER, secret_header);
        let connect = match tokio::time::timeout(
            std::time::Duration::from_millis(3000),
            tokio_tungstenite::connect_async(req),
        )
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                last_err = format!("connect failed for {account_id}: {e}");
                continue;
            }
            Err(_) => {
                last_err = format!("connect timeout for {account_id}");
                continue;
            }
        };
        let (stream, _) = connect;
        return Ok(stream);
    }
    Err(last_err)
}
