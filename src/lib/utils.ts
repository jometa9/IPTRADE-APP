import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { BUILD_CONFIG } from 'config/buildConfig';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function getApiBase(): string {
  return `http://localhost:${BUILD_CONFIG.API_PORT}`;
}

function getWebBase(): string {
  return BUILD_CONFIG.BASE_URL;
}

export const urls = {
  get apiBase(): string {
    return getApiBase();
  },
  get webBase(): string {
    return getWebBase();
  },
  get documentation(): string {
    return `${getWebBase()}/documentation`;
  },
  getApiUrl(): string {
    if (typeof window !== 'undefined' && (window.electronAPI || window.location.protocol === 'file:')) {
      return getApiBase();
    }
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return getApiBase();
    }
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
    return `${typeof window !== 'undefined' ? window.location.protocol : 'http:'}//${host}:${BUILD_CONFIG.API_PORT}`;
  },
};
