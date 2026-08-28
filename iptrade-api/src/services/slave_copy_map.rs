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
        p.push(format!(".slavecopy_{}", safe_id));
        p
    })
}

#[derive(Default, Debug, Clone)]
pub struct CopyMap {
    pub positions: HashMap<i64, i64>,
    pub orders: HashMap<i64, i64>,
}

impl CopyMap {
    pub fn is_copier_position(&self, position_id: i64) -> bool {
        self.positions.values().any(|&v| v == position_id)
    }

    pub fn is_copier_order(&self, order_id: i64) -> bool {
        self.orders.values().any(|&v| v == order_id)
    }

    pub fn set_position(&mut self, master_ticket: i64, slave_position_id: i64) -> bool {
        if master_ticket <= 0 || slave_position_id <= 0 {
            return false;
        }
        match self.positions.get(&master_ticket) {
            Some(&existing) if existing == slave_position_id => false,
            _ => {
                self.positions.insert(master_ticket, slave_position_id);
                true
            }
        }
    }

    pub fn set_order(&mut self, master_ticket: i64, slave_order_id: i64) -> bool {
        if master_ticket <= 0 || slave_order_id <= 0 {
            return false;
        }
        match self.orders.get(&master_ticket) {
            Some(&existing) if existing == slave_order_id => false,
            _ => {
                self.orders.insert(master_ticket, slave_order_id);
                true
            }
        }
    }

    pub fn remove_position_by_slave(&mut self, slave_position_id: i64) -> bool {
        if let Some(k) = self
            .positions
            .iter()
            .find(|(_, &v)| v == slave_position_id)
            .map(|(&k, _)| k)
        {
            self.positions.remove(&k);
            true
        } else {
            false
        }
    }

    pub fn remove_order_by_slave(&mut self, slave_order_id: i64) -> bool {
        if let Some(k) = self
            .orders
            .iter()
            .find(|(_, &v)| v == slave_order_id)
            .map(|(&k, _)| k)
        {
            self.orders.remove(&k);
            true
        } else {
            false
        }
    }

    pub fn retain_slave_tickets(&mut self, slave_position_ids: &[i64], slave_order_ids: &[i64]) -> bool {
        let pos_before = self.positions.len();
        let ord_before = self.orders.len();
        self.positions.retain(|_, v| slave_position_ids.contains(v));
        self.orders.retain(|_, v| slave_order_ids.contains(v));
        pos_before != self.positions.len() || ord_before != self.orders.len()
    }
}

pub fn load(account_id: &str) -> CopyMap {
    let path = match mapping_path(account_id) {
        Some(p) => p,
        None => return CopyMap::default(),
    };
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            if e.kind() != ErrorKind::NotFound {
                tracing::warn!(account_id = %account_id, path = %path.display(), error = %e, "slave_copy_map load failed");
            }
            return CopyMap::default();
        }
    };
    parse_bytes(&data)
}

fn parse_bytes(data: &[u8]) -> CopyMap {
    let mut map = CopyMap::default();
    if data.len() < 8 {
        return map;
    }
    let pos_count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let ord_count = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let expected = 8 + pos_count * 16 + ord_count * 16;
    if data.len() < expected {
        return map;
    }
    let mut off = 8;
    for _ in 0..pos_count {
        let master = i64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let slave = i64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        off += 16;
        if master > 0 && slave > 0 {
            map.positions.insert(master, slave);
        }
    }
    for _ in 0..ord_count {
        let master = i64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let slave = i64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        off += 16;
        if master > 0 && slave > 0 {
            map.orders.insert(master, slave);
        }
    }
    map
}

pub fn save(account_id: &str, map: &CopyMap) {
    let path = match mapping_path(account_id) {
        Some(p) => p,
        None => return,
    };
    let pos_count = map.positions.len() as u32;
    let ord_count = map.orders.len() as u32;
    let mut buf = Vec::with_capacity(8 + (map.positions.len() + map.orders.len()) * 16);
    buf.extend_from_slice(&pos_count.to_le_bytes());
    buf.extend_from_slice(&ord_count.to_le_bytes());
    for (&master, &slave) in &map.positions {
        buf.extend_from_slice(&master.to_le_bytes());
        buf.extend_from_slice(&slave.to_le_bytes());
    }
    for (&master, &slave) in &map.orders {
        buf.extend_from_slice(&master.to_le_bytes());
        buf.extend_from_slice(&slave.to_le_bytes());
    }
    let _ = std::fs::write(&path, &buf);
}

pub fn delete(account_id: &str) {
    if let Some(path) = mapping_path(account_id) {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
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
                    if name.starts_with(".slavecopy_") {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}
