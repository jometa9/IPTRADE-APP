use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const SYMBOLS_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
struct CachedSymbols {
    map: Arc<HashMap<u64, String>>,
    fetched_at: Instant,
}

#[derive(Default)]
pub struct CtraderSymbolsCache {
    inner: RwLock<HashMap<u64, CachedSymbols>>,
}

impl CtraderSymbolsCache {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn get(&self, ctid: u64) -> Option<Arc<HashMap<u64, String>>> {
        let g = self.inner.read().await;
        let entry = g.get(&ctid)?;
        if entry.fetched_at.elapsed() > SYMBOLS_TTL {
            return None;
        }
        Some(entry.map.clone())
    }

    pub async fn set(&self, ctid: u64, map: HashMap<u64, String>) -> Arc<HashMap<u64, String>> {
        let arc = Arc::new(map);
        let mut g = self.inner.write().await;
        g.insert(
            ctid,
            CachedSymbols {
                map: arc.clone(),
                fetched_at: Instant::now(),
            },
        );
        arc
    }

}
