
use crate::app_state::{self, AppState};
use crate::config::Config;
use crate::routes::HeartbeatRegistry;
use crate::services;
use crate::state;
use crate::timings;
use crate::util;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub async fn setup_tcp(
    config: &Config,
    tcp_listening_port: &app_state::TcpListeningPort,
) -> (
    Option<Arc<services::tcp_bridge::TcpServer>>,
    Option<tokio::net::TcpListener>,
    Option<u16>,
) {
    let tcp_addr = std::net::SocketAddr::from(([0, 0, 0, 0], config.tcp_port));
    match services::tcp_bridge::TcpServer::bind(tcp_addr).await {
        Ok((server, listener, port)) => {
            *tcp_listening_port.write().await = Some(port);
            (Some(server), Some(listener), Some(port))
        }
        Err(e) => {
            tracing::error!(error = %e, "TcpServer bind failed");
            (None, None, None)
        }
    }
}

pub fn build_app_state(
    config: Config,
    auth_state: crate::middleware::AuthState,
    state_manager: Option<Arc<state::LocalStateFileManager>>,
    http_client: reqwest::Client,
    heartbeat_registry: HeartbeatRegistry,
    linking_platform: app_state::LinkingPlatform,
    tcp_listening_port: app_state::TcpListeningPort,
    tcp_server: Option<Arc<services::tcp_bridge::TcpServer>>,
    shutdown_trigger_tx: app_state::ShutdownTriggerTx,
) -> (AppState, tokio::sync::mpsc::Receiver<()>, tokio::sync::watch::Receiver<u32>, tokio::sync::watch::Receiver<u32>, tokio::sync::mpsc::Receiver<()>) {
    let ctrader_running_accounts: app_state::CtraderRunningAccounts =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    let ctrader_account_claimed: app_state::CtraderAccountClaimed =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    let ctrader_running_since: app_state::CtraderRunningSince =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let ctrader_connected_accounts: app_state::CtraderConnectedAccounts =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    let slave_tcp_connected_accounts: app_state::SlaveTcpConnectedAccounts =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    let copy_command_tx: app_state::CopyCommandTxMap =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let (ctrader_trigger_connect_tx, ctrader_trigger_connect_rx) = tokio::sync::mpsc::channel(4);
    let (ctrader_disconnect_tx, ctrader_disconnect_rx) = tokio::sync::watch::channel(0u32);
    let ctrader_trigger_connect_tx_cell: app_state::CtraderTriggerConnectTx =
        Arc::new(tokio::sync::RwLock::new(Some(ctrader_trigger_connect_tx)));
    let ctrader_disconnect_tx_cell: app_state::CtraderDisconnectTx =
        Arc::new(tokio::sync::RwLock::new(Some(ctrader_disconnect_tx)));
    let ctrader_manager_handle: app_state::CtraderManagerHandle =
        Arc::new(tokio::sync::RwLock::new(None));
    let ctrader_account_handles: app_state::CtraderAccountHandles =
        Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let reconnect_requested_account_id: app_state::ReconnectRequestedAccountId =
        Arc::new(tokio::sync::RwLock::new(None));
    let conversion_ui_online_accounts: app_state::ConversionUiOnlineAccounts =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    let deleting_all_accounts: app_state::DeletingAllAccounts =
        Arc::new(tokio::sync::RwLock::new(false));
    let tcp_enabled: app_state::TcpEnabledByAccount =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let (copy_suspend_tx, copy_suspend_rx) = tokio::sync::watch::channel(0u32);
    let copy_suspend_tx_cell: app_state::CopySuspendTx =
        Arc::new(tokio::sync::RwLock::new(Some(copy_suspend_tx)));
    let (copy_manager_trigger_tx, copy_manager_trigger_rx) = tokio::sync::mpsc::channel(8);
    let copy_manager_trigger_tx_cell: app_state::CopyManagerTriggerTx =
        Arc::new(tokio::sync::RwLock::new(Some(copy_manager_trigger_tx)));
    let slave_tcp_handles: app_state::SlaveTcpHandles =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let account_info_cache: app_state::AccountInfoCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let ctrader_realtime_stats_cache: app_state::CtraderRealtimeStatsCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let position_pnl_cache: app_state::PositionPnlCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let ctrader_snapshot_cache: app_state::CtraderSnapshotCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let mt_realtime_stats_cache: app_state::MtRealtimeStatsCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let mt_snapshot_cache: app_state::MtSnapshotCache =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let mt_reader_handles: app_state::MtReaderHandles =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let orders_ws_subscribers = app_state::OrdersWsSubscribers::new();
    let open_orders_ws_subscribers = app_state::OrdersWsSubscribers::new();
    let (orders_ws_notify_tx, _) = tokio::sync::broadcast::channel(16);
    let history_store = services::history::HistoryStore::with_default_path().map(Arc::new);
    let ctrader_symbols_cache = services::history::CtraderSymbolsCache::new();
    let app_state = AppState {
        config: config.clone(),
        auth_state: auth_state.clone(),
        state_manager: state_manager.clone(),
        http_client: http_client.clone(),
        heartbeat_registry,
        linking_platform: linking_platform.clone(),
        tcp_listening_port: tcp_listening_port.clone(),
        tcp_server: tcp_server.clone(),
        ctrader_running_accounts: ctrader_running_accounts.clone(),
        ctrader_account_claimed: ctrader_account_claimed.clone(),
        ctrader_running_since: ctrader_running_since.clone(),
        ctrader_connected_accounts: ctrader_connected_accounts.clone(),
        slave_tcp_connected_accounts: slave_tcp_connected_accounts.clone(),
        copy_command_tx: copy_command_tx.clone(),
        ctrader_trigger_connect_tx: ctrader_trigger_connect_tx_cell,
        ctrader_disconnect_tx: ctrader_disconnect_tx_cell,
        ctrader_manager_handle,
        ctrader_account_handles,
        reconnect_requested_account_id,
        conversion_ui_online_accounts,
        deleting_all_accounts,
        shutdown_trigger_tx,
        tcp_enabled,
        copy_suspend_tx: copy_suspend_tx_cell,
        copy_manager_trigger_tx: copy_manager_trigger_tx_cell,
        slave_tcp_handles,
        account_info_cache,
        position_pnl_cache,
        ctrader_realtime_stats_cache,
        ctrader_snapshot_cache,
        mt_realtime_stats_cache,
        mt_snapshot_cache,
        mt_reader_handles,
        orders_ws_subscribers,
        open_orders_ws_subscribers,
        orders_ws_notify_tx,
        history_store,
        ctrader_symbols_cache,
    };

    (app_state, ctrader_trigger_connect_rx, ctrader_disconnect_rx, copy_suspend_rx, copy_manager_trigger_rx)
}

