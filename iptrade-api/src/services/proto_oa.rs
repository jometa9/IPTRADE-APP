use std::collections::HashMap;
use std::io::{Cursor, Read};

const PROTO_OA_APPLICATION_AUTH_REQ: i32 = 2100;
pub const PROTO_OA_APPLICATION_AUTH_RES: i32 = 2101;
pub const PROTO_OA_ACCOUNT_AUTH_REQ: i32 = 2102;
pub const PROTO_OA_ACCOUNT_AUTH_RES: i32 = 2103;
const PROTO_OA_NEW_ORDER_REQ: i32 = 2106;
const PROTO_OA_CANCEL_ORDER_REQ: i32 = 2108;
const PROTO_OA_AMEND_ORDER_REQ: i32 = 2109;
const PROTO_OA_AMEND_POSITION_SLTP_REQ: i32 = 2110;
const PROTO_OA_CLOSE_POSITION_REQ: i32 = 2111;
const PROTO_OA_ASSET_LIST_REQ: i32 = 2112;
pub const PROTO_OA_ASSET_LIST_RES: i32 = 2113;
const PROTO_OA_SYMBOLS_LIST_REQ: i32 = 2114;
pub const PROTO_OA_SYMBOLS_LIST_RES: i32 = 2115;
const PROTO_OA_SYMBOL_BY_ID_REQ: i32 = 2116;
pub const PROTO_OA_SYMBOL_BY_ID_RES: i32 = 2117;
const PROTO_OA_TRADER_REQ: i32 = 2121;
pub const PROTO_OA_TRADER_RES: i32 = 2122;
const PROTO_OA_RECONCILE_REQ: i32 = 2124;
pub const PROTO_OA_RECONCILE_RES: i32 = 2125;
pub const PROTO_OA_EXECUTION_EVENT: i32 = 2126;
const PROTO_OA_SUBSCRIBE_SPOTS_REQ: i32 = 2127;
pub const PROTO_OA_SPOT_EVENT: i32 = 2131;
pub const PROTO_OA_ORDER_ERROR_EVENT: i32 = 2132;
const PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: i32 = 2149;
pub const PROTO_OA_ERROR_RES: i32 = 2142;
const PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ: i32 = 2187;
pub const PROTO_OA_GET_POSITION_UNREALIZED_PNL_RES: i32 = 2188;
const PROTO_OA_DEAL_LIST_REQ: i32 = 2133;
pub const PROTO_OA_DEAL_LIST_RES: i32 = 2134;

const OA_ORDER_TYPE_MARKET: i32 = 1;
const OA_ORDER_TYPE_LIMIT: i32 = 2;
const OA_ORDER_TYPE_STOP: i32 = 3;
const OA_TRADE_SIDE_BUY: i32 = 1;
const OA_TRADE_SIDE_SELL: i32 = 2;

fn encode_varint(mut v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 {
            out.push(b | 0x80);
        } else {
            out.push(b);
            break;
        }
    }
    out
}

fn encode_tag(field: u32, wire_type: u8) -> Vec<u8> {
    encode_varint(((field as u64) << 3) | (wire_type as u64))
}

fn encode_length_delimited(data: &[u8]) -> Vec<u8> {
    let mut out = encode_varint(data.len() as u64);
    out.extend_from_slice(data);
    out
}

fn encode_application_auth_req_inner(client_id: &str, client_secret: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_APPLICATION_AUTH_REQ as u64));
    out.extend(encode_tag(2, 2));
    out.extend(encode_length_delimited(client_id.as_bytes()));
    out.extend(encode_tag(3, 2));
    out.extend(encode_length_delimited(client_secret.as_bytes()));
    out
}

fn encode_get_account_list_req_inner(access_token: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ as u64));
    out.extend(encode_tag(2, 2));
    out.extend(encode_length_delimited(access_token.as_bytes()));
    out
}

pub const PROTO_HEARTBEAT_EVENT: i32 = 51;

pub fn encode_heartbeat() -> Vec<u8> {
    wrap_proto_message(PROTO_HEARTBEAT_EVENT, &[])
}

fn wrap_proto_message(payload_type: i32, inner: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(payload_type as u64));
    out.extend(encode_tag(2, 2));
    out.extend(encode_length_delimited(inner));
    out
}

pub fn parse_proto_message_wrapper(bytes: &[u8]) -> Option<(i32, Vec<u8>)> {
    let mut cur = Cursor::new(bytes);
    let mut payload_type = 0i32;
    let mut payload: Vec<u8> = Vec::new();
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).ok()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => payload_type = read_varint(&mut cur).ok()? as i32,
            (2, 2) => {
                let len = read_varint(&mut cur).ok()? as usize;
                payload.resize(len, 0);
                cur.read_exact(&mut payload).ok()?;
            }
            (_, 0) => { let _ = read_varint(&mut cur).ok()?; }
            (_, 2) => {
                let len = read_varint(&mut cur).ok()? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Some((payload_type, payload))
}

pub fn encode_application_auth_req(client_id: &str, client_secret: &str) -> Vec<u8> {
    let inner = encode_application_auth_req_inner(client_id, client_secret);
    wrap_proto_message(PROTO_OA_APPLICATION_AUTH_REQ, &inner)
}

pub fn encode_get_account_list_req(access_token: &str) -> Vec<u8> {
    let inner = encode_get_account_list_req_inner(access_token);
    wrap_proto_message(PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ, &inner)
}

fn read_varint(r: &mut impl Read) -> std::io::Result<u64> {
    let mut buf = [0u8; 1];
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        r.read_exact(&mut buf)?;
        result |= (buf[0] as u64 & 0x7F) << shift;
        if (buf[0] & 0x80) == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "varint overflow",
            ));
        }
    }
    Ok(result)
}

