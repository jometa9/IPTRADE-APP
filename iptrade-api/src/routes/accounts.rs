use crate::services::connection_status::{self, NODE_HEARTBEAT_TIMEOUT_SECS};
use crate::services::metatrader::{self as mt};
use crate::util;

use axum::{
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::config::{API_KEY_HEADER, API_SECRET_HEADER};
use crate::middleware::AuthState;
use std::sync::Arc;
use crate::timings;
use crate::routes::common::ApiResponse;
use crate::services::account_history::AccountInfoDto;
use crate::state::{AccountEntry, AppPreferences, LocalStateSnapshot, PrefixSuffixConfig};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
use tracing;

fn resolve_account_key(snap: &LocalStateSnapshot, path_id: &str) -> Option<String> {
    if snap.accounts.contains_key(path_id) {
        Some(path_id.to_string())
    } else {
        None
    }
}

pub async fn disconnect_all_mt_orders_ws(state: &AppState) {
    let mut handles = state.mt_reader_handles.write().await;
    for handle in handles.drain().map(|(_, h)| h) {
        handle.abort();
    }
    state.mt_realtime_stats_cache.write().await.clear();
    state.mt_snapshot_cache.write().await.clear();
}

pub async fn clear_runtime_account_state(state: &AppState, account_id: &str) {
    state.tcp_enabled.write().await.remove(account_id);
    if let Some(handle) = state.mt_reader_handles.write().await.remove(account_id) {
        handle.abort();
    }
    state.mt_realtime_stats_cache.write().await.remove(account_id);
    state.mt_snapshot_cache.write().await.remove(account_id);
    state.ctrader_snapshot_cache.write().await.remove(account_id);
}

pub async fn clear_runtime_all_account_state(state: &AppState) {
    state.tcp_enabled.write().await.clear();
    let mut handles = state.mt_reader_handles.write().await;
    for handle in handles.drain().map(|(_, h)| h) {
        handle.abort();
    }
    state.mt_realtime_stats_cache.write().await.clear();
    state.mt_snapshot_cache.write().await.clear();
    state.ctrader_snapshot_cache.write().await.clear();
}

#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Connected,
    Connecting,
    Offline,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AccountStatusDto {
    pub account_id: String,
    pub nickname: Option<String>,
    pub platform: String,
    pub server: Option<String>,
    pub role: Option<String>,
    pub tcp_url: Option<String>,
    pub master_account_id: Option<String>,
    pub master_tcp_url: Option<String>,
    pub api_url: Option<String>,
    pub status: ConnectionStatus,
    pub tcp_enabled: Option<bool>,
    pub lot_type: Option<String>,
    pub lot_multiplier: Option<f64>,
    pub fixed_lot: Option<f64>,
    pub reverse_trading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_match: Option<bool>,
    pub symbol_translations: Option<Vec<String>>,
    pub prefix: Option<PrefixSuffixConfig>,
    pub suffix: Option<PrefixSuffixConfig>,
    pub slave_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unrealized_pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "connectionType", alias = "mt5_connection_type")]
    pub connection_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AccountOrdersDto {
    pub account_id: String,
    pub open_orders: u32,
    pub pending_orders: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountInfoDto>,
}

