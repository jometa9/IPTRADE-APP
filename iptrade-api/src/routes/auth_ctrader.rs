use utoipa::ToSchema;

use axum::{
    extract::State,
    http::StatusCode,
    Json,
};
use std::collections::HashSet;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::routes::common::ApiResponse;
use crate::services::ctrader::oauth::{self, CTraderAccountInfo, OAuthTokenResponse};
use crate::state::AccountEntry;
use tracing::{error, info};

#[derive(Debug, Serialize, ToSchema)]
pub struct AuthUrlResponse {
    pub url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub struct CompleteBody {
    pub code: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuthAccountInfo {
    pub account_id: String,
    pub server: Option<String>,
    pub is_live: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CompleteAuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub accounts: Vec<AuthAccountInfo>,
}

fn map_accounts(accounts: Vec<CTraderAccountInfo>) -> Vec<AuthAccountInfo> {
    accounts
        .into_iter()
        .map(|a| AuthAccountInfo {
            account_id: a.account_id,
            server: a.broker_name,
            is_live: a.is_live,
        })
        .collect()
}

fn complete_response(token: OAuthTokenResponse, accounts: Vec<CTraderAccountInfo>) -> CompleteAuthResponse {
    CompleteAuthResponse {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        accounts: map_accounts(accounts),
    }
}

async fn persist_oauth_accounts_to_state(
    mgr: &crate::state::LocalStateFileManager,
    token: &OAuthTokenResponse,
    accounts: &[AuthAccountInfo],
    api_base: &str,
    client_id: &str,
    client_secret: &str,
) -> (usize, usize) {
    let existing_ids: HashSet<String> = mgr
        .read(|snap| snap.accounts.keys().cloned().collect())
        .await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let expires_at = format!("{}", now.as_secs() + token.expires_in as u64);
    let token_access = token.access_token.clone();
    let token_refresh = token.refresh_token.clone();
    let client_id_opt = Some(client_id.to_string());
    let client_secret_opt = Some(client_secret.to_string());
    let to_add: Vec<_> = accounts
        .iter()
        .filter(|a| !existing_ids.contains(&a.account_id))
        .collect();
    let accounts_to_insert: Vec<_> = to_add
        .iter()
        .map(|acc| {
            let id = acc.account_id.clone();
            let ctid = id.parse::<u64>().unwrap_or(0);
            let api_url = format!("{}/api/accounts/{}", api_base.trim_end_matches('/'), id);
            let entry = AccountEntry {
                account_id: id.clone(),
                platform: "ctrader".to_string(),
                server: acc.server.clone(),
                nickname: None,
                ctid_trader_account_id: Some(ctid),
                is_live: acc.is_live,
                access_token: Some(token_access.clone()),
                refresh_token: Some(token_refresh.clone()),
                token_expires_at_utc: Some(expires_at.clone()),
                client_id: client_id_opt.clone(),
                client_secret: client_secret_opt.clone(),
                role: Some("pending".to_string()),
                master_account_id: None,
                master_tcp_url: None,
                tcp_url: None,
                api_url: Some(api_url),
                lot_type: None,
                lot_multiplier: None,
                fixed_lot: None,
                reverse_trading: None,
                exact_match: Some(false),
                symbol_translations: None,
                prefix: None,
                suffix: None,
                last_heartbeat_utc: None,
                reconnect_type: None,
                reconnect_retry_after_secs: None,
                connection_type: None,
                tcp_enabled: None,
            };
            (id, entry)
        })
        .collect();
    let added_count = accounts_to_insert.len();
    let to_update: Vec<_> = accounts
        .iter()
        .filter(|a| existing_ids.contains(&a.account_id))
        .collect();
    mgr.update(|snap| {
        for (id, entry) in accounts_to_insert {
            snap.accounts.insert(id, entry);
        }
        for acc in &to_update {
            if let Some(entry) = snap.accounts.get_mut(&acc.account_id) {
                if entry.platform.eq_ignore_ascii_case("ctrader") {
                    entry.access_token = Some(token_access.clone());
                    entry.refresh_token = Some(token_refresh.clone());
                    entry.token_expires_at_utc = Some(expires_at.clone());
                    entry.client_id = client_id_opt.clone();
                    entry.client_secret = client_secret_opt.clone();
                    entry.reconnect_type = None;
                    entry.server = acc.server.clone();
                    entry.is_live = acc.is_live;
                }
            }
        }
    })
    .await;
    (added_count, to_update.len())
}

const CTRADER_CREDENTIALS_MISSING: &str =
    "cTrader app credentials not configured. Add your cTrader Open API Client ID and Secret in the Config screen.";

/// Resolves the cTrader Open API app credentials: user-provided (encrypted local
/// state) first, then the optional CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET env
/// override for development.
pub(crate) async fn resolve_ctrader_app_credentials(state: &AppState) -> Option<(String, String)> {
    if let Some(ref mgr) = state.state_manager {
        if let Some(creds) = mgr.read(|s| s.ctrader_app.clone()).await {
            let id = creds.client_id.trim().to_string();
            let secret = creds.client_secret.trim().to_string();
            if !id.is_empty() && !secret.is_empty() {
                return Some((id, secret));
            }
        }
    }
    match (
        state.config.ctrader_client_id.clone(),
        state.config.ctrader_client_secret.clone(),
    ) {
        (Some(id), Some(secret)) => Some((id, secret)),
        _ => None,
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CtraderAppCredentialsStatus {
    pub configured: bool,
    pub client_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/ctrader/app-credentials",
    tag = "cTrader",
    responses((status = 200, body = ApiResponse<CtraderAppCredentialsStatus>))
)]
pub async fn get_app_credentials(
    State(state): State<AppState>,
) -> Json<ApiResponse<CtraderAppCredentialsStatus>> {
    let creds = resolve_ctrader_app_credentials(&state).await;
    let status = CtraderAppCredentialsStatus {
        configured: creds.is_some(),
        client_id: creds.map(|(id, _)| id),
    };
    Json(ApiResponse::ok(status, "OK"))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetCtraderAppCredentialsBody {
    #[serde(alias = "clientId")]
    pub client_id: String,
    #[serde(alias = "clientSecret")]
    pub client_secret: String,
}

#[utoipa::path(
    put,
    path = "/api/ctrader/app-credentials",
    tag = "cTrader",
    request_body(content = SetCtraderAppCredentialsBody),
    responses(
        (status = 200, body = ApiResponse<()>),
        (status = 400, body = ApiResponse<()>)
    )
)]
pub async fn set_app_credentials(
    State(state): State<AppState>,
    Json(body): Json<SetCtraderAppCredentialsBody>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let client_id = body.client_id.trim().to_string();
    let client_secret = body.client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("client_id and client_secret are required")),
        ));
    }
    let mgr = state.state_manager.as_ref().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiResponse::<()>::err("State not available")),
    ))?;
    mgr.update(move |snap| {
        snap.ctrader_app = Some(crate::state::CtraderAppCredentials {
            client_id,
            client_secret,
        });
    })
    .await;
    Ok(Json(ApiResponse::<()>::ok_empty("cTrader app credentials saved")))
}