pub fn parse_payload_type(bytes: &[u8]) -> Option<i32> {
    let mut cur = Cursor::new(bytes);
    let tag = read_varint(&mut cur).ok()?;
    let field = (tag >> 3) as u32;
    let wire = (tag & 7) as u8;
    if field == 1 && wire == 0 {
        read_varint(&mut cur).ok().map(|v| v as i32)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct CtidTraderAccount {
    pub ctid_trader_account_id: u64,
    pub is_live: Option<bool>,
    pub broker_title_short: Option<String>,
}

pub fn parse_get_account_list_res_with_extra(
    bytes: &[u8],
) -> Result<(Vec<CtidTraderAccount>, Vec<CtidTraderAccountExtra>), String> {
    let mut cur = Cursor::new(bytes);
    let mut accounts = Vec::new();
    let mut extras = Vec::new();
    while cur.position() < bytes.len() as u64 {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                let _ = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (3, 0) => {
                let _ = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (4, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok((acc, extra)) = parse_ctid_trader_account_with_extra(&sub) {
                    accounts.push(acc);
                    extras.push(extra);
                }
            }
            (_, 0) => {
                let _ = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            _ => return Err("unsupported wire type".to_string()),
        }
    }
    Ok((accounts, extras))
}

#[derive(Debug, Clone, Default)]
pub struct CtidTraderAccountExtra {
    pub field_4_varint: Option<u64>,
    pub field_5_varint: Option<u64>,
}

fn parse_ctid_trader_account_with_extra(bytes: &[u8]) -> Result<(CtidTraderAccount, CtidTraderAccountExtra), String> {
    let mut cur = Cursor::new(bytes);
    let mut ctid_trader_account_id = 0u64;
    let mut is_live = None;
    let mut broker_title_short = None;
    let mut extra = CtidTraderAccountExtra::default();
    while cur.position() < bytes.len() as u64 {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                ctid_trader_account_id = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (2, 0) => {
                let v = read_varint(&mut cur).map_err(|e| e.to_string())?;
                is_live = Some(v != 0);
            }
            (3, 0) => {
                let _ = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (4, 0) => {
                let v = read_varint(&mut cur).map_err(|e| e.to_string())?;
                extra.field_4_varint = Some(v);
            }
            (5, 0) => {
                let v = read_varint(&mut cur).map_err(|e| e.to_string())?;
                extra.field_5_varint = Some(v);
            }
            (6, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                broker_title_short = Some(String::from_utf8_lossy(&b).into_owned());
            }
            (_, 0) => {
                let v = read_varint(&mut cur).map_err(|e| e.to_string())?;
                if field == 4 {
                    extra.field_4_varint = Some(v);
                } else if field == 5 {
                    extra.field_5_varint = Some(v);
                }
            }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((
        CtidTraderAccount {
            ctid_trader_account_id,
            is_live,
            broker_title_short,
        },
        extra,
    ))
}

pub fn is_error_res(bytes: &[u8]) -> bool {
    parse_payload_type(bytes) == Some(PROTO_OA_ERROR_RES)
}

pub fn parse_error_res(bytes: &[u8]) -> Option<(String, String)> {
    let mut cur = Cursor::new(bytes);
    let mut error_code = String::new();
    let mut description = String::new();
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).ok()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                let _ = read_varint(&mut cur).ok()?;
            }
            (2, 0) => {
                let v = read_varint(&mut cur).ok()?;
                error_code = v.to_string();
            }
            (2, 2) => {
                let len = read_varint(&mut cur).ok()? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).ok()?;
                error_code = String::from_utf8_lossy(&b).into_owned();
            }
            (3, 2) => {
                let len = read_varint(&mut cur).ok()? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).ok()?;
                description = String::from_utf8_lossy(&b).into_owned();
            }
            (_, 0) => {
                let _ = read_varint(&mut cur).ok()?;
            }
            (_, 2) => {
                let len = read_varint(&mut cur).ok()? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Some((error_code, description))
}

pub fn parse_order_error_event(bytes: &[u8]) -> Option<(i64, String, String)> {
    let mut cur = Cursor::new(bytes);
    let mut order_id: i64 = 0;
    let mut error_code = String::new();
    let mut description = String::new();
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).ok()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (2, 2) => {
                let len = read_varint(&mut cur).ok()? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).ok()?;
                error_code = String::from_utf8_lossy(&b).into_owned();
            }
            (3, 0) => order_id = read_varint(&mut cur).ok()? as i64,
            (7, 2) => {
                let len = read_varint(&mut cur).ok()? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).ok()?;
                description = String::from_utf8_lossy(&b).into_owned();
            }
            (_, 0) => { let _ = read_varint(&mut cur).ok()?; }
            (_, 2) => {
                let len = read_varint(&mut cur).ok()? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Some((order_id, error_code, description))
}

pub fn is_application_auth_res(bytes: &[u8]) -> bool {
    parse_payload_type(bytes) == Some(PROTO_OA_APPLICATION_AUTH_RES)
}


fn encode_account_auth_req_inner(ctid_trader_account_id: u64, access_token: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_ACCOUNT_AUTH_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 2));
    out.extend(encode_length_delimited(access_token.as_bytes()));
    out
}

pub fn encode_account_auth_req(ctid_trader_account_id: u64, access_token: &str) -> Vec<u8> {
    let inner = encode_account_auth_req_inner(ctid_trader_account_id, access_token);
    wrap_proto_message(PROTO_OA_ACCOUNT_AUTH_REQ, &inner)
}

fn encode_fixed64(v: f64) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

#[allow(clippy::too_many_arguments)]
pub fn encode_new_order_req(
    ctid_trader_account_id: u64,
    symbol_id: u64,
    order_type: &str,
    is_buy: bool,
    volume_centi_lots: i64,
    limit_price: Option<f64>,
    stop_price: Option<f64>,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
    comment: &str,
    label: &str,
    use_relative_sltp: Option<(f64, bool)>,
    position_id: Option<i64>,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_NEW_ORDER_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(symbol_id));
    let otype = match order_type.to_lowercase().as_str() {
        "limit" => OA_ORDER_TYPE_LIMIT,
        "stop" => OA_ORDER_TYPE_STOP,
        _ => OA_ORDER_TYPE_MARKET,
    };
    out.extend(encode_tag(4, 0));
    out.extend(encode_varint(otype as u64));
    out.extend(encode_tag(5, 0));
    out.extend(encode_varint(if is_buy { OA_TRADE_SIDE_BUY } else { OA_TRADE_SIDE_SELL } as u64));
    out.extend(encode_tag(6, 0));
    out.extend(encode_varint(volume_centi_lots as u64));
    if let Some(p) = limit_price {
        out.extend(encode_tag(7, 1));
        out.extend(encode_fixed64(p));
    }
    if let Some(p) = stop_price {
        out.extend(encode_tag(8, 1));
        out.extend(encode_fixed64(p));
    }
    let use_relative = use_relative_sltp.is_some() && (stop_loss.is_some() || take_profit.is_some());
    if use_relative {
        let (entry, is_buy_side) = use_relative_sltp.unwrap();
        if let Some(sl) = stop_loss {
            let rel = absolute_to_relative_sl(entry, sl, is_buy_side);
            out.extend(encode_tag(19, 0));
            out.extend(encode_varint(rel as u64));
        }
        if let Some(tp) = take_profit {
            let rel = absolute_to_relative_tp(entry, tp, is_buy_side);
            out.extend(encode_tag(20, 0));
            out.extend(encode_varint(rel as u64));
        }
    } else {
        if let Some(sl) = stop_loss {
            out.extend(encode_tag(11, 1));
            out.extend(encode_fixed64(sl));
        }
        if let Some(tp) = take_profit {
            out.extend(encode_tag(12, 1));
            out.extend(encode_fixed64(tp));
        }
    }
    if !comment.is_empty() {
        out.extend(encode_tag(13, 2));
        out.extend(encode_length_delimited(comment.as_bytes()));
    }
    if !label.is_empty() {
        out.extend(encode_tag(16, 2));
        out.extend(encode_length_delimited(label.as_bytes()));
    }
    if let Some(pid) = position_id {
        out.extend(encode_tag(17, 0));
        out.extend(encode_varint(pid as u64));
    }
    wrap_proto_message(PROTO_OA_NEW_ORDER_REQ, &out)
}

