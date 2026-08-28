use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::services::proto_oa;
use crate::timings::CTRADER_PROTOOA_TIMEOUT_SECS;

const OAUTH_AUTH_URL: &str = "https://connect.spotware.com/apps/auth";
const OAUTH_TOKEN_URL: &str = "https://connect.spotware.com/oauth/v2/token";
const CTRADER_PROTOOA_HOST_LIVE: &str = "live.ctraderapi.com";
const CTRADER_PROTOOA_HOST_DEMO: &str = "demo.ctraderapi.com";
const CTRADER_PROTOOA_PORT: u16 = 5035;

#[must_use]
pub fn protooa_host_for_account(is_live: bool) -> &'static str {
    if is_live {
        CTRADER_PROTOOA_HOST_LIVE
    } else {
        CTRADER_PROTOOA_HOST_DEMO
    }
}

#[must_use]
pub const fn protooa_port() -> u16 {
    CTRADER_PROTOOA_PORT
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CTraderAccountInfo {
    pub account_id: String,
    pub broker_name: Option<String>,
    pub is_live: Option<bool>,
}

pub fn generate_oauth_url(
    client_id: &str,
    redirect_uri: &str,
    state: Option<&str>,
) -> Result<String, String> {
    if client_id.is_empty() {
        return Err("Invalid request".to_string());
    }
    let state_default = uuid::Uuid::new_v4().to_string();
    let state = state.unwrap_or(&state_default);
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("scope", "trading"),
        ("state", state),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let full_url = format!("{}?{}", OAUTH_AUTH_URL, query);
    Ok(full_url)
}

pub async fn exchange_code_for_tokens(
    client: &Client,
    code: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<OAuthTokenResponse, String> {
    if code.is_empty() || client_id.is_empty() || client_secret.is_empty() {
        return Err("Invalid request".to_string());
    }
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ];
    let res = client
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|_| "Authentication failed".to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|_| "Authentication failed".to_string())?;
    if !status.is_success() {
        return Err("Authentication failed".to_string());
    }
    if let Ok(err) = serde_json::from_str::<serde_json::Value>(&text) {
        let has_error = err.get("error").map(|v| !v.is_null()).unwrap_or(false)
            || err.get("errorCode").map(|v| !v.is_null()).unwrap_or(false);
        if has_error {
            return Err("Authentication failed".to_string());
        }
    }
    let token: OAuthTokenResponse =
        serde_json::from_str(&text).map_err(|_| "Authentication failed".to_string())?;
    if token.access_token.is_empty() {
        return Err("Authentication failed".to_string());
    }
    let expires_in = if token.expires_in <= 0 {
        3600
    } else {
        token.expires_in
    };
    Ok(OAuthTokenResponse {
        expires_in,
        ..token
    })
}

pub async fn refresh_token(
    client: &Client,
    refresh_token: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<OAuthTokenResponse, String> {
    if refresh_token.is_empty() || client_id.is_empty() || client_secret.is_empty() {
        return Err("Invalid request".to_string());
    }
    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("refresh_token", refresh_token),
    ];
    let res = client
        .post(OAUTH_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|_| "Authentication failed".to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|_| "Authentication failed".to_string())?;
    if !status.is_success() {
        return Err("Authentication failed".to_string());
    }
    let token: OAuthTokenResponse =
        serde_json::from_str(&text).map_err(|_| "Authentication failed".to_string())?;
    if token.access_token.is_empty() {
        return Err("Authentication failed".to_string());
    }
    let expires_in = if token.expires_in <= 0 {
        3600
    } else {
        token.expires_in
    };
    Ok(OAuthTokenResponse {
        expires_in,
        ..token
    })
}

