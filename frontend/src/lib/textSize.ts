// Three-step text size for the Pretty + Reflowed views. Stored in
// localStorage; each step maps to a class on .app-shell. CSS rules
// in globals.css read those classes to set body / heading / code
// sizes. Default is "M" — the user explicitly said today's mobile
// default (16px) was too big even for the largest setting.

export type TextSize = 'S' | 'M' | 'L';

const KEY = 'pretty-pty:text-size';

export function readTextSize(): TextSize {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'S' || v === 'M' || v === 'L') return v;
  } catch { /* ignore */ }
  return 'M';
}

export function writeTextSize(size: TextSize): void {
  try {
    window.localStorage.setItem(KEY, size);
  } catch { /* ignore */ }
}

export function nextSize(s: TextSize): TextSize {
  return s === 'S' ? 'M' : s === 'M' ? 'L' : 'S';
}

export function sizeLabel(s: TextSize): string {
  return s === 'S' ? 'Small' : s === 'M' ? 'Medium' : 'Large';
}