pub fn encode_close_position_req(ctid_trader_account_id: u64, position_id: i64, volume_centi_lots: i64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_CLOSE_POSITION_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(position_id as u64));
    out.extend(encode_tag(4, 0));
    out.extend(encode_varint(volume_centi_lots as u64));
    wrap_proto_message(PROTO_OA_CLOSE_POSITION_REQ, &out)
}

pub fn encode_amend_position_sltp_req(
    ctid_trader_account_id: u64,
    position_id: i64,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_AMEND_POSITION_SLTP_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(position_id as u64));
    if let Some(sl) = stop_loss {
        out.extend(encode_tag(4, 1));
        out.extend(encode_fixed64(sl));
    }
    if let Some(tp) = take_profit {
        out.extend(encode_tag(5, 1));
        out.extend(encode_fixed64(tp));
    }
    wrap_proto_message(PROTO_OA_AMEND_POSITION_SLTP_REQ, &out)
}

pub fn encode_amend_order_req(
    ctid_trader_account_id: u64,
    order_id: i64,
    volume_centi_lots: i64,
    limit_price: Option<f64>,
    stop_price: Option<f64>,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
    _entry_price: Option<f64>,
    _is_buy: bool,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_AMEND_ORDER_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(order_id as u64));
    out.extend(encode_tag(4, 0));
    out.extend(encode_varint(volume_centi_lots as u64));
    if let Some(p) = limit_price {
        out.extend(encode_tag(5, 1));
        out.extend(encode_fixed64(p));
    }
    if let Some(p) = stop_price {
        out.extend(encode_tag(6, 1));
        out.extend(encode_fixed64(p));
    }
    if let Some(sl) = stop_loss {
        out.extend(encode_tag(8, 1));
        out.extend(encode_fixed64(sl));
    }
    if let Some(tp) = take_profit {
        out.extend(encode_tag(9, 1));
        out.extend(encode_fixed64(tp));
    }
    wrap_proto_message(PROTO_OA_AMEND_ORDER_REQ, &out)
}

pub fn encode_cancel_order_req(ctid_trader_account_id: u64, order_id: i64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_CANCEL_ORDER_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(order_id as u64));
    wrap_proto_message(PROTO_OA_CANCEL_ORDER_REQ, &out)
}

pub fn encode_asset_list_req(ctid_trader_account_id: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_ASSET_LIST_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    wrap_proto_message(PROTO_OA_ASSET_LIST_REQ, &out)
}

pub fn parse_asset_list_res(payload: &[u8]) -> Result<HashMap<i64, String>, String> {
    let mut cur = Cursor::new(payload);
    let mut map = HashMap::new();
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (2, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (3, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok((id, name)) = parse_asset_inner(&sub) {
                    map.insert(id, name);
                }
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok(map)
}

fn parse_asset_inner(bytes: &[u8]) -> Result<(i64, String), String> {
    let mut cur = Cursor::new(bytes);
    let mut asset_id: i64 = 0;
    let mut name = String::new();
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => asset_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                name = String::from_utf8_lossy(&b).into_owned();
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 1) => { let mut b = [0u8; 8]; let _ = cur.read_exact(&mut b); }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((asset_id, name))
}

pub fn encode_trader_req(ctid_trader_account_id: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_TRADER_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    wrap_proto_message(PROTO_OA_TRADER_REQ, &out)
}

#[derive(Debug, Clone, Default)]
pub struct TraderInfo {
    pub balance: f64,
    pub equity: Option<f64>,
    pub leverage: Option<i32>,
    pub broker_name: Option<String>,
    pub currency_deposit_asset_id: Option<i64>,
}

pub fn parse_trader_res(payload: &[u8]) -> Result<TraderInfo, String> {
    let mut cur = Cursor::new(payload);
    let mut inner_trader: Option<Vec<u8>> = None;
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (2, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (3, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                inner_trader = Some(sub);
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    let (balance_raw, money_digits, leverage_in_cents, broker_name, deposit_asset_id) =
        match inner_trader {
            Some(sub) => parse_trader_inner(&sub)?,
            None => return Err("ProtoOATraderRes: missing trader".into()),
        };
    let balance = scale_money(balance_raw, money_digits);
    let leverage = leverage_in_cents.map(|c| (c / 100) as i32);
    Ok(TraderInfo {
        balance,
        equity: None,
        leverage,
        broker_name,
        currency_deposit_asset_id: deposit_asset_id,
    })
}

fn parse_trader_inner(bytes: &[u8]) -> Result<(i64, u32, Option<u32>, Option<String>, Option<i64>), String> {
    let mut cur = Cursor::new(bytes);
    let mut balance: i64 = 0;
    let mut money_digits: u32 = 8;
    let mut leverage_in_cents: Option<u32> = None;
    let mut broker_name: Option<String> = None;
    let mut deposit_asset_id: Option<i64> = None;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (2, 0) => balance = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (3, 0) | (4, 0) | (5, 0) | (6, 0) | (7, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (8, 0) => deposit_asset_id = Some(read_varint(&mut cur).map_err(|e| e.to_string())? as i64),
            (9, 0) | (11, 0) | (12, 0) | (13, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (10, 0) => leverage_in_cents = Some(read_varint(&mut cur).map_err(|e| e.to_string())? as u32),
            (14, 0) => {
                let _ = read_varint(&mut cur).map_err(|e| e.to_string())?;
            }
            (16, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                broker_name = Some(String::from_utf8_lossy(&b).into_owned());
            }
            (20, 0) => money_digits = read_varint(&mut cur).map_err(|e| e.to_string())? as u32,
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 1) => { let mut b = [0u8; 8]; let _ = cur.read_exact(&mut b); }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((balance, money_digits, leverage_in_cents, broker_name, deposit_asset_id))
}

pub fn encode_subscribe_spots_req(ctid_trader_account_id: u64, symbol_ids: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_SUBSCRIBE_SPOTS_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    for sid in symbol_ids {
        out.extend(encode_tag(3, 0));
        out.extend(encode_varint(*sid));
    }
    out.extend(encode_tag(4, 0));
    out.extend(encode_varint(1));
    wrap_proto_message(PROTO_OA_SUBSCRIBE_SPOTS_REQ, &out)
}

pub fn parse_spot_event_timestamp(bytes: &[u8]) -> Option<i64> {
    let mut cur = Cursor::new(bytes);
    let mut ts: Option<i64> = None;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).ok()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (8, 0) => ts = Some(read_varint(&mut cur).ok()? as i64),
            (_, 0) => { let _ = read_varint(&mut cur).ok()?; }
            (_, 2) => {
                let len = read_varint(&mut cur).ok()? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => return ts,
        }
    }
    ts
}

pub fn encode_reconcile_req(ctid_trader_account_id: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_RECONCILE_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    wrap_proto_message(PROTO_OA_RECONCILE_REQ, &out)
}

pub fn encode_symbols_list_req(ctid_trader_account_id: u64) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_SYMBOLS_LIST_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    out.extend(encode_tag(3, 0));
    out.extend(encode_varint(1));
    wrap_proto_message(PROTO_OA_SYMBOLS_LIST_REQ, &out)
}

pub fn encode_symbol_by_id_req(ctid_trader_account_id: u64, symbol_ids: &[u64]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(encode_tag(1, 0));
    out.extend(encode_varint(PROTO_OA_SYMBOL_BY_ID_REQ as u64));
    out.extend(encode_tag(2, 0));
    out.extend(encode_varint(ctid_trader_account_id));
    for &sid in symbol_ids {
        out.extend(encode_tag(3, 0));
        out.extend(encode_varint(sid));
    }
    wrap_proto_message(PROTO_OA_SYMBOL_BY_ID_REQ, &out)
}

pub struct FullSymbolByIdResult {
    pub lot_sizes: HashMap<u64, i64>,
    pub min_volumes: HashMap<u64, i64>,
    pub max_volumes: HashMap<u64, i64>,
    pub volume_steps: HashMap<u64, i64>,
    pub digits: HashMap<u64, u32>,
    pub resolved_names: HashMap<u64, String>,
}

pub fn parse_symbol_by_id_res_full(payload: &[u8]) -> Result<FullSymbolByIdResult, String> {
    let mut cur = Cursor::new(payload);
    let mut lot_sizes = HashMap::new();
    let mut min_volumes = HashMap::new();
    let mut max_volumes = HashMap::new();
    let mut volume_steps = HashMap::new();
    let mut digits_map = HashMap::new();
    let mut resolved_names = HashMap::new();
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        if (field == 3 || field == 4) && wire == 2 {
            let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
            let mut sub = vec![0u8; len];
            cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
            if field == 4 {
                if let Ok(ls) = parse_light_symbol(&sub) {
                    if !ls.symbol_name.is_empty() {
                        resolved_names.insert(ls.symbol_id, ls.symbol_name);
                    }
                }
            } else {
                if let Ok(meta) = parse_full_symbol_volume_meta(&sub) {
                    lot_sizes.insert(meta.symbol_id, meta.lot_size);
                    min_volumes.insert(meta.symbol_id, meta.min_volume);
                    max_volumes.insert(meta.symbol_id, meta.max_volume);
                    volume_steps.insert(meta.symbol_id, meta.step_volume);
                    digits_map.insert(meta.symbol_id, meta.digits);
                }
            }
        } else {
            skip_field(&mut cur, wire)?;
        }
    }
    Ok(FullSymbolByIdResult {
        lot_sizes,
        min_volumes,
        max_volumes,
        volume_steps,
        digits: digits_map,
        resolved_names,
    })
}

