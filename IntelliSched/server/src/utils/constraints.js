// The shared hard and soft constraints, evaluated on a GA request and its placements, all in slots.
// Engine 3 (../intellisched_backend/constraints.py) counts exactly the same way: the golden cases in
// shared/constraint-cases/ run through both. Keep the two in step.
//
// request    = { policy, rooms, faculty, demands } as built by utils/gaRequest.js
// placements = [{ demandId, day, startSlot, roomId | null }]
//
// Hard codes (one violation per):
//   HC1_LUNCH                (section, day) or (faculty, day) with >= 1 class and no continuous free
//                            lunch.minFreeSlots inside the lunch window; TBA faculty are skipped;
//                            Phase 8 Part 8 (decision 4): an outside teacher's (outsideTeacher, day) too
//   HC2_ROOM_TYPE            block whose room type is not allowed, that has a room when none is
//                            required (an online lecture, `online: true`, included), or that has no
//                            room when one is required
//   HC3_ROOM_CLASH / HC3_FACULTY_CLASH / HC3_SECTION_CLASH   overlapping pair (null never clashes);
//                            rooms are told apart by roomId, which for an extra room is its key
//                            (EXTRA-LAB-1 ...), never by name. Phase 8 (odd and even weeks): while
//                            policy.weekGroupsEnabled is true, a ROOM clash counts only between
//                            classes of the same week group (demand.weekGroup); two classes of
//                            different groups may share a room at the same hour (one is on campus in
//                            odd weeks, the other in even weeks). A class without a group meets every
//                            week and clashes with both. Professor and section clashes always count.
//                            Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher
//                            (demand.outsideTeacher, a key of its own: never a facultyRef) clashes
//                            under HC3_FACULTY_CLASH with that teacher's other classes, in any week
//                            group. The lunch hour (HC1) is the teacher's only other rule: no
//                            unavailable times, idle time or single-class days.
//   HC4_FACULTY_UNAVAILABLE  block overlapping one of the professor's unavailable windows
//   HC4_ROOM_UNAVAILABLE     block not fully inside one of the room's windows (rooms with windows)
//   HC4_DAY_NOT_ALLOWED      block on a day not in the demand's allowedDays
//   HC6_CAPACITY             block in a room smaller than the section (enforceCapacity only; skipped
//                            when either number is null)
//   HC7_SAME_DAY             pair of meetings of one meetingGroup on the same day (sameSubjectDifferentDays)
//   HC8_WINDOW               block not inside the policy window of its day (the Saturday window on
//                            Saturday), whether or not the day is allowed for the demand
//   HC9_LAB_START            block whose demand lists allowedStarts and that starts elsewhere
//   HC10_PART_TIMER_SINGLE_DAY  (Phase 8 Part 6, decision 5c) a part-timer's weekday holding exactly
//                            one class meeting, while policy.partTimerSingleDayHard is true (absent on
//                            older requests: the rule is off). One per (professor, weekday), named by
//                            the lone class and carrying facultyRef, name and day, so an edit's check
//                            can tell which day; an exempt part-timer (partTimerExempt) never breaks it.
// Soft terms (Phase 2). Each is counted first and multiplied by its weight (policy.softWeights)
// once, so both languages get the same number:
//   SAT_BLOCK     saturdayBlock     x non-fixed blocks on Saturday
//   LEC_IN_LAB    lectureInLab      x Major LEC blocks in a LAB room, extra LAB rooms included
//                                     (0 when majorLectureInLab is FREE)
//   EXTRA_ROOM    overflowRoomBlock x blocks in an extra room (a room the Dean must request)
//   SECTION_IDLE  sectionGapHour    x idle hours in the sections' days
//   FACULTY_IDLE  facultyGapHour    x idle hours in the professors' days (TBA professors have none)
//   TBA_ROOM      tbaRoomUsed       x extra (TBA) rooms that hold at least one block (Phase 4 Part 1:
//                                     once per room, whatever its number of blocks)
//   EARLY_START   earlyStart        x non-fixed blocks that start before policy.preferredEarliestStartSlot
//                                     (Phase 4 Part 1; on any day; NSTP, a fixed block, is never counted;
//                                     no slot in the policy means no early starts are counted)
//   FACULTY_SINGLE_DAY  facultySingleClassDay  x weekdays on which a professor has exactly one class
//                                     meeting (Phase 8 Part 5: the College Secretary does not want a
//                                     professor coming to school for one class). Saturday and Sunday
//                                     never count (NSTP's Saturday block is excluded by that), and an
//                                     OJT demand (classType 'OJT'; versionCheck adds them for a saved
//                                     version) is not a class meeting here: the records are placed
//                                     after the GA, so the GA and the validator count the same days.
//                                     Phase 8 Part 6 (decision 5a): the weight applies to PART-TIMERS
//                                     (request.faculty[].fullTime false), who come to campus only for
//                                     their classes; a part-timer whose lone day cannot be avoided
//                                     (partTimerExempt: fewer than two class meetings in the week, and
//                                     the two structural cases it names) is exempt, so it neither
//                                     costs nor counts. A FULL-TIMER's
//                                     single-class weekday costs fullTimerSingleClassDay (0 by
//                                     default: they are on campus for their duties). A faculty entry
//                                     without the flag (the pre-Part 6 golden cases) keeps the old
//                                     counting under facultySingleClassDay, with no exemption.
//   SECTION_SINGLE_DAY  sectionSingleClassDay  x weekdays on which a section has exactly one class
//                                     meeting (the lighter penalty of the pair; the same exclusions)
// Idle slots of one (section or professor, day) = (last end - first start) - the slots in class (the
// union of its blocks) - lunch.minFreeSlots when the lunch rule is on, never below 0. Hours = slots x
// slotMinutes / 60. total = SAT_BLOCK + LEC_IN_LAB + EXTRA_ROOM + SECTION_IDLE + FACULTY_IDLE +
// TBA_ROOM + EARLY_START + FACULTY_SINGLE_DAY + SECTION_SINGLE_DAY.

