use axum::body::to_bytes;
use axum::extract::Request;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::{API_KEY_HEADER, API_SECRET_HEADER};
use crate::middleware::AuthState;
use crate::state::{AccountEntry, PrefixSuffixConfig};
use crate::timings;

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatCopyTradingConfig {
    pub role: Option<String>,
    #[serde(alias = "master_tcp_url")]
    pub master_tcp_url: Option<String>,
    #[serde(alias = "lot_type")]
    pub lot_type: Option<String>,
    #[serde(alias = "lot_multiplier")]
    pub lot_multiplier: Option<f64>,
    #[serde(alias = "fixed_lot")]
    pub fixed_lot: Option<f64>,
    #[serde(alias = "reverse_trading")]
    pub reverse_trading: Option<bool>,
    #[serde(alias = "exact_match")]
    pub exact_match: Option<bool>,
    pub prefix: Option<PrefixSuffixConfig>,
    pub suffix: Option<PrefixSuffixConfig>,
    #[serde(alias = "symbol_translations")]
    pub symbol_translations: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct HeartbeatAccount {
    #[serde(alias = "accountId")]
    pub account_id: Option<String>,
    #[serde(alias = "tcpUrl")]
    pub tcp_url: Option<String>,
    #[serde(alias = "apiUrl")]
    pub api_url: Option<String>,
    pub server: Option<String>,
    #[serde(alias = "resolvedHost")]
    pub resolved_host: Option<String>,
    #[serde(alias = "copyTradingConfig")]
    pub copy_trading_config: Option<HeartbeatCopyTradingConfig>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(rename = "connectionType", alias = "mt5ConnectionType")]
    pub connection_type: Option<String>,
    #[serde(alias = "reconnectType")]
    pub reconnect_type: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
pub struct AccountHeartbeatPayload {
    #[serde(alias = "apiUrl")]
    pub api_url: Option<String>,
    #[serde(alias = "accountId")]
    pub account_id: Option<String>,
    pub platform: Option<String>,
    #[serde(rename = "connectionType", alias = "mt5ConnectionType")]
    pub connection_type: Option<String>,
    pub server: Option<String>,
    #[serde(alias = "resolvedHost")]
    pub resolved_host: Option<String>,
    #[serde(alias = "tcpUrl")]
    pub tcp_url: Option<String>,
    #[serde(alias = "masterTcpUrl")]
    pub master_tcp_url: Option<String>,
    #[serde(alias = "copyTradingConfig")]
    pub copy_trading_config: Option<HeartbeatCopyTradingConfig>,
    #[serde(default)]
    pub success: Option<bool>,
    #[serde(alias = "reconnectType")]
    pub reconnect_type: Option<String>,
    #[serde(default)]
    pub accounts: Option<Vec<AccountHeartbeatPayload>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HeartbeatNode {
    pub api_url: String,
    pub api_type: Option<String>,
    pub public_ip: Option<String>,
    pub accounts: Vec<HeartbeatAccount>,
    pub last_heartbeat_utc: String,
}

pub type HeartbeatRegistry = Arc<RwLock<HashMap<String, HeartbeatNode>>>;

pub fn new_registry() -> HeartbeatRegistry {
    Arc::new(RwLock::new(HashMap::new()))
}

fn utc_now() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", t.as_secs())
}

fn parse_heartbeat_account(
    payload: &AccountHeartbeatPayload,
    node_api_url: Option<&String>,
    node_platform: &str,
    node_connection_type: Option<&String>,
) -> Option<(String, String, Option<String>, HeartbeatAccount)> {
    let account_id = payload
        .account_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "0" && !s.eq_ignore_ascii_case("unknown"));
    let api_url_full = payload
        .api_url
        .as_ref()
        .or_else(|| node_api_url.and_then(|u| (!u.is_empty()).then_some(u)))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let id = account_id?;
    let (node_base, account_api_url) = api_url_full.as_ref().map(|u| {
        let u = u.trim_end_matches('/');
        if u.contains("/api/accounts/") {
            let base = u.find("/api/accounts/").map(|i| u[..i].to_string()).unwrap_or_else(|| u.to_string());
            (Some(base.clone()), u.to_string())
        } else {
            (Some(u.to_string()), format!("{}/api/accounts/{}", u, id))
        }
    }).unwrap_or_else(|| {
        (
            node_api_url.cloned(),
            node_api_url
                .map(|b| format!("{}/api/accounts/{}", b.trim_end_matches('/'), id))
                .unwrap_or_else(|| format!("/api/accounts/{}", id)),
        )
    });
    let platform = if payload.platform.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
        normalize_platform(payload.platform.as_deref())
    } else {
        node_platform.to_string()
    };
    let connection_type = payload
        .connection_type
        .clone()
        .or_else(|| node_connection_type.cloned());
    let copy_trading_config = payload.copy_trading_config.clone().or_else(|| {
        payload.master_tcp_url.as_ref().filter(|s| !s.trim().is_empty()).map(|master_tcp_url| HeartbeatCopyTradingConfig {
            role: Some("slave".to_string()),
            master_tcp_url: Some(master_tcp_url.clone()),
            ..Default::default()
        })
    });
    let acc = HeartbeatAccount {
        account_id: Some(id.clone()),
        tcp_url: payload.tcp_url.clone(),
        api_url: Some(account_api_url.clone()),
        server: payload.server.clone(),
        resolved_host: payload.resolved_host.clone(),
        copy_trading_config,
        success: payload.success,
        connection_type,
        reconnect_type: payload.reconnect_type.clone(),
    };
    let key = node_base
        .clone()
        .or_else(|| payload.api_url.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| utc_now().to_string());
    Some((key, platform, node_base, acc))
}

