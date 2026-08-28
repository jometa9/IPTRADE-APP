use axum::http::StatusCode;
use serde::Deserialize;
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use utoipa::ToSchema;

#[derive(Deserialize, Default, ToSchema)]
pub struct InstallBotsBody {
    pub target_path: Option<String>,
}

#[cfg(target_os = "windows")]
const EXCLUDED_SEGMENTS: &[&str] = &[
    "node_modules", ".git", ".svn", "$recycle.bin", "$windows.~bt", "$windows.~ws",
    "system volume information", "recovery", "temp", "tmp", "cache", "logs", ".cache",
    ".npm", ".yarn", "windows", "winsxs", "assembly", "servicing", "programdata",
    "nvidia", "intel", "amd", "target", "dist", "build", ".cargo", ".rustup", ".nuget",
    ".dotnet", ".vscode", ".vs", ".idea", "vendor", "__pycache__", "downloads",
    "documents", "desktop", "music", "videos", "pictures", "saved games", "onedrive",
    "dropbox", "contacts", "favorites",
];

#[cfg(target_os = "windows")]
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            let _ = std::fs::copy(entry.path(), dst_path);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_file_to(src: &Path, dest: &Path) -> std::io::Result<()> {
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::copy(src, dest)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn should_exclude_path(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    EXCLUDED_SEGMENTS.iter().any(|ex| s.contains(&ex.to_lowercase()))
}

#[cfg(target_os = "windows")]
fn get_windows_drives() -> Vec<String> {
    let output = std::process::Command::new("wmic")
        .args(["logicaldisk", "get", "name"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let drives: Vec<String> = stdout
                .lines()
                .filter_map(|l| {
                    let t = l.trim();
                    if t.len() >= 2
                        && t.chars().next().map(|c| c.is_ascii_alphabetic()) == Some(true)
                        && t.ends_with(':')
                    {
                        Some(format!("{}\\", t.to_uppercase()))
                    } else {
                        None
                    }
                })
                .collect();
            if !drives.is_empty() {
                return drives;
            }
        }
        _ => {}
    }
    let common = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\"];
    common
        .iter()
        .filter(|d| Path::new(d).exists())
        .map(|s| s.to_string())
        .collect()
}

#[cfg(target_os = "windows")]
fn find_mt_experts_on_drive(drive: &str) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut mt4 = Vec::new();
    let mut mt5 = Vec::new();
    let mut seen = std::collections::HashSet::<PathBuf>::new();
    let root = Path::new(drive);
    if !root.is_dir() {
        return (mt4, mt5);
    }
    let walker = walkdir::WalkDir::new(root)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !should_exclude_path(e.path()));
    for entry in walker.filter_map(Result::ok) {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name != "Experts" {
            continue;
        }
        let parent = match p.parent() {
            Some(par) => par,
            None => continue,
        };
        let parent_name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let is_mql4 = parent_name.eq_ignore_ascii_case("MQL4");
        let is_mql5 = parent_name.eq_ignore_ascii_case("MQL5");
        if !is_mql4 && !is_mql5 {
            continue;
        }
        let path_buf = p.to_path_buf();
        if seen.insert(path_buf.clone()) {
            if is_mql4 {
                mt4.push(path_buf);
            } else {
                mt5.push(path_buf);
            }
        }
    }
    (mt4, mt5)
}

#[cfg(target_os = "windows")]
fn copy_mt_to_target(
    source_root: &Path,
    platform: &str,
    experts_target: &Path,
) -> std::io::Result<()> {
    let experts_src = source_root.join(platform).join("Experts");
    if !experts_src.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&experts_src)? {
        let entry = entry?;
        let dest = experts_target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            copy_file_to(&entry.path(), &dest)?;
        }
    }
    let mql_root = experts_target.parent().unwrap_or(experts_target);
    let include_src = source_root.join(platform).join("Include");
    if include_src.is_dir() {
        let include_dest = mql_root.join("Include");
        copy_dir_all(&include_src, &include_dest)?;
    }
    let lib_src = source_root.join(platform).join("Libraries");
    if lib_src.is_dir() {
        let lib_dest = mql_root.join("Libraries");
        copy_dir_all(&lib_src, &lib_dest)?;
    }
    Ok(())
}

pub fn execute_install(
    source_path: &Path,
    body: Option<&InstallBotsBody>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    #[cfg(target_os = "windows")]
    {
        let mut targets = Vec::<PathBuf>::new();
        let mut warnings = Vec::<String>::new();
        let use_scan = body
            .and_then(|b| b.target_path.as_ref())
            .map(|t| t.trim().is_empty())
            .unwrap_or(true);

        if use_scan {
            let drives = get_windows_drives();
            let scan_results: Vec<(Vec<PathBuf>, Vec<PathBuf>)> = std::thread::scope(|s| {
                let handles: Vec<_> = drives
                    .iter()
                    .map(|drive| s.spawn(|| find_mt_experts_on_drive(drive)))
                    .collect();
                handles.into_iter().filter_map(|h| h.join().ok()).collect()
            });
            for (mt4_paths, mt5_paths) in &scan_results {
                for experts_path in mt4_paths {
                    match copy_mt_to_target(source_path, "MT4", experts_path) {
                        Ok(()) => targets.push(experts_path.clone()),
                        Err(e) => {
                            warnings.push(format!("Could not copy to {}: {}", experts_path.display(), e));
                        }
                    }
                }
                for experts_path in mt5_paths {
                    match copy_mt_to_target(source_path, "MT5", experts_path) {
                        Ok(()) => targets.push(experts_path.clone()),
                        Err(e) => {
                            warnings.push(format!("Could not copy to {}: {}", experts_path.display(), e));
                        }
                    }
                }
            }
            if targets.is_empty() && warnings.is_empty() {
                warnings.push("No MetaTrader installation folders found on this machine".to_string());
            }
        } else {
            let target = body
                .and_then(|b| b.target_path.as_ref())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or((
                    StatusCode::BAD_REQUEST,
                    "target_path is required when provided".to_string(),
                ))?;
            let target_path = Path::new(&target);
            for subdir in ["MT4", "MT5"] {
                let src = source_path.join(subdir);
                if src.is_dir() {
                    let dst = target_path.join(subdir);
                    match copy_dir_all(&src, &dst) {
                        Ok(()) => targets.push(dst),
                        Err(e) => {
                            warnings.push(format!("Failed to copy {}: {}", subdir, e));
                        }
                    }
                }
            }
        }

        let copied = targets.len() as u32;
        let targets_str: Vec<String> = targets
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();

        Ok(serde_json::json!({
            "success": copied > 0 || warnings.is_empty(),
            "copied": copied,
            "targets": targets_str,
            "warnings": warnings
        }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (source_path, body.as_ref().and_then(|b| b.target_path.as_ref()));
        Err((
            StatusCode::NOT_IMPLEMENTED,
            "Install bots is only available on Windows".to_string(),
        ))
    }
}
