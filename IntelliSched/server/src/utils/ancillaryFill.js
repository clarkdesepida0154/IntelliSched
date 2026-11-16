// Ancillary duty blocks on the Teachers' Program, as the office fills them (Phase 8 Part 3, decision
// 1b, measured on the three SF-029 scans in docs/formats/). The office fills the free weekday time:
//   1. classes and On-The-Job Training first, as placed (they come in as `classes`);
//   2. the lunch break: the free hour nearest the middle of the policy's lunch window stays empty
//      (12:00–1:00 under the default window). When a class holds it, the free hour the lunch rule
//      kept stays empty instead (Faculty's Tuesday 11:00–12:00);
//   3. EXTENSION on one weekday with no class, the morning then the afternoon around the kept hour,
//      up to its hours. Friday first: on the office's forms, Friday is the Extension day of every
//      full-timer. Without a class-free weekday, Extension joins step 4;
//   4. the other duties, smallest first: ADMINISTRATIVE FUNCTION (the Management Function hours),
//      COMPETITIVE EDGE, CONSULTATION and RESEARCH, each as whole merged blocks in the free time,
//      a tight run first and the afternoon before the morning (Faculty's COMPETITIVE EDGE Tuesday
//      3–5, CONSULTATION Wednesday 1–3). The largest comes last and takes what is left, in the
//      week's order.
// When the hours don't all fit, the largest duty is shortened and the smaller ones are drawn in
// full (Faculty's form draws 7 of her 10 Research hours; Faculty's 11 of his 15 Administrative
// Function hours). The hours that did not fit are returned as `unplaced` for the record — the form
// prints no note (decision 1b) and the load summary still counts every hour.
// Part-timers have no duties: their free time stays empty (Faculty's form), whatever their profile
// stores. Deterministic: the same records always give the same fill; computed for a view or a
// print and never stored. Duty blocks never cover a class, an unavailable time or the kept hour.
const { toMinutes, fromMinutes } = require('./timeGrid');

// The labels printed on the real forms (the scans spell "COMPETETIVE"; that is a typo, not copied).
const ANCILLARY_LABELS = Object.freeze({
  MANAGEMENT_FUNCTION: 'ADMINISTRATIVE FUNCTION',
  RESEARCH: 'RESEARCH',
  EXTENSION: 'EXTENSION',
  CEE: 'COMPETITIVE EDGE',
  CONSULTATION: 'CONSULTATION'
});

// Smallest first; equal hours keep this order (the decision lists them this way).
const TIE_ORDER = ['MANAGEMENT_FUNCTION', 'CEE', 'CONSULTATION', 'RESEARCH', 'EXTENSION'];

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// The free hour the lunch rule keeps on one day, from the policy's lunch window and the day's drawn
// blocks (classes and On-The-Job Training; unavailable times never make time busy for the lunch
// rule, as in the validator's HC1): the free slot-grid window of lunch.minFreeMinutes nearest the
// middle of the lunch window, the earlier on a tie — 12:00–1:00 under the default window when it is
// free. null when the lunch rule is off or no hour is fully free (the schedule itself then breaks
// the lunch rule; the fill reserves nothing).
const reservedLunchHour = (drawn, policy) => {
  const lunch = policy.lunch || {};
  if (!lunch.enabled) return null;
  const slot = Number(policy.slotMinutes) || 30;
  const from = toMinutes(lunch.windowStart);
  const to = toMinutes(lunch.windowEnd);
  const need = Number(lunch.minFreeMinutes) || 60;
  if (from === null || to === null) return null;
  const mid = (from + to) / 2;
  let best = null;
  for (let start = Math.ceil(from / slot) * slot; start + need <= to; start += slot) {
    const hour = { start, end: start + need };
    if (drawn.some(b => overlaps(b, hour))) continue;
    const away = Math.abs((start + need / 2) - mid);
    if (!best || away < best.away) best = { ...hour, away };
  }
  return best ? { start: best.start, end: best.end } : null;
};

// The weekday Extension takes: a weekday with no class — the professor's SET Extension day first
// (Phase 8 Part 4, decision 4: the policy's extensionDay or the profile's override, passed in as
// `preferred`; the scheduler kept it class-free, so it is normally free here), then Friday (the
// office's Extension day), else the latest class-free weekday; null when every weekday has a
// class. `classes` are the drawn blocks ({ day, start, end }), On-The-Job Training included;
// unavailable times are not classes. The On-The-Job Training placement (utils/ojtPlacement.js)
// reads the same function, so the day it keeps free is the day the fill chooses.
const extensionDayOf = (classes, policy, preferred = null) => {
  const days = (policy.weekdays || []).filter(d => d !== 'Saturday');
  const busy = new Set((classes || []).map(b => b?.day));
  const free = days.filter(d => !busy.has(d));
  if (!free.length) return null;
  if (preferred && free.includes(preferred)) return preferred;
  return free.includes('Friday') ? 'Friday' : free[free.length - 1];
};

