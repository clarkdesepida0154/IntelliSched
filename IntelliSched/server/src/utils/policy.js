// The one SchedulingPolicy: defaults, merging and validation. Every day, hour, lunch, meeting and
// load number the scheduler uses is read from here; nothing else may hard-code them.
// The defaults come from three past semesters of Teachers' Programs (docs/data/PAST_SCHEDULES_ANALYSIS.md).
const { DAY_NAMES, WEEKDAY_NAMES, isTime, isOnGrid, toMinutes, fromMinutes, formatTime12 } = require('./timeGrid');

const deepFreeze = (obj) => {
  Object.values(obj).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(obj);
};

const POLICY_DEFAULTS = deepFreeze({
  slotMinutes: 30,
  // Phase 8 (the Dean, 6 Oct 2026): classes run 08:00–17:00 and never start at 7:00. A stored policy
  // keeps its own hours; the term loader offers the new defaults where the stored policy still holds
  // the old ones.
  dayStart: '08:00',
  dayEnd: '17:00',
  weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  nstp: { day: 'Saturday', start: '08:00', end: '12:00', yearLevels: [1] },
  // Phase 8: no Saturday classes except NSTP. The overflow stays a switch, off by default.
  saturdayOverflow: { enabled: false, yearLevels: [2, 3], start: '08:00', end: '17:00' },
  lunch: { enabled: true, windowStart: '10:00', windowEnd: '15:00', minFreeMinutes: 60 },
  meetings: {
    lectureMaxMeetingHours: 2,
    threeHourLecture: { MAJOR: [3], MINOR: [2, 1] },
    labMaxMeetingHours: 3,
    labStartTimes: ['08:00', '11:00', '14:00'],
    sameSubjectDifferentDays: true,
    // Phase 8 Part 6 (decision 5c): a part-time professor never has a weekday with exactly one class
    // meeting (they come to campus only for their classes) — a hard rule (HC10) while on. A part-timer
    // whose lone day cannot be avoided is exempt (constraints.js partTimerExempt). On by default;
    // a version saved before the rule existed is judged without it (versionCheck.js). Advanced, so
    // a term that cannot be generated with it can switch it off.
    partTimerNoSingleDay: true
  },
  rooms: { majorLectureInLab: 'PENALTY', enforceCapacity: false },
  load: {
    labFactor: { FULL_TIME: 1.0, PART_TIME: 0.75 },
    standardWeeklyHours: 40,
    // Phase 8 Part 2 (decision F2): the standard FULL-TIME teaching load, information only — the load
    // panels and the Teachers' Program view read "Standard load: 18 h" and call full-time teaching
    // above it "Overload: N h". The caps still gate assignments; nothing changes on the printed SF-029.
    standardTeachingHours: 18,
    ojtCoordinatorHours: 6,
    defaultTeachingCap: { FULL_TIME: 21, PART_TIME: 40 },
    // Phase 8 Part 4 (decision 1): the default MINIMUM teaching load per employment type — the
    // Secretary wants every professor's load in a range, so each profile has a minimum next to the
    // cap. A full-timer's default is lowered by their Management Function hours, never below 0
    // (utils/load.js minTeachingHoursOf); the profile's own minTeachingHours wins over the default.
    // A load below the minimum is a Readiness warning and a balance target, never a blocker.
    defaultMinTeachingHours: { FULL_TIME: 18, PART_TIME: 18 },
    standardAncillary: { RESEARCH: 10, EXTENSION: 8, CEE: 2, CONSULTATION: 2 }
  },
  // Sanity cap on a subject's weekly lecture hours and on its lab hours (practicum exempt).
  catalog: { maxWeeklyHoursPerType: 5 },
  // Phase 8 Part 4 (decision 4): "Full-time faculty's day for Extension" — a weekday the schedule
  // keeps class-free for every full-timer (the office's practice is Friday: on the 17 undergraduate
  // forms of 2nd Sem AY 2025-26 no full-timer teaches on Friday), or 'none'. The GA request marks
  // the day unavailable for the professor, like any unavailable time (facultyAvailability.js
  // schedulingUnavailableBlocks), so the GA itself is unchanged; the duty fill then puts EXTENSION
  // there and the OJT placement avoids it. Each professor can override it on the Faculty page.
  // 'none' by default so every stored policy, fixture and recorded request stays as it was; the
  // real term's file sets Friday through its policy block.
  extensionDay: 'none',
  // Phase 4 Part 1: classes may start at the day's start (07:00), but a start before this time costs
  // the earlyStart penalty (Advanced). A saved policy without it reads 08:00.
  preferredEarliestStart: '08:00',
  // Soft-rule weights (Phase 2 Step 2), per occurrence: a Saturday class block, a Major lecture in a
  // LAB room, a class in an extra room (cheaper than Saturday, so extra weekday rooms come first), an
  // idle hour in a section's day, an idle hour in a professor's day; Phase 4 Part 1: each TBA room that
  // holds at least one class (so the GA packs TBA classes into as few TBA rooms as it can), and each
  // class that starts before preferredEarliestStart. The two Phase 4 defaults come from the rooms
  // benchmark (docs/benchmarks/phase4/ROOMS_BENCHMARK.md: 50 is the smallest weight that reached the
  // fewest TBA rooms in 2 of 3 seeds without raising the Saturday blocks; 5 lowered the early starts);
  // a saved policy without them reads these. Phase 8 Part 5: each weekday on which a professor has
  // exactly one class meeting (facultySingleClassDay: the College Secretary does not want a professor
  // coming to school for one class) and, lighter, each weekday on which a section has one
  // (sectionSingleClassDay); the two defaults come from the Part 5 tuning runs (PHASE8_PROGRESS.md,
  // "Part 5", Step 3: the smallest weights that cut the single-class days the most while seeds 1–5
  // stay conflict-free); a saved policy without them reads these. The golden cases and the
  // full-college fixture pin their own era's weights, so they never move with these defaults.
  softWeights: { saturdayBlock: 50, lectureInLab: 10, sectionGapHour: 5, facultyGapHour: 2, overflowRoomBlock: 30, tbaRoomUsed: 50, earlyStart: 5, facultySingleClassDay: 10, fullTimerSingleClassDay: 0, sectionSingleClassDay: 3 },
  // Odd and even weeks (Phase 8, the office's practice when rooms are short). Two week groups, set by
  // program and year level: a group meets face-to-face in its own weeks and online in the other weeks,
  // AT THE SAME TIMES. So a room may hold one class from each group at the same hour; a professor and
  // a section can still never be double-booked. The Dean's plain setting ("When the rooms are short:
  // Alternate odd and even weeks (Recommended) / Use TBA rooms only"); the group table is editable. On
  // by default, with the office's groups; TBA rooms stay only as the last resort. A section whose
  // program and year are not in the table meets every week (its classes share a room with nobody).
  weekGroups: {
    enabled: true,
    groups: [
      { program: 'BSIT', yearLevel: 1, weeks: 'ODD' },
      { program: 'BSIT', yearLevel: 2, weeks: 'EVEN' },
      { program: 'BSIT', yearLevel: 3, weeks: 'ODD' },
      { program: 'BSIT', yearLevel: 4, weeks: 'EVEN' },
      { program: 'BSCS', yearLevel: 1, weeks: 'EVEN' },
      { program: 'BSCS', yearLevel: 2, weeks: 'ODD' },
      { program: 'BSCS', yearLevel: 3, weeks: 'EVEN' },
      { program: 'BSCS', yearLevel: 4, weeks: 'ODD' }
    ]
  },
  // TBA rooms (Phase 2's "extra rooms"): virtual rooms EXTRA-LAB-1..lab and EXTRA-LEC-1..lec stand for
  // rooms the Dean must request from outside CCS (utils/gaRequest.js extraRoomsOf reads enabled, lab and
  // lec). Phase 3 Step 4: `mode` says how a run gets them:
  //   'auto'   (the default) before each run the counts are set to the Readiness Check's weekday
  //            suggestion for the CCS rooms, plus one room of each type it needs;
  //   'manual' the saved lab and lec counts;
  //   'off'    none.
  // The mode is resolved in ONE place, loadTermInputs (utils/termInputs.js, with preflight.js
  // resolveTbaRooms): the Readiness Check, a run's request, its save-time hash and the policySnapshot a
  // version stores all carry the resolved { mode, enabled, lab, lec }. A saved policy without `mode`
  // reads as 'auto', because mergePolicy fills a missing key with its default; this holds even for one
  // saved with enabled: false, as Phase 2's demo:full did. TBA rooms are automatic unless Advanced
  // chose otherwise.
  // Phase 8 Part 5 (decision 2a, headroom): in auto mode, when a room type would be MORE than
  // `headroom.percent` % full in the policy's weekday hours (counted the way the rooms arithmetic
  // counts, lectures in lab rooms included; per week group while the odd/even switch is on) and the
  // suggestion gave that type no TBA room, the gateway gives the GA one TBA room of that type anyway:
  // an arithmetic that fits with one spare hour (the real term without its week groups needs 314 of
  // the rooms' 315) leaves the GA no room to untangle, and the TBA-room penalty keeps the extra room
  // empty when it is not needed. On by default; a saved policy without it reads these; only
  // "Advanced (system team)" edits it.
  overflowRooms: { mode: 'auto', enabled: false, lab: 0, lec: 0, headroom: { enabled: true, percent: 85 } }
});

