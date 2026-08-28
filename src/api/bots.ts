import { endpoints } from './endpoints';
import { request } from './client';

export interface BotsInstallResponse {
  success?: boolean;
  copied?: number;
  targets?: string[];
  warnings?: string[];
  error?: string;
}

export async function installBots(): Promise<BotsInstallResponse> {
  const res = await request(endpoints.metatrader.install, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return (await res.json()) as BotsInstallResponse;
}