#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct AggregateOrdersDto {
    #[serde(rename = "type")]
    pub message_type: String,
    pub open_orders: u32,
    pub pending_orders: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<AccountOrdersDto>,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AggregateOrdersWsQuery {
    #[serde(alias = "apikey")]
    pub api_key: Option<String>,
    #[serde(alias = "apisecret")]
    pub api_secret: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AppSettings {
    pub linking_ctrader_accounts: bool,
    pub deleting_all_accounts: bool,
    pub show_nickname: bool,
    pub sounds_enabled: bool,
    pub global_copier_enabled: bool,
    pub show_slave_config_details: bool,
    pub show_orders_totals: bool,
    pub show_resources: bool,
    pub show_balance: bool,
    pub show_equity: bool,
    pub show_pnl: bool,
    pub show_open_orders: bool,
    pub always_show_columns: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Resources {
    pub cpu_usage_percent: u32,
    pub ram_used_percent: u32,
}

async fn get_system_resources() -> Resources {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return Resources {
            cpu_usage_percent: 0,
            ram_used_percent: 0,
        };
    }
    let (cpu_usage_percent, ram_used_percent) =
        tokio::task::spawn_blocking(|| {
            let mut sys = System::new_with_specifics(
                RefreshKind::nothing()
                    .with_cpu(CpuRefreshKind::everything())
                    .with_memory(MemoryRefreshKind::everything()),
            );
            let ram_total = sys.total_memory();
            let ram_used_percent = if ram_total > 0 {
                ((sys.used_memory() as f64 / ram_total as f64) * 100.0).round() as u32
            } else {
                0
            };
            #[cfg(target_os = "windows")]
            let cpu_sleep = sysinfo::MINIMUM_CPU_UPDATE_INTERVAL
                .saturating_add(std::time::Duration::from_millis(150));
            #[cfg(not(target_os = "windows"))]
            let cpu_sleep = sysinfo::MINIMUM_CPU_UPDATE_INTERVAL;
            sys.refresh_cpu_usage();
            std::thread::sleep(cpu_sleep);
            sys.refresh_cpu_usage();
            let mut cpu_usage_percent =
                (sys.global_cpu_usage() as f64).round().clamp(0.0, 100.0) as u32;
            if cpu_usage_percent == 0 && !sys.cpus().is_empty() {
                let sum: f64 = sys.cpus().iter().map(|c| c.cpu_usage() as f64).sum();
                let avg = sum / sys.cpus().len() as f64;
                cpu_usage_percent = avg.round().clamp(0.0, 100.0) as u32;
            }
            (cpu_usage_percent, ram_used_percent)
        })
        .await
        .unwrap_or((0, 0));
    Resources {
        cpu_usage_percent,
        ram_used_percent,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UnifiedStatusResponse {
    pub accounts: Vec<AccountStatusDto>,
    pub app: AppSettings,
    pub resources: Resources,
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
pub struct ConfigureAccountBody {
    pub nickname: Option<String>,
    pub role: Option<String>,
    #[serde(alias = "masterAccountId")]
    pub master_account_id: Option<String>,
    #[serde(alias = "masterTcpUrl")]
    pub master_tcp_url: Option<String>,
    #[serde(alias = "disconnectFromMaster")]
    pub disconnect_from_master: Option<bool>,
    #[serde(alias = "lotType")]
    pub lot_type: Option<String>,
    #[serde(alias = "lotMultiplier")]
    pub lot_multiplier: Option<f64>,
    #[serde(alias = "fixedLot")]
    pub fixed_lot: Option<f64>,
    #[serde(alias = "reverseTrading")]
    pub reverse_trading: Option<bool>,
    #[serde(alias = "exactMatch")]
    pub exact_match: Option<bool>,
    #[serde(alias = "symbolTranslations", default)]
    pub symbol_translations: Option<Option<Vec<String>>>,
    pub prefix: Option<Option<PrefixSuffixConfig>>,
    pub suffix: Option<Option<PrefixSuffixConfig>>,
}

fn has_max_decimals(value: f64, max_decimals: u32) -> bool {
    let factor = 10_f64.powi(max_decimals as i32);
    let scaled = value * factor;
    (scaled - scaled.round()).abs() < 1e-9
}

fn apply_configure_to_entry(
    entry: &mut AccountEntry,
    req: &ConfigureAccountBody,
) {
    if req.nickname.is_some() {
        let n = req
            .nickname
            .as_ref()
            .map(|s| s.trim())
            .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) });
        entry.nickname = n;
    }
    let role_explicitly_pending = req
        .role
        .as_ref()
        .map(|s| {
            let t = s.trim().to_lowercase();
            t.is_empty() || t == "pending"
        })
        .unwrap_or(false);
    if role_explicitly_pending {
        entry.role = Some("pending".to_string());
        entry.master_account_id = None;
        entry.master_tcp_url = None;
        entry.tcp_url = None;
        entry.lot_type = None;
        entry.lot_multiplier = None;
        entry.fixed_lot = None;
        entry.reverse_trading = None;
        entry.exact_match = None;
        entry.symbol_translations = None;
        entry.prefix = None;
        entry.suffix = None;
        return;
    }
    if (req.role.is_some() && !role_explicitly_pending)
        || req.master_tcp_url.is_some()
        || req.disconnect_from_master.is_some()
        || req.lot_type.is_some()
        || req.lot_multiplier.is_some()
        || req.fixed_lot.is_some()
        || req.reverse_trading.is_some()
        || req.exact_match.is_some()
        || req.symbol_translations.is_some()
        || req.prefix.is_some()
        || req.suffix.is_some()
    {
        let role_changed = req
            .role
            .as_ref()
            .map(|s| s.trim().to_lowercase())
            .as_deref()
            != entry.role.as_deref();
        if let Some(ref role) = req.role {
            let r = role.trim().to_lowercase();
            if !r.is_empty() {
                entry.role = Some(r.clone());
                if role_changed {
                    if r == "master" {
                        entry.master_account_id = None;
                        entry.master_tcp_url = None;
                    } else if r == "slave" {
                        entry.master_account_id = req.master_account_id.clone();
                        if req.master_tcp_url.is_some() {
                            entry.master_tcp_url = req.master_tcp_url.clone();
                        }
                        entry.tcp_url = None;
                        entry.exact_match = Some(false);
                    } else {
                        entry.master_account_id = req.master_account_id.clone();
                        if req.master_tcp_url.is_some() {
                            entry.master_tcp_url = req.master_tcp_url.clone();
                        }
                    }
                }
            }
        }
        if !role_changed {
            if req.disconnect_from_master == Some(true) {
                entry.master_account_id = None;
                entry.master_tcp_url = None;
            } else {
                if req.master_account_id.is_some() {
                    entry.master_account_id = req.master_account_id.clone();
                }
                if req.master_tcp_url.is_some() {
                    entry.master_tcp_url = req.master_tcp_url.clone();
                }
            }
        }
        if let Some(ref lt) = req.lot_type {
            let lt_lower = lt.trim().to_lowercase();
            entry.lot_type = Some(lt_lower.clone());
            if let Some(v) = req.fixed_lot {
                entry.fixed_lot = Some((v * 100.0).round() / 100.0);
            }
            if let Some(v) = req.lot_multiplier {
                entry.lot_multiplier = Some(v);
            }
        } else {
            if let Some(v) = req.fixed_lot {
                entry.fixed_lot = Some((v * 100.0).round() / 100.0);
                entry.lot_type = Some("fixed".to_string());
            }
            if let Some(v) = req.lot_multiplier {
                entry.lot_multiplier = Some(v);
                entry.lot_type = Some("multiplier".to_string());
            }
        }
        if req.reverse_trading.is_some() {
            entry.reverse_trading = req.reverse_trading;
        }
        if req.exact_match.is_some() {
            entry.exact_match = req.exact_match;
        }
        if let Some(opt) = req.symbol_translations.as_ref() {
            entry.symbol_translations = opt.clone();
        }
        if let Some(prefix_val) = req.prefix.as_ref() {
            entry.prefix = prefix_val.clone();
        }
        if let Some(suffix_val) = req.suffix.as_ref() {
            entry.suffix = suffix_val.clone();
        }
    }
}

pub(crate) fn effective_connection_type_for_status(entry: &AccountEntry) -> Option<String> {
    if let Some(ref t) = entry.connection_type {
        let s = t.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    None
}

enum BridgePostOutcome {
    Sent,
    SkippedUnreachable,
}

fn extract_bridge_error_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        if let Some(first) = errors.first().and_then(|e| e.as_str()) {
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    v.get("message")
        .and_then(|m| m.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

async fn post_mt_config_to_ea(
    state: &AppState,
    api_url: &str,
    entry: &AccountEntry,
) -> Result<BridgePostOutcome, (StatusCode, Json<ApiResponse<()>>)> {
    let role = entry.role.as_deref().unwrap_or("pending");
    let copy_trading_config = serde_json::json!({
        "role": role,
        "masterTcpUrl": entry.master_tcp_url,
        "lotType": entry.lot_type.as_deref().unwrap_or("multiplier"),
        "lotMultiplier": entry.lot_multiplier.unwrap_or(1.0),
        "fixedLot": entry.fixed_lot.unwrap_or(0.01),
        "reverseTrading": entry.reverse_trading.unwrap_or(false),
        "exactMatch": entry.exact_match.unwrap_or(false),
        "prefix": entry.prefix.as_ref().map(|p| serde_json::json!({
            "enabled": p.enabled,
            "value": p.value,
            "action": p.action
        })),
        "suffix": entry.suffix.as_ref().map(|s| serde_json::json!({
            "enabled": s.enabled,
            "value": s.value,
            "action": s.action
        })),
        "symbolTranslations": entry.symbol_translations,
    });
    let payload = serde_json::json!({ "copyTradingConfig": copy_trading_config });
    let key_with_month = AuthState::key_with_month(&state.auth_state.api_key);
    let secret_with_month = AuthState::key_with_month(&state.auth_state.api_secret);
    let timeout = std::time::Duration::from_secs(timings::HTTP_REQUEST_TIMEOUT_SECS.min(10));
    let req = state
        .http_client
        .put(api_url)
        .timeout(timeout)
        .header(API_KEY_HEADER, &key_with_month)
        .header(API_SECRET_HEADER, &secret_with_month)
        .json(&payload);
    let req_resp = req.send().await;
    match req_resp {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                let msg = extract_bridge_error_message(&body).unwrap_or_else(|| {
                    if body.is_empty() {
                        format!(
                            "Node rejected configuration: {} {}",
                            status.as_u16(),
                            status.canonical_reason().unwrap_or("")
                        )
                    } else {
                        body
                    }
                });
                return Err((
                    if status.is_client_error() {
                        StatusCode::BAD_REQUEST
                    } else {
                        StatusCode::BAD_GATEWAY
                    },
                    Json(ApiResponse::<()>::err(&msg)),
                ));
            }
            Ok(BridgePostOutcome::Sent)
        }
        Err(e) => {
            if e.is_connect() || e.is_timeout() {
                return Ok(BridgePostOutcome::SkippedUnreachable);
            }
            Err((
                StatusCode::BAD_GATEWAY,
                Json(ApiResponse::<()>::err(&format!("MetaTrader connection failed: {}", e))),
            ))
        }
    }
}


fn opaque_tcp_url(full: &Option<String>) -> Option<String> {
    full.as_ref().and_then(|u| {
        let rest = u.strip_prefix("tcp://")?;
        let account = rest.split('/').next_back()?;
        if account.is_empty() {
            None
        } else {
            Some(format!("tcp://{}", account))
        }
    })
}

fn opaque_api_url(full: &Option<String>) -> Option<String> {
    full.as_ref().and_then(|u| {
        let idx = u.find("/api/")?;
        Some(u[idx..].to_string())
    })
}

pub(crate) fn to_status_dto(
    a: &AccountEntry,
    ctrader_api_base: Option<&str>,
    now_secs: u64,
    ctrader_connected: Option<&std::collections::HashSet<String>>,
    _conversion_ui_online: Option<&std::collections::HashSet<String>>,
    tcp_enabled_map: Option<&std::collections::HashMap<String, bool>>,
) -> AccountStatusDto {
    let account_id_for_frontend = a.account_id.clone();
    let api_url_full = if a.platform.eq_ignore_ascii_case("ctrader") && !account_id_for_frontend.is_empty() {
        ctrader_api_base.map(|base| format!("{}/api/accounts/{}", base.trim_end_matches('/'), account_id_for_frontend))
    } else {
        a.api_url.clone().or_else(|| {
            (!a.account_id.is_empty()).then(|| {
                ctrader_api_base
                    .map(|base| format!("{}/api/accounts/{}", base.trim_end_matches('/'), a.account_id))
            }).flatten()
        })
    };
    let api_url = opaque_api_url(&api_url_full);
    let status = if a.platform.eq_ignore_ascii_case("ctrader") {
        let connected = ctrader_connected.map(|s| s.contains(&a.account_id)).unwrap_or(false);
        if a.reconnect_type.as_deref() == Some("reauth_oauth") {
            ConnectionStatus::Offline
        } else if connected {
            ConnectionStatus::Connected
        } else {
            ConnectionStatus::Connecting
        }
    } else if connection_status::is_connection_online(a, now_secs, NODE_HEARTBEAT_TIMEOUT_SECS) {
        if a.reconnect_type.as_deref() == Some("invalid_credentials") {
            ConnectionStatus::Offline
        } else if a.reconnect_type.is_some() {
            ConnectionStatus::Connecting
        } else {
            ConnectionStatus::Connected
        }
    } else {
        ConnectionStatus::Offline
    };
    let tcp_enabled = tcp_enabled_map
        .and_then(|m| m.get(&a.account_id).copied())
        .unwrap_or(true);
    AccountStatusDto {
        account_id: account_id_for_frontend,
        nickname: a.nickname.clone(),
        platform: a.platform.clone(),
        server: a.server.clone(),
        role: a.role.clone(),
        tcp_url: opaque_tcp_url(&a.tcp_url),
        master_account_id: a.master_account_id.clone(),
        master_tcp_url: opaque_tcp_url(&a.master_tcp_url),
        api_url,
        status,
        tcp_enabled: Some(tcp_enabled),
        lot_type: a.lot_type.clone(),
        lot_multiplier: a.lot_multiplier,
        fixed_lot: a.fixed_lot,
        reverse_trading: a.reverse_trading,
        exact_match: a.exact_match,
        symbol_translations: a.symbol_translations.clone(),
        prefix: a.prefix.clone(),
        suffix: a.suffix.clone(),
        slave_ids: None,
        reconnect_type: a.reconnect_type.clone(),
        balance: None,
        unrealized_pnl: None,
        equity: None,
        connection_type: effective_connection_type_for_status(a),
    }
}

pub async fn build_status_response(state: &AppState) -> UnifiedStatusResponse {
    let api_base = util::api_base_for_accounts(state.config.port);
    let app_version = state.config.app_version.clone();
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let ctrader_connected = state.ctrader_connected_accounts.read().await.clone();
    let ctrader_connected_for_status: std::collections::HashSet<String> = ctrader_connected.clone();
    let conversion_ui_online = {
        let mut guard = state.conversion_ui_online_accounts.write().await;
        for id in &ctrader_connected {
            guard.remove(id);
        }
        guard.clone()
    };
    let ctrader_running = state.ctrader_running_accounts.read().await.clone();
    let ctrader_running_since = state.ctrader_running_since.read().await.clone();
    let reconnecting_ctids_full: Vec<String> = ctrader_running
        .difference(&ctrader_connected)
        .filter(|id| {
            let since = ctrader_running_since.get(*id).copied().unwrap_or(0);
            now_secs.saturating_sub(since) <= timings::CTRADER_RECONNECT_TOTAL_TIMEOUT_SECS
        })
        .cloned()
        .collect();
    let requested_id = state.reconnect_requested_account_id.read().await.clone();
    let _reconnecting_ctids: Vec<String> = if let Some(ref rid) = requested_id {
        if ctrader_connected.contains(rid) {
            *state.reconnect_requested_account_id.write().await = None;
            reconnecting_ctids_full
        } else if reconnecting_ctids_full.contains(rid) {
            vec![rid.clone()]
        } else {
            *state.reconnect_requested_account_id.write().await = None;
            reconnecting_ctids_full
        }
    } else {
        reconnecting_ctids_full
    };
    let tcp_enabled_snapshot = state.tcp_enabled.read().await.clone();
    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    let account_balance_pnl: std::collections::HashMap<String, (Option<f64>, Option<f64>)> = {
        let guard = state.account_info_cache.read().await;
        guard
            .iter()
            .map(|(k, v)| (k.clone(), (v.balance.map(round2), v.unrealized_pnl.map(round2))))
            .collect()
    };
    let mt_balance_pnl: std::collections::HashMap<String, (Option<f64>, Option<f64>)> = {
        let guard = state.mt_realtime_stats_cache.read().await;
        guard
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    (v.balance.map(round2), v.unrealized_pnl.map(round2)),
                )
            })
            .collect()
    };
    let ctrader_equity: std::collections::HashMap<String, Option<f64>> = {
        let guard = state.account_info_cache.read().await;
        guard
            .iter()
            .map(|(k, v)| (k.clone(), v.equity.map(round2)))
            .collect()
    };
    let (accounts, preferences) = if let Some(ref mgr) = state.state_manager {
        mgr.read(move |snap| {
            let base = api_base.trim_end_matches('/');
            let mut accounts: Vec<AccountStatusDto> = snap
                .accounts
                .values()
                .map(|a| {
                    to_status_dto(
                        a,
                        Some(base),
                        now_secs,
                        Some(&ctrader_connected_for_status),
                        Some(&conversion_ui_online),
                        Some(&tcp_enabled_snapshot),
                    )
                })
                .collect();

            for dto in &mut accounts {
                let is_ctrader = snap
                    .accounts
                    .get(&dto.account_id)
                    .map(|e| e.platform.eq_ignore_ascii_case("ctrader"))
                    .unwrap_or(false);
                let is_mt = snap
                    .accounts
                    .get(&dto.account_id)
                    .map(|e| mt::is_metatrader_platform(&e.platform))
                    .unwrap_or(false);
                let (bal, pnl) = if is_ctrader {
                    account_balance_pnl
                        .get(&dto.account_id)
                        .copied()
                        .unwrap_or((None, None))
                } else if is_mt {
                    mt_balance_pnl
                        .get(&dto.account_id)
                        .copied()
                        .unwrap_or((None, None))
                } else {
                    (None, None)
                };
                dto.balance = bal;
                dto.unrealized_pnl = pnl;
                dto.equity = if is_ctrader {
                    ctrader_equity
                        .get(&dto.account_id)
                        .copied()
                        .flatten()
                        .or_else(|| bal.and_then(|b| pnl.map(|p| round2(b + p))))
                } else if is_mt {
                    bal.and_then(|b| pnl.map(|p| round2(b + p)))
                } else {
                    None
                };
            }

            let mut master_to_slaves: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
            for (slave_id, entry) in snap.accounts.iter() {
                let is_slave = entry.role.as_deref() == Some("slave");
                if !is_slave {
                    continue;
                }
                let master_by_id = entry.master_account_id.as_deref();
                let master_by_url = entry.master_tcp_url.as_ref();
                for (master_id, master_entry) in snap.accounts.iter() {
                    if master_entry.role.as_deref() != Some("master") {
                        continue;
                    }
                    let linked = master_by_id == Some(master_id.as_str())
                        || (master_entry.tcp_url.as_ref().is_some()
                            && master_by_url == master_entry.tcp_url.as_ref());
                    if linked {
                        master_to_slaves
                            .entry(master_id.clone())
                            .or_default()
                            .push(slave_id.clone());
                    }
                }
            }
            for dto in &mut accounts {
                if dto.role.as_deref() == Some("master") {
                    if let Some(slave_ids) = master_to_slaves.get(&dto.account_id) {
                        dto.slave_ids = Some(slave_ids.clone());
                    }
                }
            }

            accounts.sort_by(|a, b| a.account_id.cmp(&b.account_id));

            let prefs = snap.preferences.clone().unwrap_or_default();
            (accounts, prefs)
        })
        .await
    } else {
        (
            Vec::new(),
            AppPreferences::default(),
        )
    };
    let platform = state.linking_platform.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let deleting_all_accounts = *state.deleting_all_accounts.read().await;

    let app = AppSettings {
        linking_ctrader_accounts: platform.is_some(),
        deleting_all_accounts,
        show_nickname: preferences.show_nickname,
        sounds_enabled: preferences.sounds_enabled,
        global_copier_enabled: preferences.global_copier_enabled,
        show_slave_config_details: preferences.show_slave_config_details,
        show_orders_totals: preferences.show_orders_totals,
        show_resources: preferences.show_resources,
        show_balance: preferences.show_balance,
        show_equity: preferences.show_equity,
        show_pnl: preferences.show_pnl,
        show_open_orders: preferences.show_open_orders,
        always_show_columns: preferences.always_show_columns,
        app_version,
    };

    UnifiedStatusResponse {
        accounts,
        app,
        resources: get_system_resources().await,
    }
}

