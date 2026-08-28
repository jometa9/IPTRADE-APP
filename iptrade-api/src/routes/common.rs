
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiResponseSchema {
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub message: Option<String>,
    pub errors: Option<Vec<String>>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T, message: &str) -> Self {
        Self {
            success: true,
            data: Some(data),
            message: Some(message.to_string()),
            errors: None,
        }
    }

    pub fn ok_empty(message: &str) -> ApiResponse<()> {
        ApiResponse {
            success: true,
            data: None,
            message: Some(message.to_string()),
            errors: None,
        }
    }

    pub fn err(msg: &str) -> ApiResponse<()> {
        ApiResponse {
            success: false,
            data: None,
            message: None,
            errors: Some(vec![msg.to_string()]),
        }
    }
}
