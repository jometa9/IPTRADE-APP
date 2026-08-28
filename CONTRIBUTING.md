# Contributing to IPTRADE

Thanks for your interest in improving IPTRADE!

## Getting started

1. Fork and clone the repo.
2. Install prerequisites: Node 20+, Rust stable (Windows also needs the MSVC toolchain).
3. `npm ci`, then `npm run dev` to run the app locally.

## Repo map

- `src/` — React UI (Vite + Tailwind).
- `electron/` — Electron shell (TypeScript, compiled to CJS).
- `iptrade-api/` — Rust backend (axum). `cargo check` from the repo root.
- `bots/` — compiled MetaTrader artifacts; source lives in [IPTRADE-BOTS](https://github.com/jometa9/IPTRADE-BOTS).

## Pull requests

- Keep changes focused; one topic per PR.
- Make sure `cargo check` and `npx tsc --noEmit -p tsconfig.json` pass.
- Describe how you tested the change (platform, account types involved).

## Reporting issues

Open a GitHub issue with:

- OS and app version (Config screen shows it).
- Platform(s) involved (MT4/MT5/cTrader) and master/slave setup.
- Steps to reproduce, expected vs actual behavior.
- Relevant lines from the Live Logs screen if applicable.

## Security

The local API is bound to `127.0.0.1` by design. If you find a real security issue (e.g. something reachable from the network, or credentials leaving the machine), please open an issue or contact the maintainer directly.