#[utoipa::path(
    delete,
    path = "/api/ctrader/app-credentials",
    tag = "cTrader",
    responses((status = 200, body = ApiResponse<()>))
)]
pub async fn delete_app_credentials(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let mgr = state.state_manager.as_ref().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiResponse::<()>::err("State not available")),
    ))?;
    mgr.update(|snap| {
        snap.ctrader_app = None;
    })
    .await;
    Ok(Json(ApiResponse::<()>::ok_empty("cTrader app credentials removed")))
}

#[utoipa::path(
    get,
    path = "/api/auth/ctrader",
    tag = "cTrader",
    responses(
        (status = 200, body = ApiResponse<AuthUrlResponse>),
        (status = 400, body = ApiResponse<()>)
    )
)]
pub async fn url(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<AuthUrlResponse>>, (StatusCode, Json<ApiResponse<()>>)> {
    let (client_id, _) = resolve_ctrader_app_credentials(&state).await.ok_or((
        StatusCode::BAD_REQUEST,
        Json(ApiResponse::<()>::err(CTRADER_CREDENTIALS_MISSING)),
    ))?;
    let redirect_uri = state.config.ctrader_redirect_uri_local.clone();
    let url = oauth::generate_oauth_url(&client_id, &redirect_uri, None)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(ApiResponse::<()>::err(&e))))?;
    Ok(Json(ApiResponse::ok(AuthUrlResponse { url }, "OK")))
}

