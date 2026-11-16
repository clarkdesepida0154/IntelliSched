// Phase 9: the experts' checklist counts (F1-F5, S1-S6, R1-R3) for a schedule, computed from its class
// meetings alone. A small, separate helper: it does not call the gateway validator and shares no code
// with it (the mapping to the validator's HC codes is in docs/eval/GA_EVAL_REPORT.md). Pure.
//
// A meeting: { day, start, end ('HH:MM'), professor (key|null), partTime (bool), section, subject (key),
//   type ('LEC'|'LAB'|'OJT'|'NSTP'), room (key|null), roomType ('LAB'|'LEC'|null), weekGroup ('ODD'|'EVEN'|null), hours }
// Items (what each counts):
//   F1 pairs of the professor's meetings that overlap          S1 pairs of the section's meetings that overlap
//   F2 1 when the load is above the cap                         S2 subjects whose weekly hours differ from the curriculum
//   F3 teaching days with no free 30 minutes in 10:00-15:00     S3 days on which one subject has two or more meetings
//   F4 a part-timer's single-class days                         S4 lab meetings not starting at 08:00, 11:00 or 14:00
//   F5 meetings outside Mon-Fri 08:00-17:00                     S5 meetings outside the day window
//                                                               S6 days with no free 30 minutes in 10:00-15:00
//   R1 pairs of overlapping meetings of one week group         R2 lab meetings in a room that is not a lab
//   R3 meetings outside the day window
// "Pair": two meetings that overlap count 1; three at once count 3 (every two of them).
// Week groups: only R1 separates them (a room may hold an odd-week and an even-week class at one time);
// a professor or a section is never in two places at once, so F1 and S1 ignore the group.
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DAY_START = 8 * 60;
const DAY_END = 17 * 60;
const FREE_FROM = 10 * 60;
const FREE_TO = 15 * 60;
const LAB_STARTS = new Set([8 * 60, 11 * 60, 14 * 60]);
const NSTP_END = 12 * 60;
const round2 = (n) => Math.round(n * 100) / 100;

const minutes = (t) => {
  if (typeof t === 'number') return t;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const norm = (m) => ({ ...m, s: minutes(m.start), e: minutes(m.end) });
const overlaps = (a, b) => a.day === b.day && a.s < b.e && b.s < a.e;
const groupBy = (list, keyOf) => {
  const map = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
};

const pairs = (list, sameGroupOnly = false) => {
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (!overlaps(list[i], list[j])) continue;
      if (sameGroupOnly) {
        const a = list[i].weekGroup; const b = list[j].weekGroup;
        if (a && b && a !== b) continue;
      }
      n++;
    }
  }
  return n;
};

// Days (of those with a meeting) in which the meetings cover every 30-minute slot of 10:00-15:00.
const daysWithoutFreeHalfHour = (list) => {
  let n = 0;
  for (const [, day] of groupBy(list, m => m.day)) {
    let free = false;
    for (let t = FREE_FROM; t < FREE_TO; t += 30) {
      if (!day.some(m => m.s < t + 30 && t < m.e)) { free = true; break; }
    }
    if (!free) n++;
  }
  return n;
};

// Outside Mon-Fri 08:00-17:00; NSTP may sit on Saturday 08:00-12:00.
const outsideWindow = (m) => {
  if (m.type === 'NSTP' && m.day === 'Saturday') return m.s < DAY_START || m.e > NSTP_END;
  return !WEEKDAYS.includes(m.day) || m.s < DAY_START || m.e > DAY_END;
};

