use super::model::{HistoryAccountFile, HistoryDeal, HistoryIndex, HistoryIndexEntry};
use crate::state::resolve_state_file_path;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};

pub fn default_history_dir() -> Option<PathBuf> {
    resolve_state_file_path().and_then(|p| p.parent().map(|d| d.join("history")))
}

pub struct HistoryStore {
    base_dir: PathBuf,
    index: RwLock<HistoryIndex>,
    index_write_lock: Mutex<()>,
    account_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    sync_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

pub struct MergeOutcome {
    pub added: usize,
    pub updated: usize,
}

impl HistoryStore {
    pub fn new(base_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&base_dir);
        let index_path = base_dir.join("index.json");
        let initial = std::fs::read(&index_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HistoryIndex>(&bytes).ok())
            .unwrap_or_default();
        Self {
            base_dir,
            index: RwLock::new(initial),
            index_write_lock: Mutex::new(()),
            account_locks: Mutex::new(HashMap::new()),
            sync_locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_default_path() -> Option<Self> {
        default_history_dir().map(Self::new)
    }

    fn index_path(&self) -> PathBuf {
        self.base_dir.join("index.json")
    }

    fn account_path(&self, account_id: &str) -> PathBuf {
        let safe = sanitize_filename(account_id);
        self.base_dir.join(format!("{safe}.json"))
    }

    async fn lock_for_account(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.account_locks.lock().await;
        map.entry(account_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn sync_lock_for_account(&self, account_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.sync_locks.lock().await;
        map.entry(account_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn load_index(&self) -> HistoryIndex {
        self.index.read().await.clone()
    }

    pub async fn load_index_entry(&self, account_id: &str) -> HistoryIndexEntry {
        self.index
            .read()
            .await
            .accounts
            .get(account_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn persist_index_locked(&self, snapshot: &HistoryIndex) {
        let _g = self.index_write_lock.lock().await;
        let bytes = match serde_json::to_vec_pretty(snapshot) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "history index serialize failed");
                return;
            }
        };
        write_atomic(&self.index_path(), &bytes).await;
    }

    pub async fn load_account(&self, account_id: &str) -> HistoryAccountFile {
        let lock = self.lock_for_account(account_id).await;
        let _g = lock.lock().await;
        match fs::read(self.account_path(account_id)).await {
            Ok(data) => serde_json::from_slice(&data).unwrap_or_else(|_| HistoryAccountFile {
                account_id: account_id.to_string(),
                deals: Vec::new(),
            }),
            Err(_) => HistoryAccountFile {
                account_id: account_id.to_string(),
                deals: Vec::new(),
            },
        }
    }

    pub async fn save_account(&self, file: &HistoryAccountFile) {
        let lock = self.lock_for_account(&file.account_id).await;
        let _g = lock.lock().await;
        let bytes = match serde_json::to_vec(file) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "history account serialize failed");
                return;
            }
        };
        write_atomic(&self.account_path(&file.account_id), &bytes).await;
    }

    pub async fn merge_deals(
        &self,
        account_id: &str,
        mut new_deals: Vec<HistoryDeal>,
    ) -> MergeOutcome {
        if new_deals.is_empty() {
            return MergeOutcome { added: 0, updated: 0 };
        }
        let mut file = self.load_account(account_id).await;
        let mut by_id: BTreeMap<String, HistoryDeal> = BTreeMap::new();
        for d in file.deals.drain(..) {
            by_id.insert(d.deal_id.clone(), d);
        }
        let mut added = 0usize;
        let mut updated = 0usize;
        for d in new_deals.drain(..) {
            match by_id.get(&d.deal_id) {
                Some(existing) if existing == &d => {}
                Some(_) => {
                    updated += 1;
                    by_id.insert(d.deal_id.clone(), d);
                }
                None => {
                    added += 1;
                    by_id.insert(d.deal_id.clone(), d);
                }
            }
        }
        if added == 0 && updated == 0 {
            return MergeOutcome { added: 0, updated: 0 };
        }
        let mut deals: Vec<HistoryDeal> = by_id.into_values().collect();
        deals.sort_by_key(|d| d.close_time_ms.max(d.open_time_ms));
        file.deals = deals;
        self.save_account(&file).await;
        MergeOutcome { added, updated }
    }

    pub async fn mutate_index_entry<F>(&self, account_id: &str, f: F)
    where
        F: FnOnce(HistoryIndexEntry) -> HistoryIndexEntry,
    {
        let snapshot = {
            let mut g = self.index.write().await;
            let prev = g.accounts.get(account_id).cloned().unwrap_or_default();
            let next = f(prev.clone());
            if next == prev {
                return;
            }
            g.accounts.insert(account_id.to_string(), next);
            g.clone()
        };
        self.persist_index_locked(&snapshot).await;
    }

    pub async fn delete_account(&self, account_id: &str) {
        let lock = self.lock_for_account(account_id).await;
        let _g = lock.lock().await;
        let _ = fs::remove_file(self.account_path(account_id)).await;
        drop(_g);
        let snapshot = {
            let mut g = self.index.write().await;
            if g.accounts.remove(account_id).is_none() {
                return;
            }
            g.clone()
        };
        self.persist_index_locked(&snapshot).await;
    }

    pub async fn purge_all(&self) {
        let _g = self.index_write_lock.lock().await;
        if let Ok(mut entries) = fs::read_dir(&self.base_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                if path.is_file() {
                    let _ = fs::remove_file(&path).await;
                }
            }
        }
        *self.index.write().await = HistoryIndex::default();
        self.account_locks.lock().await.clear();
        self.sync_locks.lock().await.clear();
    }
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

async fn write_atomic(path: &PathBuf, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    let tmp = path.with_extension("tmp");
    match fs::File::create(&tmp).await {
        Ok(mut f) => {
            if f.write_all(bytes).await.is_err() || f.sync_all().await.is_err() {
                tracing::warn!(path = %tmp.display(), "history write_atomic: write failed");
                let _ = fs::remove_file(&tmp).await;
                return;
            }
        }
        Err(e) => {
            tracing::warn!(path = %tmp.display(), error = %e, "history write_atomic: create failed");
            return;
        }
    }
    if let Err(e) = fs::rename(&tmp, path).await {
        tracing::warn!(from = %tmp.display(), to = %path.display(), error = %e, "history write_atomic: rename failed");
        let _ = fs::remove_file(&tmp).await;
    }
}
