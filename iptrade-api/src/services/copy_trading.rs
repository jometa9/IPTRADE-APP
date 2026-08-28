use crate::app_state::AppState;
use crate::services::copy_command::CopyCommand;
use crate::services::proto_oa::{SlaveOrder, SlavePosition};
use crate::services::slave_copy_map;
use crate::state::{LocalStateFileManager, PrefixSuffixConfig};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch, Mutex, Semaphore};

use crate::timings::{
    COPY_GET_RECONCILE_TIMEOUT_SECS, COPY_MANAGER_POLL_SECS, COPY_RECONNECT_BACKOFF_SECS,
    COPY_TCP_CONNECT_TIMEOUT_SECS, COPY_INVALID_URL_SLEEP_SECS, COPY_MAX_AGE_MARKET_OPEN_SECS,
};

const COPY_INFLIGHT_GRACE_SECS: i64 = 5;

fn parse_master_tcp_url(url: &str) -> Option<(String, u16, String)> {
    let s = url.trim();
    if !s.starts_with("tcp://") {
        return None;
    }
    let rest = s.strip_prefix("tcp://")?;
    let (host_port, path) = rest.split_once('/').unwrap_or((rest, ""));
    let master_account_id = path.trim().to_string();
    let (host, port_str) = host_port.rsplit_once(':').unwrap_or((host_port, "18080"));
    let port: u16 = port_str.parse().ok()?;
    let host = host.to_string();
    Some((host, port, master_account_id))
}

#[derive(Debug, Deserialize)]
struct TcpEvent {
    event: String,
    #[serde(default)]
    ticket: Option<i64>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(rename = "type")]
    #[serde(default)]
    order_type: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    sl: Option<f64>,
    #[serde(default)]
    tp: Option<f64>,
    #[serde(default)]
    age_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct SnapshotOpenPosition {
    ticket: i64,
    symbol: String,
    #[serde(rename = "type")]
    r#type: String,
    side: String,
    volume: f64,
    #[serde(rename = "open_price")]
    _open_price: f64,
    #[serde(default)]
    sl: Option<f64>,
    #[serde(default)]
    tp: Option<f64>,
    #[serde(default)]
    age_seconds: u64,
}

#[derive(Debug, Deserialize, Clone)]
struct SnapshotPendingOrder {
    ticket: i64,
    symbol: String,
    #[serde(rename = "type")]
    r#type: String,
    side: String,
    volume: f64,
    price: f64,
    #[serde(default)]
    sl: Option<f64>,
    #[serde(default)]
    tp: Option<f64>,
    #[serde(default, rename = "expire")]
    _expire: Option<i64>,
    #[serde(default)]
    age_seconds: u64,
}

#[derive(Debug, Deserialize, Clone)]
struct TcpSnapshotMessageIn {
    event: String,
    // Snapshot ordering (see TcpSnapshotMessage): session is per-master-run, seq monotonic.
    #[serde(default)]
    session: i64,
    #[serde(default)]
    seq: i64,
    #[serde(default)]
    open_positions: Vec<SnapshotOpenPosition>,
    #[serde(default)]
    pending_orders: Vec<SnapshotPendingOrder>,
}

#[derive(Clone)]
struct SlaveCopyConfig {
    symbol_translations: Option<Vec<String>>,
    lot_type: Option<String>,
    lot_multiplier: Option<f64>,
    fixed_lot: Option<f64>,
    reverse_trading: Option<bool>,
    exact_match: Option<bool>,
    prefix: Option<PrefixSuffixConfig>,
    suffix: Option<PrefixSuffixConfig>,
}

fn apply_symbol(symbol: &str, config: &SlaveCopyConfig) -> String {
    let symbol_trim = symbol.trim();
    if symbol_trim.is_empty() {
        return String::new();
    }
    if let Some(ref list) = config.symbol_translations {
        for pair in list {
            let (from, to) = pair.split_once(':').unwrap_or((pair.as_str(), ""));
            let from_trim = from.trim();
            let to_trim = to.trim();
            let matched = from_trim.eq_ignore_ascii_case(symbol_trim);
            if matched {
                if to_trim.is_empty() {
                    tracing::warn!(
                        master_symbol = %symbol_trim,
                        translation_from = %from_trim,
                        "symbol_translations maps to empty string"
                    );
                }
                return to_trim.to_string();
            }
        }
    }
    apply_prefix_suffix(symbol_trim.to_string(), &config.prefix, &config.suffix)
}

fn starts_with_case_sensitive(s: &str, prefix: &str) -> bool {
    s.starts_with(prefix)
}

fn ends_with_case_sensitive(s: &str, suffix: &str) -> bool {
    s.ends_with(suffix)
}

fn apply_prefix_suffix(
    mut s: String,
    prefix: &Option<PrefixSuffixConfig>,
    suffix: &Option<PrefixSuffixConfig>,
) -> String {
    let prefix_val = prefix.as_ref().and_then(|p| p.value.as_deref()).unwrap_or("");
    if let Some(ref p) = prefix {
        if p.enabled && !prefix_val.is_empty() {
            s = match p.action.trim().to_lowercase().as_str() {
                "remove" => {
                    if starts_with_case_sensitive(&s, prefix_val) {
                        s[prefix_val.len()..].to_string()
                    } else {
                        s
                    }
                }
                _ => format!("{}{}", prefix_val, s),
            };
        }
    }
    let suffix_val = suffix.as_ref().and_then(|suf| suf.value.as_deref()).unwrap_or("");
    if let Some(ref suf) = suffix {
        if suf.enabled && !suffix_val.is_empty() {
            s = match suf.action.trim().to_lowercase().as_str() {
                "remove" => {
                    if ends_with_case_sensitive(&s, suffix_val) {
                        s[..s.len() - suffix_val.len()].to_string()
                    } else {
                        s
                    }
                }
                _ => format!("{}{}", s, suffix_val),
            };
        }
    }
    s
}

fn apply_volume(volume: f64, config: &SlaveCopyConfig) -> f64 {
    let use_multiplier = match config.lot_type.as_deref().map(|t| t.trim()) {
        Some("multiplier") => true,
        Some("fixed") => false,
        Some(_) | None => config.lot_multiplier.is_some() && config.fixed_lot.is_some(),
    };
    if use_multiplier {
        if let Some(mul) = config.lot_multiplier {
            (volume * mul).max(0.01)
        } else if let Some(fixed) = config.fixed_lot {
            fixed
        } else {
            volume
        }
    } else {
        if let Some(fixed) = config.fixed_lot {
            fixed
        } else if let Some(mul) = config.lot_multiplier {
            (volume * mul).max(0.01)
        } else {
            volume
        }
    }
}

fn effective_reverse(config: &SlaveCopyConfig) -> bool {
    config.reverse_trading.unwrap_or(false)
}

async fn load_slave_copy_config(
    state_manager: &Arc<LocalStateFileManager>,
    slave_account_id: &str,
) -> Option<SlaveCopyConfig> {
    state_manager
        .read(|s| {
            s.accounts.get(slave_account_id).map(|a| SlaveCopyConfig {
                symbol_translations: a.symbol_translations.clone(),
                lot_type: a.lot_type.clone(),
                lot_multiplier: a.lot_multiplier,
                fixed_lot: a.fixed_lot,
                reverse_trading: a.reverse_trading,
                exact_match: a.exact_match,
                prefix: a.prefix.clone(),
                suffix: a.suffix.clone(),
            })
        })
        .await
}

fn clamp_to_symbol_limits_by_id(
    volume: f64,
    symbol_id: u64,
    symbol_min_lots: &HashMap<u64, f64>,
    symbol_max_lots: &HashMap<u64, f64>,
) -> f64 {
    if volume <= 0.0 {
        return volume;
    }
    let mut adjusted = volume;
    if let Some(min_lots) = symbol_min_lots.get(&symbol_id).copied() {
        if min_lots.is_finite() && min_lots > 0.0 && adjusted < min_lots {
            adjusted = min_lots;
        }
    }
    if let Some(max_lots) = symbol_max_lots.get(&symbol_id).copied() {
        if max_lots.is_finite() && max_lots > 0.0 && adjusted > max_lots {
            adjusted = max_lots;
        }
    }
    adjusted
}

fn resolve_target_volume_by_id(
    _master_volume: f64,
    copied_volume: f64,
    symbol_id: u64,
    symbol_min_lots: &HashMap<u64, f64>,
    symbol_max_lots: &HashMap<u64, f64>,
) -> f64 {
    clamp_to_symbol_limits_by_id(copied_volume, symbol_id, symbol_min_lots, symbol_max_lots)
}

fn resolve_target_volume_by_name(
    master_volume: f64,
    copied_volume: f64,
    symbol_name: &str,
    symbol_id_to_name: &HashMap<u64, String>,
    symbol_min_lots: &HashMap<u64, f64>,
    symbol_max_lots: &HashMap<u64, f64>,
) -> f64 {
    if symbol_name.trim().is_empty() {
        return copied_volume;
    }
    let symbol_id = symbol_id_to_name
        .iter()
        .find_map(|(id, name)| name.eq_ignore_ascii_case(symbol_name).then_some(*id));
    match symbol_id {
        Some(id) => resolve_target_volume_by_id(
            master_volume,
            copied_volume,
            id,
            symbol_min_lots,
            symbol_max_lots,
        ),
        None => copied_volume,
    }
}

fn lookup_price_digits(symbol_digits: &HashMap<u64, u32>, symbol_id: u64) -> Option<u32> {
    symbol_digits.get(&symbol_id).copied()
}

fn lookup_price_digits_by_name(
    symbol_digits: &HashMap<u64, u32>,
    id_to_name: &HashMap<u64, String>,
    symbol_name: &str,
) -> Option<u32> {
    for (id, name) in id_to_name {
        if name.eq_ignore_ascii_case(symbol_name) {
            return symbol_digits.get(id).copied();
        }
    }
    None
}

