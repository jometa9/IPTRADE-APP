use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_LINES: usize = 100;

const LOG_RETENTION_DAYS: i64 = 3;


struct RingBufferState {
    lines: VecDeque<String>,
    current_line: String,
    max_lines: usize,
    stderr: io::Stderr,
    log_file_path: Option<std::path::PathBuf>,
}

impl RingBufferState {
    fn write_buf(&mut self, buf: &[u8]) -> io::Result<usize> {
        let s = String::from_utf8_lossy(buf);
        self.current_line.push_str(&s);
        let mut err = self.stderr.lock();
        while let Some(i) = self.current_line.find('\n') {
            let line: String = self.current_line.drain(..=i).collect();
            if self.lines.len() >= self.max_lines {
                self.lines.pop_front();
            }
            self.lines.push_back(line.clone());
            err.write_all(line.as_bytes())?;
            if let Some(ref path) = self.log_file_path {
                self.append_to_log_file(path, &line)?;
            }
        }
        err.flush()?;
        Ok(buf.len())
    }

    fn append_to_log_file(&self, path: &Path, line: &str) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(f, "{}", line.trim_end_matches('\n'))?;
        f.flush()
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.current_line.is_empty() {
            let line = std::mem::take(&mut self.current_line);
            if self.lines.len() >= self.max_lines {
                self.lines.pop_front();
            }
            self.lines.push_back(line.clone());
            let mut err = self.stderr.lock();
            err.write_all(line.as_bytes())?;
            err.flush()?;
            if let Some(ref path) = self.log_file_path {
                self.append_to_log_file(path, &line)?;
            }
        }
        self.stderr.lock().flush()
    }
}

#[derive(Clone)]
pub struct RingBufferLogWriter(Arc<Mutex<RingBufferState>>);

impl RingBufferLogWriter {
    pub fn new_with_file(max_lines: usize, log_file_path: Option<std::path::PathBuf>) -> Self {
        Self(Arc::new(Mutex::new(RingBufferState {
            lines: VecDeque::new(),
            current_line: String::new(),
            max_lines,
            stderr: io::stderr(),
            log_file_path,
        })))
    }
}

pub fn clear_log_file(path: &Path) -> io::Result<()> {
    if path.exists() {
        std::fs::write(path, "")?;
    }
    Ok(())
}

pub fn trim_log_file_to_retention(path: &Path) -> io::Result<()> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let cutoff = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 - LOG_RETENTION_DAYS * 86400)
        .unwrap_or(0);
    let cutoff_days = cutoff / 86400;

    let mut kept = Vec::new();
    for line in content.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            kept.push(line.to_string());
            continue;
        }
        let line_days = parse_line_date(line);
        match line_days {
            Some(days) if days < cutoff_days => { }
            _ => kept.push(line.to_string()),
        }
    }
    let out = kept.join("\n");
    let out = if out.ends_with('\n') { out } else { format!("{}\n", out) };
    std::fs::write(path, out)
}

fn parse_line_date(line: &str) -> Option<i64> {
    let max_scan = line.len().min(96);
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i + 10 <= max_scan {
        if is_ascii_digit(bytes[i])
            && is_ascii_digit(bytes[i + 1])
            && is_ascii_digit(bytes[i + 2])
            && is_ascii_digit(bytes[i + 3])
            && bytes[i + 4] == b'-'
            && is_ascii_digit(bytes[i + 5])
            && is_ascii_digit(bytes[i + 6])
            && bytes[i + 7] == b'-'
            && is_ascii_digit(bytes[i + 8])
            && is_ascii_digit(bytes[i + 9])
        {
            let date = &line[i..i + 10];
            if let Some((y, m, d)) = parse_ymd(date) {
                if (1970..=2100).contains(&y) && is_valid_ymd(y, m, d) {
                    return Some(ymd_to_unix_days(y, m, d));
                }
            }
        }
        i += 1;
    }
    None
}

fn parse_ymd(s: &str) -> Option<(i64, i64, i64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].trim().parse().ok()?;
    let m: i64 = parts[1].trim().parse().ok()?;
    let d: i64 = parts[2].trim().parse().ok()?;
    Some((y, m, d))
}

fn is_ascii_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

fn is_valid_ymd(y: i64, m: i64, d: i64) -> bool {
    if !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let max_day = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) { 29 } else { 28 }
        }
        _ => return false,
    };
    d <= max_day
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn ymd_to_unix_days(y: i64, m: i64, d: i64) -> i64 {
    let m = if m <= 2 { m + 12 } else { m };
    let y = if m > 12 { y - 1 } else { y };
    let era = (y * 365 + y / 4 - y / 100 + y / 400) as i64;
    let doy = (153 * m - 457) / 5 + d - 1;
    era + doy - 719468
}

impl Write for RingBufferLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
            .write_buf(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
            .flush()
    }
}
