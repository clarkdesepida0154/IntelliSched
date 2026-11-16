import { AlertCircle } from 'lucide-react';
import { extraLabRoomHelp } from '../../utils/extraRooms';
import { TBA_ROOM_MODES, TBA_ROOM_MODE_LABELS } from '../../utils/gaRun';
import { TBA_ROOM_FIELD_LABELS, tbaRoomsModeOf, tbaRoomsProblems, withTbaRoomsMode } from './tbaRooms';

// TBA rooms (Phase 3 Step 4; Phase 2 called them "extra rooms"): the Scheduling Policy's fields for
// overflowRooms { mode, enabled, lab, lec }, inside "Advanced (system team)". A TBA room stands for a room
// the Dean requests from outside CCS; its classes show as TBA and are listed under "TBA rooms to request".
// The gateway resolves the mode in one place (utils/termInputs.js) and never writes the resolved counts
// back, so the counts here are only the manual ones. Only advanced.edit may change any of this (403
// ADVANCED_ONLY for anyone else). The mode names are the Generate Schedule page's (utils/gaRun.js).
// Ids: `${idPrefix}-mode-{auto, manual, off}`, `${idPrefix}-lab`, `${idPrefix}-lec` (each with `-error`),
// `${idPrefix}-counts-note`.
const MODE_HELP = {
  auto: "Before each run the system sets how many TBA rooms it may use: the Readiness Check's suggestion, plus one room of each type it needs.",
  manual: 'Every run may use exactly the counts below.',
  off: "No TBA rooms: a term whose classes do not fit in the CCS rooms can't be generated."
};

const FieldError = ({ id, message }) => (message ? (
  <p id={id} data-testid={id} role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
    <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {message}
  </p>
) : null);

// Controlled by the page: onChange(nextValue, changedField) with changedField 'mode', 'lab' or 'lec' (a
// new mode may also change the counts: the page then clears the errors of all three); `errors` holds the
// gateway's messages per field ({ mode, lab, lec }); `savedValue` is the stored overflowRooms, which the
// counts go back to when "Manual counts" is left.
export default function TbaRoomsFields({ idPrefix, value, savedValue = null, onChange, errors = {}, disabled = false, majorLectureInLab = 'PENALTY' }) {
  const mode = tbaRoomsModeOf(value);
  const problems = tbaRoomsProblems(value);
  const isManual = mode === 'manual';
  const setMode = (next) => {
    if (next !== mode) onChange(withTbaRoomsMode(value, next, savedValue), 'mode');
  };
  const countNoteId = `${idPrefix}-counts-note`;
  const count = (field, help) => {
    const id = `${idPrefix}-${field}`;
    const error = errors[field] || problems[field] || '';
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">
          {TBA_ROOM_FIELD_LABELS[field]}
          {isManual && <span className="text-red-600 dark:text-red-400" aria-hidden="true"> *</span>}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={id}
            data-testid={id}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            required={isManual}
            aria-required={isManual || undefined}
            value={value?.[field] ?? ''}
            onChange={e => onChange({ ...value, [field]: e.target.value === '' ? null : Number(e.target.value) }, field)}
            disabled={disabled || !isManual}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help ${countNoteId}${error ? ` ${id}-error` : ''}`}
            className="w-28 bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-60 disabled:cursor-not-allowed"
          />
          <span className="text-xs text-slate-600 dark:text-slate-400">rooms</span>
        </div>
        <p id={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">{help}</p>
        <FieldError id={`${id}-error`} message={error} />
      </div>
    );
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
      <fieldset className="sm:col-span-2 min-w-0" disabled={disabled} aria-describedby={`${idPrefix}-mode-help`}>
        <legend className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">TBA rooms when the CCS rooms are full</legend>
        <p id={`${idPrefix}-mode-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mb-2 leading-snug">
          A TBA room stands for a room the Dean requests from outside CCS. Its classes show as TBA and are listed under &ldquo;TBA rooms to request&rdquo;. The scheduler fills the CCS rooms first.
        </p>
        <div className="grid grid-cols-1 gap-2">
          {TBA_ROOM_MODES.map(m => {
            const checked = mode === m;
            return (
              <label key={m} className={`flex items-start gap-2.5 p-3 rounded-xl border text-left cursor-pointer ${checked ? 'border-purple-300 bg-purple-50 dark:border-purple-500/40 dark:bg-purple-500/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c]'}`}>
                <input
                  type="radio"
                  name={`${idPrefix}-mode`}
                  value={m}
                  data-testid={`${idPrefix}-mode-${m}`}
                  checked={checked}
                  onChange={() => setMode(m)}
                  aria-describedby={`${idPrefix}-mode-${m}-help`}
                  className="mt-0.5 w-4 h-4 shrink-0 text-purple-600 focus-visible:ring-2 focus-visible:ring-purple-500"
                />
                <span className="min-w-0">
                  <span className={`block text-xs font-bold ${checked ? 'text-purple-900 dark:text-purple-100' : 'text-slate-700 dark:text-slate-200'}`}>
                    {TBA_ROOM_MODE_LABELS[m]}{m === 'auto' ? ' (recommended)' : ''}
                  </span>
                  <span id={`${idPrefix}-mode-${m}-help`} className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug">{MODE_HELP[m]}</span>
                </span>
              </label>
            );
          })}
        </div>
        <FieldError id={`${idPrefix}-mode-error`} message={errors.mode} />
      </fieldset>
      {count('lab', extraLabRoomHelp(majorLectureInLab))}
      {count('lec', 'Take the lectures that need a room.')}
      <p id={countNoteId} data-testid={countNoteId} className="sm:col-span-2 -mt-2 text-[11px] text-slate-600 dark:text-slate-400">
        {isManual
          ? 'Every run may use exactly these counts; the Readiness Check says whether they are enough.'
          : `Used only with "${TBA_ROOM_MODE_LABELS.manual}"${mode === 'auto' ? ': in Automatic mode the Readiness Check shows the counts the next run will use.' : '.'}`}
      </p>
    </div>
  );
}
