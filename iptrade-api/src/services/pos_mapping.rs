use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;

fn mapping_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "iptrade", "iptrade").map(|d| {
        let p = d.config_dir().to_path_buf();
        let _ = std::fs::create_dir_all(&p);
        p
    })
}

fn mapping_path(account_id: &str) -> Option<PathBuf> {
    mapping_dir().map(|mut p| {
        let safe_id: String = account_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        p.push(format!(".posmap_{}", safe_id));
        p
    })
}

pub fn load(account_id: &str) -> HashMap<i64, i64> {
    let path = match mapping_path(account_id) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            if e.kind() != ErrorKind::NotFound {
                tracing::warn!(account_id = %account_id, path = %path.display(), error = %e, "pos_mapping load failed");
            }
            return HashMap::new();
        }
    };
    if data.len() < 4 {
        return HashMap::new();
    }
    let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let expected = 4 + count * 16;
    if data.len() < expected {
        return HashMap::new();
    }
    let mut map = HashMap::with_capacity(count);
    for i in 0..count {
        let off = 4 + i * 16;
        let pos_id = i64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let ord_id = i64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        map.insert(pos_id, ord_id);
    }
    map
}

pub fn save(account_id: &str, map: &HashMap<i64, i64>) {
    let path = match mapping_path(account_id) {
        Some(p) => p,
        None => return,
    };
    let count = map.len() as u32;
    let mut buf = Vec::with_capacity(4 + map.len() * 16);
    buf.extend_from_slice(&count.to_le_bytes());
    for (&pos_id, &ord_id) in map {
        buf.extend_from_slice(&pos_id.to_le_bytes());
        buf.extend_from_slice(&ord_id.to_le_bytes());
    }
    let _ = std::fs::write(&path, &buf);
}

pub fn delete(account_id: &str) {
    let path = match mapping_path(account_id) {
        Some(p) => p,
        None => return,
    };
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
}

pub fn delete_all() {
    let dir = match mapping_dir() {
        Some(d) => d,
        None => return,
    };
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(".posmap_") {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

