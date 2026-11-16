// The pre-flight check (Phase 1 Step 8). Before any GA run it says, in words a Dean can act on,
// whether a conflict-free schedule is possible at all:
//   1. data completeness        section tracks, professors in locks, room types (+ warnings, info)
//   2. room supply vs demand    LAB in whole lab blocks at the allowed start times; LEC in hours.
//                               CCS and borrowed rooms, plus the extra rooms when the policy's
//                               "Use extra rooms when CCS rooms are full" is on (Phase 2). When the
//                               CCS rooms alone are short, the smallest extra-room counts are worked
//                               out, on weekdays only and also using Saturday (extraRooms.suggestion).
//   3. each section's week      weekly class hours against the allowed days x window minus lunch
//   4. each professor's week    contact hours against the window minus unavailable times and lunch
//   5. windows                  every meeting fits its day's window (full-length labs at a lab start)
// It builds the demands with the same demand builder as the generate path, so both count the same
// meetings. Pure: the caller loads the data. Returns { ok, verdict, errors, warnings, info, checks,
// numbers, extraRooms, policySaved, dataLine, readiness }; verdict is 'ready', 'needs-extra-rooms'
// (only rooms are short, and extra rooms would fix it) or 'blocked'.
//
// Phase 3 Step 4 (the Readiness Check): `readiness` is the Dean's view of the same report, built here so
// no page computes anything a second time: { verdict: 'ready' | 'not-ready', toFix, lines }, seven lines
// in a fixed order (subjects, sections, professors, rooms, faculty, week, policy), each { id, n,
// status: pass | warn | fail, text, detail?, options?, fix? }. Every error belongs to one fail line, so
// the term is 'ready' exactly when `ok`. A Major class without a professor (MAJOR_TBA) is an error now:
// it blocks generation. The TBA rooms (overflowRooms.mode) are resolved before the check, in
// loadTermInputs (resolveTbaRooms below); a room shortage the TBA rooms cover is a warning.
//
// Phase 3 Step 7 (online lectures, SubjectCatalog.lectureMode): the rooms count only on-campus meetings
// (a Major lecture held online has no room types); each section's and professor's week still counts the
// scheduled online lectures (they keep a day and a time); self-paced lectures are no meetings at all.
// While the CCS rooms are short, extraRooms.online says about how many lecture hours held online would
// make the lectures fit, and which Major subjects would cover it (onlineOption); the rooms line offers it.
const { buildGaRequest, extraRoomsOf } = require('./gaRequest');
const { MAX_EXTRA_ROOMS, TBA_ROOM_MODES } = require('./policy');
const { windowSlots, allowedDaysForSection, slotOfTime, toMinutes } = require('./timeGrid');
const { resolveSubjectType, toProgramCode, BSIT_TRACKS, findLockFor } = require('./curriculumMatcher');
const { buildFacultyResolver, TBA_POOL_FACULTY_ID, assignmentCounts, unassignedMajorPairs, termLoads } = require('./termAssignments');
// Phase 8 Part 4 (decision 4): the professor's free time counts the Extension day as unavailable.
const { schedulingUnavailableBlocks } = require('./facultyAvailability');

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
// A Major's description shorter than this is flagged (the ranking matches professors on it).
const MIN_DESCRIPTION_WORDS = 10;
// Natural order for codes ("ITEC 2" before "ITEC 10").
const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });

