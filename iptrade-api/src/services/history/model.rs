use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct HistoryDeal {
    pub deal_id: String,
    pub account_id: String,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_type: Option<String>,
    pub symbol: String,
    pub side: String,
    pub volume: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_price: Option<f64>,
    pub open_time_ms: i64,
    pub close_time_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tp: Option<f64>,
    pub commission: f64,
    pub swap: f64,
    pub profit: f64,
    pub net_profit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryAccountFile {
    pub account_id: String,
    #[serde(default)]
    pub deals: Vec<HistoryDeal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CoveredRange {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HistoryIndexEntry {
    pub last_synced_ms: i64,
    pub oldest_synced_ms: i64,
    pub deals_count: usize,
    #[serde(default)]
    pub covered_ranges: Vec<CoveredRange>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryIndex {
    #[serde(default)]
    pub accounts: HashMap<String, HistoryIndexEntry>,
}

pub fn merge_covered_range(ranges: &mut Vec<CoveredRange>, new_range: CoveredRange) {
    if new_range.to_ms < new_range.from_ms {
        return;
    }
    ranges.push(new_range);
    ranges.sort_by_key(|r| r.from_ms);
    let mut merged: Vec<CoveredRange> = Vec::with_capacity(ranges.len());
    for r in ranges.drain(..) {
        if let Some(last) = merged.last_mut() {
            if r.from_ms <= last.to_ms.saturating_add(1) {
                last.to_ms = last.to_ms.max(r.to_ms);
                continue;
            }
        }
        merged.push(r);
    }
    *ranges = merged;
}

pub fn gaps_in(ranges: &[CoveredRange], from_ms: i64, to_ms: i64) -> Vec<CoveredRange> {
    if to_ms < from_ms {
        return Vec::new();
    }
    let mut sorted: Vec<CoveredRange> = ranges
        .iter()
        .copied()
        .filter(|r| r.to_ms >= from_ms && r.from_ms <= to_ms)
        .collect();
    sorted.sort_by_key(|r| r.from_ms);
    let mut gaps = Vec::new();
    let mut cursor = from_ms;
    for r in sorted {
        if r.to_ms < cursor {
            continue;
        }
        if r.from_ms > cursor {
            let gap_to = (r.from_ms - 1).min(to_ms);
            if gap_to >= cursor {
                gaps.push(CoveredRange {
                    from_ms: cursor,
                    to_ms: gap_to,
                });
            }
        }
        if r.to_ms >= cursor {
            cursor = r.to_ms.saturating_add(1);
        }
        if cursor > to_ms {
            break;
        }
    }
    if cursor <= to_ms {
        gaps.push(CoveredRange {
            from_ms: cursor,
            to_ms,
        });
    }
    gaps
}
