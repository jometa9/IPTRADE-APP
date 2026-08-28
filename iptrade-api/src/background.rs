use crate::app_state::AppState;
use crate::routes::accounts;
use crate::services;
use crate::state;
use crate::timings;
use std::sync::Arc;

pub fn spawn_all(app_state: &AppState) {
    tokio::spawn(accounts::run_orders_broadcaster(Arc::new(app_state.clone())));
    spawn_token_refresh_task(app_state.clone());
    spawn_backfill_task(app_state.clone());

    if let Some(ref mgr) = app_state.state_manager {
        spawn_node_offline_task(mgr.clone());
    }

    spawn_stale_ctrader_task(app_state.clone());

    if let Some(path) = app_state.config.default_log_file_path() {
        spawn_log_trim_task(path);
    }
}

fn spawn_log_trim_task(path: std::path::PathBuf) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(e) = crate::log_buffer::trim_log_file_to_retention(&path) {
                tracing::warn!(error = %e, "Failed to trim log file");
            }
        }
    });
}

fn spawn_token_refresh_task(app_state: AppState) {
    type TokenKey = (String, String, String);

    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(timings::TOKEN_REFRESH_CHECK_INTERVAL_SECS));
        interval.tick().await;
        loop {
            interval.tick().await;
            let Some(ref mgr) = app_state.state_manager else { continue };
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let expires_before = now_secs + timings::TOKEN_REFRESH_BUFFER_SECS;

            let mut groups: std::collections::HashMap<TokenKey, Vec<String>> = std::collections::HashMap::new();
            let mut needs_refresh: std::collections::HashSet<TokenKey> = std::collections::HashSet::new();

            mgr.read(|snap| {
                for (account_id, a) in &snap.accounts {
                    if a.platform != "ctrader" {
                        continue;
                    }
                    let (Some(ref cid), Some(ref csec), Some(ref rtok)) =
                        (a.client_id.as_ref(), a.client_secret.as_ref(), a.refresh_token.as_ref())
                    else {
                        continue;
                    };
                    let exp = a.token_expires_at_utc.as_ref().and_then(|s| s.parse::<u64>().ok());
                    let key: TokenKey = (cid.to_string(), csec.to_string(), rtok.to_string());
                    groups.entry(key.clone()).or_default().push(account_id.clone());
                    if exp.map(|e| e <= expires_before).unwrap_or(true) {
                        needs_refresh.insert(key);
                    }
                }
            })
            .await;

            for key in needs_refresh {
                let account_ids = match groups.get(&key) {
                    Some(ids) => ids.clone(),
                    None => continue,
                };
                match services::ctrader::oauth::refresh_token(
                    &app_state.http_client,
                    key.2.as_str(),
                    key.0.as_str(),
                    key.1.as_str(),
                )
                .await
                {
                    Ok(new_token) => {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default();
                        let new_expires_at = format!("{}", now.as_secs() + new_token.expires_in as u64);
                        let access = new_token.access_token.clone();
                        let refresh_new = new_token.refresh_token.clone();
                        let exp = new_expires_at.clone();
                        let _ = mgr
                            .update(|snap| {
                                for id in &account_ids {
                                    if let Some(entry) = snap.accounts.get_mut(id) {
                                        entry.access_token = Some(access.clone());
                                        entry.refresh_token = Some(refresh_new.clone());
                                        entry.token_expires_at_utc = Some(exp.clone());
                                    }
                                }
                            })
                            .await;
                    }
                    Err(e) => {
                        tracing::warn!(account_ids = ?account_ids, error = %e, "ctrader token refresh failed");
                    }
                }
            }
        }
    });
}

fn spawn_backfill_task(app_state: AppState) {
    tokio::spawn(async move {
        crate::setup::run_tcp_backfill(&app_state).await;
    });
}

fn spawn_node_offline_task(state_manager: Arc<state::LocalStateFileManager>) {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(timings::NODE_OFFLINE_CHECK_INTERVAL_SECS));
        interval.tick().await;
        loop {
            interval.tick().await;
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            state_manager
                .update(move |snap| {
                    services::connection_status::apply_offline_if_stale(
                        snap,
                        now_secs,
                        timings::NODE_HEARTBEAT_TIMEOUT_SECS,
                    );
                })
                .await;
        }
    });
}

fn spawn_stale_ctrader_task(app_state: AppState) {
    tokio::spawn(async move {
        let state_manager = app_state.state_manager.clone();
        let running = app_state.ctrader_running_accounts.clone();
        let running_since = app_state.ctrader_running_since.clone();
        let connected = app_state.ctrader_connected_accounts.clone();

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(timings::STALE_RECONNECT_CHECK_INTERVAL_SECS));
        interval.tick().await;
        loop {
            interval.tick().await;
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let running_since_map = running_since.read().await.clone();
            let running_set = running.read().await.clone();
            let connected_set = connected.read().await.clone();

            let stale: Vec<String> = running_since_map
                .iter()
                .filter(|(id, &since)| {
                    now_secs.saturating_sub(since) > timings::CTRADER_RECONNECT_TOTAL_TIMEOUT_SECS
                        && running_set.contains(*id)
                        && !connected_set.contains(*id)
                })
                .map(|(id, _)| id.clone())
                .collect();

            for account_id in stale {
                if let Some(ref mgr) = state_manager {
                    let rid = account_id.clone();
                    mgr.update(move |snap| {
                        if let Some(entry) = snap.accounts.get_mut(&rid) {
                            entry.tcp_url = None;
                            entry.reconnect_type = Some("retry_credentials".to_string());
                        }
                    })
                    .await;
                }
                services::ctrader_connection::ctrader_cleanup_and_reconnect(
                    &app_state,
                    services::ctrader_connection::CtraderReconnectScope::Account(account_id),
                )
                .await;
            }
        }
    });
}
