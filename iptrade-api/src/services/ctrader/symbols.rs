use crate::services::proto_oa::{self, SlaveOrder, SlavePosition};
use std::collections::{HashMap, HashSet};

pub fn volume_lots_to_protocol(volume_lots: f64, lot_size: i64, volume_step: i64) -> i64 {
    let raw = volume_lots * (lot_size as f64);
    let rounded = raw.round() as i64;
    let safe_step = volume_step.max(1);
    let snapped = if rounded <= 0 {
        safe_step
    } else {
        ((rounded + (safe_step / 2)) / safe_step) * safe_step
    };
    snapped.max(safe_step).max(1)
}

pub fn merge_symbol_by_id_result(
    result: &proto_oa::FullSymbolByIdResult,
    symbols_by_name: &mut HashMap<String, u64>,
    symbol_id_to_name: &mut HashMap<u64, String>,
) {
    for (id, name) in &result.resolved_names {
        symbols_by_name.entry(name.clone()).or_insert(*id);
        symbol_id_to_name.entry(*id).or_insert_with(|| name.clone());
    }
}

pub fn collect_missing_symbol_ids(
    positions: &[SlavePosition],
    orders: &[SlaveOrder],
    known: &HashMap<u64, String>,
    known_lot_sizes: &HashMap<u64, i64>,
) -> Vec<u64> {
    let mut missing = HashSet::new();
    for p in positions {
        let id = p.symbol_id;
        if !known.contains_key(&id) || !known_lot_sizes.contains_key(&id) {
            missing.insert(id);
        }
    }
    for o in orders {
        if !known.contains_key(&o.symbol_id) || !known_lot_sizes.contains_key(&o.symbol_id) {
            missing.insert(o.symbol_id);
        }
    }
    missing.into_iter().collect()
}

pub fn refresh_position_symbol_index(
    positions: &[SlavePosition],
    position_symbol_index: &mut HashMap<i64, u64>,
) {
    position_symbol_index.clear();
    for p in positions {
        position_symbol_index.insert(p.position_id, p.symbol_id);
    }
}

pub fn resolve_symbol_name(symbols: &HashMap<String, u64>, name: &str) -> Option<(u64, String)> {
    if let Some((key, &id)) = symbols.iter().find(|(k, _)| k.as_str() == name) {
        return Some((id, key.to_string()));
    }
    let sample: Vec<&str> = symbols.keys().map(String::as_str).take(10).collect();
    tracing::warn!(
        lookup_name = %name,
        known_count = symbols.len(),
        sample_symbols = ?sample,
        "symbols_by_name: name not found (order will not be placed on this symbol pair)"
    );
    None
}

#[derive(Clone, Copy)]
pub struct SymbolVolumeMeta {
    pub symbol_id: u64,
    pub lot_size: i64,
    pub volume_step: i64,
}

pub fn symbol_volume_meta_by_id(
    symbol_id: u64,
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_volume_steps: &HashMap<u64, i64>,
) -> SymbolVolumeMeta {
    SymbolVolumeMeta {
        symbol_id,
        lot_size: *symbol_lot_sizes.get(&symbol_id).unwrap_or(&10_000_000),
        volume_step: *symbol_volume_steps.get(&symbol_id).unwrap_or(&1),
    }
}

pub fn symbol_volume_meta_by_name(
    symbol_name: &str,
    symbols_by_name: &HashMap<String, u64>,
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_volume_steps: &HashMap<u64, i64>,
) -> Result<SymbolVolumeMeta, String> {
    let (symbol_id, _broker_key) = resolve_symbol_name(symbols_by_name, symbol_name)
        .ok_or_else(|| format!("symbol not found: {}", symbol_name))?;
    Ok(symbol_volume_meta_by_id(
        symbol_id,
        symbol_lot_sizes,
        symbol_volume_steps,
    ))
}

pub fn protocol_volume_from_lots(volume_lots: f64, meta: SymbolVolumeMeta) -> i64 {
    volume_lots_to_protocol(volume_lots, meta.lot_size, meta.volume_step)
}

pub fn build_symbol_volume_limits_lots(
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_min_volumes: &HashMap<u64, i64>,
    symbol_max_volumes: &HashMap<u64, i64>,
    symbol_volume_steps: &HashMap<u64, i64>,
) -> (HashMap<u64, f64>, HashMap<u64, f64>) {
    let min_lots = symbol_lot_sizes
        .iter()
        .map(|(symbol_id, lot_size)| {
            let safe_lot_size = (*lot_size).max(1) as f64;
            let step = symbol_volume_steps.get(symbol_id).copied().unwrap_or(1).max(1);
            let min_protocol = symbol_min_volumes
                .get(symbol_id)
                .copied()
                .unwrap_or(step)
                .max(step)
                .max(1) as f64;
            (*symbol_id, min_protocol / safe_lot_size)
        })
        .collect();
    let max_lots = symbol_lot_sizes
        .iter()
        .filter_map(|(symbol_id, lot_size)| {
            let max_protocol = symbol_max_volumes.get(symbol_id).copied().unwrap_or(0);
            if max_protocol <= 0 {
                return None;
            }
            let safe_lot_size = (*lot_size).max(1) as f64;
            Some((*symbol_id, (max_protocol as f64) / safe_lot_size))
        })
        .collect();
    (min_lots, max_lots)
}
