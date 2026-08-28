import React, { createContext, useEffect, useState } from 'react';
import { BUILD_CONFIG } from 'config/buildConfig';

export interface UpdateInfo {
  appVersion: string;
  windowsDownloadUrl?: string | null;
  macDownloadUrl?: string | null;
}

interface AuthContextType {
  updateInfo: UpdateInfo | null;
}

const AUTH_CONTEXT_GLOBAL_KEY = '__IPTRADE_AUTH_CONTEXT__';

type GlobalWithAuthContext = typeof globalThis & {
  [AUTH_CONTEXT_GLOBAL_KEY]?: React.Context<AuthContextType | undefined>;
};

const globalWithAuthContext = globalThis as GlobalWithAuthContext;

export const AuthContext =
  globalWithAuthContext[AUTH_CONTEXT_GLOBAL_KEY] ??
  createContext<AuthContextType | undefined>(undefined);

if (!globalWithAuthContext[AUTH_CONTEXT_GLOBAL_KEY]) {
  AuthContext.displayName = 'AuthContext';
  globalWithAuthContext[AUTH_CONTEXT_GLOBAL_KEY] = AuthContext;
}

const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubReleasePayload {
  tag_name?: string;
  assets?: GitHubReleaseAsset[];
}

// Latest release of the public repo is the single source of truth for updates.
const RELEASES_LATEST_URL = `https://api.github.com/repos/${BUILD_CONFIG.GITHUB_REPO}/releases/latest`;

function findAssetUrl(assets: GitHubReleaseAsset[], match: (name: string) => boolean): string | null {
  const asset = assets.find((a) => a.name && a.browser_download_url && match(a.name.toLowerCase()));
  return asset?.browser_download_url ?? null;
}

async function fetchRemoteVersion(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(RELEASES_LATEST_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GitHubReleasePayload;
    const version = data.tag_name?.trim().replace(/^v/i, '');
    if (!version) return null;
    const assets = data.assets ?? [];
    return {
      appVersion: version,
      windowsDownloadUrl: findAssetUrl(assets, (n) => n.endsWith('.exe')),
      macDownloadUrl: findAssetUrl(assets, (n) => n.endsWith('.dmg') || n.endsWith('.pkg')),
    };
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const info = await fetchRemoteVersion();
      if (!cancelled && info) setUpdateInfo(info);
    };
    check();
    const id = setInterval(check, VERSION_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const value: AuthContextType = {
    updateInfo,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