// Hours with at most one decimal ("27.5", "45").
const h = (hours) => String(Math.round(hours * 10) / 10);
const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
const hoursWord = (hours) => (Number.isInteger(hours) && hours < NUMBER_WORDS.length ? NUMBER_WORDS[hours] : h(hours));
const dayRangeLabel = (days) => (days.length > 2 ? `${days[0].slice(0, 3)}–${days.at(-1).slice(0, 3)}` : days.map(d => d.slice(0, 3)).join(' and '));
const yearsLabel = (years) => (years || []).map(y => ORDINAL[y] || `${y}th`).join('/');
// "2nd and 3rd years", "2nd, 3rd and 4th years".
const yearsWords = (years) => {
  const names = (years || []).map(y => ORDINAL[y] || `${y}th`);
  return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('')} years`;
};
// "3 lab and 3 lecture rooms", "3 lab rooms", "1 lecture room".
const tbaRoomsWords = (lab, lec) => {
  const parts = [lab > 0 ? `${lab} lab` : null, lec > 0 ? `${lec} lecture` : null].filter(Boolean);
  return `${parts.join(' and ')} ${lab + lec === 1 ? 'room' : 'rooms'}`;
};
// Saturday counts for the Saturday years while Saturday overflow is on (and Saturday is not a weekday).
const saturdayOnOf = (policy) => Boolean(policy.saturdayOverflow?.enabled) && !(policy.weekdays || []).includes('Saturday');

// The track a section must carry (CLAUDE.md); null = any of the BSIT specialization tracks.
const trackProblem = (section) => {
  const year = Number(section.yearLevel);
  const program = toProgramCode(section.program);
  if (program === 'BSCS') return section.track === 'IS' ? null : `BSCS sections are on the IS track (it has ${section.track || 'none'}).`;
  if (program !== 'BSIT') return `The program must be BSIT or BSCS (it is ${section.program || 'missing'}).`;
  if (year === 1 || year === 2) return section.track === 'NONE' ? null : `1st and 2nd year BSIT sections have no track (it has ${section.track}).`;
  if (year === 3 || year === 4) return BSIT_TRACKS.includes(section.track) ? null : `3rd and 4th year BSIT sections need WMAD, SMP or AMG (it has ${section.track || 'none'}).`;
  return `The year level must be 1 to 4 (it is ${section.yearLevel}).`;
};

// A room's usable intervals on a day, in slots: the policy window, cut to the room's availability
// windows when it has any (rooms borrowed from other departments).
const roomIntervals = (policy, room, day) => {
  const w = windowSlots(policy, day);
  if (!w) return [];
  const avail = room.availability || [];
  if (!avail.length) return [[w.startSlot, w.endSlot]];
  return avail
    .filter(a => a.day === day)
    .map(a => [Math.max(w.startSlot, slotOfTime(policy, a.start)), Math.min(w.endSlot, slotOfTime(policy, a.end))])
    .filter(([s, e]) => e > s);
};
// Whole lab blocks one room holds on a day: allowed starts that fit, taken without overlap.
const labBlocksOn = (policy, room, day, starts, length) => {
  const intervals = roomIntervals(policy, room, day);
  let count = 0;
  let freeFrom = -Infinity;
  for (const s of starts) {
    if (s < freeFrom) continue;
    if (intervals.some(([a, b]) => a <= s && s + length <= b)) { count += 1; freeFrom = s + length; }
  }
  return count;
};
const hoursOn = (policy, room, day) => roomIntervals(policy, room, day).reduce((sum, [s, e]) => sum + (e - s), 0) * policy.slotMinutes / 60;

// A day's usable slot intervals: the policy window minus the given blocks (a professor's
// unavailable times; none for a section).
const usableIntervals = (policy, day, blocks = []) => {
  const w = windowSlots(policy, day);
  if (!w) return [];
  const busy = blocks
    .filter(b => b.day === day && toMinutes(b.start) !== null && toMinutes(b.end) !== null)
    .map(b => [slotOfTime(policy, b.start), slotOfTime(policy, b.end)])
    .sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = w.startSlot;
  for (const [start, end] of busy) {
    if (start > cursor) free.push([cursor, Math.min(start, w.endSlot)]);
    cursor = Math.max(cursor, end);
    if (cursor >= w.endSlot) break;
  }
  if (cursor < w.endSlot) free.push([cursor, w.endSlot]);
  return free.filter(([a, b]) => b > a);
};
const slotsIn = (intervals, from, to) => intervals.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
// Hours a day can hold while the lunch rule still holds. The rule needs one continuous free run of
// minFreeMinutes inside the lunch window, and only classes make time busy (the validator's HC1), so
// time that is already unusable (unavailable, or outside the day's window) can be the lunch. The
// cost is the fewest usable slots any such run takes: 0 when one already lies in unusable time.
const usableHoursWithLunch = (policy, intervals) => {
  const total = slotsIn(intervals, -Infinity, Infinity);
  let cost = 0;
  if (policy.lunch?.enabled) {
    const start = slotOfTime(policy, policy.lunch.windowStart);
    const end = slotOfTime(policy, policy.lunch.windowEnd);
    const need = Math.ceil(policy.lunch.minFreeMinutes / policy.slotMinutes);
    cost = need;
    for (let r = start; r + need <= end; r += 1) cost = Math.min(cost, slotsIn(intervals, r, r + need));
  }
  return Math.max(0, total - cost) * policy.slotMinutes / 60;
};

// LAB and LEC room supply against the demands, for one set of rooms ({ roomName, type, availability }).
// saturdayOn: Saturday counts for the demands allowed there (the overflow years). Labs are whole blocks
// at the lab start times; lecture rooms are hours, and LAB time left over after the labs may hold Major
// lectures (unless majorLectureInLab is NEVER).
const rawRoomSupply = ({ policy, demands, labRooms, lecRooms, saturdayOn }) => {
  const slotHours = policy.slotMinutes / 60;
  const weekdays = policy.weekdays || [];
  const labLength = Math.round(policy.meetings.labMaxMeetingHours * 60 / policy.slotMinutes);
  const labStarts = policy.meetings.labStartTimes.map(t => slotOfTime(policy, t)).sort((a, b) => a - b);
  const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
  const satEligible = (d) => !d.fixed && (d.allowedDays || []).includes('Saturday') && !weekdays.includes('Saturday');
  const hoursOf = (d) => d.durationSlots * slotHours;

  const weekdayLabBlocks = sum(labRooms, r => sum(weekdays, day => labBlocksOn(policy, r, day, labStarts, labLength)));
  const saturdayLabBlocks = saturdayOn ? sum(labRooms, r => labBlocksOn(policy, r, 'Saturday', labStarts, labLength)) : 0;
  const weekdayLabHours = sum(labRooms, r => sum(weekdays, day => hoursOn(policy, r, day)));
  const saturdayLabHours = saturdayOn ? sum(labRooms, r => hoursOn(policy, r, 'Saturday')) : 0;
  const weekdayLecHours = sum(lecRooms, r => sum(weekdays, day => hoursOn(policy, r, day)));
  const saturdayLecHours = saturdayOn ? sum(lecRooms, r => hoursOn(policy, r, 'Saturday')) : 0;

  const fullLabs = demands.filter(d => d.classType === 'LAB' && d.allowedStarts);
  const shortLabs = demands.filter(d => d.classType === 'LAB' && !d.allowedStarts);
  const shortLabHours = sum(shortLabs, hoursOf);
  // Only the shorter lab meetings of the Saturday years may use Saturday LAB time.
  const shortSatHours = sum(shortLabs.filter(satEligible), hoursOf);
  const labsNeeded = fullLabs.length;
  const saturdayLabsUsable = Math.min(saturdayLabBlocks, fullLabs.filter(satEligible).length);
  const labsFit = Math.min(labsNeeded, weekdayLabBlocks + saturdayLabsUsable);
  const labShort = labsNeeded - labsFit;
  const labsOnWeekdays = Math.min(labsNeeded, weekdayLabBlocks);
  const labsOnSaturday = labsFit - labsOnWeekdays;
  const labHoursEach = policy.meetings.labMaxMeetingHours;
  // LAB blocks one room holds in a week (for "about N more rooms").
  const perLabRoom = labRooms.length ? (weekdayLabBlocks + saturdayLabBlocks) / labRooms.length : weekdays.length * labStarts.length;

  // Lab time left after the labs, weekdays and Saturday apart. Shorter lab meetings take it first
  // (weekdays, then Saturday); the rest may hold Major lectures (unless majorLectureInLab is NEVER).
  const labLeftoverWeekday = Math.max(0, weekdayLabHours - labsOnWeekdays * labHoursEach);
  const labLeftoverSaturday = Math.max(0, saturdayLabHours - labsOnSaturday * labHoursEach);
  const labLeftover = labLeftoverWeekday + labLeftoverSaturday;
  const shortOnWeekdays = Math.min(shortLabHours, labLeftoverWeekday);
  const shortOnSaturday = Math.min(labLeftoverSaturday, shortSatHours, shortLabHours - shortOnWeekdays);
  // Short when the weekdays and the Saturday time cannot hold them all, or when the weekday time
  // alone cannot hold the ones that may not go on Saturday.
  const labHoursShort = Math.max(0, shortLabHours - shortOnWeekdays - shortOnSaturday, (shortLabHours - shortSatHours) - labLeftoverWeekday);
  const weekdayLabForMajors = labLeftoverWeekday - shortOnWeekdays;
  const saturdayLabForMajors = labLeftoverSaturday - shortOnSaturday;

  // Only on-campus meetings need a room: a Major lecture held online (Phase 3 Step 7) has no room types.
  const majorLec = demands.filter(d => d.classType === 'LEC' && !d.isMinor && d.allowedRoomTypes.length > 0);
  const minorLec = demands.filter(d => d.classType === 'LEC' && d.isMinor && d.allowedRoomTypes.includes('LEC'));
  const majorHours = sum(majorLec, hoursOf);
  const minorHours = sum(minorLec, hoursOf);
  const lecNeeded = majorHours + minorHours;
  // Saturday serves only the lectures that may go there, counted once across its LEC rooms and its
  // leftover LAB time (which takes Major lectures first, so the LEC rooms keep room for Minors).
  const saturdayMajor = sum(majorLec.filter(satEligible), hoursOf);
  const saturdayMinor = sum(minorLec.filter(satEligible), hoursOf);
  const labAllowed = policy.rooms.majorLectureInLab !== 'NEVER';
  const majorOnSaturdayLab = labAllowed ? Math.min(saturdayLabForMajors, saturdayMajor) : 0;
  const saturdayLecUsable = Math.min(saturdayLecHours, saturdayMajor + saturdayMinor - majorOnSaturdayLab);
  const labForMajors = labAllowed ? Math.min(weekdayLabForMajors + majorOnSaturdayLab, majorHours) : 0;
  const lecAvailable = weekdayLecHours + saturdayLecUsable + labForMajors;
  const lecShort = Math.max(0, lecNeeded - lecAvailable, minorHours - (weekdayLecHours + Math.min(saturdayLecHours, saturdayMinor)));
  const perLecRoom = lecRooms.length ? weekdayLecHours / lecRooms.length : sum(weekdays, day => { const w = windowSlots(policy, day); return w ? (w.endSlot - w.startSlot) * slotHours : 0; });

  return {
    labsNeeded, weekdayLabBlocks, saturdayLabsUsable, labsFit, labShort, perLabRoom, labHoursEach, labStartsPerDay: labStarts.length,
    shortLabHours, labLeftover, labHoursShort,
    majorHours, minorHours, lecNeeded, weekdayLecHours, saturdayLecUsable, labForMajors, lecAvailable, lecShort, perLecRoom
  };
};

// Phase 8 (odd and even weeks). While the policy's switch is on, each room's slots count once PER WEEK
// GROUP: a room hour holds one odd-week class and one even-week class, so the odd group's classes are
// checked against the full rooms, and the even group's too. A class without a group meets every week,
// so it is in both checks. The supply is then the per-group arithmetic combined:
//   - fit: each group fits (a shortage of 0 in both);
//   - the demand counts (labsNeeded, hours needed) count each class once (odd + even − both-weeks);
//   - the shortage counts are the groups' sums, with a both-weeks class's shortage counted once;
//   - the capacity numbers (blocks and hours a week) are the groups' sums (once per group, B5's rule).
// With the switch off, the supply is the plain arithmetic (rawRoomSupply).
const roomSupply = (args) => {
  const { policy, demands } = args;
  if (!policy.weekGroups?.enabled) return rawRoomSupply(args);
  const always = demands.filter(d => !d.weekGroup);
  const groupOf = (weeks) => rawRoomSupply({ ...args, demands: [...demands.filter(d => d.weekGroup === weeks), ...always] });
  const odd = groupOf('ODD');
  const even = groupOf('EVEN');
  const base = rawRoomSupply({ ...args, demands: always });
  const once = (field) => odd[field] + even[field] - base[field];
  const sum = (field) => odd[field] + even[field];
  const short = (field) => Math.max(0, odd[field] + even[field] - base[field]);
  const labsNeeded = once('labsNeeded');
  const labShort = short('labShort');
  return {
    labsNeeded,
    weekdayLabBlocks: sum('weekdayLabBlocks'),
    saturdayLabsUsable: once('saturdayLabsUsable'),
    labsFit: Math.max(0, labsNeeded - labShort),
    labShort,
    perLabRoom: sum('perLabRoom'),
    labHoursEach: odd.labHoursEach,
    labStartsPerDay: odd.labStartsPerDay,
    shortLabHours: once('shortLabHours'),
    labLeftover: sum('labLeftover'),
    labHoursShort: short('labHoursShort'),
    majorHours: once('majorHours'),
    minorHours: once('minorHours'),
    lecNeeded: once('lecNeeded'),
    weekdayLecHours: sum('weekdayLecHours'),
    saturdayLecUsable: sum('saturdayLecUsable'),
    labForMajors: sum('labForMajors'),
    lecAvailable: sum('lecAvailable'),
    lecShort: short('lecShort'),
    perLecRoom: sum('perLecRoom'),
    // The per-group view, for the Readiness Check's "How we know" (absent with the switch off):
    // what each week group's check counted, and the capacity ONE group has (the full rooms).
    weekGroups: {
      ODD: { labsNeeded: odd.labsNeeded, labShort: odd.labShort, lecNeeded: odd.lecNeeded, lecShort: odd.lecShort },
      EVEN: { labsNeeded: even.labsNeeded, labShort: even.labShort, lecNeeded: even.lecNeeded, lecShort: even.lecShort },
      perGroup: {
        weekdayLabBlocks: odd.weekdayLabBlocks,
        saturdayLabsUsable: Math.max(odd.saturdayLabsUsable, even.saturdayLabsUsable),
        weekdayLecHours: odd.weekdayLecHours,
        saturdayLecUsable: Math.max(odd.saturdayLecUsable, even.saturdayLecUsable)
      }
    }
  };
};

// Virtual rooms for the suggestion (the same shape as a facility; no availability windows).
const virtualRooms = (type, count) => Array.from({ length: count }, (_, i) => ({ roomName: `Extra ${type} room ${i + 1}`, type, availability: [] }));

// The smallest extra-room counts that make the supply arithmetic fit, in this order so the answer is
// unique: first the fewest extra LAB rooms that fit all labs, then, with those LAB rooms counted (their
// free hours can take Major lectures), the fewest extra LEC rooms that fit the lectures needing a room.
// null when even MAX_EXTRA_ROOMS of a type are not enough.
const smallestExtraRooms = ({ policy, demands, labRooms, lecRooms, saturdayOn }) => {
  let lab = 0;
  const labFits = (n) => {
    const s = roomSupply({ policy, demands, labRooms: [...labRooms, ...virtualRooms('LAB', n)], lecRooms, saturdayOn });
    return s.labShort === 0 && s.labHoursShort === 0;
  };
  while (lab <= MAX_EXTRA_ROOMS && !labFits(lab)) lab += 1;
  if (lab > MAX_EXTRA_ROOMS) return null;
  let lec = 0;
  const lecFits = (n) => roomSupply({ policy, demands, labRooms: [...labRooms, ...virtualRooms('LAB', lab)], lecRooms: [...lecRooms, ...virtualRooms('LEC', n)], saturdayOn }).lecShort === 0;
  while (lec <= MAX_EXTRA_ROOMS && !lecFits(lec)) lec += 1;
  return lec > MAX_EXTRA_ROOMS ? null : { lab, lec };
};

const SUGGESTION_NOTE = 'These are arithmetic minimums: the schedule may need one more room of a type, because a class cannot be split across rooms and every section and professor also needs its lunch hour.';

// Phase 3 Step 7: the third option when the CCS rooms are short, holding Major lectures online
// (scheduled: a day and a time, no room). Counted on weekdays, with the TBA lab rooms the labs need
// (labs always stay on campus): about how many lecture hours held online leave no lecture short of a
// room, and the Major subjects whose lectures cover it, largest first (a subject's lecture hours that
// need a room now, in all its sections). Holding them online leaves the weekday suggestion at
// { lab, lec: 0 } (weekdaysAfter). null when the CCS rooms hold every class, when no lecture is short
// once the labs have their rooms (online lectures would not change the TBA rooms), or when Major
// lectures online cannot cover it (the GenEd lectures alone are short). `subjects` maps a subject id
// to its catalog record, for the titles.
//   { hours, coveredHours, weekdaysAfter: { lab, lec }, subjects: [{ subjectId, subjectCode,
//     subjectTitle, lectureHours, sections }], fix: { page } }
const onlineOption = ({ policy, demands, ccsLab, ccsLec, suggestion, subjects = new Map() }) => {
  if (!suggestion) return null;
  const supplyWith = (list, lab) => roomSupply({ policy, demands: list, labRooms: [...ccsLab, ...virtualRooms('LAB', lab)], lecRooms: ccsLec, saturdayOn: false });
  // The weekday suggestion's TBA lab rooms (the fewest that fit the labs), also when no weekday count
  // fits the lectures.
  let lab = suggestion.weekdays ? suggestion.weekdays.lab : 0;
  if (!suggestion.weekdays) {
    const labsFit = (n) => { const s = supplyWith(demands, n); return s.labShort === 0 && s.labHoursShort === 0; };
    while (lab <= MAX_EXTRA_ROOMS && !labsFit(lab)) lab += 1;
    if (lab > MAX_EXTRA_ROOMS) return null;
  }
  const short = supplyWith(demands, lab).lecShort;
  if (!(short > 1e-9)) return null;
  const hoursOf = (d) => d.durationSlots * policy.slotMinutes / 60;
  const bySubject = new Map();
  for (const d of demands) {
    if (d.classType !== 'LEC' || d.isMinor || d.fixed || !d.allowedRoomTypes.length) continue;
    if (!bySubject.has(d.subjectId)) {
      bySubject.set(d.subjectId, { subjectId: d.subjectId, subjectCode: d.subjectCode, subjectTitle: subjects.get(d.subjectId)?.descriptiveTitle || '', lectureHours: 0, sectionIds: new Set() });
    }
    const entry = bySubject.get(d.subjectId);
    entry.lectureHours += hoursOf(d);
    entry.sectionIds.add(d.sectionId);
  }
  const candidates = [...bySubject.values()].sort((a, b) => b.lectureHours - a.lectureHours || byText(a.subjectCode, b.subjectCode) || byText(a.subjectTitle, b.subjectTitle) || byText(a.subjectId, b.subjectId));
  const chosen = [];
  const online = new Set();
  for (const c of candidates) {
    chosen.push(c);
    online.add(c.subjectId);
    const left = demands.filter(d => !(d.classType === 'LEC' && online.has(d.subjectId)));
    if (supplyWith(left, lab).lecShort === 0) {
      return {
        hours: short,
        coveredHours: chosen.reduce((sum, s) => sum + s.lectureHours, 0),
        weekdaysAfter: { lab, lec: 0 },
        subjects: chosen.map(({ sectionIds, ...s }) => ({ ...s, sections: sectionIds.size })),
        fix: { page: 'subjects' }
      };
    }
  }
  return null;
};

// The Readiness option for it: "Or hold about 46 lecture hours online (e.g. ITEC 102, CMSC 201, …) – set
// the Lecture mode in the Master Catalog" (each code once; "…" when more subjects follow).
const onlineOptionText = (online) => {
  const codes = [...new Set(online.subjects.map(s => s.subjectCode))];
  const shown = codes.slice(0, 3).join(', ');
  return `Or hold about ${h(Math.ceil(online.hours - 1e-9))} lecture hours online (e.g. ${shown}${codes.length > 3 ? ', …' : ''}) – set the Lecture mode in the Master Catalog`;
};

// The CCS (and borrowed) rooms alone against the demands, and when they are short the smallest TBA-room
// counts that make the arithmetic fit: { supply, short, suggestion }, where suggestion is null when the
// CCS rooms hold every class, otherwise { weekdays: { lab, lec } | null, withSaturday: { lab, lec } |
// null, note }. The one computation behind the report's extraRooms.suggestion and the automatic counts.
const ccsRoomSuggestion = ({ policy, demands, ccsLab, ccsLec, saturdayOn }) => {
  const supply = roomSupply({ policy, demands, labRooms: ccsLab, lecRooms: ccsLec, saturdayOn });
  const short = supply.labShort > 0 || supply.labHoursShort > 0 || supply.lecShort > 0;
  const suggestion = short ? {
    weekdays: smallestExtraRooms({ policy, demands, labRooms: ccsLab, lecRooms: ccsLec, saturdayOn: false }),
    withSaturday: saturdayOn ? smallestExtraRooms({ policy, demands, labRooms: ccsLab, lecRooms: ccsLec, saturdayOn: true }) : null,
    note: SUGGESTION_NOTE
  } : null;
  return { supply, short, suggestion };
};

// The rooms the pre-flight counts: the active rooms, and those with a room type for the supply.
const activeRooms = (facilities) => facilities.filter(r => r.isActive !== false);
const typedRooms = (rooms) => rooms.filter(r => ['LEC', 'LAB'].includes(r.type));

// Phase 8 Part 5 (decision 2a): how full each room type would be in the policy's WEEKDAY hours, the
// way the rooms arithmetic counts — labs as whole blocks against the lab rooms' blocks AND as hours
// (with the shorter lab meetings and the Major lecture hours the LEC rooms cannot hold, when
// lectures in lab rooms are allowed) against the lab rooms' hours; lectures as hours against the
// LEC rooms' hours. With the odd/even week groups on, each group is measured against the full rooms
// (a room hour holds one class of each group) and the fuller group counts. Returns
// { lab: { percent, needHours, haveHours }, lec: { ... }, total: { percent, needHours, haveHours },
//   groups: { ODD: {...}, EVEN: {...} } | null } (percent is null when a type has no demand and no
// rooms; a demand with no rooms reads as fully over).
const weekdayRoomFullness = ({ policy, demands, ccsLab, ccsLec }) => {
  const weekdays = policy.weekdays || [];
  const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
  const labHave = sum(ccsLab, r => sum(weekdays, day => hoursOn(policy, r, day)));
  const lecHave = sum(ccsLec, r => sum(weekdays, day => hoursOn(policy, r, day)));
  const noGroups = { ...policy, weekGroups: { ...(policy.weekGroups || {}), enabled: false } };
  const measure = (list) => {
    const s = roomSupply({ policy: noGroups, demands: list, labRooms: ccsLab, lecRooms: ccsLec, saturdayOn: false });
    const lecNeed = s.lecNeeded;
    // The Major lecture hours the LEC rooms cannot hold go into the lab rooms' SPARE time (never
    // more than the lab rooms have left): they fill the LAB type's hours, while the total counts
    // every class hour once (labs + lectures).
    const labNeedOwn = s.labsNeeded * s.labHoursEach + s.shortLabHours;
    const intoLab = policy.rooms.majorLectureInLab === 'NEVER' ? 0
      : Math.min(Math.max(0, lecNeed - lecHave), s.majorHours, Math.max(0, labHave - labNeedOwn));
    const labNeed = labNeedOwn + intoLab;
    const ratio = (need, have) => (have > 0 ? need / have : need > 0 ? Infinity : null);
    // Labs are whole blocks too: a window that holds fewer blocks than hours still fills up.
    const labRatio = Math.max(ratio(labNeed, labHave) ?? 0, s.weekdayLabBlocks > 0 ? s.labsNeeded / s.weekdayLabBlocks : (s.labsNeeded > 0 ? Infinity : 0));
    const pct = (r) => (r === null ? null : Math.round(r * 1000) / 10);
    return {
      lab: { percent: pct(labHave > 0 || labNeed > 0 ? labRatio : null), needHours: round1(labNeed), haveHours: round1(labHave) },
      lec: { percent: pct(ratio(lecNeed, lecHave)), needHours: round1(lecNeed), haveHours: round1(lecHave) },
      total: { percent: pct(ratio(labNeedOwn + lecNeed, labHave + lecHave)), needHours: round1(labNeedOwn + lecNeed), haveHours: round1(labHave + lecHave) }
    };
  };
  if (!policy.weekGroups?.enabled) return { ...measure(demands), groups: null };
  const always = demands.filter(d => !d.weekGroup);
  const odd = measure([...demands.filter(d => d.weekGroup === 'ODD'), ...always]);
  const even = measure([...demands.filter(d => d.weekGroup === 'EVEN'), ...always]);
  const fuller = (a, b) => ((b.percent ?? -1) > (a.percent ?? -1) ? b : a);
  return { lab: fuller(odd.lab, even.lab), lec: fuller(odd.lec, even.lec), total: fuller(odd.total, even.total), groups: { ODD: odd, EVEN: even } };
};

// Phase 3 Step 4: the TBA rooms a term's run gets, from the policy's overflowRooms.mode:
//   'off'    none;
//   'manual' the saved lab and lec counts;
//   'auto'   the weekday suggestion for the CCS rooms plus one room of each type it needs, capped at
//            MAX_EXTRA_ROOMS: the suggestion is an arithmetic minimum, and the Phase 2 benchmark showed a
//            run sometimes needs one more. When only Saturday helps (no weekday suggestion), the Saturday
//            suggestion plus one; none when the CCS rooms hold every class, or when no count would do.
//            Phase 8 Part 5 (decision 2a, the headroom rule, on by default): a room type MORE than
//            `overflowRooms.headroom.percent` % full in the weekday hours (weekdayRoomFullness; per
//            week group while the odd/even switch is on) that the lines above left at 0 TBA rooms
//            still gets ONE — an arithmetic that fits with an hour to spare leaves the GA nothing to
//            untangle with, and the TBA-room penalty keeps the room empty when it is not needed. A
//            type the suggestion already gave a room keeps its suggestion + 1, exactly as before.
// Returns the concrete { mode, enabled, lab, lec, headroom } that extraRoomsOf reads; `headroom`
// carries the rule's settings, the measured weekday fullness and what it added ({ enabled, percent,
// fullness, fired: { lab, lec }, added: { lab, lec } }), for the Readiness Check's per-group numbers
// and a failed run's cause (2c); since Phase 8 Part 8 (decision 5) the rule is silent before the run. loadTermInputs is its ONE caller, so the Readiness Check, the run's
// request, the save-time hash and the policySnapshot agree.
const resolveTbaRooms = ({ policy, pairs = [], locks = [], faculty = [], facilities = [] }) => {
  const saved = policy.overflowRooms || {};
  const mode = TBA_ROOM_MODES.includes(saved.mode) ? saved.mode : 'auto';
  const cfg = { enabled: true, percent: 85, ...(saved.headroom || {}) };
  // The weekday fullness is measured in every mode (so a failed run with "use only the CCS rooms"
  // can still name the cause, decision 2c); the rule ADDS a room in auto mode only.
  const rooms = typedRooms(activeRooms(facilities));
  const { demands } = buildGaRequest({ policy, pairs, locks, faculty, facilities: rooms }).request;
  const ccsLab = rooms.filter(r => r.type === 'LAB');
  const ccsLec = rooms.filter(r => r.type === 'LEC');
  const fullness = weekdayRoomFullness({ policy, demands, ccsLab, ccsLec });
  const over = (type) => fullness[type].percent !== null && fullness[type].percent > cfg.percent;
  const fired = { lab: Boolean(cfg.enabled) && over('lab'), lec: Boolean(cfg.enabled) && over('lec') };
  const headroom = { enabled: Boolean(cfg.enabled), percent: cfg.percent, fullness, fired, added: { lab: 0, lec: 0 } };
  if (mode === 'off') return { mode, enabled: false, lab: 0, lec: 0, headroom };
  if (mode === 'manual') return { mode, enabled: true, lab: saved.lab, lec: saved.lec, headroom };
  const { suggestion } = ccsRoomSuggestion({ policy, demands, ccsLab, ccsLec, saturdayOn: saturdayOnOf(policy) });
  const counts = suggestion?.weekdays || suggestion?.withSaturday || { lab: 0, lec: 0 };
  const plusOne = (n) => (n > 0 ? Math.min(n + 1, MAX_EXTRA_ROOMS) : 0);
  const base = { lab: plusOne(counts.lab), lec: plusOne(counts.lec) };
  // The suggestion's own +1 already gives a short type its headroom; the rule covers the type the
  // arithmetic left at 0, so every resolved count from before Part 5 stays exactly as it was.
  headroom.added = { lab: fired.lab && base.lab === 0 ? 1 : 0, lec: fired.lec && base.lec === 0 ? 1 : 0 };
  return { mode, enabled: true, lab: base.lab + headroom.added.lab, lec: base.lec + headroom.added.lec, headroom };
};

// The cause a failed run names when a room type sits above the headroom level (Phase 8 Part 5,
// decision 2c; since Part 8 the Readiness Check says nothing about the level before the run), from
// the RESOLVED policy's overflowRooms.headroom. Null while nothing is over the level (or the rule is
// off). `opening` is the plain fact ("Without odd and even weeks, the CCS classes need 314 of the
// rooms' 315 hours"); the caller adds its own ending.
// Phase 8 Part 8 (decision 5): with the odd and even weeks on, the cause names the full room type and
// its week group ("In the odd weeks, the lectures need 154 of the lecture rooms' 180 weekday hours"),
// and `waysOut` never offers a setting that is already on (roomWaysOut).
const headroomCause = (policy) => {
  const head = policy?.overflowRooms?.headroom;
  if (!head?.fullness || !(head.fired?.lab || head.fired?.lec)) return null;
  const groupsOn = Boolean(policy.weekGroups?.enabled);
  const groups = groupsOn ? head.fullness.groups : null;
  const kind = !groups || (head.fired.lab && head.fired.lec) ? 'total' : head.fired.lab ? 'lab' : 'lec';
  const group = !groups ? null : (groups.EVEN?.[kind]?.percent ?? -1) > (groups.ODD?.[kind]?.percent ?? -1) ? 'EVEN' : 'ODD';
  const f = groups ? groups[group][kind] : head.fullness.total;
  const what = kind === 'lab' ? `the lab classes need ${h(f.needHours)} of the lab rooms' ${h(f.haveHours)} weekday hours`
    : kind === 'lec' ? `the lectures need ${h(f.needHours)} of the lecture rooms' ${h(f.haveHours)} weekday hours`
      : `the CCS classes need ${h(f.needHours)} of the rooms' ${h(f.haveHours)} hours`;
  const opening = groups ? `In the ${group === 'ODD' ? 'odd' : 'even'} weeks, ${what}` : `Without odd and even weeks, ${what}`;
  return { opening, needHours: f.needHours, haveHours: f.haveHours, percent: f.percent, kind, group, groupsOn, added: head.added, waysOut: roomWaysOut(policy) };
};

