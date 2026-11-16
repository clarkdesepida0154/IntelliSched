import { useState } from 'react';
import { AlertCircle, AlertTriangle, Loader2, Square } from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';
import { budgetMsOf, formatClock, personText, progressLine, timeOf } from '../../utils/gaRun';

// A run the gateway is still working on, in plain words (Phase 3 Step 4): "Placing classes… 12
// conflicts left", then "No conflicts. Improving the schedule…" (the best schedule so far, updated by the
// page about once a second), the time used against the time limit, who started it, and Cancel with a
// confirmation. The generation, the counts and the soft penalty are under "Advanced". onCancel()
// resolves true when the gateway accepted the cancel.
export default function GaRunProgress({ run, origin, otherTerm = '', onCancel, isCancelling, cancelError, pollError, cancelNotAllowedReason = '' }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const p = run.progress || null;
  const budgetMs = budgetMsOf(run);
  const elapsedMs = Math.max(0, Number(p?.elapsedMs) || 0);
  const pct = budgetMs ? Math.min(100, (elapsedMs / budgetMs) * 100) : 0;
  const saving = run.status === 'saving';
  const cancelBlockedReason = saving
    ? 'The run has finished and the schedule is being saved, so it can no longer be cancelled.'
    : run.cancelRequested
      ? 'Cancel requested: the run stops within a few seconds.'
      : isCancelling ? 'Sending the cancel…' : cancelNotAllowedReason;

  const handleConfirm = async () => {
    await onCancel();
    setConfirmOpen(false);
  };

  return (
    <div data-testid="generate-progress" data-run-id={run._id} data-status={run.status} className="space-y-4">
      <div>
        <p role="status" data-testid="generate-progress-line" className="text-base font-black text-slate-900 dark:text-white flex items-center">
          <Loader2 size={18} className="mr-2 shrink-0 animate-spin text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          {progressLine(run)}
        </p>
        {otherTerm && <p data-testid="generate-progress-term" className="text-xs font-bold text-slate-700 dark:text-slate-300 mt-1">This run is for {otherTerm} (one run at a time for the whole college).</p>}
        <p data-testid="ga-run-by" className="text-xs text-slate-600 dark:text-slate-300 mt-1">
          Started by {personText(run.startedBy)}{run.startedAt ? ` at ${timeOf(run.startedAt)}` : ''}
        </p>
        {origin === 'resumed' && (
          <p data-testid="ga-run-resumed" className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">This run was already going when you opened the page.</p>
        )}
      </div>

      <div>
        <div className="flex items-baseline justify-between text-xs font-bold text-slate-700 dark:text-slate-200 mb-1.5">
          <span id="generate-progress-label">Time used</span>
          <span data-testid="generate-elapsed">{formatClock(elapsedMs)}{budgetMs ? ` of ${formatClock(budgetMs)}` : ''}</span>
        </div>
        <div
          role="progressbar"
          data-testid="generate-progress-bar"
          aria-labelledby="generate-progress-label"
          aria-valuemin={0}
          aria-valuemax={budgetMs ? Math.round(budgetMs / 1000) : undefined}
          aria-valuenow={budgetMs ? Math.min(Math.round(elapsedMs / 1000), Math.round(budgetMs / 1000)) : undefined}
          aria-valuetext={`${formatClock(elapsedMs)}${budgetMs ? ` of ${formatClock(budgetMs)}` : ''} (minutes:seconds)`}
          className="w-full h-2.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
        >
          <div className="h-full rounded-full bg-indigo-600 transition-all duration-500 ease-out" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">It often ends before the time limit, as soon as it finds no better schedule. You can leave this page: the run goes on, and this page shows it again when you come back.</p>
      </div>

      {pollError && (
        <p role="alert" data-testid="ga-poll-error" className="flex items-start gap-2 text-xs font-bold text-amber-800 dark:text-amber-300">
          <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {pollError}
        </p>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <button
          type="button"
          data-testid="ga-cancel"
          onClick={() => setConfirmOpen(true)}
          disabled={Boolean(cancelBlockedReason)}
          aria-describedby="ga-cancel-reason"
          className="self-start px-4 py-2 rounded-xl text-xs font-bold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 hover:bg-red-100 dark:hover:bg-red-500/20 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Square size={12} className="mr-1.5 fill-current" aria-hidden="true" /> Cancel the run
        </button>
        <p id="ga-cancel-reason" data-testid="ga-cancel-reason" className="text-[11px] text-slate-600 dark:text-slate-400">{cancelBlockedReason}</p>
      </div>
      {cancelError && (
        <p role="alert" data-testid="ga-cancel-error" className="flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
          <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {cancelError}
        </p>
      )}

      {confirmOpen && (
        <ConfirmDialog
          testId="ga-cancel-dialog"
          keepTestId="ga-cancel-keep"
          confirmTestId="ga-cancel-confirm"
          title="Stop the run? Nothing will be saved."
          keepLabel="Keep running"
          confirmLabel="Stop the run"
          onKeep={() => setConfirmOpen(false)}
          onConfirm={handleConfirm}
          busy={isCancelling}
          tone="red"
        >
          The run stops within a few seconds and no Draft is saved for it. You can generate again afterwards.
        </ConfirmDialog>
      )}
    </div>
  );
}