pub async fn get_accounts_by_token(
    access_token: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<Vec<CTraderAccountInfo>, String> {
    let err_live = try_get_accounts_by_token_on_host(
        access_token,
        client_id,
        client_secret,
        CTRADER_PROTOOA_HOST_LIVE,
    )
    .await;
    match err_live {
        Ok(accounts) => Ok(accounts),
        Err(e) if e.contains("application auth rejected") => {
            try_get_accounts_by_token_on_host(
                access_token,
                client_id,
                client_secret,
                CTRADER_PROTOOA_HOST_DEMO,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

async fn try_get_accounts_by_token_on_host(
    access_token: &str,
    client_id: &str,
    client_secret: &str,
    host: &str,
) -> Result<Vec<CTraderAccountInfo>, String> {
    let url = format!("wss://{}:{}", host, CTRADER_PROTOOA_PORT);
    let (ws_stream, _) = connect_async(&url).await.map_err(|_| "Authentication failed".to_string())?;
    let (mut write, mut read) = ws_stream.split();
    let timeout = std::time::Duration::from_secs(CTRADER_PROTOOA_TIMEOUT_SECS);

    let auth_body = proto_oa::encode_application_auth_req(client_id, client_secret);
    tokio::time::timeout(timeout, write.send(Message::Binary(auth_body)))
        .await
        .map_err(|_| "ProtoOA send application auth timeout")?
        .map_err(|_| "Authentication failed".to_string())?;

    const MAX_FRAMES_BEFORE_AUTH: usize = 10;
    const PROTO_OA_APPLICATION_AUTH_RES: i32 = 2101;
    const PROTO_OA_ERROR_RES: i32 = 2142;
    let auth_ok = {
        let mut wrapper_pt: Option<i32> = None;
        let mut inner_payload: Vec<u8> = vec![];
        for _ in 0..MAX_FRAMES_BEFORE_AUTH {
            let msg = tokio::time::timeout(timeout, read.next())
                .await
                .map_err(|_| "ProtoOA wait for application auth response timeout")?
                .ok_or("ProtoOA connection closed before auth response")?
                .map_err(|_| "Authentication failed".to_string())?;
            match msg {
                Message::Binary(b) => {
                    if let Some((pt, pl)) = proto_oa::parse_proto_message_wrapper(&b) {
                        wrapper_pt = Some(pt);
                        inner_payload = pl;
                    } else {
                        inner_payload = b.to_vec();
                    }
                    break;
                }
                Message::Text(_t) => {}
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return Err("Authentication failed".to_string()),
                Message::Frame(_) => {}
            }
        }
        match wrapper_pt {
            Some(PROTO_OA_APPLICATION_AUTH_RES) => true,
            Some(PROTO_OA_ERROR_RES) => return Err("Authentication failed".to_string()),
            _ => {
                let body = inner_payload.as_slice();
                if body.is_empty() {
                    return Err("Authentication failed".to_string());
                }
                if proto_oa::is_application_auth_res(body) {
                    true
                } else if proto_oa::is_error_res(body) {
                    return Err("Authentication failed".to_string());
                } else {
                    return Err("Authentication failed".to_string());
                }
            }
        }
    };
    let _ = auth_ok;

    let req_body = proto_oa::encode_get_account_list_req(access_token);
    tokio::time::timeout(timeout, write.send(Message::Binary(req_body)))
        .await
        .map_err(|_| "ProtoOA send get account list timeout")?
        .map_err(|_| "Authentication failed".to_string())?;

    let res_bytes = {
        let mut out: Vec<u8> = vec![];
        for _ in 0..MAX_FRAMES_BEFORE_AUTH {
            let msg = tokio::time::timeout(timeout, read.next())
                .await
                .map_err(|_| "ProtoOA wait for account list response timeout")?
                .ok_or("ProtoOA connection closed before account list response")?
                .map_err(|_| "Authentication failed".to_string())?;
            match msg {
                Message::Binary(b) => {
                    let (_body_pt, body_payload) = proto_oa::parse_proto_message_wrapper(&b)
                        .map(|(pt, pl)| (Some(pt), pl))
                        .unwrap_or((None, b.to_vec()));
                    out = body_payload;
                    break;
                }
                Message::Text(_t) => {}
                Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return Err("Authentication failed".to_string()),
                Message::Frame(_) => {}
            }
        }
        out
    };
    if res_bytes.is_empty() {
        return Err("Authentication failed".to_string());
    }
    let body = res_bytes.as_slice();
    if proto_oa::is_error_res(body) {
        return Err("Authentication failed".to_string());
    }
    let (ctid_accounts, extras) =
        proto_oa::parse_get_account_list_res_with_extra(body).map_err(|_| "Authentication failed".to_string())?;
    let _ = extras;
    let accounts: Vec<CTraderAccountInfo> = ctid_accounts
        .into_iter()
        .map(|a| CTraderAccountInfo {
            account_id: a.ctid_trader_account_id.to_string(),
            broker_name: a.broker_title_short.clone(),
            is_live: a.is_live,
        })
        .collect();
    Ok(accounts)
}
