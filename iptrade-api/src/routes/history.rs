use crate::app_state::AppState;
use crate::routes::common::ApiResponse;
use crate::services::history::{model::CoveredRange, sync, HistoryDeal};
use crate::services::metatrader as mt;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub account_ids: Option<String>,
    #[serde(default)]
    pub force_refresh: Option<bool>,
    #[serde(default)]
    pub since_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct HistorySyncStatus {
    pub account_id: String,
    pub last_synced_ms: i64,
    pub oldest_synced_ms: i64,
    pub deals_count: usize,
    pub covered_ranges: Vec<CoveredRange>,
}

#[derive(Debug, Serialize)]
pub struct HistoryDealsResponse {
    pub deals: Vec<HistoryDeal>,
    pub sync_status: Vec<HistorySyncStatus>,
    pub server_now_ms: i64,
}

pub async fn get_deals(
    State(state): State<AppState>,
    Query(q): Query<HistoryQuery>,
) -> impl IntoResponse {
    let Some(ref store) = state.history_store else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiResponse::<HistoryDealsResponse> {
                success: false,
                data: None,
                message: Some("history store not initialized".into()),
                errors: None,
            }),
        )
            .into_response();
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let to_ms = q.to_ms.unwrap_or(now_ms);
    let from_ms = q.from_ms.unwrap_or(to_ms - 90 * 86_400_000);

    let requested_ids: Option<Vec<String>> = q.account_ids.as_ref().map(|s| {
        s.split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect()
    });

    let target_ids: Vec<String> = if let Some(ref ids) = requested_ids {
        if ids.is_empty() { all_eligible_ids(&state).await } else { ids.clone() }
    } else {
        all_eligible_ids(&state).await
    };

    let force = q.force_refresh.unwrap_or(false);
    {
        use futures_util::stream::StreamExt;
        const ENDPOINT_FETCH_CONCURRENCY: usize = 4;
        let tasks = target_ids.iter().cloned().map(|id| {
            let state = state.clone();
            let store = store.clone();
            async move {
                if let Err(e) =
                    sync::ensure_account_synced(&state, &store, &id, from_ms, to_ms, force).await
                {
                    tracing::warn!(account_id = %id, error = %e, "history endpoint: ensure_account_synced failed");
                }
            }
        });
        futures_util::stream::iter(tasks)
            .buffer_unordered(ENDPOINT_FETCH_CONCURRENCY)
            .for_each(|_| async {})
            .await;
    }

    let since_ms = q.since_ms;
    let idx = store.load_index().await;
    let per_account: Vec<(String, crate::services::history::model::HistoryAccountFile)> = {
        use futures_util::stream::StreamExt;
        const READ_CONCURRENCY: usize = 8;
        let tasks = target_ids.iter().cloned().map(|id| {
            let store = store.clone();
            async move {
                let file = store.load_account(&id).await;
                (id, file)
            }
        });
        futures_util::stream::iter(tasks)
            .buffer_unordered(READ_CONCURRENCY)
            .collect()
            .await
    };

    let mut all_deals: Vec<HistoryDeal> = Vec::new();
    let mut sync_status: Vec<HistorySyncStatus> = Vec::new();
    for (id, file) in per_account {
        for d in file.deals {
            let ts = if d.close_time_ms > 0 { d.close_time_ms } else { d.open_time_ms };
            if ts < from_ms || ts > to_ms {
                continue;
            }
            if let Some(s) = since_ms {
                if ts < s {
                    continue;
                }
            }
            all_deals.push(d);
        }
        let entry = idx.accounts.get(&id).cloned().unwrap_or_default();
        sync_status.push(HistorySyncStatus {
            account_id: id,
            last_synced_ms: entry.last_synced_ms,
            oldest_synced_ms: entry.oldest_synced_ms,
            deals_count: entry.deals_count,
            covered_ranges: entry.covered_ranges,
        });
    }

    all_deals.sort_by(|a, b| {
        let ta = if a.close_time_ms > 0 { a.close_time_ms } else { a.open_time_ms };
        let tb = if b.close_time_ms > 0 { b.close_time_ms } else { b.open_time_ms };
        tb.cmp(&ta)
    });

    let response = HistoryDealsResponse {
        deals: all_deals,
        sync_status,
        server_now_ms: now_ms,
    };
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

async fn all_eligible_ids(state: &AppState) -> Vec<String> {
    let Some(ref mgr) = state.state_manager else { return Vec::new() };
    mgr.read(|snap| {
        snap.accounts
            .iter()
            .filter(|(_, e)| sync::is_history_eligible(e))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    })
    .await
}

pub async fn get_eligible_accounts(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let mut out: Vec<HashMap<String, serde_json::Value>> = Vec::new();
    let Some(ref mgr) = state.state_manager else {
        return (
            StatusCode::OK,
            Json(ApiResponse::<Vec<HashMap<String, serde_json::Value>>> {
                success: true,
                data: Some(out),
                message: None,
                errors: None,
            }),
        )
            .into_response();
    };
    let entries = mgr
        .read(|snap| {
            snap.accounts
                .iter()
                .filter(|(_, e)| {
                    sync::is_history_eligible(e) || mt::is_metatrader_platform(&e.platform)
                })
                .map(|(id, e)| {
                    (
                        id.clone(),
                        e.platform.clone(),
                        e.server.clone(),
                        e.nickname.clone(),
                        e.connection_type.clone(),
                        e.role.clone(),
                        sync::is_history_eligible(e),
                    )
                })
                .collect::<Vec<_>>()
        })
        .await;
    for (id, platform, server, nickname, ct, role, eligible) in entries {
        let mut m = HashMap::new();
        m.insert("account_id".to_string(), serde_json::Value::String(id));
        m.insert("platform".to_string(), serde_json::Value::String(platform));
        m.insert("server".to_string(), server.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        m.insert("nickname".to_string(), nickname.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        m.insert("connection_type".to_string(), ct.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        m.insert("role".to_string(), role.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
        m.insert("eligible".to_string(), serde_json::Value::Bool(eligible));
        out.push(m);
    }
    (
        StatusCode::OK,
        Json(ApiResponse {
            success: true,
            data: Some(out),
            message: None,
            errors: None,
        }),
    )
        .into_response()
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/history/deals", axum::routing::get(get_deals))
        .route("/api/history/accounts", axum::routing::get(get_eligible_accounts))
}