fn normalize_platform(platform: Option<&str>) -> String {
    let t = platform.map(|s| s.to_lowercase().trim().to_string()).unwrap_or_default();
    if t.is_empty() {
        return "unknown".to_string();
    }
    if t == "metatrader4" || t == "mt4" {
        "metatrader4".to_string()
    } else if t == "metatrader5" || t == "mt5" {
        "metatrader5".to_string()
    } else if t == "ctrader" {
        "ctrader".to_string()
    } else {
        t
    }
}

fn master_tcp_url_missing(cfg: &HeartbeatCopyTradingConfig) -> bool {
    cfg.master_tcp_url
        .as_ref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

fn tcp_url_missing(acc: &HeartbeatAccount) -> bool {
    acc.tcp_url
        .as_ref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

fn copy_config_differs(recv: &HeartbeatCopyTradingConfig, entry: &AccountEntry) -> bool {
    let opt_str_eq = |a: Option<&String>, b: Option<&String>| {
        let a = a.map(|s| s.trim().to_lowercase()).unwrap_or_default();
        let b = b.map(|s| s.trim().to_lowercase()).unwrap_or_default();
        a == b
    };
    if !opt_str_eq(
        recv.role.as_ref(),
        entry.role.as_ref(),
    ) {
        return true;
    }
    let recv_master = recv
        .master_tcp_url
        .as_ref()
        .map(|s| s.trim())
        .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) });
    if recv_master.as_ref() != entry.master_tcp_url.as_ref() {
        return true;
    }
    if !opt_str_eq(recv.lot_type.as_ref(), entry.lot_type.as_ref()) {
        return true;
    }
    let opt_f64_eq = |a: Option<f64>, b: Option<f64>, default: f64| {
        (a.unwrap_or(default) - b.unwrap_or(default)).abs() <= 1e-9
    };
    if !opt_f64_eq(recv.lot_multiplier, entry.lot_multiplier, 1.0) {
        return true;
    }
    if !opt_f64_eq(recv.fixed_lot, entry.fixed_lot, 0.01) {
        return true;
    }
    let recv_reverse = recv.reverse_trading.unwrap_or(false);
    let entry_reverse = entry.reverse_trading.unwrap_or(false);
    if recv_reverse != entry_reverse {
        return true;
    }
    let recv_exact = recv.exact_match.unwrap_or(false);
    let entry_exact = entry.exact_match.unwrap_or(false);
    if recv_exact != entry_exact {
        return true;
    }
    let recv_prefix_effective = recv.prefix.as_ref().and_then(|p| if p.enabled { Some(p) } else { None });
    let entry_prefix_effective = entry.prefix.as_ref().and_then(|p| if p.enabled { Some(p) } else { None });
    let prefix_eq = match (&recv_prefix_effective, &entry_prefix_effective) {
        (None, None) => true,
        (Some(a), Some(b)) => a.value.as_deref().unwrap_or("") == b.value.as_deref().unwrap_or("") && a.action == b.action,
        _ => false,
    };
    if !prefix_eq {
        return true;
    }
    let recv_suffix_effective = recv.suffix.as_ref().and_then(|s| if s.enabled { Some(s) } else { None });
    let entry_suffix_effective = entry.suffix.as_ref().and_then(|s| if s.enabled { Some(s) } else { None });
    let suffix_eq = match (&recv_suffix_effective, &entry_suffix_effective) {
        (None, None) => true,
        (Some(a), Some(b)) => a.value.as_deref().unwrap_or("") == b.value.as_deref().unwrap_or("") && a.action == b.action,
        _ => false,
    };
    if !suffix_eq {
        return true;
    }
    let recv_sym = recv.symbol_translations.as_deref().unwrap_or(&[]);
    let entry_sym = entry.symbol_translations.as_deref().unwrap_or(&[]);
    let sym_eq = recv_sym.len() == entry_sym.len() && recv_sym.iter().zip(entry_sym.iter()).all(|(x, y)| x == y);
    if !sym_eq {
        return true;
    }
    false
}

