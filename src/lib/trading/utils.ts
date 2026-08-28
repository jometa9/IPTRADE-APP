export const platformLabel: Record<string, string> = {
  metatrader4: 'MetaTrader 4',
  metatrader5: 'MetaTrader 5',
  ctrader: 'cTrader',
};

export function getPlatformDisplayName(platform: string | null | undefined): string {
  if (platform == null || platform === '') return platform ?? '';
  const key = platform.toLowerCase().trim();
  return platformLabel[key] ?? platform;
}
