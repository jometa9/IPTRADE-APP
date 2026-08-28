use super::ctrader_fetch::fetch_ctrader_deals;
use super::model::{
    gaps_in, merge_covered_range, CoveredRange, HistoryDeal, HistoryIndexEntry,
};
use super::store::HistoryStore;
use crate::app_state::AppState;
use crate::state::AccountEntry;
use std::sync::Arc;

const TODAY_OVERLAP_MS: i64 = 60 * 60 * 1000;

const INITIAL_BACKFILL_DAYS: i64 = 90;

const TODAY_FRESHNESS_TOLERANCE_MS: i64 = 30 * 1000;

pub async fn sync_account_range(
    app_state: &AppState,
    store: &Arc<HistoryStore>,
    account_id: &str,
    entry: &AccountEntry,
    from_ms: i64,
    to_ms: i64,
) -> Result<(), String> {
    if to_ms <= from_ms {
        return Ok(());
    }
    let deals = fetch_account_deals(app_state, account_id, entry, from_ms, to_ms).await?;
    let outcome = if deals.is_empty() {
        super::store::MergeOutcome { added: 0, updated: 0 }
    } else {
        store.merge_deals(account_id, deals).await
    };

    store
        .mutate_index_entry(account_id, |prev| {
            let mut covered = prev.covered_ranges.clone();
            merge_covered_range(
                &mut covered,
                CoveredRange { from_ms, to_ms },
            );
            let oldest = covered
                .first()
                .map(|r| r.from_ms)
                .unwrap_or_else(|| if prev.oldest_synced_ms > 0 { prev.oldest_synced_ms } else { from_ms });
            let last = covered
                .last()
                .map(|r| r.to_ms)
                .unwrap_or_else(|| prev.last_synced_ms.max(to_ms));
            HistoryIndexEntry {
                last_synced_ms: last.max(prev.last_synced_ms),
                oldest_synced_ms: if oldest > 0 { oldest } else { from_ms },
                deals_count: prev.deals_count,
                covered_ranges: covered,
            }
        })
        .await;

    if outcome.added > 0 || outcome.updated > 0 {
        let count = store.load_account(account_id).await.deals.len();
        store
            .mutate_index_entry(account_id, |prev| HistoryIndexEntry {
                deals_count: count,
                ..prev
            })
            .await;
    }

    Ok(())
}

pub async fn ensure_account_synced(
    app_state: &AppState,
    store: &Arc<HistoryStore>,
    account_id: &str,
    desired_from_ms: i64,
    desired_to_ms: i64,
    force: bool,
) -> Result<(), String> {
    let Some(ref mgr) = app_state.state_manager else {
        return Ok(());
    };
    let Some(entry) = mgr.read(|s| s.accounts.get(account_id).cloned()).await else {
        return Ok(());
    };
    if !is_history_eligible(&entry) {
        return Ok(());
    }

    let sync_lock = store.sync_lock_for_account(account_id).await;
    let _g = sync_lock.lock().await;

    let cur = store.load_index_entry(account_id).await;

    let now_ms = now_ms();
    let start_today = start_of_utc_day(now_ms);
    let today_from = start_today - TODAY_OVERLAP_MS;

    let effective_from = if cur.last_synced_ms == 0 {
        let cutoff = now_ms - INITIAL_BACKFILL_DAYS * 86_400_000;
        desired_from_ms.max(cutoff)
    } else {
        desired_from_ms
    };
    let effective_to = desired_to_ms;

    let mut ranges_to_fetch: Vec<CoveredRange> = if force {
        vec![CoveredRange {
            from_ms: effective_from,
            to_ms: effective_to,
        }]
    } else {
        let mut ranges = gaps_in(&cur.covered_ranges, effective_from, effective_to);

        let needs_today = effective_to >= today_from
            && (cur.last_synced_ms == 0
                || cur.last_synced_ms < now_ms - TODAY_FRESHNESS_TOLERANCE_MS);
        if needs_today {
            let from = if cur.last_synced_ms > 0 {
                (cur.last_synced_ms - 60_000).max(today_from)
            } else {
                today_from
            };
            let to = now_ms.min(effective_to);
            if to > from {
                ranges.push(CoveredRange { from_ms: from, to_ms: to });
            }
        }

        ranges
    };

    if ranges_to_fetch.len() > 1 {
        let mut coalesced: Vec<CoveredRange> = Vec::new();
        ranges_to_fetch.sort_by_key(|r| r.from_ms);
        for r in ranges_to_fetch.into_iter() {
            if let Some(last) = coalesced.last_mut() {
                if r.from_ms <= last.to_ms.saturating_add(1) {
                    last.to_ms = last.to_ms.max(r.to_ms);
                    continue;
                }
            }
            coalesced.push(r);
        }
        ranges_to_fetch = coalesced;
    }

    if ranges_to_fetch.is_empty() {
        return Ok(());
    }

    for r in ranges_to_fetch {
        if let Err(e) = sync_account_range(app_state, store, account_id, &entry, r.from_ms, r.to_ms).await {
            tracing::warn!(
                account_id = %account_id,
                from_ms = r.from_ms,
                to_ms = r.to_ms,
                error = %e,
                "history ensure_account_synced: range fetch failed"
            );
        }
    }
    Ok(())
}

async fn fetch_account_deals(
    app_state: &AppState,
    account_id: &str,
    entry: &AccountEntry,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<HistoryDeal>, String> {
    if entry.platform == "ctrader" {
        let _ = account_id;
        fetch_ctrader_deals(entry, from_ms, to_ms, &app_state.ctrader_symbols_cache).await
    } else {
        Err("account not eligible for history".into())
    }
}

pub fn is_history_eligible(entry: &AccountEntry) -> bool {
    if entry.platform == "ctrader" {
        return entry.access_token.is_some()
            && entry.client_id.is_some()
            && entry.client_secret.is_some();
    }
    false
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn start_of_utc_day(ms: i64) -> i64 {
    if ms <= 0 {
        return 0;
    }
    (ms / 86_400_000) * 86_400_000
}