// Phase 8 Part 8 (decision 5): the ways out of a room-tight term, never a setting that is already on —
// the odd and even weeks while they are off, the TBA rooms while "Use only the CCS rooms" is chosen;
// with both on, another run and a borrowed room's free times.
const roomWaysOut = (policy) => {
  const settings = [
    ...(policy?.weekGroups?.enabled ? [] : ['choose "Alternate odd and even weeks" in the Scheduling Policy']),
    ...(policy?.overflowRooms?.mode === 'off' ? ['choose "Put the extra classes in TBA rooms" in the Scheduling Policy'] : [])
  ];
  return settings.length ? settings : ['generate again (a new run starts from new schedules)', 'add a borrowed room from another department, with its free times (Rooms page)'];
};

// The fewest meetings, longest first, whose hours cover `hours` (0 when nothing is short).
const fewestMeetingsFor = (meetings, hours, hoursOf) => {
  if (!(hours > 1e-9)) return 0;
  let covered = 0;
  let count = 0;
  for (const d of [...meetings].sort((a, b) => hoursOf(b) - hoursOf(a))) {
    if (covered >= hours - 1e-9) break;
    covered += hoursOf(d);
    count += 1;
  }
  return count;
};

const ROOM_SHORTAGE_CODES = ['LAB_SHORTAGE', 'LAB_HOURS_SHORTAGE', 'LEC_SHORTAGE'];

