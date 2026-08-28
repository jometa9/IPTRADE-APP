import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'iptrade.accounts.favorites.v1';
const CHANGE_EVENT = 'iptrade:favorite-accounts-changed';

function readFavorites(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
  }
}

export function useFavoriteAccounts() {
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites());

  useEffect(() => {
    const onChange = () => setFavorites(readFavorites());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setFavorites(readFavorites());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const isFavorite = useCallback(
    (accountId: string) => favorites.includes(accountId),
    [favorites]
  );

  const toggleFavorite = useCallback((accountId: string) => {
    const current = readFavorites();
    const next = current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId];
    writeFavorites(next);
    setFavorites(next);
  }, []);

  return { favorites, isFavorite, toggleFavorite };
}

export function sortAccountsByFavorite<T>(
  accounts: T[],
  getId: (a: T) => string,
  favorites: string[]
): T[] {
  if (favorites.length === 0) return accounts;
  const favSet = new Set(favorites);
  const favored: T[] = [];
  const rest: T[] = [];
  for (const a of accounts) {
    if (favSet.has(getId(a))) favored.push(a);
    else rest.push(a);
  }
  return [...favored, ...rest];
}
