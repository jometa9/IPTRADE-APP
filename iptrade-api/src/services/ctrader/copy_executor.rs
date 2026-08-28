use crate::services::copy_command::{CopyCommand, ReconcileResult};
use crate::services::proto_oa;
use futures_util::SinkExt;
use std::collections::HashMap;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use super::symbols;

pub(crate) async fn execute_copy_command(
    ctid: u64,
    write: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    symbols_by_name: &HashMap<String, u64>,
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_volume_steps: &HashMap<u64, i64>,
    position_symbol_index: &HashMap<i64, u64>,
    cmd: CopyCommand,
    pending_reconcile_reply: &mut Option<oneshot::Sender<ReconcileResult>>,
    pending_create_reply: &mut Option<oneshot::Sender<Result<(), String>>>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    match cmd {
        CopyCommand::OpenMarket {
            symbol_name,
            volume_lots,
            is_buy,
            comment,
            label,
            position_id,
            reply,
        } => {
            if pending_create_reply.is_some() {
                if let Some(tx) = reply {
                    let _ = tx.send(Err("another create order is still awaiting broker confirmation".to_string()));
                }
                return Err("create order already pending confirmation".to_string());
            }
            let symbol_meta = symbols::symbol_volume_meta_by_name(
                &symbol_name,
                symbols_by_name,
                symbol_lot_sizes,
                symbol_volume_steps,
            )?;
            let volume_protocol = symbols::protocol_volume_from_lots(volume_lots, symbol_meta);
            let msg = proto_oa::encode_new_order_req(
                ctid,
                symbol_meta.symbol_id,
                "market",
                is_buy,
                volume_protocol,
                None,
                None,
                None,
                None,
                &comment,
                &label,
                None,
                position_id,
            );
            let send_res = tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                .await
                .map_err(|_| "send new order timeout".to_string())
                .and_then(|r| r.map_err(|e| format!("send: {}", e)));
            if let Err(ref e) = send_res {
                if let Some(tx) = reply {
                    let _ = tx.send(Err(e.clone()));
                }
            } else {
                *pending_create_reply = reply;
            }
            send_res?;
        }
        CopyCommand::PlacePendingOrder {
            symbol_name,
            volume_lots,
            is_buy,
            order_type,
            price,
            stop_loss,
            take_profit,
            comment,
            label,
            reply,
        } => {
            if pending_create_reply.is_some() {
                if let Some(tx) = reply {
                    let _ = tx.send(Err("another create order is still awaiting broker confirmation".to_string()));
                }
                return Err("create order already pending confirmation".to_string());
            }
            let symbol_meta = symbols::symbol_volume_meta_by_name(
                &symbol_name,
                symbols_by_name,
                symbol_lot_sizes,
                symbol_volume_steps,
            )?;
            let volume_protocol = symbols::protocol_volume_from_lots(volume_lots, symbol_meta);
            let (limit_price, stop_price) = if order_type.eq_ignore_ascii_case("stop") {
                (None, Some(price))
            } else if order_type.eq_ignore_ascii_case("market") {
                (None, None)
            } else {
                (Some(price), None)
            };
            let use_relative_sltp = (stop_loss.is_some() || take_profit.is_some()).then_some((price, is_buy));
            let msg = proto_oa::encode_new_order_req(
                ctid,
                symbol_meta.symbol_id,
                &order_type,
                is_buy,
                volume_protocol,
                limit_price,
                stop_price,
                stop_loss,
                take_profit,
                &comment,
                &label,
                use_relative_sltp,
                None,
            );
            let send_res = tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                .await
                .map_err(|_| "send new order timeout".to_string())
                .and_then(|r| r.map_err(|e| format!("send: {}", e)));
            if let Err(ref e) = send_res {
                if let Some(tx) = reply {
                    let _ = tx.send(Err(e.clone()));
                }
            } else {
                *pending_create_reply = reply;
            }
            send_res?;
        }
        CopyCommand::AmendPositionSLTP {
            position_id,
            stop_loss,
            take_profit,
        } => {
            if stop_loss.is_some() && take_profit.is_some() {
                let mut any_ok = false;
                let mut errors: Vec<String> = Vec::new();

                let msg_sl = proto_oa::encode_amend_position_sltp_req(ctid, position_id, stop_loss, None);
                let sl_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_sl)))
                    .await
                    .map_err(|_| "send amend sl timeout")?
                    .map_err(|e| format!("send: {}", e));
                match sl_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("sl: {e}")),
                }

                let msg_tp = proto_oa::encode_amend_position_sltp_req(ctid, position_id, None, take_profit);
                let tp_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_tp)))
                    .await
                    .map_err(|_| "send amend tp timeout")?
                    .map_err(|e| format!("send: {}", e));
                match tp_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("tp: {e}")),
                }

                let msg_both = proto_oa::encode_amend_position_sltp_req(ctid, position_id, stop_loss, take_profit);
                let both_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_both)))
                    .await
                    .map_err(|_| "send amend both timeout")?
                    .map_err(|e| format!("send: {}", e));
                match both_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("both: {e}")),
                }

                if !any_ok {
                    return Err(format!("send amend position sl/tp failed ({})", errors.join(", ")));
                }
            } else {
                let msg = proto_oa::encode_amend_position_sltp_req(ctid, position_id, stop_loss, take_profit);
                tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                    .await
                    .map_err(|_| "send amend sltp timeout")?
                    .map_err(|e| format!("send: {}", e))?;
            }
        }
        CopyCommand::AmendOrder {
            symbol_name,
            order_id,
            order_type,
            volume_lots,
            price,
            stop_loss,
            take_profit,
            is_buy,
        } => {
            let volume_protocol = symbol_name
                .as_deref()
                .and_then(|n| {
                    symbols::symbol_volume_meta_by_name(
                        n,
                        symbols_by_name,
                        symbol_lot_sizes,
                        symbol_volume_steps,
                    )
                    .ok()
                })
                .map(|meta| symbols::protocol_volume_from_lots(volume_lots, meta))
                .unwrap_or_else(|| symbols::volume_lots_to_protocol(volume_lots, 10_000_000, 1));
            let (limit_price, stop_price) = if order_type.eq_ignore_ascii_case("stop") {
                (None, price)
            } else {
                (price, None)
            };
            if stop_loss.is_some() && take_profit.is_some() {
                let mut any_ok = false;
                let mut errors: Vec<String> = Vec::new();

                let msg_sl = proto_oa::encode_amend_order_req(
                    ctid,
                    order_id,
                    volume_protocol,
                    limit_price,
                    stop_price,
                    stop_loss,
                    None,
                    None,
                    is_buy,
                );
                let sl_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_sl)))
                    .await
                    .map_err(|_| "send amend order sl timeout")?
                    .map_err(|e| format!("send: {}", e));
                match sl_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("sl: {e}")),
                }

                let msg_tp = proto_oa::encode_amend_order_req(
                    ctid,
                    order_id,
                    volume_protocol,
                    limit_price,
                    stop_price,
                    None,
                    take_profit,
                    None,
                    is_buy,
                );
                let tp_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_tp)))
                    .await
                    .map_err(|_| "send amend order tp timeout")?
                    .map_err(|e| format!("send: {}", e));
                match tp_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("tp: {e}")),
                }

                let msg_both = proto_oa::encode_amend_order_req(
                    ctid,
                    order_id,
                    volume_protocol,
                    limit_price,
                    stop_price,
                    stop_loss,
                    take_profit,
                    None,
                    is_buy,
                );
                let both_send = tokio::time::timeout(timeout, write.send(Message::Binary(msg_both)))
                    .await
                    .map_err(|_| "send amend order both timeout")?
                    .map_err(|e| format!("send: {}", e));
                match both_send {
                    Ok(()) => any_ok = true,
                    Err(e) => errors.push(format!("both: {e}")),
                }

                if !any_ok {
                    return Err(format!("send amend order failed ({})", errors.join(", ")));
                }
            } else {
                let msg = proto_oa::encode_amend_order_req(
                    ctid,
                    order_id,
                    volume_protocol,
                    limit_price,
                    stop_price,
                    stop_loss,
                    take_profit,
                    None,
                    is_buy,
                );
                tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                    .await
                    .map_err(|_| "send amend order timeout")?
                    .map_err(|e| format!("send: {}", e))?;
            }
        }
        CopyCommand::ClosePosition {
            position_id,
            volume_centi_lots,
        } => {
            let requested_lots = (volume_centi_lots.max(1) as f64) / 100.0;
            let symbol_meta = position_symbol_index
                .get(&position_id)
                .copied()
                .map(|symbol_id| symbols::symbol_volume_meta_by_id(symbol_id, symbol_lot_sizes, symbol_volume_steps));
            let volume_protocol = symbol_meta
                .map(|meta| symbols::protocol_volume_from_lots(requested_lots, meta))
                .unwrap_or_else(|| symbols::volume_lots_to_protocol(requested_lots, 10_000_000, 1));
            let msg = proto_oa::encode_close_position_req(ctid, position_id, volume_protocol.max(1));
            tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                .await
                .map_err(|_| "send close position timeout")?
                .map_err(|e| format!("send: {}", e))?;
        }
        CopyCommand::CancelOrder { order_id } => {
            let msg = proto_oa::encode_cancel_order_req(ctid, order_id);
            tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                .await
                .map_err(|_| "send cancel order timeout")?
                .map_err(|e| format!("send: {}", e))?;
        }
        CopyCommand::GetReconcile { reply } => {
            *pending_reconcile_reply = Some(reply);
            let msg = proto_oa::encode_reconcile_req(ctid);
            tokio::time::timeout(timeout, write.send(Message::Binary(msg)))
                .await
                .map_err(|_| "send reconcile timeout")?
                .map_err(|e| format!("send: {}", e))?;
        }
    }
    Ok(())
}