// ---- faculty
// ojtHours: what one practicum coordination counts (6). cap: (professorKey, partTime) -> hours.
const facultyCounts = (meetings, { ojtHours = 6, labFactorPartTime = 0.75, capOf = (key, pt) => (pt ? 40 : 21) } = {}) => {
  const rows = [];
  for (const [prof, mine] of groupBy(meetings, m => m.professor)) {
    const partTime = mine.some(m => m.partTime);
    const factor = partTime ? labFactorPartTime : 1;
    const ojt = new Set(mine.filter(m => m.type === 'OJT').map(m => m.section));
    const load = round2(mine.filter(m => m.type !== 'OJT').reduce((sum, m) => sum + (m.type === 'LAB' ? m.hours * factor : m.hours), 0) + ojt.size * ojtHours);
    const classes = mine.filter(m => m.type !== 'OJT');
    const singleDays = partTime ? [...groupBy(classes.filter(m => WEEKDAYS.includes(m.day)), m => m.day)].filter(([, d]) => d.length === 1).length : 0;
    rows.push({
      professor: prof, partTime, load,
      F1: pairs(mine), F2: load > capOf(prof, partTime) ? 1 : 0, F3: daysWithoutFreeHalfHour(mine), F4: singleDays,
      F5: mine.filter(outsideWindow).length
    });
  }
  return rows;
};

// ---- sections
// curriculum: Map(section -> Map(subject -> weekly hours)); a subject absent from the map is not checked.
const sectionCounts = (meetings, { curriculum = new Map() } = {}) => {
  const rows = [];
  const sections = new Set([...groupBy(meetings, m => m.section).keys(), ...curriculum.keys()]);
  for (const section of sections) {
    const mine = meetings.filter(m => m.section === section);
    const placed = mine.filter(m => m.type !== 'OJT');
    let S2 = 0;
    for (const [subject, expected] of curriculum.get(section) || []) {
      const got = round2(placed.filter(m => m.subject === subject).reduce((sum, m) => sum + m.hours, 0));
      if (got !== round2(expected)) S2++;
    }
    let S3 = 0;
    for (const [, bySubject] of groupBy(placed, m => m.subject)) {
      S3 += [...groupBy(bySubject, m => m.day)].filter(([, d]) => d.length > 1).length;
    }
    rows.push({
      section,
      S1: pairs(mine), S2, S3,
      S4: mine.filter(m => m.type === 'LAB' && !LAB_STARTS.has(m.s)).length,
      S5: mine.filter(outsideWindow).length,
      S6: daysWithoutFreeHalfHour(mine)
    });
  }
  return rows;
};

// ---- rooms
const roomCounts = (meetings) => {
  const rows = [];
  for (const [room, mine] of groupBy(meetings.filter(m => m.room), m => m.room)) {
    rows.push({
      room,
      R1: pairs(mine, true),
      R2: mine.filter(m => m.type === 'LAB' && m.roomType !== 'LAB').length,
      R3: mine.filter(outsideWindow).length
    });
  }
  return rows;
};

const countAll = (rawMeetings, options = {}) => {
  const meetings = rawMeetings.map(norm);
  return {
    faculty: facultyCounts(meetings, options),
    sections: sectionCounts(meetings, options),
    rooms: roomCounts(meetings)
  };
};