fn round_to_digits(value: f64, digits: u32) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let factor = 10_f64.powi(digits as i32);
    (value * factor).round() / factor
}

fn normalize_price(value: f64, digits: Option<u32>) -> f64 {
    match digits {
        Some(d) => round_to_digits(value, d),
        None => value,
    }
}

fn normalize_price_opt(value: Option<f64>, digits: Option<u32>) -> Option<f64> {
    match digits {
        Some(d) => value.map(|v| round_to_digits(v, d)),
        None => value,
    }
}

fn price_opt_eq(a: Option<f64>, b: Option<f64>, digits: Option<u32>) -> bool {
    match digits {
        Some(d) => {
            let na = a.map(|v| round_to_digits(v, d));
            let nb = b.map(|v| round_to_digits(v, d));
            na == nb
        }
        None => match (a, b) {
            (None, None) => true,
            (Some(x), Some(y)) => (x - y).abs() < 1e-6,
            _ => false,
        },
    }
}

fn sanitize_pending_sltp(
    _entry_price: f64,
    sl: Option<f64>,
    tp: Option<f64>,
    _digits: Option<u32>,
    _is_buy: bool,
) -> (Option<f64>, Option<f64>) {
    (sl, tp)
}

fn normalize_optional_price_for_compare(value: Option<f64>, digits: Option<u32>) -> Option<f64> {
    let normalized = normalize_price_opt(value, digits);
    match normalized {
        Some(v) if v.abs() <= 1e-9 => None,
        _ => normalized,
    }
}

fn apply_reverse_side(side: &str, reverse: bool) -> String {
    if !reverse {
        return side.to_string();
    }
    match side.to_lowercase().as_str() {
        "buy" => "sell".to_string(),
        "sell" => "buy".to_string(),
        _ => side.to_string(),
    }
}

fn apply_reverse_sl_tp(sl: Option<f64>, tp: Option<f64>, reverse: bool) -> (Option<f64>, Option<f64>) {
    if !reverse {
        return (sl, tp);
    }
    (tp, sl)
}

fn apply_reverse_order_type(order_type: &str, reverse: bool) -> String {
    if !reverse {
        return order_type.to_string();
    }
    match order_type.trim().to_lowercase().as_str() {
        "limit" => "stop".to_string(),
        "stop" => "limit".to_string(),
        _ => order_type.to_string(),
    }
}

async fn refresh_copy_tx(
    copy_tx: &mut mpsc::Sender<CopyCommand>,
    app_state: &Option<Arc<AppState>>,
    slave_account_id: &str,
) -> bool {
    if let Some(ref app) = app_state {
        if let Some(new_tx) = app.copy_command_tx.read().await.get(slave_account_id).cloned() {
            if !new_tx.is_closed() {
                *copy_tx = new_tx;
                return true;
            }
        }
    }
    false
}

fn master_ticket_from_pos(pos: &SlavePosition) -> Option<i64> {
    pos.label.trim().parse::<i64>().ok()
        .or_else(|| pos.comment.trim().parse::<i64>().ok())
}

fn master_ticket_from_ord(ord: &SlaveOrder) -> Option<i64> {
    ord.label.trim().parse::<i64>().ok()
        .or_else(|| ord.comment.trim().parse::<i64>().ok())
}

fn refresh_ticket_index(
    positions: &[SlavePosition],
    orders: &[SlaveOrder],
    position_index: &mut HashMap<i64, Vec<(i64, i64)>>,
    order_index: &mut HashMap<i64, Vec<i64>>,
) {
    position_index.clear();
    order_index.clear();
    for pos in positions {
        if let Some(ticket) = master_ticket_from_pos(pos) {
            let vol_centi = ((pos.volume * 100.0).round() as i64).max(1);
            position_index
                .entry(ticket)
                .or_default()
                .push((pos.position_id, vol_centi));
        }
    }
    for ord in orders {
        if let Some(ticket) = master_ticket_from_ord(ord) {
            order_index.entry(ticket).or_default().push(ord.order_id);
        }
    }
}

fn slave_pos_matches(pos: &SlavePosition, master_label: &str) -> bool {
    let ml = master_label.trim();
    pos.comment.trim().eq_ignore_ascii_case(ml) || pos.label.trim().eq_ignore_ascii_case(ml)
}

fn slave_ord_matches(ord: &SlaveOrder, master_label: &str) -> bool {
    let ml = master_label.trim();
    ord.comment.trim().eq_ignore_ascii_case(ml) || ord.label.trim().eq_ignore_ascii_case(ml)
        || ml.parse::<i64>().ok().map(|t| master_ticket_from_ord(ord) == Some(t)).unwrap_or(false)
}

fn order_type_for_amend(proto_order_type: i32) -> &'static str {
    if proto_order_type == 3 {
        "stop"
    } else {
        "limit"
    }
}

async fn get_reconcile(
    copy_tx: &mut tokio::sync::mpsc::Sender<CopyCommand>,
) -> Result<
    (
        Vec<crate::services::proto_oa::SlavePosition>,
        Vec<crate::services::proto_oa::SlaveOrder>,
        HashMap<u64, String>,
        HashMap<u64, u32>,
        HashMap<u64, f64>,
        HashMap<u64, f64>,
    ),
    String,
> {
    let (reply_tx, reply_rx) = oneshot::channel();
    copy_tx
        .send(CopyCommand::GetReconcile { reply: reply_tx })
        .await
        .map_err(|_| "copy_tx send failed".to_string())?;
    let inner = tokio::time::timeout(
        std::time::Duration::from_secs(COPY_GET_RECONCILE_TIMEOUT_SECS),
        reply_rx,
    )
    .await
    .map_err(|_| "get reconcile timeout".to_string())?
    .map_err(|_| "get reconcile channel closed".to_string())?;
    inner
}

const COPY_GET_RECONCILE_RETRY_DELAY_MS: u64 = 1500;

async fn get_reconcile_with_retry(
    slave_account_id: &str,
    copy_tx: &mut tokio::sync::mpsc::Sender<CopyCommand>,
    phase: &str,
) -> Result<
    (
        Vec<crate::services::proto_oa::SlavePosition>,
        Vec<crate::services::proto_oa::SlaveOrder>,
        HashMap<u64, String>,
        HashMap<u64, u32>,
        HashMap<u64, f64>,
        HashMap<u64, f64>,
    ),
    String,
> {
    let mut last_err = String::new();
    for attempt in 0..3 {
        match get_reconcile(copy_tx).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                last_err = e.clone();
                tracing::warn!(
                    slave = %slave_account_id,
                    phase = %phase,
                    attempt = attempt + 1,
                    error = %e,
                    "get_reconcile failed during snapshot reconciliation"
                );
                if attempt < 2 {
                    tokio::time::sleep(std::time::Duration::from_millis(COPY_GET_RECONCILE_RETRY_DELAY_MS)).await;
                }
            }
        }
    }
    Err(last_err)
}