#[utoipa::path(
    get,
    path = "/api/accounts/status",
    tag = "Accounts",
    responses(
        (status = 200, description = "", body = UnifiedStatusResponse,
            example = json!({
                "accounts": [],
                "app": {
                    "linking_ctrader_accounts": false,
                    "deleting_all_accounts": false,
                    "show_nickname": true,
                    "sounds_enabled": true,
                    "global_copier_enabled": true,
                    "show_slave_config_details": false,
                    "show_orders_totals": true,
                    "show_resources": true,
                    "app_version": "2.0.4"
                },
                "resources": {
                    "cpu_usage_percent": 21,
                    "ram_used_percent": 65
                }
            }))
    )
)]
pub async fn status(State(state): State<AppState>) -> Json<UnifiedStatusResponse> {
    Json(build_status_response(&state).await)
}

#[utoipa::path(
    put,
    path = "/api/accounts/{account_id}",
    tag = "Accounts",
    params(("account_id" = String, Path, description = "The account ID")),
    request_body(content = Option<ConfigureAccountBody>, description = "role, enabled, masterTcpUrl, lotType, etc."),
    responses(
        (status = 200, description = "", body = ApiResponse<()>,
            example = json!({ "success": true, "data": null, "message": "OK", "errors": null })),
        (status = 400, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["role must be master, slave or pending"] })),
        (status = 404, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["Account not found"] })),
        (status = 500, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["State not available"] })),
        (status = 502, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["Node rejected configuration: 401 Unauthorized"] }))
    )
)]
pub async fn configure(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
    Json(body): Json<Option<ConfigureAccountBody>>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = state
        .state_manager
        .as_ref()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::<()>::err("State not available")),
        ))?;

    let path_id = account_id.trim().to_string();
    if path_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("accountId required")),
        ));
    }
    let state_key = mgr.read(|snap| resolve_account_key(snap, &path_id)).await;
    let account_id = match state_key {
        Some(k) => k,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiResponse::<()>::err("Account not found")),
            ));
        }
    };

    if let Some(ref req) = body {
        if let Some(lot_multiplier) = req.lot_multiplier {
            if !has_max_decimals(lot_multiplier, 4) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ApiResponse::<()>::err("lot_multiplier supports at most 4 decimal places")),
                ));
            }
        }
        let role = req.role.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
        if let Some(ref r) = role {
            if *r != "master" && *r != "slave" && *r != "pending" {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ApiResponse::<()>::err("role must be master, slave or pending")),
                ));
            }
        }
    }

    let mt_post_info = if let Some(ref req) = body {
        mgr.read(|snap| {
            let entry = snap.accounts.get(&account_id)?.clone();
            if !mt::is_metatrader_platform(&entry.platform) {
                return None;
            }
            let mut merged = entry;
            apply_configure_to_entry(&mut merged, req);
            let api_url = merged
                .api_url
                .as_ref()
                .map(|u| u.trim().to_string())
                .filter(|s| !s.is_empty())?;
            Some((api_url, merged))
        })
        .await
    } else {
        None
    };

    if let (Some(_req), Some((api_url, entry_clone))) = (body.as_ref(), mt_post_info) {
        post_mt_config_to_ea(&state, &api_url, &entry_clone).await?;
    }

    let (old_role, is_ctrader, old_master_tcp_url) = mgr
        .read(|snap| {
            snap.accounts.get(&account_id).map(|e| {
                (e.role.clone(), e.platform.eq_ignore_ascii_case("ctrader"), e.master_tcp_url.clone())
            })
        })
        .await
        .unwrap_or((None, false, None));

    let tcp_port = state.tcp_listening_port.read().await
        .unwrap_or_else(|| util::tcp_port_from_base_url(&state.config.tcp_base_url).unwrap_or(18080));
    let host = util::tcp_host_for_accounts();
    let body_clone = body.clone();
    let account_id_for_update = account_id.clone();
    let updated = mgr.update(move |snap| {
        let entry = snap.accounts.get_mut(&account_id_for_update);
        if let Some(entry) = entry {
            if let Some(ref req) = body_clone {
                apply_configure_to_entry(entry, req);
            }
            for (mid, e) in snap.accounts.iter_mut() {
                if e.platform.eq_ignore_ascii_case("ctrader") && e.role.as_deref() == Some("master") {
                    e.tcp_url = Some(format!("tcp://{}:{}/{}", host, tcp_port, mid));
                }
            }
            crate::state::recalc_slaves_master_tcp_urls(snap);
            true
        } else {
            false
        }
    })
    .await;

    if !updated {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiResponse::<()>::err("Account not found")),
        ));
    }

    if body.is_some() && !state.tcp_enabled.read().await.contains_key(&account_id) {
        let global_enabled = match &state.state_manager {
            Some(m) => m.read(|s| s.preferences.as_ref().map_or(true, |p| p.global_copier_enabled)).await,
            None => true,
        };
        let _ = apply_tcp_for_account(&state, &account_id, global_enabled, false).await;
    }

    let state_bg = state.clone();
    let account_id_bg = account_id.clone();
    let body_some = body.is_some();
    let is_ctrader_bg = is_ctrader;
    let old_role_bg = old_role.clone();
    let old_master_tcp_url_bg = old_master_tcp_url;
    tokio::spawn(async move {
        if body_some && is_ctrader_bg {
            let mgr = match &state_bg.state_manager {
                Some(m) => m.clone(),
                None => return,
            };
            let (new_role, new_master_tcp_url) = mgr.read(|snap| {
                snap.accounts.get(&account_id_bg).map(|e| (e.role.clone(), e.master_tcp_url.clone()))
            }).await.unwrap_or((None, None));
            let role_changed = new_role.as_deref() != old_role_bg.as_deref();
            if role_changed && (new_role.as_deref() == Some("master") || new_role.as_deref() == Some("slave")) {

                crate::services::ctrader_connection::ctrader_cleanup_and_reconnect(
                    &state_bg,
                    crate::services::ctrader_connection::CtraderReconnectScope::Account(
                        account_id_bg.clone(),
                    ),
                )
                .await;
                crate::routes::apply_system_tcp_ordered_from_preferences(&state_bg).await;
            }
            let was_or_is_slave = old_role_bg.as_deref() == Some("slave")
                || new_role.as_deref() == Some("slave");
            let master_changed = new_master_tcp_url != old_master_tcp_url_bg;
            if was_or_is_slave && (role_changed || master_changed) {
                if let Some(handle) = state_bg.slave_tcp_handles.write().await.remove(&account_id_bg) {
                    handle.abort();
                }
                state_bg.slave_tcp_connected_accounts.write().await.remove(&account_id_bg);
                if let Some(ref tx) = *state_bg.copy_manager_trigger_tx.read().await {
                    let _ = tx.try_send(());
                }
            }
        }
        if body_some {
            let mgr = match &state_bg.state_manager {
                Some(m) => m.clone(),
                None => return,
            };
            let push_info = mgr
                .read(|snap| {
                    let entry = snap.accounts.get(&account_id_bg)?;
                    let is_mt = mt::is_metatrader_platform(&entry.platform);
                    let api_url = entry
                        .api_url
                        .as_ref()
                        .map(|u| u.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let is_slave = entry.role.as_deref() == Some("slave");
                    if is_slave && api_url.is_some() && !is_mt {
                        let api_url = api_url.unwrap();
                        let entry = entry.clone();
                        Some((api_url, entry))
                    } else {
                        None
                    }
                })
                .await;
            if let Some((api_url, entry)) = push_info {
                let copy_trading_config = serde_json::json!({
                    "role": entry.role.as_deref().unwrap_or("slave"),
                    "masterTcpUrl": entry.master_tcp_url,
                    "lotType": entry.lot_type.as_deref().unwrap_or("multiplier"),
                    "lotMultiplier": entry.lot_multiplier.unwrap_or(1.0),
                    "fixedLot": entry.fixed_lot.unwrap_or(0.01),
                    "reverseTrading": entry.reverse_trading.unwrap_or(false),
                    "exactMatch": entry.exact_match.unwrap_or(false),
                    "prefix": entry.prefix.as_ref().map(|p| serde_json::json!({
                        "enabled": p.enabled,
                        "value": p.value,
                        "action": p.action
                    })),
                    "suffix": entry.suffix.as_ref().map(|s| serde_json::json!({
                        "enabled": s.enabled,
                        "value": s.value,
                        "action": s.action
                    })),
                    "symbolTranslations": entry.symbol_translations,
                });
                let payload = serde_json::json!({ "copyTradingConfig": copy_trading_config });
                let key_with_month = AuthState::key_with_month(&state_bg.auth_state.api_key);
                let secret_with_month = AuthState::key_with_month(&state_bg.auth_state.api_secret);
                let timeout = std::time::Duration::from_secs(timings::HTTP_REQUEST_TIMEOUT_SECS.min(10));
                let _ = state_bg
                    .http_client
                    .put(&api_url)
                    .timeout(timeout)
                    .header(API_KEY_HEADER, &key_with_month)
                    .header(API_SECRET_HEADER, &secret_with_month)
                    .json(&payload)
                    .send()
                    .await;
            }
        }
    });

    Ok(Json(ApiResponse::<()>::ok_empty("OK")))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct TcpEnabledQuery {
    pub enabled: Option<bool>,
    pub tcp: Option<bool>,
}

pub async fn apply_tcp_for_account(
    state: &AppState,
    account_id: &str,
    enabled: bool,
    return_forward_error: bool,
) -> Result<(), (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = match state.state_manager.as_ref() {
        Some(m) => m,
        None => return Ok(()),
    };

    state.tcp_enabled.write().await.insert(account_id.to_string(), enabled);

    let mt_tcp_forward: Option<String> = mgr
        .read(|snap| {
            let entry = snap.accounts.get(account_id)?;
            if !mt::is_metatrader_platform(&entry.platform) {
                return None;
            }
            let is_ea = entry.connection_type.as_deref() == Some("ea");
            if !is_ea {
                return None;
            }
            entry
                .api_url
                .as_ref()
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
        })
        .await;

    if let Some(api_url) = mt_tcp_forward {
        let base = if api_url.contains("/api/accounts/") {
            api_url
                .find("/api/accounts/")
                .map(|i| api_url[..i].trim_end_matches('/').to_string())
                .unwrap_or_else(|| api_url.clone())
        } else {
            api_url.trim_end_matches('/').to_string()
        };
        let put_url = format!("{}/api/accounts/{}/tcp?enabled={}", base, account_id, enabled);
        let key_with_month = AuthState::key_with_month(&state.auth_state.api_key);
        let secret_with_month = AuthState::key_with_month(&state.auth_state.api_secret);
        let timeout = std::time::Duration::from_secs(timings::HTTP_REQUEST_TIMEOUT_SECS.min(10));
        let mut tcp_req = state
            .http_client
            .put(&put_url)
            .timeout(timeout)
            .header(API_KEY_HEADER, &key_with_month)
            .header(API_SECRET_HEADER, &secret_with_month);
        if let Ok(secret) = std::env::var("IPTRADE_STATE_SECRET") {
            if !secret.trim().is_empty() {
                tcp_req = tcp_req.header("X-Iptrade-Bridge-Internal", secret.trim());
            }
        }
        match tcp_req
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                if !status.is_success() && return_forward_error {
                    let msg = if body.is_empty() {
                        format!(
                            "Node returned {} {}",
                            status.as_u16(),
                            status.canonical_reason().unwrap_or("")
                        )
                    } else {
                        body
                    };
                    return Err((
                        if status.is_client_error() {
                            StatusCode::BAD_REQUEST
                        } else {
                            StatusCode::BAD_GATEWAY
                        },
                        Json(ApiResponse::<()>::err(&msg)),
                    ));
                }
            }
            Err(e) => {
                if return_forward_error {
                    tracing::error!(account_id = %account_id, error = %e, "Node request failed (apply_tcp)");
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        Json(ApiResponse::<()>::err(&format!("Node request failed: {}", e))),
                    ));
                }
            }
        }
    }
    Ok(())
}