// ---- Phase 10: one row per teacher, section and room in the columns of schedule_units.csv
// (scripts/eval/analyze_phase10.py). The same rules for the manual schedule and every IntelliSched run:
//   Conflicts         pairs of overlapping meetings: a teacher's own, a section's own, a room's in the same
//                     week group (an all-weeks meeting meets both groups)
//   Overload          teachers: 1 when the load (lecture + lab x 0.75 for part-timers, OJT 6 h per section)
//                     is above the cap (21 h full-time, 40 h part-time), else 0
//   Missing hours     sections: subjects whose weekly hours differ from the curriculum (S2)
//   Rule breaks       meetings outside Mon-Fri 08:00-17:00 (NSTP: Sat 08:00-12:00) + labs not starting at
//                     8, 11 or 2 + days with one subject twice + days with no free 30 minutes in 10:00-15:00
//                     + (teachers) a part-timer's single-class days; rooms: the meeting-level ones (outside
//                     the window, lab start) + lab meetings in a room that is not a lab. A teacher's "subject
//                     twice" is per section (two sections of one subject on a day is normal).
//   Idle gap hours    teachers and sections: per day, last end - first start - time in class - 1 h lunch,
//                     never below 0, summed over the week
//   Days used         teachers and sections: days with at least one meeting
//   Single-class days teachers and sections: days with exactly one meeting
//   Used hours        rooms: meeting hours per week, odd/even-week meetings count half
const LUNCH_MIN = 60;
const inClassMinutes = (list) => {
  const iv = list.map(m => [m.s, m.e]).sort((a, b) => a[0] - b[0]);
  let total = 0; let cs = null; let ce = null;
  for (const [s, e] of iv) {
    if (cs === null || s > ce) { if (cs !== null) total += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e);
  }
  return cs === null ? 0 : total + (ce - cs);
};
const dayStats = (list) => {
  let idle = 0; let used = 0; let single = 0;
  for (const [, day] of groupBy(list, m => m.day)) {
    used++;
    if (day.length === 1) single++;
    const span = Math.max(...day.map(m => m.e)) - Math.min(...day.map(m => m.s));
    idle += Math.max(0, span - inClassMinutes(day) - LUNCH_MIN);
  }
  return { idle: round2(idle / 60), used, single };
};
const subjectTwiceDays = (list, keyOf) => {
  let n = 0;
  for (const [, bySubject] of groupBy(list.filter(m => m.type !== 'OJT'), keyOf)) n += [...groupBy(bySubject, m => m.day)].filter(([, d]) => d.length > 1).length;
  return n;
};
const labStartBreaks = (list) => list.filter(m => m.type === 'LAB' && !LAB_STARTS.has(m.s)).length;

const scheduleUnits = (rawMeetings, options = {}) => {
  const meetings = rawMeetings.map(norm);
  const fac = new Map(facultyCounts(meetings, options).map(r => [r.professor, r]));
  const sec = new Map(sectionCounts(meetings, options).map(r => [r.section, r]));
  const rows = [];
  for (const [prof, mine] of groupBy(meetings, m => m.professor)) {
    const f = fac.get(prof); const d = dayStats(mine);
    rows.push({ view: 'Faculty', unit: prof, conflicts: f.F1, overload: f.F2, missingHours: null,
      ruleBreaks: f.F5 + labStartBreaks(mine) + subjectTwiceDays(mine, m => `${m.section}|${m.subject}`) + f.F3 + f.F4,
      idleGapHours: d.idle, daysUsed: d.used, singleClassDays: d.single, usedHours: null, load: f.load, partTime: f.partTime });
  }
  for (const [section, s] of sec) {
    const mine = meetings.filter(m => m.section === section); const d = dayStats(mine);
    rows.push({ view: 'Section', unit: section, conflicts: s.S1, overload: null, missingHours: s.S2,
      ruleBreaks: s.S5 + s.S4 + s.S3 + s.S6, idleGapHours: d.idle, daysUsed: d.used, singleClassDays: d.single, usedHours: null });
  }
  for (const r of roomCounts(meetings)) {
    const mine = meetings.filter(m => m.room === r.room);
    rows.push({ view: 'Room', unit: r.room, conflicts: r.R1, overload: null, missingHours: null,
      ruleBreaks: r.R3 + labStartBreaks(mine) + r.R2, idleGapHours: null, daysUsed: null, singleClassDays: null,
      usedHours: round2(mine.reduce((sum, m) => sum + m.hours * (m.weekGroup === 'ODD' || m.weekGroup === 'EVEN' ? 0.5 : 1), 0)) });
  }
  return rows;
};
const UNIT_COLUMNS = ['View', 'Unit', 'Source', 'Run', 'Conflicts', 'Overload', 'Missing hours', 'Rule breaks', 'Idle gap hours', 'Days used', 'Single-class days', 'Used hours'];
const unitCells = (r, source, run) => [r.view, r.unit, source, run, r.conflicts, r.overload, r.missingHours, r.ruleBreaks, r.idleGapHours, r.daysUsed, r.singleClassDays, r.usedHours].map(v => (v === null || v === undefined ? '' : v));

module.exports = { countAll, facultyCounts, sectionCounts, roomCounts, pairs, daysWithoutFreeHalfHour, outsideWindow, scheduleUnits, UNIT_COLUMNS, unitCells };
