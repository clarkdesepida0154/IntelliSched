import React, { useEffect, useId, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

// A small "?" button that opens the explanation a page used to show as a paragraph (Phase 8 Part 10).
// `label` names what the tip is about (for the button's aria-label); `testid` goes on the button, and
// `${testid}-text` on the opened text. Closes on Escape, on a click outside, or on the button again.
export default function HelpTip({ label, testid, children, className = '' }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  return (
    <span ref={boxRef} className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        data-testid={testid}
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-slate-500 hover:text-blue-800 dark:text-slate-400 dark:hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 cursor-pointer"
      >
        <HelpCircle size={16} aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="note"
          data-testid={testid ? `${testid}-text` : undefined}
          className="absolute left-0 top-full mt-1 z-30 w-72 max-w-[80vw] p-3 rounded-xl text-xs font-normal normal-case tracking-normal text-left text-slate-800 dark:text-slate-100 bg-white dark:bg-[#18181b] border border-slate-300 dark:border-slate-700 shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