async fn amend_sltp_after_open(
    copy_tx: &mut tokio::sync::mpsc::Sender<CopyCommand>,
    master_label: &str,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
) {
    if stop_loss.is_none() && take_profit.is_none() {
        return;
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    if let Ok((positions_after, _, _, _, _, _)) = get_reconcile(copy_tx).await {
        if let Some(pos) = positions_after.iter().find(|p| slave_pos_matches(p, master_label)) {
            let _ = copy_tx
                .send(CopyCommand::AmendPositionSLTP {
                    position_id: pos.position_id,
                    stop_loss,
                    take_profit,
                })
                .await;
        } else {
            tracing::warn!(
                master_label = %master_label,
                "Position not found for AmendPositionSLTP (may not have opened yet)"
            );
        }
    }
}

fn symbol_matches(expected: &str, actual: Option<&str>) -> bool {
    match actual {
        None => true,
        Some(a) => a.trim().eq_ignore_ascii_case(expected.trim()),
    }
}

async fn run_snapshot_reconcile_loop(
    sid: String,
    mut copy_tx: mpsc::Sender<CopyCommand>,
    mut snap: TcpSnapshotMessageIn,
    mut config: SlaveCopyConfig,
    known_position_ids: Arc<RwLock<HashMap<i64, i64>>>,
    known_order_ids: Arc<RwLock<HashMap<i64, i64>>>,
    snap_order: Arc<RwLock<(i64, i64)>>,
    copy_map: Arc<RwLock<slave_copy_map::CopyMap>>,
    event_generation: Arc<AtomicU64>,
    _sem: Arc<Semaphore>,
    pending: Arc<Mutex<Option<(TcpSnapshotMessageIn, SlaveCopyConfig)>>>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    app_state: Option<Arc<AppState>>,
) {
    let _permit = match permit {
        Some(p) => p,
        None => _sem.acquire_owned().await.unwrap(),
    };
    loop {
        reconcile_slave_with_snapshot(
            &sid,
            &mut copy_tx,
            &app_state,
            &snap,
            &config,
            &known_position_ids,
            &known_order_ids,
            &snap_order,
            &copy_map,
            &event_generation,
        )
        .await;
        if let Some((next_snap, next_config)) = pending.lock().await.take() {
            snap = next_snap;
            config = next_config;
        } else {
            break;
        }
    }
}

async fn reconcile_slave_with_snapshot(
    slave_account_id: &str,
    copy_tx: &mut tokio::sync::mpsc::Sender<CopyCommand>,
    app_state: &Option<Arc<AppState>>,
    snapshot: &TcpSnapshotMessageIn,
    config: &SlaveCopyConfig,
    known_position_ids: &Arc<RwLock<HashMap<i64, i64>>>,
    known_order_ids: &Arc<RwLock<HashMap<i64, i64>>>,
    snap_order: &Arc<RwLock<(i64, i64)>>,
    copy_map: &Arc<RwLock<slave_copy_map::CopyMap>>,
    event_generation: &Arc<AtomicU64>,
) {
    if !refresh_copy_tx(copy_tx, app_state, slave_account_id).await && copy_tx.is_closed() {
        return;
    }
    // Order gate: ignore stale / out-of-order / replayed snapshots. Only act on one newer
    // than the last applied (a new master session is always accepted). snap_order = (session, seq)
    // and persists across reconnects, so the on-connect replay of an old snapshot is dropped.
    if snapshot.session > 0 {
        let mut g = snap_order.write().unwrap();
        if snapshot.session != g.0 {
            *g = (snapshot.session, snapshot.seq);
        } else if snapshot.seq <= g.1 {
            return;
        } else {
            g.1 = snapshot.seq;
        }
    }
    let gen_start = event_generation.load(Ordering::Relaxed);
    let (positions, orders, _, _, _, _) =
        match get_reconcile_with_retry(slave_account_id, copy_tx, "phase1_close_extras").await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(slave = %slave_account_id, error = %e, "reconcile phase1 failed, skipping snapshot");
                return;
            }
        };
    if event_generation.load(Ordering::Relaxed) != gen_start {
        return;
    }
    let reverse = effective_reverse(&config);
    let master_pos_tickets: HashSet<i64> = snapshot.open_positions.iter().map(|p| p.ticket).collect();
    let master_ord_tickets: HashSet<i64> = snapshot.pending_orders.iter().map(|o| o.ticket).collect();
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    {
        let mut map = copy_map.write().unwrap();
        let mut changed = false;
        for pos in &positions {
            if let Some(t) = master_ticket_from_pos(pos) {
                if map.set_position(t, pos.position_id) {
                    changed = true;
                }
            }
        }
        for ord in &orders {
            if let Some(t) = master_ticket_from_ord(ord) {
                if map.set_order(t, ord.order_id) {
                    changed = true;
                }
            }
        }
        let slave_pos_ids: Vec<i64> = positions.iter().map(|p| p.position_id).collect();
        let slave_ord_ids: Vec<i64> = orders.iter().map(|o| o.order_id).collect();
        if map.retain_slave_tickets(&slave_pos_ids, &slave_ord_ids) {
            changed = true;
        }
        if changed {
            slave_copy_map::save(slave_account_id, &map);
        }
    }

    for pos in &positions {
        let ticket: i64 = match master_ticket_from_pos(pos) {
            Some(t) => t,
            _ => continue,
        };
        if master_pos_tickets.contains(&ticket) || master_ord_tickets.contains(&ticket) {
            known_position_ids.write().unwrap().remove(&ticket);
            continue;
        }
        // Grace: don't close a copy opened within the inflight window. Covers the async race
        // where a real-time `placed` just opened it and this snapshot predates that open.
        let recently_opened = known_position_ids
            .read()
            .unwrap()
            .get(&ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false);
        if recently_opened {
            continue;
        }
        known_position_ids.write().unwrap().remove(&ticket);
        let vol_centi = (pos.volume * 100.0).round() as i64;
let _ = copy_tx.send(CopyCommand::ClosePosition {
            position_id: pos.position_id,
            volume_centi_lots: vol_centi.max(1),
        }).await;
        known_position_ids.write().unwrap().remove(&ticket);
        {
            let mut map = copy_map.write().unwrap();
            if map.remove_position_by_slave(pos.position_id) {
                slave_copy_map::save(slave_account_id, &map);
            }
        }
    }
    for ord in &orders {
        let ticket: i64 = match master_ticket_from_ord(ord) {
            Some(t) => t,
            _ => continue,
        };
        if master_ord_tickets.contains(&ticket) || master_pos_tickets.contains(&ticket) {
            known_order_ids.write().unwrap().remove(&ticket);
            continue;
        }
        let recently_placed = known_order_ids
            .read()
            .unwrap()
            .get(&ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false);
        if recently_placed {
            continue;
        }
        known_order_ids.write().unwrap().remove(&ticket);
let _ = copy_tx.send(CopyCommand::CancelOrder { order_id: ord.order_id }).await;
        known_order_ids.write().unwrap().remove(&ticket);
        {
            let mut map = copy_map.write().unwrap();
            if map.remove_order_by_slave(ord.order_id) {
                slave_copy_map::save(slave_account_id, &map);
            }
        }
    }
    if config.exact_match.unwrap_or(false) {
        for pos in &positions {
            let is_copier = master_ticket_from_pos(pos).is_some()
                || copy_map.read().unwrap().is_copier_position(pos.position_id);
            if is_copier {
                continue;
            }
            let vol_centi = (pos.volume * 100.0).round() as i64;
            tracing::info!(
                slave = %slave_account_id,
                position_id = pos.position_id,
                "exact_match: closing untracked slave position"
            );
            let _ = copy_tx
                .send(CopyCommand::ClosePosition {
                    position_id: pos.position_id,
                    volume_centi_lots: vol_centi.max(1),
                })
                .await;
        }
        for ord in &orders {
            let is_copier = master_ticket_from_ord(ord).is_some()
                || copy_map.read().unwrap().is_copier_order(ord.order_id);
            if is_copier {
                continue;
            }
            tracing::info!(
                slave = %slave_account_id,
                order_id = ord.order_id,
                "exact_match: cancelling untracked slave pending order"
            );
            let _ = copy_tx
                .send(CopyCommand::CancelOrder { order_id: ord.order_id })
                .await;
        }
    }
    if event_generation.load(Ordering::Relaxed) != gen_start {
        return;
    }
    if !refresh_copy_tx(copy_tx, app_state, slave_account_id).await && copy_tx.is_closed() {
        return;
    }

    let (positions, orders, id_to_name_early, sym_digits_early, sym_min_lots_early, sym_max_lots_early) =
        match get_reconcile_with_retry(slave_account_id, copy_tx, "phase2_open_new").await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(slave = %slave_account_id, error = %e, "reconcile phase2 failed, skipping snapshot");
                return;
            }
        };

    for pos in &snapshot.open_positions {
        let label = pos.ticket.to_string();
        let in_flight_pos = known_position_ids
            .read()
            .unwrap()
            .get(&pos.ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false);
        let already_on_slave = positions.iter().any(|p| slave_pos_matches(p, &label)) || in_flight_pos;
        let has_pending_on_slave = orders.iter().any(|o| slave_ord_matches(o, &label));
        let has_inflight_pending = known_order_ids
            .read()
            .unwrap()
            .get(&pos.ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false)
            && master_ord_tickets.contains(&pos.ticket);
        if known_order_ids.read().unwrap().contains_key(&pos.ticket)
            && !master_ord_tickets.contains(&pos.ticket)
            && !has_pending_on_slave
        {
            known_order_ids.write().unwrap().remove(&pos.ticket);
        }
        let slave_has_pending_with_label = has_pending_on_slave || has_inflight_pending;
        if already_on_slave || slave_has_pending_with_label {
            continue;
        }
        if !pos.r#type.eq_ignore_ascii_case("market") {
            continue;
        }
        if pos.age_seconds > COPY_MAX_AGE_MARKET_OPEN_SECS {
            continue;
        }
        let slave_symbol = apply_symbol(&pos.symbol, config);
        if slave_symbol.is_empty() {
            tracing::warn!(
                master_symbol = %pos.symbol,
                ticket = pos.ticket,
                slave = %slave_account_id,
                "copy skip (snapshot): symbol maps to empty for market position"
            );
            continue;
        }
        let configured_volume = apply_volume(pos.volume, config);
        let volume = resolve_target_volume_by_name(
            pos.volume,
            configured_volume,
            &slave_symbol,
            &id_to_name_early,
            &sym_min_lots_early,
            &sym_max_lots_early,
        );
        if volume <= 0.0 {
            continue;
        }
        let side = apply_reverse_side(&pos.side, reverse);
        let price_digits = lookup_price_digits_by_name(&sym_digits_early, &id_to_name_early, &slave_symbol);
        let (raw_sl, raw_tp) = apply_reverse_sl_tp(pos.sl, pos.tp, reverse);
        let sl = normalize_price_opt(raw_sl, price_digits);
        let tp = normalize_price_opt(raw_tp, price_digits);
        let is_buy = side.eq_ignore_ascii_case("buy");
        let send_ok = copy_tx
            .send(CopyCommand::OpenMarket {
                symbol_name: slave_symbol.clone(),
                volume_lots: volume,
                is_buy,
                comment: label.clone(),
                label: label.clone(),
                position_id: None,
                reply: None,
            })
            .await
            .is_ok();
        if send_ok {
            known_position_ids.write().unwrap().insert(pos.ticket, now_secs);
        }
        amend_sltp_after_open(copy_tx, &label, sl, tp).await;
    }
    for ord in &snapshot.pending_orders {
        let label = format!("{}", ord.ticket);
        let in_flight_ord = known_order_ids
            .read()
            .unwrap()
            .get(&ord.ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false);
        let in_flight_pos = known_position_ids
            .read()
            .unwrap()
            .get(&ord.ticket)
            .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
            .unwrap_or(false);
        let already_ord = orders.iter().any(|o| slave_ord_matches(o, &label)) || in_flight_ord;
        let already_pos = positions.iter().any(|p| slave_pos_matches(p, &label)) || in_flight_pos;
        if already_ord || already_pos {
            continue;
        }
        let slave_symbol = apply_symbol(&ord.symbol, config);
        if slave_symbol.is_empty() {
            tracing::warn!(
                slave = %slave_account_id,
                ticket = ord.ticket,
                master_symbol = %ord.symbol,
                "copy skip (snapshot): symbol maps to empty"
            );
            continue;
        }
        let configured_volume = apply_volume(ord.volume, config);
        let volume = resolve_target_volume_by_name(
            ord.volume,
            configured_volume,
            &slave_symbol,
            &id_to_name_early,
            &sym_min_lots_early,
            &sym_max_lots_early,
        );
        if volume <= 0.0 {
            tracing::warn!(
                slave = %slave_account_id,
                ticket = ord.ticket,
                symbol = %slave_symbol,
                master_volume = ord.volume,
                configured_volume,
                "copy skip (snapshot): resolved volume <= 0"
            );
            continue;
        }
        let side = apply_reverse_side(&ord.side, reverse);
        let price_digits = lookup_price_digits_by_name(&sym_digits_early, &id_to_name_early, &slave_symbol);
        let (raw_sl, raw_tp) = apply_reverse_sl_tp(ord.sl, ord.tp, reverse);
        let target_price = normalize_price(ord.price, price_digits);
        let is_buy = side.eq_ignore_ascii_case("buy");
        let (sl, tp) = sanitize_pending_sltp(
            target_price,
            normalize_price_opt(raw_sl, price_digits),
            normalize_price_opt(raw_tp, price_digits),
            price_digits,
            is_buy,
        );
        let order_type_slave = apply_reverse_order_type(&ord.r#type, reverse);
        let send_ok = copy_tx.send(CopyCommand::PlacePendingOrder {
            symbol_name: slave_symbol.clone(),
            volume_lots: volume,
            is_buy,
            order_type: order_type_slave,
            price: target_price,
            stop_loss: sl,
            take_profit: tp,
            comment: label.clone(),
            label: label.clone(),
            reply: None,
        }).await.is_ok();
        if send_ok {
            known_order_ids.write().unwrap().insert(ord.ticket, now_secs);
        }
    }
    if event_generation.load(Ordering::Relaxed) != gen_start {
        return;
    }

    let Ok((positions2, orders2, symbol_id_to_name, symbol_digits, symbol_min_lots, symbol_max_lots)) =
        get_reconcile(copy_tx).await
    else {
        return;
    };
    for pos in &snapshot.open_positions {
        let label = pos.ticket.to_string();
        let slave_pos = positions2.iter().find(|p| slave_pos_matches(p, &label));
        let slave_ord = orders2.iter().find(|o| slave_ord_matches(o, &label));
        if let Some(slave_pos) = slave_pos {
        let expected_slave_symbol = apply_symbol(&pos.symbol, config);
        let actual_slave_symbol = symbol_id_to_name.get(&slave_pos.symbol_id).map(|s| s.as_str());
        let symbol_changed = !symbol_matches(&expected_slave_symbol, actual_slave_symbol);
        if symbol_changed {
            tracing::warn!(
                slave = %slave_account_id,
                ticket = pos.ticket,
                master_symbol = %pos.symbol,
                expected_slave_symbol = %expected_slave_symbol,
                actual_slave_symbol = ?actual_slave_symbol,
                position_id = slave_pos.position_id,
                "Symbol mismatch: slave position on wrong pair, closing and may reopen on correct"
            );
        }
        let price_digits = lookup_price_digits(&symbol_digits, slave_pos.symbol_id);
        let (raw_sl, raw_tp) = apply_reverse_sl_tp(pos.sl, pos.tp, reverse);
        let sl = normalize_price_opt(raw_sl, price_digits);
        let tp = normalize_price_opt(raw_tp, price_digits);
        let target_vol = resolve_target_volume_by_id(
            pos.volume,
            apply_volume(pos.volume, config),
            slave_pos.symbol_id,
            &symbol_min_lots,
            &symbol_max_lots,
        );
        let sl_changed = !price_opt_eq(slave_pos.stop_loss, sl, price_digits);
        let tp_changed = !price_opt_eq(slave_pos.take_profit, tp, price_digits);
        let expected_side = apply_reverse_side(&pos.side, reverse);
        let expected_is_buy = expected_side.eq_ignore_ascii_case("buy");
        let side_changed = expected_is_buy != (slave_pos.trade_side == 1);
        let age_secs = pos.age_seconds as i64;
        if symbol_changed {
            let vol_centi = (slave_pos.volume * 100.0).round() as i64;
            let reopen_symbol = age_secs <= COPY_INFLIGHT_GRACE_SECS;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                position_id: slave_pos.position_id,
                volume_centi_lots: vol_centi.max(1),
            }).await;
            if reopen_symbol && !expected_slave_symbol.is_empty() {
                let volume = resolve_target_volume_by_name(
                    pos.volume,
                    apply_volume(pos.volume, config),
                    &expected_slave_symbol,
                    &symbol_id_to_name,
                    &symbol_min_lots,
                    &symbol_max_lots,
                );
                if volume > 0.0 {
                    let side = apply_reverse_side(&pos.side, reverse);
                    let is_buy = side.eq_ignore_ascii_case("buy");
if copy_tx.send(CopyCommand::OpenMarket {
                        symbol_name: expected_slave_symbol.clone(),
                        volume_lots: volume,
                        is_buy,
                        comment: label.clone(),
                        label: label.clone(),
                        position_id: None,
                        reply: None,
                    }).await.is_ok() {
                        amend_sltp_after_open(copy_tx, &label, sl, tp).await;
                    }
                }
            }
        } else if side_changed {
            let vol_centi = (slave_pos.volume * 100.0).round() as i64;
            let reopen = age_secs <= COPY_INFLIGHT_GRACE_SECS;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                position_id: slave_pos.position_id,
                volume_centi_lots: vol_centi.max(1),
            }).await;
            if reopen && !expected_slave_symbol.is_empty() {
                let volume = resolve_target_volume_by_name(
                    pos.volume,
                    apply_volume(pos.volume, config),
                    &expected_slave_symbol,
                    &symbol_id_to_name,
                    &symbol_min_lots,
                    &symbol_max_lots,
                );
                if volume > 0.0 {
if copy_tx.send(CopyCommand::OpenMarket {
                        symbol_name: expected_slave_symbol.clone(),
                        volume_lots: volume,
                        is_buy: expected_is_buy,
                        comment: label.clone(),
                        label: label.clone(),
                        position_id: None,
                        reply: None,
                    }).await.is_ok() {
                        amend_sltp_after_open(copy_tx, &label, sl, tp).await;
                    }
                }
            }
        } else if sl_changed || tp_changed {
let _ = copy_tx.send(CopyCommand::AmendPositionSLTP {
                position_id: slave_pos.position_id,
                stop_loss: sl,
                take_profit: tp,
            }).await;
        }
        if !symbol_changed && target_vol > 0.0 && target_vol < slave_pos.volume - 0.001 {
            let vol_centi = ((slave_pos.volume - target_vol) * 100.0).round() as i64;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                position_id: slave_pos.position_id,
                volume_centi_lots: vol_centi.max(1),
            }).await;
        }
        } else if let Some(slave_ord) = slave_ord {
            let expected_slave_symbol = apply_symbol(&pos.symbol, config);
            let price_digits = lookup_price_digits(&symbol_digits, slave_ord.symbol_id);
            let (raw_sl, raw_tp) = apply_reverse_sl_tp(pos.sl, pos.tp, reverse);
            let sl = normalize_price_opt(raw_sl, price_digits);
            let tp = normalize_price_opt(raw_tp, price_digits);
            let current_sl = normalize_optional_price_for_compare(slave_ord.stop_loss, price_digits);
            let current_tp = normalize_optional_price_for_compare(slave_ord.take_profit, price_digits);
            let target_sl = normalize_optional_price_for_compare(sl, price_digits);
            let target_tp = normalize_optional_price_for_compare(tp, price_digits);
            let sl_changed = !price_opt_eq(current_sl, target_sl, price_digits);
            let tp_changed = !price_opt_eq(current_tp, target_tp, price_digits);
            let has_sltp_to_send = sl.is_some() || tp.is_some();
            if (sl_changed || tp_changed) && has_sltp_to_send && !expected_slave_symbol.is_empty() {
let _ = copy_tx.send(CopyCommand::AmendOrder {
                    symbol_name: Some(expected_slave_symbol),
                    order_id: slave_ord.order_id,
                    order_type: order_type_for_amend(slave_ord.order_type).to_string(),
                    volume_lots: slave_ord.volume,
                    price: slave_ord.price,
                    stop_loss: sl,
                    take_profit: tp,
                    is_buy: slave_ord.trade_side == 1,
                }).await;
            }
        }
    }
    for ord in &snapshot.pending_orders {
        let label = format!("{}", ord.ticket);
        let slave_ord = orders2.iter().find(|o| slave_ord_matches(o, &label));
        let slave_pos = positions2.iter().find(|p| slave_pos_matches(p, &label));
        let price_digits = if let Some(so) = slave_ord {
            lookup_price_digits(&symbol_digits, so.symbol_id)
        } else if let Some(sp) = slave_pos {
            lookup_price_digits(&symbol_digits, sp.symbol_id)
        } else {
            let slave_sym = apply_symbol(&ord.symbol, config);
            lookup_price_digits_by_name(&symbol_digits, &symbol_id_to_name, &slave_sym)
        };
        let (raw_sl, raw_tp) = apply_reverse_sl_tp(ord.sl, ord.tp, reverse);
        let target_price = normalize_price(ord.price, price_digits);
        let expected_is_buy = apply_reverse_side(&ord.side, reverse).eq_ignore_ascii_case("buy");
        let (sl, tp) = sanitize_pending_sltp(
            target_price,
            normalize_price_opt(raw_sl, price_digits),
            normalize_price_opt(raw_tp, price_digits),
            price_digits,
            expected_is_buy,
        );
        let target_vol = if let Some(so) = slave_ord {
            resolve_target_volume_by_id(
                ord.volume,
                apply_volume(ord.volume, config),
                so.symbol_id,
                &symbol_min_lots,
                &symbol_max_lots,
            )
        } else if let Some(sp) = slave_pos {
            resolve_target_volume_by_id(
                ord.volume,
                apply_volume(ord.volume, config),
                sp.symbol_id,
                &symbol_min_lots,
                &symbol_max_lots,
            )
        } else {
            let slave_sym = apply_symbol(&ord.symbol, config);
            resolve_target_volume_by_name(
                ord.volume,
                apply_volume(ord.volume, config),
                &slave_sym,
                &symbol_id_to_name,
                &symbol_min_lots,
                &symbol_max_lots,
            )
        };
            if let Some(slave_ord) = slave_ord {
            let expected_slave_symbol = apply_symbol(&ord.symbol, config);
            let actual_slave_symbol = symbol_id_to_name.get(&slave_ord.symbol_id).map(|s| s.as_str());
            let symbol_changed = !symbol_matches(&expected_slave_symbol, actual_slave_symbol);
            if symbol_changed {
                tracing::warn!(
                    slave = %slave_account_id,
                    ticket = ord.ticket,
                    master_symbol = %ord.symbol,
                    expected_slave_symbol = %expected_slave_symbol,
                    actual_slave_symbol = ?actual_slave_symbol,
                    order_id = slave_ord.order_id,
                    "Symbol mismatch: slave order on wrong pair, cancelling and may replace on correct"
                );
            }
            let expected_side = apply_reverse_side(&ord.side, reverse);
            let expected_order_type_slave = apply_reverse_order_type(&ord.r#type, reverse);
            let expected_is_buy = expected_side.eq_ignore_ascii_case("buy");
            let current_sl = normalize_optional_price_for_compare(slave_ord.stop_loss, price_digits);
            let current_tp = normalize_optional_price_for_compare(slave_ord.take_profit, price_digits);
            let target_sl = normalize_optional_price_for_compare(sl, price_digits);
            let target_tp = normalize_optional_price_for_compare(tp, price_digits);
            let sl_changed = !price_opt_eq(current_sl, target_sl, price_digits);
            let tp_changed = !price_opt_eq(current_tp, target_tp, price_digits);
            let vol_changed = (slave_ord.volume - target_vol).abs() > 0.001;
            let price_changed = !price_opt_eq(slave_ord.price, Some(target_price), price_digits);
            let side_changed = expected_is_buy != (slave_ord.trade_side == 1);
            let order_type_changed = !expected_order_type_slave.eq_ignore_ascii_case(order_type_for_amend(slave_ord.order_type));
            if symbol_changed {
                let age_secs = ord.age_seconds as i64;
                let reopen_symbol = age_secs <= COPY_INFLIGHT_GRACE_SECS;
let _ = copy_tx.send(CopyCommand::CancelOrder { order_id: slave_ord.order_id }).await;
                if reopen_symbol && target_vol > 0.0 && !expected_slave_symbol.is_empty() {
                    let _ = copy_tx.send(CopyCommand::PlacePendingOrder {
                        symbol_name: expected_slave_symbol,
                        volume_lots: target_vol,
                        is_buy: expected_is_buy,
                        order_type: expected_order_type_slave.clone(),
                        price: target_price,
                        stop_loss: sl,
                        take_profit: tp,
                        comment: label.clone(),
                        label: label.clone(),
                        reply: None,
                    }).await;
                }
            } else if side_changed || order_type_changed {
                if target_vol <= 0.0 || expected_slave_symbol.is_empty() {
                    continue;
                }
let _ = copy_tx.send(CopyCommand::CancelOrder { order_id: slave_ord.order_id }).await;
                let _ = copy_tx.send(CopyCommand::PlacePendingOrder {
                    symbol_name: expected_slave_symbol,
                    volume_lots: target_vol,
                    is_buy: expected_is_buy,
                    order_type: expected_order_type_slave.clone(),
                    price: target_price,
                    stop_loss: sl,
                    take_profit: tp,
                    comment: label.clone(),
                    label: label.clone(),
                    reply: None,
                }).await;
            } else if sl_changed || tp_changed || vol_changed || price_changed {
                let new_vol = if vol_changed { target_vol } else { slave_ord.volume };
                let new_price = if price_changed {
                    target_price
                } else {
                    normalize_price_opt(slave_ord.price, price_digits).unwrap_or(target_price)
                };
let _ = copy_tx.send(CopyCommand::AmendOrder {
                    symbol_name: Some(expected_slave_symbol.clone()),
                    order_id: slave_ord.order_id,
                    order_type: order_type_for_amend(slave_ord.order_type).to_string(),
                    volume_lots: new_vol,
                    price: Some(new_price),
                    stop_loss: sl,
                    take_profit: tp,
                    is_buy: slave_ord.trade_side == 1,
                }).await;
            }
        } else if let Some(slave_pos) = slave_pos {
            let expected_slave_symbol = apply_symbol(&ord.symbol, config);
            let actual_slave_symbol = symbol_id_to_name.get(&slave_pos.symbol_id).map(|s| s.as_str());
            let symbol_changed = !symbol_matches(&expected_slave_symbol, actual_slave_symbol);
            if symbol_changed {
                tracing::warn!(
                    slave = %slave_account_id,
                    ticket = ord.ticket,
                    master_symbol = %ord.symbol,
                    expected_slave_symbol = %expected_slave_symbol,
                    actual_slave_symbol = ?actual_slave_symbol,
                    position_id = slave_pos.position_id,
                    "Symbol mismatch: slave position (from pending) on wrong pair"
                );
            }
            let sl_changed = !price_opt_eq(slave_pos.stop_loss, sl, price_digits);
            let tp_changed = !price_opt_eq(slave_pos.take_profit, tp, price_digits);
            if symbol_changed && !expected_slave_symbol.is_empty() && target_vol > 0.0 {
                let side = apply_reverse_side(&ord.side, reverse);
                let is_buy = side.eq_ignore_ascii_case("buy");
                let vol_centi = (slave_pos.volume * 100.0).round() as i64;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                    position_id: slave_pos.position_id,
                    volume_centi_lots: vol_centi.max(1),
                }).await;
                if copy_tx.send(CopyCommand::PlacePendingOrder {
                    symbol_name: expected_slave_symbol,
                    volume_lots: target_vol,
                    is_buy,
                    order_type: apply_reverse_order_type(&ord.r#type, reverse),
                    price: target_price,
                    stop_loss: sl,
                    take_profit: tp,
                    comment: label.clone(),
                    label: label.clone(),
                    reply: None,
                }).await.is_ok() {}
            } else if sl_changed || tp_changed {
let _ = copy_tx.send(CopyCommand::AmendPositionSLTP {
                    position_id: slave_pos.position_id,
                    stop_loss: sl,
                    take_profit: tp,
                }).await;
            }
            if !symbol_changed && target_vol > 0.0 && target_vol < slave_pos.volume - 0.001 {
                let vol_centi = ((slave_pos.volume - target_vol) * 100.0).round() as i64;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                    position_id: slave_pos.position_id,
                    volume_centi_lots: vol_centi.max(1),
                }).await;
            }
        }
    }
}

