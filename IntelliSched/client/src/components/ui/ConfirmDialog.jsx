import { useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import useEscapeKey from '../../hooks/useEscapeKey';

// A confirmation that says exactly what will change (audit X6; Phase 3 Step 5): approval sign-offs,
// restoring a version, a GA run that replaces the newest Draft, stopping a run, disabling
// a record. It follows the Curriculum Builder's Detach dialog: role="alertdialog"; the focus starts on
// the safe choice and Tab stays inside; Escape or a click outside is the safe choice (not while busy);
// when it closes, the focus goes back to where it was (or to returnFocusRef when that control is gone
// or disabled). The confirm button names the action ("Publish v3", "Disable ROOM 47").
//   title, children   the question and exactly what happens (children may hold a list)
//   keepLabel         the safe choice ("Cancel", "Don't generate", "Keep running")
//   confirmLabel      the action; busyLabel replaces it while busy ("Restoring…")
//   error             shown inside the dialog (role="alert") when the action failed; the dialog stays
//                     open so the user can try again or cancel
// Test ids: `${testId}`, `${testId}-title`, `${testId}-error`, and the two buttons: keepTestId (the
// safe choice; default `${testId}-keep`) and confirmTestId (default `${testId}-confirm`).
const TONES = {
  red: { badge: 'bg-red-500/10 text-red-600 dark:text-red-400', button: 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500' },
  indigo: { badge: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400', button: 'bg-indigo-600 hover:bg-indigo-700 focus-visible:ring-indigo-500' },
  violet: { badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', button: 'bg-violet-600 hover:bg-violet-700 focus-visible:ring-violet-500' }
};

// A control that can take the focus back: still on the page and not disabled.
const canTakeFocus = (el) => Boolean(el) && el.isConnected && !el.disabled && typeof el.focus === 'function';

export default function ConfirmDialog({
  testId, title, children, keepLabel = 'Cancel', confirmLabel, onKeep, onConfirm, busy = false, busyLabel = '',
  tone = 'red', keepTestId = '', confirmTestId = '', error = '', icon: Icon = AlertTriangle, returnFocusRef = null
}) {
  const t = TONES[tone] || TONES.red;
  const dialogRef = useRef(null);
  const keepRef = useRef(null);
  // Read when the dialog closes: the fallback may be rendered after the dialog opened.
  const fallbackRef = useRef(returnFocusRef);
  useEffect(() => { fallbackRef.current = returnFocusRef; }, [returnFocusRef]);

  // Focus the safe choice; give the focus back to where it was when the dialog closes.
  useEffect(() => {
    const previous = document.activeElement;
    keepRef.current?.focus();
    return () => {
      const fallback = fallbackRef.current?.current || null;
      const target = [previous, fallback].find(canTakeFocus);
      target?.focus();
    };
  }, []);
  // A click on the action disables it while busy, which drops the focus; when the action fails and the
  // dialog stays open, the focus comes back to the safe choice.
  useEffect(() => {
    if (!busy && dialogRef.current && !dialogRef.current.contains(document.activeElement)) keepRef.current?.focus();
  }, [busy]);

  useEscapeKey(true, onKeep, busy);

  // Tab and Shift+Tab stay inside the dialog.
  const keepFocusInside = (e) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onKeep(); }}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        aria-describedby={`${testId}-desc`}
        aria-busy={busy || undefined}
        data-testid={testId}
        onKeyDown={keepFocusInside}
        className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-md shadow-2xl border border-slate-200 dark:border-slate-800 p-6"
      >
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-4 ${t.badge}`}><Icon size={24} aria-hidden="true" /></div>
        <h3 id={`${testId}-title`} data-testid={`${testId}-title`} className="text-lg font-black text-slate-900 dark:text-white mb-1">{title}</h3>
        <div id={`${testId}-desc`} className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-6">{children}</div>
        {error && (
          <p role="alert" data-testid={`${testId}-error`} className="-mt-3 mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
            <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3 justify-end">
          <button
            ref={keepRef}
            type="button"
            data-testid={keepTestId || `${testId}-keep`}
            onClick={onKeep}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            data-testid={confirmTestId || `${testId}-confirm`}
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-2 rounded-xl text-xs font-bold text-white cursor-pointer disabled:opacity-60 flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${t.button}`}
          >
            {busy && <Loader2 size={12} className="mr-1.5 animate-spin" aria-hidden="true" />}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
