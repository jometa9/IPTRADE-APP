
use crate::state::{AccountEntry, LocalStateSnapshot};

pub use crate::timings::NODE_HEARTBEAT_TIMEOUT_SECS;

pub fn uses_node_heartbeat(entry: &AccountEntry) -> bool {
    let p = entry.platform.to_lowercase();
    p != "ctrader"
}

pub fn is_connection_online(
    entry: &AccountEntry,
    now_secs: u64,
    heartbeat_timeout_secs: u64,
) -> bool {
    let platform = entry.platform.to_lowercase();
    if platform == "ctrader" {
        return false;
    }
    let last = match entry.last_heartbeat_utc.as_ref().and_then(|s| s.parse::<u64>().ok()) {
        Some(t) => t,
        None => return false,
    };
    now_secs.saturating_sub(last) <= heartbeat_timeout_secs
}

pub fn apply_offline_if_stale(
    snap: &mut LocalStateSnapshot,
    now_secs: u64,
    heartbeat_timeout_secs: u64,
) {
    for (account_id, entry) in snap.accounts.iter_mut() {
        if !uses_node_heartbeat(entry) {
            continue;
        }
        if is_connection_online(entry, now_secs, heartbeat_timeout_secs) {
            continue;
        }
        let last = entry.last_heartbeat_utc.as_ref().and_then(|s| s.parse::<u64>().ok());
        let had_tcp = entry.tcp_url.is_some();
        if had_tcp {
            let age_secs = last.map(|t| now_secs.saturating_sub(t)).unwrap_or(u64::MAX);
            tracing::warn!(
                account_id = %account_id,
                platform = %entry.platform,
                reason = "heartbeat_expired",
                age_secs = age_secs,
                timeout_secs = heartbeat_timeout_secs,
                last_heartbeat_utc = ?entry.last_heartbeat_utc,
                "mt account offline"
            );
        }
        entry.tcp_url = None;
    }
}