async fn run_slave_tcp_client(
    slave_account_id: String,
    state_manager: Arc<LocalStateFileManager>,
    app_state: Option<Arc<AppState>>,
) {
    // (session, seq) of the last snapshot applied. Created OUTSIDE the reconnect loop so it
    // survives reconnects — otherwise the on-connect replay of an old snapshot would be
    // accepted. Reset to (0,0) only when this task restarts (new master assignment).
    let snap_order: Arc<RwLock<(i64, i64)>> = Arc::new(RwLock::new((0, 0)));
    loop {
        let tcp_enabled = match &app_state {
            Some(app) => *app.tcp_enabled.read().await.get(&slave_account_id).unwrap_or(&true),
            None => false,
        };
        if !tcp_enabled {
            return;
        }

        let (master_url, config) = {
            let url_only = state_manager
                .read(|s| {
                    s.accounts
                        .get(&slave_account_id)
                        .map(|a| (true, a.master_tcp_url.clone()))
                })
                .await;
            let cfg = load_slave_copy_config(&state_manager, &slave_account_id).await;
            let snap = match (url_only, cfg) {
                (Some((true, url)), Some(c)) => Some((true, url, c)),
                _ => None,
            };
            match snap {
                Some((true, Some(url), cfg)) if !url.trim().is_empty() => (url, cfg),
                _ => {
                    return;
                }
            }
        };

        let (host, port, master_account_id) = match parse_master_tcp_url(&master_url) {
            Some(t) => t,
            None => {
                tokio::time::sleep(std::time::Duration::from_secs(COPY_INVALID_URL_SLEEP_SECS)).await;
                continue;
            }
        };
        if master_account_id.is_empty() {
            tokio::time::sleep(std::time::Duration::from_secs(COPY_INVALID_URL_SLEEP_SECS)).await;
            continue;
        }

        let addr = format!("{}:{}", host, port);
        let stream = match tokio::time::timeout(
            std::time::Duration::from_secs(COPY_TCP_CONNECT_TIMEOUT_SECS),
            TcpStream::connect(&addr),
        )
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                tracing::warn!(slave = %slave_account_id, error = %e, "copy TCP connect failed");
                tokio::time::sleep(std::time::Duration::from_secs(COPY_RECONNECT_BACKOFF_SECS)).await;
                continue;
            }
            Err(_) => {
                tracing::warn!(slave = %slave_account_id, "copy TCP connect timeout");
                tokio::time::sleep(std::time::Duration::from_secs(COPY_RECONNECT_BACKOFF_SECS)).await;
                continue;
            }
        };

        let (read_half, mut write_half) = stream.into_split();
        let account_line = format!("{}\n", master_account_id);
        if let Err(e) = write_half.write_all(account_line.as_bytes()).await {
            tracing::warn!(slave = %slave_account_id, error = %e, "copy TCP write account line failed");
            tokio::time::sleep(std::time::Duration::from_secs(COPY_RECONNECT_BACKOFF_SECS)).await;
            continue;
        }
        write_half.flush().await.ok();

        let known_position_ids: Arc<RwLock<HashMap<i64, i64>>> = Arc::new(RwLock::new(HashMap::new()));
        let known_order_ids: Arc<RwLock<HashMap<i64, i64>>> = Arc::new(RwLock::new(HashMap::new()));
        let copy_map: Arc<RwLock<slave_copy_map::CopyMap>> =
            Arc::new(RwLock::new(slave_copy_map::load(&slave_account_id)));
        let snapshot_sem: Arc<Semaphore> = Arc::new(Semaphore::new(1));
        let pending_snapshot: Arc<Mutex<Option<(TcpSnapshotMessageIn, SlaveCopyConfig)>>> =
            Arc::new(Mutex::new(None));
        let event_generation: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let mut position_index: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
        let mut order_index: HashMap<i64, Vec<i64>> = HashMap::new();

        let mut copy_tx = match &app_state {
            Some(s) => match s.copy_command_tx.read().await.get(&slave_account_id).cloned() {
                Some(tx) => tx,
                None => {
                    tokio::time::sleep(std::time::Duration::from_secs(COPY_RECONNECT_BACKOFF_SECS)).await;
                    continue;
                }
            },
            None => {
                return;
            }
        };

        if let Some(s) = &app_state {
            s.slave_tcp_connected_accounts.write().await.insert(slave_account_id.clone());
        }
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let mut last_line_seen: Option<(String, std::time::Instant)> = None;
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Some((prev_line, prev_ts)) = &last_line_seen {
                        if prev_line == line
                            && prev_ts.elapsed() <= std::time::Duration::from_millis(1200)
                        {
continue;
                        }
                    }
                    last_line_seen = Some((line.to_string(), std::time::Instant::now()));
                    if copy_tx.is_closed() {
                        if !refresh_copy_tx(&mut copy_tx, &app_state, &slave_account_id).await {
                            break;
                        }
                    }
                    let current_master_tcp_url = state_manager
                        .read(|s| s.accounts.get(&slave_account_id).and_then(|a| a.master_tcp_url.clone()))
                        .await;
                    if current_master_tcp_url.as_deref() != Some(master_url.trim()) {
                        break;
                    }
                    if let Some(ref app) = &app_state {
                        if !*app.tcp_enabled.read().await.get(&slave_account_id).unwrap_or(&true) {
                            break;
                        }
                    }
                    if line.contains("\"account_id\"")
                        && (line.contains("\"status\":\"connected\"") || line.contains("\"status\":\"ready\""))
                    {
                        continue;
                    }
                    if let Ok(snap) = serde_json::from_str::<TcpSnapshotMessageIn>(line) {
                        if snap.event.eq_ignore_ascii_case("snapshot") || snap.event.eq_ignore_ascii_case("periodic_snapshot") {
                            let config_snap = load_slave_copy_config(&state_manager, &slave_account_id)
                                .await
                                .unwrap_or_else(|| config.clone());
                            if let Ok(permit) = snapshot_sem.clone().try_acquire_owned() {
                                tokio::spawn(run_snapshot_reconcile_loop(
                                    slave_account_id.to_string(),
                                    copy_tx.clone(),
                                    snap,
                                    config_snap,
                                    Arc::clone(&known_position_ids),
                                    Arc::clone(&known_order_ids),
                                    Arc::clone(&snap_order),
                                    Arc::clone(&copy_map),
                                    Arc::clone(&event_generation),
                                    Arc::clone(&snapshot_sem),
                                    Arc::clone(&pending_snapshot),
                                    Some(permit),
                                    app_state.clone(),
                                ));
                            } else {
                                *pending_snapshot.lock().await = Some((snap, config_snap));
                            }
                            continue;
                        }
                    }
                    let evt: TcpEvent = match serde_json::from_str(line) {
                        Ok(e) => e,
                        Err(e) => {
                            tracing::warn!(
                                slave = %slave_account_id,
                                error = %e,
                                raw = %line,
                                "copy TCP event parse failed"
                            );
                            continue;
                        }
                    };
                    if evt.event.eq_ignore_ascii_case("closed") {
                        event_generation.fetch_add(1, Ordering::Relaxed);
                        let ticket = evt.ticket.unwrap_or(0);
                        if ticket > 0 {
                            let mut close_targets = position_index
                                .get(&ticket)
                                .cloned()
                                .unwrap_or_default();
                            let mut cancel_targets = order_index
                                .get(&ticket)
                                .cloned()
                                .unwrap_or_default();
                            if close_targets.is_empty() && cancel_targets.is_empty() {
                                if let Ok((positions, orders, _, _, _, _)) = get_reconcile(&mut copy_tx).await {
                                    refresh_ticket_index(
                                        &positions,
                                        &orders,
                                        &mut position_index,
                                        &mut order_index,
                                    );
                                    close_targets = position_index
                                        .get(&ticket)
                                        .cloned()
                                        .unwrap_or_default();
                                    cancel_targets = order_index
                                        .get(&ticket)
                                        .cloned()
                                        .unwrap_or_default();
                                }
                            }
                            for (position_id, volume_centi_lots) in close_targets {
                                let _ = copy_tx
                                    .send(CopyCommand::ClosePosition {
                                        position_id,
                                        volume_centi_lots,
                                    })
                                    .await;
                            }
                            for order_id in cancel_targets {
                                let _ = copy_tx.send(CopyCommand::CancelOrder { order_id }).await;
                            }
                            position_index.remove(&ticket);
                            order_index.remove(&ticket);
                        }
                        known_position_ids.write().unwrap().remove(&ticket);
                        known_order_ids.write().unwrap().remove(&ticket);
                        continue;
                    }
                    let (positions, orders, symbol_id_to_name, symbol_digits, symbol_min_lots, symbol_max_lots) =
                        match get_reconcile(&mut copy_tx).await {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::warn!(slave = %slave_account_id, error = %e, "copy get_reconcile failed");
                            if copy_tx.is_closed() {
                                if !refresh_copy_tx(&mut copy_tx, &app_state, &slave_account_id).await {
                                    break;
                                }
                            }
                            if let Ok(p) = get_reconcile(&mut copy_tx).await {
                                p
                            } else {
                                tracing::warn!(slave = %slave_account_id, "copy get_reconcile retry failed");
                                continue;
                            }
                        }
                    };
                    refresh_ticket_index(&positions, &orders, &mut position_index, &mut order_index);
                    let config = load_slave_copy_config(&state_manager, &slave_account_id)
                        .await
                        .unwrap_or_else(|| config.clone());
                    let reverse = effective_reverse(&config);
                    match evt.event.to_lowercase().as_str() {
                        "placed" => {
                            event_generation.fetch_add(1, Ordering::Relaxed);
                            let now_secs = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs() as i64;
                            let ticket = evt.ticket.unwrap_or(0);
                            let label = format!("{}", ticket);
                            let already_pos = positions.iter().any(|p| slave_pos_matches(p, &label))
                                || known_position_ids
                                    .read()
                                    .unwrap()
                                    .get(&ticket)
                                    .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
                                    .unwrap_or(false);
                            let already_ord = orders.iter().any(|o| slave_ord_matches(o, &label))
                                || known_order_ids
                                    .read()
                                    .unwrap()
                                    .get(&ticket)
                                    .map(|ts| now_secs - *ts <= COPY_INFLIGHT_GRACE_SECS)
                                    .unwrap_or(false);
                            if already_pos || already_ord {
                                continue;
                            }
                            let order_type = evt.order_type.as_deref().unwrap_or("market");
                            let is_pending = !order_type.eq_ignore_ascii_case("market");
                            let skip_reason = match evt.age_seconds {
                                None => {
                                    tracing::warn!(
                                        slave = %slave_account_id,
                                        ticket,
                                        symbol = ?evt.symbol,
                                        "copy skip: placed event has no age_seconds"
                                    );
                                    "no_age_seconds"
                                }
                                Some(age) if !is_pending && age > COPY_MAX_AGE_MARKET_OPEN_SECS => {
                                    tracing::warn!(
                                        slave = %slave_account_id,
                                        ticket,
                                        symbol = ?evt.symbol,
                                        age_secs = age,
                                        max_age_secs = COPY_MAX_AGE_MARKET_OPEN_SECS,
                                        "copy skip: placed event too old (market order)"
                                    );
                                    "event_too_old"
                                }
                                _ => "",
                            };
                            if !skip_reason.is_empty() {
                                continue;
                            }
                            let symbol = evt.symbol.as_deref().unwrap_or("");
                            let slave_symbol = apply_symbol(symbol, &config);
                            if slave_symbol.is_empty() {
                                continue;
                            }
                            let master_volume = evt.volume.unwrap_or(0.0);
                            let configured_volume = apply_volume(master_volume, &config);
                            let volume = resolve_target_volume_by_name(
                                master_volume,
                                configured_volume,
                                &slave_symbol,
                                &symbol_id_to_name,
                                &symbol_min_lots,
                                &symbol_max_lots,
                            );
                            if volume <= 0.0 {
                                continue;
                            }
                            let side = apply_reverse_side(evt.side.as_deref().unwrap_or("buy"), reverse);
                            let price_digits = lookup_price_digits_by_name(&symbol_digits, &symbol_id_to_name, &slave_symbol);
                            let (raw_sl, raw_tp) = apply_reverse_sl_tp(evt.sl, evt.tp, reverse);
                            let sl = normalize_price_opt(raw_sl, price_digits);
                            let tp = normalize_price_opt(raw_tp, price_digits);
                            let normalized_price = evt.price.map(|p| normalize_price(p, price_digits));
                            let order_type_slave = apply_reverse_order_type(order_type, reverse);
                            let is_buy = side.eq_ignore_ascii_case("buy");
                            if order_type.eq_ignore_ascii_case("market") {
                                let age_secs = evt.age_seconds;
                                tracing::info!(
                                    slave_account_id = %slave_account_id,
                                    master_ticket = ticket,
                                    symbol = %slave_symbol,
                                    volume_lots = volume,
                                    side = %side,
                                    sl = ?sl,
                                    tp = ?tp,
                                    event_age_secs = ?age_secs,
                                    "copy → slave: OpenMarket (queuing)"
                                );
                                let send_ok = copy_tx.send(CopyCommand::OpenMarket {
                                    symbol_name: slave_symbol.clone(),
                                    volume_lots: volume,
                                    is_buy,
                                    comment: label.clone(),
                                    label: label.clone(),
                                    position_id: None,
                                    reply: None,
                                }).await.is_ok();
                                if send_ok {
                                    known_position_ids.write().unwrap().insert(ticket, now_secs);
                                    tracing::info!(
                                        slave_account_id = %slave_account_id,
                                        symbol = %slave_symbol,
                                        "copy → slave: OpenMarket queued OK"
                                    );
                                } else {
                                    tracing::warn!(
                                        slave_account_id = %slave_account_id,
                                        symbol = %slave_symbol,
                                        "copy → slave: OpenMarket FAILED (channel closed, slave may be disconnected)"
                                    );
                                }
                                amend_sltp_after_open(&mut copy_tx, &label, sl, tp).await;
                            } else {
                                let price = normalized_price.unwrap_or(0.0);
                                let (sl, tp) = sanitize_pending_sltp(price, sl, tp, price_digits, is_buy);
                                tracing::info!(
                                    slave_account_id = %slave_account_id,
                                    master_ticket = ticket,
                                    symbol = %slave_symbol,
                                    volume_lots = volume,
                                    side = %side,
                                    order_type = %order_type_slave,
                                    price = price,
                                    sl = ?sl,
                                    tp = ?tp,
                                    "copy → slave: PlacePendingOrder (queuing)"
                                );
                                let send_ok = copy_tx.send(CopyCommand::PlacePendingOrder {
                                    symbol_name: slave_symbol.clone(),
                                    volume_lots: volume,
                                    is_buy,
                                    order_type: order_type_slave.clone(),
                                    price,
                                    stop_loss: sl,
                                    take_profit: tp,
                                    comment: label.clone(),
                                    label,
                                    reply: None,
                                }).await.is_ok();
                                if send_ok {
                                    known_order_ids.write().unwrap().insert(ticket, now_secs);
                                    tracing::info!(
                                        slave_account_id = %slave_account_id,
                                        symbol = %slave_symbol,
                                        "copy → slave: PlacePendingOrder queued OK"
                                    );
                                } else {
                                    tracing::warn!(
                                        slave_account_id = %slave_account_id,
                                        symbol = %slave_symbol,
                                        "copy → slave: PlacePendingOrder FAILED (channel closed, slave may be disconnected)"
                                    );
                                }
                            }
                        }
                        "modified" => {
                            event_generation.fetch_add(1, Ordering::Relaxed);
                            let ticket = evt.ticket.unwrap_or(0);
                            let label_mod = format!("{}", ticket);
                            let price_digits = if let Some(pos) = positions.iter().find(|p| slave_pos_matches(p, &label_mod)) {
                                lookup_price_digits(&symbol_digits, pos.symbol_id)
                            } else if let Some(ord) = orders.iter().find(|o| slave_ord_matches(o, &label_mod)) {
                                lookup_price_digits(&symbol_digits, ord.symbol_id)
                            } else {
                                let sym = evt.symbol.as_deref().map(|s| apply_symbol(s, &config)).unwrap_or_default();
                                lookup_price_digits_by_name(&symbol_digits, &symbol_id_to_name, &sym)
                            };
                            let (raw_sl, raw_tp) = apply_reverse_sl_tp(evt.sl, evt.tp, reverse);
                            let sl = normalize_price_opt(raw_sl, price_digits);
                            let tp = normalize_price_opt(raw_tp, price_digits);
                            let target_price = evt.price.map(|p| normalize_price(p, price_digits));
                            let label = format!("{}", ticket);
                            let expected_slave_symbol = evt.symbol.as_deref().map(|s| apply_symbol(s, &config)).unwrap_or_default();
                            if let Some(pos) = positions.iter().find(|p| slave_pos_matches(p, &label)) {
                                let actual_slave_symbol = symbol_id_to_name.get(&pos.symbol_id).map(|s| s.as_str());
                                let symbol_changed = !symbol_matches(&expected_slave_symbol, actual_slave_symbol);
                                if symbol_changed {
                                    tracing::warn!(
                                        slave = %slave_account_id,
                                        ticket,
                                        master_symbol = ?evt.symbol,
                                        expected_slave_symbol = %expected_slave_symbol,
                                        actual_slave_symbol = ?actual_slave_symbol,
                                        position_id = pos.position_id,
                                        "Symbol mismatch (modified): slave position on wrong pair"
                                    );
                                }
                                let expected_side_evt = evt.side.as_deref().map(|s| apply_reverse_side(s, reverse)).unwrap_or_else(|| if pos.trade_side == 1 { "buy".to_string() } else { "sell".to_string() });
                                let expected_is_buy_evt = expected_side_evt.eq_ignore_ascii_case("buy");
                                let side_changed_evt = expected_is_buy_evt != (pos.trade_side == 1);
                                let age_secs_evt = evt.age_seconds.map(|a| a as i64).unwrap_or(i64::MAX);
                                if symbol_changed && !expected_slave_symbol.is_empty() {
                                    let vol_centi = (pos.volume * 100.0).round() as i64;
                                    let reopen_symbol = age_secs_evt <= COPY_INFLIGHT_GRACE_SECS;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                                        position_id: pos.position_id,
                                        volume_centi_lots: vol_centi.max(1),
                                    }).await;
                                    if reopen_symbol {
                                        let vol = evt
                                            .volume
                                            .map(|v| {
                                                resolve_target_volume_by_name(
                                                    v,
                                                    apply_volume(v, &config),
                                                    &expected_slave_symbol,
                                                    &symbol_id_to_name,
                                                    &symbol_min_lots,
                                                    &symbol_max_lots,
                                                )
                                            })
                                            .unwrap_or(pos.volume);
                                        if vol > 0.0 {
                                            let side = evt.side.as_deref().map(|s| apply_reverse_side(s, reverse)).unwrap_or_else(|| if pos.trade_side == 1 { "buy".to_string() } else { "sell".to_string() });
                                            let is_buy = side.eq_ignore_ascii_case("buy");
if copy_tx.send(CopyCommand::OpenMarket {
                                                symbol_name: expected_slave_symbol.clone(),
                                                volume_lots: vol,
                                                is_buy,
                                                comment: label.clone(),
                                                label: label.clone(),
                                                position_id: None,
                                                reply: None,
                                            }).await.is_ok() {
                                                amend_sltp_after_open(&mut copy_tx, &label, sl, tp).await;
                                            }
                                        }
                                    }
                                } else if side_changed_evt {
                                    let vol_centi = (pos.volume * 100.0).round() as i64;
                                    let reopen = age_secs_evt <= COPY_INFLIGHT_GRACE_SECS;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                                        position_id: pos.position_id,
                                        volume_centi_lots: vol_centi.max(1),
                                    }).await;
                                    if reopen && !expected_slave_symbol.is_empty() {
                                        let vol = evt
                                            .volume
                                            .map(|v| {
                                                resolve_target_volume_by_name(
                                                    v,
                                                    apply_volume(v, &config),
                                                    &expected_slave_symbol,
                                                    &symbol_id_to_name,
                                                    &symbol_min_lots,
                                                    &symbol_max_lots,
                                                )
                                            })
                                            .unwrap_or(pos.volume);
                                        if vol > 0.0 {
if copy_tx.send(CopyCommand::OpenMarket {
                                                symbol_name: expected_slave_symbol.clone(),
                                                volume_lots: vol,
                                                is_buy: expected_is_buy_evt,
                                                comment: label.clone(),
                                                label: label.clone(),
                                                position_id: None,
                                                reply: None,
                                            }).await.is_ok() {
                                                amend_sltp_after_open(&mut copy_tx, &label, sl, tp).await;
                                            }
                                        }
                                    }
                                } else {
                                    if let Some(vol) = evt.volume.map(|v| {
                                        resolve_target_volume_by_id(
                                            v,
                                            apply_volume(v, &config),
                                            pos.symbol_id,
                                            &symbol_min_lots,
                                            &symbol_max_lots,
                                        )
                                    }) {
                                        if vol < pos.volume - 0.001 {
                                            let vol_centi = (vol * 100.0).round() as i64;
                                            let close_vol = (pos.volume * 100.0).round() as i64 - vol_centi;
let _ = copy_tx.send(CopyCommand::ClosePosition {
                                                position_id: pos.position_id,
                                                volume_centi_lots: close_vol.max(1),
                                            }).await;
                                        } else if vol > pos.volume + 0.001 {
                                            let skip_age = match evt.age_seconds {
                                                None => true,
                                                Some(age) => age > COPY_MAX_AGE_MARKET_OPEN_SECS,
                                            };
                                            if !skip_age {
                                                let additional_vol = vol - pos.volume;
                                                if !expected_slave_symbol.is_empty() {
                                                    let is_buy = pos.trade_side == 1;
if copy_tx.send(CopyCommand::OpenMarket {
                                                        symbol_name: expected_slave_symbol.clone(),
                                                        volume_lots: additional_vol,
                                                        is_buy,
                                                        comment: label.clone(),
                                                        label: label.clone(),
                                                        position_id: Some(pos.position_id),
                                                        reply: None,
                                                    }).await.is_ok() {}
                                                }
                                            }
                                        }
                                    }
                                    let sl_diff = !price_opt_eq(sl, pos.stop_loss, price_digits);
                                    let tp_diff = !price_opt_eq(tp, pos.take_profit, price_digits);
                                    if sl_diff || tp_diff {
let _ = copy_tx.send(CopyCommand::AmendPositionSLTP {
                                            position_id: pos.position_id,
                                            stop_loss: sl,
                                            take_profit: tp,
                                        }).await;
                                    }
                                }
                            } else if let Some(ord) = orders.iter().find(|o| slave_ord_matches(o, &label)) {
                                let actual_ord_symbol = symbol_id_to_name.get(&ord.symbol_id).map(|s| s.as_str());
                                let symbol_changed = !symbol_matches(&expected_slave_symbol, actual_ord_symbol);
                                if symbol_changed {
                                    tracing::warn!(
                                        slave = %slave_account_id,
                                        ticket,
                                        master_symbol = ?evt.symbol,
                                        expected_slave_symbol = %expected_slave_symbol,
                                        actual_slave_symbol = ?actual_ord_symbol,
                                        order_id = ord.order_id,
                                        "Symbol mismatch (modified): slave order on wrong pair"
                                    );
                                }
                                let expected_side_ord = evt.side.as_deref()
                                    .map(|s| apply_reverse_side(s, reverse))
                                    .unwrap_or_else(|| if ord.trade_side == 1 { "buy".to_string() } else { "sell".to_string() });
                                let expected_is_buy_ord = expected_side_ord.eq_ignore_ascii_case("buy");
                                let new_vol = evt
                                    .volume
                                    .map(|v| {
                                        resolve_target_volume_by_id(
                                            v,
                                            apply_volume(v, &config),
                                            ord.symbol_id,
                                            &symbol_min_lots,
                                            &symbol_max_lots,
                                        )
                                    })
                                    .unwrap_or(ord.volume);
                                let new_price = target_price.or(ord.price);
                                let compare_price = new_price.unwrap_or(ord.price.unwrap_or(0.0));
                                let (sl_sanitized, tp_sanitized) =
                                    sanitize_pending_sltp(compare_price, sl, tp, price_digits, expected_is_buy_ord);
                                let vol_diff = (new_vol - ord.volume).abs() > 0.001;
                                let price_diff = !price_opt_eq(new_price, ord.price, price_digits);
                                let current_sl = normalize_optional_price_for_compare(ord.stop_loss, price_digits);
                                let current_tp = normalize_optional_price_for_compare(ord.take_profit, price_digits);
                                let target_sl = normalize_optional_price_for_compare(sl_sanitized, price_digits);
                                let target_tp = normalize_optional_price_for_compare(tp_sanitized, price_digits);
                                let sl_diff = !price_opt_eq(target_sl, current_sl, price_digits);
                                let tp_diff = !price_opt_eq(target_tp, current_tp, price_digits);
                                let expected_order_type_slave = evt.order_type.as_deref()
                                    .map(|t| apply_reverse_order_type(t, reverse))
                                    .unwrap_or_else(|| order_type_for_amend(ord.order_type).to_string());
                                let side_diff = expected_is_buy_ord != (ord.trade_side == 1);
                                let order_type_diff = !expected_order_type_slave.eq_ignore_ascii_case(order_type_for_amend(ord.order_type));
                                if symbol_changed {
                                    let age_secs_evt = evt
                                        .age_seconds
                                        .map(|a| a as i64)
                                        .unwrap_or(i64::MAX);
                                    let reopen_symbol = age_secs_evt <= COPY_INFLIGHT_GRACE_SECS;
                                    let vol = evt
                                        .volume
                                        .map(|v| {
                                            resolve_target_volume_by_name(
                                                v,
                                                apply_volume(v, &config),
                                                &expected_slave_symbol,
                                                &symbol_id_to_name,
                                                &symbol_min_lots,
                                                &symbol_max_lots,
                                            )
                                        })
                                        .unwrap_or(ord.volume);
                                    let price = target_price.unwrap_or(ord.price.unwrap_or(0.0));
                                    let (sl_send, tp_send) =
                                        sanitize_pending_sltp(price, sl_sanitized, tp_sanitized, price_digits, expected_is_buy_ord);
let _ = copy_tx.send(CopyCommand::CancelOrder { order_id: ord.order_id }).await;
                                    if reopen_symbol && vol > 0.0 && !expected_slave_symbol.is_empty() {
                                        let _ = copy_tx.send(CopyCommand::PlacePendingOrder {
                                            symbol_name: expected_slave_symbol,
                                            volume_lots: vol,
                                            is_buy: expected_is_buy_ord,
                                            order_type: expected_order_type_slave,
                                            price,
                                            stop_loss: sl_send,
                                            take_profit: tp_send,
                                            comment: label.clone(),
                                            label,
                                            reply: None,
                                        }).await;
                                    }
                                } else if side_diff || order_type_diff {
                                    let vol = evt
                                        .volume
                                        .map(|v| {
                                            resolve_target_volume_by_name(
                                                v,
                                                apply_volume(v, &config),
                                                &expected_slave_symbol,
                                                &symbol_id_to_name,
                                                &symbol_min_lots,
                                                &symbol_max_lots,
                                            )
                                        })
                                        .unwrap_or(ord.volume);
                                    let price = target_price.unwrap_or(ord.price.unwrap_or(0.0));
                                    let (sl_send, tp_send) =
                                        sanitize_pending_sltp(price, sl_sanitized, tp_sanitized, price_digits, expected_is_buy_ord);
                                    if vol > 0.0 && !expected_slave_symbol.is_empty() {
let _ = copy_tx.send(CopyCommand::CancelOrder { order_id: ord.order_id }).await;
                                        let _ = copy_tx.send(CopyCommand::PlacePendingOrder {
                                            symbol_name: expected_slave_symbol,
                                            volume_lots: vol,
                                            is_buy: expected_is_buy_ord,
                                            order_type: expected_order_type_slave,
                                            price,
                                            stop_loss: sl_send,
                                            take_profit: tp_send,
                                            comment: label.clone(),
                                            label,
                                            reply: None,
                                        }).await;
                                    }
                                } else if vol_diff || price_diff || sl_diff || tp_diff {
                                    let amend_price = new_price.unwrap_or(ord.price.unwrap_or(0.0));
                                    let (sl_send, tp_send) = sanitize_pending_sltp(
                                        amend_price,
                                        sl_sanitized,
                                        tp_sanitized,
                                        price_digits,
                                        expected_is_buy_ord,
                                    );
let _ = copy_tx.send(CopyCommand::AmendOrder {
                                        symbol_name: Some(expected_slave_symbol.clone()),
                                        order_id: ord.order_id,
                                        order_type: order_type_for_amend(ord.order_type).to_string(),
                                        volume_lots: new_vol,
                                        price: new_price,
                                        stop_loss: sl_send,
                                        take_profit: tp_send,
                                        is_buy: ord.trade_side == 1,
                                    }).await;
                                }
                            }
                        }
                        "closed" => {}
                        _ => {}
                    }
                }
                Err(e) => {
                    tracing::warn!(slave = %slave_account_id, error = %e, "copy TCP read_line failed");
                    break;
                }
            }
        }

        if let Some(s) = &app_state {
            s.slave_tcp_connected_accounts.write().await.remove(&slave_account_id);
        }
        tokio::time::sleep(std::time::Duration::from_secs(COPY_RECONNECT_BACKOFF_SECS)).await;
    }
}

