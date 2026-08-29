pub const HTTP_PORT: u16 = 7777;
pub const TCP_PORT: u16 = 7776;
pub const SHOW_SWAGGER_DOCS: bool = false;
macro_rules! base_url { () => { "https://jometa9.github.io/IPTRADE" }; }
// Local-only auth pair shared with the MetaTrader EAs (copybridge.dll). The API
// binds to 127.0.0.1, so this is an installation identifier, not a secret.
pub const API_KEY: &str = "a7f3c9e2b1d84f6a5e8c0b3d7f2a9e1c4b6d8a0f3e5c7b9d1a2e4f6c8b0d2a4";
pub const API_SECRET: &str = "9e5b1c7d3a6f0e2d8b4a6c0e2f4a8b0d2c6e8a0b4d6f8c0e2a4b6d8f0c2e4a6";
pub const CTRADER_REDIRECT_URI_LOCAL: &str = concat!(base_url!(), "/auth/local/callback");
