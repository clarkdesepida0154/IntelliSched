import { useEffect, useRef } from 'react';
import { AlertOctagon, CheckCircle2, Clock, Loader2, Lock, X } from 'lucide-react';
import { codeLine, isTbaRoomKey, timeRangeLabel } from '../../utils/scheduleDisplay';
import Select from '../ui/Select';

// "Move this class" on the Schedule Views page (Drafts only). The parent builds the choices from the
// version's policy and rooms (days, start times that keep the class's length, rooms including the TBA
// rooms under their TBA names) and has the gateway's validator check every choice as it is made;
// this panel shows the form, the check and why Save is closed. A fixed class (the NSTP block) only
// says why it can't be moved. A lecture held online (roomKind ONLINE, Phase 3 Step 7) takes no room:
// its only room choice is "Online (no room)".
//
// check: { tone: 'idle' | 'checking' | 'ok' | 'error' | 'invalid', message, violations: [text] }
const selectClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-60';
const labelClass = 'block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider';
const Required = () => <span className="text-red-700 dark:text-red-400" aria-hidden="true"> *</span>;

const CHECK_LOOK = {
  idle: { icon: Clock, box: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]', text: 'text-slate-700 dark:text-slate-300' },
  checking: { icon: Loader2, box: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]', text: 'text-slate-700 dark:text-slate-300' },
  ok: { icon: CheckCircle2, box: 'border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10', text: 'text-green-800 dark:text-green-300' },
  error: { icon: AlertOctagon, box: 'border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10', text: 'text-red-800 dark:text-red-300' },
  invalid: { icon: AlertOctagon, box: 'border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10', text: 'text-amber-900 dark:text-amber-300' }
};