pub(crate) fn apply_copy_config(entry: &mut AccountEntry, cfg: &HeartbeatCopyTradingConfig) {
    let is_pending = entry.role.as_deref() == Some("pending");
    if !is_pending {
        if let Some(ref r) = cfg.role {
            let r = r.trim().to_lowercase();
            if !r.is_empty() {
                entry.role = Some(r);
            }
        }
    }
    if !is_pending {
        if let Some(ref u) = cfg.master_tcp_url {
            if !u.trim().is_empty() && entry.master_account_id.is_some() {
                entry.master_tcp_url = Some(u.clone());
            }
        }
    }
    if let Some(ref lt) = cfg.lot_type {
        entry.lot_type = Some(lt.trim().to_lowercase());
    }
    if let Some(v) = cfg.lot_multiplier {
        entry.lot_multiplier = Some(v);
    }
    if let Some(v) = cfg.fixed_lot {
        entry.fixed_lot = Some((v * 100.0).round() / 100.0);
    }
    if let Some(v) = cfg.reverse_trading {
        entry.reverse_trading = Some(v);
    }
    if let Some(v) = cfg.exact_match {
        entry.exact_match = Some(v);
    }
    if cfg.prefix.is_some() {
        entry.prefix = cfg.prefix.clone();
    }
    if cfg.suffix.is_some() {
        entry.suffix = cfg.suffix.clone();
    }
    if let Some(ref s) = cfg.symbol_translations {
        entry.symbol_translations = Some(s.clone());
    }
}