pub async fn set_tcp_for_account_persistent(
    state: &AppState,
    account_id: &str,
    enabled: bool,
    return_forward_error: bool,
) -> Result<(), (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = state.state_manager.as_ref().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiResponse::<()>::err("State not available")),
    ))?;

    let resolved = account_id.to_string();
    mgr.update(move |snap| {
        if let Some(entry) = snap.accounts.get_mut(&resolved) {
            entry.tcp_enabled = Some(enabled);
        }
    })
    .await;

    let global_enabled = mgr
        .read(|s| s.preferences.as_ref().map_or(true, |p| p.global_copier_enabled))
        .await;
    let effective = enabled && global_enabled;

    apply_tcp_for_account(state, account_id, effective, return_forward_error).await?;

    Ok(())
}

#[utoipa::path(
    put,
    path = "/api/accounts/{account_id}/tcp",
    tag = "Accounts",
    params(
        ("account_id" = String, Path, description = "Account ID"),
        ("enabled" = Option<bool>, Query, description = "Enable TCP (alias: tcp)")
    ),
    responses(
        (status = 200, description = "", body = ApiResponse<()>),
        (status = 400, description = "", body = ApiResponse<()>),
        (status = 404, description = "", body = ApiResponse<()>)
    )
)]
pub async fn set_account_tcp(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
    Query(query): Query<TcpEnabledQuery>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let path_id = account_id.trim().to_string();
    if path_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("accountId required")),
        ));
    }
    let enabled = query
        .enabled
        .or(query.tcp)
        .ok_or((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("Query enabled or tcp required (e.g. ?enabled=true)")),
        ))?;

    let mgr = state
        .state_manager
        .as_ref()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::<()>::err("State not available")),
        ))?;
    let resolved_id = match mgr
        .read(|snap| resolve_account_key(snap, &path_id).map(|k| k))
        .await
    {
        Some(k) => k,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiResponse::<()>::err("Account not found")),
            ));
        }
    };

    set_tcp_for_account_persistent(&state, &resolved_id, enabled, true).await?;

    Ok(Json(ApiResponse::<()>::ok_empty("OK")))
}

