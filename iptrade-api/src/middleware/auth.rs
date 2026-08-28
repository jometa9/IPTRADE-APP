use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Datelike;
use tracing::error;

use crate::config::{
    API_KEY_HEADER, API_SECRET_HEADER, DYNAMIC_INSERT_POS, DYNAMIC_LEN,
};

#[derive(Clone, Default)]
pub struct AuthState {
    pub api_key: String,
    pub api_secret: String,
}

impl AuthState {
    pub fn with_api_keys(api_key: String, api_secret: String) -> Self {
        Self { api_key, api_secret }
    }

    pub fn key_with_month(base: &str) -> String {
        let base = base.trim();
        if base.len() < DYNAMIC_INSERT_POS + DYNAMIC_LEN {
            return base.to_string();
        }
        let month_x2 = chrono::Utc::now().month() * 2;
        let prefix = base.get(..DYNAMIC_INSERT_POS).unwrap_or("");
        let suffix = base.get(DYNAMIC_INSERT_POS..).unwrap_or("");
        format!("{}{:02}{}", prefix, month_x2, suffix)
    }
}

fn validate_key(received: &str, expected_base: &str) -> bool {
    let received = received.trim();
    let expected_base = expected_base.trim();
    if received.is_empty() || expected_base.is_empty() {
        return false;
    }
    if expected_base.len() < DYNAMIC_INSERT_POS + DYNAMIC_LEN {
        return false;
    }
    let expected_dynamic = AuthState::key_with_month(expected_base);
    received == expected_dynamic
}

const PUBLIC_HEALTH_PATH: &str = "/api/health";
const PUBLIC_BUILD_INFO_PATH: &str = "/api/build-info";
const PUBLIC_DOCS_PATHS: [&str; 4] = ["/api/docs", "/api/openapi.json", PUBLIC_HEALTH_PATH, PUBLIC_BUILD_INFO_PATH];
const PUBLIC_ORDERS_WS_PATH: &str = "/api/accounts/orders";
const PUBLIC_OPEN_ORDERS_WS_PATH: &str = "/api/orders/open/ws";
const API_KEY_ONLY_PATHS: [&str; 2] = ["/api/heartbeat", "/api/system/shutdown"];

pub async fn auth_middleware(request: Request, next: Next, auth_state: AuthState) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    if method == Method::OPTIONS {
        return next.run(request).await;
    }
    let path_trimmed = path.trim_end_matches('/');
    let path_lower = path_trimmed.to_lowercase();
    if path_lower == PUBLIC_HEALTH_PATH || path_lower == PUBLIC_BUILD_INFO_PATH {
        return next.run(request).await;
    }
    if PUBLIC_DOCS_PATHS.iter().any(|p| path_lower == p.trim_end_matches('/').to_lowercase()) {
        return next.run(request).await;
    }
    if path == PUBLIC_ORDERS_WS_PATH || path == PUBLIC_OPEN_ORDERS_WS_PATH {
        return next.run(request).await;
    }
    let key = request
        .headers()
        .get(API_KEY_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let secret = request
        .headers()
        .get(API_SECRET_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim);

    let (key_valid, secret_valid) = key
        .zip(secret)
        .map(|(k, s)| {
            let kv = !k.is_empty() && validate_key(k, &auth_state.api_key);
            let sv = !s.is_empty() && validate_key(s, &auth_state.api_secret);
            (kv, sv)
        })
        .unwrap_or((false, false));
    let ok = key_valid && secret_valid;

    if !ok {
        error!("Auth failed: missing or invalid X-Api-Key / X-Api-Secret");
        let mut res = (StatusCode::UNAUTHORIZED, "Missing or invalid X-Api-Key / X-Api-Secret").into_response();
        res.headers_mut().insert(
            axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
            axum::http::header::HeaderValue::from_static("*"),
        );
        return res;
    }

    if API_KEY_ONLY_PATHS.iter().any(|p| path == *p) {
        return next.run(request).await;
    }

    next.run(request).await
}
