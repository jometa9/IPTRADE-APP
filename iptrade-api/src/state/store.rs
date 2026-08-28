
use super::{AccountEntry, AppPreferences, CtraderAppCredentials};
use super::encrypt::{decrypt, encrypt, EncryptedPayload};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
const SNAPSHOT_VERSION: u32 = 4;

const LEGACY_STATE_SECRET: &str = "iptrade-default-secret-change-in-production";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LocalStateSnapshot {
    pub version: u32,
    pub accounts: HashMap<String, AccountEntry>,
    #[serde(default)]
    pub preferences: Option<AppPreferences>,
    #[serde(default)]
    pub ctrader_app: Option<CtraderAppCredentials>,
    pub last_updated_utc: String,
}

impl LocalStateSnapshot {
    pub fn new() -> Self {
        Self {
            version: SNAPSHOT_VERSION,
            accounts: HashMap::new(),
            preferences: None,
            ctrader_app: None,
            last_updated_utc: utc_now(),
        }
    }
}

fn prune_invalid_accounts(snap: &mut LocalStateSnapshot) {
    let invalid: Vec<String> = snap
        .accounts
        .keys()
        .filter(|k| {
            let t = k.trim();
            t.is_empty() || t == "0" || t.eq_ignore_ascii_case("unknown")
        })
        .cloned()
        .collect();
    for k in invalid {
        tracing::warn!(account_id = %k, "state load: pruning invalid account id");
        snap.accounts.remove(&k);
    }
}

fn utc_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", t.as_secs())
}

pub fn default_state_file_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "iptrade", "iptrade").map(|d| {
        let mut p = d.config_dir().to_path_buf();
        std::fs::create_dir_all(&p).ok();
        p.push(".state");
        p
    })
}

pub fn resolve_state_file_path() -> Option<PathBuf> {
    let from_env = std::env::var("IPTRADE_STATE_PATH").ok();
    let path = from_env
        .filter(|s| !s.trim().is_empty())
        .map(|s| PathBuf::from(s.trim()));
    path.or_else(default_state_file_path)
}

pub struct LocalStateFileManager {
    file_path: PathBuf,
    secret: String,
    mutex: Mutex<()>,
    cached: Mutex<Option<LocalStateSnapshot>>,
}

impl LocalStateFileManager {
    pub fn new(file_path: PathBuf, encryption_secret: String) -> Self {
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Self {
            file_path,
            secret: encryption_secret,
            mutex: Mutex::new(()),
            cached: Mutex::new(None),
        }
    }

    pub fn with_default_path(encryption_secret: String) -> Option<Self> {
        resolve_state_file_path().map(|p| Self::new(p, encryption_secret))
    }

    async fn load(&self) -> LocalStateSnapshot {
        let _guard = self.mutex.lock().await;
        if let Some(ref c) = *self.cached.lock().await {
            return c.clone();
        }
        let snap = self.load_from_disk().await;
        *self.cached.lock().await = Some(snap.clone());
        snap
    }

    async fn load_from_disk(&self) -> LocalStateSnapshot {
        let Ok(data) = fs::read(&self.file_path).await else {
            return LocalStateSnapshot::new();
        };
        let payload: EncryptedPayload = match serde_json::from_slice(&data) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "state load: json from_slice failed");
                return LocalStateSnapshot::new();
            }
        };
        let plain = match decrypt(&payload, &self.secret) {
            Ok(p) => p,
            Err(e) => {
                if self.secret != LEGACY_STATE_SECRET {
                    if let Ok(p) = decrypt(&payload, LEGACY_STATE_SECRET) {
                        if let Ok(mut snap) = serde_json::from_slice::<LocalStateSnapshot>(&p) {
                            prune_invalid_accounts(&mut snap);
                            tracing::info!("state load: migrated from legacy encryption");
                            let plain_ser = serde_json::to_vec(&snap).unwrap_or_default();
                            if let Ok(new_payload) = encrypt(&plain_ser, &self.secret) {
                                if let Ok(new_json) = serde_json::to_vec(&new_payload) {
                                    let _ = tokio::fs::write(&self.file_path, &new_json).await;
                                }
                            }
                            return snap;
                        }
                    }
                }
                tracing::warn!(error = %e, "state load: decrypt failed");
                return LocalStateSnapshot::new();
            }
        };
        match serde_json::from_slice::<LocalStateSnapshot>(&plain) {
            Ok(mut s) => {
                prune_invalid_accounts(&mut s);
                s
            }
            Err(e) => {
                tracing::warn!(error = %e, "state load: json from_slice plain failed");
                LocalStateSnapshot::new()
            }
        }
    }

    pub async fn read<T, F>(&self, f: F) -> T
    where
        F: FnOnce(&LocalStateSnapshot) -> T,
    {
        let snap = self.load().await;
        f(&snap)
    }

    pub async fn update<T, F>(&self, f: F) -> T
    where
        F: FnOnce(&mut LocalStateSnapshot) -> T,
    {
        let _guard = self.mutex.lock().await;
        let mut snap = if let Some(ref c) = *self.cached.lock().await {
            c.clone()
        } else {
            self.load_from_disk().await
        };
        let result = f(&mut snap);
        snap.last_updated_utc = utc_now();
        snap.version = SNAPSHOT_VERSION;

        let plain = serde_json::to_vec(&snap).unwrap_or_default();
        let payload = match encrypt(&plain, &self.secret) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "state update: encrypt failed, changes not persisted");
                return result;
            }
        };
        let json = serde_json::to_vec(&payload).unwrap_or_default();
        let temp_path = self.file_path.with_extension("tmp");
        let write_ok = match fs::File::create(&temp_path).await {
            Ok(mut file) => {
                let ok = file.write_all(&json).await.is_ok() && file.sync_all().await.is_ok();
                if !ok {
                    tracing::error!(path = %temp_path.display(), "state update: write_all/sync_all failed");
                }
                ok
            }
            Err(e) => {
                tracing::error!(path = %temp_path.display(), error = %e, "state update: create temp file failed");
                false
            }
        };
        let rename_ok = write_ok && fs::rename(&temp_path, &self.file_path).await.is_ok();
        if write_ok && !rename_ok {
            tracing::error!(from = %temp_path.display(), to = %self.file_path.display(), "state update: rename failed");
        }
        if rename_ok {
            *self.cached.lock().await = Some(snap);
        } else if write_ok {
            let _ = fs::remove_file(&temp_path).await;
        }
        result
    }

    pub async fn purge(&self) {
        let _guard = self.mutex.lock().await;
        let _ = fs::remove_file(&self.file_path).await;
        let temp_path = self.file_path.with_extension("tmp");
        let _ = fs::remove_file(&temp_path).await;
        *self.cached.lock().await = Some(LocalStateSnapshot::new());
    }
}
