import { useEffect, useMemo, useRef } from 'react';
import { fromMinutes, formatTime12 } from '../../utils/timeGrid';
import { rangeWords, markedSlotsOf, rebuildDay, gridSlots, outsideParts, withoutOutsidePart } from '../../utils/unavailableGrid';

/**
 * A weekly grid of the policy's slots for a professor's unavailable times (Phase 4 Part 2). The days
 * and the 30-minute rows come from the Scheduling Policy; a click marks or unmarks one cell, a drag
 * marks a range; every cell is a button with an aria-label ("Monday 8:00–8:30 AM, unavailable"),
 * and the arrow keys move between cells. It reads and writes the stored format, the same
 * { day, start, end[, note] } rows the list editor edits (no new storage; utils/unavailableGrid.js):
 * the marked cells of one day are merged into rows, a row's note survives while any of its cells
 * stays marked, and rows the grid cannot show (another day, or times outside the policy's hours)
 * are kept as they are. Phase 8 Part 8 (decision 3e): those parts are listed on a line under the grid
 * ("Outside the grid: Saturday 7:00–8:00 AM · Remove"), so none can hide; Remove takes that part out.
 *
 * Props
 * - blocks, onChange: the rows and their setter (the form's unavailableBlocks)
 * - days: the columns, e.g. the policy's weekdays and Saturday
 * - hours: { start, end } ("HH:MM"), the rows (the policy's whole day)
 * - slotMinutes: the policy's slot length
 * - testIdPrefix: cells are `${testIdPrefix}-${day}-${HH:MM}`; the grid is `${testIdPrefix}`
 */

const CELL_BASE = 'h-5 w-full border-r border-b border-slate-200 dark:border-slate-700 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:cursor-not-allowed';
const CELL_FREE = 'bg-white hover:bg-slate-100 dark:bg-[#121212] dark:hover:bg-slate-800';
const CELL_MARKED = 'bg-rose-400 hover:bg-rose-500 dark:bg-rose-500/70 dark:hover:bg-rose-500';