#[utoipa::path(
    delete,
    path = "/api/accounts/{account_id}",
    tag = "Accounts",
    params(("account_id" = String, Path, description = "The account ID to delete")),
    responses(
        (status = 200, description = "", body = ApiResponse<()>,
            example = json!({ "success": true, "data": null, "message": "OK", "errors": null })),
        (status = 400, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["accountId required"] })),
        (status = 404, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["Account not found"] })),
        (status = 500, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["State not available"] }))
    )
)]
pub async fn delete_account(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = state
        .state_manager
        .as_ref()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::<()>::err("State not available")),
        ))?;

    let path_id = account_id.trim().to_string();
    if path_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("accountId required")),
        ));
    }
    let state_key = mgr.read(|snap| resolve_account_key(snap, &path_id)).await;
    let account_id = state_key.ok_or((
        StatusCode::NOT_FOUND,
        Json(ApiResponse::<()>::err("Account not found")),
    ))?;

    let _ = apply_tcp_for_account(&state, &account_id, false, false).await;

    let (is_ctrader, master_tcp_url) = mgr
        .read(|snap| {
            snap.accounts.get(&account_id).map(|e| {
                (
                    e.platform.eq_ignore_ascii_case("ctrader"),
                    e.tcp_url.clone(),
                )
            })
        })
        .await
        .unwrap_or((false, None));
    let found = mgr
        .update(|snap| {
            let is_master = snap
                .accounts
                .get(&account_id)
                .map(|e| e.role.as_deref() == Some("master"))
                .unwrap_or(false);
            if is_master {
                for (_, entry) in snap.accounts.iter_mut() {
                    let linked_by_id = entry.master_account_id.as_deref() == Some(account_id.as_str());
                    let linked_by_url = master_tcp_url.as_ref().is_some_and(|url| {
                        entry.master_tcp_url.as_deref() == Some(url.as_str())
                    });
                    if linked_by_id || linked_by_url {
                        entry.master_account_id = None;
                        entry.master_tcp_url = None;
                    }
                }
            }
            if let Some(entry) = snap.accounts.get_mut(&account_id) {
                entry.role = Some("pending".to_string());
                entry.master_account_id = None;
                entry.master_tcp_url = None;
                entry.tcp_url = None;
            }
            snap.accounts.remove(&account_id).is_some()
        })
        .await;
    if !found {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiResponse::<()>::err("Account not found")),
        ));
    }

    if is_ctrader {
        crate::services::ctrader_connection::ctrader_cleanup_and_reconnect(
            &state,
            crate::services::ctrader_connection::CtraderReconnectScope::Account(account_id.clone()),
        )
        .await;
    }
    {
        let mut g = state.heartbeat_registry.write().await;
        let keys_to_remove: Vec<String> = g
            .iter()
            .filter(|(_, node)| {
                node.accounts.iter().any(|acc| {
                    acc.account_id
                        .as_deref()
                        .map(|id| id.eq_ignore_ascii_case(&account_id))
                        .unwrap_or(false)
                })
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys_to_remove {
            g.remove(&k);
        }
    }
    clear_runtime_account_state(&state, &account_id).await;
    crate::services::pos_mapping::delete(&account_id);
    crate::services::slave_copy_map::delete(&account_id);
    crate::services::slave_mapping::delete_for_account(&account_id);
    if let Some(ref store) = state.history_store {
        store.delete_account(&account_id).await;
    }

    Ok(Json(ApiResponse::<()>::ok_empty("OK")))
}

#[utoipa::path(
    delete,
    path = "/api/accounts",
    tag = "Accounts",
    responses(
        (status = 200, description = "", body = ApiResponse<()>,
            example = json!({ "success": true, "data": null, "message": "OK", "errors": null })),
        (status = 500, description = "", body = ApiResponse<()>,
            example = json!({ "success": false, "data": null, "message": null, "errors": ["State not available"] }))
    )
)]
pub async fn delete_all_accounts(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = state
        .state_manager
        .as_ref()
        .ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse::<()>::err("State not available")),
        ))?;
    crate::routes::apply_system_tcp_ordered(&state, false).await;

    crate::services::ctrader_connection::ctrader_cleanup_and_reconnect(
        &state,
        crate::services::ctrader_connection::CtraderReconnectScope::Full,
    )
    .await;
    clear_runtime_all_account_state(&state).await;
    crate::services::pos_mapping::delete_all();
    crate::services::slave_copy_map::delete_all();
    crate::services::slave_mapping::delete_all();

    mgr.update(|snap| {
        for entry in snap.accounts.values_mut() {
            entry.role = Some("pending".to_string());
        }
    })
    .await;

    *state.deleting_all_accounts.write().await = true;
    let removed_ids: Vec<String> = mgr
        .update(|snap| {
            let ids: Vec<String> = snap.accounts.keys().cloned().collect();
            snap.accounts.clear();
            ids
        })
        .await;
    {
        state.heartbeat_registry.write().await.clear();
    }
    *state.deleting_all_accounts.write().await = false;
    if let Some(ref store) = state.history_store {
        for id in &removed_ids {
            store.delete_account(id).await;
        }
    }

    if let Some(ref store) = state.history_store {
        store.purge_all().await;
    }
    mgr.purge().await;

    Ok(Json(ApiResponse::<()>::ok_empty("OK")))
}

