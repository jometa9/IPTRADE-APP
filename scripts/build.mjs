#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(cmd, label, env = {}) {
  console.log('[build] ▶', label);
  console.log('[build]   $', cmd);
  const start = Date.now();
  execSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  console.log('[build] ✓', label, `(${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
}

function removeDirRobust(dirPath, label) {
  if (!fs.existsSync(dirPath)) return true;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      if (!fs.existsSync(dirPath)) return true;
    } catch {

    }

    try {
      const p = dirPath.replace(/'/g, "''");
      execSync(`powershell -NoProfile -NonInteractive -Command "if (Test-Path -LiteralPath '${p}') { attrib -R -S -H /S /D '${p}\\*' 2>$null; Remove-Item -LiteralPath '${p}' -Recurse -Force -ErrorAction SilentlyContinue }"`, {
        cwd: root,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
    }

    if (!fs.existsSync(dirPath)) return true;

    sleep(700);
  }

  if (fs.existsSync(dirPath)) {
    console.error(`[build] WARN: could not clean ${label}: ${dirPath} (likely locked by another process)`);
    return false;
  }
  return true;
}

function cleanReleaseDir(dir) {
  if (!fs.existsSync(dir)) return;
  const cleaned = removeDirRobust(dir, path.basename(dir));
  if (!cleaned) {
    console.error(`[build] ERROR: could not clean ${dir}.`);
    console.error('[build] Close any running IPTRADE process and retry so output stays intact.');
    process.exit(1);
  }
  console.log(`[build] Cleaned ${path.basename(dir)}/\n`);
}

function verifyPackagedOutput(buildOutputDir, isWin) {
  const binName = isWin ? 'iptrade-api.exe' : 'iptrade-api';
  const verifyPaths = isWin
    ? [path.join(buildOutputDir, 'win-unpacked', 'resources', 'bin', binName)]
    : [
        path.join(buildOutputDir, 'mac-arm64', 'IPTRADE.app', 'Contents', 'Resources', 'bin', binName),
        path.join(buildOutputDir, 'mac', 'IPTRADE.app', 'Contents', 'Resources', 'bin', binName),
      ];
  if (!verifyPaths.some((p) => fs.existsSync(p))) {
    console.error('[build] ERROR: Rust binary NOT FOUND in packaged app. Installed app will not work.');
    process.exit(1);
  }
  console.log('[build] Verified: Rust binary present in package\n');
}

function writeBuilderConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const baseBuild = JSON.parse(JSON.stringify(pkg.build));

  baseBuild.directories = baseBuild.directories || {};
  baseBuild.directories.output = releaseDir;

  const configPath = path.join(root, '.electron-builder.json');
  fs.writeFileSync(configPath, JSON.stringify(baseBuild, null, 2));
  return configPath;
}

function buildApp({ isWin, isMac }) {
  const distDir = path.join(root, 'dist');
  if (fs.existsSync(distDir)) removeDirRobust(distDir, 'dist');
  run('npm run build:frontend', 'Frontend (Vite)');

  const configPath = writeBuilderConfig();
  const platformFlag = isMac ? '--mac' : '--win';
  try {
    run(
      `node node_modules/electron-builder/cli.js ${platformFlag} --publish=never --config="${configPath}"`,
      'electron-builder'
    );
  } finally {
    try { fs.rmSync(configPath, { force: true }); } catch {}
  }

  verifyPackagedOutput(releaseDir, isWin);
}

function buildRust() {
  run(`cargo build --release`, 'Rust (release)');
}

function main() {
  const plat = platform();
  const isMac = plat === 'darwin';
  const isWin = plat === 'win32';

  if (!isMac && !isWin) {
    console.error('[build] Only macOS (arm64) and Windows (x64) are supported.');
    process.exit(1);
  }

  console.log('\n[build] ========== IPTRADE Build ==========');
  console.log('[build] Platform:', isMac ? 'mac (arm64)' : 'win (x64)');
  console.log('[build] Builds are unsigned — see README for install notes.\n');

  cleanReleaseDir(releaseDir);

  try {
    if (isWin) {
      execSync('taskkill /IM iptrade-api.exe /F 2>nul', { cwd: root, stdio: 'ignore' });
    } else {
      execSync('pkill -9 iptrade-api 2>/dev/null || true', { cwd: root, stdio: 'ignore' });
    }
  } catch {}

  buildRust();
  run('npm run build:electron', 'Electron (compile + sync config)');

  buildApp({ isWin, isMac });

  console.log('[build] ========== Build complete ==========');
  if (fs.existsSync(releaseDir)) {
    console.log('[build] Artifacts in release/');
    const files = fs.readdirSync(releaseDir).filter((f) => !f.startsWith('.'));
    files.forEach((f) => console.log('[build]   -', f));
  }
  console.log('');
}

main();
