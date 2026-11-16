import { useState } from 'react';
import { AlertCircle, CheckCircle2, ClipboardCheck, DoorOpen, Info, Loader2, Save } from 'lucide-react';
import api from '../../services/api';
import { setPolicyCache } from '../../hooks/usePolicy';
import { reasonFor } from '../../utils/permissions';
import { TBA_ROOM_MODES, TBA_ROOM_MODE_LABELS, tbaRoomCountsText, tbaRoomModeLabel } from '../../utils/gaRun';
import Select from '../ui/Select';

// TBA rooms (Phase 2's "extra rooms"; Phase 3 Step 4), in the Generate Schedule page's "Advanced (system
// team)": rooms the Dean requests from outside CCS when the CCS rooms are full; their classes show TBA.
// How a run gets them is policy.overflowRooms.mode, which the gateway resolves before each run (and in
// the Readiness Check that the panel reads, report.extraRooms):
//   Automatic      the fewest that fit (the weekday suggestion) plus one room of each type it needs;
//   Manual counts  the counts saved here;
//   Off            none (generating is blocked when the CCS rooms are short).
// The panel says what the next run gets, shows the suggested counts ("Use these numbers" fills Manual
// counts, saving nothing), and saves PUT /policy { overflowRooms: { mode, enabled, lab, lec } } (canEdit:
// the permission map's advanced.edit, Phase 3 Step 6; the gateway refuses the Advanced settings from
// anyone else). After a save, onSaved() runs the Readiness Check again.
// Test ids (prefix `ga-tba`): -rooms, -current, -use-weekdays / -use-saturday (each with -option),
// -note, -filled, -form, -mode, -lab, -lec (each with -help and -error), -submit, -save-reason, -error,
// -saved.

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
const MODE_HELP = {
  auto: 'Before each run the counts are set to the fewest TBA rooms that fit, plus one room of each type needed (the fewest is an arithmetic minimum).',
  manual: 'Each run gets exactly the counts below.',
  off: 'No TBA rooms: when the CCS rooms can\'t hold every class that needs a room, generating is blocked.'
};
const inputClass = 'w-28 bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60 aria-[invalid=true]:border-red-500';

const FieldError = ({ id, message }) => (message ? (
  <p id={id} data-testid={id} role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
    <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {message}
  </p>
) : null);

// The saved setting: { mode, lab, lec } plus the Phase 8 Part 5 headroom rule (a policy saved before
// the mode existed reads as Automatic; one saved before Part 5 reads headroom on at 85%).
const savedOf = (policy) => ({
  mode: TBA_ROOM_MODES.includes(policy?.overflowRooms?.mode) ? policy.overflowRooms.mode : 'auto',
  lab: Number.isInteger(policy?.overflowRooms?.lab) ? policy.overflowRooms.lab : 0,
  lec: Number.isInteger(policy?.overflowRooms?.lec) ? policy.overflowRooms.lec : 0,
  headroomEnabled: policy?.overflowRooms?.headroom?.enabled !== false,
  headroomPercent: Number.isInteger(policy?.overflowRooms?.headroom?.percent) ? policy.overflowRooms.headroom.percent : 85
});
const countProblem = (n, type) => (Number.isInteger(n) && n >= 0 ? '' : `Enter a whole number of TBA ${type} rooms, 0 or more.`);
const percentProblem = (n) => (Number.isInteger(n) && n >= 50 && n <= 100 ? '' : 'Enter the fullness level as a whole number of percent, from 50 to 100.');

// What the next run gets, from the Readiness Check (the counts the gateway resolved for the saved mode).
const currentText = (extra) => {
  if (!extra) return 'Run the Readiness Check to see what the next run gets.';
  const resolved = extra.resolved || { lab: extra.lab || 0, lec: extra.lec || 0 };
  const any = resolved.lab + resolved.lec > 0;
  const fewest = extra.suggestion?.weekdays || extra.suggestion?.withSaturday || null;
  switch (extra.mode) {
    case 'off':
      return 'Set to Off: the next run gets no TBA room, so every class that needs a room must fit the CCS rooms.';
    case 'manual':
      return `Set to Manual counts: the next run gets ${any ? tbaRoomCountsText(resolved) : 'no TBA room'}.`;
    default:
      if (!any) return 'Set to Automatic: the CCS rooms hold every class that needs a room, so the next run gets no TBA room.';
      return `Set to Automatic: the next run gets ${tbaRoomCountsText(resolved)}${fewest ? ` (the fewest that fit, ${fewest.lab} + ${fewest.lec}, plus one of each type needed)` : ''}.`;
  }
};

