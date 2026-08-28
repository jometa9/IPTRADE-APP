import { BUILD_CONFIG } from 'config/buildConfig';

export const getCurrentAppVersion = (): string => BUILD_CONFIG.APP_VERSION;

// Returns true when `remote` is strictly newer than `current` (x.y.z compare),
// so republished or older releases never trigger the update banner.
export function isNewerVersion(remote: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const r = parse(remote);
  const c = parse(current);
  const len = Math.max(r.length, c.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] ?? 0;
    const b = c[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}
