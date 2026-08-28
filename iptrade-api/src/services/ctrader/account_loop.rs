use crate::state::LocalStateFileManager;

pub async fn get_eligible_ctrader_account_ids(
    mgr: &LocalStateFileManager,
    apply_throttle: bool,
) -> (Vec<String>, Vec<String>) {
    let now_secs_i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    mgr.read(|snap| {
        let mut masters = Vec::new();
        let mut others = Vec::new();
        for (id, a) in snap.accounts.iter() {
            if a.platform != "ctrader"
                || a.reconnect_type.as_deref() == Some("reauth_oauth")
                || a.access_token.as_deref().map(|s| s.is_empty()).unwrap_or(true)
                || a.client_id.as_deref().map(|s| s.is_empty()).unwrap_or(true)
                || a.client_secret.as_deref().map(|s| s.is_empty()).unwrap_or(true)
            {
                continue;
            }
            if apply_throttle {
                if let Some(retry_after) = a.reconnect_retry_after_secs {
                    if now_secs_i64 < retry_after {
                        continue;
                    }
                }
            }
            if a.role.as_deref() == Some("master") {
                masters.push(id.clone());
            } else {
                others.push(id.clone());
            }
        }
        (masters, others)
    })
    .await
}