pub fn spawn_copy_trading_manager(
    state_manager: Option<Arc<LocalStateFileManager>>,
    app_state: Option<Arc<AppState>>,
    mut copy_suspend_rx: watch::Receiver<u32>,
    mut copy_manager_trigger_rx: mpsc::Receiver<()>,
) {
    let Some(mgr) = state_manager else { return };
    let Some(app) = app_state else { return };
    let mgr_clone = mgr.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(COPY_MANAGER_POLL_SECS));
        interval.tick().await;
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = copy_manager_trigger_rx.recv() => {}
                _ = copy_suspend_rx.changed() => {
                    let mut h = app_clone.slave_tcp_handles.write().await;
                    for (_id, handle) in h.drain() {
                        handle.abort();
                    }
                    app_clone.slave_tcp_connected_accounts.write().await.clear();
                    continue;
                }
            }
            {
                    let (slave_ids, _slaves_without_url): (Vec<String>, Vec<String>) = mgr_clone
                        .read(|s| {
                            let mut with_url = Vec::new();
                            let mut disabled_or_no_url = Vec::new();
                            for (id, a) in s.accounts.iter() {
                                if a.platform != "ctrader"
                                    || !a.role.as_deref().map(|r| r.eq_ignore_ascii_case("slave")).unwrap_or(false)
                                {
                                    continue;
                                }
                                let has_url = a.master_tcp_url.as_ref().map(|u| !u.trim().is_empty()).unwrap_or(false);
                                if has_url {
                                    with_url.push(id.clone());
                                } else {
                                    disabled_or_no_url.push(id.clone());
                                }
                            }
                            (with_url, disabled_or_no_url)
                        })
                        .await;

                    let slave_ids: Vec<String> = {
                        let tcp = app_clone.tcp_enabled.read().await;
                        slave_ids
                            .into_iter()
                            .filter(|id| *tcp.get(id).unwrap_or(&true))
                            .collect()
                    };

                    let slave_ids: Vec<String> = {
                        let connected = app_clone.ctrader_connected_accounts.read().await.clone();
                        slave_ids
                            .into_iter()
                            .filter(|id| connected.contains(id))
                            .collect()
                    };

                    let mut h = app_clone.slave_tcp_handles.write().await;
                    for slave_account_id in slave_ids {
                        if h.contains_key(&slave_account_id) {
                            continue;
                        }
                        drop(h);

                        let state_mgr = mgr_clone.clone();
                        let app_s = Some(app_clone.clone());
                        let key_for_insert = slave_account_id.clone();
                        let key_for_remove = slave_account_id.clone();
                        let app_for_cleanup = app_clone.clone();
                        let handle = tokio::spawn(async move {
                            run_slave_tcp_client(slave_account_id, state_mgr, app_s).await;
                            app_for_cleanup.slave_tcp_handles.write().await.remove(&key_for_remove);
                        });
                        app_clone.slave_tcp_handles.write().await.insert(key_for_insert, handle);

                        h = app_clone.slave_tcp_handles.write().await;
                    }
                }
        }
    });
}