// The Readiness Check's seven lines (Phase 3 Step 4), in the Dean's words, read from the report's own
// errors, warnings and numbers (nothing is counted a second time). Every error folds into the line it
// belongs to (data problems included: tracks into sections, incomplete profiles into professors' time,
// room types and capacity into rooms), and each fail line comes from an error, so the verdict is
// 'ready' exactly when the report is ok. A fail or warn line a page fixes names it in `fix` (the Step 4
// page keys). A status alone reads as a phrase; an explanation is a sentence.
const buildReadiness = ({ policy, mode, errors, warnings, sections, noProfessor, subjectsPlaced, semesterLabel, academicYear, policySaved, ccsShort, suggestion, online, tbaClassesEstimate, extraLab, extraLec, professorTime = [], underMinimum = [], saturdayOn = false, rooms = null }) => {
  const of = (list, ...codes) => list.filter(e => codes.includes(e.code));
  const details = (list) => list.map(e => e.message).join(' ');
  const term = academicYear ? `${semesterLabel}, AY ${academicYear}` : `the ${semesterLabel}`;
  const lines = [];
  const line = (id, status, text, extra = {}) => lines.push({ id, n: lines.length + 1, status, text, ...extra });

  // 1. The term's subjects are placed in the curriculum.
  const noDemands = of(errors, 'NO_DEMANDS');
  if (subjectsPlaced === 0) {
    line('subjects', 'fail', `No subjects are placed in the curriculum for ${term}.`, { detail: details(noDemands), fix: { page: 'subjects' } });
  } else if (noDemands.length && sections.length) {
    line('subjects', 'fail', `No subject placed in the curriculum for ${term} matches an active section (program, year level and track).`, { detail: details(noDemands), fix: { page: 'subjects' } });
  } else line('subjects', 'pass', "The term's subjects are placed in the curriculum");

  // 2. The term has N active sections (a wrong track folds in here).
  const tracks = of(errors, 'SECTION_TRACK');
  if (!sections.length) line('sections', 'fail', 'The term has no active sections.', { fix: { page: 'sections' } });
  else if (tracks.length) {
    line('sections', 'fail', tracks.length === 1 ? `Section ${tracks[0].sectionCode} has the wrong track.` : `${tracks.length} sections have the wrong track: ${tracks.map(e => e.sectionCode).join(', ')}.`,
      { detail: details(tracks), fix: { page: 'sections' } });
  } else line('sections', 'pass', `The term has ${plural(sections.length, 'active section')}`);

  // 3. Every Major class has a professor.
  if (noProfessor.length) {
    line('professors', 'fail', `${plural(noProfessor.length, 'Major class has', 'Major classes have')} no professor.`, {
      detail: noProfessor.map(p => `${p.subject.subjectCode} (${p.section.sectionCode})`).join(', '),
      fix: { page: 'assign-faculty', params: { tab: 'by-class' } }
    });
  } else line('professors', 'pass', 'Every Major class has a professor');

  // 4. Rooms: a shortage the TBA rooms cover is a warning (the other options listed); a shortage is a
  // blocker only while TBA rooms are off, too few (manual) or not enough even at the most the policy
  // allows; a room without a type, or a section no room fits (capacity enforced), blocks too. The other
  // options: Saturday classes, and (Phase 3 Step 7) holding about N lecture hours online, named with the
  // subjects that would cover it, only when that would leave no lecture short of a room (labs always
  // stay on campus, so a shortage of lab rooms alone gets no online option).
  const shortage = of(errors, ...ROOM_SHORTAGE_CODES);
  const roomTypes = of(errors, 'ROOM_TYPE');
  const capacity = of(errors, 'CAPACITY');
  const sizes = of(warnings, 'SECTION_SIZE');
  const years = policy.saturdayOverflow?.yearLevels || [];
  // Phase 8 Part 8 (decision 5): never a setting that is already on (Saturday classes while they are on).
  const options = [...(years.length && !saturdayOn ? [`Saturday classes for ${yearsWords(years)} (Scheduling Policy)`] : []), ...(online ? [onlineOptionText(online)] : [])];
  const withOptions = options.length ? { options } : {};
  // Phase 4 Part 1 (Step 3): the numbers are minimums and say so. The classes are the arithmetic
  // minimum of meetings that cover the hours short (tbaClassesEstimate: a run may put more classes in
  // TBA rooms to avoid Saturday classes and idle hours), and the rooms are the weekday suggestion (the
  // fewest that make the arithmetic fit), not the automatic count a run gets (one more of each type).
  const classes = plural(tbaClassesEstimate, 'class', 'classes');
  // Phase 8 Part 8 (decision 5): with the odd and even weeks on, a shortage names its week group(s).
  const shortGroups = rooms?.supply?.weekGroups ? ['ODD', 'EVEN'].filter(g => rooms.supply.weekGroups[g].labShort > 0 || rooms.supply.weekGroups[g].lecShort > 0) : [];
  const inGroups = shortGroups.length === 2 ? 'In both the odd and the even weeks, at least' : shortGroups.length === 1 ? `In the ${shortGroups[0] === 'ODD' ? 'odd' : 'even'} weeks, at least` : 'At least';
  const wontFit = `${inGroups} ${classes} won't fit in the CCS rooms on weekdays`;
  const withSizes = (list) => details([...list, ...sizes]);
  // Phase 4 Part 4 (rooms the Dean's way): "How we know", in plain numbers: the term's three-hour labs
  // against the most the CCS lab rooms can hold (3 a day each, plus Saturday when it is on), and the
  // lecture hours against the lecture rooms' hours. Only when the rooms are counted (a shortage or not).
  // Phase 8 (odd and even weeks): with the switch on, each room's slots count once per group (a room
  // hour holds one odd-week and one even-week class), and the line says so with each group's count.
  const s = rooms?.supply;
  const wg = s?.weekGroups;
  const howWeKnow = !s ? null : wg ? [
    `With odd and even weeks alternating, a room hour holds one odd-week and one even-week class, so each week group is checked against the full rooms.`,
    `The term has ${plural(s.labsNeeded, `${hoursWord(s.labHoursEach)}-hour lab`)} (${wg.ODD.labsNeeded} count in the odd weeks, ${wg.EVEN.labsNeeded} in the even weeks); the ${plural(rooms.ccsLab, 'CCS lab room')} can hold ${wg.perGroup.weekdayLabBlocks} a week on weekdays for each group (${s.labStartsPerDay} a day each)${saturdayOn ? `, plus ${wg.perGroup.saturdayLabsUsable} on Saturday for the years allowed` : ''}.`,
    `The lectures need about ${h(s.lecNeeded)} h of room time a week (${h(wg.ODD.lecNeeded)} h in the odd weeks, ${h(wg.EVEN.lecNeeded)} h in the even weeks); the ${plural(rooms.ccsLec, 'CCS lecture room')} give ${h(wg.perGroup.weekdayLecHours)} h on weekdays for each group${saturdayOn ? `, plus ${h(wg.perGroup.saturdayLecUsable)} h on Saturday` : ''}${s.labForMajors > 0 ? `, and the lab rooms' spare time can take up to ${h(s.labForMajors)} h of Major lectures across the two groups` : ''}.`
  ].join(' ') : [
    `The term has ${plural(s.labsNeeded, `${hoursWord(s.labHoursEach)}-hour lab`)}; the ${plural(rooms.ccsLab, 'CCS lab room')} can hold ${s.weekdayLabBlocks} a week on weekdays (${s.labStartsPerDay} a day each)${saturdayOn ? `, plus ${s.saturdayLabsUsable} on Saturday for the years allowed` : ''}.`,
    `The lectures need about ${h(s.lecNeeded)} h of room time a week; the ${plural(rooms.ccsLec, 'CCS lecture room')} give ${h(s.weekdayLecHours)} h on weekdays${saturdayOn ? `, plus ${h(s.saturdayLecUsable)} h on Saturday` : ''}${s.labForMajors > 0 ? `, and the lab rooms' spare time can take up to ${h(s.labForMajors)} h of Major lectures` : ''}.`
  ].join(' ');
  const withHow = howWeKnow ? { howWeKnow } : {};
  // With "use only the CCS rooms" (the Dean's plain choice) the ways out are TBA rooms (the other choice),
  // a borrowed room, Saturday classes and online lectures.
  const ccsOnlyOptions = mode === 'off' ? ['TBA rooms: choose "Put the extra classes in TBA rooms" on the Scheduling Policy', 'A borrowed room from another department, with its free times (Rooms page)', ...options] : options;
  const withCcsOnlyOptions = ccsOnlyOptions.length ? { options: ccsOnlyOptions } : {};
  // Phase 8 Part 8 (decision 5, replacing Part 5's decision 2b): the headroom rule is silent before the
  // run. When the rooms fit, the line is a pass even above the headroom level: the rule's spare TBA
  // room stays, as the GA's safety net, and the Generate result says when a class lands in it. A
  // warning remains only when a week group's classes truly exceed the rooms (the shortage lines).
  const groupFit = (() => {
    const groups = policy.overflowRooms?.headroom?.fullness?.groups;
    if (!wg || !groups) return null;
    const words = (g) => `${h(groups[g].total.needHours)} of the rooms' ${h(groups[g].total.haveHours)} h`;
    return `the odd weeks need ${words('ODD')}, the even weeks ${words('EVEN')}`;
  })();
  if (shortage.length) {
    const text = mode === 'off' ? `${wontFit}, and the Scheduling Policy uses only the CCS rooms.`
      : mode === 'manual' ? `${wontFit}, and the TBA rooms set in Advanced (${extraLab} lab, ${extraLec} lecture) are not enough.`
        : !(suggestion?.weekdays || suggestion?.withSaturday) ? `${wontFit}, and even ${MAX_EXTRA_ROOMS} TBA rooms of a type would not be enough.`
          : `${wontFit}.`;
    line('rooms', 'fail', text, { detail: withSizes([...shortage, ...roomTypes, ...capacity]), ...withCcsOnlyOptions, ...withHow, fix: { page: mode === 'off' ? 'policy' : 'rooms' } });
  } else if (roomTypes.length) {
    line('rooms', 'fail', roomTypes.length === 1 ? `Room ${roomTypes[0].roomName} has no room type (LEC or LAB).` : `${roomTypes.length} rooms have no room type (LEC or LAB): ${roomTypes.map(e => e.roomName).join(', ')}.`,
      { detail: withSizes([...roomTypes, ...capacity]), fix: { page: 'rooms' } });
  } else if (capacity.length) {
    line('rooms', 'fail', capacity.length === 1 ? capacity[0].message : `${capacity.length} classes fit no room large enough for their section.`, { detail: withSizes(capacity), fix: { page: 'rooms' } });
  } else if (ccsShort) {
    // The weekday suggestion (the Saturday one when no weekday count works), never the automatic count.
    const fewest = suggestion?.weekdays || suggestion?.withSaturday || { lab: extraLab, lec: extraLec };
    const usingSaturday = !suggestion?.weekdays && suggestion?.withSaturday ? ', also using Saturday,' : '';
    line('rooms', 'warn', `${wontFit}. They will go into TBA rooms: at least ${tbaRoomsWords(fewest.lab, fewest.lec)}${usingSaturday} to request. The schedule will give the exact list.`, { ...withOptions, ...withHow, ...(sizes.length ? { detail: details(sizes) } : {}) });
  } else if (sizes.length) {
    line('rooms', 'warn', `${plural(sizes.length, 'section has', 'sections have')} no student count, so room size is not checked for ${sizes.length === 1 ? 'it' : 'them'}.`, { detail: details(sizes), fix: { page: 'sections' } });
  } else if (wg) {
    line('rooms', 'pass', `Every week group's classes fit the CCS rooms${groupFit ? ` (${groupFit})` : ''}`, withHow);
  } else line('rooms', 'pass', 'The CCS rooms hold every class that needs a room', withHow);

  // 5. Every professor's classes fit their available time (an incomplete profile folds in here).
  const hours = of(errors, 'FACULTY_HOURS');
  const incomplete = of(errors, 'FACULTY_INCOMPLETE');
  if (hours.length || incomplete.length) {
    const parts = [];
    if (hours.length === 1) parts.push(`${hours[0].facultyName} has ${h(hours[0].hoursNeeded)} h of classes but only ${h(hours[0].hoursFree)} h free in the week`);
    else if (hours.length > 1) parts.push(`${hours.length} professors have more classes than free time: ${hours.map(e => `${e.facultyName} (${h(e.hoursNeeded)} h of classes, ${h(e.hoursFree)} h free)`).join(', ')}`);
    if (incomplete.length === 1) parts.push(`${incomplete[0].facultyName} has no ${incomplete[0].missing} on record`);
    else if (incomplete.length > 1) parts.push(`${incomplete.length} professors have no employment type or teaching cap on record: ${incomplete.map(e => e.facultyName).join(', ')}`);
    line('faculty', 'fail', `${parts.join('; ')}.`, { detail: details([...hours, ...incomplete]), fix: { page: 'faculty' } });
  } else line('faculty', 'pass', "Every professor's classes fit their available time");

  // 6. Every section's classes fit in the week (a meeting that fits no day's window folds in here).
  const week = of(errors, 'SECTION_HOURS');
  const windows = of(errors, 'WINDOW');
  if (week.length || windows.length) {
    const parts = [];
    if (week.length === 1) parts.push(`Section ${week[0].sectionCode} has ${h(week[0].hoursNeeded)} h of classes but only ${h(week[0].hoursAvailable)} h fit in its week`);
    else if (week.length > 1) parts.push(`${week.length} sections have more classes than their week holds: ${week.map(e => `${e.sectionCode} (${h(e.hoursNeeded)} h of classes, ${h(e.hoursAvailable)} h fit)`).join(', ')}`);
    if (windows.length) parts.push(`${plural(windows.length, 'class meeting does', 'class meetings do')} not fit inside the day's hours`);
    line('week', 'fail', `${parts.join('; ')}.`, { detail: details([...week, ...windows]), fix: { page: week.length ? 'subjects' : 'policy' } });
  } else line('week', 'pass', "Every section's classes fit in the week");

  // 7. The Scheduling Policy is saved (a warning: the defaults are used until it is).
  if (policySaved) line('policy', 'pass', 'The Scheduling Policy is saved');
  else line('policy', 'warn', 'The Scheduling Policy has not been saved yet: the default settings are used. Open it and press Save to confirm them.', { fix: { page: 'policy' } });

  // 8. Each professor's free weekday time against their classes (Phase 4 Part 2 Step 3): one line per
  // professor whose slack (free weekday hours − class hours) is below 3 h, with "Fix this" to that
  // professor on the Faculty page; one ✔ line when everyone has enough. Slack below 0: ✖ with Saturday
  // classes off (the week cannot hold them), ⚠ with them on (about that many hours go to Saturday).
  const tight = (professorTime || []).filter(p => p.slack < 3);
  if (!tight.length) line('professor-time', 'pass', 'Every professor has enough free time');
  for (const p of tight) {
    const extra = { fix: { page: 'faculty', params: { professor: p.facultyId } }, professor: { facultyId: p.facultyId, facultyRef: p.facultyRef, name: p.name, classHours: p.classHours, freeHours: p.freeHours, slack: p.slack } };
    if (p.slack < 0 && !saturdayOn) {
      line('professor-time', 'fail', `${p.name} teaches ${h(p.classHours)} h of classes but is free only about ${h(p.freeHours)} h on weekdays. Give a class to another professor, or mark fewer unavailable times.`, extra);
    } else if (p.slack < 0) {
      line('professor-time', 'warn', `About ${h(-p.slack)} h of ${p.name}'s classes will go to Saturday.`, extra);
    } else {
      line('professor-time', 'warn', `${p.name} has very little free time (about ${h(p.slack)} h). The schedule may need Saturday or early starts.`, extra);
    }
  }

  // 9. Professors under their minimum teaching load (Phase 8 Part 4, decision 1): ONE ⚠ line, never
  // a blocker — the Secretary wants every load in a range, and the Teaching loads panel on Assign
  // Faculty suggests the moves. A professor whose minimum is 0 (for example one who teaches only
  // graduate classes) is never listed.
  if (underMinimum.length) {
    const named = underMinimum.map(p => `${p.name}: ${h(p.teaching)} of ${h(p.min)} h (${h(p.underMin)} h under)`);
    line('professor-minimum', 'warn', `${plural(underMinimum.length, 'professor is', 'professors are')} under their minimum teaching load.`, {
      detail: named.join('; '),
      list: named,
      howWeKnow: 'A professor\'s minimum is the one typed on their profile, or the policy default for their employment type, lowered for a full-timer by their Management Function hours. Teaching hours count lecture + lab at the lab factor + practicum coordination. The Teaching loads panel on Assign Faculty suggests moves that raise a professor toward the minimum.',
      professors: underMinimum.map(p => ({ facultyRef: p.facultyRef, facultyId: p.facultyId, name: p.name, teaching: p.teaching, min: p.min, underMin: p.underMin })),
      fix: { page: 'assign-faculty', params: { tab: 'by-class' } }
    });
  }

  const toFix = lines.filter(l => l.status === 'fail').length;
  return { verdict: toFix === 0 ? 'ready' : 'not-ready', toFix, lines };
};