// ancillaryByType: { TYPE: hours } (utils/load.js ancillaryByTypeOf, so the hours are the load's own).
// classes: [{ day, start, end }] the professor's class and On-The-Job Training blocks ("HH:MM").
// unavailable: [{ day, start, end }] the profile's unavailable times.
// Part-timers have no ancillary loads (Phase 8 Part 3's guard, removed in Phase 11 and restored in
// Phase 11.2): a PART_TIME professor gets no blocks. A full-timer's blocks are filled and shown in the
// editor; the PRINTED Teachers' Program leaves every duty block out (exports/pageModels.js).
// extensionDay: the professor's set day for Extension (Phase 8 Part 4; null when none is set).
// Returns { blocks: [{ type, label, day, start, end, hours }], unplaced: [{ type, label, hours }] }.
const fillAncillary = ({ ancillaryByType = {}, classes = [], unavailable = [], policy, extensionDay = null, employmentType = null }) => {
  if (employmentType === 'PART_TIME') return { blocks: [], unplaced: [] };
  const slot = Number(policy.slotMinutes) || 30;
  const dayStart = toMinutes(policy.dayStart);
  const dayEnd = toMinutes(policy.dayEnd);
  const days = (policy.weekdays || []).filter(d => d !== 'Saturday');

  // Per day: what a duty block may not cover (classes, unavailable times, the kept lunch hour, other
  // duty blocks), and the drawn blocks the kept hour is computed from (classes only).
  const occupied = Object.fromEntries(days.map(d => [d, []]));
  const drawn = Object.fromEntries(days.map(d => [d, []]));
  const addTo = (targets, list) => (list || []).forEach(b => {
    const start = toMinutes(b?.start);
    const end = toMinutes(b?.end);
    if (occupied[b?.day] && start !== null && end !== null && end > start) targets.forEach(t => t[b.day].push({ start, end }));
  });
  addTo([occupied, drawn], classes);
  addTo([occupied], unavailable);
  const lunchByDay = Object.fromEntries(days.map(d => {
    const kept = reservedLunchHour(drawn[d], policy);
    if (kept) occupied[d].push(kept);
    return [d, kept];
  }));
  // The afternoon starts after the kept hour (1:00 under the defaults); without a lunch rule, at the
  // middle of the day window.
  const afternoonAt = (day) => (lunchByDay[day] ? lunchByDay[day].end : (dayStart + dayEnd) / 2);

  // The maximal free runs of one day, on the slot grid, in time order.
  const freeRuns = (day) => {
    const busy = [...occupied[day]].sort((a, b) => a.start - b.start || a.end - b.end);
    const runs = [];
    let cursor = dayStart;
    for (const b of busy) {
      if (b.start > cursor) runs.push({ start: cursor, end: Math.min(b.start, dayEnd) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= dayEnd) break;
    }
    if (cursor < dayEnd) runs.push({ start: cursor, end: dayEnd });
    return runs
      .map(r => ({ start: Math.ceil(r.start / slot) * slot, end: Math.floor(r.end / slot) * slot }))
      .filter(r => r.end > r.start);
  };

  const blocks = [];
  const place = (type, day, start, end) => {
    const block = { start, end };
    occupied[day].push(block);
    blocks.push({ type, label: ANCILLARY_LABELS[type], day, start: fromMinutes(start), end: fromMinutes(end), hours: (end - start) / 60 });
  };

  const minutesOf = (hours) => Math.max(0, Math.round(((Number(hours) || 0) * 60) / slot) * slot);
  const duties = TIE_ORDER
    .map(type => ({ type, minutes: minutesOf(ancillaryByType[type]) }))
    .filter(d => d.minutes > 0);

  // Step 3: Extension on its class-free weekday (the set day first), the morning then the
  // afternoon, up to its hours.
  const extension = duties.find(d => d.type === 'EXTENSION');
  const extensionOn = extension ? extensionDayOf(classes, policy, extensionDay) : null;
  if (extension && extensionOn) {
    for (const run of freeRuns(extensionOn)) {
      if (!extension.minutes) break;
      const take = Math.min(extension.minutes, run.end - run.start);
      place('EXTENSION', extensionOn, run.start, run.start + take);
      extension.minutes -= take;
    }
  }

  // Step 4: the others, smallest first (TIE_ORDER on equal hours), the largest last.
  const queue = duties.filter(d => d.minutes > 0)
    .sort((a, b) => a.minutes - b.minutes || TIE_ORDER.indexOf(a.type) - TIE_ORDER.indexOf(b.type));
  const unplaced = [];
  queue.forEach((duty, at) => {
    const last = at === queue.length - 1;
    let left = duty.minutes;
    while (left > 0) {
      const runs = days.flatMap(day => freeRuns(day).map(run => ({ day, ...run, length: run.end - run.start })));
      if (!runs.length) break;
      let pick;
      if (last) {
        // The largest takes what is left, in the week's order.
        pick = runs.sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day) || a.start - b.start)[0];
      } else {
        // A whole block in the tightest run that holds it, the afternoon before the morning, then the
        // week's order; when no run holds what is left, the largest run.
        const fits = runs.filter(r => r.length >= left);
        const pool = fits.length ? fits : runs;
        const slack = (r) => (fits.length ? r.length - left : -r.length);
        const morning = (r) => (r.start >= afternoonAt(r.day) ? 0 : 1);
        pick = pool.sort((a, b) => slack(a) - slack(b) || morning(a) - morning(b)
          || days.indexOf(a.day) - days.indexOf(b.day) || a.start - b.start)[0];
      }
      const take = Math.min(left, pick.length);
      place(duty.type, pick.day, pick.start, pick.start + take);
      left -= take;
    }
    if (left > 0) unplaced.push({ type: duty.type, label: ANCILLARY_LABELS[duty.type], hours: left / 60 });
  });

  blocks.sort((a, b) => (days.indexOf(a.day) - days.indexOf(b.day)) || (toMinutes(a.start) - toMinutes(b.start)));
  return { blocks, unplaced };
};

module.exports = { ANCILLARY_LABELS, fillAncillary, extensionDayOf, reservedLunchHour };
