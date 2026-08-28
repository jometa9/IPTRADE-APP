use crate::app_state::AppState;
use crate::middleware::AuthState;
use crate::routes::common::ApiResponse;
use crate::services::account_history::TcpSnapshotMessage;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct LivePositionRow {
    pub account_id: String,
    pub platform: String,
    pub server: Option<String>,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub ticket: i64,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub volume: f64,
    pub open_price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub age_seconds: u64,
    pub profit: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LivePendingRow {
    pub account_id: String,
    pub platform: String,
    pub server: Option<String>,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub ticket: i64,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub volume: f64,
    pub price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub age_seconds: u64,
    pub magic: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct OpenOrdersResponse {
    pub positions: Vec<LivePositionRow>,
    pub pending: Vec<LivePendingRow>,
    pub server_now_ms: i64,
}

#[derive(Default, Clone)]
struct AccountMeta {
    platform: String,
    server: Option<String>,
    nickname: Option<String>,
    role: Option<String>,
}

async fn build_open_orders_payload(state: &AppState) -> OpenOrdersResponse {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let metas: std::collections::HashMap<String, AccountMeta> = if let Some(ref mgr) = state.state_manager {
        mgr.read(|snap| {
            snap.accounts
                .iter()
                .map(|(id, e)| {
                    (
                        id.clone(),
                        AccountMeta {
                            platform: e.platform.clone(),
                            server: e.server.clone(),
                            nickname: e.nickname.clone(),
                            role: e.role.clone(),
                        },
                    )
                })
                .collect()
        })
        .await
    } else {
        std::collections::HashMap::new()
    };

    let mut positions_map: std::collections::HashMap<(String, i64), LivePositionRow> =
        std::collections::HashMap::new();
    let mut pending_map: std::collections::HashMap<(String, i64), LivePendingRow> =
        std::collections::HashMap::new();

    let push_from_snapshot =
        |positions: &mut std::collections::HashMap<(String, i64), LivePositionRow>,
         pending: &mut std::collections::HashMap<(String, i64), LivePendingRow>,
         account_id: &str,
         meta: &AccountMeta,
         snap: &TcpSnapshotMessage| {
            for p in &snap.open_positions {
                positions.insert(
                    (account_id.to_string(), p.ticket),
                    LivePositionRow {
                        account_id: account_id.to_string(),
                        platform: meta.platform.clone(),
                        server: meta.server.clone(),
                        nickname: meta.nickname.clone(),
                        role: meta.role.clone(),
                        ticket: p.ticket,
                        symbol: p.symbol.clone(),
                        side: p.side.clone(),
                        kind: p.r#type.clone(),
                        volume: p.volume,
                        open_price: p.open_price,
                        sl: p.sl,
                        tp: p.tp,
                        age_seconds: p.age_seconds,
                        profit: p.profit,
                    },
                );
            }
            for o in &snap.pending_orders {
                pending.insert(
                    (account_id.to_string(), o.ticket),
                    LivePendingRow {
                        account_id: account_id.to_string(),
                        platform: meta.platform.clone(),
                        server: meta.server.clone(),
                        nickname: meta.nickname.clone(),
                        role: meta.role.clone(),
                        ticket: o.ticket,
                        symbol: o.symbol.clone(),
                        side: o.side.clone(),
                        kind: o.r#type.clone(),
                        volume: o.volume,
                        price: o.price,
                        sl: o.sl,
                        tp: o.tp,
                        age_seconds: o.age_seconds,
                        magic: o.magic,
                    },
                );
            }
        };

    {
        let snaps = state.ctrader_snapshot_cache.read().await;
        for (id, snap) in snaps.iter() {
            let meta = metas.get(id).cloned().unwrap_or(AccountMeta {
                platform: "ctrader".to_string(),
                ..Default::default()
            });
            push_from_snapshot(&mut positions_map, &mut pending_map, id, &meta, snap);
        }
    }

    {
        let snaps = state.mt_snapshot_cache.read().await;
        for (id, snap) in snaps.iter() {
            let meta = metas.get(id).cloned().unwrap_or(AccountMeta {
                platform: "metatrader5".to_string(),
                ..Default::default()
            });
            push_from_snapshot(&mut positions_map, &mut pending_map, id, &meta, snap);
        }
    }

    let mut positions: Vec<LivePositionRow> = positions_map.into_values().collect();
    let mut pending: Vec<LivePendingRow> = pending_map.into_values().collect();
    positions.sort_by(|a, b| a.ticket.cmp(&b.ticket).then_with(|| a.account_id.cmp(&b.account_id)));
    pending.sort_by(|a, b| a.ticket.cmp(&b.ticket).then_with(|| a.account_id.cmp(&b.account_id)));

    OpenOrdersResponse {
        positions,
        pending,
        server_now_ms: now_ms,
    }
}

pub async fn get_open_orders(State(state): State<AppState>) -> impl IntoResponse {
    let response = build_open_orders_payload(&state).await;
    (
        StatusCode::OK,
        Json(ApiResponse {
            success: true,
            data: Some(response),
            message: None,
            errors: None,
        }),
    )
        .into_response()
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenOrdersWsQuery {
    #[serde(alias = "apikey")]
    pub api_key: Option<String>,
    #[serde(alias = "apisecret")]
    pub api_secret: Option<String>,
}

pub async fn open_orders_ws(
    State(state): State<AppState>,
    Query(query): Query<OpenOrdersWsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    let provided_key = query
        .api_key
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let provided_secret = query
        .api_secret
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let expected_key = AuthState::key_with_month(&state.auth_state.api_key);
    let expected_secret = AuthState::key_with_month(&state.auth_state.api_secret);
    let authorized = match (provided_key, provided_secret) {
        (Some(k), Some(s)) => k == expected_key && s == expected_secret,
        _ => false,
    };
    if !authorized {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let (rx, is_first) = state.open_orders_ws_subscribers.add_subscriber().await;
    if is_first {
        tokio::spawn(run_open_orders_broadcaster(Arc::new(state.clone())));
    }
    Ok(ws.on_upgrade(move |socket| open_orders_forward(socket, rx)))
}

async fn open_orders_forward(
    mut socket: WebSocket,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    while let Some(json) = rx.recv().await {
        if socket.send(Message::Text(json.into())).await.is_err() {
            break;
        }
    }
}

async fn run_open_orders_broadcaster(state: Arc<AppState>) {
    const DEBOUNCE_MS: u64 = 450;
    const QUIET_WINDOW_MS: u64 = 120;
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut notify_rx = state.orders_ws_notify_tx.subscribe();
    let mut last_signature: Option<String> = None;

    loop {
        let woke_by_notify = tokio::select! {
            _ = tick.tick() => false,
            res = notify_rx.recv() => match res {
                Ok(_) => true,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
        };

        if woke_by_notify {
            tokio::time::sleep(std::time::Duration::from_millis(DEBOUNCE_MS)).await;
            loop {
                let mut got_more = false;
                while notify_rx.try_recv().is_ok() {
                    got_more = true;
                }
                if !got_more {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(QUIET_WINDOW_MS)).await;
            }
        }
        while notify_rx.try_recv().is_ok() {}

        let payload = build_open_orders_payload(&state).await;
        let signature = match serde_json::to_string(&(&payload.positions, &payload.pending)) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "open_orders signature serialize failed");
                continue;
            }
        };
        if last_signature.as_deref() == Some(signature.as_str()) {
            continue;
        }
        let json = match serde_json::to_string(&payload) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "open_orders payload serialize failed");
                continue;
            }
        };
        if !state.open_orders_ws_subscribers.broadcast(json).await {
            break;
        }
        last_signature = Some(signature);
    }
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/orders/open", axum::routing::get(get_open_orders))
        .route("/api/orders/open/ws", axum::routing::get(open_orders_ws))
}