struct SymbolVolumeMeta {
    symbol_id: u64,
    lot_size: i64,
    min_volume: i64,
    max_volume: i64,
    step_volume: i64,
    digits: u32,
}

fn parse_full_symbol_volume_meta(bytes: &[u8]) -> Result<SymbolVolumeMeta, String> {
    let mut cur = Cursor::new(bytes);
    let mut symbol_id: u64 = 0;
    let mut lot_size: i64 = 0;
    let mut has_lot_size = false;
    let mut min_volume: i64 = 1;
    let mut max_volume: i64 = 0;
    let mut step_volume: i64 = 1;
    let mut digits: u32 = 0;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => symbol_id = read_varint(&mut cur).map_err(|e| e.to_string())? as u64,
            (2, 0) => digits = read_varint(&mut cur).map_err(|e| e.to_string())? as u32,
            (9, 0) => {
                max_volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64;
            }
            (10, 0) => {
                min_volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64;
            }
            (11, 0) => {
                step_volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64;
            }
            (30, 0) => {
                lot_size = read_varint(&mut cur).map_err(|e| e.to_string())? as i64;
                has_lot_size = true;
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    if !has_lot_size || lot_size <= 0 {
        lot_size = 10_000_000;
    }
    if step_volume <= 0 {
        step_volume = 1;
    }
    if min_volume <= 0 {
        min_volume = step_volume.max(1);
    }
    if max_volume > 0 && min_volume > max_volume {
        std::mem::swap(&mut min_volume, &mut max_volume);
    }
    Ok(SymbolVolumeMeta { symbol_id, lot_size, min_volume, max_volume, step_volume, digits })
}

pub fn encode_get_position_unrealized_pnl_req(ctid_trader_account_id: u64) -> Vec<u8> {
    let mut inner = Vec::new();
    inner.extend(encode_tag(1, 0));
    inner.extend(encode_varint(PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ as u64));
    inner.extend(encode_tag(2, 0));
    inner.extend(encode_varint(ctid_trader_account_id));
    wrap_proto_message(PROTO_OA_GET_POSITION_UNREALIZED_PNL_REQ, &inner)
}

fn scale_money(value: i64, money_digits: u32) -> f64 {
    if money_digits == 0 {
        return value as f64;
    }
    let divisor = 10_f64.powi(money_digits as i32);
    (value as f64) / divisor
}

#[derive(Debug, Clone)]
pub struct SlavePosition {
    pub position_id: i64,
    pub symbol_id: u64,
    pub volume: f64,
    pub comment: String,
    pub label: String,
    pub open_price: f64,
    pub open_timestamp_ms: i64,
    pub trade_side: i32,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub swap: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct SlaveOrder {
    pub order_id: i64,
    pub symbol_id: u64,
    pub volume: f64,
    pub comment: String,
    pub label: String,
    pub price: Option<f64>,
    pub order_type: i32,
    pub trade_side: i32,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
}

fn volume_protocol_to_lots(volume_protocol: i64, symbol_id: u64, symbol_lot_sizes: &HashMap<u64, i64>) -> f64 {
    let lot_size = *symbol_lot_sizes.get(&symbol_id).unwrap_or(&10_000_000);
    let safe_lot_size = if lot_size > 0 { lot_size as f64 } else { 10_000_000.0 };
    (volume_protocol as f64) / safe_lot_size
}

pub fn parse_reconcile_res(
    payload: &[u8],
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_digits: &HashMap<u64, u32>,
) -> Result<(Vec<SlavePosition>, Vec<SlaveOrder>), String> {
    let mut cur = Cursor::new(payload);
    let mut positions = Vec::new();
    let mut orders = Vec::new();
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (2, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (3, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok(p) = parse_position_inner(&sub, symbol_lot_sizes) {
                    positions.push(p);
                }
            }
            (4, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok(o) = parse_order_inner(&sub, symbol_lot_sizes, symbol_digits) {
                    orders.push(o);
                }
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((positions, orders))
}

fn parse_position_inner(bytes: &[u8], symbol_lot_sizes: &HashMap<u64, i64>) -> Result<SlavePosition, String> {
    let mut cur = Cursor::new(bytes);
    let mut position_id: i64 = 0;
    let mut symbol_id: u64 = 0;
    let mut volume: i64 = 0;
    let mut trade_side = 1i32;
    let mut comment = String::new();
    let mut label = String::new();
    let mut open_price = 0f64;
    let mut open_timestamp_ms: i64 = 0;
    let mut stop_loss: Option<f64> = None;
    let mut take_profit: Option<f64> = None;
    let mut swap_raw: i64 = 0;
    let mut money_digits: u32 = 8;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => position_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                let (sid, vol, side, cmt, ts_ms, lbl) = parse_trade_data(&sub)?;
                symbol_id = sid;
                volume = vol;
                trade_side = side;
                comment = cmt;
                label = lbl;
                open_timestamp_ms = ts_ms;
            }
            (5, 1) => {
                let mut buf = [0u8; 8];
                cur.read_exact(&mut buf).map_err(|e| e.to_string())?;
                open_price = f64::from_le_bytes(buf);
            }
            (4, 0) => swap_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (6, 1) => stop_loss = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (7, 1) => take_profit = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (15, 0) => money_digits = read_varint(&mut cur).map_err(|e| e.to_string())? as u32,
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { let mut b = [0u8; 8]; let _ = cur.read_exact(&mut b); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    let swap = Some(scale_money(swap_raw, money_digits));
    let volume_lots = volume_protocol_to_lots(volume, symbol_id, symbol_lot_sizes);
    Ok(SlavePosition {
        position_id,
        symbol_id,
        volume: volume_lots,
        comment,
        label,
        open_price,
        open_timestamp_ms,
        trade_side,
        stop_loss,
        take_profit,
        swap,
    })
}

fn price_decimal_digits(price: f64) -> u32 {
    if !price.is_finite() || price == 0.0 {
        return 5;
    }
    let s = format!("{:.10}", price).trim_end_matches('0').to_string();
    if let Some(dot) = s.find('.') {
        (s.len() - dot - 1).min(8) as u32
    } else {
        5
    }
}

fn round_to_digits(value: f64, digits: u32) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let factor = 10_f64.powi(digits as i32);
    (value * factor).round() / factor
}

fn relative_to_absolute_sl(
    entry_price: f64,
    relative: i64,
    trade_side: i32,
    price_digits: u32,
) -> f64 {
    let rel_f = relative as f64 / 100_000.0;
    let abs_price = if trade_side == 1 {
        entry_price - rel_f
    } else {
        entry_price + rel_f
    };
    round_to_digits(abs_price, price_digits)
}

fn relative_to_absolute_tp(
    entry_price: f64,
    relative: i64,
    trade_side: i32,
    price_digits: u32,
) -> f64 {
    let rel_f = relative as f64 / 100_000.0;
    let abs_price = if trade_side == 1 {
        entry_price + rel_f
    } else {
        entry_price - rel_f
    };
    round_to_digits(abs_price, price_digits)
}

pub fn absolute_to_relative_sl(entry_price: f64, sl_abs: f64, is_buy: bool) -> i64 {
    let dist = if is_buy {
        entry_price - sl_abs
    } else {
        sl_abs - entry_price
    };
    (dist * 100_000.0).round().max(0.0) as i64
}

pub fn absolute_to_relative_tp(entry_price: f64, tp_abs: f64, is_buy: bool) -> i64 {
    let dist = if is_buy {
        tp_abs - entry_price
    } else {
        entry_price - tp_abs
    };
    (dist * 100_000.0).round().max(0.0) as i64
}

fn parse_order_inner(
    bytes: &[u8],
    symbol_lot_sizes: &HashMap<u64, i64>,
    symbol_digits: &HashMap<u64, u32>,
) -> Result<SlaveOrder, String> {
    let mut cur = Cursor::new(bytes);
    let mut order_id: i64 = 0;
    let mut symbol_id: u64 = 0;
    let mut volume: i64 = 0;
    let mut trade_side = 1i32;
    let mut comment = String::new();
    let mut label = String::new();
    let mut order_type = 2i32;
    let mut limit_price: Option<f64> = None;
    let mut stop_price: Option<f64> = None;
    let mut stop_loss: Option<f64> = None;
    let mut take_profit: Option<f64> = None;
    let mut relative_stop_loss: Option<i64> = None;
    let mut relative_take_profit: Option<i64> = None;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => order_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                let (sid, vol, side, cmt, _ts_ms, lbl) = parse_trade_data(&sub)?;
                symbol_id = sid;
                volume = vol;
                trade_side = side;
                comment = cmt;
                label = lbl;
            }
            (3, 0) => order_type = read_varint(&mut cur).map_err(|e| e.to_string())? as i32,
            (13, 1) => limit_price = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (14, 1) => stop_price = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (15, 1) => stop_loss = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (16, 1) => take_profit = Some(read_fixed64(&mut cur).map_err(|e| e.to_string())?),
            (20, 0) => relative_stop_loss = Some(read_varint(&mut cur).map_err(|e| e.to_string())? as i64),
            (21, 0) => relative_take_profit = Some(read_varint(&mut cur).map_err(|e| e.to_string())? as i64),
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { let _ = read_fixed64(&mut cur).map_err(|e| e.to_string())?; }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    let price = limit_price.or(stop_price);
    let entry_price = price.unwrap_or(0.0);
    let price_digits = symbol_digits
        .get(&symbol_id)
        .copied()
        .unwrap_or_else(|| price_decimal_digits(entry_price));
    let stop_loss = stop_loss.or_else(|| {
        relative_stop_loss.map(|r| relative_to_absolute_sl(entry_price, r, trade_side, price_digits))
    });
    let take_profit = take_profit.or_else(|| {
        relative_take_profit.map(|r| relative_to_absolute_tp(entry_price, r, trade_side, price_digits))
    });
    let volume_lots = volume_protocol_to_lots(volume, symbol_id, symbol_lot_sizes);
    Ok(SlaveOrder {
        order_id,
        symbol_id,
        volume: volume_lots,
        comment,
        label,
        price,
        order_type,
        trade_side,
        stop_loss,
        take_profit,
    })
}

fn read_fixed64(r: &mut impl Read) -> std::io::Result<f64> {
    let mut buf = [0u8; 8];
    r.read_exact(&mut buf)?;
    Ok(f64::from_le_bytes(buf))
}

fn parse_trade_data(bytes: &[u8]) -> Result<(u64, i64, i32, String, i64, String), String> {
    let mut cur = Cursor::new(bytes);
    let mut symbol_id: u64 = 0;
    let mut volume: i64 = 0;
    let mut trade_side = 1i32;
    let mut comment = String::new();
    let mut label = String::new();
    let mut open_timestamp_ms: i64 = 0;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => symbol_id = read_varint(&mut cur).map_err(|e| e.to_string())? as u64,
            (2, 0) => volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (3, 0) => trade_side = read_varint(&mut cur).map_err(|e| e.to_string())? as i32,
            (4, 0) => open_timestamp_ms = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (7, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                comment = String::from_utf8_lossy(&b).into_owned();
            }
            (8, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                label = String::from_utf8_lossy(&b).into_owned();
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((symbol_id, volume, trade_side, comment, open_timestamp_ms, label))
}

pub struct SymbolsListResult {
    pub by_name: std::collections::HashMap<String, u64>,
    pub id_to_name: std::collections::HashMap<u64, String>,
    pub unnamed_ids: Vec<u64>,
    pub unnamed_asset_pairs: Vec<(u64, i64, i64)>,
}

pub fn parse_symbols_list_res(payload: &[u8]) -> Result<SymbolsListResult, String> {
    let mut cur = Cursor::new(payload);
    let mut by_name = std::collections::HashMap::new();
    let mut id_to_name: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
    let mut unnamed_ids = Vec::new();
    let mut unnamed_asset_pairs = Vec::new();
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        if (field == 3 || field == 4) && wire == 2 {
            let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
            let mut sub = vec![0u8; len];
            cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
            let parsed = parse_light_symbol(&sub).or_else(|_| parse_archived_symbol_minimal(&sub));
            if let Ok(ls) = parsed {
                if !ls.symbol_name.is_empty() {
                    by_name.insert(ls.symbol_name.clone(), ls.symbol_id);
                    id_to_name.entry(ls.symbol_id).or_insert(ls.symbol_name);
                } else if ls.symbol_id > 0 {
                    unnamed_ids.push(ls.symbol_id);
                    if ls.base_asset_id > 0 && ls.quote_asset_id > 0 {
                        unnamed_asset_pairs.push((ls.symbol_id, ls.base_asset_id, ls.quote_asset_id));
                    }
                }
            }
        } else {
            skip_field(&mut cur, wire)?;
        }
    }
    Ok(SymbolsListResult { by_name, id_to_name, unnamed_ids, unnamed_asset_pairs })
}

pub fn parse_get_position_unrealized_pnl_res(payload: &[u8]) -> Result<HashMap<i64, f64>, String> {
    let mut cur = Cursor::new(payload);
    let mut money_digits: u32 = 8;
    let mut entries: Vec<(i64, i64)> = Vec::new();
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (3, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                let (pos_id, net_pnl) = parse_position_unrealized_pnl_inner(&sub)?;
                entries.push((pos_id, net_pnl));
            }
            (4, 0) => money_digits = read_varint(&mut cur).map_err(|e| e.to_string())? as u32,
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    const MAX_REASONABLE_PROFIT: f64 = 1e12;
    let out: HashMap<i64, f64> = entries
        .into_iter()
        .map(|(pos_id, net_pnl)| {
            let scaled = scale_money(net_pnl, money_digits);
            let clamped = if scaled.abs() > MAX_REASONABLE_PROFIT {
                0.0
            } else {
                scaled
            };
            (pos_id, clamped)
        })
        .collect();
    Ok(out)
}

fn parse_position_unrealized_pnl_inner(bytes: &[u8]) -> Result<(i64, i64), String> {
    let mut cur = Cursor::new(bytes);
    let mut position_id: i64 = 0;
    let mut net_unrealized_pnl: i64 = 0;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => position_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (2, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (3, 0) => {
                let raw = read_varint(&mut cur).map_err(|e| e.to_string())?;
                net_unrealized_pnl = raw as i64;
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok((position_id, net_unrealized_pnl))
}

pub struct LightSymbolParsed {
    pub symbol_id: u64,
    pub symbol_name: String,
    pub base_asset_id: i64,
    pub quote_asset_id: i64,
}

fn parse_archived_symbol_minimal(bytes: &[u8]) -> Result<LightSymbolParsed, String> {
    let mut cur = Cursor::new(bytes);
    let mut symbol_id: u64 = 0;
    let mut symbol_name = String::new();
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => symbol_id = read_varint(&mut cur).map_err(|e| e.to_string())? as u64,
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                symbol_name = String::from_utf8_lossy(&b).into_owned();
            }
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => {}
        }
    }
    Ok(LightSymbolParsed { symbol_id, symbol_name, base_asset_id: 0, quote_asset_id: 0 })
}

fn parse_light_symbol(bytes: &[u8]) -> Result<LightSymbolParsed, String> {
    let mut cur = Cursor::new(bytes);
    let mut symbol_id: u64 = 0;
    let mut symbol_name = String::new();
    let mut base_asset_id: i64 = 0;
    let mut quote_asset_id: i64 = 0;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => symbol_id = read_varint(&mut cur).map_err(|e| e.to_string())? as u64,
            (2, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut b = vec![0u8; len];
                cur.read_exact(&mut b).map_err(|e| e.to_string())?;
                symbol_name = String::from_utf8_lossy(&b).into_owned();
            }
            (4, 0) => base_asset_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (5, 0) => quote_asset_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (_, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (_, 1) => { cur.set_position(cur.position() + 8); }
            (_, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as u64;
                cur.set_position(cur.position() + len);
            }
            (_, 5) => { cur.set_position(cur.position() + 4); }
            _ => { break; }
        }
    }
    Ok(LightSymbolParsed { symbol_id, symbol_name, base_asset_id, quote_asset_id })
}

