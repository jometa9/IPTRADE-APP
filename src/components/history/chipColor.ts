const CHIP_PALETTE = [
  'bg-blue-100 text-blue-800 hover:bg-blue-200',
  'bg-green-100 text-green-800 hover:bg-green-200',
  'bg-amber-100 text-amber-800 hover:bg-amber-200',
  'bg-rose-100 text-rose-800 hover:bg-rose-200',
  'bg-purple-100 text-purple-800 hover:bg-purple-200',
  'bg-cyan-100 text-cyan-800 hover:bg-cyan-200',
  'bg-orange-100 text-orange-800 hover:bg-orange-200',
  'bg-teal-100 text-teal-800 hover:bg-teal-200',
  'bg-pink-100 text-pink-800 hover:bg-pink-200',
  'bg-indigo-100 text-indigo-800 hover:bg-indigo-200',
  'bg-lime-100 text-lime-800 hover:bg-lime-200',
  'bg-sky-100 text-sky-800 hover:bg-sky-200',
  'bg-fuchsia-100 text-fuchsia-800 hover:bg-fuchsia-200',
  'bg-emerald-100 text-emerald-800 hover:bg-emerald-200',
  'bg-violet-100 text-violet-800 hover:bg-violet-200',
];

function hashLower(s: string): number {
  const lower = s.toLowerCase();
  let h = 5381;
  for (let i = 0; i < lower.length; i++) {
    h = ((h << 5) + h + lower.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function chipColorFor(text: string): string {
  return CHIP_PALETTE[hashLower(text) % CHIP_PALETTE.length];
}
