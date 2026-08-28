import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const appRoot = path.resolve(__dirname, '..', '..');

interface AfterPackContext {
  electronPlatformName: string;
  appOutDir: string;
}

function copyRustBinary(electronPlatformName: string, appOutDir: string) {
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const binDir = path.join(resourcesDir, 'bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  const isWindows = electronPlatformName === 'win32';
  const binaryName = isWindows ? 'iptrade-api.exe' : 'iptrade-api';
  const candidates = [
    path.join(appRoot, 'target', 'release', binaryName),
    path.join(appRoot, 'target', 'debug', binaryName),
    path.join(appRoot, 'iptrade-api', 'target', 'release', binaryName),
    path.join(appRoot, 'iptrade-api', 'target', 'debug', binaryName),
  ];
  const srcPath = candidates.find((p) => fs.existsSync(p)) ?? '';
  const destPath = path.join(binDir, binaryName);
  if (srcPath && fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    if (!isWindows) {
      try {
        fs.chmodSync(destPath, 0o755);
      } catch {
      }
    }
  } else {
    console.error(
      'afterPack: Rust binary NOT FOUND. Checked:',
      candidates.map((p) => path.relative(appRoot, p)).join(', ')
    );
  }
}

// Unsigned distribution: apply an ad-hoc signature so the arm64 binaries are
// runnable at all (Apple Silicon refuses completely unsigned code). Users still
// need to approve the app on first launch (right-click → Open).
function adHocSignMacApp(appOutDir: string) {
  if (!appOutDir.endsWith('.app')) return;
  try {
    execSync(`codesign --force --deep --sign - "${appOutDir}"`, { stdio: 'inherit' });
    console.log('afterPack: ad-hoc signed', path.basename(appOutDir));
  } catch (err) {
    console.error('afterPack: ad-hoc codesign failed:', err);
    throw err;
  }
}

function copyBotsToResources(appOutDir: string) {
  const resourcesDir = path.join(appOutDir, 'resources');
  const botsDest = path.join(resourcesDir, 'bots');
  const botsSrc = path.join(appRoot, 'bots');
  if (!fs.existsSync(botsSrc)) return;
  if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
  if (fs.existsSync(botsDest)) {
    try {
      fs.rmSync(botsDest, { recursive: true });
    } catch {
    }
  }
  try {
    fs.cpSync(botsSrc, botsDest, { recursive: true });
  } catch (err) {
    console.warn('afterPack: copy bots folder failed:', err);
  }
}

function ensureBotsNotInMacBundle(appOutDir: string) {
  const resourcesDir = path.join(appOutDir, 'Contents', 'Resources');
  const botsDir = path.join(resourcesDir, 'bots');
  if (fs.existsSync(botsDir)) {
    try {
      fs.rmSync(botsDir, { recursive: true });
    } catch (err) {
      console.warn('afterPack: remove bots from Mac bundle failed:', err);
    }
  }
}

function applyWindowsInstallerAssets(appOutDir: string) {
  const sourceIcon = path.join(appRoot, 'public', 'icon.ico');
  const exePath = path.join(appOutDir, 'IPTRADE.exe');

  if (!fs.existsSync(sourceIcon)) {
    const pngIcon = path.join(appRoot, 'public', 'icon.png');
    if (fs.existsSync(pngIcon)) {
      const rceditPath = path.join(appRoot, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
      if (fs.existsSync(rceditPath) && fs.existsSync(exePath)) {
        try {
          execSync(`"${rceditPath}" "${exePath}" --set-icon "${pngIcon}"`, { stdio: 'inherit' });
        } catch (err) {
          console.error('Failed to set icon:', err);
        }
      }
    }
    return;
  }

  if (fs.existsSync(exePath)) {
    const rceditPath = path.join(appRoot, 'node_modules', 'rcedit', 'bin', 'rcedit.exe');
    if (fs.existsSync(rceditPath)) {
      try {
        execSync(`"${rceditPath}" "${exePath}" --set-icon "${sourceIcon}"`, { stdio: 'inherit' });
      } catch (err) {
        console.error('Failed to set icon:', err);
      }
    }
  }

  const targetLocations = [
    path.join(appOutDir, 'icon.ico'),
    path.join(appOutDir, 'resources', 'icon.ico'),
  ];
  for (const targetIcon of targetLocations) {
    const targetDir = path.dirname(targetIcon);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(sourceIcon, targetIcon);
  }
}

export default async function afterPack(context: AfterPackContext) {
  const { electronPlatformName, appOutDir } = context;

  copyRustBinary(electronPlatformName, appOutDir);

  if (electronPlatformName === 'win32') {
    copyBotsToResources(appOutDir);
    try {
      applyWindowsInstallerAssets(appOutDir);
    } catch (err) {
      console.error('Failed to apply Windows installer assets:', err);
    }
  }

  if (electronPlatformName === 'darwin') {
    ensureBotsNotInMacBundle(appOutDir);
    const appBundle = fs
      .readdirSync(appOutDir)
      .map((name) => path.join(appOutDir, name))
      .find((p) => p.endsWith('.app'));
    if (appBundle) adHocSignMacApp(appBundle);
  }
}

module.exports = afterPack as any;