fn skip_field(cur: &mut Cursor<&[u8]>, wire: u8) -> Result<(), String> {
    match wire {
        0 => { let _ = read_varint(cur).map_err(|e| e.to_string())?; }
        1 => { cur.set_position(cur.position() + 8); }
        2 => {
            let len = read_varint(cur).map_err(|e| e.to_string())? as u64;
            cur.set_position(cur.position() + len);
        }
        5 => { cur.set_position(cur.position() + 4); }
        _ => {}
    }
    Ok(())
}


#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UnifiedExecutionEvent {
    Placed {
        ticket: i64,
        symbol: String,
        #[serde(rename = "type")]
        order_type: String,
        side: String,
        volume: f64,
        price: f64,
        sl: Option<f64>,
        tp: Option<f64>,
        age_seconds: u64,
    },
    Modified {
        ticket: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        symbol: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<f64>,
        sl: Option<f64>,
        tp: Option<f64>,
        price: f64,
        age_seconds: u64,
    },
    Closed {
        ticket: i64,
        #[serde(skip_serializing)]
        volume: Option<f64>,
    },
}

impl UnifiedExecutionEvent {
    pub fn to_json_line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn ticket(&self) -> i64 {
        match self {
            UnifiedExecutionEvent::Placed { ticket, .. }
            | UnifiedExecutionEvent::Modified { ticket, .. }
            | UnifiedExecutionEvent::Closed { ticket, .. } => *ticket,
        }
    }

