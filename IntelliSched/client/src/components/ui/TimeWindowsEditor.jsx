import { useRef } from 'react';
import { Plus, Trash2, AlertCircle, Sun } from 'lucide-react';
import { formatTime12 } from '../../utils/timeGrid';
import Select from './Select';

const selectClass = 'bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 px-2 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50';

/**
 * A keyboard-usable list of { day, start, end[, note] } rows (24-hour "HH:MM" values, 12-hour
 * labels). Used for room availability and faculty unavailable blocks.
 *
 * Props
 * - testIdPrefix: e.g. "room-availability" -> room-availability-day-0, ...-start-0, ...-end-0, ...-remove-0, ...-add
 * - fieldPrefix:  server error field prefix, e.g. "availability" (errors like "availability.0.start")
 * - errors:       { [field]: message } from the last save
 * - days, times:  the options offered (from the Scheduling Policy / calendar)
 * - withNote:     show a note input per row
 * - wholeDay:     (day) => { start, end } enables a "Whole day" button per row
 */
export default function TimeWindowsEditor({
  label, help, testIdPrefix, fieldPrefix, windows, onChange, days, times, errors = {},
  withNote = false, wholeDay = null, disabled = false, addLabel = 'Add a window', emptyText
}) {
  const listRef = useRef(null);
  const rows = windows || [];
  const update = (i, patch) => onChange(rows.map((row, k) => (k === i ? { ...row, ...patch } : row)));
  const remove = (i) => onChange(rows.filter((_, k) => k !== i));
  const add = () => {
    const last = rows[rows.length - 1];
    const next = { day: last?.day || days[0], start: times[0], end: times[Math.min(2, times.length - 1)], ...(withNote ? { note: '' } : {}) };
    onChange([...rows, next]);
    // Move focus to the new row's day so the keyboard flow continues there.
    setTimeout(() => listRef.current?.querySelector(`[data-testid="${testIdPrefix}-day-${rows.length}"]`)?.focus(), 0);
  };
  const rowError = (i) => Object.entries(errors).filter(([f]) => f.startsWith(`${fieldPrefix}.${i}.`)).map(([, m]) => m);
  const withCurrent = (options, value) => (value && !options.includes(value) ? [value, ...options] : options);

  return (
    <fieldset className="col-span-2" disabled={disabled}>
      <legend className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">{label}</legend>
      {help && <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 leading-snug">{help}</p>}
      <ul ref={listRef} className="space-y-2">
        {rows.length === 0 && (
          <li className="text-xs text-slate-500 dark:text-slate-400 italic">{emptyText || 'None.'}</li>
        )}
        {rows.map((row, i) => {
          const errs = rowError(i);
          return (
            <li key={i} className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#121212]">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`${testIdPrefix}-day-${i}`}>Day, row {i + 1}</label>
                <Select id={`${testIdPrefix}-day-${i}`} data-testid={`${testIdPrefix}-day-${i}`} value={row.day} onChange={e => update(i, { day: e.target.value })} className={selectClass}>
                  {withCurrent(days, row.day).map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
                <label className="sr-only" htmlFor={`${testIdPrefix}-start-${i}`}>From, row {i + 1}</label>
                <Select id={`${testIdPrefix}-start-${i}`} data-testid={`${testIdPrefix}-start-${i}`} value={row.start} onChange={e => update(i, { start: e.target.value })} className={selectClass}>
                  {withCurrent(times, row.start).map(t => <option key={t} value={t}>{formatTime12(t)}</option>)}
                </Select>
                <span className="text-xs text-slate-500 dark:text-slate-400" aria-hidden="true">to</span>
                <label className="sr-only" htmlFor={`${testIdPrefix}-end-${i}`}>Until, row {i + 1}</label>
                <Select id={`${testIdPrefix}-end-${i}`} data-testid={`${testIdPrefix}-end-${i}`} value={row.end} onChange={e => update(i, { end: e.target.value })} className={selectClass}>
                  {withCurrent(times, row.end).map(t => <option key={t} value={t}>{formatTime12(t)}</option>)}
                </Select>
                {wholeDay && (
                  <button
                    type="button"
                    data-testid={`${testIdPrefix}-wholeday-${i}`}
                    onClick={() => update(i, wholeDay(row.day))}
                    className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500"
                  >
                    <Sun size={12} aria-hidden="true" /> Whole day
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-remove-${i}`}
                  onClick={() => remove(i)}
                  aria-label={`Remove row ${i + 1} (${row.day} ${formatTime12(row.start)} to ${formatTime12(row.end)})`}
                  className="ml-auto p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {withNote && (
                <div className="mt-2">
                  <label className="sr-only" htmlFor={`${testIdPrefix}-note-${i}`}>Note, row {i + 1}</label>
                  <input
                    id={`${testIdPrefix}-note-${i}`}
                    data-testid={`${testIdPrefix}-note-${i}`}
                    type="text"
                    maxLength={120}
                    placeholder="Note (optional), e.g. MIT classes, teaches at BSBA"
                    value={row.note || ''}
                    onChange={e => update(i, { note: e.target.value })}
                    className={`${selectClass} w-full font-normal`}
                  />
                </div>
              )}
              {errs.map(message => (
                <p key={message} role="alert" className="mt-1.5 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
                  <AlertCircle size={12} className="mt-px shrink-0" /> {message}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-testid={`${testIdPrefix}-add`}
        onClick={add}
        className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald-500"
      >
        <Plus size={13} aria-hidden="true" /> {addLabel}
      </button>
      {errors[fieldPrefix] && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{errors[fieldPrefix]}</p>}
    </fieldset>
  );
}
