import { useEffect, useRef } from 'react';
import { AlertOctagon, CheckCircle2, Loader2, Star, X } from 'lucide-react';
import { codeLine } from '../../utils/scheduleDisplay';
import { EMPLOYMENT_LABELS } from '../../utils/policyLabels';
import { likelihoodText } from '../../utils/likelihood';

// "Change professor" on the Schedule Views page (Phase 4 Part 2; Drafts only, faculty.assign). The
// parent asks the gateway for every active professor's live verdict on this class's (section, subject)
// pair (POST /schedule/change-professor/check) and, when the ranking service has them, the recommended
// professors with their rank (POST /schedule/recommendations); this panel lists them, recommended first,
// each with the verdict next to the name, and offers Save only for a professor whose verdict is OK. The
// change covers every meeting of the subject for the section (lecture and lab together), so the summary
// names them all ("ITEL 305 for BSIT 3A WMAD: the lecture on Wednesday and the lab on Tuesday").
//
// state: { status: 'loading' | 'ready' | 'error', message, retry, changeText, current, verdicts: [{
//   facultyRef, facultyId, name, employmentType, position, ok, same, text, reasons, rank?, score?, rankReason? }],
//   (Phase 6: a recommended professor also shows the Likelihood and the ranking's reason in the Dean's words)
//   rankingNote, tbaAllowed, newestDraft, notNewestMessage }
// form: { chosen: facultyRef | null | undefined, reason }
const labelClass = 'block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider';