struct LinkingGuard(std::sync::Arc<std::sync::Mutex<Option<String>>>);
impl Drop for LinkingGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.0.lock() {
            *g = None;
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/auth/ctrader",
    tag = "cTrader",
    request_body(
        content = CompleteBody,
        example = json!({ "code": "authorization_code_from_ctrader" })
    ),
    responses(
        (status = 200, description = "OAuth completed: returns tokens and cTrader accounts obtained with that code", body = ApiResponse<CompleteAuthResponse>,
            example = json!({
                "success": true,
                "data": {
                    "access_token": "eyJhbGc...",
                    "refresh_token": "dGhpcyBpcy...",
                    "expires_in": 86400,
                    "accounts": [
                        {
                            "account_id": "12345678",
                            "server": "ICMarkets-Demo",
                            "is_live": false
                        },
                        {
                            "account_id": "87654321",
                            "server": "ICMarkets-Live",
                            "is_live": true
                        }
                    ]
                },
                "message": "OAuth completed. Added 2 account(s).",
                "errors": null
            })),
        (status = 400, body = ApiResponse<()>)
    )
)]
pub async fn complete(
    State(state): State<AppState>,
    Json(body): Json<CompleteBody>,
) -> Result<Json<ApiResponse<CompleteAuthResponse>>, (StatusCode, Json<ApiResponse<()>>)> {
    let code = body.code.trim();
    if code.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err("Invalid request")),
        ));
    }

    let redirect_uri = state.config.ctrader_redirect_uri_local.clone();

    let (client_id, client_secret) = resolve_ctrader_app_credentials(&state).await.ok_or((
        StatusCode::BAD_REQUEST,
        Json(ApiResponse::<()>::err(CTRADER_CREDENTIALS_MISSING)),
    ))?;

    {
        let mut g = state.linking_platform.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some("ctrader".to_string());
    }

    let _guard = LinkingGuard(state.linking_platform.clone());

    let token = match oauth::exchange_code_for_tokens(
        &state.http_client,
        code,
        &redirect_uri,
        &client_id,
        &client_secret,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            error!(error = %e, "ctrader OAuth exchange token failed");
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ApiResponse::<()>::err(&e)),
            ));
        }
    };

    let accounts = oauth::get_accounts_by_token(
        &token.access_token,
        &client_id,
        &client_secret,
    )
    .await
    .map_err(|e| {
        error!(error = %e, "ctrader get_accounts_by_token failed");
        (StatusCode::BAD_REQUEST, Json(ApiResponse::<()>::err(&e)))
    })?;

    if accounts.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse::<()>::err(
                "No accounts found for this authorization.",
            )),
        ));
    }

    let response = complete_response(token.clone(), accounts.clone());
    let total_accounts = response.accounts.len();
    if let Some(ref mgr) = state.state_manager {
        let api_base = crate::util::api_base_for_accounts(state.config.port);
        let (added_count, updated_count) = persist_oauth_accounts_to_state(
            mgr,
            &token,
            &response.accounts,
            &api_base,
            &client_id,
            &client_secret,
        )
        .await;
        if let Some(ref tx) = *state.ctrader_trigger_connect_tx.read().await {
            info!(added = added_count, updated = updated_count, "ctrader OAuth complete, triggering connect");
            let _ = tx.try_send(());
        }
        let msg = if updated_count > 0 && added_count == 0 {
            format!("OAuth completed. Updated {} existing account(s) with new tokens.", updated_count)
        } else if added_count > 0 && updated_count > 0 {
            format!("OAuth completed. Added {} account(s), updated {} with new tokens.", added_count, updated_count)
        } else {
            format!("OAuth completed. Added {} account(s).", added_count)
        };
        return Ok(Json(ApiResponse::ok(response, &msg)));
    }
    Ok(Json(ApiResponse::ok(
        response,
        &format!("OAuth completed. Found {} account(s).", total_accounts),
    )))
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/auth/ctrader", axum::routing::get(url).post(complete))
        .route(
            "/api/ctrader/app-credentials",
            axum::routing::get(get_app_credentials)
                .put(set_app_credentials)
                .delete(delete_app_credentials),
        )
}