async fn account_orders_ws_stream(mut socket: WebSocket, state: AppState, account_id: String) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let json = {
            let snap = state.ctrader_snapshot_cache.read().await.get(&account_id).cloned();
            match snap {
                Some(s) => {
                    let summary = serde_json::json!({
                        "event": s.event,
                        "account": s.account,
                        "open_orders": s.open_positions.len(),
                        "pending_orders": s.pending_orders.len(),
                    });
                    match serde_json::to_string(&summary) {
                        Ok(j) => j,
                        Err(_) => continue,
                    }
                }
                None => continue,
            }
        };
        if !json.is_empty() && socket.send(Message::Text(json)).await.is_err() {
            break;
        }
    }
}

async fn aggregate_orders_forward(
    mut socket: WebSocket,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    while let Some(json) = rx.recv().await {
        if socket.send(Message::Text(json.into())).await.is_err() {
            break;
        }
    }
}

pub(crate) async fn run_orders_broadcaster(state: Arc<AppState>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut notify_rx = state.orders_ws_notify_tx.subscribe();
    loop {
        tick.tick().await;
        while notify_rx.try_recv().is_ok() {}
        let (accounts, global_copier_enabled) = if let Some(ref mgr) = state.state_manager {
            let (accounts, enabled) = mgr
                .read(|snap| {
                    let accounts = snap.accounts.values().cloned().collect::<Vec<_>>();
                    let enabled = snap.preferences.as_ref().map_or(true, |p| p.global_copier_enabled);
                    (accounts, enabled)
                })
                .await;
            (accounts, enabled)
        } else {
            (Vec::new(), false)
        };

        let mut ctrader_account_ids: Vec<String> = Vec::new();
        let mut mt_targets: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for acc in &accounts {
            if acc.platform.eq_ignore_ascii_case("ctrader") {
                ctrader_account_ids.push(acc.account_id.clone());
                continue;
            }
            if !mt::is_metatrader_platform(&acc.platform) {
                continue;
            }
            let Some(api_url) = acc
                .api_url
                .as_ref()
                .map(|u| u.trim())
                .filter(|u| !u.is_empty())
            else {
                continue;
            };
            let Some(ws_url) = mt::orders_ws_url(api_url) else {
                continue;
            };
            mt_targets.insert(acc.account_id.clone(), ws_url.clone());
        }

        if !global_copier_enabled {
            let mut handles = state.mt_reader_handles.write().await;
            for handle in handles.drain().map(|(_, h)| h) {
                handle.abort();
            }
            state.mt_realtime_stats_cache.write().await.clear();
            state.mt_snapshot_cache.write().await.clear();
        } else {
            let target_ids: std::collections::HashSet<String> = mt_targets.keys().cloned().collect();
            {
                let mut handles = state.mt_reader_handles.write().await;
                let to_remove: Vec<String> = handles
                    .keys()
                    .filter(|id| !target_ids.contains(*id))
                    .cloned()
                    .collect();
                for aid in to_remove {
                    if let Some(handle) = handles.remove(&aid) {
                        handle.abort();
                    }
                    state.mt_realtime_stats_cache.write().await.remove(&aid);
                    state.mt_snapshot_cache.write().await.remove(&aid);
                }
            }
            {
                let mut handles = state.mt_reader_handles.write().await;
                for (account_id, ws_url) in &mt_targets {
                    let has_active = handles
                        .get(account_id)
                        .map(|h| !h.is_finished())
                        .unwrap_or(false);
                    if has_active {
                        continue;
                    }
                    if let Some(old) = handles.remove(account_id) {
                        old.abort();
                    }
                    let handle =
                        mt::run_mt_orders_reader(state.clone(), account_id.clone(), ws_url.clone());
                    handles.insert(account_id.clone(), handle);
                }
            }
        }

        let mut total_open = 0_u32;
        let mut total_pending = 0_u32;
        let mut accounts: Vec<AccountOrdersDto> = Vec::new();
        {
            let cache = state.ctrader_realtime_stats_cache.read().await;
            let account_cache = state.account_info_cache.read().await;
            for ct_id in &ctrader_account_ids {
                let stats = cache.get(ct_id);
                let (open_pos, pending_pos) = stats
                    .map(|s| (s.open_positions, s.pending_orders))
                    .unwrap_or((0, 0));
                total_open = total_open.saturating_add(open_pos);
                total_pending = total_pending.saturating_add(pending_pos);
                let account = account_cache.get(ct_id).cloned();
                let (balance, pnl) = account
                    .as_ref()
                    .map(|a| (a.balance, a.unrealized_pnl))
                    .unwrap_or((None, None));
                let equity = account.as_ref().and_then(|a| a.equity).or_else(|| {
                    balance.zip(pnl).map(|(b, p)| (b * 100.0 + p * 100.0).round() / 100.0)
                });
                accounts.push(AccountOrdersDto {
                    account_id: ct_id.clone(),
                    open_orders: open_pos,
                    pending_orders: pending_pos,
                    balance,
                    pnl,
                    equity,
                    account,
                });
            }
        }
        {
            let cache = state.mt_realtime_stats_cache.read().await;
            for mt_id in mt_targets.keys() {
                let stats = cache.get(mt_id);
                let (open_pos, pending_pos, balance, pnl) = stats
                    .map(|s| {
                        (
                            s.open_positions,
                            s.pending_orders,
                            s.balance.map(|b| (b * 100.0).round() / 100.0),
                            s.unrealized_pnl.map(|p| (p * 100.0).round() / 100.0),
                        )
                    })
                    .unwrap_or((0, 0, None, None));
                let equity = balance.zip(pnl).map(|(b, p)| (b * 100.0 + p * 100.0).round() / 100.0);
                total_open = total_open.saturating_add(open_pos);
                total_pending = total_pending.saturating_add(pending_pos);
                accounts.push(AccountOrdersDto {
                    account_id: mt_id.clone(),
                    open_orders: open_pos,
                    pending_orders: pending_pos,
                    balance,
                    pnl,
                    equity,
                    account: (balance.is_some() || pnl.is_some()).then(|| AccountInfoDto {
                        account_id: mt_id.clone(),
                        server: None,
                        currency: None,
                        balance,
                        equity,
                        unrealized_pnl: pnl,
                        leverage: None,
                        margin: None,
                    }),
                });
            }
        }

        let now_utc = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let payload = AggregateOrdersDto {
            message_type: "orders_aggregate".to_string(),
            open_orders: total_open,
            pending_orders: total_pending,
            accounts,
            timestamp: now_utc,
        };
        let json = match serde_json::to_string(&payload) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "orders_aggregate payload serialize failed");
                continue;
            }
        };
        if !state.orders_ws_subscribers.broadcast(json).await {
            break;
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/accounts/orders",
    tag = "Accounts",
    params(
        ("api_key" = Option<String>, Query, description = "Dynamic API key"),
        ("api_secret" = Option<String>, Query, description = "Dynamic API secret")
    ),
    responses(
        (status = 101, description = "Switching Protocols (WebSocket)"),
        (status = 401, description = "Unauthorized")
    )
)]
pub async fn aggregate_orders_ws(
    State(state): State<AppState>,
    Query(query): Query<AggregateOrdersWsQuery>,
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
    let (rx, is_first) = state.orders_ws_subscribers.add_subscriber().await;
    if is_first {
        tokio::spawn(run_orders_broadcaster(Arc::new(state.clone())));
    }
    Ok(ws.on_upgrade(move |socket| aggregate_orders_forward(socket, rx)))
}