// The most extra (TBA) rooms of one type the policy accepts.
const MAX_EXTRA_ROOMS = 20;
// How a run gets its TBA rooms (overflowRooms.mode).
const TBA_ROOM_MODES = ['auto', 'manual', 'off'];

const MAJOR_LECTURE_IN_LAB = ['NEVER', 'PENALTY', 'FREE'];
const NSTP_DAYS = ['Saturday', 'Sunday'];
// Odd and even weeks (Phase 8): the values a week-group row may take.
const WEEK_GROUP_PROGRAMS = ['BSIT', 'BSCS'];
const WEEK_GROUP_WEEKS = ['ODD', 'EVEN'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// A fresh, mutable copy of the defaults.
const defaultPolicy = () => clone(POLICY_DEFAULTS);
// Phase 8 Part 8 (decision 3f): what "Reset to defaults" restores — the defaults, with Friday kept as
// the office's Extension day. A stored policy without the field still reads as the default ('none'), so
// stored policies and fixtures stay as they were; only the values a reset saves carry the office's day.
const RESET_EXTENSION_DAY = 'Friday';
const resetPolicy = () => ({ ...defaultPolicy(), extensionDay: RESET_EXTENSION_DAY });

// Deep-merges `patch` onto `base`, keeping only the keys the defaults define (anything else is
// dropped). Arrays and scalars replace; objects merge key by key.
const mergeInto = (shape, base, patch) => {
  const out = {};
  for (const key of Object.keys(shape)) {
    const baseValue = base?.[key];
    const patchValue = patch?.[key];
    if (isPlainObject(shape[key])) {
      out[key] = mergeInto(shape[key], isPlainObject(baseValue) ? baseValue : shape[key], isPlainObject(patchValue) ? patchValue : undefined);
    } else if (patchValue !== undefined) {
      out[key] = clone(patchValue);
    } else if (baseValue !== undefined) {
      out[key] = clone(baseValue);
    } else {
      out[key] = clone(shape[key]);
    }
  }
  return out;
};

const mergePolicy = (base, patch) => mergeInto(POLICY_DEFAULTS, base, patch);

// Returns [{ field, message }] in plain words; an empty list means the policy is usable.
// plainOnly: the one saving may change only the plain settings (anyone without advanced.edit, Phase 3
// Step 4; policyController.updatePolicy). A problem such a save can cause in an Advanced setting is then
// named next to the plain setting that caused it, with what they can do about it: the class day's start
// and end against the lab start times (an Advanced setting they cannot see or change).
const ORDINAL_SUFFIX = { 1: 'st', 2: 'nd', 3: 'rd' };

const validatePolicy = (p, { plainOnly = false } = {}) => {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const slot = POLICY_DEFAULTS.slotMinutes;

  if (p.slotMinutes !== slot) add('slotMinutes', `The slot length is fixed at ${slot} minutes.`);

  const checkTime = (field, value) => {
    if (!isTime(value)) { add(field, 'Enter a time as HH:MM (24-hour), for example 07:00 or 13:30.'); return false; }
    if (!isOnGrid(value, slot)) { add(field, `Times must fall on a ${slot}-minute boundary (:00 or :30).`); return false; }
    return true;
  };
  const checkRange = (startField, start, endField, end, what) => {
    const okStart = checkTime(startField, start);
    const okEnd = checkTime(endField, end);
    if (okStart && okEnd && toMinutes(start) >= toMinutes(end)) add(endField, `${what} must end after it starts.`);
  };
  const checkYearLevels = (field, value) => {
    if (!Array.isArray(value) || value.some(y => !Number.isInteger(y) || y < 1 || y > 4)) add(field, 'Year levels must be whole numbers from 1 to 4.');
    else if (new Set(value).size !== value.length) add(field, 'Each year level may appear only once.');
  };
  const checkHalfStep = (field, value, { min = 0, max = Infinity, allowZero = true } = {}) => {
    const ok = typeof value === 'number' && Number.isFinite(value) && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9 &&
      value >= min && value <= max && (allowZero || value > 0);
    if (!ok) add(field, `Enter a number of hours in steps of 0.5${Number.isFinite(max) ? `, from ${allowZero ? min : 'above ' + min} to ${max}` : ''}.`);
    return ok;
  };
  const checkBool = (field, value) => { if (typeof value !== 'boolean') add(field, 'Choose on or off.'); };
  const checkNonNegative = (field, value, { integer = false } = {}) => {
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value));
    if (!ok) add(field, integer ? 'Enter a whole number, 0 or more.' : 'Enter a number, 0 or more.');
  };

  // Days & hours
  checkRange('dayStart', p.dayStart, 'dayEnd', p.dayEnd, 'The class day');
  if (!Array.isArray(p.weekdays) || p.weekdays.length === 0) add('weekdays', 'Choose at least one weekday.');
  else if (p.weekdays.some(d => !WEEKDAY_NAMES.includes(d))) add('weekdays', 'Weekdays must be Monday to Friday.');
  else if (new Set(p.weekdays).size !== p.weekdays.length) add('weekdays', 'Each weekday may appear only once.');

  if (!NSTP_DAYS.includes(p.nstp?.day)) add('nstp.day', 'NSTP meets on Saturday or Sunday.');
  checkRange('nstp.start', p.nstp?.start, 'nstp.end', p.nstp?.end, 'The NSTP block');
  checkYearLevels('nstp.yearLevels', p.nstp?.yearLevels);

  checkBool('saturdayOverflow.enabled', p.saturdayOverflow?.enabled);
  checkYearLevels('saturdayOverflow.yearLevels', p.saturdayOverflow?.yearLevels);
  checkRange('saturdayOverflow.start', p.saturdayOverflow?.start, 'saturdayOverflow.end', p.saturdayOverflow?.end, 'The Saturday window');
  if (p.nstp?.day === 'Saturday' && [p.nstp.start, p.nstp.end, p.saturdayOverflow?.start, p.saturdayOverflow?.end].every(isTime) &&
      (toMinutes(p.nstp.start) < toMinutes(p.saturdayOverflow.start) || toMinutes(p.nstp.end) > toMinutes(p.saturdayOverflow.end))) {
    add('nstp.end', 'The NSTP block must fit inside the Saturday window.');
  }

  // Lunch
  checkBool('lunch.enabled', p.lunch?.enabled);
  checkRange('lunch.windowStart', p.lunch?.windowStart, 'lunch.windowEnd', p.lunch?.windowEnd, 'The lunch window');
  const free = p.lunch?.minFreeMinutes;
  if (!Number.isInteger(free) || free <= 0 || free % slot !== 0) add('lunch.minFreeMinutes', `Enter the free time in minutes, a multiple of ${slot} (for example 60).`);
  else if (isTime(p.lunch?.windowStart) && isTime(p.lunch?.windowEnd) && free > toMinutes(p.lunch.windowEnd) - toMinutes(p.lunch.windowStart)) {
    add('lunch.minFreeMinutes', 'The free time cannot be longer than the lunch window.');
  }

  // Meetings
  const m = p.meetings || {};
  checkHalfStep('meetings.lectureMaxMeetingHours', m.lectureMaxMeetingHours, { min: 0.5, max: 5 });
  for (const kind of ['MAJOR', 'MINOR']) {
    const parts = m.threeHourLecture?.[kind];
    const ok = Array.isArray(parts) && parts.length > 0 &&
      parts.every(h => typeof h === 'number' && h > 0 && Math.abs(h * 2 - Math.round(h * 2)) < 1e-9) &&
      Math.abs(parts.reduce((a, b) => a + b, 0) - 3) < 1e-9;
    if (!ok) add(`meetings.threeHourLecture.${kind}`, 'The meetings of a 3-hour lecture must add up to 3 hours, in steps of 0.5.');
  }
  const labMaxOk = checkHalfStep('meetings.labMaxMeetingHours', m.labMaxMeetingHours, { min: 0.5, max: 5 });
  if (!Array.isArray(m.labStartTimes) || m.labStartTimes.length === 0) add('meetings.labStartTimes', 'Add at least one lab start time.');
  else {
    m.labStartTimes.forEach((t, i) => checkTime(`meetings.labStartTimes.${i}`, t));
    if (new Set(m.labStartTimes).size !== m.labStartTimes.length) add('meetings.labStartTimes', 'Each lab start time may appear only once.');
    if (labMaxOk && isTime(p.dayStart) && isTime(p.dayEnd)) {
      const hours = m.labMaxMeetingHours;
      const starts = m.labStartTimes.filter(isTime);
      const endOf = (t) => toMinutes(t) + hours * 60;
      const early = starts.filter(t => toMinutes(t) < toMinutes(p.dayStart));
      const late = starts.filter(t => endOf(t) > toMinutes(p.dayEnd));
      if (!plainOnly) {
        const outside = starts.filter(t => early.includes(t) || late.includes(t));
        if (outside.length) add('meetings.labStartTimes', `A ${hours}-hour lab starting at ${outside.join(', ')} would not fit inside the class day.`);
      } else if (toMinutes(p.dayStart) < toMinutes(p.dayEnd)) {
        // Only the day's hours can have moved (the lab start times are Advanced), so the problem is named
        // at the day's start or end (unless that setting already has a problem of its own).
        const noteAt = (field, message) => { if (!errors.some(e => e.field === field)) add(field, message); };
        if (early.length) {
          const first = formatTime12(early.reduce((a, b) => (toMinutes(b) < toMinutes(a) ? b : a)));
          noteAt('dayStart', `A ${hours}-hour lab may start at ${first}, before the class day starts. Keep the class day's start at ${first} or earlier, or change the lab start times under Advanced (system team).`);
        }
        if (late.length) {
          const last = late.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
          const end = formatTime12(fromMinutes(endOf(last)));
          noteAt('dayEnd', `A ${hours}-hour lab starting at ${formatTime12(last)} would end at ${end}, after the class day ends. Keep the class day's end at ${end} or later, or change the lab start times under Advanced (system team).`);
        }
      }
    }
  }
  checkBool('meetings.sameSubjectDifferentDays', m.sameSubjectDifferentDays);
  checkBool('meetings.partTimerNoSingleDay', m.partTimerNoSingleDay);

  // The preferred earliest start (Phase 4 Part 1): a time on the grid, at or after the grid origin (the
  // earliest start of any window), so its slot is never negative in the GA request.
  if (checkTime('preferredEarliestStart', p.preferredEarliestStart) && [p.dayStart, p.saturdayOverflow?.start, p.nstp?.start].every(isTime)
      && toMinutes(p.preferredEarliestStart) < Math.min(toMinutes(p.dayStart), toMinutes(p.saturdayOverflow.start), toMinutes(p.nstp.start))) {
    add('preferredEarliestStart', 'Choose a time at or after the earliest class start (the class day, the Saturday window or the NSTP block).');
  }

  // Rooms
  if (!MAJOR_LECTURE_IN_LAB.includes(p.rooms?.majorLectureInLab)) add('rooms.majorLectureInLab', 'Choose Never, With a penalty, or Freely.');
  checkBool('rooms.enforceCapacity', p.rooms?.enforceCapacity);

  // Load
  const load = p.load || {};
  for (const type of ['FULL_TIME', 'PART_TIME']) {
    const f = load.labFactor?.[type];
    if (typeof f !== 'number' || !(f > 0 && f <= 1)) add(`load.labFactor.${type}`, 'The lab factor must be above 0 and at most 1.');
    checkHalfStep(`load.defaultTeachingCap.${type}`, load.defaultTeachingCap?.[type], { min: 0, max: 40 });
    // Phase 8 Part 4: the default minimum teaching load sits inside the cap's own range.
    checkHalfStep(`load.defaultMinTeachingHours.${type}`, load.defaultMinTeachingHours?.[type], { min: 0, max: 40 });
    if (typeof load.defaultMinTeachingHours?.[type] === 'number' && typeof load.defaultTeachingCap?.[type] === 'number'
        && load.defaultMinTeachingHours[type] > load.defaultTeachingCap[type]) {
      add(`load.defaultMinTeachingHours.${type}`, 'The default minimum cannot be above the default teaching cap.');
    }
  }
  checkHalfStep('load.standardWeeklyHours', load.standardWeeklyHours, { min: 0.5, max: 80 });
  checkHalfStep('load.standardTeachingHours', load.standardTeachingHours, { min: 0.5, max: 40 });
  checkHalfStep('load.ojtCoordinatorHours', load.ojtCoordinatorHours, { min: 0, max: 40 });
  for (const type of ['RESEARCH', 'EXTENSION', 'CEE', 'CONSULTATION']) {
    checkHalfStep(`load.standardAncillary.${type}`, load.standardAncillary?.[type], { min: 0, max: 20 });
  }

  // Catalog
  checkHalfStep('catalog.maxWeeklyHoursPerType', p.catalog?.maxWeeklyHoursPerType, { min: 0.5, max: 20 });

  // Full-time faculty's day for Extension (Phase 8 Part 4): a weekday the policy's week has, or none.
  if (p.extensionDay !== 'none' && !WEEKDAY_NAMES.includes(p.extensionDay)) {
    add('extensionDay', 'Choose a weekday for the full-time faculty\'s Extension day, or none.');
  } else if (p.extensionDay !== 'none' && Array.isArray(p.weekdays) && !p.weekdays.includes(p.extensionDay)) {
    add('extensionDay', `${p.extensionDay} is not one of the chosen weekdays.`);
  }

  // Odd and even weeks (Phase 8)
  checkBool('weekGroups.enabled', p.weekGroups?.enabled);
  const groups = p.weekGroups?.groups;
  if (!Array.isArray(groups)) add('weekGroups.groups', 'The week groups must be a list of program, year level and weeks.');
  else {
    const seen = new Set();
    groups.forEach((g, i) => {
      if (!WEEK_GROUP_PROGRAMS.includes(g?.program)) add(`weekGroups.groups.${i}.program`, 'The program must be BSIT or BSCS.');
      if (!Number.isInteger(g?.yearLevel) || g.yearLevel < 1 || g.yearLevel > 4) add(`weekGroups.groups.${i}.yearLevel`, 'The year level must be a whole number from 1 to 4.');
      if (!WEEK_GROUP_WEEKS.includes(g?.weeks)) add(`weekGroups.groups.${i}.weeks`, 'Choose Odd weeks or Even weeks.');
      const key = `${g?.program}|${g?.yearLevel}`;
      if (seen.has(key)) add('weekGroups.groups', `${g.program} ${g.yearLevel}${ORDINAL_SUFFIX[g.yearLevel] || 'th'} year appears more than once in the week groups.`);
      seen.add(key);
    });
  }

  // Soft weights and TBA rooms
  for (const key of Object.keys(POLICY_DEFAULTS.softWeights)) checkNonNegative(`softWeights.${key}`, p.softWeights?.[key]);
  if (!TBA_ROOM_MODES.includes(p.overflowRooms?.mode)) add('overflowRooms.mode', 'Choose Automatic, Manual counts or Off for the TBA rooms.');
  checkBool('overflowRooms.enabled', p.overflowRooms?.enabled);
  for (const type of ['lab', 'lec']) {
    const n = p.overflowRooms?.[type];
    if (!(Number.isInteger(n) && n >= 0 && n <= MAX_EXTRA_ROOMS)) add(`overflowRooms.${type}`, `Enter a whole number of TBA ${type === 'lab' ? 'lab' : 'lecture'} rooms, from 0 to ${MAX_EXTRA_ROOMS}.`);
  }
  // The headroom rule (Phase 8 Part 5): on/off and the fullness level that adds one TBA room.
  checkBool('overflowRooms.headroom.enabled', p.overflowRooms?.headroom?.enabled);
  const headroomPercent = p.overflowRooms?.headroom?.percent;
  if (!(Number.isInteger(headroomPercent) && headroomPercent >= 50 && headroomPercent <= 100)) {
    add('overflowRooms.headroom.percent', 'Enter the fullness level as a whole number of percent, from 50 to 100.');
  }

  return errors;
};

