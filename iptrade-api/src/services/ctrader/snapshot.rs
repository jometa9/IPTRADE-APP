use crate::app_state::AppState;
use crate::services::account_history::{
    AccountInfoDto, TcpOpenPositionDto, TcpPendingOrderDto, TcpSnapshotMessage,
};
use crate::services::proto_oa::{MasterOrderRow, MasterPositionRow};
use crate::services::tcp_bridge::TcpServer;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};

// Snapshot ordering for cTrader masters built in this process: `session` is fixed per
// process run (a restart changes it -> slaves reset) and `seq` is a global monotonic
// counter. The slave keeps the last (session, seq) it applied and ignores anything older.
static SNAP_SEQ: AtomicI64 = AtomicI64::new(0);
static SNAP_SESSION: OnceLock<i64> = OnceLock::new();

fn snapshot_session() -> i64 {
    *SNAP_SESSION.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(1)
    })
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn age_seconds_from_ms(server_now_ms: i64, open_timestamp_ms: i64) -> u64 {
    if open_timestamp_ms <= 0 {
        return 0;
    }
    ((server_now_ms - open_timestamp_ms).max(0) / 1000) as u64
}

pub(crate) fn build_tcp_snapshot_message(
    positions: &HashMap<i64, MasterPositionRow>,
    orders: &HashMap<i64, MasterOrderRow>,
    event: &str,
    pos_id_to_ord_id: &HashMap<i64, i64>,
    mut account: AccountInfoDto,
    pnl_map: Option<&HashMap<i64, f64>>,
    server_now_ms: i64,
) -> TcpSnapshotMessage {
    if let Some(map) = pnl_map {
        account.unrealized_pnl = Some(round2(map.values().sum()));
    }
    let mut open_positions: Vec<TcpOpenPositionDto> = positions
        .values()
        .map(|p| TcpOpenPositionDto {
            ticket: pos_id_to_ord_id.get(&p.position_id).copied().unwrap_or(p.position_id),
            symbol: p.symbol.clone(),
            r#type: "market".to_string(),
            side: p.side.clone(),
            volume: p.volume,
            open_price: p.price,
            sl: p.sl,
            tp: p.tp,
            age_seconds: age_seconds_from_ms(server_now_ms, p.open_timestamp_ms),
            profit: pnl_map
                .and_then(|m| m.get(&p.position_id).copied())
                .unwrap_or(0.0),
        })
        .collect();
    open_positions.sort_by(|a, b| a.ticket.cmp(&b.ticket));
    let mut pending_orders: Vec<TcpPendingOrderDto> = orders
        .values()
        .map(|o| TcpPendingOrderDto {
            ticket: o.order_id,
            symbol: o.symbol.clone(),
            r#type: o.order_type.clone(),
            side: o.side.clone(),
            volume: o.volume,
            price: o.price.unwrap_or(0.0),
            sl: o.sl,
            tp: o.tp,
            age_seconds: 0,
            magic: None,
        })
        .collect();
    pending_orders.sort_by_key(|o| o.ticket);
    TcpSnapshotMessage {
        event: event.to_string(),
        session: snapshot_session(),
        seq: SNAP_SEQ.fetch_add(1, Ordering::Relaxed) + 1,
        account,
        open_positions,
        pending_orders,
    }
}

fn local_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub(crate) async fn emit_master_snapshot_tcp(
    account_id: &str,
    last_positions: &HashMap<i64, MasterPositionRow>,
    last_orders: &HashMap<i64, MasterOrderRow>,
    app_state: Option<&Arc<AppState>>,
    tcp_server: Option<&Arc<TcpServer>>,
    pos_id_to_ord_id: &HashMap<i64, i64>,
    server_clock_offset_ms: i64,
) {
    let server_now_ms = local_now_ms() + server_clock_offset_ms;
    let account = match app_state {
        Some(s) => s
            .account_info_cache
            .read()
            .await
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| AccountInfoDto {
                account_id: account_id.to_string(),
                ..Default::default()
            }),
        None => AccountInfoDto {
            account_id: account_id.to_string(),
            ..Default::default()
        },
    };
    let pnl_map = match app_state {
        Some(s) => s.position_pnl_cache.read().await.get(account_id).cloned(),
        None => None,
    };
    let snapshot = build_tcp_snapshot_message(
        last_positions,
        last_orders,
        "snapshot",
        pos_id_to_ord_id,
        account,
        pnl_map.as_ref(),
        server_now_ms,
    );
    let line = match snapshot.to_json_line() {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(account_id = %account_id, error = %e, "snapshot to_json_line failed");
            return;
        }
    };
    // Broadcast live and cache it; caller gates on ctrader_reconcile_received so only
    // real snapshots reach this cache, which the TCP bridge replays to a slave on connect.
    if let Some(state) = app_state {
        state
            .ctrader_snapshot_cache
            .write()
            .await
            .insert(account_id.to_string(), snapshot);
        let _ = state.orders_ws_notify_tx.send(());
    }
    if let Some(tcp) = tcp_server {
        tcp.broadcast(account_id, &line).await;
    }
}

pub(crate) async fn update_ctrader_snapshot_cache(
    account_id: &str,
    positions: &HashMap<i64, MasterPositionRow>,
    orders: &HashMap<i64, MasterOrderRow>,
    pos_id_to_ord_id: &HashMap<i64, i64>,
    app_state: Option<&Arc<AppState>>,
    server_clock_offset_ms: i64,
) {
    let server_now_ms = local_now_ms() + server_clock_offset_ms;
    if let Some(state) = app_state {
        let account = state
            .account_info_cache
            .read()
            .await
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| AccountInfoDto {
                account_id: account_id.to_string(),
                ..Default::default()
            });
        if positions.is_empty() {
            if account.unrealized_pnl.map(|p| p.abs() > 1e-9).unwrap_or(false) {
                return;
            }
        }
        let pnl_map = state.position_pnl_cache.read().await.get(account_id).cloned();
        let snapshot = build_tcp_snapshot_message(
            positions,
            orders,
            "snapshot",
            pos_id_to_ord_id,
            account,
            pnl_map.as_ref(),
            server_now_ms,
        );
        state
            .ctrader_snapshot_cache
            .write()
            .await
            .insert(account_id.to_string(), snapshot);
        let _ = state.orders_ws_notify_tx.send(());
    }
}
