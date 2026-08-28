pub mod accounts;
mod auth_ctrader;
pub mod docs;
pub mod common;
mod bots;
pub mod heartbeat;
pub mod history;
mod logs;
pub mod orders;
mod system;

pub use accounts::router as accounts_router;
pub use auth_ctrader::router as auth_ctrader_router;
pub use bots::router as bots_router;
pub use heartbeat::{new_registry as new_heartbeat_registry, router as heartbeat_router, HeartbeatRegistry};
pub use history::router as history_router;
pub use orders::router as orders_router;
pub use system::{apply_system_tcp_ordered, apply_system_tcp_ordered_from_preferences, router as system_router};
pub use system::health_route;
pub use logs::router as logs_router;

pub use docs::router as docs_router;