    pub fn volume(&self) -> Option<f64> {
        match self {
            UnifiedExecutionEvent::Placed { volume, .. } => Some(*volume),
            UnifiedExecutionEvent::Modified { volume, .. } => *volume,
            UnifiedExecutionEvent::Closed { volume, .. } => *volume,
        }
    }

    pub fn event_summary_for_log(&self) -> String {
        match self {
            UnifiedExecutionEvent::Placed { ticket, symbol, order_type, side, volume, price, sl, tp, age_seconds } => {
                format!(
                    "Placed ticket={} symbol={} type={} side={} volume={:.4} price={} sl={:?} tp={:?} age={}s",
                    ticket, symbol, order_type, side, volume, price, sl, tp, age_seconds
                )
            }
            UnifiedExecutionEvent::Modified { ticket, symbol, volume, sl, tp, price, age_seconds } => {
                format!(
                    "Modified ticket={} symbol={:?} volume={:?} price={} sl={:?} tp={:?} age={}s",
                    ticket, symbol, volume, price, sl, tp, age_seconds
                )
            }
            UnifiedExecutionEvent::Closed { ticket, volume, .. } => {
                format!("Closed ticket={} volume={:?}", ticket, volume)
            }
        }
    }
}


#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterPositionRow {
    pub position_id: i64,
    pub symbol: String,
    pub volume: f64,
    pub side: String,
    pub price: f64,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub open_timestamp_ms: i64,
    pub swap: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MasterOrderRow {
    pub order_id: i64,
    pub symbol: String,
    pub volume: f64,
    pub side: String,
    pub order_type: String,
    pub price: Option<f64>,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
}

