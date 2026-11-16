// The Teachers' Program's own blocks on the weekly table (Phase 3 Steps 2 and 3), shared by the
// Schedule Views & Editor and the printed "Class schedule table" layout, so the screen and the paper
// draw them the same way: the ancillary duty blocks the gateway placed in free weekday time (GET
// /schedule/outputs faculty[].ancillary.blocks) and the professor's unavailable times. Blocks are in
// the shape of WeeklyTable's `blocks`. Nothing here computes an hour of the load.
import { dayWindow, fromMinutes, toMinutes } from './timeGrid';
import { dutyLines, practicumLines, timeLabel } from './scheduleDisplay';

// A coordinator's On-The-Job Training boxes (Phase 4 Part 4; GET /schedule/outputs
// faculty[].practicum.blocks), placed by the gateway in free weekday time before the duty blocks:
// the practicum code, "On-The-Job Training", the section. testIdOf(i) names each box ("tp-ojt-0").
export const practicumBlocks = (blocks, { testIdOf = (i) => `tp-ojt-${i}` } = {}) => (Array.isArray(blocks) ? blocks : []).map((block, i) => ({
  id: `ojt-${i}`,
  day: block.day,
  start: block.start,
  end: block.end,
  kind: 'practicum',
  lines: practicumLines(block),
  testId: testIdOf(i),
  ariaLabel: `${block.day} ${timeLabel(block.start)} to ${timeLabel(block.end)}: ${block.subjectCode} ${block.label || 'On-The-Job Training'}, ${block.sectionLabel}`
}));

// The window of one day under the version's policy (dayWindow), or the weekday window on a day
// without one (e.g. Sunday, which the table's rows always cover).
const windowOf = (policy, day) => {
  const known = policy?.saturdayOverflow && policy?.nstp ? dayWindow(policy, day) : null;
  return known || { start: policy?.dayStart, end: policy?.dayEnd };
};

// The part of a professor's unavailable time inside that day's window of the version's policy, so it
// never widens the table; null when none of it is (e.g. after the day ends).
export const unavailableInWindow = (policy, u) => {
  const w = windowOf(policy, u?.day);
  const [from, to, open, close] = [u?.start, u?.end, w.start, w.end].map(toMinutes);
  if ([from, to, open, close].includes(null)) return null;
  const start = Math.max(from, open);
  const end = Math.min(to, close);
  return end > start ? { start: fromMinutes(start), end: fromMinutes(end) } : null;
};

// The ancillary duty blocks, labelled as on the real forms ("RESEARCH", "EXTENSION SERVICES", …);
// the time range shows when the box has room for a second line (an hour or more). testIdOf(i) names
// each block ("tp-duty-0" on screen).
export const dutyBlocks = (duties, policy, { testIdOf = (i) => `tp-duty-${i}` } = {}) => (Array.isArray(duties) ? duties : []).map((duty, i) => {
  const minutes = toMinutes(duty.end) - toMinutes(duty.start);
  return {
    id: `duty-${i}`,
    day: duty.day,
    start: duty.start,
    end: duty.end,
    kind: 'duty',
    lines: dutyLines(duty, { withTime: minutes >= 2 * policy.slotMinutes }),
    testId: testIdOf(i),
    ariaLabel: `${duty.day} ${timeLabel(duty.start)} to ${timeLabel(duty.end)}: ${duty.label} (ancillary duty)`
  };
});

// The professor's unavailable times, in grey with their note (counted in no total), drawn only
// inside the day's window.
export const unavailableBlocks = (unavailable, policy, { testId = 'views-unavailable' } = {}) => (Array.isArray(unavailable) ? unavailable : []).flatMap((u, i) => {
  const shown = unavailableInWindow(policy, u);
  if (!shown) return [];
  return [{
    id: `unavailable-${i}`,
    day: u.day,
    start: shown.start,
    end: shown.end,
    kind: 'unavailable',
    lines: [{ text: 'Unavailable', bold: true, fit: 'nowrap' }, ...(u.note ? [{ text: u.note }] : [])],
    testId,
    ariaLabel: `${u.day} ${timeLabel(shown.start)} to ${timeLabel(shown.end)}: unavailable${u.note ? ` (${u.note})` : ''}`
  }];
});
