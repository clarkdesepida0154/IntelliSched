// Time grid helpers. Storage is always 24-hour "HH:MM"; the 12-hour form is for display only.
// Every day window, slot origin and allowed day comes from the SchedulingPolicy passed in; nothing
// here knows the college's hours.
//
// client/src/utils/timeGrid.js is an identical mirror: the code between the SHARED markers must be
// byte-for-byte the same in both files (server/tests/unit/timeGrid.test.js checks it).

// ---- BEGIN SHARED ----
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad2 = (n) => String(n).padStart(2, '0');

// "HH:MM" (24-hour) only; "7:00" and "07:00 AM" are not storage times.
const isTime = (value) => typeof value === 'string' && TIME_PATTERN.test(value);

// "13:30" -> 810; null when the value is not a storage time.
const toMinutes = (time) => {
  if (!isTime(time)) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

// 810 -> "13:30". Minutes are taken within one day (0..1440; 1440 is "24:00", the end of the day).
const fromMinutes = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

const isOnGrid = (time, slotMinutes) => {
  const m = toMinutes(time);
  return m !== null && m % slotMinutes === 0;
};

// "13:00" -> "1:00 PM". Display only.
const formatTime12 = (time) => {
  const m = toMinutes(time);
  if (m === null) return String(time ?? '');
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad2(m % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
};

const formatRange12 = (start, end) => `${formatTime12(start)}–${formatTime12(end)}`;

// Hours between two storage times (may be fractional, e.g. 1.5).
const hoursBetween = (start, end) => (toMinutes(end) - toMinutes(start)) / 60;

// Every grid time from start to end inclusive, e.g. ("07:00", "08:00", 30) -> 07:00, 07:30, 08:00.
const gridTimes = (start, end, slotMinutes) => {
  const from = toMinutes(start);
  const to = toMinutes(end);
  if (from === null || to === null || !(slotMinutes > 0)) return [];
  const times = [];
  for (let m = from; m <= to; m += slotMinutes) times.push(fromMinutes(m));
  return times;
};

// The window classes may occupy on one day: the weekday window on weekdays, the Saturday window on
// Saturday (the overflow window, also used when overflow is switched off), the NSTP window on the
// NSTP day when that is another weekend day. null for a day the scheduler never uses.
const dayWindow = (policy, day) => {
  if ((policy.weekdays || []).includes(day)) return { start: policy.dayStart, end: policy.dayEnd };
  if (day === 'Saturday') return { start: policy.saturdayOverflow.start, end: policy.saturdayOverflow.end };
  if (day === policy.nstp.day) return { start: policy.nstp.start, end: policy.nstp.end };
  return null;
};

// Slot 0 is the earliest start of any window, so every slot index is >= 0.
const gridOrigin = (policy) => fromMinutes(Math.min(
  toMinutes(policy.dayStart),
  toMinutes(policy.saturdayOverflow.start),
  toMinutes(policy.nstp.start)
));

// "HH:MM" -> slot index from the grid origin; null when the time is not a storage time.
const slotOfTime = (policy, time) => {
  const m = toMinutes(time);
  if (m === null) return null;
  return (m - toMinutes(gridOrigin(policy))) / policy.slotMinutes;
};

// Slot index -> "HH:MM".
const timeOfSlot = (policy, slot) => fromMinutes(toMinutes(gridOrigin(policy)) + slot * policy.slotMinutes);

// A day's window in slots: { day, startSlot, endSlot } (endSlot exclusive), or null.
const windowSlots = (policy, day) => {
  const w = dayWindow(policy, day);
  return w ? { day, startSlot: slotOfTime(policy, w.start), endSlot: slotOfTime(policy, w.end) } : null;
};

// Days a section's classes may use: the weekdays, plus Saturday when the overflow is on and the
// section's year level is in its list. (NSTP has its own fixed day.)
const allowedDaysForSection = (policy, section) => {
  const days = [...(policy.weekdays || [])];
  const year = Number(section?.yearLevel);
  const overflow = policy.saturdayOverflow || {};
  if (overflow.enabled && (overflow.yearLevels || []).includes(year) && !days.includes('Saturday')) days.push('Saturday');
  return days;
};

// True when [windowStart, windowEnd) holds a continuous stretch of at least minFree minutes that no
// busy interval touches. Intervals are { start, end } in minutes, end exclusive.
const hasFreeRun = (busy, windowStart, windowEnd, minFree) => {
  const clipped = (busy || [])
    .map(b => ({ start: Math.max(b.start, windowStart), end: Math.min(b.end, windowEnd) }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  let cursor = windowStart;
  for (const b of clipped) {
    if (b.start - cursor >= minFree) return true;
    cursor = Math.max(cursor, b.end);
  }
  return windowEnd - cursor >= minFree;
};
// ---- END SHARED ----

module.exports = {
  DAY_NAMES,
  WEEKDAY_NAMES,
  isTime,
  toMinutes,
  fromMinutes,
  isOnGrid,
  formatTime12,
  formatRange12,
  hoursBetween,
  gridTimes,
  dayWindow,
  gridOrigin,
  slotOfTime,
  timeOfSlot,
  windowSlots,
  allowedDaysForSection,
  hasFreeRun
};
