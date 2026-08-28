
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, RwLock};
#[derive(serde::Deserialize)]
struct AuthMessage {
    #[serde(alias = "account_id")]
    account_id: Option<String>,
}

type Sessions = Arc<RwLock<HashMap<String, Vec<mpsc::UnboundedSender<String>>>>>;

pub type TcpEnabledRef = Option<Arc<RwLock<std::collections::HashMap<String, bool>>>>;

// Latest REAL master snapshot cache (mt_snapshot_cache / ctrader_snapshot_cache),
// replayed to a slave on connect so it syncs without waiting a full snapshot interval.
pub type SnapshotCacheRef =
    Option<Arc<RwLock<std::collections::HashMap<String, crate::services::account_history::TcpSnapshotMessage>>>>;

pub struct TcpServer {
    sessions: Sessions,
    tcp_enabled: Arc<RwLock<TcpEnabledRef>>,
    mt_snapshot_cache: Arc<RwLock<SnapshotCacheRef>>,
    ctrader_snapshot_cache: Arc<RwLock<SnapshotCacheRef>>,
    shutdown_tx: broadcast::Sender<()>,
}

impl TcpServer {
    pub async fn bind(addr: std::net::SocketAddr) -> Result<(Arc<Self>, TcpListener, u16), std::io::Error> {
        let listener = TcpListener::bind(addr).await?;
        let actual_port = listener.local_addr()?.port();
        let (shutdown_tx, _) = broadcast::channel(1);
        let server = Arc::new(Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            tcp_enabled: Arc::new(RwLock::new(None)),
            mt_snapshot_cache: Arc::new(RwLock::new(None)),
            ctrader_snapshot_cache: Arc::new(RwLock::new(None)),
            shutdown_tx,
        });
        Ok((server, listener, actual_port))
    }

    pub async fn set_tcp_enabled_map(&self, map: TcpEnabledRef) {
        let mut g = self.tcp_enabled.write().await;
        *g = map;
    }

    pub async fn set_snapshot_caches(&self, mt: SnapshotCacheRef, ctrader: SnapshotCacheRef) {
        *self.mt_snapshot_cache.write().await = mt;
        *self.ctrader_snapshot_cache.write().await = ctrader;
    }

    // Latest cached snapshot line for a master account (MT5 cache first, then cTrader).
    async fn latest_master_snapshot_line(&self, account_id: &str) -> Option<String> {
        if let Some(ref map) = *self.mt_snapshot_cache.read().await {
            if let Some(msg) = map.read().await.get(account_id) {
                if let Ok(line) = msg.to_json_line() {
                    return Some(line);
                }
            }
        }
        if let Some(ref map) = *self.ctrader_snapshot_cache.read().await {
            if let Some(msg) = map.read().await.get(account_id) {
                if let Ok(line) = msg.to_json_line() {
                    return Some(line);
                }
            }
        }
        None
    }

    async fn is_tcp_enabled(&self, account_id: &str) -> bool {
        let guard = self.tcp_enabled.read().await;
        let Some(ref map) = *guard else {
            return true;
        };
        let map = map.read().await;
        *map.get(account_id).unwrap_or(&true)
    }

    pub async fn run_until(
        self: Arc<Self>,
        listener: TcpListener,
        mut shutdown: tokio::sync::oneshot::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                _ = &mut shutdown => {
                    break;
                }
                result = listener.accept() => {
                    match result {
                        Ok((stream, _)) => {
                            let server = self.clone();
                            tokio::spawn(async move {
                                let _ = server.handle_connection(stream).await;
                            });
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "tcp listener accept failed");
                        }
                    }
                }
            }
        }
    }

    pub async fn close_all_sessions(&self) {
        let _ = self.shutdown_tx.send(());
        let mut sessions = self.sessions.write().await;
        sessions.clear();
        drop(sessions);
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        let mut first_line = String::new();
        let n = reader.read_line(&mut first_line).await?;
        if n == 0 {
            return Ok(());
        }
        let first_line = first_line.trim();

        let account_id: String = if first_line.starts_with('{') {
            let msg: AuthMessage = serde_json::from_str(first_line).map_err(|e| format!("invalid JSON: {}", e))?;
            msg.account_id.ok_or("missing account_id in JSON")?.trim().to_string()
        } else {
            first_line.to_string()
        };

        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            let err = r#"{"status":"error","message":"account_id required"}"#;
            write_half.write_all(err.as_bytes()).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await?;
            return Ok(());
        }

        let response = format!(r#"{{"status":"connected","account_id":"{}"}}"#, account_id);
        write_half.write_all(response.as_bytes()).await?;
        write_half.write_all(b"\n").await?;
        write_half.flush().await?;

        // Replay the latest real master snapshot on connect so the slave syncs at once.
        if self.is_tcp_enabled(&account_id).await {
            if let Some(line) = self.latest_master_snapshot_line(&account_id).await {
                let line = if line.ends_with('\n') { line } else { format!("{}\n", line) };
                let _ = write_half.write_all(line.as_bytes()).await;
                let _ = write_half.flush().await;
            }
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut sessions = self.sessions.write().await;
            sessions.entry(account_id.clone()).or_default().push(tx.clone());
        }

        let mut shutdown_rx = self.shutdown_tx.subscribe();
        let mut dead = false;
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(line) => {
                            let full = if line.ends_with('\n') { line } else { format!("{}\n", line) };
                            if write_half.write_all(full.as_bytes()).await.is_err() {
                                dead = true;
                                break;
                            }
                            if write_half.flush().await.is_err() {
                                dead = true;
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = shutdown_rx.recv() => break,
            }
        }
        if dead {
            drop(rx);
        }

        {
            let mut sessions = self.sessions.write().await;
            if let Some(list) = sessions.get_mut(&account_id) {
                list.retain(|tx| !tx.is_closed());
                if list.is_empty() {
                    sessions.remove(&account_id);
                }
            }
        }
        Ok(())
    }

    pub async fn broadcast(&self, account_id: &str, json_line: &str) {
        let account_id = account_id.trim();
        if !self.is_tcp_enabled(account_id).await {
            return;
        }
        let list = {
            let sessions = self.sessions.read().await;
            sessions.get(account_id).cloned()
        };
        if let Some(senders) = list {
            if senders.is_empty() {
                return;
            }
            let line = if json_line.ends_with('\n') {
                json_line.to_string()
            } else {
                format!("{}\n", json_line)
            };
            let mut to_remove = Vec::new();
            for (i, tx) in senders.iter().enumerate() {
                if tx.send(line.clone()).is_err() {
                    to_remove.push(i);
                }
            }
            if !to_remove.is_empty() {
                let mut sessions = self.sessions.write().await;
                if let Some(list) = sessions.get_mut(account_id) {
                    for i in to_remove.into_iter().rev() {
                        list.remove(i);
                    }
                    if list.is_empty() {
                        sessions.remove(account_id);
                    }
                }
            }
        }
    }

}