const HARD_CODES = [
  'HC1_LUNCH', 'HC2_ROOM_TYPE', 'HC3_ROOM_CLASH', 'HC3_FACULTY_CLASH', 'HC3_SECTION_CLASH',
  'HC4_FACULTY_UNAVAILABLE', 'HC4_ROOM_UNAVAILABLE', 'HC4_DAY_NOT_ALLOWED', 'HC6_CAPACITY',
  'HC7_SAME_DAY', 'HC8_WINDOW', 'HC9_LAB_START', 'HC10_PART_TIMER_SINGLE_DAY'
];

const SOFT_TERMS = ['SAT_BLOCK', 'LEC_IN_LAB', 'EXTRA_ROOM', 'SECTION_IDLE', 'FACULTY_IDLE', 'TBA_ROOM', 'EARLY_START', 'FACULTY_SINGLE_DAY', 'SECTION_SINGLE_DAY'];

// Single-class days (Phase 8 Part 5) count on these days only: never on Saturday or Sunday.
const WEEKEND_DAYS = new Set(['Saturday', 'Sunday']);

// The slot before which a non-fixed block counts as an early start (policy.preferredEarliestStartSlot),
// or null when the policy carries none (an older request): then nothing is counted.
const earlyStartSlotOf = (policy) => (Number.isInteger(policy.preferredEarliestStartSlot) ? policy.preferredEarliestStartSlot : null);

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// Idle slots in one day: the span from the first start to the last end, minus the slots in class
// (the union of the blocks), minus the lunch allowance; never below 0.
const idleSlots = (blocks, lunchSlots) => {
  if (!blocks.length) return 0;
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const first = sorted[0].start;
  const last = Math.max(...sorted.map(b => b.end));
  let inClass = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].end;
  for (const b of sorted.slice(1)) {
    if (b.start >= curEnd) {
      inClass += curEnd - curStart;
      curStart = b.start;
      curEnd = b.end;
    } else if (b.end > curEnd) curEnd = b.end;
  }
  inClass += curEnd - curStart;
  return Math.max(0, last - first - inClass - lunchSlots);
};