pub async fn start_ctrader_and_copy_trading(
    app_state: &AppState,
    ctrader_trigger_connect_rx: tokio::sync::mpsc::Receiver<()>,
    ctrader_disconnect_rx: tokio::sync::watch::Receiver<u32>,
    copy_suspend_rx: tokio::sync::watch::Receiver<u32>,
    copy_manager_trigger_rx: tokio::sync::mpsc::Receiver<()>,
) {
    services::ctrader_connection::spawn_ctrader_ws_manager(
        app_state.ctrader_running_accounts.clone(),
        app_state.state_manager.clone(),
        app_state.tcp_server.clone(),
        Some(Arc::new(app_state.clone())),
        Some(ctrader_trigger_connect_rx),
        ctrader_disconnect_rx,
    );

    services::copy_trading::spawn_copy_trading_manager(
        app_state.state_manager.clone(),
        Some(Arc::new(app_state.clone())),
        copy_suspend_rx,
        copy_manager_trigger_rx,
    );
}

pub async fn run_tcp_backfill(app_state: &AppState) {
    tokio::time::sleep(std::time::Duration::from_secs(timings::BACKFILL_INITIAL_DELAY_SECS)).await;
    let Some(ref mgr) = app_state.state_manager else { return };
    let tcp_port = app_state
        .tcp_listening_port
        .read()
        .await
        .unwrap_or_else(|| util::tcp_port_from_base_url(&app_state.config.tcp_base_url).unwrap_or(18080));
    let host = util::tcp_host_for_accounts();
    let _ = mgr
        .update(|snap| {
            for (account_id, entry) in snap.accounts.iter_mut() {
                if entry.platform.eq_ignore_ascii_case("ctrader") && entry.role.as_deref() == Some("master") {
                    entry.tcp_url = Some(format!("tcp://{}:{}/{}", host, tcp_port, account_id));
                }
                if let Some(ref url) = entry.master_tcp_url {
                    let same_port = url.contains(&format!(":{}", tcp_port));
                    if same_port {
                        let path = url.split('/').next_back().unwrap_or("");
                        entry.master_tcp_url = Some(format!("tcp://{}:{}/{}", host, tcp_port, path));
                    }
                }
            }
            crate::state::recalc_slaves_master_tcp_urls(snap);
        })
        .await;
}
