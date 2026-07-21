import { useState } from 'react';
import { copyText } from '../lib/copyText';

interface Props {
  // Either the raw text to copy, OR a function that returns it (for
  // cases where the text is computed on click — e.g. concatenating
  // streaming sub-blocks).
  getText: string | (() => string);
  className?: string;
  label?: string;
}

// Tiny "Copy" button with built-in flash-to-Copied feedback. No toasts,
// no global state — the button itself shows the success/fail state for
// 1.4s, then reverts. Matches what sessions-tmux had on MessageBlock /
// CommandBlock / FileCard.
export function CopyButton({ getText, className, label = 'Copy' }: Props): JSX.Element {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');

  const onClick = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const text = typeof getText === 'function' ? getText() : getText;
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'err');
    setTimeout(() => setState('idle'), 1400);
  };

  return (
    <button
      type="button"
      className={`copy-btn ${state} ${className ?? ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {state === 'ok' ? '✓ Copied' : state === 'err' ? '× Failed' : label}
    </button>
  );
}