// { SAT_BLOCK, LEC_IN_LAB, EXTRA_ROOM, SECTION_IDLE, FACULTY_IDLE, total } from the counts, each term
// weight x count and the total summed in SOFT_TERMS order (constraints.py does the same).
const softFromCounts = (policy, counts) => {
  const w = policy.softWeights || {};
  const weight = (key) => Number(w[key]) || 0;
  const slotHours = (Number(policy.slotMinutes) || 30) / 60;
  const soft = {
    SAT_BLOCK: weight('saturdayBlock') * counts.saturdayBlocks,
    LEC_IN_LAB: weight('lectureInLab') * counts.lecturesInLab,
    EXTRA_ROOM: weight('overflowRoomBlock') * counts.extraRoomBlocks,
    SECTION_IDLE: weight('sectionGapHour') * (counts.sectionIdleSlots * slotHours),
    FACULTY_IDLE: weight('facultyGapHour') * (counts.facultyIdleSlots * slotHours),
    TBA_ROOM: weight('tbaRoomUsed') * (counts.tbaRoomsUsed || 0),
    EARLY_START: weight('earlyStart') * (counts.earlyStarts || 0),
    FACULTY_SINGLE_DAY: weight('facultySingleClassDay') * ((counts.facultySingleDaysLegacy || 0) + (counts.facultySingleDaysPart || 0))
      + weight('fullTimerSingleClassDay') * (counts.facultySingleDaysFull || 0),
    SECTION_SINGLE_DAY: weight('sectionSingleClassDay') * (counts.sectionSingleDays || 0)
  };
  let total = 0;
  for (const term of SOFT_TERMS) total += soft[term];
  return { ...soft, total };
};

// Phase 8 Part 6: the most class slots one weekday can hold for one person — the widest
// Monday-to-Friday window less the lunch rule's free run when the rule is on (one person's meetings
// never overlap, and the free run lies inside the window). 0 when the policy has no weekday window.
const weekdayCapacity = (policy) => {
  let widest = 0;
  for (const [day, w] of Object.entries(policy.dayWindows || {})) {
    if (!WEEKEND_DAYS.has(day)) widest = Math.max(widest, Number(w.endSlot) - Number(w.startSlot));
  }
  const free = policy.lunch?.enabled ? Number(policy.lunch.minFreeSlots) || 0 : 0;
  return Math.max(0, widest - free);
};

// Phase 8 Part 6 (decisions 5a and 5c): true when a part-timer's class meetings ([{ group, slots }],
// their non-OJT demands) cannot be laid out without a weekday that holds exactly one of them, so
// such a day is exempt — it neither costs, nor counts, nor breaks HC10:
//   - fewer than two meetings in the week;
//   - more meetings of one subject for one section than all their other meetings together (those
//     must fall on different days, so one of their days keeps a meeting alone);
//   - an odd number of meetings when no three of them (three different subjects-for-a-section) fit
//     in one weekday (weekdayCapacity): with an odd number, some day must hold three.
// Engine 3's constraints.py decides the same way.
const partTimerExempt = (meetings, policy) => {
  const n = meetings.length;
  if (n < 2) return true;
  const distinct = Boolean(policy.sameSubjectDifferentDays);
  if (distinct) {
    const sizes = new Map();
    for (const m of meetings) sizes.set(m.group, (sizes.get(m.group) || 0) + 1);
    if (2 * Math.max(...sizes.values()) > n) return true;
  }
  if (n % 2 === 1) {
    const cap = weekdayCapacity(policy);
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (let c = b + 1; c < n; c++) {
          if (distinct && new Set([meetings[a].group, meetings[b].group, meetings[c].group]).size < 3) continue;
          if (meetings[a].slots + meetings[b].slots + meetings[c].slots <= cap) return false;
        }
      }
    }
    return true;
  }
  return false;
};

// Each professor's single-class-day class (Phase 8 Part 6): 'full' (fullTime true), 'part' (false),
// 'exempt' (a part-timer whose lone day cannot be avoided: partTimerExempt) or 'legacy' (no flag:
// the pre-Part 6 counting). A professor missing from request.faculty reads as legacy.
const facultyClassesOf = (request) => {
  const meetings = new Map();
  for (const d of request.demands || []) {
    if (!d.facultyRef || d.classType === 'OJT') continue;
    if (!meetings.has(d.facultyRef)) meetings.set(d.facultyRef, []);
    meetings.get(d.facultyRef).push({ group: d.meetingGroup, slots: Number(d.durationSlots) });
  }
  const classes = new Map();
  for (const f of request.faculty || []) {
    if (f.fullTime === true) classes.set(f.facultyRef, 'full');
    else if (f.fullTime === false) classes.set(f.facultyRef, partTimerExempt(meetings.get(f.facultyRef) || [], request.policy || {}) ? 'exempt' : 'part');
    else classes.set(f.facultyRef, 'legacy');
  }
  return classes;
};

