import { ChildProcess, spawn, execSync } from 'child_process';
import { platform } from 'os';
import { app } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { BUILD_CONFIG } from './buildConfig';
import { appendLogLineWithRetention } from './logRetention';

const API_KEYS_FILENAME = 'api-keys.json';
const STATE_SECRET_FILENAME = '.state-secret';

const DEFAULT_API_KEY = BUILD_CONFIG.API_KEY;
const DEFAULT_API_SECRET = BUILD_CONFIG.API_SECRET;

function appendMainLog(line: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    appendLogLineWithRetention(path.join(dir, 'main.log'), `[${new Date().toISOString()}] ${line}`);
  } catch {}
}

const DYNAMIC_INSERT_POS = 10;
const DYNAMIC_LEN = 2;

function buildDynamicKey(baseKey: string): string {
  if (baseKey.length < DYNAMIC_INSERT_POS + 1) return baseKey;
  const month = (new Date().getUTCMonth() + 1) * 2;
  const monthStr = String(month).padStart(DYNAMIC_LEN, '0');
  return baseKey.slice(0, DYNAMIC_INSERT_POS) + monthStr + baseKey.slice(DYNAMIC_INSERT_POS);
}

export interface ApiKeys {
  apiKey: string;
  apiSecret: string;
}

let serverProcess: ChildProcess | null = null;
let cachedApiKeys: ApiKeys | null = null;

function getPort(): number {
  return BUILD_CONFIG.API_PORT;
}

const isWin = platform() === 'win32';

function killProcessOnPortWindows(port: number): void {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
    const portStr = `:${port}`;
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(portStr) || !line.toUpperCase().includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const last = parts[parts.length - 1];
      const pid = parseInt(last, 10);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    const myPid = process.pid;
    for (const pid of pids) {
      if (pid === myPid) continue;
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true });
      } catch {
      }
    }
  } catch {
  }
}

function killProcessOnPortSync(port: number): void {
  try {
    if (isWin) {
      killProcessOnPortWindows(port);
    } else {
      execSync(`lsof -ti :${port} 2>/dev/null | xargs kill -9 2>/dev/null`, { stdio: 'ignore', shell: '/bin/sh' });
    }
  } catch {
  }
}

async function killProcessOnPort(port: number): Promise<void> {
  killProcessOnPortSync(port);
  await new Promise(r => setTimeout(r, isWin ? 500 : 200));
}

function killOtherWindowsSameExePeers(): void {
  if (!isWin || !app.isPackaged) return;
  const exeName = path.basename(app.getPath('exe'));
  const myPid = process.pid;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH`, {
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === myPid) continue;
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true });
      } catch {
      }
    }
  } catch {
  }
}

export function preemptSingleInstancePeers(): void {
  killOtherWindowsSameExePeers();
  if (isWin && app.isPackaged) {
    try {
      execSync('cmd.exe /c ping -n 2 127.0.0.1 >nul', { stdio: 'ignore', windowsHide: true });
    } catch {
    }
  }
}

function killOtherAppInstances(): void {
  killOtherWindowsSameExePeers();
  const appRoot = getAppRoot();
  const myPid = process.pid;
  try {
    if (isWin) {
      const escaped = appRoot.replace(/\\/g, '\\\\').replace(/'/g, "''");
      const ps = `$root = '${escaped}'; Get-CimInstance Win32_Process -Filter "name like '%electron%'" | Where-Object { $_.CommandLine -like "*$root*" -and $_.ProcessId -ne ${myPid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore', windowsHide: true });
    } else {
      const pids = execSync('pgrep -f -i "Electron"', { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        const pidNum = Number(pid);
        if (pidNum === myPid) continue;
        try {
          const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim();
          if (cmd.includes(appRoot)) {
            process.kill(pidNum, 'SIGKILL');
          }
        } catch {
        }
      }
    }
  } catch {
  }
}

export function runLaunchCleanup(): void {
  killProcessOnPortSync(getPort());
  killProcessOnPortSync(BUILD_CONFIG.TCP_PORT);
  killOtherAppInstances();
}

function getAppRoot(): string {
  if (app.isPackaged) {
    return path.dirname(app.getPath('exe'));
  }
  return path.resolve(__dirname, '..', '..');
}

function getApiKeysPath(): string {
  return path.join(app.getPath('userData'), API_KEYS_FILENAME);
}

function getStateSecretPath(): string {
  return path.join(app.getPath('userData'), STATE_SECRET_FILENAME);
}

export function ensureStateSecret(): string {
  const filePath = getStateSecretPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw.length >= 32) return raw;
    }
  } catch {
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(filePath, secret, 'utf8');
    if (process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (e) {
    console.warn('[serverProduction] Could not persist state secret:', e);
  }
  return secret;
}

export function ensureApiKeys(): ApiKeys {
  if (cachedApiKeys) return cachedApiKeys;
  const filePath = getApiKeysPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw) as { apiKey?: string; apiSecret?: string };
      const k = typeof data?.apiKey === 'string' ? data.apiKey.trim() : '';
      const s = typeof data?.apiSecret === 'string' ? data.apiSecret.trim() : '';
      if (k && s) {
        cachedApiKeys = { apiKey: k, apiSecret: s };
        return cachedApiKeys;
      }
    }
  } catch {
  }
  cachedApiKeys = { apiKey: DEFAULT_API_KEY, apiSecret: DEFAULT_API_SECRET };
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ apiKey: cachedApiKeys.apiKey, apiSecret: cachedApiKeys.apiSecret }),
      'utf8'
    );
  } catch (e) {
    console.warn('[serverProduction] Could not persist api-keys.json:', e);
  }
  return cachedApiKeys;
}

