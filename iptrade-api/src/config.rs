use std::env;

pub use crate::build_config::{
    API_KEY, API_SECRET, CTRADER_REDIRECT_URI_LOCAL, HTTP_PORT, TCP_PORT,
};

pub const API_KEY_HEADER: &str = "x-api-key";
pub const API_SECRET_HEADER: &str = "x-api-secret";
pub const DYNAMIC_INSERT_POS: usize = 10;
pub const DYNAMIC_LEN: usize = 2;

#[derive(Clone, Debug)]
pub struct Config {
    pub api_key: String,
    pub api_secret: String,
    pub port: u16,
    pub app_version: Option<String>,
    pub ctrader_client_id: Option<String>,
    pub ctrader_client_secret: Option<String>,
    pub ctrader_redirect_uri_local: String,
    pub tcp_port: u16,
    pub tcp_base_url: String,
    pub heartbeat_in_enabled: bool,
    pub logs_to_file_enabled: bool,
    #[cfg(target_os = "windows")]
    pub install_bots_enabled: bool,
    #[cfg(target_os = "windows")]
    pub bots_source_path: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: API_KEY.to_string(),
            api_secret: API_SECRET.to_string(),
            port: HTTP_PORT,
            app_version: None,
            ctrader_client_id: None,
            ctrader_client_secret: None,
            ctrader_redirect_uri_local: CTRADER_REDIRECT_URI_LOCAL.to_string(),
            tcp_port: TCP_PORT,
                        tcp_base_url: format!("tcp://localhost:{}", TCP_PORT),
            heartbeat_in_enabled: true,
            logs_to_file_enabled: true,
            #[cfg(target_os = "windows")]
            install_bots_enabled: true,
            #[cfg(target_os = "windows")]
            bots_source_path: None,
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let api_key = env::var("IPTRADE_API_KEY")
            .ok()
            .filter(|v| v.len() == 64)
            .unwrap_or_else(|| API_KEY.to_string());
        let api_secret = env::var("IPTRADE_API_SECRET")
            .ok()
            .filter(|v| v.len() == 64)
            .unwrap_or_else(|| API_SECRET.to_string());
        let port = HTTP_PORT;
        let app_version = env::var("APP_VERSION").ok().filter(|s| !s.is_empty());
        // Optional dev override; normally the user's cTrader app credentials are
        // stored in the encrypted local state (set from the app's Config screen).
        let ctrader_client_id = env::var("CTRADER_CLIENT_ID").ok().filter(|s| !s.trim().is_empty());
        let ctrader_client_secret = env::var("CTRADER_CLIENT_SECRET").ok().filter(|s| !s.trim().is_empty());
        let ctrader_redirect_uri_local = CTRADER_REDIRECT_URI_LOCAL.to_string();
                let tcp_base_url = format!("tcp://localhost:{}", TCP_PORT);
        let tcp_port = TCP_PORT;

        let heartbeat_in_enabled = env::var("HEARTBEAT_IN_ENABLED")
            .ok()
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            .unwrap_or(true);

        let logs_to_file_enabled = env::var("LOGS_TO_FILE_ENABLED")
            .ok()
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            .unwrap_or(true);

        #[cfg(target_os = "windows")]
        let install_bots_enabled = env::var("INSTALL_BOTS_ENABLED")
            .ok()
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            .unwrap_or(true);
        #[cfg(target_os = "windows")]
        let bots_source_path = env::var("BOTS_SOURCE_PATH").ok().filter(|s| !s.is_empty());

        Self {
            api_key,
            api_secret,
            port,
            app_version,
            ctrader_client_id,
            ctrader_client_secret,
            ctrader_redirect_uri_local,
            tcp_port,
            tcp_base_url,
            heartbeat_in_enabled,
            logs_to_file_enabled,
            #[cfg(target_os = "windows")]
            install_bots_enabled,
            #[cfg(target_os = "windows")]
            bots_source_path,
        }
    }

    pub fn default_log_file_path(&self) -> Option<std::path::PathBuf> {
        if let Ok(state_path) = std::env::var("IPTRADE_STATE_PATH") {
            let p = std::path::PathBuf::from(&state_path);
            if let Some(parent) = p.parent() {
                return Some(parent.join("logs").join("iptrade.log"));
            }
        }
        std::env::current_dir().ok().map(|cwd| cwd.join("logs").join("iptrade.log"))
    }

    pub fn log_file_path(&self) -> Option<std::path::PathBuf> {
        if !self.logs_to_file_enabled {
            return None;
        }
        self.default_log_file_path()
    }
}
