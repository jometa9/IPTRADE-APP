import { endpoints } from './endpoints';
import { request } from './client';

export async function setSystemEngine(status: 'on' | 'off'): Promise<void> {
  const res = await request(endpoints.system.engine(status), {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function getLogs(): Promise<string | null> {
  const res = await request(endpoints.logs);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function clearLogs(): Promise<void> {
  const res = await request(endpoints.logsClear, {
    method: 'DELETE',
  });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface BuildInfo {
  status?: string;
  build?: string;
  api_build_ver?: string;
  shell_version?: string | null;
  version_mismatch?: boolean | null;
}

export async function getBuildInfo(): Promise<BuildInfo | null> {
  try {
    const res = await request(endpoints.buildInfo);
    if (!res.ok) return null;
    return (await res.json()) as BuildInfo;
  } catch {
    return null;
  }
}
