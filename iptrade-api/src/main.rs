mod app_state;
mod background;
mod build_config;
mod config;
mod log_buffer;
mod port;
mod setup;
mod timings;
mod middleware;
mod util;
mod routes;
mod state;
mod services;

use axum::middleware as axum_middleware;
use std::io::Write;
use std::sync::Arc;
use std::net::SocketAddr;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn log_startup_hint(is_prod: bool) {
    let msg: &str = if is_prod {
        "account sync ready"
    } else {
        "sync ready"
    };
    tracing::info!("{}", msg);
}

fn print_banner(title: &str, extra: Option<&str>) {
    let version = std::env::var("APP_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    let mut out = format!("\n瞬写\n{title}\nv{version}\n");
    if let Some(s) = extra {
        out.push_str(s);
        if !s.ends_with('\n') {
            out.push('\n');
        }
    }
    let _ = std::io::stdout().write_all(out.as_bytes());
    let _ = std::io::stdout().flush();
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let is_prod = std::env::var_os("IPTRADE_ELECTRON_PROD").is_some_and(|v| v == "1");

    let config_for_logs = config::Config::from_env();
    if let Some(ref path) = config_for_logs.default_log_file_path() {
        if let Err(e) = log_buffer::trim_log_file_to_retention(path) {
            eprintln!("Warning: failed to trim log file at startup: {}", e);
        }
    }
    if is_prod {
        print_banner("IPTRADE", None);
        let log_file_path = config_for_logs.log_file_path();
        if log_file_path.is_some() {
            let ring_writer = log_buffer::RingBufferLogWriter::new_with_file(log_buffer::MAX_LINES, log_file_path);
            let filter = tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
            tracing_subscriber::registry()
                .with(filter)
                .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(move || ring_writer.clone())
                    .with_ansi(true),
            )
                .init();
        } else {
            tracing_subscriber::registry()
                .with(tracing_subscriber::EnvFilter::new("off"))
                .with(tracing_subscriber::fmt::layer().with_writer(std::io::sink))
                .init();
        }
    } else {
        let config = config::Config::from_env();
        let log_file_path = config.log_file_path();
        let ring_writer = log_buffer::RingBufferLogWriter::new_with_file(log_buffer::MAX_LINES, log_file_path);
        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        tracing_subscriber::registry()
            .with(filter)
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(move || ring_writer.clone())
                    .with_ansi(true),
            )
            .init();
    }

    let config = config::Config::from_env();
    if is_prod {
        let starting = format!("Starting API Process...");
        let _ = std::io::stdout().write_all(starting.as_bytes());
        let _ = std::io::stdout().flush();
        log_startup_hint(true);
    } else {
        let swagger_extra = if build_config::SHOW_SWAGGER_DOCS {
            String::from("API docs (Swagger): /api/docs\nOpenAPI JSON: /api/openapi.json")
        } else {
            String::new()
        };
        print_banner("IPTRADE DEV", if swagger_extra.is_empty() { None } else { Some(&swagger_extra) });
        let starting = String::from("Starting API Process...\n");
        let _ = std::io::stdout().write_all(starting.as_bytes());
        let _ = std::io::stdout().flush();
        log_startup_hint(false);
    }
    const BASE_KEY_LEN: usize = 64;
    let api_key = if config.api_key.len() == BASE_KEY_LEN {
        config.api_key.clone()
    } else {
        config::API_KEY.to_string()
    };
    let api_secret = if config.api_secret.len() == BASE_KEY_LEN {
        config.api_secret.clone()
    } else {
        config::API_SECRET.to_string()
    };
    let auth_state = middleware::AuthState::with_api_keys(api_key.clone(), api_secret.clone());
    let state_secret = std::env::var("IPTRADE_STATE_SECRET")
        .unwrap_or_else(|_| "iptrade-default-secret-change-in-production".to_string());
    let state_manager = state::LocalStateFileManager::with_default_path(state_secret).map(Arc::new);

    let http_client = {
        let key_with_month = middleware::AuthState::key_with_month(&api_key);
        let secret_with_month = middleware::AuthState::key_with_month(&api_secret);
        let mut headers = reqwest::header::HeaderMap::new();
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&key_with_month) {
            headers.insert(config::API_KEY_HEADER, v);
        }
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&secret_with_month) {
            headers.insert(config::API_SECRET_HEADER, v);
        }
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("HTTP client with api key headers")
    };
    let heartbeat_registry = routes::new_heartbeat_registry();
    let linking_platform: app_state::LinkingPlatform = Arc::new(std::sync::Mutex::new(None));
    let tcp_listening_port: app_state::TcpListeningPort = Arc::new(tokio::sync::RwLock::new(None));

    port::kill_process_on_port(config.tcp_port).ok();

    let (tcp_server, tcp_listener, actual_tcp_port) =
        setup::setup_tcp(&config, &tcp_listening_port).await;

    let (tcp_shutdown_tx, tcp_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (shutdown_request_tx, shutdown_request_rx) = tokio::sync::oneshot::channel::<()>();
    let shutdown_trigger_tx: app_state::ShutdownTriggerTx =
        Arc::new(std::sync::Mutex::new(Some(shutdown_request_tx)));

    if let (Some(server), Some(listener)) = (tcp_server.as_ref(), tcp_listener) {
        let server_clone = server.clone();
        tokio::spawn(async move {
            server_clone.run_until(listener, tcp_shutdown_rx).await;
        });
    }
    if actual_tcp_port.is_none() {
        *tcp_listening_port.write().await = Some(config.tcp_port);
    }

    let (app_state, ctrader_trigger_connect_rx, ctrader_disconnect_rx, copy_suspend_rx, copy_manager_trigger_rx) = setup::build_app_state(
        config.clone(),
        auth_state.clone(),
        state_manager,
        http_client,
        heartbeat_registry,
        linking_platform,
        tcp_listening_port,
        tcp_server.clone(),
        shutdown_trigger_tx,
    );

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let auth_state_for_layer = auth_state.clone();
    let app = {
        axum::Router::new()
            .merge(routes::health_route())
            .merge(routes::auth_ctrader_router())
            .merge(routes::accounts_router())
            .merge(routes::heartbeat_router())
            .merge(routes::bots_router())
            .merge(routes::system_router())
            .merge(routes::logs_router())
            .merge(routes::history_router())
            .merge(routes::orders_router())
            .merge(if build_config::SHOW_SWAGGER_DOCS { routes::docs_router() } else { axum::Router::<app_state::AppState>::new() })
    }
        .layer(cors)
        .layer(axum_middleware::from_fn(move |req, next| {
            let auth = auth_state_for_layer.clone();
            async move { middleware::auth_middleware(req, next, auth).await }
        }))
        .with_state(app_state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));

    port::kill_process_on_port(config.port).ok();
    const MAX_WAIT_MS: u64 = 15_000;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(MAX_WAIT_MS);
    let listener = loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                if std::time::Instant::now() >= deadline {
                    let pids = port::pids_on_port(config.port).unwrap_or_default();
                    if pids.is_empty() {
                        tracing::error!(
                            "API port still in use after {} s. netstat did not find any process holding it (maybe another user or reserved). Free it manually or change the configured port.",
                            MAX_WAIT_MS / 1000
                        );
                    } else {
                        tracing::error!(
                            "API port still in use after {} s by {} process(es). Use the OS task manager / `taskkill` (Windows) or `kill` (Unix) to free it.",
                            MAX_WAIT_MS / 1000,
                            pids.len()
                        );
                    }
                    return Err(e.into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(timings::API_PROCESS_POLL_MS)).await;
            }
            Err(e) => return Err(e.into()),
        }
    };

    if !is_prod {
        let listening_msg = String::from("API listening.\n");
        let _ = std::io::stdout().write_all(listening_msg.as_bytes());
        let _ = std::io::stdout().flush();
    }

    let app_state_ctrader = app_state.clone();
    let tcp_server_ctrader = tcp_server.clone();
    tokio::spawn(async move {
        routes::apply_system_tcp_ordered_from_preferences(&app_state_ctrader).await;
        if let Some(ref tcp) = tcp_server_ctrader {
            tcp.set_tcp_enabled_map(Some(app_state_ctrader.tcp_enabled.clone())).await;
            tcp.set_snapshot_caches(
                Some(app_state_ctrader.mt_snapshot_cache.clone()),
                Some(app_state_ctrader.ctrader_snapshot_cache.clone()),
            )
            .await;
        }
        setup::start_ctrader_and_copy_trading(
            &app_state_ctrader,
            ctrader_trigger_connect_rx,
            ctrader_disconnect_rx,
            copy_suspend_rx,
            copy_manager_trigger_rx,
        )
        .await;
        background::spawn_all(&app_state_ctrader);
    });

    let tcp_server_gs = tcp_server.clone();
    let shutdown_future = async move {
        let sigterm_fut = async {
            #[cfg(unix)]
            {
                let mut s = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM");
                let _ = s.recv().await;
            }
            #[cfg(not(unix))]
            {
                std::future::pending::<()>().await
            }
        };
        tokio::pin!(sigterm_fut);
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm_fut => {}
            _ = shutdown_request_rx => {}
        }
        if let Some(ref tcp) = tcp_server_gs {
            tcp.close_all_sessions().await;
        }
        let _ = tcp_shutdown_tx.send(());
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_future)
        .await?;
    Ok(())
}
