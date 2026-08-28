#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const FRONTEND_PORT = 7775;
const API_PORT = 7777;
const TCP_PORT = 7776;

function latestMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  let latest = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const t = latestMtime(full);
      if (t > latest) latest = t;
    } else if (st.mtimeMs > latest) {
      latest = st.mtimeMs;
    }
  }
  return latest;
}

function ensureRustBuilt() {
  const rustSrcDir = path.join(root, 'iptrade-api', 'src');
  const cargoToml = path.join(root, 'iptrade-api', 'Cargo.toml');
  const cargoLock = path.join(root, 'Cargo.lock');
  const binaryName = isWindows ? 'iptrade-api.exe' : 'iptrade-api';
  const rustBinary = path.join(root, 'target', 'debug', binaryName);

  const srcTime = Math.max(
    latestMtime(rustSrcDir),
    fs.existsSync(cargoToml) ? fs.statSync(cargoToml).mtimeMs : 0,
    fs.existsSync(cargoLock) ? fs.statSync(cargoLock).mtimeMs : 0
  );
  const distTime = fs.existsSync(rustBinary) ? fs.statSync(rustBinary).mtimeMs : 0;

  if (distTime >= srcTime && distTime > 0) {
    console.log('[electron:dev] Rust API up to date, skipping build');
    return;
  }
  console.log('[electron:dev] Building Rust API...');
  execSync('cd iptrade-api && cargo build', { cwd: root, stdio: 'inherit' });
}

function ensureElectronBuilt() {
  const mainJs = path.join(root, 'electron', 'dist', 'main.js');
  const srcDir = path.join(root, 'electron', 'src');
  const srcTime = latestMtime(srcDir);
  const distTime = fs.existsSync(mainJs) ? fs.statSync(mainJs).mtimeMs : 0;
  if (distTime < srcTime || distTime === 0) {
    console.log('[electron:dev] Building Electron main...');
    execSync('npm run build:electron', { cwd: root, stdio: 'inherit' });
  } else {
    console.log('[electron:dev] Electron main up to date, skipping build');
  }
}

function patchElectronProtocolForMac() {
  if (process.platform !== 'darwin') return;
  const appPath = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return;

  let alreadyPatched = false;
  try {
    const check = execSync(`defaults read "${plist}" CFBundleURLTypes 2>&1`, { encoding: 'utf8' }).trim();
    alreadyPatched = check.includes('iptrade');
  } catch {}

  if (!alreadyPatched) {
    try {
      execSync(
        `defaults write "${plist}" CFBundleURLTypes -array '{ CFBundleURLSchemes = (iptrade); CFBundleURLName = "IPTRADE URL"; }'`,
        { stdio: 'ignore' }
      );
      console.log('[electron:dev] Registered iptrade:// protocol in Electron.app plist');
    } catch {}
  }

  // Modifying Info.plist invalidates the ad-hoc code signature; on Apple Silicon
  // macOS will SIGKILL the process at launch (visible as "zsh: killed").
  // Re-sign whenever the embedded signature is missing or stale.
  try {
    const sigInfo = execSync(`codesign -dv "${appPath}" 2>&1`, { encoding: 'utf8' });
    if (sigInfo.includes('Info.plist=not bound') || !sigInfo.includes('Signature=adhoc')) {
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'ignore' });
      console.log('[electron:dev] Re-signed Electron.app (ad-hoc) after plist patch');
    }
  } catch {
    try {
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'ignore' });
      console.log('[electron:dev] Re-signed Electron.app (ad-hoc)');
    } catch {}
  }
}

function killPortsAndExit() {
  killAllPorts();
  process.exit(0);
}

function waitForVite() {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${FRONTEND_PORT}/`;
    const deadline = Date.now() + 60000;
    function poll() {
      if (Date.now() > deadline) {
        reject(new Error('Vite did not respond in time'));
        return;
      }
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on('error', () => setTimeout(poll, 300));
    }
    setTimeout(poll, 500);
  });
}

function killAllPorts() {
  const ports = [API_PORT, TCP_PORT, FRONTEND_PORT];
  for (const p of ports) {
    try {
      execSync(`node "${path.join(__dirname, 'kill-port.mjs')}" ${p}`, { cwd: root, stdio: 'inherit' });
    } catch {}
  }
}

async function main() {
  killAllPorts();
  await new Promise(r => setTimeout(r, 500));

  console.log('[electron:dev] Starting Vite...');
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteChild = spawn('node', [viteBin, '--port', String(FRONTEND_PORT), '--mode', 'development'], {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1,::1' },
  });
  viteChild.stdout?.on('data', c => process.stdout.write(c));
  viteChild.stderr?.on('data', c => process.stderr.write(c));
  viteChild.on('error', err => console.error('[electron:dev] Vite error:', err));
  process.on('exit', () => { try { viteChild.kill(); } catch {} });

  await waitForVite();
  console.log('[electron:dev] Vite ready at http://localhost:7775\n');

  ensureRustBuilt();
  ensureElectronBuilt();
  patchElectronProtocolForMac();

  const electronBin = path.join(root, 'node_modules', '.bin', isWindows ? 'electron.cmd' : 'electron');
  const doCleanup = () => {
    try { viteChild.kill('SIGKILL'); } catch {}
    killPortsAndExit();
  };
  process.on('SIGINT', doCleanup);
  process.on('SIGTERM', doCleanup);
  try {
    execSync(`"${electronBin}" .`, { cwd: root, stdio: 'inherit', shell: isWindows });
  } finally {
    doCleanup();
  }
}

main().catch(err => {
  console.error('[electron:dev]', err.message);
  process.exit(1);
});