// academicYear, termMappings (the term's curriculum placements) and policySaved (a Scheduling Policy
// document is stored) only feed the Readiness lines; without them the lines use general words.
const runPreflight = ({ policy, sections = [], pairs = [], locks = [], faculty = [], facilities = [], semesterLabel = 'term', academicYear = null, termMappings = null, policySaved = false }) => {
  const errors = [];
  const warnings = [];
  const info = [];
  // `extra`: more fields for one message, e.g. the list behind it for "Technical details".
  const add = (list, check, code, message, fix = '', extra = {}) => list.push({ check, code, message, ...(fix ? { fix } : {}), ...extra });
  const slotHours = policy.slotMinutes / 60;
  const weekdays = policy.weekdays || [];
  const overflow = policy.saturdayOverflow || {};
  const saturdayOn = saturdayOnOf(policy);

  // ---------------------------------------------------------------- 1. Data completeness
  for (const s of sections) {
    const problem = trackProblem(s);
    if (problem) add(errors, 'data', 'SECTION_TRACK', `Section ${s.sectionCode}: ${problem}`, 'Fix the track on the Sections page.', { sectionCode: s.sectionCode });
  }
  const resolveHolder = buildFacultyResolver(faculty);
  const reported = new Set();
  for (const { section, subject } of pairs) {
    const type = resolveSubjectType(subject);
    if (type === 'NSTP') continue;
    const lock = findLockFor(locks, section.sectionCode, subject);
    if (!lock || lock.facultyId === TBA_POOL_FACULTY_ID || (type === 'Minor' && lock.source !== 'manual')) continue;
    const holder = resolveHolder(lock);
    if (!holder || reported.has(String(holder._id))) continue;
    const missing = [!holder.employmentType && 'employment type', !Number.isFinite(holder.teachingCapHours) && 'teaching cap'].filter(Boolean);
    if (missing.length) {
      reported.add(String(holder._id));
      add(errors, 'data', 'FACULTY_INCOMPLETE', `${holder.name} holds an assignment but has no ${missing.join(' or ')} on record.`, 'Open the professor on the Faculty page and fill it in.', { facultyName: holder.name, missing: missing.join(' or ') });
    }
  }
  const rooms = activeRooms(facilities);
  for (const r of rooms) {
    if (!['LEC', 'LAB'].includes(r.type)) add(errors, 'data', 'ROOM_TYPE', `Room ${r.roomName} has no room type (LEC or LAB).`, 'Set its type on the Rooms page.', { roomName: r.roomName });
  }

  if (!pairs.length) {
    add(errors, 'data', 'NO_DEMANDS', `No subject placed in the curriculum for the ${semesterLabel} matches an active section, so there is nothing to schedule.`, 'Place subjects in the curriculum on the Curriculum & Subjects page, and check each section\'s program, year level and track on the Sections page.');
  }
  const { request, unscheduledItems } = buildGaRequest({ policy, pairs, locks, faculty, facilities: typedRooms(rooms) });
  const demands = request.demands;

  // Phase 3 Step 4: a Major class without a professor blocks generation (it was a warning, and the class
  // went out as TBA). Read per pair, like the Assign Faculty counts (numbers.assignment): a Major locked
  // to the TBA pool, or to someone who is no longer an active professor, has no professor either.
  const assignment = assignmentCounts({ pairs, locks, faculty });
  const noProfessor = unassignedMajorPairs({ pairs, locks, faculty });
  for (const { section, subject, lock } of noProfessor) {
    const what = `${subject.subjectCode} (${section.sectionCode})`;
    const message = !lock ? `${what} has no professor yet.`
      : lock.facultyId === TBA_POOL_FACULTY_ID ? `${what} is set to TBA, but a Major class needs a professor.`
        : `${what} is assigned to ${lock.facultyName || 'a professor'}, who is no longer an active professor.`;
    add(errors, 'data', 'MAJOR_TBA', message, 'Assign a professor on the Assign Faculty page.', { subjectId: String(subject._id), subjectCode: subject.subjectCode, sectionCode: section.sectionCode });
  }
  // The Majors ranked this term whose description is missing or very short: ONE warning for all of
  // them, with the subjects in `detail` and `subjects` ("Technical details"). The ranking matches
  // professors on the title when there is no description, and a very short one adds little to it.
  const brief = new Map();
  for (const { subject } of pairs) {
    if (resolveSubjectType(subject) !== 'Major' || subject.isPracticum || brief.has(String(subject._id))) continue;
    const words = String(subject.subjectDescription || '').trim().split(/\s+/).filter(Boolean).length;
    if (words < MIN_DESCRIPTION_WORDS) {
      brief.set(String(subject._id), { subjectId: String(subject._id), subjectCode: subject.subjectCode, subjectTitle: subject.descriptiveTitle || '', words });
    }
  }
  if (brief.size) {
    const subjects = [...brief.values()].sort((a, b) => byText(a.subjectCode, b.subjectCode) || byText(a.subjectTitle, b.subjectTitle));
    // A code several subjects share (ITST 301 on each BSIT track) is told apart by its title.
    const perCode = subjects.reduce((m, s) => m.set(s.subjectCode, (m.get(s.subjectCode) || 0) + 1), new Map());
    const named = subjects.map(s => (perCode.get(s.subjectCode) > 1 && s.subjectTitle ? `${s.subjectCode} (${s.subjectTitle})` : s.subjectCode));
    const one = subjects.length === 1;
    add(warnings, 'data', 'SHORT_DESCRIPTION',
      `${plural(subjects.length, 'subject')} ${one ? 'has' : 'have'} no description yet (or a very short one): professors are matched on ${one ? 'its title' : 'their titles'} until one is added.`,
      `Add a description of at least ${MIN_DESCRIPTION_WORDS} words to ${one ? 'it' : 'each'} in the Master Catalog.`,
      { detail: named.join(', '), subjects });
  }
  const minorTba = new Set(demands.filter(d => d.isMinor && !d.fixed && !d.facultyRef).map(d => d.meetingGroup)).size;
  if (minorTba) add(info, 'data', 'MINOR_TBA', `${plural(minorTba, 'Minor subject-section pair')} ${minorTba === 1 ? 'is' : 'are'} TBA (staffed by the GenEd departments).`);
  // Unscheduled items are practicum pairs and (Phase 3 Step 7) self-paced online lectures: counted apart.
  const practicumPairs = unscheduledItems.filter(u => u.kind === 'PRACTICUM').length;
  if (practicumPairs) add(info, 'data', 'PRACTICUM', `${plural(practicumPairs, 'practicum pair')} ${practicumPairs === 1 ? 'is' : 'are'} not placed on the timetable (they count as coordinator load only).`);
  // Phase 3 Step 7: the Major lectures the Dean holds online, in hours (scheduled: a day and a time, no
  // room; self-paced: not on the timetable, still in the professors' loads).
  const selfPaced = unscheduledItems.filter(u => u.kind === 'SELF_PACED');
  const lecHoursOnline = demands.filter(d => d.online).reduce((sum, d) => sum + d.durationSlots * slotHours, 0);
  const lecHoursSelfPaced = selfPaced.reduce((sum, u) => sum + (Number(u.hours) || 0), 0);
  if (lecHoursOnline > 0 || lecHoursSelfPaced > 0) {
    const parts = [
      lecHoursOnline > 0 ? `${h(lecHoursOnline)} h of Major lectures are held online at a set day and time (no room)` : null,
      lecHoursSelfPaced > 0 ? `${h(lecHoursSelfPaced)} h ${lecHoursOnline > 0 ? '' : 'of Major lectures '}are self-paced online in ${plural(selfPaced.length, 'subject-section pair')} (not on the timetable; they count in the professors' loads)` : null
    ].filter(Boolean);
    add(info, 'data', 'ONLINE', `${parts.join('; ')}.`);
  }

  if (policy.rooms?.enforceCapacity) {
    for (const s of sections) {
      if (!Number.isFinite(s.studentCount)) add(warnings, 'data', 'SECTION_SIZE', `Section ${s.sectionCode} has no student count, so room capacity is not checked for it.`, 'Enter it on the Sections page.', { sectionCode: s.sectionCode });
    }
    const tooBig = new Map();
    for (const d of demands) {
      if (!d.allowedRoomTypes.length || d.sectionSize === null) continue;
      // TBA rooms have no stated capacity, so (like the GA and the validator) they fit any section.
      const fits = [...rooms, ...extraRoomsOf(policy).map(r => ({ type: r.roomType, capacity: null }))]
        .some(r => d.allowedRoomTypes.includes(r.type) && (!Number.isFinite(r.capacity) || r.capacity >= d.sectionSize));
      if (!fits) tooBig.set(`${d.sectionCode}|${d.classType}`, `Section ${d.sectionCode} (${d.sectionSize} students) fits no ${d.allowedRoomTypes.join(' or ')} room.`);
    }
    tooBig.forEach(message => add(errors, 'data', 'CAPACITY', message, 'Add a larger room on the Rooms page, or turn off "Enforce room capacity" (Scheduling Policy, Advanced).'));
  }

  // ---------------------------------------------------------------- 2. Room supply against demand
  // CCS rooms (and borrowed rooms, with their windows), plus the TBA rooms the policy carries (resolved
  // from its mode by loadTermInputs before the check).
  const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
  const hoursOf = (d) => d.durationSlots * slotHours;
  const ccsLab = rooms.filter(r => r.type === 'LAB');
  const ccsLec = rooms.filter(r => r.type === 'LEC');
  const extra = extraRoomsOf(policy).map(r => ({ roomName: r.roomName, type: r.roomType, availability: [] }));
  const extraLab = extra.filter(r => r.type === 'LAB').length;
  const extraLec = extra.filter(r => r.type === 'LEC').length;
  const labRooms = [...ccsLab, ...extra.filter(r => r.type === 'LAB')];
  const lecRooms = [...ccsLec, ...extra.filter(r => r.type === 'LEC')];
  const supply = roomSupply({ policy, demands, labRooms, lecRooms, saturdayOn });
  const { labsNeeded, weekdayLabBlocks, saturdayLabsUsable, labsFit, labShort, labHoursEach, shortLabHours, labLeftover,
    majorHours, minorHours, lecNeeded, weekdayLecHours, saturdayLecUsable, labForMajors, lecAvailable, lecShort } = supply;
  const weekLabel = dayRangeLabel(weekdays);
  const satYears = yearsLabel(overflow.yearLevels);
  const withExtra = (n, type) => (n ? ` (${plural(n, `TBA ${type === 'LAB' ? 'lab' : 'lecture'} room`)} included)` : '');
  const mode = TBA_ROOM_MODES.includes(policy.overflowRooms?.mode) ? policy.overflowRooms.mode : 'auto';

  // When the CCS rooms alone are short, the smallest TBA-room counts (arithmetic minimums), and (Phase 3
  // Step 7) about how many Major lecture hours held online would make the lectures fit instead.
  const { supply: ccsSupply, short: ccsShort, suggestion } = ccsRoomSuggestion({ policy, demands, ccsLab, ccsLec, saturdayOn });
  const online = onlineOption({ policy, demands, ccsLab, ccsLec, suggestion, subjects: new Map(pairs.map(p => [String(p.subject._id), p.subject])) });
  const counts = (s) => `${plural(s.lab, 'TBA lab room')} and ${plural(s.lec, 'TBA lecture room')}`;
  const options = [
    suggestion?.weekdays ? `${counts(suggestion.weekdays)} on weekdays only` : null,
    suggestion?.withSaturday ? `${counts(suggestion.withSaturday)} also using Saturday for ${satYears} years` : null
  ].filter(Boolean);
  const anyOption = options.length > 0;
  const suggestionText = !suggestion ? ''
    : anyOption
      ? ` Fewest TBA rooms to request: ${options.join(', or ')}${suggestion.weekdays ? '' : ` (on weekdays only, even ${MAX_EXTRA_ROOMS} TBA rooms of a type are not enough)`} (arithmetic minimums; the schedule may need one more of a type).`
      : ` Even ${MAX_EXTRA_ROOMS} TBA rooms of a type (the most the policy allows) are not enough.`;
  const extraFix = !anyOption
    ? 'Add a borrowed room on the Rooms page, or reduce the classes that need rooms (fewer lab sections, or GenEd subjects hosted by other departments).'
    : mode === 'off'
      ? 'Switch TBA rooms on (Scheduling Policy, Advanced: Automatic), or add a borrowed room on the Rooms page.'
      : mode === 'manual'
        ? 'Raise the TBA room counts or set them to Automatic (Scheduling Policy, Advanced), or add a borrowed room on the Rooms page.'
        : 'Add a borrowed room on the Rooms page.';

  // Phase 8: with odd and even weeks on, the capacities below count each room once per week group.
  const perGroupNote = policy.weekGroups?.enabled ? ', counting each room once per week group (odd and even weeks share a room)' : '';
  const labLine = `${plural(labsNeeded, `${hoursWord(labHoursEach)}-hour lab`)} needed; ${weekdayLabBlocks} fit ${weekLabel}${withExtra(extraLab, 'LAB')}${perGroupNote}`
    + (saturdayOn ? ` and ${saturdayLabsUsable} more on Saturday for ${satYears} years (${weekdayLabBlocks + saturdayLabsUsable})` : '');
  if (labShort > 0) {
    add(errors, 'lab', 'LAB_SHORTAGE', `LAB rooms: ${labLine}. Short by ${labShort}.${suggestionText}`, extraFix);
  }
  if (supply.labHoursShort > 0) {
    add(errors, 'lab', 'LAB_HOURS_SHORTAGE', `LAB rooms: ${h(shortLabHours)} h of shorter lab meetings need LAB rooms, but only ${h(labLeftover)} h are left after the ${labHoursEach}-hour labs${saturdayOn ? ` (the Saturday time serves only ${satYears} years)` : ''}.${suggestionText}`, extraFix);
  }
  // Major lectures held online need no room (Phase 3 Step 7): said only when there are some.
  const lecLine = `about ${h(lecNeeded)} h of lectures need a room (${h(majorHours)} h Major + ${h(minorHours)} h GenEd/Minor${lecHoursOnline > 0 ? `; ${h(lecHoursOnline)} h of Major lectures are online and need none` : ''}); about ${h(lecAvailable)} h are available${perGroupNote} `
    + `(${h(weekdayLecHours)} h ${weekLabel}${withExtra(extraLec, 'LEC')}${saturdayOn ? `, ${h(saturdayLecUsable)} h on Saturday for ${satYears} years` : ''}`
    + `${policy.rooms.majorLectureInLab === 'NEVER' ? '' : `, up to ${h(labForMajors)} h left over in LAB rooms for Major lectures`})`;
  if (lecShort > 0) {
    add(errors, 'lec', 'LEC_SHORTAGE', `Lecture rooms: ${lecLine}. Short by about ${h(lecShort)} h.${labShort > 0 ? '' : suggestionText}`,
      `${extraFix}${minorHours > 0 ? ' Unticking "Needs a CCS room" on a GenEd subject hosted by another department also frees room hours.' : ''}`
      + `${online ? ' Holding some Major lectures online (Lecture mode, in the Master Catalog) frees room hours too.' : ''}`);
  }

  // ---------------------------------------------------------------- 3. Each section's week
  const sectionByCode = new Map(sections.map(s => [s.sectionCode, s]));
  const demandsBySection = new Map();
  demands.filter(d => !d.fixed).forEach(d => demandsBySection.set(d.sectionCode, [...(demandsBySection.get(d.sectionCode) || []), d]));
  for (const [code, list] of demandsBySection) {
    const section = sectionByCode.get(code);
    const days = allowedDaysForSection(policy, section);
    const available = sum(days, day => usableHoursWithLunch(policy, usableIntervals(policy, day)));
    const needed = sum(list, hoursOf);
    if (needed > available) {
      add(errors, 'sections', 'SECTION_HOURS', `Section ${code}: ${h(needed)} h of classes a week, but only ${h(available)} h fit (${plural(days.length, 'day')} × the window, keeping the lunch rule).`,
        'Move a subject to another semester on the Curriculum & Subjects page, or allow Saturday classes for this year level (Scheduling Policy, Advanced).',
        { sectionCode: code, hoursNeeded: needed, hoursAvailable: available });
    }
  }

  // ---------------------------------------------------------------- 4. Each professor's week
  const facultyByRef = new Map(faculty.map(f => [String(f._id), f]));
  const demandsByFaculty = new Map();
  demands.filter(d => d.facultyRef && !d.fixed).forEach(d => demandsByFaculty.set(d.facultyRef, [...(demandsByFaculty.get(d.facultyRef) || []), d]));
  // Phase 4 Part 2 Step 3: each professor's weekday slack, the numbers of docs/benchmarks/phase3/
  // SATURDAY_ANALYSIS.md (free weekday hours = each weekday's window minus the professor's unavailable
  // times, keeping the lunch rule; class hours = the meeting hours of their classes, labs as real hours,
  // self-paced online hours and practicum coordination left out; slack = free − class hours).
  const professorTime = [];
  for (const [ref, list] of demandsByFaculty) {
    const prof = facultyByRef.get(ref);
    const blocks = schedulingUnavailableBlocks(prof, policy);
    const days = [...new Set(list.flatMap(d => d.allowedDays))];
    const available = sum(days, day => usableHoursWithLunch(policy, usableIntervals(policy, day, blocks)));
    const needed = sum(list, hoursOf);
    if (needed > available) {
      add(errors, 'faculty', 'FACULTY_HOURS', `${prof.name}: ${h(needed)} h of classes assigned, but only ${h(available)} h are free in the week (the window minus unavailable times, keeping the lunch rule).`,
        'Reassign a subject on the Assign Faculty page, or shorten an unavailable time on the Faculty page.',
        { facultyName: prof.name, hoursNeeded: needed, hoursFree: available });
    }
    const freeHours = round1(sum(weekdays, day => usableHoursWithLunch(policy, usableIntervals(policy, day, blocks))));
    const classHours = round1(needed);
    professorTime.push({ facultyRef: ref, facultyId: prof.facultyId || null, name: prof.name, employmentType: prof.employmentType || null, freeHours, classHours, slack: round1(freeHours - classHours) });
  }
  professorTime.sort((a, b) => a.slack - b.slack || byText(a.name, b.name));

  // Phase 8 Part 4 (decision 1): the professors under their minimum teaching load, from the term's
  // locks by the one load rule (practicum coordination included, so the number is the load panels').
  // Active professors only; a minimum of 0 never warns.
  const underMinimum = termLoads({ faculty, pairs, locks, policy })
    .filter(f => f.isActive && f.min > 0 && f.underMin > 0)
    .map(f => ({ facultyRef: f.facultyRef, facultyId: f.facultyId || null, name: f.name, teaching: f.teaching, min: f.min, underMin: f.underMin }))
    .sort((a, b) => b.underMin - a.underMin || byText(a.name, b.name));

  // ---------------------------------------------------------------- 5. Every meeting fits its window
  const windowProblems = new Map();
  for (const d of demands) {
    const fits = d.fixed
      ? (() => { const w = windowSlots(policy, d.fixed.day); return Boolean(w) && w.startSlot <= d.fixed.startSlot && d.fixed.startSlot + d.durationSlots <= w.endSlot; })()
      : d.allowedDays.some(day => {
        const w = windowSlots(policy, day);
        if (!w) return false;
        return d.allowedStarts
          ? d.allowedStarts.some(s => w.startSlot <= s && s + d.durationSlots <= w.endSlot)
          : d.durationSlots <= w.endSlot - w.startSlot;
      });
    if (!fits) {
      windowProblems.set(`${d.subjectId}:${d.classType}:${d.durationSlots}`, d.allowedStarts
        ? `${d.subjectCode} lab (${h(hoursOf(d))} h) cannot start at any lab start time inside an allowed day's window.`
        : `${d.subjectCode} ${d.classType} meeting (${h(hoursOf(d))} h) does not fit inside any allowed day's window.`);
    }
  }
  windowProblems.forEach(message => add(errors, 'window', 'WINDOW', message, 'Check the day window, lab start times and meeting rules in the Scheduling Policy.'));

  // ---------------------------------------------------------------- Checks (the technical details)
  const statusOf = (check) => (errors.some(e => e.check === check) ? 'fail' : warnings.some(w => w.check === check) ? 'warn' : 'pass');
  const checks = [
    { id: 'data', title: 'Data is complete', status: statusOf('data'), detail: `${plural(sections.length, 'active section')}, ${plural(pairs.length, 'subject-section pair')}, ${plural(demands.length, 'class meeting')}, ${plural(rooms.length, 'active room')}.` },
    { id: 'lab', title: 'LAB rooms can hold every lab', status: statusOf('lab'), detail: `LAB rooms: ${labLine}.` },
    { id: 'lec', title: 'Lecture rooms can hold every lecture that needs a room', status: statusOf('lec'), detail: `Lecture rooms: ${lecLine}.` },
    { id: 'sections', title: 'Every section\'s week fits', status: statusOf('sections'), detail: `${plural(demandsBySection.size, 'section')} checked against the allowed days, the window and the lunch rule.` },
    { id: 'faculty', title: 'Every professor\'s week fits', status: statusOf('faculty'), detail: `${plural(demandsByFaculty.size, 'assigned professor')} checked against the window, their unavailable times and lunch.` },
    { id: 'window', title: 'Every meeting fits its day\'s window', status: statusOf('window'), detail: `Lab meetings of ${h(labHoursEach)} h start only at ${policy.meetings.labStartTimes.join(', ')}.` }
  ];

  // Ready; Needs extra rooms (every problem is a room shortage, and extra rooms would fix it); Blocked.
  const onlyRoomsShort = errors.length > 0 && errors.every(e => ROOM_SHORTAGE_CODES.includes(e.code));
  const verdict = errors.length === 0 ? 'ready' : onlyRoomsShort && (suggestion?.weekdays || suggestion?.withSaturday) ? 'needs-extra-rooms' : 'blocked';

  // About how many classes the CCS rooms can't hold ("The CCS rooms can't hold N classes"), counted on
  // weekdays: TBA rooms are weekday rooms, and a class in one costs less than a Saturday class, so a run
  // fills them before Saturday. The labs short, plus the fewest meetings (longest first) that cover the
  // shorter labs' and the lectures' hours short. 0 while the CCS rooms hold every class.
  const weekdayCcs = roomSupply({ policy, demands, labRooms: ccsLab, lecRooms: ccsLec, saturdayOn: false });
  const tbaClassesEstimate = !ccsShort ? 0 : weekdayCcs.labShort
    + fewestMeetingsFor(demands.filter(d => d.classType === 'LAB' && !d.allowedStarts), weekdayCcs.labHoursShort, hoursOf)
    + fewestMeetingsFor(demands.filter(d => d.classType === 'LEC' && d.allowedRoomTypes.length > 0), weekdayCcs.lecShort, hoursOf);

  // The distinct active subjects the term's curriculum places (null when the caller gave no placements).
  const subjectsPlaced = Array.isArray(termMappings)
    ? new Set(termMappings.map(m => m.subject).filter(s => s && s.isActive !== false).map(s => String(s._id))).size
    : null;

  const readiness = buildReadiness({
    policy, mode, errors, warnings, sections, noProfessor, subjectsPlaced, semesterLabel, academicYear, policySaved,
    ccsShort, suggestion, online, tbaClassesEstimate, extraLab, extraLec, professorTime, underMinimum, saturdayOn,
    // Phase 4 Part 4: the CCS rooms alone against the term, for the rooms line's "How we know".
    rooms: { ccsLab: ccsLab.length, ccsLec: ccsLec.length, supply: ccsSupply }
  });

  return {
    ok: errors.length === 0,
    verdict,
    errors,
    warnings,
    info,
    checks,
    // Phase 4 Part 2 Step 3: each assigned professor's weekday free hours, class hours and slack, the
    // tightest first (the Readiness line 8 and "Technical details").
    professorTime,
    // Phase 8 Part 4: the professors under their minimum teaching load (the Readiness ⚠ line).
    underMinimum,
    extraRooms: {
      // How the TBA rooms are set (Phase 3 Step 4) and the counts this check (and the next run) uses:
      // lab/lec and resolved are the same numbers, the rooms the policy given to the check carries.
      mode,
      enabled: Boolean(policy.overflowRooms?.enabled),
      lab: extraLab,
      lec: extraLec,
      // The smallest counts that make the arithmetic fit when the CCS rooms alone are short (null
      // otherwise): { weekdays: { lab, lec }, withSaturday: { lab, lec } | null, note }.
      suggestion,
      resolved: { lab: extraLab, lec: extraLec },
      // Phase 8 Part 5: the headroom rule's settings, the measured weekday fullness and what it
      // added (resolveTbaRooms wrote it into the resolved policy this check received).
      headroom: policy.overflowRooms?.headroom || null,
      // Phase 3 Step 7: the online option while the CCS rooms are short (null otherwise; onlineOption):
      // { hours, coveredHours, weekdaysAfter, subjects: [{ subjectId, subjectCode, subjectTitle,
      // lectureHours, sections }], fix }.
      online
    },
    // A Scheduling Policy document is stored (Readiness line 7).
    policySaved: Boolean(policySaved),
    // The Term Checklist's "Data complete: 20 sections, 96 subjects, 21 professors, 6 rooms".
    dataLine: {
      sections: sections.length,
      subjects: subjectsPlaced ?? new Set(pairs.map(p => String(p.subject._id))).size,
      professors: faculty.length,
      rooms: rooms.length
    },
    readiness,
    numbers: {
      sections: sections.length,
      pairs: pairs.length,
      demands: demands.length,
      practicumPairs,
      // Phase 3 Step 7: the Major lecture hours held online (scheduled), self-paced, and the self-paced pairs.
      lecHoursOnline,
      lecHoursSelfPaced,
      selfPacedPairs: selfPaced.length,
      // Phase 3 Step 4, per (section, subject) pair (utils/termAssignments.js assignmentCounts).
      assignment,
      tbaClassesEstimate,
      labsNeeded,
      labBlocksWeekday: weekdayLabBlocks,
      labBlocksSaturdayUsable: saturdayLabsUsable,
      labsFit,
      labShort,
      lecHoursNeeded: lecNeeded,
      lecHoursMajor: majorHours,
      lecHoursMinor: minorHours,
      lecHoursWeekday: weekdayLecHours,
      lecHoursSaturdayUsable: saturdayLecUsable,
      labHoursLeftForMajors: labForMajors,
      lecHoursAvailable: lecAvailable,
      lecShortHours: lecShort
    }
  };
};

// roomIntervals and hoursOn also give the Room Program its hours available (utils/scheduleOutputs.js).
// resolveTbaRooms is called by loadTermInputs only (utils/termInputs.js). usableIntervals and
// usableHoursWithLunch also give the part-time balance its free-weekday-hours rule (Phase 8,
// controllers/partTimeLoadsController.js), the same arithmetic as the Readiness Check's line 8.
module.exports = { runPreflight, resolveTbaRooms, headroomCause, weekdayRoomFullness, ccsRoomSuggestion, trackProblem, roomSupply, smallestExtraRooms, roomIntervals, hoursOn, usableIntervals, usableHoursWithLunch };
