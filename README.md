# IPTRADE

**Free, open-source trade copier for MetaTrader 4/5 and cTrader.**

IPTRADE is a desktop app that copies trades between trading accounts in real time on your own computer. No cloud, no subscription, no account limits — your credentials and trading data never leave your machine.

- Website: [iptradecopier.com](https://iptradecopier.com)
- Downloads: [Releases](https://github.com/jometa9/IPTRADE-APP/releases/latest)
- Landing page source: [jometa9/IPTRADE](https://github.com/jometa9/IPTRADE)
- MetaTrader EAs + bridge DLL source: [jometa9/IPTRADE-BOTS](https://github.com/jometa9/IPTRADE-BOTS)

## Features

- Master/slave copy trading between any mix of MetaTrader 4, MetaTrader 5 and cTrader accounts
- Lot sizing per slave: fixed lot or multiplier, reverse trading, symbol prefix/suffix, symbol translations
- Live orders, balance/equity/PnL, trade history with calendar and statistics
- Local first: everything runs on `127.0.0.1`, state stored encrypted on disk

| Platform | MetaTrader 4 | MetaTrader 5 | cTrader |
| --- | --- | --- | --- |
| Windows (x64) | ✅ Expert Advisor | ✅ Expert Advisor | ✅ API |
| macOS (arm64) | — | — | ✅ API |

## Install

Download from [Releases](https://github.com/jometa9/IPTRADE-APP/releases/latest):

- **Windows**: `IPTRADE-Setup.exe`
- **macOS (Apple Silicon)**: `IPTRADE-Setup.dmg`

Builds are **not code-signed** (no paid Apple/Microsoft certificates), so the OS warns on first launch:

- **macOS**: if "IPTRADE is damaged / can't be opened" appears, run `xattr -cr /Applications/IPTRADE.app` in Terminal, or right-click the app → Open. On macOS 15+ allow it under System Settings → Privacy & Security → "Open Anyway".
- **Windows**: in the SmartScreen dialog click "More info" → "Run anyway".

You can always audit exactly what you are running — this repository is the full source, and CI builds the installers from it.

## Architecture

Three processes, all local:

```
┌──────────────────────────── Electron shell ───────────────────────────┐
│  React UI (Vite)  ⇄  iptrade-api (Rust · axum)                        │
│                       HTTP 127.0.0.1:7777 · TCP 7776                  │
└───────────────────────────────────────────────────────────────────────┘
        ▲ HTTP heartbeat + WebSocket                ▲ ProtoOA (TLS)
        │                                           │
  MetaTrader terminals                         cTrader servers
  IPTRADE EA + copybridge.dll                  (your own Open API app)
```

- **`electron/`** — shell: spawns and supervises the Rust binary, tray, deep links (`iptrade://`), window lockdown.
- **`src/`** — React UI (Vite + Tailwind + Radix).
- **`iptrade-api/`** — Rust backend: copy engine, account state (encrypted at rest), TCP server for master→slave streaming, cTrader Open API client.
- **`bots/`** — compiled MetaTrader artifacts (`IPTRADE.ex4/.ex5` + `copybridge.dll`) that the app installs into your terminals on Windows. Their source lives in [IPTRADE-BOTS](https://github.com/jometa9/IPTRADE-BOTS).

### How accounts connect

- **MetaTrader (Windows)**: the app installs the IPTRADE Expert Advisor into your MT4/MT5 terminals. The EA (through `copybridge.dll`) sends a heartbeat to `POST /api/heartbeat` on port 7777, exposes a local HTTP/WebSocket server for orders, and masters stream trade events to slaves over local TCP (one JSON object per line).
- **cTrader**: OAuth through your browser against your **own cTrader Open API application** (see below), then the app talks ProtoOA directly to Spotware servers.

### cTrader setup

IPTRADE does not ship embedded cTrader API credentials — you use your own (takes ~2 minutes, free):

1. Sign in at [openapi.ctrader.com](https://openapi.ctrader.com) and create an application.
2. Set its **Redirect URL** to `https://iptradecopier.com/auth/local/callback` (that page only forwards the OAuth code back into the app via the `iptrade://` deep link — see [its source](https://github.com/jometa9/IPTRADE/blob/main/app/auth/local/callback/page.tsx)).
3. In IPTRADE go to **Config → cTrader API** and paste the app's Client ID and Secret. They are stored encrypted on your machine only.

### Local API auth

The Rust API binds to `127.0.0.1` and expects `x-api-key` / `x-api-secret` headers that the UI and the EAs share. These values are committed in the repo on purpose: they are a local handshake between processes on your own machine, not a secret — the API is never reachable from the network.

## Development

Prerequisites: Node 20+, Rust (stable). Windows additionally needs the MSVC toolchain.

```bash
npm ci
npm run dev        # builds the Rust API (debug), starts Vite + Electron
```

Useful env overrides in dev: `CTRADER_CLIENT_ID` / `CTRADER_CLIENT_SECRET` (skip the Config screen), `RUST_BACKTRACE=1`.

## Build installers

```bash
npm run build      # cargo build --release + vite build + electron-builder
```

- On macOS produces `release/IPTRADE-Setup.dmg` (arm64, ad-hoc signed).
- On Windows produces `release/IPTRADE-Setup.exe` (NSIS x64, unsigned).

Releases are built by [GitHub Actions](.github/workflows/release.yml): pushing a tag `vX.Y.Z` builds both platforms and publishes a GitHub Release. The app checks `releases/latest` (GitHub API) every 6 hours and shows an update banner when a newer version exists.

To cut a release: bump `version` in `package.json` **and** `iptrade-api/Cargo.toml`, commit, then:

```bash
git tag v4.2.1 && git push origin v4.2.1
```

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
