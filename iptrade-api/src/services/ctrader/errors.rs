pub const DISCONNECT_REQUESTED: &str = "disconnect requested";

pub fn is_ctrader_invalid_credentials_error(err: &str) -> bool {
    if is_ctrader_temporary_broker_error(err) {
        return false;
    }
    let upper = err.to_ascii_uppercase();
    if upper.starts_with("APP AUTH REJECTED:") || upper.starts_with("ACCOUNT AUTH REJECTED:") {
        return true;
    }
    if upper.contains("CH_ACCESS_TOKEN_INVALID") || upper.contains("ACCOUNT_NOT_AUTHORIZED") {
        return true;
    }
    upper.contains("INVALID_REQUEST") && upper.contains("NOT AUTHORIZED")
}

pub fn is_ctrader_temporary_broker_error(err: &str) -> bool {
    let upper = err.to_ascii_uppercase();
    upper.contains("SERVER_IS_UNDER_MAINTENANCE") || upper.contains("CANT_ROUTE_REQUEST")
}

pub fn ctrader_temporary_broker_reconnect_type(err: &str) -> Option<&'static str> {
    let upper = err.to_ascii_uppercase();
    if upper.contains("SERVER_IS_UNDER_MAINTENANCE") {
        Some("server_maintenance")
    } else if upper.contains("CANT_ROUTE_REQUEST") {
        Some("cant_route_request")
    } else {
        None
    }
}
