import { endpoints } from './endpoints';
import { request } from './client';
import type { CtraderOAuthUrlResponse } from './types';

export async function getOAuthUrl(): Promise<CtraderOAuthUrlResponse> {
  const res = await request(endpoints.authCtrader.oauthUrl, {
    method: 'GET',
  });
  return (await res.json()) as CtraderOAuthUrlResponse;
}

export async function completeOAuth(code: string): Promise<void> {
  const res = await request(endpoints.authCtrader.complete, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  const data = (await res.json()) as { success?: boolean; error?: string; message?: string };
  if (!res.ok) {
    const msg = data?.error ?? data?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

export interface CtraderAppCredentialsStatus {
  configured: boolean;
  client_id?: string | null;
}

export async function getCtraderAppCredentials(): Promise<CtraderAppCredentialsStatus> {
  const res = await request(endpoints.authCtrader.appCredentials, { method: 'GET' });
  const data = (await res.json()) as { data?: CtraderAppCredentialsStatus };
  return data.data ?? { configured: false };
}

export async function setCtraderAppCredentials(clientId: string, clientSecret: string): Promise<void> {
  const res = await request(endpoints.authCtrader.appCredentials, {
    method: 'PUT',
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const data = (await res.json()) as { success?: boolean; errors?: string[]; message?: string };
  if (!res.ok || data.success === false) {
    throw new Error(data.errors?.[0] ?? data.message ?? `HTTP ${res.status}`);
  }
}
