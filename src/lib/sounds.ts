function getSoundUrl(filename: string): string {
  if (typeof window === 'undefined') {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '') || '/';
    return `${base}/sounds/${filename}`;
  }
  const origin = window.location?.origin ?? '';
  if (origin === 'file://' || origin === 'null' || !origin) {
    const base = (import.meta.env.BASE_URL ?? './').replace(/\/+$/, '') || '.';
    return `${base}/sounds/${filename}`;
  }
  return `${origin.replace(/\/+$/, '')}/sounds/${filename}`;
}

function play(url: string): void {
  try {
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch {}
}

let soundsEnabled = true;

export function getSoundsEnabled(): boolean {
  return soundsEnabled;
}

export function setSoundsEnabled(enabled: boolean): void {
  soundsEnabled = enabled;
}

export function playAccountOnlineSound(): void {
  play(getSoundUrl('success.mp3'));
}

export function playAccountOfflineSound(): void {
  play(getSoundUrl('error.mp3'));
}
