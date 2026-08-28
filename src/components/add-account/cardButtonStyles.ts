import { cn } from '@/lib/utils';

const addAccountCardButtonBase =
  'inline-flex items-center justify-center rounded-full bg-black px-3 py-4 text-base text-white transition-all duration-200 hover:bg-gray-600 cursor-pointer';

export const addAccountCardButtonClass = cn('mt-4 w-full', addAccountCardButtonBase);

export function addAccountCardButtonClassWithDisabled(disabled: boolean) {
  return cn(
    addAccountCardButtonClass,
    disabled && 'bg-gray-400 hover:bg-gray-400 cursor-not-allowed'
  );
}
