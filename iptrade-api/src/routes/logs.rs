use axum::{
    extract::State,
    http::{header, StatusCode},
    response::IntoResponse,
};

use crate::app_state::AppState;
use crate::log_buffer;

#[utoipa::path(
    get,
    path = "/api/logs",
    tag = "Logs",
    responses(
        (status = 200, description = "Log file content (last 3 days) or 'Waiting for logs...'", body = String, content_type = "text/plain"),
        (status = 404, description = "Log file feature disabled. Set LOGS_TO_FILE_ENABLED=true.", body = String, content_type = "text/plain"),
        (status = 500, description = "Failed to read log file", body = String, content_type = "text/plain")
    )
)]
pub async fn get_logs(State(state): State<AppState>) -> impl IntoResponse {
    let path = match state.config.log_file_path() {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "Log file feature is disabled. Set LOGS_TO_FILE_ENABLED=true to enable.".to_string(),
            )
                .into_response()
        }
    };

    if !path.exists() {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Waiting for logs...".to_string(),
        )
            .into_response();
    }

    if let Err(e) = log_buffer::trim_log_file_to_retention(&path) {
        tracing::warn!(error = %e, "Failed to trim log file");
    }

    match std::fs::read_to_string(&path) {
        Ok(content) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            content,
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("Failed to read log file: {}", e),
        )
            .into_response(),
    }
}

#[utoipa::path(
    delete,
    path = "/api/logs",
    tag = "Logs",
    responses(
        (status = 204, description = "Logs cleared successfully"),
        (status = 404, description = "Log file feature disabled. Set LOGS_TO_FILE_ENABLED=true.", body = String, content_type = "text/plain"),
        (status = 500, description = "Failed to clear log file", body = String, content_type = "text/plain")
    )
)]
pub async fn clear_logs(State(state): State<AppState>) -> impl IntoResponse {
    let path = match state.config.log_file_path() {
        Some(p) => p,
        None => {
            return (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "Log file feature is disabled. Set LOGS_TO_FILE_ENABLED=true to enable.".to_string(),
            )
                .into_response()
        }
    };

    match log_buffer::clear_log_file(&path) {
        Ok(()) => (StatusCode::NO_CONTENT, ()).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            format!("Failed to clear log file: {}", e),
        )
            .into_response(),
    }
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/logs", axum::routing::get(get_logs).delete(clear_logs))
}
