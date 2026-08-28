
mod encrypt;
mod store;

pub use store::{LocalStateFileManager, LocalStateSnapshot, resolve_state_file_path};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct AppPreferences {
    #[serde(default = "default_true")]
    pub show_nickname: bool,
    #[serde(default = "default_true")]
    pub sounds_enabled: bool,
    #[serde(default = "default_true")]
    pub global_copier_enabled: bool,
    #[serde(default)]
    pub show_slave_config_details: bool,
    #[serde(default)]
    pub show_orders_totals: bool,
    #[serde(default = "default_true")]
    pub show_resources: bool,
    #[serde(default = "default_true")]
    pub show_balance: bool,
    #[serde(default)]
    pub show_equity: bool,
    #[serde(default = "default_true")]
    pub show_pnl: bool,
    #[serde(default = "default_true")]
    pub show_open_orders: bool,
    #[serde(default)]
    pub always_show_columns: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            show_nickname: true,
            sounds_enabled: true,
            global_copier_enabled: true,
            show_slave_config_details: false,
            show_orders_totals: false,
            show_resources: true,
            show_balance: true,
            show_equity: false,
            show_pnl: true,
            show_open_orders: true,
            always_show_columns: false,
        }
    }
}

// Credentials of the user's own cTrader Open API application (see
// https://openapi.ctrader.com). Stored in the encrypted local state file.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct CtraderAppCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub struct PrefixSuffixConfig {
    pub enabled: bool,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub action: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct AccountEntry {
    pub account_id: String,
    pub platform: String,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub ctid_trader_account_id: Option<u64>,
    pub is_live: Option<bool>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_expires_at_utc: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub role: Option<String>,
    #[serde(default)]
    pub master_account_id: Option<String>,
    pub master_tcp_url: Option<String>,
    pub tcp_url: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    pub lot_type: Option<String>,
    pub lot_multiplier: Option<f64>,
    pub fixed_lot: Option<f64>,
    pub reverse_trading: Option<bool>,
    #[serde(default, alias = "exactMatch")]
    pub exact_match: Option<bool>,
    pub symbol_translations: Option<Vec<String>>,
    #[serde(default)]
    pub prefix: Option<PrefixSuffixConfig>,
    #[serde(default)]
    pub suffix: Option<PrefixSuffixConfig>,
    pub last_heartbeat_utc: Option<String>,
    #[serde(default)]
    pub reconnect_type: Option<String>,
    #[serde(default)]
    pub reconnect_retry_after_secs: Option<i64>,
    #[serde(default, rename = "connectionType", alias = "mt5_connection_type", alias = "mt5ConnectionType")]
    pub connection_type: Option<String>,
    #[serde(default)]
    pub tcp_enabled: Option<bool>,
}

pub fn recalc_slaves_master_tcp_urls(snap: &mut LocalStateSnapshot) {
    use std::collections::HashMap;
    let master_urls: HashMap<String, String> = snap
        .accounts
        .iter()
        .filter(|(_, e)| {
            e.role.as_deref() == Some("master")
                && e.tcp_url.as_ref().map(|u| !u.is_empty()).unwrap_or(false)
        })
        .filter_map(|(id, e)| e.tcp_url.as_ref().map(|u| (id.clone(), u.clone())))
        .collect();
    let mut updated: Vec<String> = Vec::new();
    let mut skipped_no_mid: Vec<String> = Vec::new();
    let mut skipped_master_not_found: Vec<(String, String)> = Vec::new();
    for (id, entry) in snap.accounts.iter_mut() {
        if entry.role.as_deref() != Some("slave") {
            continue;
        }
        match &entry.master_account_id {
            None => {
                skipped_no_mid.push(id.clone());
            }
            Some(mid) => {
                if let Some(url) = master_urls.get(mid) {
                    entry.master_tcp_url = Some(url.clone());
                    updated.push(id.clone());
                } else {
                    skipped_master_not_found.push((id.clone(), mid.clone()));
                }
            }
        }
    }
}