pub fn build_master_snapshot(
    positions: &[SlavePosition],
    orders: &[SlaveOrder],
    symbol_id_to_name: &HashMap<u64, String>,
) -> (HashMap<i64, MasterPositionRow>, HashMap<i64, MasterOrderRow>) {
    let mut pos_map = HashMap::new();
    for p in positions {
        let symbol = symbol_id_to_name
            .get(&(p.symbol_id as u64))
            .cloned()
            .unwrap_or_default();
        let side = if p.trade_side == 1 { "buy" } else { "sell" };
        pos_map.insert(
            p.position_id,
            MasterPositionRow {
                position_id: p.position_id,
                symbol,
                volume: p.volume,
                side: side.to_string(),
                price: p.open_price,
                sl: p.stop_loss,
                tp: p.take_profit,
                open_timestamp_ms: p.open_timestamp_ms,
                swap: p.swap,
            },
        );
    }
    let mut ord_map = HashMap::new();
    for o in orders {
        let symbol = match symbol_id_to_name.get(&o.symbol_id).cloned() {
            Some(v) => v,
            None => continue,
        };
        let side = if o.trade_side == 1 { "buy" } else { "sell" };
        let order_type = match o.order_type {
            1 => "market",
            2 => "limit",
            3 => "stop",
            _ => "market",
        };
        ord_map.insert(
            o.order_id,
            MasterOrderRow {
                order_id: o.order_id,
                symbol,
                volume: o.volume,
                side: side.to_string(),
                order_type: order_type.to_string(),
                price: o.price,
                sl: o.stop_loss,
                tp: o.take_profit,
            },
        );
    }
    (pos_map, ord_map)
}

fn opt_eq(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

pub fn detect_fills(
    prev_orders: &HashMap<i64, MasterOrderRow>,
    curr_orders: &HashMap<i64, MasterOrderRow>,
    curr_positions: &HashMap<i64, MasterPositionRow>,
    prev_positions: &HashMap<i64, MasterPositionRow>,
) -> Vec<(i64, i64)> {
    let disappeared_orders: Vec<&MasterOrderRow> = prev_orders
        .values()
        .filter(|o| {
            !curr_orders.contains_key(&o.order_id)
                && !o.order_type.eq_ignore_ascii_case("market")
        })
        .collect();

    let new_positions: Vec<&MasterPositionRow> = curr_positions
        .values()
        .filter(|p| !prev_positions.contains_key(&p.position_id))
        .collect();

    let mut fills: Vec<(i64, i64)> = Vec::new();
    let mut used_pos_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for ord in disappeared_orders {
        if let Some(pos) = new_positions.iter().find(|p| {
            !used_pos_ids.contains(&p.position_id)
                && p.symbol == ord.symbol
                && p.side == ord.side
        }) {
            used_pos_ids.insert(pos.position_id);
            fills.push((pos.position_id, ord.order_id));
        }
    }
    fills
}

pub fn diff_master_snapshots(
    prev_positions: &HashMap<i64, MasterPositionRow>,
    prev_orders: &HashMap<i64, MasterOrderRow>,
    curr_positions: &HashMap<i64, MasterPositionRow>,
    curr_orders: &HashMap<i64, MasterOrderRow>,
    pos_id_to_ord_id: &mut HashMap<i64, i64>,
    server_now_ms: i64,
) -> (Vec<UnifiedExecutionEvent>, bool) {
    let mut out = Vec::new();

    let fills = detect_fills(prev_orders, curr_orders, curr_positions, prev_positions);
    let had_fills = !fills.is_empty();
    for (pos_id, ord_id) in fills {
        pos_id_to_ord_id.entry(pos_id).or_insert(ord_id);
    }

    let ticket_map_before_retain = pos_id_to_ord_id.clone();
    let before_len = pos_id_to_ord_id.len();
    pos_id_to_ord_id.retain(|pos_id, _| curr_positions.contains_key(pos_id));
    let mapping_changed = had_fills || pos_id_to_ord_id.len() != before_len;

    let filled_pos_ids: std::collections::HashSet<i64> = pos_id_to_ord_id.keys().copied().collect();

    let age_from_pos = |pos: &MasterPositionRow| -> u64 {
        if pos.open_timestamp_ms > 0 {
            (server_now_ms - pos.open_timestamp_ms).max(0) as u64 / 1000
        } else {
            0
        }
    };

    for (id, pos) in curr_positions {
        if !prev_positions.contains_key(id) {
            if pos_id_to_ord_id.contains_key(id) {
                continue;
            }
            let ticket = pos_id_to_ord_id.get(id).copied().unwrap_or(*id);
            out.push(UnifiedExecutionEvent::Placed {
                ticket,
                symbol: pos.symbol.clone(),
                order_type: "market".to_string(),
                side: pos.side.clone(),
                volume: pos.volume,
                price: pos.price,
                sl: pos.sl,
                tp: pos.tp,
                age_seconds: age_from_pos(pos),
            });
        } else {
            let prev = prev_positions.get(id).unwrap();
            let vol_changed = prev.volume != pos.volume;
            let price_changed = prev.price != pos.price;
            let sl_changed = !opt_eq(prev.sl, pos.sl);
            let tp_changed = !opt_eq(prev.tp, pos.tp);
            if vol_changed || price_changed || sl_changed || tp_changed {
                let ticket = pos_id_to_ord_id.get(id).copied().unwrap_or(*id);
                out.push(UnifiedExecutionEvent::Modified {
                    ticket,
                    symbol: Some(pos.symbol.clone()),
                    volume: Some(pos.volume),
                    sl: pos.sl,
                    tp: pos.tp,
                    price: pos.price,
                    age_seconds: age_from_pos(pos),
                });
            }
        }
    }
    for (id, prev) in prev_positions {
        if !curr_positions.contains_key(id) {
            let ticket = ticket_map_before_retain
                .get(id)
                .copied()
                .unwrap_or(*id);
            out.push(UnifiedExecutionEvent::Closed {
                ticket,
                volume: Some(prev.volume),
            });
        }
    }

    for (id, ord) in curr_orders {
        if !prev_orders.contains_key(id) {
            if ord.order_type.eq_ignore_ascii_case("market") {
                continue;
            }
            out.push(UnifiedExecutionEvent::Placed {
                ticket: *id,
                symbol: ord.symbol.clone(),
                order_type: ord.order_type.clone(),
                side: ord.side.clone(),
                volume: ord.volume,
                price: ord.price.unwrap_or(0.0),
                sl: ord.sl,
                tp: ord.tp,
                age_seconds: 0,
            });
        } else {
            let prev = prev_orders.get(id).unwrap();
            let vol_changed = prev.volume != ord.volume;
            let price_changed = !opt_eq(prev.price, ord.price);
            let sl_changed = !opt_eq(prev.sl, ord.sl);
            let tp_changed = !opt_eq(prev.tp, ord.tp);
            if vol_changed || price_changed || sl_changed || tp_changed {
                out.push(UnifiedExecutionEvent::Modified {
                    ticket: *id,
                    symbol: Some(ord.symbol.clone()),
                    volume: Some(ord.volume),
                    sl: ord.sl,
                    tp: ord.tp,
                    price: ord.price.unwrap_or(0.0),
                    age_seconds: 0,
                });
            }
        }
    }
    for (id, prev) in prev_orders {
        if !curr_orders.contains_key(id) {
            if prev.order_type.eq_ignore_ascii_case("market") {
                continue;
            }
            if filled_pos_ids.iter().any(|pos_id| {
                pos_id_to_ord_id.get(pos_id).copied() == Some(*id)
            }) {
                continue;
            }
            out.push(UnifiedExecutionEvent::Closed {
                ticket: *id,
                volume: Some(prev.volume),
            });
        }
    }
    (out, mapping_changed)
}

pub fn encode_deal_list_req(
    ctid_trader_account_id: u64,
    from_timestamp_ms: i64,
    to_timestamp_ms: i64,
    max_rows: i32,
) -> Vec<u8> {
    let mut inner = Vec::new();
    inner.extend(encode_tag(1, 0));
    inner.extend(encode_varint(PROTO_OA_DEAL_LIST_REQ as u64));
    inner.extend(encode_tag(2, 0));
    inner.extend(encode_varint(ctid_trader_account_id));
    inner.extend(encode_tag(3, 0));
    inner.extend(encode_varint(from_timestamp_ms.max(0) as u64));
    inner.extend(encode_tag(4, 0));
    inner.extend(encode_varint(to_timestamp_ms.max(0) as u64));
    inner.extend(encode_tag(5, 0));
    inner.extend(encode_varint(max_rows.max(0) as u64));
    wrap_proto_message(PROTO_OA_DEAL_LIST_REQ, &inner)
}

#[derive(Debug, Clone, Default)]
pub struct ClosePositionDetail {
    pub entry_price: Option<f64>,
    pub gross_profit_raw: i64,
    pub swap_raw: i64,
    pub commission_raw: i64,
    pub closed_volume: i64,
    pub balance_raw: i64,
    pub pnl_conversion_fee_raw: i64,
    pub has_close_detail: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ProtoOADeal {
    pub deal_id: i64,
    pub order_id: i64,
    pub position_id: i64,
    pub volume: i64,
    pub filled_volume: i64,
    pub symbol_id: u64,
    pub create_timestamp_ms: i64,
    pub execution_timestamp_ms: i64,
    pub last_update_timestamp_ms: i64,
    pub execution_price: Option<f64>,
    pub trade_side: i32,
    pub deal_status: i32,
    pub commission_raw: i64,
    pub money_digits: u32,
    pub close_detail: ClosePositionDetail,
}

pub fn parse_deal_list_res(
    payload: &[u8],
) -> Result<(Vec<ProtoOADeal>, bool), String> {
    let mut cur = Cursor::new(payload);
    let mut deals = Vec::new();
    let mut has_more = false;
    while (cur.position() as usize) < payload.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (2, 0) => { let _ = read_varint(&mut cur).map_err(|e| e.to_string())?; }
            (3, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok(d) = parse_deal_inner(&sub) {
                    deals.push(d);
                }
            }
            (4, 0) => {
                let v = read_varint(&mut cur).map_err(|e| e.to_string())?;
                has_more = v != 0;
            }
            _ => skip_field(&mut cur, wire)?,
        }
    }
    Ok((deals, has_more))
}

