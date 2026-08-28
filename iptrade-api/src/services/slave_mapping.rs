use std::path::PathBuf;

fn mapping_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "iptrade", "iptrade").map(|d| {
        let p = d.config_dir().to_path_buf();
        let _ = std::fs::create_dir_all(&p);
        p
    })
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn delete_for_account(account_id: &str) {
    let dir = match mapping_dir() {
        Some(d) => d,
        None => return,
    };
    let safe_id = sanitize_id(account_id);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(".slavemap_") && name.contains(&safe_id) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
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
                    if name.starts_with(".slavemap_") {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}