function getRustBinaryPath(): string {
  const appRoot = getAppRoot();
  if (app.isPackaged) {
    const resourcesPath = process.resourcesPath;
    const binDir = path.join(resourcesPath, 'bin');
    const isWindows = process.platform === 'win32';
    const name = isWindows ? 'iptrade-api.exe' : 'iptrade-api';
    return path.join(binDir, name);
  }
  const isWindows = process.platform === 'win32';
  const name = isWindows ? 'iptrade-api.exe' : 'iptrade-api';
  return path.join(appRoot, 'target', 'debug', name);
}

async function spawnRustProcess(port: number, keys: ApiKeys): Promise<ChildProcess> {
  const binaryPath = getRustBinaryPath();
  const binaryExists = fs.existsSync(binaryPath);
  if (!binaryExists) {
    const msg = `[serverProduction] Rust binary not found: ${binaryPath}`;
    console.error(msg);
    if (app.isPackaged) appendMainLog(msg);
    throw new Error(`Rust binary not found: ${binaryPath}`);
  }
  const appRoot = getAppRoot();
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.NO_PROXY = ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY].filter(Boolean).join(',');
  env.no_proxy = env.NO_PROXY;
  const stateDir = app.getPath('userData');
  const statePath = path.join(stateDir, '.state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
  }
  env.IPTRADE_STATE_PATH = statePath;
  env.IPTRADE_STATE_SECRET = ensureStateSecret();
  env.IPTRADE_API_KEY = keys.apiKey;
  env.IPTRADE_API_SECRET = keys.apiSecret;
  env.APP_VERSION = app.getVersion();
  if (app.isPackaged) {
    env.IPTRADE_ELECTRON_PROD = '1';
    const logsDir = path.join(stateDir, 'logs');
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {
    }
  } else {
    env.RUST_BACKTRACE = '1';
  }
  if (process.platform === 'win32') {
    const botsPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bots')
      : path.join(appRoot, 'bots');
    if (fs.existsSync(botsPath)) {
      env.BOTS_SOURCE_PATH = botsPath;
      env.INSTALL_BOTS_ENABLED = 'true';
    }
  }
  env.IPTRADE_ELECTRON_PLATFORM = process.platform;
  const cwd = app.isPackaged ? path.dirname(binaryPath) : path.join(appRoot, 'iptrade-api');
  const proc = spawn(binaryPath, [], {
    env,
    cwd,
    stdio: 'pipe',
    windowsHide: true,
  });
  proc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write('[iptrade-api] ' + chunk.toString());
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write('[iptrade-api] ' + chunk.toString());
  });
  proc.on('error', err => {
    const msg = '[serverProduction] Rust process spawn error: ' + String(err?.message ?? err);
    console.error(msg);
    if (app.isPackaged) appendMainLog(msg);
  });
  proc.on('close', (code, signal) => {
    if (serverProcess === proc) {
      serverProcess = null;
    }
    if (code != null && code !== 0) {
      const msg = `[serverProduction] Rust process exited code=${code} signal=${signal}`;
      console.error(msg);
      if (app.isPackaged) appendMainLog(msg);
    }
  });
  return proc;
}