#[utoipa::path(
    get,
    path = "/api/accounts/{account_id}/orders",
    tag = "Accounts",
    params(("account_id" = String, Path, description = "Account ID (cTrader only; for MT5 use aggregate /api/accounts/orders or bridge /api/accounts/{id}/orders)")),
    responses(
        (status = 101, description = "Switching Protocols (WebSocket)"),
        (status = 400, description = "Account exists but is not cTrader"),
        (status = 404, description = "Account not found")
    )
)]
pub async fn account_orders_ws(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    let path_id = account_id.trim().to_string();
    if path_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mgr = state
        .state_manager
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let exists_and_ctrader = mgr
        .read(|snap| {
            snap.accounts
                .get(&path_id)
                .map(|a| a.platform.eq_ignore_ascii_case("ctrader"))
        })
        .await;
    match exists_and_ctrader {
        None => Err(StatusCode::NOT_FOUND),
        Some(false) => Err(StatusCode::BAD_REQUEST),
        Some(true) => Ok(ws.on_upgrade(move |socket| account_orders_ws_stream(socket, state, path_id))),
    }
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/accounts/status", axum::routing::get(status))
        .route("/api/accounts/orders", axum::routing::get(aggregate_orders_ws))
        .route("/api/accounts", axum::routing::delete(delete_all_accounts))
        .route("/api/accounts/:account_id/orders", axum::routing::get(account_orders_ws))
        .route("/api/accounts/:account_id/tcp", axum::routing::put(set_account_tcp))
        .route("/api/accounts/:account_id", axum::routing::put(configure))
        .route("/api/accounts/:account_id", axum::routing::delete(delete_account))
}
