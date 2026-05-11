import { useEffect, useState } from 'react';

// Shared opt-out flag for Beat Battle. Set when the user presses any
// "Quit Battle" CTA so the rest of the UI knows to neutralize battle
// chrome (countdown timer, Quit buttons, sidebar grouping) without
// touching the server-side battle state — others in the lobby keep
// producing, but for *us* it's over.
//
// localStorage isn't reactive on its own. We pair it with a custom
// 'ghost-battle-opt-out-changed' event that every writer fires, so
// every consuming component re-renders the moment the flag flips.

const KEY = 'beat-battle-opted-out';
const EVENT = 'ghost-battle-opt-out-changed';

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setBattleOptOut(value: boolean): void {
  try {
    if (value) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* quota — flag is best-effort */ }
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch { /* SSR */ }
}

export function useBeatBattleOptOut(): boolean {
  const [optedOut, setOptedOut] = useState<boolean>(read);
  useEffect(() => {
    const refresh = () => setOptedOut(read());
    window.addEventListener(EVENT, refresh);
    // Cross-tab support: localStorage 'storage' event fires in other
    // tabs/windows when the flag is updated.
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return optedOut;
}
