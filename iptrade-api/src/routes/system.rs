use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

#[utoipa::path(get, path = "/api/health", tag = "System", responses((status = 200, body = serde_json::Value)))]
pub async fn health() -> impl IntoResponse {
    build_info_json()
}

#[utoipa::path(get, path = "/api/build-info", tag = "System", responses((status = 200, body = serde_json::Value)))]
pub async fn build_info() -> impl IntoResponse {
    build_info_json()
}

fn build_info_json() -> Json<serde_json::Value> {
    let build_mode = if cfg!(debug_assertions) { "debug" } else { "release" };
    let binary_version = env!("CARGO_PKG_VERSION");
    let shell_version = std::env::var("APP_VERSION").ok().filter(|s| !s.is_empty());
    // mismatch = Electron shell updated but native binary left stale
    let version_mismatch = shell_version.as_deref().map(|s| s != binary_version);
    Json(serde_json::json!({
        "status": "ok",
        "build": build_mode,
        "api_build_ver": binary_version,
        "shell_version": shell_version,
        "version_mismatch": version_mismatch,
    }))
}
use serde::Deserialize;
use crate::app_state::AppState;
use crate::routes::accounts::{apply_tcp_for_account, disconnect_all_mt_orders_ws};

pub async fn on_copy_engine_disabled(state: &AppState) {
    if let Some(ref tx) = *state.ctrader_disconnect_tx.read().await {
        let _ = tx.send_modify(|v| *v = v.wrapping_add(1));
    }
    if let Some(ref tx) = *state.copy_suspend_tx.read().await {
        let _ = tx.send_modify(|v| *v = v.wrapping_add(1));
    }
    disconnect_all_mt_orders_ws(state).await;
    state.ctrader_snapshot_cache.write().await.clear();
    state.ctrader_realtime_stats_cache.write().await.clear();
    state.mt_snapshot_cache.write().await.clear();
}

#[utoipa::path(
    put,
    path = "/api/system/engine/{status}",
    tag = "System",
    params(("status" = String, Path, description = "on or off")),
    responses((status = 204, description = ""), (status = 400, description = "Invalid status"))
)]
pub async fn engine(
    State(state): State<AppState>,
    Path(status): Path<String>,
) -> impl IntoResponse {
    let persist_global_copier_enabled = |enabled: bool| {
        let state_manager = state.state_manager.clone();
        async move {
            if let Some(ref mgr) = state_manager {
            mgr.update(|snap| {
                let mut prefs = snap.preferences.clone().unwrap_or_default();
                prefs.global_copier_enabled = enabled;
                snap.preferences = Some(prefs);
            })
            .await;
        }
        }
    };

    let status_lower = status.to_lowercase();
    if status_lower == "off" {
        persist_global_copier_enabled(false).await;
        apply_system_tcp_ordered(&state, false).await;
        on_copy_engine_disabled(&state).await;
        StatusCode::NO_CONTENT
    } else if status_lower == "on" {
        persist_global_copier_enabled(true).await;
        crate::services::ctrader_connection::ctrader_cleanup_and_reconnect(
            &state,
            crate::services::ctrader_connection::CtraderReconnectScope::Full,
        )
        .await;
        apply_system_tcp_ordered_from_preferences(&state).await;
        StatusCode::NO_CONTENT
    } else {
        StatusCode::BAD_REQUEST
    }
}

#[utoipa::path(
    post,
    path = "/api/system/shutdown",
    tag = "System",
    responses((status = 204, description = ""))
)]
pub async fn shutdown(State(state): State<AppState>) -> impl IntoResponse {
    apply_system_tcp_ordered(&state, false).await;
    let tx = state.shutdown_trigger_tx.lock().ok().and_then(|mut g| g.take());
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
    StatusCode::NO_CONTENT
}

pub async fn apply_system_tcp_ordered_from_preferences(state: &AppState) {
    let enabled = match &state.state_manager {
        Some(m) => m.read(|s| s.preferences.as_ref().map_or(true, |p| p.global_copier_enabled)).await,
        None => return,
    };
    apply_system_tcp_ordered(state, enabled).await;
}

