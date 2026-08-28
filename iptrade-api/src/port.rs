use std::io;
use std::process::Command;

pub fn pids_on_port(port: u16) -> io::Result<Vec<u32>> {
    let my_pid = std::process::id();
    let pids = pids_listening_on_port(port)?
        .into_iter()
        .filter(|&pid| pid != my_pid)
        .collect();
    Ok(pids)
}

pub fn kill_process_on_port(port: u16) -> io::Result<()> {
    let my_pid = std::process::id();
    let pids = pids_listening_on_port(port)?;
    let to_kill: Vec<u32> = pids.into_iter().filter(|&pid| pid != my_pid).collect();
    if to_kill.is_empty() {
        return Ok(());
    }
    for pid in &to_kill {
        kill_pid(*pid)?;
    }
    Ok(())
}

fn pids_listening_on_port(port: u16) -> io::Result<Vec<u32>> {
    #[cfg(target_os = "windows")]
    return pids_on_port_windows(port);
    #[cfg(not(target_os = "windows"))]
    return pids_on_port_unix(port);
}

#[cfg(not(target_os = "windows"))]
fn pids_on_port_unix(port: u16) -> io::Result<Vec<u32>> {
    let out = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output()?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let pids: Vec<u32> = s
        .split_whitespace()
        .filter_map(|x| x.parse().ok())
        .collect();
    Ok(pids)
}

#[cfg(target_os = "windows")]
fn pids_on_port_windows(port: u16) -> io::Result<Vec<u32>> {
    let out = Command::new("netstat")
        .args(["-ano"])
        .output()?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let port_str = format!(":{}", port);
    let mut pids = Vec::new();
    for line in s.lines() {
        if !line.contains(&port_str) || !line.to_uppercase().contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(last) = parts.last() {
            if let Ok(pid) = last.parse::<u32>() {
                if pid > 0 {
                    pids.push(pid);
                }
            }
        }
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) -> io::Result<()> {
    let status = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()?;
    let _ = status;
    Ok(())
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) -> io::Result<()> {
    let out = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()?;
    if out.status.code() == Some(128) || out.status.success() {
        return Ok(());
    }
    Ok(())
}
