import { BrowserWindow, app, ipcMain, shell, nativeImage, Tray, Menu, powerMonitor, screen, session } from 'electron';
import path from 'path';
import fs from 'fs';

import {
  getServerUrl,
  getApiKeys,
  preemptSingleInstancePeers,
  runLaunchCleanup,
  startProductionServer,
  stopProductionServer,
  forceKillApiOnPort,
  ensureServerRunning,
  pingServerOnly,
} from './serverProduction';
import { BUILD_CONFIG } from './buildConfig';
import { appendLogLineWithRetention, trimLogFileToRetention } from './logRetention';

const appRoot = path.resolve(__dirname, '..', '..');

function getMainLogPath(): string {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'main.log');
  } catch {
    return '';
  }
}
function logMain(message: string, isError = false): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (app.isPackaged) {
    try {
      appendLogLineWithRetention(getMainLogPath(), line);
    } catch {}
  }
  if (isError) console.error(message);
  else console.log(message);
}

const DEFAULT_WINDOW = { width: 800, height: 600, x: undefined as number | undefined, y: undefined as number | undefined };

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function isPointOnAnyDisplay(x: number, y: number): boolean {
  try {
    const displays = screen.getAllDisplays();
    for (const d of displays) {
      const b = d.bounds;
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function loadWindowState(): WindowState {
  try {
    const p = getWindowStatePath();
    if (!fs.existsSync(p)) return { ...DEFAULT_WINDOW };
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as Partial<WindowState>;
    const w = typeof data.width === 'number' && data.width >= 800 ? data.width : DEFAULT_WINDOW.width;
    const h = typeof data.height === 'number' && data.height >= 600 ? data.height : DEFAULT_WINDOW.height;
    let x: number | undefined = typeof data.x === 'number' ? data.x : undefined;
    let y: number | undefined = typeof data.y === 'number' ? data.y : undefined;
    if (x != null && y != null && !isPointOnAnyDisplay(x, y)) {
      x = undefined;
      y = undefined;
    }
    return { width: w, height: h, x, y };
  } catch {
    return { ...DEFAULT_WINDOW };
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  try {
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    const state: WindowState = { width, height, x, y };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf8');
  } catch {
  }
}

function getFrontendPort(): number {
  return BUILD_CONFIG.FRONTEND_PORT;
}

function getFrontendServerUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  return `http://localhost:${getFrontendPort()}`;
}

const showDevTools = false;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let deeplinkingUrl: string | undefined;
let pendingDeepLinkUrl: string | undefined;
let trayMenuJustClosed = false;
let trayMenuJustClosedTimer: ReturnType<typeof setTimeout> | null = null;

const urlFromArgv = process.argv.find((arg) => arg.toLowerCase().startsWith('iptrade://'));
if (urlFromArgv) {
  deeplinkingUrl = urlFromArgv;
}

app.setName('IPTRADE');
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'IPTRADE'));
}

