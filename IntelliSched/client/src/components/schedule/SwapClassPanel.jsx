import { useEffect, useRef } from 'react';
import { AlertOctagon, ArrowLeftRight, CheckCircle2, Clock, Loader2, X } from 'lucide-react';
import { codeLine, timeRangeLabel } from '../../utils/scheduleDisplay';
import Select from '../ui/Select';

// "Swap with another class" on the Schedule Views page (Phase 4 Part 2; Drafts only, schedule.move).
// The second class comes from the same section's or the same professor's classes (the list below) or
// from a click on the table; the gateway checks the swap live (POST /schedule/swap/check: the two
// classes exchange day, start and room; when that breaks a room rule, each keeps its own room) and
// this panel shows both new places and the verdict; Save is open only when the verdict is OK.
//
// candidates: [{ group: 'Same section' | 'Same professor', options: [{ value: itemId, label }] }]
// check: { tone: 'idle' | 'checking' | 'ok' | 'error' | 'invalid', message, reasons: [text],
//          places: { a, b } | null, roomText, retry }
const selectClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60';
const labelClass = 'block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider';
const LOOK = {
  idle: { icon: Clock, box: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]', text: 'text-slate-700 dark:text-slate-300' },
  checking: { icon: Loader2, box: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]', text: 'text-slate-700 dark:text-slate-300' },
  ok: { icon: CheckCircle2, box: 'border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10', text: 'text-green-800 dark:text-green-300' },
  error: { icon: AlertOctagon, box: 'border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10', text: 'text-red-800 dark:text-red-300' },
  invalid: { icon: AlertOctagon, box: 'border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10', text: 'text-amber-900 dark:text-amber-300' }
};

export default function SwapClassPanel({
  cls, nowText, partner, candidates, withId, onChoose, check, onRecheck, saveBlockedReason, saveError, isSaving, onSave, onClose, onBack
}) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, [cls.itemId]);
  const busy = isSaving;
  const look = LOOK[check.tone] || LOOK.idle;
  const CheckIcon = look.icon;
  const inList = candidates.some(g => g.options.some(o => o.value === withId));

  return (
    <section
      data-testid="swap-panel"
      data-item-id={cls.itemId}
      aria-labelledby="swap-panel-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="bg-white dark:bg-[#18181b] border-2 border-violet-300 dark:border-violet-500/40 rounded-2xl shadow-md overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-start gap-3">
        <div className="min-w-0">
          <h3 id="swap-panel-title" ref={headingRef} tabIndex={-1} className="inline-block text-base font-black text-slate-900 dark:text-white tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded">
            Swap with another class
          </h3>
          <p data-testid="swap-summary" className="text-xs font-bold text-slate-700 dark:text-slate-200 mt-0.5">
            {codeLine(cls)} · {cls.subjectTitle} · {cls.sectionLabel}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">Now: {nowText}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onBack && (
            <button type="button" data-testid="swap-back" onClick={onBack} disabled={busy} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
              Back to Move
            </button>
          )}
          <button
            type="button"
            data-testid="swap-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close the swap panel without saving"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 p-1 rounded-lg cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <div>
          <label htmlFor="swap-with" className={labelClass}>Swap with<span className="text-red-700 dark:text-red-400" aria-hidden="true"> *</span></label>
          <Select id="swap-with" data-testid="swap-with" aria-required="true" value={withId || ''} onChange={(e) => onChoose(e.target.value || null)} disabled={busy} className={selectClass}>
            <option value="">Choose a class, or click one in the table</option>
            {withId && !inList && partner && <option value={withId}>{`${codeLine(partner)} · ${partner.sectionLabel} · ${partner.day} ${timeRangeLabel(partner.startTime, partner.endTime)} (from the table)`}</option>}
            {candidates.map(group => (
              <optgroup key={group.group} label={group.group}>
                {group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </optgroup>
            ))}
          </Select>
          <p data-testid="swap-hint" className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
            The two classes exchange their day, start and room. If the rooms don't suit, each keeps its own room. Professors stay the same.
          </p>
        </div>

        <div data-testid="swap-check" data-tone={check.tone} aria-live="polite" className={`p-3.5 rounded-xl border flex items-start gap-2.5 ${look.box}`}>
          <CheckIcon size={17} className={`shrink-0 mt-px ${look.text} ${check.tone === 'checking' ? 'animate-spin' : ''}`} aria-hidden="true" />
          <div className={`text-xs font-bold ${look.text} min-w-0`}>
            <p data-testid="swap-check-message">{check.message}</p>
            {check.places && (
              <ul data-testid="swap-places" className="mt-1.5 space-y-0.5 font-medium">
                {['a', 'b'].map(key => {
                  const p = check.places[key];
                  return p ? (
                    <li key={key} data-testid={`swap-place-${key}`} className="flex items-start gap-1.5">
                      <ArrowLeftRight size={12} className="mt-px shrink-0" aria-hidden="true" />
                      <span>{p.subjectCode} ({p.section}) → {p.day} {timeRangeLabel(p.startTime, p.endTime)}, {p.roomWords}</span>
                    </li>
                  ) : null;
                })}
                {check.roomText && <li data-testid="swap-room-text" className="text-[11px]">{check.roomText}</li>}
              </ul>
            )}
            {check.reasons?.length > 0 && (
              <ul className="mt-1 list-disc pl-4 font-medium space-y-0.5">
                {check.reasons.map((text, i) => <li key={i} data-testid="swap-check-reason">{text}</li>)}
              </ul>
            )}
            {check.retry && onRecheck && (
              <button type="button" data-testid="swap-recheck" onClick={onRecheck} className="mt-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-transparent border border-current cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                Check again
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex flex-col sm:flex-row sm:items-center justify-end gap-3">
        {saveError && <p role="alert" data-testid="swap-save-error" className="text-xs font-bold text-red-700 dark:text-red-400 sm:mr-auto">{saveError}</p>}
        {saveBlockedReason && !busy && (
          <p id="swap-save-reason" data-testid="swap-save-reason" className="text-[11px] text-slate-600 dark:text-slate-300 sm:mr-auto">{saveBlockedReason}</p>
        )}
        <button type="button" data-testid="swap-cancel" onClick={onClose} disabled={busy} className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
          Cancel
        </button>
        <button
          type="button"
          data-testid="swap-submit"
          onClick={onSave}
          disabled={Boolean(saveBlockedReason) || busy}
          aria-describedby={saveBlockedReason ? 'swap-save-reason' : undefined}
          title={saveBlockedReason || undefined}
          className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors shadow-md shadow-violet-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
        >
          {busy ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : null}
          {busy ? 'Saving…' : 'Save the swap'}
        </button>
      </div>
    </section>
  );
}