// True when [from, to) holds a continuous free run of at least `need` slots.
const hasFreeRun = (busy, from, to, need) => {
  const clipped = busy
    .map(b => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter(b => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  let cursor = from;
  for (const b of clipped) {
    if (b.start - cursor >= need) return true;
    cursor = Math.max(cursor, b.end);
  }
  return to - cursor >= need;
};

const groupBy = (entries, keyOf) => {
  const groups = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
};

// Every overlapping pair inside each group (entries sorted by start).
const overlappingPairs = (group) => {
  const sorted = [...group].sort((a, b) => a.start - b.start);
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) pairs.push([sorted[i], sorted[j]]);
  }
  return pairs;
};

const evaluatePlacements = (request, placements) => {
  const { policy } = request;
  const demandsById = new Map((request.demands || []).map(d => [d.demandId, d]));
  const roomsById = new Map((request.rooms || []).map(r => [r.roomId, r]));
  const facultyByRef = new Map((request.faculty || []).map(f => [f.facultyRef, f]));

  const violations = [];
  const add = (code, demandIds, message) => violations.push({ code, demandIds, message });
  const counts = { saturdayBlocks: 0, lecturesInLab: 0, extraRoomBlocks: 0, sectionIdleSlots: 0, facultyIdleSlots: 0, tbaRoomsUsed: 0, earlyStarts: 0, facultySingleDaysLegacy: 0, facultySingleDaysPart: 0, facultySingleDaysPartExempt: 0, facultySingleDaysFull: 0, sectionSingleDays: 0 };
  const extraRoomsUsed = new Set();
  const earlyBefore = earlyStartSlotOf(policy);

  // Placed blocks with their demand; placements naming no demand are ignored here (the gateway's
  // completeness check reports them).
  const blocks = [];
  for (const p of placements || []) {
    const d = demandsById.get(p.demandId);
    if (!d) continue;
    blocks.push({ d, day: p.day, start: p.startSlot, end: p.startSlot + d.durationSlots, roomId: p.roomId ?? null });
  }

  for (const b of blocks) {
    const { d } = b;
    const label = `${d.subjectCode} ${d.classType} (${d.sectionCode})`;
    const room = b.roomId === null ? null : roomsById.get(b.roomId) || null;

    // HC2 (a lecture held online, Phase 3 Step 7, is a meeting with no room types)
    const allowed = d.allowedRoomTypes || [];
    if (allowed.length === 0) {
      if (b.roomId !== null) add('HC2_ROOM_TYPE', [d.demandId], d.online ? `${label} is online, so it takes no room.` : `${label} needs no room but was given one.`);
    } else if (b.roomId === null) {
      add('HC2_ROOM_TYPE', [d.demandId], `${label} needs a ${allowed.join(' or ')} room but has none.`);
    } else if (!room || !allowed.includes(room.roomType)) {
      add('HC2_ROOM_TYPE', [d.demandId], `${label} is in ${room ? `${room.roomName} (${room.roomType})` : 'an unknown room'}; allowed: ${allowed.join(' or ')}.`);
    }

    // HC4 faculty
    const prof = d.facultyRef ? facultyByRef.get(d.facultyRef) : null;
    if (prof && (prof.unavailable || []).some(w => w.day === b.day && overlaps(b, { start: w.startSlot, end: w.endSlot }))) {
      add('HC4_FACULTY_UNAVAILABLE', [d.demandId], `${label}: ${prof.name} is unavailable then (${b.day}).`);
    }
    // HC4 room windows
    if (room && (room.availability || []).length > 0
      && !room.availability.some(w => w.day === b.day && w.startSlot <= b.start && b.end <= w.endSlot)) {
      add('HC4_ROOM_UNAVAILABLE', [d.demandId], `${label}: ${room.roomName} is not available then (${b.day}).`);
    }
    // HC4 day
    if (!(d.allowedDays || []).includes(b.day)) {
      add('HC4_DAY_NOT_ALLOWED', [d.demandId], `${label} is on ${b.day}, which is not allowed for it.`);
    }
    // HC6
    if (policy.enforceCapacity && room && room.capacity != null && d.sectionSize != null && room.capacity < d.sectionSize) {
      add('HC6_CAPACITY', [d.demandId], `${label}: ${room.roomName} seats ${room.capacity}, the section has ${d.sectionSize}.`);
    }
    // HC8
    const w = policy.dayWindows?.[b.day];
    if (!w || b.start < w.startSlot || b.end > w.endSlot) {
      add('HC8_WINDOW', [d.demandId], `${label} does not fit inside the ${b.day} window.`);
    }
    // HC9
    if (Array.isArray(d.allowedStarts) && d.allowedStarts.length > 0 && !d.allowedStarts.includes(b.start)) {
      add('HC9_LAB_START', [d.demandId], `${label} starts at a time labs may not start.`);
    }

    // Soft counts
    if (b.day === 'Saturday' && !d.fixed) counts.saturdayBlocks += 1;
    if (d.classType === 'LEC' && !d.isMinor && room && room.roomType === 'LAB' && policy.majorLectureInLab !== 'FREE') counts.lecturesInLab += 1;
    if (room && room.extra) {
      counts.extraRoomBlocks += 1;
      extraRoomsUsed.add(b.roomId);
    }
    if (earlyBefore !== null && !d.fixed && b.start < earlyBefore) counts.earlyStarts += 1;
  }
  counts.tbaRoomsUsed = extraRoomsUsed.size;

  // HC3 clashes: one per overlapping pair on the same day and the same key. Phase 8: a ROOM pair of
  // two different week groups is allowed (skipPair), professor and section pairs always count.
  const weekGroupsOn = policy.weekGroupsEnabled === true;
  const crossGroup = (a, b) => weekGroupsOn && a.d.weekGroup && b.d.weekGroup && a.d.weekGroup !== b.d.weekGroup;
  const clash = (code, keyOf, what, skipPair = null) => {
    for (const group of groupBy(blocks, keyOf).values()) {
      for (const [a, b] of overlappingPairs(group)) {
        if (skipPair && skipPair(a, b)) continue;
        add(code, [a.d.demandId, b.d.demandId], `${what(a)} is double-booked on ${a.day}: ${a.d.subjectCode} (${a.d.sectionCode}) and ${b.d.subjectCode} (${b.d.sectionCode}).`);
      }
    }
  };
  clash('HC3_ROOM_CLASH', b => (b.roomId === null ? null : `${b.roomId}|${b.day}`), b => `Room ${roomsById.get(b.roomId)?.roomName || b.roomId}`, crossGroup);
  clash('HC3_FACULTY_CLASH', b => (b.d.facultyRef ? `${b.d.facultyRef}|${b.day}` : null), b => facultyByRef.get(b.d.facultyRef)?.name || 'A professor');
  // Phase 8 Part 8 (decision 4): an outside teacher, in any week group.
  clash('HC3_FACULTY_CLASH', b => (b.d.outsideTeacher ? `${b.d.outsideTeacher}|${b.day}` : null), b => b.d.outsideTeacherName || 'An outside teacher');
  clash('HC3_SECTION_CLASH', b => (b.d.sectionId ? `${b.d.sectionId}|${b.day}` : null), b => `Section ${b.d.sectionCode}`);

  // HC7: meetings of one subject for one section on the same day.
  if (policy.sameSubjectDifferentDays) {
    for (const group of groupBy(blocks, b => `${b.d.meetingGroup}|${b.day}`).values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          add('HC7_SAME_DAY', [group[i].d.demandId, group[j].d.demandId], `${group[i].d.subjectCode} (${group[i].d.sectionCode}) meets twice on ${group[i].day}.`);
        }
      }
    }
  }

  // HC1 lunch: per (section, day) and (faculty, day) with at least one class.
  const lunch = policy.lunch;
  if (lunch?.enabled) {
    const check = (keyOf, who) => {
      for (const group of groupBy(blocks, keyOf).values()) {
        if (!hasFreeRun(group, lunch.startSlot, lunch.endSlot, lunch.minFreeSlots)) {
          add('HC1_LUNCH', group.map(b => b.d.demandId), `${who(group[0])} has no free lunch hour on ${group[0].day}.`);
        }
      }
    };
    check(b => (b.d.sectionId ? `${b.d.sectionId}|${b.day}` : null), b => `Section ${b.d.sectionCode}`);
    check(b => (b.d.facultyRef ? `${b.d.facultyRef}|${b.day}` : null), b => facultyByRef.get(b.d.facultyRef)?.name || 'A professor');
    // Phase 8 Part 8 (decision 4): an outside teacher keeps the lunch hour too.
    check(b => (b.d.outsideTeacher ? `${b.d.outsideTeacher}|${b.day}` : null), b => b.d.outsideTeacherName || 'An outside teacher');
  }

  // Idle time (soft), per (section, day) and (professor, day); the same groups give the single-class
  // days (Phase 8 Part 5): a weekday whose group holds exactly one class meeting, OJT demands left out.
  const lunchSlots = lunch?.enabled ? Number(lunch.minFreeSlots) || 0 : 0;
  const sectionGroups = groupBy(blocks, b => (b.d.sectionId ? `${b.d.sectionId}|${b.day}` : null));
  const facultyGroups = groupBy(blocks, b => (b.d.facultyRef ? `${b.d.facultyRef}|${b.day}` : null));
  for (const group of sectionGroups.values()) counts.sectionIdleSlots += idleSlots(group, lunchSlots);
  for (const group of facultyGroups.values()) counts.facultyIdleSlots += idleSlots(group, lunchSlots);
  const singleDaysOf = (groups) => {
    let days = 0;
    for (const group of groups.values()) {
      if (WEEKEND_DAYS.has(group[0].day)) continue;
      if (group.filter(b => b.d.classType !== 'OJT').length === 1) days += 1;
    }
    return days;
  };
  counts.sectionSingleDays = singleDaysOf(sectionGroups);
  // Phase 8 Part 6 (decision 5a): the professors' single days by employment type (facultyClassesOf,
  // the exemption from the whole request's non-OJT demands, wherever placed). Every non-exempt
  // part-timer's lone weekday is listed (partTimerSingleDays: the Generate result, the editor's
  // warning) and, while policy.partTimerSingleDayHard is on (5c), is also HC10.
  const classes = facultyClassesOf(request);
  const partTimerSingleDays = [];
  for (const group of facultyGroups.values()) {
    if (WEEKEND_DAYS.has(group[0].day)) continue;
    const meaningful = group.filter(b => b.d.classType !== 'OJT');
    if (meaningful.length !== 1) continue;
    const lone = meaningful[0];
    const cls = classes.get(lone.d.facultyRef) || 'legacy';
    if (cls === 'legacy') counts.facultySingleDaysLegacy += 1;
    else if (cls === 'full') counts.facultySingleDaysFull += 1;
    else if (cls === 'exempt') counts.facultySingleDaysPartExempt += 1;
    else {
      counts.facultySingleDaysPart += 1;
      const name = facultyByRef.get(lone.d.facultyRef)?.name || 'A part-time professor';
      partTimerSingleDays.push({ facultyRef: lone.d.facultyRef, name, day: lone.day, demandId: lone.d.demandId });
      if (policy.partTimerSingleDayHard === true) {
        violations.push({
          code: 'HC10_PART_TIMER_SINGLE_DAY', demandIds: [lone.d.demandId], facultyRef: lone.d.facultyRef, name, day: lone.day,
          message: `${name} (part-time) has only one class on ${lone.day}: ${lone.d.subjectCode} (${lone.d.sectionCode}).`
        });
      }
    }
  }

  const hard = {};
  for (const v of violations) hard[v.code] = (hard[v.code] || 0) + 1;
  const hardTotal = violations.length;
  const soft = softFromCounts(policy, counts);
  const slotHours = (Number(policy.slotMinutes) || 30) / 60;
  return {
    hard,
    hardTotal,
    soft,
    softCounts: {
      saturdayBlocks: counts.saturdayBlocks,
      lecturesInLab: counts.lecturesInLab,
      extraRoomBlocks: counts.extraRoomBlocks,
      sectionIdleHours: counts.sectionIdleSlots * slotHours,
      facultyIdleHours: counts.facultyIdleSlots * slotHours,
      tbaRoomsUsed: counts.tbaRoomsUsed,
      earlyStarts: counts.earlyStarts,
      facultySingleClassDays: counts.facultySingleDaysLegacy + counts.facultySingleDaysPart + counts.facultySingleDaysFull,
      facultySingleClassDaysPartTime: counts.facultySingleDaysPart,
      facultySingleClassDaysFullTime: counts.facultySingleDaysFull,
      sectionSingleClassDays: counts.sectionSingleDays
    },
    fitness: -(100000 * hardTotal + soft.total),
    violations,
    partTimerSingleDays
  };
};

module.exports = { HARD_CODES, SOFT_TERMS, evaluatePlacements, hasFreeRun, idleSlots, softFromCounts, earlyStartSlotOf, weekdayCapacity, partTimerExempt, facultyClassesOf };
