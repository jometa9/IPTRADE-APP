
use crate::config::Config;
use crate::middleware::AuthState;
use crate::routes::HeartbeatRegistry;
use crate::services::account_history::{AccountInfoDto, TcpSnapshotMessage};
use crate::services::copy_command::CopyCommand;
use crate::services::history::{CtraderSymbolsCache, HistoryStore};
use crate::services::tcp_bridge::TcpServer;
use crate::state::LocalStateFileManager;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::{broadcast, mpsc, watch, RwLock};

pub type LinkingPlatform = Arc<Mutex<Option<String>>>;

pub type TcpListeningPort = Arc<RwLock<Option<u16>>>;

pub type CtraderRunningAccounts = Arc<RwLock<HashSet<String>>>;
pub type CtraderAccountClaimed = Arc<RwLock<HashSet<String>>>;

pub type CtraderRunningSince = Arc<RwLock<HashMap<String, u64>>>;

pub type CtraderConnectedAccounts = Arc<RwLock<HashSet<String>>>;

pub type SlaveTcpConnectedAccounts = Arc<RwLock<HashSet<String>>>;

pub type CopyCommandTxMap = Arc<RwLock<HashMap<String, mpsc::Sender<CopyCommand>>>>;

pub type CtraderTriggerConnectTx = Arc<RwLock<Option<mpsc::Sender<()>>>>;

pub type CtraderDisconnectTx = Arc<RwLock<Option<watch::Sender<u32>>>>;

pub type CtraderManagerHandle = Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>;

pub type CtraderAccountHandles = Arc<RwLock<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>>;

pub type ReconnectRequestedAccountId = Arc<RwLock<Option<String>>>;

pub type ConversionUiOnlineAccounts = Arc<RwLock<HashSet<String>>>;

pub type DeletingAllAccounts = Arc<RwLock<bool>>;

pub type TcpEnabledByAccount = Arc<RwLock<HashMap<String, bool>>>;

pub type AccountInfoCache = Arc<RwLock<HashMap<String, AccountInfoDto>>>;
pub type PositionPnlCache = Arc<RwLock<HashMap<String, std::collections::HashMap<i64, f64>>>>;
pub type CtraderSnapshotCache = Arc<RwLock<HashMap<String, TcpSnapshotMessage>>>;
pub type CtraderRealtimeStatsCache = Arc<RwLock<HashMap<String, CtraderRealtimeStats>>>;
pub type MtRealtimeStatsCache = Arc<RwLock<HashMap<String, CtraderRealtimeStats>>>;
pub type MtSnapshotCache = Arc<RwLock<HashMap<String, TcpSnapshotMessage>>>;
pub type MtReaderHandles = Arc<RwLock<HashMap<String, tokio::task::JoinHandle<()>>>>;

pub type CopySuspendTx = Arc<RwLock<Option<watch::Sender<u32>>>>;

pub type CopyManagerTriggerTx = Arc<RwLock<Option<mpsc::Sender<()>>>>;

pub type SlaveTcpHandles = Arc<RwLock<HashMap<String, tokio::task::JoinHandle<()>>>>;

pub type ShutdownTriggerTx = Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>;

pub type OrdersWsNotifyTx = broadcast::Sender<()>;

pub struct OrdersWsSubscribers {
    senders: Arc<RwLock<Vec<tokio::sync::mpsc::UnboundedSender<String>>>>,
}

impl OrdersWsSubscribers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            senders: Arc::new(RwLock::new(Vec::new())),
        })
    }

    pub async fn add_subscriber(self: &Arc<Self>) -> (tokio::sync::mpsc::UnboundedReceiver<String>, bool) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let is_first = {
            let mut s = self.senders.write().await;
            s.push(tx);
            s.len() == 1
        };
        (rx, is_first)
    }

    pub async fn broadcast(&self, json: String) -> bool {
        let mut senders = self.senders.write().await;
        senders.retain(|tx| tx.send(json.clone()).is_ok());
        !senders.is_empty()
    }
}

#[derive(Clone, Debug, Default)]
pub struct CtraderRealtimeStats {
    pub open_positions: u32,
    pub pending_orders: u32,
    pub balance: Option<f64>,
    pub unrealized_pnl: Option<f64>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub auth_state: AuthState,
    pub state_manager: Option<Arc<LocalStateFileManager>>,
    pub http_client: reqwest::Client,
    pub heartbeat_registry: HeartbeatRegistry,
    pub linking_platform: LinkingPlatform,
    pub tcp_listening_port: TcpListeningPort,
    pub tcp_server: Option<Arc<TcpServer>>,
    pub ctrader_running_accounts: CtraderRunningAccounts,
    pub ctrader_account_claimed: CtraderAccountClaimed,
    pub ctrader_running_since: CtraderRunningSince,
    pub ctrader_connected_accounts: CtraderConnectedAccounts,
    pub slave_tcp_connected_accounts: SlaveTcpConnectedAccounts,
    pub copy_command_tx: CopyCommandTxMap,
    pub ctrader_trigger_connect_tx: CtraderTriggerConnectTx,
    pub ctrader_disconnect_tx: CtraderDisconnectTx,
    pub ctrader_manager_handle: CtraderManagerHandle,
    pub ctrader_account_handles: CtraderAccountHandles,
    pub reconnect_requested_account_id: ReconnectRequestedAccountId,
    pub conversion_ui_online_accounts: ConversionUiOnlineAccounts,
    pub deleting_all_accounts: DeletingAllAccounts,
    pub shutdown_trigger_tx: ShutdownTriggerTx,
    pub tcp_enabled: TcpEnabledByAccount,
    pub copy_suspend_tx: CopySuspendTx,
    pub copy_manager_trigger_tx: CopyManagerTriggerTx,
    pub slave_tcp_handles: SlaveTcpHandles,
    pub account_info_cache: AccountInfoCache,
    pub position_pnl_cache: PositionPnlCache,
    pub ctrader_realtime_stats_cache: CtraderRealtimeStatsCache,
    pub ctrader_snapshot_cache: CtraderSnapshotCache,
    pub mt_realtime_stats_cache: MtRealtimeStatsCache,
    pub mt_snapshot_cache: MtSnapshotCache,
    pub mt_reader_handles: MtReaderHandles,
    pub orders_ws_subscribers: Arc<OrdersWsSubscribers>,
    pub open_orders_ws_subscribers: Arc<OrdersWsSubscribers>,
    pub orders_ws_notify_tx: OrdersWsNotifyTx,
    pub history_store: Option<Arc<HistoryStore>>,
    pub ctrader_symbols_cache: Arc<CtraderSymbolsCache>,
}
