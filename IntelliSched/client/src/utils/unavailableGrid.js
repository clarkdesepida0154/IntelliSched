// The Unavailable times grid's reading and writing of the stored rows (components/ui/UnavailableGrid.jsx;
// Phase 4 Part 2). The rows are the same { day, start, end[, note] } ("HH:MM") the list editor edits and
// the gateway validates (server/src/utils/timeWindows.js): no new storage.
import { DAY_NAMES, toMinutes, fromMinutes, formatTime12 } from './timeGrid';

// "8:00–8:30 AM" when both ends share AM/PM, else "11:30 AM–12:00 PM" (display only).
export const rangeWords = (start, end) => {
  const a = formatTime12(start);
  const b = formatTime12(end);
  const [aTime, aMeridiem] = a.split(' ');
  const bMeridiem = b.split(' ')[1];
  return aMeridiem === bMeridiem ? `${aTime}–${b}` : `${a}–${b}`;
};

const DAY_ORDER = Object.fromEntries(DAY_NAMES.map((day, i) => [day, i]));
const sortRows = (rows) => [...rows].sort((x, y) => ((DAY_ORDER[x.day] ?? 99) - (DAY_ORDER[y.day] ?? 99)) || ((toMinutes(x.start) ?? 0) - (toMinutes(y.start) ?? 0)));

// The marked slot starts (minutes) of one day: every grid slot a row of that day covers inside the
// grid's hours. A row off the grid is read slot by slot (a slot counts when the row covers all of it).
export const markedSlotsOf = (blocks, day, hours, slotMinutes) => {
  const winStart = toMinutes(hours.start);
  const winEnd = toMinutes(hours.end);
  const marked = new Set();
  (blocks || []).forEach(row => {
    if (row.day !== day) return;
    const s = toMinutes(row.start);
    const e = toMinutes(row.end);
    if (s === null || e === null) return;
    for (let m = winStart; m < winEnd; m += slotMinutes) {
      if (s <= m && e >= m + slotMinutes) marked.add(m);
    }
  });
  return marked;
};

// The rows after one day's marked slots changed: rows of the other days unchanged; this day's rows
// outside the grid's hours kept (clipped to the outside); the marked slots merged into rows, each
// carrying the note of the first original row it overlaps ('' when none). Sorted by day, then start.
export const rebuildDay = (blocks, day, marked, hours, slotMinutes) => {
  const winStart = toMinutes(hours.start);
  const winEnd = toMinutes(hours.end);
  const dayRows = (blocks || []).filter(row => row.day === day);
  const others = (blocks || []).filter(row => row.day !== day);
  const kept = [];
  dayRows.forEach(row => {
    const s = toMinutes(row.start);
    const e = toMinutes(row.end);
    if (s === null || e === null) {
      kept.push(row);
      return;
    }
    if (s < winStart) kept.push({ ...row, end: fromMinutes(Math.min(e, winStart)) });
    if (e > winEnd) kept.push({ ...row, start: fromMinutes(Math.max(s, winEnd)) });
  });
  const runs = [];
  [...marked].sort((a, b) => a - b).forEach(m => {
    const last = runs[runs.length - 1];
    if (last && last.end === m) last.end = m + slotMinutes;
    else runs.push({ start: m, end: m + slotMinutes });
  });
  const rows = runs.map(run => {
    const source = dayRows.find(row => toMinutes(row.start) < run.end && toMinutes(row.end) > run.start);
    return { day, start: fromMinutes(run.start), end: fromMinutes(run.end), note: source?.note || '' };
  });
  return sortRows([...others, ...kept, ...rows]);
};

// The grid's slot starts (minutes) for the policy's hours.
export const gridSlots = (hours, slotMinutes) => {
  const out = [];
  const from = toMinutes(hours.start);
  const to = toMinutes(hours.end);
  if (from === null || to === null || !(slotMinutes > 0)) return out;
  for (let m = from; m < to; m += slotMinutes) out.push(m);
  return out;
};

// Phase 8 Part 8 (decision 3e): the parts of the stored rows the grid cannot show — a day that is not
// one of its columns (Sunday), or the hours before or after its window (Saturday 7:00–8:00 while the
// grid starts at 8:00) — so none can hide: the grid lists them on a line under it, each with Remove.
// [{ index, day, start, end, note }], `index` being the row it comes from.
export const outsideParts = (blocks, days, hours) => {
  const winStart = toMinutes(hours.start);
  const winEnd = toMinutes(hours.end);
  const out = [];
  (blocks || []).forEach((row, index) => {
    const s = toMinutes(row.start);
    const e = toMinutes(row.end);
    if (s === null || e === null || e <= s) return;
    const note = row.note || '';
    if (!days.includes(row.day)) {
      out.push({ index, day: row.day, start: row.start, end: row.end, note });
      return;
    }
    if (s < winStart) out.push({ index, day: row.day, start: row.start, end: fromMinutes(Math.min(e, winStart)), note });
    if (e > winEnd) out.push({ index, day: row.day, start: fromMinutes(Math.max(s, winEnd)), end: row.end, note });
  });
  return out;
};

// The rows without one outside part: a row wholly outside goes; a row partly inside keeps the rest.
export const withoutOutsidePart = (blocks, part) => {
  const rows = [];
  (blocks || []).forEach((row, index) => {
    if (index !== part.index) {
      rows.push(row);
      return;
    }
    const s = toMinutes(row.start);
    const e = toMinutes(row.end);
    const ps = toMinutes(part.start);
    const pe = toMinutes(part.end);
    if (s < ps) rows.push({ ...row, end: fromMinutes(ps) });
    if (e > pe) rows.push({ ...row, start: fromMinutes(pe) });
  });
  return sortRows(rows);
};