// Phase 3 Step 4: the settings the Dean may change on the Scheduling Policy page (the days, the hours,
// the lunch rule and Saturday on or off). Every other setting is "Advanced (system team)", which only
// only advanced.edit may change: the slot length, NSTP, the Saturday window and years, meetings, rooms,
// load, the catalog limit, the penalty weights and the TBA rooms' manual counts.
// Phase 4 Part 4 (rooms the Dean's way): the choice "When the CCS rooms are full: put the extra classes in
// TBA rooms (automatic) / use only the CCS rooms (off)" is plain too (overflowRooms.mode between 'auto'
// and 'off', with the `enabled` flag that follows it); "manual" and the counts stay Advanced.
// Phase 8: the odd/even week groups are the Dean's plain setting too ("When the rooms are short:
// Alternate odd and even weeks / Use TBA rooms only", with the editable group table).
// Phase 8 Part 4: so is the full-time faculty's day for Extension (the office's own practice).
const PLAIN_POLICY_FIELDS = ['weekdays', 'dayStart', 'dayEnd', 'lunch', 'saturdayOverflow.enabled', 'weekGroups', 'extensionDay'];
const PLAIN_TBA_MODES = ['auto', 'off'];
const isPlainPolicyField = (path) => PLAIN_POLICY_FIELDS.some(f => path === f || path.startsWith(`${f}.`));
const isPlainTbaChange = (path, before, after) => ['overflowRooms.mode', 'overflowRooms.enabled'].includes(path)
  && PLAIN_TBA_MODES.includes(before?.overflowRooms?.mode ?? 'auto') && PLAIN_TBA_MODES.includes(after?.overflowRooms?.mode ?? 'auto');