pub async fn apply_system_tcp_ordered(state: &AppState, enabled: bool) {
    let mgr = match state.state_manager.as_ref() {
        Some(m) => m,
        None => return,
    };
    let mut list: Vec<(String, String, Option<bool>)> = mgr
        .read(|snap| {
            snap.accounts
                .iter()
                .map(|(id, e)| {
                    (
                        id.clone(),
                        e.role.as_deref().unwrap_or("pending").to_string(),
                        e.tcp_enabled,
                    )
                })
                .collect()
        })
        .await;
    let order_slave_first = !enabled;
    list.sort_by(|a, b| {
        let rank = |role: &str| -> u8 {
            if order_slave_first {
                match role {
                    "slave" => 0,
                    "master" => 1,
                    _ => 2,
                }
            } else {
                match role {
                    "master" => 0,
                    "slave" => 1,
                    _ => 2,
                }
            }
        };
        rank(a.1.as_str()).cmp(&rank(b.1.as_str()))
    });
    for (account_id, _, per_account) in list {
        let effective = enabled && per_account.unwrap_or(true);
        let _ = apply_tcp_for_account(state, &account_id, effective, false).await;
    }
    if !enabled {
        if let Some(ref tcp) = state.tcp_server {
            tcp.close_all_sessions().await;
        }
    }
    if enabled {
        let tx_guard = state.copy_manager_trigger_tx.read().await;
        if let Some(ref tx) = *tx_guard {
            let _ = tx.try_send(());
        }
    }
}


#[derive(Clone, Debug, Default, Deserialize, utoipa::ToSchema)]
pub struct UpdatePreferencesBody {
    pub show_nickname: Option<bool>,
    pub sounds_enabled: Option<bool>,
    #[serde(alias = "globalCopierEnabled")]
    pub global_copier_enabled: Option<bool>,
    pub show_slave_config_details: Option<bool>,
    #[serde(alias = "showOrdersTotals")]
    pub show_orders_totals: Option<bool>,
    #[serde(alias = "showResources")]
    pub show_resources: Option<bool>,
    #[serde(alias = "showBalance")]
    pub show_balance: Option<bool>,
    #[serde(alias = "showEquity")]
    pub show_equity: Option<bool>,
    #[serde(alias = "showPnl")]
    pub show_pnl: Option<bool>,
    #[serde(alias = "showOpenOrders")]
    pub show_open_orders: Option<bool>,
    #[serde(alias = "alwaysShowColumns")]
    pub always_show_columns: Option<bool>,
}

#[utoipa::path(
    put,
    path = "/api/system/preferences",
    tag = "System",
    request_body(content = UpdatePreferencesBody),
    responses(
        (status = 200, description = "", body = serde_json::Value),
        (status = 500, description = "", body = String)
    )
)]
pub async fn put_preferences(
    State(state): State<AppState>,
    Json(body): Json<UpdatePreferencesBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mgr = state
        .state_manager
        .as_ref()
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "State not available".to_string()))?;

    mgr.update(|snap| {
        let mut prefs = snap.preferences.clone().unwrap_or_default();
        if let Some(v) = body.show_nickname {
            prefs.show_nickname = v;
        }
        if let Some(v) = body.sounds_enabled {
            prefs.sounds_enabled = v;
        }
        if let Some(v) = body.global_copier_enabled {
            prefs.global_copier_enabled = v;
        }
        if let Some(v) = body.show_slave_config_details {
            prefs.show_slave_config_details = v;
        }
        if let Some(v) = body.show_orders_totals {
            prefs.show_orders_totals = v;
        }
        if let Some(v) = body.show_resources {
            prefs.show_resources = v;
        }
        if let Some(v) = body.show_balance {
            prefs.show_balance = v;
        }
        if let Some(v) = body.show_equity {
            prefs.show_equity = v;
        }
        if let Some(v) = body.show_pnl {
            prefs.show_pnl = v;
        }
        if let Some(v) = body.show_open_orders {
            prefs.show_open_orders = v;
        }
        if let Some(v) = body.always_show_columns {
            prefs.always_show_columns = v;
        }
        snap.preferences = Some(prefs);
    })
    .await;

    if let Some(enabled) = body.global_copier_enabled {
        apply_system_tcp_ordered(&state, enabled).await;
        if !enabled {
            on_copy_engine_disabled(&state).await;
        }
    }

    Ok(Json(serde_json::json!({ "success": true })))
}

pub fn health_route() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/health", axum::routing::get(health))
        .route("/api/build-info", axum::routing::get(build_info))
}

pub fn router() -> axum::Router<AppState> {
    let r = axum::Router::new()
        .route("/api/system/engine/:status", axum::routing::put(engine))
        .route("/api/system/shutdown", axum::routing::post(shutdown))
        .route("/api/system/preferences", axum::routing::put(put_preferences));
    r
}
