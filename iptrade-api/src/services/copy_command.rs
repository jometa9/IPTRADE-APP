
use crate::services::proto_oa::{SlaveOrder, SlavePosition};
use std::collections::HashMap;
use tokio::sync::oneshot;

pub type ReconcileResult = Result<
    (
        Vec<SlavePosition>,
        Vec<SlaveOrder>,
        HashMap<u64, String>,
        HashMap<u64, u32>,
        HashMap<u64, f64>,
        HashMap<u64, f64>,
    ),
    String,
>;

#[derive(Debug)]
pub enum CopyCommand {
    OpenMarket {
        symbol_name: String,
        volume_lots: f64,
        is_buy: bool,
        comment: String,
        label: String,
        position_id: Option<i64>,
        reply: Option<oneshot::Sender<Result<(), String>>>,
    },
    PlacePendingOrder {
        symbol_name: String,
        volume_lots: f64,
        is_buy: bool,
        order_type: String,
        price: f64,
        stop_loss: Option<f64>,
        take_profit: Option<f64>,
        comment: String,
        label: String,
        reply: Option<oneshot::Sender<Result<(), String>>>,
    },
    AmendPositionSLTP {
        position_id: i64,
        stop_loss: Option<f64>,
        take_profit: Option<f64>,
    },
    AmendOrder {
        symbol_name: Option<String>,
        order_id: i64,
        order_type: String,
        volume_lots: f64,
        price: Option<f64>,
        stop_loss: Option<f64>,
        take_profit: Option<f64>,
        is_buy: bool,
    },
    ClosePosition {
        position_id: i64,
        volume_centi_lots: i64,
    },
    CancelOrder { order_id: i64 },
    GetReconcile {
        reply: oneshot::Sender<ReconcileResult>,
    },
}
