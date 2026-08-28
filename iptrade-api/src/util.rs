pub fn tcp_host_for_accounts() -> String {
    std::env::var("TCP_PUBLIC_HOST")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

pub fn api_base_for_accounts(port: u16) -> String {
    std::env::var("API_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("http://localhost:{}", port))
}

pub fn tcp_port_from_base_url(tcp_base_url: &str) -> Option<u16> {
    let s = tcp_base_url.trim();
    let after_last_colon = s.rfind(':').map(|i| &s[i + 1..])?;
    after_last_colon.split('/').next()?.parse().ok()
}

pub fn tcp_url_for_account(tcp_port: u16, account_id: &str) -> String {
    format!("tcp://{}:{}/{}", tcp_host_for_accounts(), tcp_port, account_id)
}