if (app.isPackaged && process.platform === 'win32' && !urlFromArgv) {
  preemptSingleInstancePeers();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  runLaunchCleanup();
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.show();
    }
    const urlFromArgs = commandLine.find((arg) => arg.toLowerCase().startsWith('iptrade://'));
    if (urlFromArgs) {
      setTimeout(() => handleDeepLink(urlFromArgs), 200);
    }
  });

  app.whenReady().then(async () => {
    try {
      await session.defaultSession.clearCache();
    } catch (e) {
      console.warn('[main] clearCache failed:', e);
    }
    if (app.isPackaged) {
      const mainLogPath = getMainLogPath();
      trimLogFileToRetention(mainLogPath, true);
      setInterval(() => trimLogFileToRetention(mainLogPath, true), 60 * 60 * 1000);
    }
    if (app.isPackaged) {
      logMain('[main] Packaged app started — logs also in: ' + getMainLogPath());
    }
    setupPowerMonitor();
    void ensureServerRunning().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logMain('[main] ensureServerRunning failed: ' + msg, true);
    });
    if (!app.isPackaged && process.platform === 'darwin') {
      const dockIconPath = getWindowIconPath();
      if (dockIconPath && app.dock) {
        app.dock.setIcon(dockIconPath);
      }
    }
    if (process.platform === 'win32') {
      app.setAsDefaultProtocolClient('iptrade', process.execPath, [appRoot]);
    } else {
      app.setAsDefaultProtocolClient('iptrade');
    }
    await createWindow();
    if (!app.isPackaged) {
      console.log('[main] Dev: make sure "npm run dev" is running.');
    }
    if (process.platform === 'darwin') {
      const trayIconPath = getTrayIconPath();
      if (trayIconPath) {
        const trayImage = nativeImage.createFromPath(trayIconPath);
        trayImage.setTemplateImage(true);
        tray = new Tray(trayImage);
        tray.setToolTip('IPTRADE');
        tray.on('click', () => {
          if (!tray) return;
          if (trayMenuJustClosed) {
            trayMenuJustClosed = false;
            if (trayMenuJustClosedTimer) {
              clearTimeout(trayMenuJustClosedTimer);
            }
            return;
          }
          const menu = buildTrayMenu();
          menu.once('menu-will-close', () => {
            trayMenuJustClosed = true;
            if (trayMenuJustClosedTimer) {
              clearTimeout(trayMenuJustClosedTimer);
            }
            trayMenuJustClosedTimer = setTimeout(() => {
              trayMenuJustClosed = false;
              trayMenuJustClosedTimer = null;
            }, 200);
          });
          tray.setContextMenu(menu);
          tray.popUpContextMenu();
        });
      }
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

function handleDeepLink(url: string) {
  pendingDeepLinkUrl = url;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.show();
    mainWindow.webContents.send('deep-link', { url });
  } else {
    deeplinkingUrl = url;
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function getWindowIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconPath = path.join(appRoot, 'public', iconName);
  return fs.existsSync(iconPath) ? iconPath : '';
}

function getTrayIconPath(): string {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'public', 'iconTrayTemplate.png');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  const base = path.join(appRoot, 'public', 'iconTrayTemplate.png');
  return fs.existsSync(base) ? base : '';
}

function openSettingsInFrontend(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate-to-settings');
  }
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Settings', click: () => openSettingsInFrontend() },
    { type: 'separator' },
    { label: '瞬写', enabled: false },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
}

let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;

async function createWindow() {
  const iconPath = getWindowIconPath();
  const state = loadWindowState();
  const preloadPath = path.join(__dirname, 'preload.js');
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: state.width,
    minWidth: 850,
    height: state.height,
    minHeight: 700,
    ...(state.x != null && state.y != null && { x: state.x, y: state.y }),
    title: 'IPTRADE',
    show: false,
    alwaysOnTop: false,
    ...(iconPath && { icon: nativeImage.createFromPath(iconPath) }),
    ...(process.platform === 'darwin' && { titleBarStyle: 'hiddenInset' }),
    ...(isWindows && { titleBarStyle: 'hidden' }),
    ...(isWindows && {
      titleBarOverlay: {
        color: '#FFFFFF',
        symbolColor: '#111827',
        height: 40,
      },
    }),
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  const sendFullScreen = (isFullScreen: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fullscreen-changed', isFullScreen);
    }
  };
  let shown = false;
  const ensureShow = (from: string) => {
    if (mainWindow && !mainWindow.isDestroyed() && !shown) {
      shown = true;
      mainWindow.show();
      mainWindow.focus();
    }
  };
  mainWindow.once('ready-to-show', () => {
    ensureShow('ready-to-show');
    sendFullScreen(mainWindow?.isFullScreen() ?? false);
  });
  mainWindow.on('enter-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-full-screen', () => sendFullScreen(false));
  mainWindow.on('enter-html-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-html-full-screen', () => sendFullScreen(false));

  mainWindow.setMenu(null);
  Menu.setApplicationMenu(null);

  if (!showDevTools) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const mod = input.control || input.meta;
      const k = input.key?.toLowerCase() ?? '';
      const blocked =
        input.key === 'F12' ||
        input.key === 'F5' ||
        (mod && !input.shift && k === 'r') ||
        (mod && input.shift && k === 'r') ||
        (mod && input.shift && k === 'i') ||
        (mod && input.shift && k === 'j') ||
        (mod && k === 'u');
      if (blocked) event.preventDefault();
    });
  }
  mainWindow.webContents.on('context-menu', (e) => e.preventDefault());

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('iptrade://')) {
      event.preventDefault();
      handleDeepLink(url);
      return;
    }
    const currentUrl = mainWindow?.webContents.getURL() ?? '';
    let allowed = false;
    try {
      allowed =
        !!currentUrl && new URL(url).origin === new URL(currentUrl).origin;
    } catch {}
    if (
      !allowed &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('http://127.0.0.1')
    ) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('iptrade://')) {
      handleDeepLink(url);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  if (showDevTools) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });
  }

  const frontendUrl = getFrontendServerUrl();
  const distPath = app.isPackaged
    ? path.join(app.getAppPath(), 'dist', 'index.html')
    : path.join(appRoot, 'dist', 'index.html');
  if (frontendUrl) {
    mainWindow.loadURL(frontendUrl).then(() => {
      ensureShow('loadURL-ok');
    }).catch((err) => {
      logMain('[createWindow] loadURL failed: ' + String(err?.message ?? err) + ' url=' + frontendUrl, true);
      ensureShow('loadURL-catch');
    });
  } else {
    logMain('[main] Loading frontend from: ' + distPath);
    mainWindow.loadFile(distPath).then(() => {
      ensureShow('loadFile-ok');
      logMain('[main] Frontend loaded OK');
    }).catch((err) => {
      logMain('[createWindow] loadFile failed: ' + String(err?.message ?? err) + ' path=' + distPath, true);
      ensureShow('loadFile-catch');
    });
  }
  if (deeplinkingUrl) {
    handleDeepLink(deeplinkingUrl);
    deeplinkingUrl = undefined;
  }
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLinkUrl && mainWindow && !mainWindow.isDestroyed()) {
      const urlToSend = pendingDeepLinkUrl;
      pendingDeepLinkUrl = undefined;
      setTimeout(() => {
        if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('deep-link', { url: urlToSend });
        }
      }, 1500);
    }
  });
  const scheduleSaveState = () => {
    if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
    saveWindowStateTimer = setTimeout(() => {
      saveWindowStateTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
    }, 500);
  };
  mainWindow.on('resize', scheduleSaveState);
  mainWindow.on('move', scheduleSaveState);

  mainWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
    if (isQuitting) return;
    e.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel: string) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

