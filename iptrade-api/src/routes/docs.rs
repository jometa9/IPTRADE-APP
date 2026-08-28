use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityScheme};
use utoipa::{Modify, OpenApi};

use crate::app_state::AppState;
use crate::config::{API_KEY_HEADER, API_SECRET_HEADER};
use crate::routes::accounts;
use crate::routes::auth_ctrader;
use crate::routes::bots;
use crate::routes::common::ApiResponseSchema;
use crate::routes::heartbeat;
use crate::routes::logs;
use crate::routes::system;
use crate::services::account_history::{AccountInfoDto, OpenPositionDto, PendingOrderDto};
use crate::state;

use axum::extract::State;
use axum::response::IntoResponse;

struct ApiKeySecurityModifier;
struct ApiResponseSchemaModifier;

impl Modify for ApiKeySecurityModifier {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.as_mut().expect("OpenAPI components");
        components.add_security_scheme(
            "api_key",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new(API_KEY_HEADER))),
        );
        components.add_security_scheme(
            "api_secret",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new(API_SECRET_HEADER))),
        );
    }
}

impl Modify for ApiResponseSchemaModifier {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            if let Some(schema) = components.schemas.get("ApiResponseSchema").cloned() {
                components.schemas.insert("ApiResponse".to_string(), schema);
            }
        }
    }
}

#[derive(utoipa::OpenApi)]
#[openapi(
    modifiers(&ApiKeySecurityModifier, &ApiResponseSchemaModifier),
    info(
        title = "IPTRADE API",
        description = "パンクにならないで",
        version = "2.0.4"
    ),
    security(
        ("api_key" = [], "api_secret" = [])
    ),
    paths(
        system::health,
        auth_ctrader::url,
        auth_ctrader::complete,
        accounts::status,
        accounts::aggregate_orders_ws,
        accounts::delete_all_accounts,
        accounts::set_account_tcp,
        accounts::account_orders_ws,
        accounts::configure,
        accounts::delete_account,
        system::put_preferences,
        heartbeat::heartbeat_in,
        system::engine,
        system::shutdown,
        bots::install_bots,
        logs::get_logs,
        logs::clear_logs,
    ),
    components(schemas(
        ApiResponseSchema,
        auth_ctrader::CompleteBody,
        accounts::UnifiedStatusResponse,
        accounts::AccountStatusDto,
        accounts::AppSettings,
        accounts::ConfigureAccountBody,
        accounts::Resources,
        system::UpdatePreferencesBody,
        accounts::ConnectionStatus,
        state::PrefixSuffixConfig,
        crate::services::metatrader::InstallBotsBody,
        heartbeat::AccountHeartbeatPayload,
        heartbeat::HeartbeatCopyTradingConfig,
        state::AppPreferences,
        AccountInfoDto,
        OpenPositionDto,
        PendingOrderDto,
    )),
    tags(
        (name = "Accounts"),
        (name = "System"),
        (name = "cTrader"),
        (name = "Heartbeat"),
        (name = "Logs"),
        (name = "MetaTrader")
    )
)]
pub struct ApiDoc;

pub async fn openapi_json(State(_state): State<AppState>) -> impl IntoResponse {
    let spec = ApiDoc::openapi();
    let json = serde_json::to_string_pretty(&spec).unwrap_or_else(|_| "{}".to_string());
    ([(axum::http::header::CONTENT_TYPE, "application/json")], json)
}

pub async fn swagger_ui_html(State(_state): State<AppState>) -> impl IntoResponse {
    let spec = ApiDoc::openapi();
    let json = serde_json::to_string(&spec).unwrap_or_else(|_| "{}".to_string());
    let escaped = json.replace("</script>", "<\\/script>");
    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <title>{}</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    .responses-table th:nth-child(3),
    .responses-table td:nth-child(3),
    .response-col_links {{ display: none !important; }}
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script type="application/json" id="openapi-spec">{}</script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {{
      const spec = JSON.parse(document.getElementById('openapi-spec').textContent);
      window.ui = SwaggerUIBundle({{
        spec,
        dom_id: '#swagger-ui',
        defaultModelsExpandDepth: -1,
      }});
    }};
  </script>
</body>
</html>"#,
        "IPTRADE API",
        escaped
    );
    ([(axum::http::header::CONTENT_TYPE, "text/html")], html)
}

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/docs", axum::routing::get(swagger_ui_html))
        .route("/api/openapi.json", axum::routing::get(openapi_json))
}