// The Advanced groups in the words of the refusal ("Only the Dean can change ...").
const ADVANCED_GROUP_LABELS = {
  slotMinutes: 'the slot length',
  nstp: 'the NSTP block',
  saturdayOverflow: 'the Saturday window and years',
  meetings: 'the meeting rules',
  preferredEarliestStart: 'the preferred earliest start',
  rooms: 'the room rules',
  load: 'the faculty load rules',
  catalog: 'the weekly hour limit per subject',
  softWeights: 'the penalty weights',
  overflowRooms: 'the TBA rooms'
};

// The settings (dotted paths; a list counts as one setting) whose VALUES differ between two policies.
// Both are normalized first, so a list sent in another order is not a change. Values are compared, not
// the keys a request carried: the page's Reset sends every default.
const changedPolicyFields = (before, after) => {
  const a = normalizePolicy(mergePolicy(before, undefined));
  const b = normalizePolicy(mergePolicy(after, undefined));
  const changed = [];
  const walk = (shape, x, y, prefix) => {
    for (const key of Object.keys(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(shape[key])) walk(shape[key], x?.[key], y?.[key], path);
      else if (JSON.stringify(x?.[key]) !== JSON.stringify(y?.[key])) changed.push(path);
    }
  };
  walk(POLICY_DEFAULTS, a, b, '');
  return changed;
};
// The Advanced settings a save would change: [] when it changes only plain settings (or nothing).
const advancedPolicyChanges = (before, after) => {
  const a = mergePolicy(before, undefined);
  const b = mergePolicy(after, undefined);
  return changedPolicyFields(before, after).filter(path => !isPlainPolicyField(path) && !isPlainTbaChange(path, a, b));
};
// "the penalty weights, the TBA rooms": each changed Advanced group once, in the policy's order.
const describeAdvancedChanges = (paths) => [...new Set(paths.map(p => p.split('.')[0]))].map(group => ADVANCED_GROUP_LABELS[group] || group).join(', ');