export default function ChangeProfessorPanel({
  cls, nowText, state, form, onChange, onRecheck, saveBlockedReason, saveError, isSaving, onSave, onClose, onBack
}) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, [cls.itemId]);
  const busy = isSaving;
  const loading = state.status === 'loading';
  const verdicts = state.verdicts || [];
  const chosen = verdicts.find(v => (v.facultyRef ?? null) === (form.chosen ?? null) && form.chosen !== undefined) || null;

  return (
    <section
      data-testid="professor-panel"
      data-item-id={cls.itemId}
      aria-labelledby="professor-panel-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="bg-white dark:bg-[#18181b] border-2 border-violet-300 dark:border-violet-500/40 rounded-2xl shadow-md overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-start gap-3">
        <div className="min-w-0">
          <h3 id="professor-panel-title" ref={headingRef} tabIndex={-1} className="inline-block text-base font-black text-slate-900 dark:text-white tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded">
            Change professor
          </h3>
          <p data-testid="professor-summary" className="text-xs font-bold text-slate-700 dark:text-slate-200 mt-0.5">
            {codeLine(cls)} · {cls.subjectTitle} · {cls.sectionLabel}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">Now: {cls.facultyName || 'TBA'} · {nowText}</p>
          {state.changeText && (
            <p data-testid="professor-change-text" className="text-xs text-slate-600 dark:text-slate-300 mt-1">
              Changes <span className="font-bold">{state.changeText}</span>. Times and rooms stay the same.
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onBack && (
            <button type="button" data-testid="professor-back" onClick={onBack} disabled={busy} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
              Back to Move
            </button>
          )}
          <button
            type="button"
            data-testid="professor-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close the professor panel without saving"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 p-1 rounded-lg cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {state.notNewestMessage && (
          <p role="alert" data-testid="professor-not-newest" className="p-3 rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-xs font-bold text-amber-900 dark:text-amber-300">
            {state.notNewestMessage}
          </p>
        )}
        {loading && (
          <p data-testid="professor-loading" className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2" aria-live="polite">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Checking every professor against this class's times, their unavailable times, the lunch rule and the teaching cap…
          </p>
        )}
        {state.status === 'error' && (
          <div role="alert" data-testid="professor-error" className="p-3.5 rounded-xl border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-xs font-bold text-red-800 dark:text-red-300">
            {state.message}
            {onRecheck && (
              <button type="button" data-testid="professor-recheck" onClick={onRecheck} className="ml-2 px-3 py-1 rounded-lg bg-white dark:bg-transparent border border-current cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                Check again
              </button>
            )}
          </div>
        )}
        {state.status === 'ready' && (
          <fieldset disabled={busy}>
            <legend className={labelClass}>Professor <span className="text-red-700 dark:text-red-400" aria-hidden="true">*</span></legend>
            {state.rankingNote && <p data-testid="professor-ranking-note" className="text-[11px] text-slate-600 dark:text-slate-300 mb-2">{state.rankingNote}</p>}
            <ul data-testid="professor-options" className="space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar pr-1">
              {verdicts.map(v => {
                const key = v.facultyRef ?? 'tba';
                const picked = form.chosen !== undefined && (form.chosen ?? null) === (v.facultyRef ?? null);
                const selectable = v.ok;
                return (
                  <li key={key}>
                    <label
                      data-testid={`professor-option-${key}`}
                      data-ok={v.ok ? 'true' : 'false'}
                      className={`flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer ${picked ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10 dark:border-violet-500/50' : 'border-slate-200 dark:border-slate-700'} ${selectable ? '' : 'opacity-80'}`}
                    >
                      <input
                        type="radio"
                        name="professor-choice"
                        data-testid={`professor-choice-${key}`}
                        checked={picked}
                        disabled={!selectable}
                        aria-describedby={`professor-verdict-${key}`}
                        onChange={() => onChange({ chosen: v.facultyRef ?? null })}
                        className="mt-1 accent-violet-600"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-bold text-slate-900 dark:text-white">
                          {v.name}
                          {v.rank ? (
                            <span data-testid={`professor-rank-${key}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                              <Star size={10} aria-hidden="true" /> Recommended #{v.rank}
                            </span>
                          ) : null}
                          {v.same ? <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">current</span> : null}
                          {v.facultyRef && (v.position || v.employmentType) ? (
                            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{[v.position, EMPLOYMENT_LABELS[v.employmentType]].filter(Boolean).join(' · ')}</span>
                          ) : null}
                        </span>
                        {v.rank ? (
                          <span data-testid={`professor-likelihood-${key}`} className="block text-[11px] font-medium text-slate-600 dark:text-slate-300">
                            <span className="font-bold">{likelihoodText(v.score, v.facultyId)}</span>{v.rankReason ? ` · ${v.rankReason}` : ''}
                          </span>
                        ) : null}
                        <span id={`professor-verdict-${key}`} data-testid={`professor-verdict-${key}`} className={`flex items-start gap-1 text-[11px] font-bold ${v.ok ? 'text-green-700 dark:text-green-300' : v.same ? 'text-slate-500 dark:text-slate-400' : 'text-red-700 dark:text-red-300'}`}>
                          {v.ok ? <CheckCircle2 size={12} className="mt-px shrink-0" aria-hidden="true" /> : v.same ? null : <AlertOctagon size={12} className="mt-px shrink-0" aria-hidden="true" />}
                          {v.text}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3">
              <label htmlFor="professor-reason" className={labelClass}>Reason (optional)</label>
              <input
                id="professor-reason"
                data-testid="professor-reason"
                type="text"
                value={form.reason}
                onChange={(e) => onChange({ reason: e.target.value })}
                placeholder="e.g. the professor took a leave"
                className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
              />
            </div>
          </fieldset>
        )}
      </div>

      <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex flex-col sm:flex-row sm:items-center justify-end gap-3">
        {saveError && <p role="alert" data-testid="professor-save-error" className="text-xs font-bold text-red-700 dark:text-red-400 sm:mr-auto">{saveError}</p>}
        {saveBlockedReason && !busy && (
          <p id="professor-save-reason" data-testid="professor-save-reason" className="text-[11px] text-slate-600 dark:text-slate-300 sm:mr-auto">{saveBlockedReason}</p>
        )}
        <button type="button" data-testid="professor-cancel" onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
          Cancel
        </button>
        <button
          type="button"
          data-testid="professor-submit"
          onClick={onSave}
          disabled={Boolean(saveBlockedReason) || busy || !chosen}
          aria-describedby={saveBlockedReason ? 'professor-save-reason' : undefined}
          title={saveBlockedReason || undefined}
          className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors shadow-md shadow-violet-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
        >
          {busy ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : null}
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}