#[utoipa::path(
    post,
    path = "/api/heartbeat",
    tag = "Heartbeat",
    request_body(content = AccountHeartbeatPayload, description = "Heartbeat from trading node. Set platform (e.g. metatrader4, metatrader5). Include connectionType: 'ea' (Expert Advisor) or 'api' (cTrader)."),
    responses(
        (status = 200, description = "", body = serde_json::Value),
        (status = 400, description = "", body = serde_json::Value),
        (status = 404, description = "", body = serde_json::Value)
    )
)]
pub async fn heartbeat_in(
    State(state): State<crate::app_state::AppState>,
    request: Request,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let body_bytes = to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let payload: AccountHeartbeatPayload = serde_json::from_slice(&body_bytes)
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    if !state.config.heartbeat_in_enabled {
        return Err(StatusCode::NOT_FOUND);
    }

    let node_api = payload.api_url.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let node_platform = normalize_platform(payload.platform.as_deref());
    let node_connection_type = payload.connection_type.clone();

    let accounts: Vec<(String, String, Option<String>, HeartbeatAccount)> = if let Some(ref batch) = payload.accounts {
        if batch.is_empty() {
            vec![]
        } else {
            batch
                .iter()
                .filter_map(|p| parse_heartbeat_account(p, node_api.as_ref(), &node_platform, node_connection_type.as_ref()))
                .collect()
        }
    } else if payload.account_id.is_some() || payload.api_url.is_some() {
        parse_heartbeat_account(&payload, None, &node_platform, node_connection_type.as_ref()).map(|x| vec![x]).unwrap_or_default()
    } else {
        vec![]
    };

    let registry = state.heartbeat_registry.clone();

    if accounts.is_empty() {
        let Some(key) = node_api
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            return Err(StatusCode::BAD_REQUEST);
        };
        let node = HeartbeatNode {
            api_url: key.clone(),
            api_type: Some(node_platform.clone()),
            public_ip: None,
            accounts: vec![],
            last_heartbeat_utc: utc_now(),
        };
        {
            let mut g = registry.write().await;
            g.insert(key, node);
        }
        return Ok(Json(serde_json::json!({ "success": true })));
    }

    let (key, platform, node_api_url, _) = &accounts[0];
    let key = key.clone();
    let platform = platform.clone();
    let node_api_url = node_api_url.clone();
    let accounts: Vec<HeartbeatAccount> = accounts.into_iter().map(|(_, _, _, a)| a).collect();
    let node = HeartbeatNode {
        api_url: key.clone(),
        api_type: Some(platform.clone()),
        public_ip: None,
        accounts: accounts.clone(),
        last_heartbeat_utc: utc_now(),
    };
    {
        let mut g = registry.write().await;
        g.insert(key, node);
    }

    let now_utc = utc_now();

    if let Some(ref mgr) = state.state_manager {
        let accounts_to_upsert = accounts;
        let push_config_accounts: Vec<(String, String)> = mgr.update(|snap| {
            let master_tcp_urls_disconnected: Vec<String> = Vec::new();
            let mut push_config: Vec<(String, String)> = Vec::new();
            for acc in accounts_to_upsert {
                let id = acc
                    .account_id
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let id = match id {
                    Some(id) => id,
                    None => continue,
                };
                let api_url = acc.api_url.clone().or_else(|| {
                    node_api_url.as_ref().map(|u| format!("{}/api/accounts/{}", u.trim_end_matches('/'), id))
                });
                let api_url_clone = api_url.clone();

                let update_connected = acc.success != Some(false);
                if let Some(entry) = snap.accounts.get_mut(&id) {
                    let hb_server = acc
                        .server
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    if let Some(server_name) = hb_server {
                        entry.server = Some(server_name);
                    }
                    let from_hb = acc
                        .connection_type
                        .as_ref()
                        .map(|t| t.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    if let Some(t) = from_hb {
                        entry.connection_type = Some(t);
                    }
                    if update_connected {
                        if let Some(ref cfg) = acc.copy_trading_config {
                            let cleared = cfg.role.as_deref().map(|r| r.eq_ignore_ascii_case("slave")).unwrap_or(false)
                                && master_tcp_url_missing(cfg)
                                && entry.master_account_id.is_none();
                            if cleared {
                                entry.master_tcp_url = None;
                            }
                        }
                        entry.last_heartbeat_utc = Some(now_utc.clone());
                        if let Some(ref u) = acc.tcp_url {
                            if !u.trim().is_empty() {
                                entry.tcp_url = Some(u.clone());
                            }
                        }
                        if let Some(ref u) = api_url {
                            entry.api_url = Some(u.clone());
                        }
                    }
                    if update_connected {
                        if let Some(ref cfg) = acc.copy_trading_config {
                            let config_differs = copy_config_differs(cfg, entry);
                            if config_differs {
                                let _app_configured = entry.role.as_deref() != Some("pending");
                                if _app_configured {
                                    if let Some(ref url) = api_url_clone {
                                        if !url.trim().is_empty() {
                                            push_config.push((id.clone(), url.clone()));
                                        }
                                    }
                                } else {
                                    apply_copy_config(entry, cfg);
                                    if let Some(ref url) = api_url_clone {
                                        if !url.trim().is_empty() {
                                            push_config.push((id.clone(), url.clone()));
                                        }
                                    }
                                }
                            } else {
                                apply_copy_config(entry, cfg);
                            }
                            if cfg.role.as_deref().map(|r| r.eq_ignore_ascii_case("master")).unwrap_or(false)
                                && tcp_url_missing(&acc)
                                && entry.role.as_deref() == Some("master")
                                && entry.tcp_url.is_some()
                            {
                                entry.tcp_url = None;
                            }
                        }
                    }
                    entry.reconnect_type = acc.reconnect_type.clone()
                        .filter(|rt| !rt.is_empty());
                    if acc.reconnect_type.as_ref().is_some_and(|rt| !rt.is_empty()) {
                        entry.last_heartbeat_utc = Some(now_utc.clone());
                    }
                } else {
                    let normalized_server = acc
                        .server
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let entry = AccountEntry {
                        account_id: id.clone(),
                        platform: platform.clone(),
                        server: normalized_server.clone(),
                        connection_type: acc.connection_type.clone(),
                        nickname: None,
                        ctid_trader_account_id: None,
                        is_live: None,
                        access_token: None,
                        refresh_token: None,
                        token_expires_at_utc: None,
                        client_id: None,
                        client_secret: None,
                        role: Some("pending".to_string()),
                        master_account_id: None,
                        master_tcp_url: None,
                        tcp_url: if update_connected { acc.tcp_url.clone() } else { None },
                        api_url: api_url_clone.clone(),
                        lot_type: None,
                        lot_multiplier: None,
                        fixed_lot: None,
                        reverse_trading: None,
                        exact_match: Some(false),
                        symbol_translations: None,
                        prefix: None,
                        suffix: None,
                        last_heartbeat_utc: if update_connected { Some(now_utc.clone()) } else { None },
                        reconnect_type: None,
                        reconnect_retry_after_secs: None,
                        tcp_enabled: None,
                    };
                    snap.accounts.insert(id.clone(), entry);
                    if let Some(ref url) = api_url_clone {
                        if !url.trim().is_empty() {
                            push_config.push((id, url.clone()));
                        }
                    }
                }
            }
            for entry in snap.accounts.values_mut() {
                if let Some(ref u) = entry.master_tcp_url {
                    if master_tcp_urls_disconnected.iter().any(|d| d == u) {
                        entry.master_tcp_url = None;
                    }
                }
            }
            let before_recalc: std::collections::HashMap<String, Option<String>> = snap
                .accounts
                .iter()
                .filter(|(_, e)| e.role.as_deref() == Some("slave"))
                .map(|(id, e)| (id.clone(), e.master_tcp_url.clone()))
                .collect();
            crate::state::recalc_slaves_master_tcp_urls(snap);
            for (id, entry) in snap.accounts.iter() {
                if entry.role.as_deref() != Some("slave") {
                    continue;
                }
                let after = entry.master_tcp_url.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                let before = before_recalc.get(id).and_then(|o| o.as_ref()).map(|s| s.trim()).unwrap_or("");
                let changed = after.as_deref() != Some(before);
                if changed && after.is_some() {
                    if let Some(ref url) = entry.api_url {
                        if !url.trim().is_empty() && !push_config.iter().any(|(i, _)| i == id) {
                            push_config.push((id.clone(), url.clone()));
                        }
                    }
                }
            }
            push_config
        })
        .await;

        for (account_id, api_url) in push_config_accounts {
            if let Some(entry) = mgr.read(|snap| snap.accounts.get(&account_id).cloned()).await {
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
                    "symbolTranslations": entry.symbol_translations
                });
                let payload = serde_json::json!({ "copyTradingConfig": copy_trading_config });
                let key_with_month = AuthState::key_with_month(&state.auth_state.api_key);
                let secret_with_month = AuthState::key_with_month(&state.auth_state.api_secret);
                let timeout = std::time::Duration::from_secs(timings::HTTP_REQUEST_TIMEOUT_SECS.min(10));
                let req_resp = state
                    .http_client
                    .put(&api_url)
                    .timeout(timeout)
                    .header(API_KEY_HEADER, &key_with_month)
                    .header(API_SECRET_HEADER, &secret_with_month)
                    .json(&payload)
                    .send()
                    .await;
                match req_resp {
                    Ok(_resp) => {}
                    Err(e) => {
                        tracing::warn!(account_id = %account_id, error = %e, "heartbeat push to node failed");
                    }
                }
            }
        }
    }

    Ok(Json(serde_json::json!({ "success": true })))
}

pub fn router() -> axum::Router<crate::app_state::AppState> {
    axum::Router::new().route("/api/heartbeat", axum::routing::post(heartbeat_in))
}
