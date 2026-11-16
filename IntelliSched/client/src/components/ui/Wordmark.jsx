import React from 'react';

// The one place the name is drawn. Phase 8 Part 11: the old header (Part 10's baseline) with one
// change only: "INTELLI" has the same weight as "SCHED". No icon, the old colours and sizes.
// size: 'compact' (sidebar: INTELLI slate, SCHED blue) | 'large' (sign-in, on the dark brand
// panel: the whole name in white).
export default function Wordmark({ size = 'compact', className = '' }) {
  if (size === 'large') {
    return (
      <span
        data-testid="wordmark"
        aria-label="IntelliSched"
        className={`text-3xl font-black text-white tracking-widest whitespace-nowrap ${className}`}
      >
        <span aria-hidden="true">INTELLISCHED</span>
      </span>
    );
  }
  return (
    <span
      data-testid="wordmark"
      aria-label="IntelliSched"
      className={`text-lg tracking-widest leading-tight whitespace-nowrap ${className}`}
    >
      <span aria-hidden="true">
        <span className="font-black text-slate-500 dark:text-slate-400">INTELLI</span>
        <span className="font-black text-blue-800 dark:text-blue-500">SCHED</span>
      </span>
    </span>
  );
}
