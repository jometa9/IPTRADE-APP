#!/usr/bin/env node

import { execSync } from 'child_process';
import { platform } from 'os';

const port = parseInt(process.argv[2], 10);
if (!Number.isInteger(port) || port < 1) {
  console.error('Usage: node kill-port.mjs <port>');
  process.exit(1);
}

const isWin = platform() === 'win32';

async function killPort() {
  try {
    if (isWin) {
      const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
      const portStr = `:${port}`;
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(portStr) || !line.toUpperCase().includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const last = parts[parts.length - 1];
        const pid = parseInt(last, 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore', windowsHide: true });
          console.log(`[kill-port] Freed port ${port} (killed PID ${pid})`);
        } catch {}
      }
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
    }
    await new Promise(r => setTimeout(r, isWin ? 500 : 200));
  } catch {}
}

await killPort();