function SuggestionOption({ testId, title, counts, emptyText, onUse, applyBlockedReason, isChosen }) {
  return (
    <div data-testid={`${testId}-option`} className={`p-4 rounded-xl border bg-white dark:bg-[#1a1a1c] ${isChosen ? 'border-indigo-400 dark:border-indigo-500/60' : 'border-slate-200 dark:border-slate-800'}`}>
      <p className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">{title}</p>
      <p className="text-sm font-black text-slate-800 dark:text-white mt-1">{counts ? tbaRoomCountsText(counts) : emptyText}</p>
      {counts && (
        <button
          type="button"
          data-testid={testId}
          onClick={onUse}
          disabled={Boolean(applyBlockedReason)}
          title={applyBlockedReason || undefined}
          className="mt-3 px-3 py-1.5 rounded-lg text-xs font-bold border text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {isChosen ? 'Filled in below' : 'Use these numbers'}
        </button>
      )}
    </div>
  );
}

export default function TbaRoomsPanel({ prefix = 'ga-tba', report, policy, policyError = '', onReloadPolicy, canEdit, lockedReason = '', onSaved }) {
  const extra = report?.extraRooms || null;
  const suggestion = extra?.suggestion || null;
  const saved = savedOf(policy);
  // The form's value: null follows the saved policy; typing or "Use these numbers" fills it.
  const [draft, setDraft] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [banner, setBanner] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const value = draft ?? saved;
  const manual = value.mode === 'manual';
  const problems = {
    ...(manual ? { lab: countProblem(value.lab, 'lab'), lec: countProblem(value.lec, 'lecture') } : { lab: '', lec: '' }),
    headroomPercent: value.headroomEnabled ? percentProblem(value.headroomPercent) : ''
  };
  const hasProblem = Boolean(problems.lab || problems.lec || problems.headroomPercent);
  const isDirty = value.mode !== saved.mode || (manual && (value.lab !== saved.lab || value.lec !== saved.lec))
    || value.headroomEnabled !== saved.headroomEnabled || value.headroomPercent !== saved.headroomPercent;
  const saturdayYears = (policy?.saturdayOverflow?.yearLevels || []).map(y => ORDINAL[y] || `${y}th`).join('/');
  const disabled = !canEdit || isSaving || Boolean(lockedReason);
  const saveBlockedReason = !canEdit ? reasonFor('advanced.edit')
    : lockedReason || (isSaving ? 'Saving…'
      : hasProblem ? 'Fix the marked field first.'
        : !isDirty ? 'No changes to save.' : '');

  const change = (next, field) => {
    setDraft(next);
    setChosen(null);
    setSavedMessage('');
    setBanner('');
    setFieldErrors(prev => {
      if (!prev[field]) return prev;
      const rest = { ...prev };
      delete rest[field];
      return rest;
    });
  };
  const fillCounts = (option, counts) => {
    // Keep the headroom fields (Phase 8 Part 5): only the mode and the counts change here.
    setDraft({ ...value, mode: 'manual', lab: counts.lab, lec: counts.lec });
    setChosen(option);
    setSavedMessage('');
    setBanner('');
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (saveBlockedReason) return;
    setIsSaving(true);
    setBanner('');
    setSavedMessage('');
    try {
      // Only Manual counts change the saved counts; the other modes keep them as they are.
      const counts = manual ? { lab: value.lab, lec: value.lec } : { lab: saved.lab, lec: saved.lec };
      const res = await api.put('/policy', { overflowRooms: { mode: value.mode, enabled: value.mode !== 'off', ...counts, headroom: { enabled: value.headroomEnabled, percent: value.headroomPercent } } });
      setPolicyCache(res.data);
      setDraft(null);
      setChosen(null);
      setFieldErrors({});
      setSavedMessage(`TBA rooms saved: ${tbaRoomModeLabel(value.mode)}${manual ? `, ${tbaRoomCountsText(counts)}` : ''}.`);
      if (onSaved) await onSaved(res.data);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 400 && Array.isArray(data?.errors)) {
        const mine = {};
        const other = [];
        data.errors.forEach(({ field, message }) => {
          const key = String(field || '').replace(/^overflowRooms\./, '');
          const own = { enabled: 'mode', mode: 'mode', lab: 'lab', lec: 'lec', 'headroom.enabled': 'headroomEnabled', 'headroom.percent': 'headroomPercent' };
          if (field !== key && own[key]) mine[own[key]] = message;
          else other.push(message);
        });
        setFieldErrors(mine);
        setBanner(`The TBA rooms were not saved.${Object.keys(mine).length ? ' Each problem is marked next to its field.' : ''}${other.length ? ` ${other.join(' ')}` : ''} Your choice is still in the form.`);
      } else if (err.response?.status === 403) {
        setBanner(`${data?.message || reasonFor('advanced.edit')} Nothing was saved.`);
      } else {
        setBanner(`The TBA rooms could not be saved (${data?.message || err.message}). Your choice is still in the form; try again.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const countField = (field, label, help) => {
    const id = `${prefix}-${field}`;
    const error = fieldErrors[field] || problems[field] || '';
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
          {label}{manual && <><span className="text-red-600 dark:text-red-400" aria-hidden="true"> *</span><span className="sr-only"> (required)</span></>}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={id}
            data-testid={id}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            required={manual}
            aria-required={manual}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
            value={value[field] ?? ''}
            onChange={e => change({ ...value, [field]: e.target.value === '' ? null : Number(e.target.value) }, field)}
            disabled={disabled || !manual}
            className={inputClass}
          />
          <span className="text-xs text-slate-600 dark:text-slate-400">rooms</span>
        </div>
        <p id={`${id}-help`} data-testid={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
          {help}{manual ? '' : ' Used only with Manual counts.'}
        </p>
        <FieldError id={`${id}-error`} message={error} />
      </div>
    );
  };

  return (
    <section data-testid={`${prefix}-rooms`} aria-labelledby={`${prefix}-title`} className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-indigo-500/10"><DoorOpen size={16} className="text-indigo-600 dark:text-indigo-400" aria-hidden="true" /></div>
        <div>
          <h4 id={`${prefix}-title`} className="font-bold text-sm text-slate-800 dark:text-white">TBA rooms</h4>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">Rooms the Dean requests from outside CCS when the CCS rooms are full; their classes show TBA. The run uses the CCS rooms first.</p>
        </div>
      </div>
      <p data-testid={`${prefix}-current`} className="text-xs font-bold text-slate-800 dark:text-slate-200">{currentText(extra)}</p>

      {suggestion && (
        <div className="space-y-3">
          <p className="text-xs text-slate-700 dark:text-slate-300">The CCS rooms alone are short. The fewest TBA rooms that make the room arithmetic fit:</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <SuggestionOption
              testId={`${prefix}-use-weekdays`}
              title="Weekdays only"
              counts={suggestion.weekdays}
              emptyText="Not enough, even with the most TBA rooms the policy allows."
              onUse={() => fillCounts('weekdays', suggestion.weekdays)}
              applyBlockedReason={disabled ? saveBlockedReason : ''}
              isChosen={chosen === 'weekdays'}
            />
            <SuggestionOption
              testId={`${prefix}-use-saturday`}
              title={`Also using Saturday${saturdayYears ? ` (${saturdayYears} years)` : ''}`}
              counts={suggestion.withSaturday}
              emptyText="No Saturday option: Saturday classes are switched off in the Scheduling Policy, or they do not help."
              onUse={() => fillCounts('saturday', suggestion.withSaturday)}
              applyBlockedReason={disabled ? saveBlockedReason : ''}
              isChosen={chosen === 'saturday'}
            />
          </div>
          {suggestion.note && (
            <p data-testid={`${prefix}-note`} className="flex items-start gap-2 text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3">
              <Info size={14} className="shrink-0 mt-px text-slate-500 dark:text-slate-400" aria-hidden="true" /> {suggestion.note}
            </p>
          )}
        </div>
      )}

      {chosen && (
        <p role="status" data-testid={`${prefix}-filled`} className="flex items-center gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-300">
          <ClipboardCheck size={14} className="shrink-0" aria-hidden="true" />
          Filled in as Manual counts from &ldquo;{chosen === 'weekdays' ? 'Weekdays only' : 'Also using Saturday'}&rdquo;. Nothing is saved until you press &ldquo;Save TBA rooms&rdquo;.
        </p>
      )}

      {policy ? (
        <form onSubmit={handleSave} noValidate data-testid={`${prefix}-form`} className="space-y-4">
          {lockedReason && <p className="text-[11px] font-bold text-slate-700 dark:text-slate-300">{lockedReason}</p>}
          <fieldset disabled={disabled} className="min-w-0 grid grid-cols-1 md:grid-cols-3 gap-4">
            <legend className="sr-only">TBA rooms</legend>
            <div>
              <label htmlFor={`${prefix}-mode`} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                How the TBA rooms are set<span className="text-red-600 dark:text-red-400" aria-hidden="true"> *</span><span className="sr-only"> (required)</span>
              </label>
              <Select
                id={`${prefix}-mode`}
                data-testid={`${prefix}-mode`}
                required
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.mode)}
                aria-describedby={`${prefix}-mode-help${fieldErrors.mode ? ` ${prefix}-mode-error` : ''}`}
                value={value.mode}
                onChange={e => change({ ...value, mode: e.target.value }, 'mode')}
                className="w-full bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
              >
                {TBA_ROOM_MODES.map(mode => <option key={mode} value={mode}>{TBA_ROOM_MODE_LABELS[mode]}</option>)}
              </Select>
              <p id={`${prefix}-mode-help`} data-testid={`${prefix}-mode-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">{MODE_HELP[value.mode]}</p>
              <FieldError id={`${prefix}-mode-error`} message={fieldErrors.mode} />
            </div>
            {countField('lab', 'TBA lab rooms', 'Take labs, and Major lectures when the lecture rooms are full.')}
            {countField('lec', 'TBA lecture rooms', 'Take the lectures that need a room.')}
          </fieldset>
          {/* The headroom rule (Phase 8 Part 5, decision 2a): on by default; Automatic mode only adds the room. */}
          <fieldset disabled={disabled} className="min-w-0 space-y-2">
            <legend className="sr-only">Headroom for TBA rooms</legend>
            <label htmlFor={`${prefix}-headroom`} className="flex items-start gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                id={`${prefix}-headroom`}
                data-testid={`${prefix}-headroom`}
                type="checkbox"
                checked={value.headroomEnabled}
                onChange={e => change({ ...value, headroomEnabled: e.target.checked }, 'headroomEnabled')}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              <span>Headroom: with Automatic, give the run one TBA room of a type that is nearly full, even when the arithmetic says the CCS rooms fit.</span>
            </label>
            <div className="flex items-center gap-2 pl-6">
              <label htmlFor={`${prefix}-headroom-percent`} className="text-xs font-bold text-slate-700 dark:text-slate-300">Nearly full means more than</label>
              <input
                id={`${prefix}-headroom-percent`}
                data-testid={`${prefix}-headroom-percent`}
                type="number"
                inputMode="numeric"
                min={50}
                max={100}
                step={1}
                aria-invalid={Boolean(fieldErrors.headroomPercent || problems.headroomPercent)}
                aria-describedby={`${prefix}-headroom-help${fieldErrors.headroomPercent || problems.headroomPercent ? ` ${prefix}-headroom-percent-error` : ''}`}
                value={value.headroomPercent ?? ''}
                onChange={e => change({ ...value, headroomPercent: e.target.value === '' ? null : Number(e.target.value) }, 'headroomPercent')}
                disabled={disabled || !value.headroomEnabled}
                className={inputClass}
              />
              <span className="text-xs text-slate-600 dark:text-slate-400">% of the weekday room hours</span>
            </div>
            <p id={`${prefix}-headroom-help`} data-testid={`${prefix}-headroom-help`} className="text-[11px] text-slate-600 dark:text-slate-400 pl-6 leading-snug">
              An arithmetic that fits with an hour to spare leaves the run nothing to untangle with; the TBA-room penalty keeps the extra room empty when it is not needed. With the odd and even weeks on, each week group is measured on its own.
            </p>
            <FieldError id={`${prefix}-headroom-percent-error`} message={fieldErrors.headroomPercent || problems.headroomPercent} />
          </fieldset>
          {banner && (
            <p role="alert" data-testid={`${prefix}-error`} className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
              <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {banner}
            </p>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <button
              type="submit"
              data-testid={`${prefix}-submit`}
              disabled={Boolean(saveBlockedReason)}
              aria-describedby={`${prefix}-save-reason`}
              className="self-start px-4 py-2 rounded-xl text-xs font-bold text-white flex items-center shadow-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500"
            >
              {isSaving ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : <Save size={14} className="mr-1.5" aria-hidden="true" />}
              {isSaving ? 'Saving…' : 'Save TBA rooms'}
            </button>
            <p id={`${prefix}-save-reason`} data-testid={`${prefix}-save-reason`} className="text-[11px] text-slate-600 dark:text-slate-400">
              {saveBlockedReason && saveBlockedReason !== 'Saving…' ? saveBlockedReason : ''}
              {!saveBlockedReason && isDirty ? 'Not saved yet: press "Save TBA rooms" to keep this choice.' : ''}
            </p>
          </div>
          {savedMessage && (
            <p role="status" data-testid={`${prefix}-saved`} className="flex items-center gap-1.5 text-xs font-bold text-green-700 dark:text-green-400">
              <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" /> {savedMessage}
            </p>
          )}
        </form>
      ) : policyError ? (
        <p role="alert" className="text-xs font-bold text-red-700 dark:text-red-400">
          {policyError}{' '}
          {onReloadPolicy && <button type="button" onClick={onReloadPolicy} className="underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">Retry</button>}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading the Scheduling Policy…
        </p>
      )}
    </section>
  );
}