export default function UnavailableGrid({
  blocks, onChange, days, hours, slotMinutes, disabled = false, testIdPrefix = 'faculty-grid'
}) {
  const gridRef = useRef(null);
  // The latest rows, so a drag that marks several cells before React re-renders builds on its own
  // earlier marks, not on the rows of the last render.
  const blocksRef = useRef(blocks);
  useEffect(() => { blocksRef.current = blocks; }, [blocks]);
  // { mark } while the mouse button is held down on the grid.
  const drag = useRef(null);

  const slots = useMemo(() => gridSlots(hours, slotMinutes), [hours, slotMinutes]);
  const marked = useMemo(
    () => Object.fromEntries(days.map(day => [day, markedSlotsOf(blocks, day, hours, slotMinutes)])),
    [blocks, days, hours, slotMinutes]
  );
  const markedHours = days.reduce((sum, day) => sum + marked[day].size, 0) * slotMinutes / 60;
  const outside = useMemo(() => outsideParts(blocks, days, hours), [blocks, days, hours]);
  const removeOutside = (part) => {
    if (disabled) return;
    const next = withoutOutsidePart(blocksRef.current, part);
    blocksRef.current = next;
    onChange(next);
  };

  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener('mouseup', end);
    return () => window.removeEventListener('mouseup', end);
  }, []);

  // Marks or clears one cell, or (during a drag) every cell of that day from the drag's first cell to
  // this one, so a fast drag that skips a cell's mouse event still marks the whole range.
  const apply = (day, slot, mark, fromSlot = slot) => {
    if (disabled) return;
    const current = markedSlotsOf(blocksRef.current, day, hours, slotMinutes);
    const lo = Math.min(slot, fromSlot);
    const hi = Math.max(slot, fromSlot);
    let changed = false;
    for (let s = lo; s <= hi; s += slotMinutes) {
      if (current.has(s) === mark) continue;
      if (mark) current.add(s);
      else current.delete(s);
      changed = true;
    }
    if (!changed) return;
    const next = rebuildDay(blocksRef.current, day, current, hours, slotMinutes);
    blocksRef.current = next;
    onChange(next);
  };

  const moveFocus = (event) => {
    const deltas = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const dayIndex = days.indexOf(event.currentTarget.dataset.day) + delta[0];
    const slotIndex = slots.indexOf(Number(event.currentTarget.dataset.slot)) + delta[1];
    const target = gridRef.current?.querySelector(`[data-day="${days[dayIndex]}"][data-slot="${slots[slotIndex]}"]`);
    target?.focus();
  };

  return (
    <div data-testid={testIdPrefix} className="select-none">
      <div
        ref={gridRef}
        role="group"
        aria-label="Unavailable times, by day and half hour"
        className="grid rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden text-[10px]"
        style={{ gridTemplateColumns: `4.25rem repeat(${days.length}, minmax(0, 1fr))` }}
      >
        <div className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-r border-slate-200 dark:border-slate-700" aria-hidden="true" />
        {days.map(day => (
          <div key={day} className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-r last:border-r-0 border-slate-200 dark:border-slate-700 px-1 py-1 text-center font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate" title={day}>
            {day.slice(0, 3)}
          </div>
        ))}
        {slots.map(slot => {
          const start = fromMinutes(slot);
          const end = fromMinutes(slot + slotMinutes);
          const onHour = slot % 60 === 0;
          return [
            <div
              key={`${slot}-label`}
              className={`border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#1a1a1c] px-1 h-5 leading-5 text-right font-bold tabular-nums text-slate-500 dark:text-slate-400 ${onHour ? '' : 'text-transparent'}`}
              aria-hidden="true"
            >
              {onHour ? formatTime12(start) : '·'}
            </div>,
            ...days.map(day => {
              const isMarked = marked[day].has(slot);
              return (
                <button
                  key={`${slot}-${day}`}
                  type="button"
                  data-testid={`${testIdPrefix}-${day}-${start}`}
                  data-day={day}
                  data-slot={slot}
                  aria-pressed={isMarked}
                  aria-label={`${day} ${rangeWords(start, end)}, ${isMarked ? 'unavailable' : 'available'}`}
                  title={`${day} ${rangeWords(start, end)}: ${isMarked ? 'unavailable (click to clear)' : 'available (click to mark unavailable)'}`}
                  disabled={disabled}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    drag.current = { mark: !isMarked, day, slot };
                    apply(day, slot, !isMarked);
                  }}
                  onMouseEnter={() => {
                    if (!drag.current) return;
                    apply(day, slot, drag.current.mark, drag.current.day === day ? drag.current.slot : slot);
                  }}
                  // A click from the keyboard (Enter or Space) has no mouse detail; a mouse click was
                  // already applied on mousedown.
                  onClick={(event) => { if (event.detail === 0) apply(day, slot, !isMarked); }}
                  onKeyDown={moveFocus}
                  className={`${CELL_BASE} ${isMarked ? CELL_MARKED : CELL_FREE} last:border-r-0`}
                />
              );
            })
          ];
        })}
      </div>
      <p data-testid={`${testIdPrefix}-summary`} className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-block align-middle w-3 h-3 rounded-sm bg-rose-400 dark:bg-rose-500/70 mr-1" aria-hidden="true" />
        {markedHours > 0 ? `${markedHours} h marked unavailable.` : 'Nothing marked: the professor can teach whenever classes run.'}
        {' '}Click a cell to mark or unmark it; drag to mark a range. Use the arrow keys to move and Enter to mark.
      </p>
      {outside.length > 0 && (
        <p data-testid={`${testIdPrefix}-outside`} className="mt-1.5 text-[11px] text-amber-800 dark:text-amber-300">
          <span className="font-bold">Outside the grid:</span>{' '}
          {outside.map((part, i) => (
            <span key={`${part.index}-${part.start}`} className="whitespace-nowrap">
              {i > 0 ? '; ' : ''}{part.day} {rangeWords(part.start, part.end)}{part.note ? ` (${part.note})` : ''}{' · '}
              <button
                type="button"
                data-testid={`${testIdPrefix}-outside-remove-${i}`}
                onClick={() => removeOutside(part)}
                disabled={disabled}
                aria-label={`Remove ${part.day} ${rangeWords(part.start, part.end)} (outside the grid)`}
                className="font-bold underline cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
              >
                Remove
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
