use axum::{extract::State, http::StatusCode, Json};
use axum::body::to_bytes;
use axum::extract::Request;
use std::path::Path;

use crate::app_state::AppState;
use crate::services::metatrader::{execute_install, InstallBotsBody};

#[utoipa::path(
    post,
    path = "/api/metatrader/install",
    tag = "MetaTrader",
    request_body(content = Option<InstallBotsBody>, description = "Optional targetPath for specific install; omit to scan drives"),
    responses(
        (status = 200, description = "", body = serde_json::Value),
        (status = 400, description = "", body = String),
        (status = 501, description = "", body = String),
        (status = 503, description = "", body = String)
    )
)]
pub async fn install_bots(
    State(_state): State<AppState>,
    request: Request,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let body = to_bytes(request.into_body(), 64 * 1024)
        .await
        .ok()
        .filter(|b| !b.is_empty())
        .and_then(|b| serde_json::from_slice::<InstallBotsBody>(&b).ok());

    let source_path: &Path = {
        #[cfg(target_os = "windows")]
        {
            if !_state.config.install_bots_enabled {
                return Err((
                    StatusCode::NOT_IMPLEMENTED,
                    "Install bots is disabled".to_string(),
                ));
            }
            let source = _state
                .config
                .bots_source_path
                .as_deref()
                .ok_or((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Bots source path not configured (BOTS_SOURCE_PATH)".to_string(),
                ))?;
            let p = Path::new(source);
            if !p.is_dir() {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Bots source path does not exist".to_string(),
                ));
            }
            p
        }
        #[cfg(not(target_os = "windows"))]
        Path::new("")
    };

    match execute_install(source_path, body.as_ref()) {
        Ok(v) => Ok(Json(v)),
        Err((code, msg)) => Err((code, msg)),
    }
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new().route("/api/metatrader/install", axum::routing::post(install_bots))
}