function setupPowerMonitor() {
  powerMonitor.on('suspend', () => sendToRenderer('system-suspend'));
  powerMonitor.on('resume', () => sendToRenderer('system-resume'));
  powerMonitor.on('lock-screen', () => sendToRenderer('system-suspend'));
  powerMonitor.on('unlock-screen', () => sendToRenderer('system-resume'));
}

app.on('window-all-closed', () => {
  void stopProductionServer().then(() => app.quit());
});

app.on('will-quit', () => {
  forceKillApiOnPort();
});

let isQuitting = false;
const PREPARE_QUIT_TIMEOUT_MS = 10_000;

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  let quitDone = false;
  const doQuit = () => {
    if (quitDone) return;
    quitDone = true;
    stopProductionServer().then(() => app.quit());
  };
  mainWindow?.webContents?.send('prepare-quit');
  ipcMain.once('quit-ready', doQuit);
  setTimeout(doQuit, PREPARE_QUIT_TIMEOUT_MS);
});

ipcMain.handle('get-pending-deep-link', () => {
  const url = pendingDeepLinkUrl ?? null;
  return url;
});
ipcMain.handle('clear-pending-deep-link', (_event, urlToClear: string) => {
  if (pendingDeepLinkUrl === urlToClear) pendingDeepLinkUrl = undefined;
});
ipcMain.handle('get-server-url', () => getServerUrl());
ipcMain.handle('get-api-keys', () => getApiKeys());
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('get-is-full-screen', () => (mainWindow ? mainWindow.isFullScreen() : false));
ipcMain.handle('check-server-status', async () => {
  try {
    const ok = await ensureServerRunning();
    return { ok, url: getServerUrl() };
  } catch {
    return { ok: false, url: getServerUrl() };
  }
});

ipcMain.handle('ping-server', async () => {
  try {
    const ok = await pingServerOnly();
    return { ok };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle('open-external-link', async (_event, url: string) => {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u || (!u.startsWith('http://') && !u.startsWith('https://'))) {
    console.warn('[main] open-external-link: invalid URL or not http(s)');
    return;
  }
  try {
    await shell.openExternal(u);
  } catch (e) {
    console.error('[main] open-external-link failed:', e);
    throw e;
  }
});
ipcMain.handle(
  'set-window-button-position',
  (_event, { x, y }: { x: number | null; y: number | null }) => {
    if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed()) return;
    if (x == null || y == null) {
      mainWindow.setWindowButtonPosition(null);
    } else {
      mainWindow.setWindowButtonPosition({ x, y });
    }
  }
);