// Stored day lists keep the calendar order, whatever order the client sent.
const byNumber = (a, b) => a - b;
const normalizePolicy = (p) => ({
  ...p,
  weekdays: Array.isArray(p.weekdays) ? DAY_NAMES.filter(d => p.weekdays.includes(d)) : p.weekdays,
  nstp: { ...p.nstp, yearLevels: Array.isArray(p.nstp?.yearLevels) ? [...p.nstp.yearLevels].sort(byNumber) : p.nstp?.yearLevels },
  saturdayOverflow: {
    ...p.saturdayOverflow,
    yearLevels: Array.isArray(p.saturdayOverflow?.yearLevels) ? [...p.saturdayOverflow.yearLevels].sort(byNumber) : p.saturdayOverflow?.yearLevels
  },
  meetings: {
    ...p.meetings,
    labStartTimes: Array.isArray(p.meetings?.labStartTimes) ? [...p.meetings.labStartTimes].sort() : p.meetings?.labStartTimes
  },
  weekGroups: {
    ...p.weekGroups,
    groups: Array.isArray(p.weekGroups?.groups)
      ? [...p.weekGroups.groups].sort((a, b) => String(a?.program).localeCompare(String(b?.program)) || (a?.yearLevel ?? 0) - (b?.yearLevel ?? 0))
      : p.weekGroups?.groups
  }
});