fn parse_deal_inner(bytes: &[u8]) -> Result<ProtoOADeal, String> {
    let mut cur = Cursor::new(bytes);
    let mut d = ProtoOADeal::default();
    d.money_digits = 2;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 0) => d.deal_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (2, 0) => d.order_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (3, 0) => d.position_id = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (4, 0) => d.volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (5, 0) => d.filled_volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (6, 0) => d.symbol_id = read_varint(&mut cur).map_err(|e| e.to_string())?,
            (7, 0) => d.create_timestamp_ms = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (8, 0) => d.execution_timestamp_ms = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (9, 0) => d.last_update_timestamp_ms = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (10, 1) => {
                let v = read_fixed64(&mut cur).map_err(|e| e.to_string())?;
                d.execution_price = Some(v);
            }
            (11, 0) => d.trade_side = read_varint(&mut cur).map_err(|e| e.to_string())? as i32,
            (12, 0) => d.deal_status = read_varint(&mut cur).map_err(|e| e.to_string())? as i32,
            (14, 0) => d.commission_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (16, 2) => {
                let len = read_varint(&mut cur).map_err(|e| e.to_string())? as usize;
                let mut sub = vec![0u8; len];
                cur.read_exact(&mut sub).map_err(|e| e.to_string())?;
                if let Ok(c) = parse_close_position_detail(&sub) {
                    d.close_detail = c;
                }
            }
            (17, 0) => d.money_digits = read_varint(&mut cur).map_err(|e| e.to_string())? as u32,
            _ => skip_field(&mut cur, wire)?,
        }
    }
    Ok(d)
}

fn parse_close_position_detail(bytes: &[u8]) -> Result<ClosePositionDetail, String> {
    let mut cur = Cursor::new(bytes);
    let mut c = ClosePositionDetail::default();
    c.has_close_detail = true;
    while (cur.position() as usize) < bytes.len() {
        let tag = read_varint(&mut cur).map_err(|e| e.to_string())?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 7) as u8;
        match (field, wire) {
            (1, 1) => {
                let v = read_fixed64(&mut cur).map_err(|e| e.to_string())?;
                c.entry_price = Some(v);
            }
            (2, 0) => c.gross_profit_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (3, 0) => c.swap_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (4, 0) => c.commission_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (5, 0) => c.balance_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (7, 0) => c.closed_volume = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            (10, 0) => c.pnl_conversion_fee_raw = read_varint(&mut cur).map_err(|e| e.to_string())? as i64,
            _ => skip_field(&mut cur, wire)?,
        }
    }
    Ok(c)
}

pub fn money_scale(money_digits: u32) -> f64 {
    if money_digits == 0 {
        1.0
    } else {
        10_f64.powi(money_digits as i32)
    }
}
