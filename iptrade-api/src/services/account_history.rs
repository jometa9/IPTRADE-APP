
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct AccountInfoDto {
    pub account_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unrealized_pnl: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leverage: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct OpenPositionDto {
    pub ticket: i64,
    pub symbol: String,
    pub r#type: String,
    pub side: String,
    pub volume: f64,
    pub open_price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub open_time: i64,
    pub profit: f64,
    pub swap: f64,
    pub commission: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magic: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct PendingOrderDto {
    pub ticket: i64,
    pub symbol: String,
    pub r#type: String,
    pub side: String,
    pub volume: f64,
    pub price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magic: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TcpOpenPositionDto {
    pub ticket: i64,
    pub symbol: String,
    pub r#type: String,
    pub side: String,
    pub volume: f64,
    pub open_price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub age_seconds: u64,
    pub profit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TcpPendingOrderDto {
    pub ticket: i64,
    pub symbol: String,
    pub r#type: String,
    pub side: String,
    pub volume: f64,
    pub price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub age_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magic: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TcpSnapshotMessage {
    pub event: String,
    /// Snapshot ordering: `session` is fixed per producer run (a restart changes it) and
    /// `seq` is a monotonic counter. The slave ignores any snapshot not newer than the last
    /// applied, so stale / out-of-order / replayed snapshots never drive a close.
    #[serde(default)]
    pub session: i64,
    #[serde(default)]
    pub seq: i64,
    pub account: AccountInfoDto,
    pub open_positions: Vec<TcpOpenPositionDto>,
    pub pending_orders: Vec<TcpPendingOrderDto>,
}

impl TcpSnapshotMessage {
    pub fn to_json_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}