// The week group of a section under this policy: 'ODD' | 'EVEN' while the odd/even switch is on and
// the table has a row for the section's program and year, else null (the class meets every week).
// The one place the group of a (program, yearLevel) is read; gaRequest, the outputs, the Readiness
// Check and Fill TBA rooms all go through it. `toProgramCode` is not used here: callers pass the
// section record, whose program may still be the long name, so it is normalized the same way.
const PROGRAM_CODES = { BSIT: 'BSIT', BSCS: 'BSCS', 'BS INFORMATION TECHNOLOGY': 'BSIT', 'BS COMPUTER SCIENCE': 'BSCS' };
const weekGroupOf = (policy, section) => {
  if (!policy?.weekGroups?.enabled || !section) return null;
  const program = PROGRAM_CODES[String(section.program ?? '').trim().toUpperCase()] || String(section.program ?? '').trim().toUpperCase();
  const year = Number(section.yearLevel);
  const row = (policy.weekGroups.groups || []).find(g => g?.program === program && Number(g?.yearLevel) === year);
  return row && WEEK_GROUP_WEEKS.includes(row.weeks) ? row.weeks : null;
};

// The policy every scheduling path reads: the stored document merged over the defaults (so a field
// added later has its default until the Dean saves), or the defaults when none is stored, with
// `persisted` (a document is stored: the Readiness Check's "The Scheduling Policy is saved"). Never writes.
const loadStoredPolicy = async () => {
  const SchedulingPolicy = require('../models/SchedulingPolicy');
  const stored = await SchedulingPolicy.findOne({ key: SchedulingPolicy.ACTIVE_KEY }).lean();
  return { policy: stored ? mergePolicy(stored, undefined) : defaultPolicy(), persisted: Boolean(stored) };
};
const loadPolicy = async () => (await loadStoredPolicy()).policy;

module.exports = {
  POLICY_DEFAULTS,
  MAX_EXTRA_ROOMS,
  TBA_ROOM_MODES,
  MAJOR_LECTURE_IN_LAB,
  NSTP_DAYS,
  WEEK_GROUP_PROGRAMS,
  WEEK_GROUP_WEEKS,
  weekGroupOf,
  PLAIN_POLICY_FIELDS,
  defaultPolicy,
  resetPolicy,
  RESET_EXTENSION_DAY,
  mergePolicy,
  validatePolicy,
  normalizePolicy,
  changedPolicyFields,
  advancedPolicyChanges,
  describeAdvancedChanges,
  loadStoredPolicy,
  loadPolicy
};