function pingHealth(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request(
      { host, port, path: '/api/health', method: 'GET', timeout: 3000 },
      res => {
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function pingStatus(port: number, _keys: ApiKeys): Promise<boolean> {
  return pingHealth('127.0.0.1', port);
}

async function waitForApiReady(port: number, keys: ApiKeys, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const pollIntervalMs = 500;
  while (Date.now() - start < timeoutMs) {
    if (await pingStatus(port, keys)) return true;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return false;
}

const API_READY_TIMEOUT_MS = 60_000;

export async function startProductionServer(): Promise<{ port: number; basePath: string }> {
  const port = getPort();
  const root = getAppRoot();
  const basePath = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(root, 'target', 'debug');

  const keys = ensureApiKeys();
  if (app.isPackaged) {
    if (await pingStatus(port, keys)) {
      return { port, basePath };
    }
    if (serverProcess && !serverProcess.killed) {
      const ready = await waitForApiReady(port, keys, API_READY_TIMEOUT_MS);
      if (ready) {
        return { port, basePath };
      }
    }
  } else {
    if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
    serverProcess = null;
  }
  await killProcessOnPort(port);
  serverProcess = await spawnRustProcess(port, keys);
  const ready = await waitForApiReady(port, keys, API_READY_TIMEOUT_MS);
  if (!ready) {
    const msg = '[serverProduction] API did not become ready in time.';
    console.error(msg);
    if (app.isPackaged) appendMainLog(msg);
    throw new Error('API did not respond within timeout');
  }
  return { port, basePath };
}

const KILL_TIMEOUT_MS = 1500;

function forceKill(proc: ChildProcess): void {
  try {
    if (!proc.pid) return;
    if (platform() === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      process.kill(proc.pid, 'SIGKILL');
    }
  } catch {
  }
}

function requestGracefulShutdown(port: number, keys: ApiKeys): Promise<void> {
  return new Promise((resolve) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port,
      path: '/api/system/shutdown',
      method: 'POST',
      timeout: 1500,
      headers: {
        'x-api-key': buildDynamicKey(keys.apiKey),
        'x-api-secret': buildDynamicKey(keys.apiSecret),
      },
    };
    const req = http.request(opts, () => resolve());
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

export function stopProductionServer(): Promise<void> {
  const proc = serverProcess;
  serverProcess = null;
  const port = getPort();
  const keys = ensureApiKeys();

  return new Promise<void>((resolve) => {
    if (!proc || proc.killed) {
      killProcessOnPortSync(port);
      resolve(undefined);
      return;
    }
    const timeout = setTimeout(() => {
      forceKill(proc);
      killProcessOnPortSync(port);
      resolve(undefined);
    }, KILL_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
    requestGracefulShutdown(port, keys).finally(() => proc.kill('SIGTERM'));
  }).finally(() => killProcessOnPortSync(port));
}

export function getServerUrl(): string {
  const port = getPort();
  return `http://127.0.0.1:${port}`;
}

export async function pingServerOnly(): Promise<boolean> {
  const port = getPort();
  const keys = ensureApiKeys();
  return pingStatus(port, keys);
}

export function forceKillApiOnPort(): void {
  killProcessOnPortSync(getPort());
  killProcessOnPortSync(BUILD_CONFIG.TCP_PORT);
}

export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

let ensureServerPromise: Promise<boolean> | null = null;

export async function ensureServerRunning(): Promise<boolean> {
  const port = getPort();
  const keys = ensureApiKeys();
  if (await pingStatus(port, keys)) {
    return true;
  }
  if (ensureServerPromise) return ensureServerPromise;
  ensureServerPromise = (async () => {
    try {
      await startProductionServer();
      return true;
    } catch (error) {
      console.error('Failed to restart server:', error);
      return false;
    } finally {
      ensureServerPromise = null;
    }
  })();
  return ensureServerPromise;
}

export function getApiKeys(): ApiKeys {
  return ensureApiKeys();
}
