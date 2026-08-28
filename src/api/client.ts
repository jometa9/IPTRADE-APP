import { BUILD_CONFIG } from 'config/buildConfig';
import type { ApiKeys } from '../types/electron';

const API_BASE = `http://127.0.0.1:${BUILD_CONFIG.API_PORT}`;

export async function getBaseUrl(): Promise<string> {
  if (typeof window !== 'undefined' && window.electronAPI?.getServerUrl) {
    try {
      const url = await window.electronAPI.getServerUrl();
      if (url) return url;
    } catch {}
  }
  return API_BASE;
}

const DYNAMIC_INSERT_POS = 10;
const DYNAMIC_LEN = 2;

function buildDynamicKey(baseKey: string): string {
  const base = baseKey.trim();
  if (base.length < DYNAMIC_INSERT_POS + 1) return base;
  const month = (new Date().getUTCMonth() + 1) * 2;
  const monthStr = String(month).padStart(DYNAMIC_LEN, '0');
  return base.slice(0, DYNAMIC_INSERT_POS) + monthStr + base.slice(DYNAMIC_INSERT_POS);
}

async function getApiKeysForRequest(): Promise<ApiKeys | null> {
  if (typeof window !== 'undefined' && window.electronAPI?.getApiKeys) {
    try {
      const keys = await window.electronAPI.getApiKeys();
      if (keys?.apiKey && keys?.apiSecret) return keys;
      return { apiKey: BUILD_CONFIG.API_KEY, apiSecret: BUILD_CONFIG.API_SECRET };
    } catch {
      return { apiKey: BUILD_CONFIG.API_KEY, apiSecret: BUILD_CONFIG.API_SECRET };
    }
  }
  const envKey = import.meta.env?.VITE_API_KEY as string | undefined;
  const envSecret = import.meta.env?.VITE_API_SECRET as string | undefined;
  if (envKey && envSecret) return { apiKey: envKey, apiSecret: envSecret };
  return null;
}

export interface RequestOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  skipJsonContentType?: boolean;
  authHeaders?: { 'x-api-key': string; 'x-api-secret': string };
}

export interface WsAuthQuery {
  api_key: string;
  api_secret: string;
}

export async function getWsAuthQuery(): Promise<WsAuthQuery | null> {
  const apiKeys = await getApiKeysForRequest();
  if (!apiKeys) return null;
  return {
    api_key: buildDynamicKey(apiKeys.apiKey),
    api_secret: buildDynamicKey(apiKeys.apiSecret),
  };
}

export async function request(
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  const base = await getBaseUrl();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };
  if (options.authHeaders) {
    headers['x-api-key'] = options.authHeaders['x-api-key'];
    headers['x-api-secret'] = options.authHeaders['x-api-secret'];
  } else {
    const apiKeys = await getApiKeysForRequest();
    if (apiKeys) {
      headers['x-api-key'] = buildDynamicKey(apiKeys.apiKey);
      headers['x-api-secret'] = buildDynamicKey(apiKeys.apiSecret);
    }
  }
  if (
    options.body !== undefined &&
    typeof options.body === 'string' &&
    !headers['Content-Type'] &&
    !options.skipJsonContentType
  ) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { ...options, headers });
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function deleteRequest(path: string): Promise<Response> {
  return request(path, { method: 'DELETE' });
}