export default function MoveClassPanel({
  cls, nowText, form, onChange, dayOptions, startOptions, endOf, roomGroups, check, onRecheck,
  saveBlockedReason, saveError, isSaving, onSave, onClose, actions = []
}) {
  const headingRef = useRef(null);
  // Keyboard users land in the panel when a class is chosen.
  useEffect(() => { headingRef.current?.focus(); }, [cls.itemId]);

  const look = CHECK_LOOK[check.tone] || CHECK_LOOK.idle;
  const CheckIcon = look.icon;
  const startFits = startOptions.includes(form.start);
  const busy = isSaving;
  const isOnline = cls.roomKind === 'ONLINE';

  return (
    <section
      data-testid="move-panel"
      data-item-id={cls.itemId}
      aria-labelledby="move-panel-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="bg-white dark:bg-[#18181b] border-2 border-violet-300 dark:border-violet-500/40 rounded-2xl shadow-md overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-start gap-3">
        <div className="min-w-0">
          <h3 id="move-panel-title" ref={headingRef} tabIndex={-1} className="inline-block text-base font-black text-slate-900 dark:text-white tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded">
            Move this class
          </h3>
          <p data-testid="move-summary" className="text-xs font-bold text-slate-700 dark:text-slate-200 mt-0.5">
            {codeLine(cls)} · {cls.subjectTitle} · {cls.sectionLabel}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">Now: {nowText}</p>
          {/* The class's other edits (Phase 4 Part 2): "Change professor" and "Swap with another class".
              A closed action says why: the role, the version or the class. */}
          {actions.length > 0 && (
            <div data-testid="move-actions" className="mt-2 flex flex-wrap items-center gap-2">
              {actions.map(action => (
                <span key={action.key} className="inline-flex flex-col">
                  <button
                    type="button"
                    data-testid={action.testId}
                    onClick={action.onClick}
                    disabled={busy || Boolean(action.blockedReason)}
                    aria-describedby={action.blockedReason ? `${action.testId}-reason` : undefined}
                    title={action.blockedReason || undefined}
                    className="inline-flex items-center px-3 py-1.5 rounded-lg text-[11px] font-bold text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/30 hover:bg-violet-100 dark:hover:bg-violet-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  >
                    {action.label}
                  </button>
                  {action.blockedReason && (
                    <span id={`${action.testId}-reason`} data-testid={`${action.testId}-reason`} className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-56">{action.blockedReason}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="move-close"
          onClick={onClose}
          disabled={busy}
          aria-label="Close the move panel without saving"
          className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 p-1 rounded-lg cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {cls.isFixed ? (
        <p data-testid="move-fixed-note" className="p-5 text-xs font-bold text-slate-700 dark:text-slate-200 flex items-start">
          <Lock size={14} className="mr-2 mt-px shrink-0" aria-hidden="true" />
          This class can't be moved: it is the fixed NSTP block, whose day and time come from the Scheduling Policy.
        </p>
      ) : (
        <>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div>
                <label htmlFor="move-day" className={labelClass}>Day<Required /></label>
                <Select id="move-day" data-testid="move-day" aria-required="true" value={form.day} onChange={(e) => onChange({ day: e.target.value })} disabled={busy} className={selectClass}>
                  {dayOptions.map(day => <option key={day} value={day}>{day}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor="move-start" className={labelClass}>Start (same length)<Required /></label>
                <Select id="move-start" data-testid="move-start" aria-required="true" value={form.start} onChange={(e) => onChange({ start: e.target.value })} disabled={busy} className={selectClass}>
                  {!startFits && (
                    <option value={form.start} disabled>{form.start ? `${timeRangeLabel(form.start, endOf(form.start))} (does not fit this day)` : 'Choose a start time'}</option>
                  )}
                  {startOptions.map(time => <option key={time} value={time}>{timeRangeLabel(time, endOf(time))}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor="move-room" className={labelClass}>Room<Required /></label>
                <Select
                  id="move-room"
                  data-testid="move-room"
                  aria-required="true"
                  aria-describedby={isOnline ? 'move-room-online-note' : undefined}
                  value={form.roomKey}
                  onChange={(e) => onChange({ roomKey: e.target.value })}
                  disabled={busy}
                  className={selectClass}
                >
                  <option value="">{isOnline ? 'Online (no room)' : 'TBA – no CCS room needed'}</option>
                  {!isOnline && roomGroups.map(group => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </optgroup>
                  ))}
                </Select>
                {isOnline && (
                  <p id="move-room-online-note" data-testid="move-room-online-note" className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                    This lecture is held online, so it takes no room (its Lecture mode is set in the Master Catalog).
                  </p>
                )}
                {isTbaRoomKey(form.roomKey) && (
                  <p data-testid="move-room-tba-note" className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                    A TBA room to request: students and faculty see &ldquo;TBA&rdquo; until a room is borrowed from another department.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="move-reason" className={labelClass}>Reason (optional)</label>
                <input
                  id="move-reason"
                  data-testid="move-reason"
                  type="text"
                  value={form.reason}
                  onChange={(e) => onChange({ reason: e.target.value })}
                  disabled={busy}
                  placeholder="e.g. the professor asked for a morning class"
                  className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
                />
              </div>
            </div>

            <div data-testid="move-check" data-tone={check.tone} aria-live="polite" className={`p-3.5 rounded-xl border flex items-start gap-2.5 ${look.box}`}>
              <CheckIcon size={17} className={`shrink-0 mt-px ${look.text} ${check.tone === 'checking' ? 'animate-spin' : ''}`} aria-hidden="true" />
              <div className={`text-xs font-bold ${look.text}`}>
                <p data-testid="move-check-message">{check.message}</p>
                {/* Phase 8 Part 6 (decision 5): an allowed move that leaves a part-timer with only
                    one class on a weekday is saved all the same, but the Dean is told which day. */}
                {check.warning && (
                  <p data-testid="move-part-timer-warning" className="mt-1 font-medium text-amber-900 dark:text-amber-300">{check.warning}</p>
                )}
                {check.violations?.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 font-medium space-y-0.5">
                    {check.violations.map((text, i) => <li key={i} data-testid="move-check-violation">{text}</li>)}
                  </ul>
                )}
                {check.retry && onRecheck && (
                  <button
                    type="button"
                    data-testid="move-recheck"
                    onClick={onRecheck}
                    className="mt-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-transparent border border-current cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  >
                    Check again
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex flex-col sm:flex-row sm:items-center justify-end gap-3">
            {saveError && (
              <p role="alert" data-testid="move-save-error" className="text-xs font-bold text-red-700 dark:text-red-400 sm:mr-auto">{saveError}</p>
            )}
            {saveBlockedReason && !busy && (
              <p id="move-save-reason" data-testid="move-save-reason" className="text-[11px] text-slate-600 dark:text-slate-300 sm:mr-auto">{saveBlockedReason}</p>
            )}
            <button
              type="button"
              data-testid="move-cancel"
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="move-submit"
              onClick={onSave}
              disabled={Boolean(saveBlockedReason) || busy}
              aria-describedby={saveBlockedReason ? 'move-save-reason' : undefined}
              title={saveBlockedReason || undefined}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 transition-colors shadow-md shadow-violet-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
            >
              {busy ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : null}
              {busy ? 'Saving…' : 'Save the move'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
