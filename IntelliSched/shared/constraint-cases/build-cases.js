// Writes the golden constraint cases (*.json in this folder). Both the gateway validator
// (server/tests/unit/constraintCases.test.js) and Engine 3's fitness (intellisched_backend
// tests/test_constraint_cases.py) run every case and must report exactly `expected`.
// Run: node shared/constraint-cases/build-cases.js   (then commit the JSON files)
//
// Each case: { name, description, policy, rooms, faculty, demands, placements, expected,
// expectedSoft }, all in the GA request's slot form. `expected` lists only the shared hard codes
// ({} = no violation). `expectedSoft` (Phase 2) is the soft breakdown { SAT_BLOCK, LEC_IN_LAB,
// EXTRA_ROOM, SECTION_IDLE, FACULTY_IDLE, total } both languages must report exactly: worked out by
// hand for the soft-rule cases, and for the others by referenceSoft below, an independent
// implementation (per-slot sets, not the evaluators' interval merging) that is also checked against
// every hand-worked value. Every value is a placeholder test value. Phase 3 Step 7: a case may carry
// `unplaced`, the demand builder's unscheduledItems (self-paced online lectures); both runners then
// check that no demand and no placement is a lecture of such a (section, subject) pair.
const fs = require('fs');
const path = require('path');
const utils = (p) => require(path.resolve(__dirname, '../../server/src/utils', p));
const { defaultPolicy, mergePolicy } = utils('policy');
const { slotOfTime } = utils('timeGrid');
const { buildGaPolicy, buildGaRequest, extraRoomsOf } = utils('gaRequest');

// Phase 8 moved the default weekday window to 08:00, switched Saturday overflow off and switched the
// odd/even week groups on. Cases 1–56 keep the policy they were written under (07:00 window, Saturday
// on, no week groups) — a stored policy may still hold those values, and the rules they test are
// unchanged — so their files stay exactly as committed. The Phase 8 cases (57 on) use the new defaults.
const CASE_BASE = { dayStart: '07:00', saturdayOverflow: { enabled: true, start: '07:00' }, weekGroups: { enabled: false } };
const BASE = mergePolicy(defaultPolicy(), CASE_BASE);
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const slot = (time) => slotOfTime(BASE, time);
const LAB_STARTS = BASE.meetings.labStartTimes.map(slot);
// Phase 8 Part 5 added the single-class-day weights to the policy defaults. Cases 1–61 keep their
// files byte-identical: their policies carry NO single-class-day weights (both evaluators read an
// absent weight as 0), so the two builders below strip the keys mergePolicy fills in. The Part 5
// cases (62 on) use gaPolicyP5, which pins its own test values.
const withoutSingleDayWeights = (policy) => {
  delete policy.softWeights.facultySingleClassDay;
  delete policy.softWeights.sectionSingleClassDay;
  // Phase 8 Part 6 added the full-timers' weight to the defaults; stripping it keeps these files
  // byte-identical (both evaluators read an absent weight as 0).
  delete policy.softWeights.fullTimerSingleClassDay;
  // ... and the part-timers' hard rule (5c, on by default): an absent key reads as off.
  delete policy.partTimerSingleDayHard;
  return policy;
};
const gaPolicy = (patch = {}) => withoutSingleDayWeights(buildGaPolicy(mergePolicy(BASE, patch), 1));
// The Phase 8 defaults (08:00 window, week groups on), for the cases written under them.
const NEW_BASE = defaultPolicy();
const slotNew = (time) => slotOfTime(NEW_BASE, time);
const gaPolicyNew = (patch = {}) => withoutSingleDayWeights(buildGaPolicy(mergePolicy(defaultPolicy(), patch), 1));
const atNew = (d, day, time, roomId = null) => ({ demandId: d.demandId, day, startSlot: slotNew(time), roomId });
// Phase 8 Part 5 (the single-class-day cases): the Phase 8 defaults with the two new weights at
// pinned test values (7 for a professor's day, 3 for a section's: placeholder values, not the
// production defaults, so later tuning never moves these files).
const gaPolicyP5 = (patch = {}) => {
  const policy = buildGaPolicy(mergePolicy(mergePolicy(defaultPolicy(), { softWeights: { facultySingleClassDay: 7, sectionSingleClassDay: 3 } }), patch), 1);
  // The Part 5 files stay byte-identical: no Part 6 key (absent reads as 0, or off).
  delete policy.softWeights.fullTimerSingleClassDay;
  delete policy.partTimerSingleDayHard;
  return policy;
};
// Phase 8 Part 6 (the part-timer scope): the Part 5 pinned values plus the full-timers' weight at a
// pinned test value (4), so the two professor weights can be told apart.
const gaPolicyP6 = (patch = {}) => {
  const policy = buildGaPolicy(mergePolicy(mergePolicy(defaultPolicy(), { softWeights: { facultySingleClassDay: 7, fullTimerSingleClassDay: 4, sectionSingleClassDay: 3 } }), patch), 1);
  // Cases 68-71 test the re-weighting alone (5a): the hard rule's key stays out of them.
  delete policy.partTimerSingleDayHard;
  return policy;
};
// Phase 8 Part 6 (decision 5c): the same pinned weights with the part-timers' hard rule on.
const gaPolicyP6c = (patch = {}) => ({ ...gaPolicyP6(patch), partTimerSingleDayHard: true });

const ROOMS = [
  { roomId: 'room-lec-1', roomName: 'TEST LEC 1', roomType: 'LEC', capacity: 40, availability: [] },
  { roomId: 'room-lec-2', roomName: 'TEST LEC 2', roomType: 'LEC', capacity: 40, availability: [] },
  { roomId: 'room-lab-1', roomName: 'TEST LAB 1', roomType: 'LAB', capacity: null, availability: [] },
  { roomId: 'room-lab-2', roomName: 'TEST LAB 2', roomType: 'LAB', capacity: null, availability: [] }
];

// A demand with sensible defaults: a Major lecture of `hours` for section `sec`, subject `subj`.
const demand = ({ sec = 'sec-a', subj = 'subj-1', type = 'LEC', index = 0, hours = 2, ...rest }) => ({
  demandId: `${sec}:${subj}:${type}:${index}`,
  subjectId: subj,
  subjectCode: `TEST ${subj.toUpperCase()}`,
  sectionId: sec,
  sectionCode: `TEST ${sec.toUpperCase()}`,
  sectionSize: null,
  classType: type,
  meetingGroup: `${sec}:${subj}`,
  durationSlots: hours * 2,
  facultyRef: null,
  isMinor: false,
  requiresRoom: true,
  allowedRoomTypes: type === 'LAB' ? ['LAB'] : ['LEC', 'LAB'],
  allowedDays: WEEK,
  allowedStarts: type === 'LAB' && hours === BASE.meetings.labMaxMeetingHours ? LAB_STARTS : null,
  fixed: null,
  ...rest
});
const lab = (o) => demand({ type: 'LAB', hours: 3, ...o });
const minorLec = (o) => demand({ isMinor: true, allowedRoomTypes: ['LEC'], ...o });
const at = (d, day, time, roomId = null) => ({ demandId: d.demandId, day, startSlot: slot(time), roomId });

// The extra rooms exactly as the demand builder makes them (1 LAB, 1 LEC; a second LAB for clashes).
const EXTRA = extraRoomsOf(mergePolicy(defaultPolicy(), { overflowRooms: { enabled: true, lab: 2, lec: 1 } }));
const WITH_EXTRA = [...ROOMS, ...EXTRA];

// Independent soft reference: occupied slots as sets per (section, day) and (professor, day), and
// (Phase 8 Part 5) the class meetings of each such day, for the single-class-day terms.
const referenceSoft = (c) => {
  const w = c.policy.softWeights;
  const byId = new Map(c.demands.map(d => [d.demandId, d]));
  const rooms = new Map(c.rooms.map(r => [r.roomId, r]));
  const lunchSlots = c.policy.lunch.enabled ? c.policy.lunch.minFreeSlots : 0;
  const slotHours = c.policy.slotMinutes / 60;
  const days = { s: new Map(), f: new Map() };
  const meetings = { s: new Map(), f: new Map() };
  const n = { sat: 0, lab: 0, extra: 0, early: 0 };
  // Phase 4 Part 1: the TBA rooms in use (once each) and the non-fixed blocks before the preferred
  // earliest start slot (none when the policy carries no slot).
  const tbaRooms = new Set();
  const earlyBefore = Number.isInteger(c.policy.preferredEarliestStartSlot) ? c.policy.preferredEarliestStartSlot : null;
  for (const p of c.placements) {
    const d = byId.get(p.demandId);
    const room = p.roomId ? rooms.get(p.roomId) : null;
    if (p.day === 'Saturday' && !d.fixed) n.sat += 1;
    if (d.classType === 'LEC' && !d.isMinor && room?.roomType === 'LAB' && c.policy.majorLectureInLab !== 'FREE') n.lab += 1;
    if (room?.extra) { n.extra += 1; tbaRooms.add(room.roomId); }
    if (earlyBefore !== null && !d.fixed && p.startSlot < earlyBefore) n.early += 1;
    for (const [kind, key] of [['s', d.sectionId], ['f', d.facultyRef]]) {
      if (!key) continue;
      const k = `${key}|${p.day}`;
      if (!days[kind].has(k)) days[kind].set(k, new Set());
      for (let s = p.startSlot; s < p.startSlot + d.durationSlots; s += 1) days[kind].get(k).add(s);
      // The single-class days (Phase 8 Part 5): weekdays only, OJT demands never a class meeting.
      if (!['Saturday', 'Sunday'].includes(p.day) && d.classType !== 'OJT') {
        meetings[kind].set(k, (meetings[kind].get(k) || 0) + 1);
      }
    }
  }
  const idle = (map) => [...map.values()].reduce((acc, set) => {
    const slots = [...set];
    return acc + Math.max(0, Math.max(...slots) + 1 - Math.min(...slots) - set.size - lunchSlots);
  }, 0);
  const singles = (map) => [...map.values()].filter(count => count === 1).length;
  // Phase 8 Part 6 (decision 5a), independently of the evaluators: a professor's lone weekday is
  // weighed by their fullTime flag — false = the part-timers' weight, unless the part-timer is
  // exempt; true = the full-timers' weight; absent = the old counting. Exempt (5c's wording): the lone
  // day cannot be avoided — fewer than two meetings; one subject-for-a-section holding more meetings
  // than all the others; or an odd number with no three meetings of three groups fitting in the
  // widest weekday less the lunch run (every 3-subset tried by bitmask).
  const fullTimeOf = new Map((c.faculty || []).map(f => [f.facultyRef, f.fullTime]));
  const exemptOf = (ref) => {
    const mine = c.demands.filter(d => d.facultyRef === ref && d.classType !== 'OJT');
    if (mine.length < 2) return true;
    const distinct = Boolean(c.policy.sameSubjectDifferentDays);
    if (distinct) {
      const perGroup = {};
      mine.forEach(d => { perGroup[d.meetingGroup] = (perGroup[d.meetingGroup] || 0) + 1; });
      const largest = Math.max(...Object.values(perGroup));
      if (largest > mine.length - largest) return true;
    }
    if (mine.length % 2 === 0) return false;
    const widest = Math.max(0, ...WEEK.map(day => (c.policy.dayWindows[day] ? c.policy.dayWindows[day].endSlot - c.policy.dayWindows[day].startSlot : 0)));
    const cap = widest - (c.policy.lunch.enabled ? c.policy.lunch.minFreeSlots : 0);
    for (let mask = 0; mask < (1 << mine.length); mask += 1) {
      const picked = mine.filter((_, i) => mask & (1 << i));
      if (picked.length !== 3) continue;
      if (distinct && new Set(picked.map(d => d.meetingGroup)).size < 3) continue;
      if (picked.reduce((sum, d) => sum + d.durationSlots, 0) <= cap) return false;
    }
    return true;
  };
  let facultySingle = 0;
  for (const [k, count] of meetings.f) {
    if (count !== 1) continue;
    const ref = k.split('|')[0];
    const flag = fullTimeOf.get(ref);
    if (flag === true) facultySingle += w.fullTimerSingleClassDay || 0;
    else if (flag === false) facultySingle += exemptOf(ref) ? 0 : (w.facultySingleClassDay || 0);
    else facultySingle += w.facultySingleClassDay || 0;
  }
  const soft = {
    SAT_BLOCK: w.saturdayBlock * n.sat,
    LEC_IN_LAB: w.lectureInLab * n.lab,
    EXTRA_ROOM: w.overflowRoomBlock * n.extra,
    SECTION_IDLE: w.sectionGapHour * (idle(days.s) * slotHours),
    FACULTY_IDLE: w.facultyGapHour * (idle(days.f) * slotHours),
    TBA_ROOM: (w.tbaRoomUsed || 0) * tbaRooms.size,
    EARLY_START: (w.earlyStart || 0) * n.early,
    FACULTY_SINGLE_DAY: facultySingle,
    SECTION_SINGLE_DAY: (w.sectionSingleClassDay || 0) * singles(meetings.s)
  };
  return {
    ...soft,
    total: soft.SAT_BLOCK + soft.LEC_IN_LAB + soft.EXTRA_ROOM + soft.SECTION_IDLE + soft.FACULTY_IDLE
      + soft.TBA_ROOM + soft.EARLY_START + soft.FACULTY_SINGLE_DAY + soft.SECTION_SINGLE_DAY
  };
};

// Phase 4 Part 1: the cases written before the tbaRoomUsed and earlyStart penalties existed keep their
// results: the cases whose placements use a TBA room carry the two new weights at 0 in their input
// (every other case's counts for them are 0 anyway, so those keep the defaults).
const BEFORE_PHASE4 = gaPolicy({ softWeights: { tbaRoomUsed: 0, earlyStart: 0 } });

const cases = [];
// expectedSoft: a partial, hand-worked breakdown (missing terms are 0); checked against referenceSoft.
// A case whose policy carries no single-class-day weights (cases 1–61, byte-identical since Part 5)
// is written WITHOUT the two new terms; the runners fill them in as 0.
const add = (name, description, { policy = gaPolicy(), rooms = ROOMS, faculty = [], demands, placements, expected, expectedSoft, unplaced }) => {
  const c = { name, description, policy, rooms, faculty, demands, placements, expected };
  const reference = referenceSoft(c);
  if (expectedSoft) {
    const hand = { SAT_BLOCK: 0, LEC_IN_LAB: 0, EXTRA_ROOM: 0, SECTION_IDLE: 0, FACULTY_IDLE: 0, TBA_ROOM: 0, EARLY_START: 0, FACULTY_SINGLE_DAY: 0, SECTION_SINGLE_DAY: 0, ...expectedSoft };
    hand.total = hand.SAT_BLOCK + hand.LEC_IN_LAB + hand.EXTRA_ROOM + hand.SECTION_IDLE + hand.FACULTY_IDLE + hand.TBA_ROOM + hand.EARLY_START + hand.FACULTY_SINGLE_DAY + hand.SECTION_SINGLE_DAY;
    if (JSON.stringify(hand) !== JSON.stringify(reference)) throw new Error(`${name}: the hand-worked soft values ${JSON.stringify(hand)} differ from the reference ${JSON.stringify(reference)}`);
  }
  const written = { ...reference };
  if (policy.softWeights.facultySingleClassDay === undefined && policy.softWeights.sectionSingleClassDay === undefined) {
    delete written.FACULTY_SINGLE_DAY;
    delete written.SECTION_SINGLE_DAY;
  }
  cases.push({ ...c, expectedSoft: written, ...(unplaced ? { unplaced } : {}) });
};

// ---------------- Lunch ----------------
{
  const d = lab({});
  add('lunch-lab-11-14-keeps-10-11-free', 'A section with an 11:00-14:00 lab keeps 10:00-11:00 free.',
    { demands: [d], placements: [at(d, 'Monday', '11:00', 'room-lab-1')], expected: {} });
}
{
  const ds = [lab({ subj: 's1' }), lab({ subj: 's2' }), lab({ subj: 's3' })];
  add('lunch-section-three-labs-tba', 'One section with TBA labs 08-11, 11-14 and 14-17 on one day.',
    { demands: ds, placements: [at(ds[0], 'Monday', '08:00', 'room-lab-1'), at(ds[1], 'Monday', '11:00', 'room-lab-1'), at(ds[2], 'Monday', '14:00', 'room-lab-1')], expected: { HC1_LUNCH: 1 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const ds = ['sec-a', 'sec-b', 'sec-c'].map(sec => lab({ sec, facultyRef: 'fac-1' }));
  add('lunch-professor-three-sections', 'One professor teaches labs 08-11, 11-14 and 14-17 to three sections (one class each).',
    { faculty, demands: ds, placements: [at(ds[0], 'Monday', '08:00', 'room-lab-1'), at(ds[1], 'Monday', '11:00', 'room-lab-1'), at(ds[2], 'Monday', '14:00', 'room-lab-1')], expected: { HC1_LUNCH: 1 } });
}
{
  const ds = [lab({ subj: 's1' }), lab({ subj: 's2' }), lab({ subj: 's3' })];
  add('lunch-rule-switched-off', 'The same three labs with the lunch rule switched off.',
    { policy: gaPolicy({ lunch: { enabled: false } }), demands: ds, placements: [at(ds[0], 'Monday', '08:00', 'room-lab-1'), at(ds[1], 'Monday', '11:00', 'room-lab-1'), at(ds[2], 'Monday', '14:00', 'room-lab-1')], expected: {} });
}

// ---------------- Clashes ----------------
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Same Name', unavailable: [] }, { facultyRef: 'fac-2', name: 'Test Same Name', unavailable: [] }];
  const a = demand({ sec: 'sec-a', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', facultyRef: 'fac-2' });
  add('clash-two-faculty-same-name', 'Two professors who share a name teach at the same time.',
    { faculty, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '08:00', 'room-lec-2')], expected: {} });
}
{
  const a = demand({ sec: 'sec-a' });
  const b = demand({ sec: 'sec-b' });
  add('clash-tba-twice', 'A TBA professor twice at the same time, different sections and rooms.',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '08:00', 'room-lec-2')], expected: {} });
}
{
  const a = demand({ sec: 'sec-a', isMinor: true, requiresRoom: false, allowedRoomTypes: [] });
  const b = demand({ sec: 'sec-b', isMinor: true, requiresRoom: false, allowedRoomTypes: [] });
  add('clash-two-null-rooms', 'Two blocks with no room at the same time, different sections.',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00'), at(b, 'Monday', '08:00')], expected: {} });
}
{
  const a = demand({ sec: 'sec-a' });
  const b = demand({ sec: 'sec-b' });
  add('clash-room', 'Two sections in the same room at overlapping times.',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '09:00', 'room-lec-1')], expected: { HC3_ROOM_CLASH: 1 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = demand({ sec: 'sec-a', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', facultyRef: 'fac-1' });
  add('clash-faculty', 'One professor in two sections at overlapping times.',
    { faculty, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '09:00', 'room-lec-2')], expected: { HC3_FACULTY_CLASH: 1 } });
}
{
  const a = demand({ subj: 's1' });
  const b = demand({ subj: 's2' });
  add('clash-section', 'One section in two subjects at overlapping times.',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '09:00', 'room-lec-2')], expected: { HC3_SECTION_CLASH: 1 } });
}

// ---------------- Rooms ----------------
{
  const d = lab({});
  add('room-lab-in-lec-room', 'A LAB block in a LEC room.', { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: { HC2_ROOM_TYPE: 1 } });
}
{
  const d = demand({});
  add('room-major-lec-in-lab', 'A Major LEC block in a LAB room (soft penalty only).', { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lab-1')], expected: {} });
}
{
  const d = minorLec({});
  add('room-minor-lec-in-lab', 'A Minor LEC block in a LAB room.', { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lab-1')], expected: { HC2_ROOM_TYPE: 1 } });
}
{
  const d = demand({ isMinor: true, requiresRoom: false, allowedRoomTypes: [] });
  add('room-given-when-none-required', 'A Minor that needs no room is given one.', { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: { HC2_ROOM_TYPE: 1 } });
}
{
  const d = demand({ sectionSize: 45 });
  add('room-capacity-not-enforced', 'A 45-student section in a 40-seat room, enforceCapacity off.', { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: {} });
  add('room-capacity-enforced', 'A 45-student section in a 40-seat room, enforceCapacity on.',
    { policy: gaPolicy({ rooms: { enforceCapacity: true } }), demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: { HC6_CAPACITY: 1 } });
}

// ---------------- Days and meetings ----------------
{
  const first = demand({ sec: 'sec-1st' });
  add('day-saturday-first-year', 'A non-NSTP Saturday block for a 1st-year section (Saturday not allowed).',
    { demands: [first], placements: [at(first, 'Saturday', '08:00', 'room-lec-1')], expected: { HC4_DAY_NOT_ALLOWED: 1 } });
  const second = demand({ sec: 'sec-2nd', allowedDays: [...WEEK, 'Saturday'] });
  add('day-saturday-second-year', 'The same Saturday block for a 2nd-year section (overflow allowed).',
    { demands: [second], placements: [at(second, 'Saturday', '08:00', 'room-lec-1')], expected: {} });
}
{
  const d = demand({ subj: 'nstp', hours: 4, isMinor: true, requiresRoom: false, allowedRoomTypes: [], allowedDays: ['Saturday'], fixed: { day: 'Saturday', startSlot: slot('08:00') } });
  add('day-nstp-saturday-block', 'NSTP on Saturday 08:00-12:00.', { demands: [d], placements: [at(d, 'Saturday', '08:00')], expected: {} });
}
{
  const a = minorLec({ subj: 'gec', index: 0, hours: 2 });
  const b = minorLec({ subj: 'gec', index: 1, hours: 1 });
  add('meeting-gened-same-day', "A GenEd subject's 2 h and 1 h meetings on the same day.",
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '15:00', 'room-lec-1')], expected: { HC7_SAME_DAY: 1 } });
  add('meeting-gened-different-days', "The GenEd subject's meetings on different days.",
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Tuesday', '08:00', 'room-lec-1')], expected: {} });
}
{
  const l = demand({ subj: 'itec', hours: 2 });
  const b = lab({ subj: 'itec' });
  add('meeting-lecture-and-lab-same-day', 'A lecture and its lab on the same day.',
    { demands: [l, b], placements: [at(l, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '14:00', 'room-lab-1')], expected: { HC7_SAME_DAY: 1 } });
}
{
  const d = lab({});
  add('lab-start-0900', 'A 3-hour lab starting at 09:00.', { demands: [d], placements: [at(d, 'Tuesday', '09:00', 'room-lab-1')], expected: { HC9_LAB_START: 1 } });
  add('lab-start-1100', 'The same lab starting at 11:00.', { demands: [d], placements: [at(d, 'Tuesday', '11:00', 'room-lab-1')], expected: {} });
}

// ---------------- Availability and window ----------------
{
  const faculty = [{ facultyRef: 'fac-pt', name: 'Test Part-timer', unavailable: [{ day: 'Monday', startSlot: slot('13:00'), endSlot: slot('17:00') }] }];
  const d = demand({ facultyRef: 'fac-pt' });
  add('availability-part-timer-monday-afternoon', 'A part-timer unavailable Monday 13:00-17:00 with a class at 14:00.',
    { faculty, demands: [d], placements: [at(d, 'Monday', '14:00', 'room-lec-1')], expected: { HC4_FACULTY_UNAVAILABLE: 1 } });
}
{
  const rooms = [...ROOMS, { roomId: 'room-borrowed', roomName: 'TEST BORROWED', roomType: 'LEC', capacity: null, availability: [{ day: 'Tuesday', startSlot: slot('13:00'), endSlot: slot('17:00') }] }];
  const d = demand({});
  add('availability-borrowed-room-wrong-day', 'A borrowed room available only Tuesday 13:00-17:00, used on Wednesday.',
    { rooms, demands: [d], placements: [at(d, 'Wednesday', '13:00', 'room-borrowed')], expected: { HC4_ROOM_UNAVAILABLE: 1 } });
  add('availability-borrowed-room-inside-window', 'The borrowed room used inside its Tuesday window.',
    { rooms, demands: [d], placements: [at(d, 'Tuesday', '13:00', 'room-borrowed')], expected: {} });
}
{
  const d = demand({ hours: 1.5 });
  add('window-block-past-day-end', 'A block from 16:00 to 17:30.', { demands: [d], placements: [at(d, 'Monday', '16:00', 'room-lec-1')], expected: { HC8_WINDOW: 1 } });
}
{
  const d = demand({ allowedDays: [...WEEK, 'Saturday'] });
  add('window-saturday-uses-saturday-window', 'A Saturday block ending after the Saturday window (shortened to 12:00).',
    { policy: gaPolicy({ saturdayOverflow: { end: '12:00' }, nstp: { end: '12:00' } }), demands: [d], placements: [at(d, 'Saturday', '11:00', 'room-lec-1')], expected: { HC8_WINDOW: 1 } });
}

// ---------------- Extra rooms (Phase 2) ----------------
{
  const d = lab({});
  add('soft-extra-room-lab', 'A lab in an extra LAB room: allowed, one EXTRA_ROOM penalty.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'EXTRA-LAB-1')], expected: {}, expectedSoft: { EXTRA_ROOM: 30 } });
}
{
  const d = demand({});
  add('soft-extra-lab-room-major-lecture', 'A Major lecture in an extra LAB room pays the lecture-in-lab and the extra-room penalties.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'EXTRA-LAB-1')], expected: {}, expectedSoft: { LEC_IN_LAB: 10, EXTRA_ROOM: 30 } });
}
{
  const d = lab({});
  add('room-lab-in-extra-lec-room', 'A LAB block in an extra LEC room.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'EXTRA-LEC-1')], expected: { HC2_ROOM_TYPE: 1 }, expectedSoft: { EXTRA_ROOM: 30 } });
}
{
  const d = demand({ isMinor: true, requiresRoom: false, allowedRoomTypes: [] });
  add('room-minor-without-room-in-extra-room', 'A Minor hosted by another department (room TBA) placed in an extra room.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'EXTRA-LEC-1')], expected: { HC2_ROOM_TYPE: 1 }, expectedSoft: { EXTRA_ROOM: 30 } });
}
{
  const a = lab({ sec: 'sec-a' });
  const b = lab({ sec: 'sec-b' });
  add('clash-extra-room', 'Two sections in the same extra LAB room at the same time.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'EXTRA-LAB-1'), at(b, 'Monday', '08:00', 'EXTRA-LAB-1')], expected: { HC3_ROOM_CLASH: 1 }, expectedSoft: { EXTRA_ROOM: 60 } });
  add('clash-two-extra-rooms', 'Two sections at the same time in two different extra LAB rooms.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'EXTRA-LAB-1'), at(b, 'Monday', '08:00', 'EXTRA-LAB-2')], expected: {}, expectedSoft: { EXTRA_ROOM: 60 } });
}
{
  const d = demand({ sec: 'sec-2nd', allowedDays: [...WEEK, 'Saturday'] });
  add('soft-saturday-in-extra-room', 'A 2nd-year Saturday lecture in an extra LEC room pays both penalties.',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Saturday', '08:00', 'EXTRA-LEC-1')], expected: {}, expectedSoft: { SAT_BLOCK: 50, EXTRA_ROOM: 30 } });
}

// ---------------- Idle time (Phase 2) ----------------
{
  // 08:00-10:00 and 14:00-16:00: the day spans 8 h, 4 h in class, 1 h is the lunch allowance -> 3 idle hours.
  const a = demand({ subj: 's1' });
  const b = demand({ subj: 's2' });
  const placements = [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '14:00', 'room-lec-2')];
  add('soft-section-idle', 'A section with classes 08:00-10:00 and 14:00-16:00: 3 idle hours after the lunch hour.',
    { demands: [a, b], placements, expected: {}, expectedSoft: { SECTION_IDLE: 15 } });
  add('soft-section-idle-lunch-off', 'The same day with the lunch rule off: 4 idle hours.',
    { policy: gaPolicy({ lunch: { enabled: false } }), demands: [a, b], placements, expected: {}, expectedSoft: { SECTION_IDLE: 20 } });
}
{
  // One professor, two sections: 08:00-10:00 and 13:00-15:00 -> 7 h span, 4 h in class, 1 h lunch -> 2 idle hours.
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = demand({ sec: 'sec-a', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', facultyRef: 'fac-1' });
  add('soft-faculty-idle', 'A professor teaching 08:00-10:00 and 13:00-15:00: 2 idle hours (each section has one class).',
    { faculty, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '13:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_IDLE: 4 } });
  const ta = demand({ sec: 'sec-a' });
  const tb = demand({ sec: 'sec-b' });
  add('soft-idle-tba-professor', 'The same two classes with a TBA professor: no professor idle time.',
    { demands: [ta, tb], placements: [at(ta, 'Monday', '08:00', 'room-lec-1'), at(tb, 'Monday', '13:00', 'room-lec-1')], expected: {}, expectedSoft: {} });
}
{
  const a = demand({ subj: 's1' });
  const b = demand({ subj: 's2' });
  add('soft-idle-back-to-back', 'Classes 08:00-10:00 and 10:00-12:00: no idle time (never below 0).',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00', 'room-lec-1'), at(b, 'Monday', '10:00', 'room-lec-2')], expected: {}, expectedSoft: {} });
}

// ---------------- Online lectures (Phase 3 Step 7) ----------------
// A Major lecture held online (scheduled: a day and a time, no room) as the demand builder makes it: no
// room types, requiresRoom false, online true. No room key, so no room clash; the section's and the
// professor's time, the lunch rule and idle time still count.
const online = (o) => demand({ requiresRoom: false, allowedRoomTypes: [], online: true, ...o });
{
  const a = online({ sec: 'sec-a' });
  const b = online({ sec: 'sec-b' });
  add('online-no-room-clash', 'Two sections have online lectures at the same time: no room, so no clash.',
    { demands: [a, b], placements: [at(a, 'Monday', '08:00'), at(b, 'Monday', '08:00')], expected: {}, expectedSoft: {} });
}
{
  const a = online({ subj: 's1' });
  const b = demand({ subj: 's2' });
  add('online-clash-section', "An online lecture overlaps the same section's class in a room.",
    { demands: [a, b], placements: [at(a, 'Monday', '08:00'), at(b, 'Monday', '09:00', 'room-lec-1')], expected: { HC3_SECTION_CLASH: 1 }, expectedSoft: {} });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = online({ sec: 'sec-a', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', facultyRef: 'fac-1' });
  add('online-clash-faculty', "An online lecture overlaps the same professor's class of another section in a room.",
    { faculty, demands: [a, b], placements: [at(a, 'Monday', '08:00'), at(b, 'Monday', '09:00', 'room-lec-1')], expected: { HC3_FACULTY_CLASH: 1 }, expectedSoft: {} });
}
{
  const d = online({});
  add('online-given-a-room', 'An online lecture is placed in a CCS room.',
    { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: { HC2_ROOM_TYPE: 1 }, expectedSoft: {} });
  add('online-in-tba-room', 'An online lecture is placed in a TBA room (an extra room to request).',
    { policy: BEFORE_PHASE4, rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'EXTRA-LEC-1')], expected: { HC2_ROOM_TYPE: 1 }, expectedSoft: { EXTRA_ROOM: 30 } });
}
{
  // A lab 08:00-11:00, the online lecture 11:00-13:00 and a lecture 13:00-15:00: nothing is free
  // between 10:00 and 15:00, the online lecture's time included.
  const l = lab({ subj: 's1' });
  const o = online({ subj: 's2' });
  const c = demand({ subj: 's3' });
  add('online-counts-for-lunch', 'An online lecture is class time: with it the section has no free lunch hour.',
    { demands: [l, o, c], placements: [at(l, 'Monday', '08:00', 'room-lab-1'), at(o, 'Monday', '11:00'), at(c, 'Monday', '13:00', 'room-lec-1')], expected: { HC1_LUNCH: 1 }, expectedSoft: {} });
}
{
  // Online 08:00-10:00 and a class 14:00-16:00: the day spans 8 h, 4 h in class, 1 h is the lunch
  // allowance -> 3 idle hours, exactly as when both are on campus (soft-section-idle).
  const o = online({ subj: 's1' });
  const c = demand({ subj: 's2' });
  add('online-section-idle', 'A section with an online lecture 08:00-10:00 and a class 14:00-16:00: 3 idle hours after the lunch hour.',
    { demands: [o, c], placements: [at(o, 'Monday', '08:00'), at(c, 'Monday', '14:00', 'room-lec-2')], expected: {}, expectedSoft: { SECTION_IDLE: 15 } });
}
{
  // Self-paced: the real demand builder on a Major (2 h lecture + 3 h lab) whose lectures are
  // self-paced online. Its lecture hours get no demand (an unscheduled item instead, kept as
  // `unplaced`); only the lab is a demand, and only the lab is placed.
  const section = { _id: 'sec-a', sectionCode: 'TEST SEC-A', program: 'BSIT', yearLevel: 1, track: 'NONE' };
  const subject = { _id: 'subj-sp', subjectCode: 'TEST SUBJ-SP', descriptiveTitle: 'TEST self-paced Major', type: 'Major', lecHours: 2, labHours: 3, units: 3, requiresRoom: true, lectureMode: 'ONLINE_SELF_PACED' };
  const built = buildGaRequest({ policy: mergePolicy(defaultPolicy(), CASE_BASE), pairs: [{ section, subject }], seed: 1 });
  const [labDemand] = built.request.demands;
  add('online-self-paced-unplaced', 'A Major whose lectures are self-paced online: its lecture is in no demand and no placement; only its lab is placed.',
    { demands: built.request.demands, placements: [at(labDemand, 'Monday', '08:00', 'room-lab-1')], expected: {}, expectedSoft: {}, unplaced: built.unscheduledItems });
}

// ---------------- TBA rooms used and early starts (Phase 4 Part 1) ----------------
// tbaRoomUsed counts each TBA room that holds at least one class, once; earlyStart counts each
// non-fixed class that starts before preferredEarliestStart (08:00, slot 2), on any day; NSTP (a
// fixed block) is never counted. The default weights (the rooms benchmark's choice): tbaRoomUsed 50, earlyStart 5.
{
  const d = demand({});
  add('soft-no-tba-room-used', 'A lecture at 08:00 in a CCS room: no TBA room used, no early start.',
    { rooms: WITH_EXTRA, demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: {} });
}
{
  const a = demand({ sec: 'sec-a' });
  const b = demand({ sec: 'sec-b' });
  add('soft-one-tba-room-two-classes', 'Two classes in the same TBA lecture room (different times): the room is counted once.',
    { rooms: WITH_EXTRA, demands: [a, b], placements: [at(a, 'Monday', '08:00', 'EXTRA-LEC-1'), at(b, 'Tuesday', '08:00', 'EXTRA-LEC-1')], expected: {}, expectedSoft: { EXTRA_ROOM: 60, TBA_ROOM: 50 } });
}
{
  const a = lab({ sec: 'sec-a' });
  const b = lab({ sec: 'sec-b' });
  const c = demand({ sec: 'sec-c' });
  add('soft-three-tba-rooms', 'Three classes in three TBA rooms (two labs, one lecture): three TBA rooms used.',
    { rooms: WITH_EXTRA, demands: [a, b, c], placements: [at(a, 'Monday', '08:00', 'EXTRA-LAB-1'), at(b, 'Monday', '08:00', 'EXTRA-LAB-2'), at(c, 'Monday', '08:00', 'EXTRA-LEC-1')], expected: {}, expectedSoft: { EXTRA_ROOM: 90, TBA_ROOM: 150 } });
}
{
  const d = demand({});
  add('soft-lecture-at-0700', 'A lecture at 07:00 in a CCS room: one early start.',
    { demands: [d], placements: [at(d, 'Monday', '07:00', 'room-lec-1')], expected: {}, expectedSoft: { EARLY_START: 5 } });
  add('soft-lecture-at-0730', 'A lecture at 07:30: still before 08:00, one early start.',
    { demands: [d], placements: [at(d, 'Monday', '07:30', 'room-lec-1')], expected: {}, expectedSoft: { EARLY_START: 5 } });
  add('soft-lecture-at-0800', 'A lecture at 08:00: not counted.',
    { demands: [d], placements: [at(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: {} });
}
{
  // NSTP fixed at 07:00 on Saturday (the policy's block moved to 07:00–11:00): never an early start.
  const d = demand({ sec: 'sec-1st', subj: 'nstp', hours: 4, isMinor: true, requiresRoom: false, allowedRoomTypes: [], allowedDays: ['Saturday'], fixed: { day: 'Saturday', startSlot: slot('07:00') } });
  add('soft-early-nstp-not-counted', 'The fixed NSTP block at 07:00 on Saturday: no early start and no Saturday penalty.',
    { policy: gaPolicy({ nstp: { start: '07:00', end: '11:00' } }), demands: [d], placements: [at(d, 'Saturday', '07:00')], expected: {}, expectedSoft: {} });
}

// ---------------- Odd and even weeks (Phase 8) ----------------
// The office's practice when rooms are short: a week group meets face-to-face in its own weeks and
// online in the other weeks, at the same times. While policy.weekGroupsEnabled is true, a ROOM clash
// counts only between classes of the same week group; a professor or section is still never
// double-booked. With the switch off, the groups on the demands mean nothing.
{
  const a = demand({ sec: 'sec-odd', weekGroup: 'ODD' });
  const b = demand({ sec: 'sec-even', weekGroup: 'EVEN' });
  add('week-groups-room-shared-across-groups', 'Two classes of different week groups in one room at one time: allowed (they alternate weeks).',
    { policy: gaPolicyNew(), demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: {} });
}
{
  const a = demand({ sec: 'sec-odd-1', weekGroup: 'ODD' });
  const b = demand({ sec: 'sec-odd-2', weekGroup: 'ODD' });
  add('week-groups-room-same-group-clash', 'Two classes of the SAME week group in one room at one time: a room clash.',
    { policy: gaPolicyNew(), demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '08:00', 'room-lec-1')], expected: { HC3_ROOM_CLASH: 1 }, expectedSoft: {} });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = demand({ sec: 'sec-odd', weekGroup: 'ODD', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-even', weekGroup: 'EVEN', facultyRef: 'fac-1' });
  add('week-groups-professor-across-groups-clash', 'One professor in both week groups at the same time (different rooms): still a professor clash.',
    { policy: gaPolicyNew(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '08:00', 'room-lec-2')], expected: { HC3_FACULTY_CLASH: 1 }, expectedSoft: {} });
}
{
  const a = demand({ sec: 'sec-odd', weekGroup: 'ODD' });
  const b = demand({ sec: 'sec-even', weekGroup: 'EVEN' });
  add('week-groups-switch-off-room-clash', 'The same two classes with the odd/even switch off: a room clash.',
    { policy: gaPolicyNew({ weekGroups: { enabled: false } }), demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '08:00', 'room-lec-1')], expected: { HC3_ROOM_CLASH: 1 }, expectedSoft: {} });
}

// ---------------- The per-class GenEd room rule (Phase 8) ----------------
// The real demand builder on one Minor subject for two sections: the class with a CCS professor
// assigned (a manual Minor lock) needs a CCS lecture room; the class with the professor TBA needs no
// room (another college teaches it in its own rooms). The subject's "Needs a CCS room" box is unticked.
{
  const sections = [
    { _id: 'sec-a', sectionCode: 'TEST SEC-A', program: 'BSIT', yearLevel: 1, track: 'NONE' },
    { _id: 'sec-b', sectionCode: 'TEST SEC-B', program: 'BSIT', yearLevel: 1, track: 'NONE' }
  ];
  const subject = { _id: 'subj-gec', subjectCode: 'TEST GEC', descriptiveTitle: 'TEST GenEd Minor', type: 'Minor', lecHours: 2, labHours: 0, units: 2, requiresRoom: false };
  const professor = { _id: 'fac-minor', facultyId: 'FAC-901', name: 'Test Minor Professor', isActive: true };
  const lock = { sectionCode: 'TEST SEC-A', subjectId: 'subj-gec', subjectCode: 'TEST GEC', facultyRef: 'fac-minor', facultyId: 'FAC-901', facultyName: professor.name, source: 'manual', classType: 'ALL' };
  const built = buildGaRequest({ policy: mergePolicy(defaultPolicy(), {}), pairs: sections.map(section => ({ section, subject })), locks: [lock], faculty: [professor], seed: 1 });
  const [withProfessor, tba] = built.request.demands;
  add('minor-room-per-class-professor', 'A Minor with a CCS professor needs a lecture room; the same subject with the professor TBA needs none.',
    // Phase 8 Part 6 added fullTime to the gateway's faculty entries; stripping it keeps this file
    // byte-identical (no single-class-day weight is in this case's policy anyway).
    { policy: withoutSingleDayWeights(built.request.policy), faculty: built.request.faculty.map(({ fullTime, ...f }) => f), demands: built.request.demands,
      placements: [{ demandId: withProfessor.demandId, day: 'Monday', startSlot: slotNew('08:00'), roomId: 'room-lec-1' }, { demandId: tba.demandId, day: 'Tuesday', startSlot: slotNew('08:00'), roomId: null }],
      expected: {}, expectedSoft: {} });
}

// ---------------- Single-class days (Phase 8 Part 5) ----------------
// A soft penalty for each weekday on which a professor has exactly one class meeting
// (facultySingleClassDay, pinned at 7 here) and a lighter one for a section's such day
// (sectionSingleClassDay, pinned at 3). Saturday and Sunday never count (so NSTP's fixed Saturday
// block is excluded), and an OJT demand (classType 'OJT', the version check's records) is not a
// class meeting. These cases use the Phase 8 defaults (08:00 window) with the two pinned weights.
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const d = demand({ facultyRef: 'fac-1' });
  add('single-day-professor-one-class', 'A professor with exactly one class on Monday: one professor single-class day (and the section has one too).',
    { policy: gaPolicyP5(), faculty, demands: [d], placements: [atNew(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 7, SECTION_SINGLE_DAY: 3 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = demand({ sec: 'sec-a', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', facultyRef: 'fac-1' });
  add('single-day-professor-two-classes', 'The professor teaches two classes back to back on Monday: no professor single-class day (each section still has one).',
    { policy: gaPolicyP5(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '10:00', 'room-lec-2')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 6 } });
}
{
  const d = demand({});
  add('single-day-section-one-class', 'A section with one class on Monday and the professor TBA: one section single-class day, no professor day.',
    { policy: gaPolicyP5(), demands: [d], placements: [atNew(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 3 } });
}
{
  const nstp = demand({ sec: 'sec-1st', subj: 'nstp', hours: 4, isMinor: true, requiresRoom: false, allowedRoomTypes: [], allowedDays: ['Saturday'], fixed: { day: 'Saturday', startSlot: slotNew('08:00') } });
  const c = demand({ sec: 'sec-1st', subj: 's1' });
  add('single-day-nstp-excluded', "NSTP alone on Saturday is never a single-class day (not a weekday); the section's lone Monday class still is.",
    { policy: gaPolicyP5(), demands: [nstp, c], placements: [atNew(nstp, 'Saturday', '08:00'), atNew(c, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 3 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Professor', unavailable: [] }];
  const a = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-a', subj: 's2', facultyRef: 'fac-1' });
  const c = demand({ sec: 'sec-b', subj: 's3', facultyRef: 'fac-1' });
  add('single-day-the-two-weights', "The two weights apart: the professor's lone Monday class costs 7, the three section single-class days cost 3 each (Tuesday has two professor classes, so no professor day).",
    { policy: gaPolicyP5(), faculty, demands: [a, b, c], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Tuesday', '08:00', 'room-lec-1'), atNew(c, 'Tuesday', '10:00', 'room-lec-2')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 7, SECTION_SINGLE_DAY: 9 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Coordinator', unavailable: [] }];
  const a = demand({ sec: 'sec-a', facultyRef: 'fac-1' });
  const ojt = demand({ sec: 'sec-d', subj: 'prac', type: 'OJT', hours: 2, facultyRef: 'fac-1', requiresRoom: false, allowedRoomTypes: [] });
  add('single-day-ojt-records-not-counted', "An OJT record (the version check's demands) is not a class meeting: the professor's Monday still has exactly one class, and the OJT section's day counts nothing.",
    { policy: gaPolicyP5(), faculty, demands: [a, ojt], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(ojt, 'Monday', '10:00')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 7, SECTION_SINGLE_DAY: 3 } });
}

// ---------------- The part-timer scope (Phase 8 Part 6, decision 5a) ----------------
// request.faculty[].fullTime tells the professors apart: false = a part-timer (the
// facultySingleClassDay weight, and the exemption below), true = a full-timer
// (fullTimerSingleClassDay, pinned at 4 here; 0 in production by default), absent = the pre-Part 6
// counting (cases 62-67 stay as recorded). A part-timer with fewer than two class meetings in the
// week is exempt: the lone day cannot be avoided, so it neither costs nor counts.
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Part-Timer', fullTime: false, unavailable: [] }];
  const a = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', subj: 's2', facultyRef: 'fac-1' });
  add('single-day-part-timer-two-lone-days', "A part-timer (fullTime false) with one class on Monday and one on Tuesday: two part-timer single-class days at the professors' weight (7 each); each section has its own lone day.",
    { policy: gaPolicyP6(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Tuesday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 14, SECTION_SINGLE_DAY: 6 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Full-Timer', fullTime: true, unavailable: [] }];
  const d = demand({ facultyRef: 'fac-1' });
  add('single-day-full-timer-weight', "A full-timer's lone Monday class costs the full-timers' weight (pinned 4 here; 0 in production: they are on campus for their duties), not the part-timers' 7.",
    { policy: gaPolicyP6(), faculty, demands: [d], placements: [atNew(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 4, SECTION_SINGLE_DAY: 3 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test One-Class Part-Timer', fullTime: false, unavailable: [] }];
  const d = demand({ facultyRef: 'fac-1' });
  add('single-day-part-timer-exempt', 'A part-timer with fewer than two class meetings in the week is exempt: the lone Monday costs and counts nothing for the professor (the section still has its day).',
    { policy: gaPolicyP6(), faculty, demands: [d], placements: [atNew(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 3 } });
}
{
  const faculty = [
    { facultyRef: 'fac-1', name: 'Test Legacy Professor', unavailable: [] },
    { facultyRef: 'fac-2', name: 'Test Part-Timer', fullTime: false, unavailable: [] }
  ];
  const a = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', subj: 's2', facultyRef: 'fac-2' });
  const c = demand({ sec: 'sec-c', subj: 's3', facultyRef: 'fac-2' });
  add('single-day-flag-absent-keeps-old-counting', "A faculty entry without the fullTime flag (the pre-Part 6 cases) keeps the old counting: the legacy professor's lone Monday costs 7 like the part-timer's two lone days (7 each); three section days at 3.",
    { policy: gaPolicyP6(), faculty, demands: [a, b, c], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '10:00', 'room-lec-1'), atNew(c, 'Tuesday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 21, SECTION_SINGLE_DAY: 9 } });
}

// ---------------- The part-timers' hard rule (Phase 8 Part 6, decision 5c) ----------------
// While policy.partTimerSingleDayHard is true, each non-exempt part-timer's weekday with exactly one
// class meeting is HC10_PART_TIMER_SINGLE_DAY (the soft term still counts it too). Exempt: the lone
// day cannot be avoided — fewer than two meetings, one subject-for-a-section's meetings outnumbering
// the rest (they fall on different days), or an odd number with no three meetings fitting a weekday
// (the 08:00-17:00 day less the lunch hour holds 8 class hours). Full-timers are never bound.
const LAB_STARTS_NEW = ['08:00', '11:00', '14:00'].map(slotNew);
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Part-Timer', fullTime: false, unavailable: [] }];
  const a = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', subj: 's2', facultyRef: 'fac-1' });
  add('part-timer-hard-two-lone-days', 'With the hard rule on, a part-timer with one class on Monday and one on Tuesday breaks it twice (HC10 on each day); the soft terms count as before.',
    { policy: gaPolicyP6c(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Tuesday', '08:00', 'room-lec-1')], expected: { HC10_PART_TIMER_SINGLE_DAY: 2 }, expectedSoft: { FACULTY_SINGLE_DAY: 14, SECTION_SINGLE_DAY: 6 } });
  add('part-timer-hard-paired-day', "The same two classes on one Monday (08:00 and 10:00, the lunch hour free at 12:00) keep the rule: no conflict; only the sections' lone days cost.",
    { policy: gaPolicyP6c(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Monday', '10:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 6 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test One-Class Part-Timer', fullTime: false, unavailable: [] }];
  const d = demand({ facultyRef: 'fac-1' });
  add('part-timer-hard-exempt-one-meeting', 'A part-timer with one class meeting in the week is exempt: the lone Monday breaks nothing and costs nothing for the professor.',
    { policy: gaPolicyP6c(), faculty, demands: [d], placements: [atNew(d, 'Monday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 3 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Lecture-and-Lab Part-Timer', fullTime: false, unavailable: [] }];
  const l = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const x = demand({ sec: 'sec-a', subj: 's1', type: 'LAB', hours: 3, allowedRoomTypes: ['LAB'], allowedStarts: LAB_STARTS_NEW, facultyRef: 'fac-1' });
  add('part-timer-hard-exempt-lecture-and-lab', "A part-timer whose only subject is one section's lecture and lab is exempt: the two meetings must fall on different days, so a lone day cannot be avoided.",
    { policy: gaPolicyP6c(), faculty, demands: [l, x], placements: [atNew(l, 'Monday', '08:00', 'room-lec-1'), atNew(x, 'Tuesday', '08:00', 'room-lab-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 6 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Three-Long-Classes Part-Timer', fullTime: false, unavailable: [] }];
  const ds = ['sec-a', 'sec-b', 'sec-c'].map(sec => demand({ sec, subj: 's1', hours: 3, facultyRef: 'fac-1' }));
  add('part-timer-hard-exempt-three-long-meetings', 'A part-timer with three 3-hour classes is exempt: an odd number needs a day of three, and 9 class hours never fit the 08:00-17:00 day with its lunch hour.',
    { policy: gaPolicyP6c(), faculty, demands: ds, placements: [atNew(ds[0], 'Monday', '08:00', 'room-lec-1'), atNew(ds[1], 'Monday', '12:00', 'room-lec-1'), atNew(ds[2], 'Tuesday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 9 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Three-Short-Classes Part-Timer', fullTime: false, unavailable: [] }];
  const ds = ['sec-a', 'sec-b', 'sec-c'].map(sec => demand({ sec, subj: 's1', facultyRef: 'fac-1' }));
  add('part-timer-hard-odd-with-a-day-of-three', 'Three 2-hour classes fit one day (6 of its 8 class hours), so the part-timer is not exempt: two on Monday and one alone on Tuesday break the rule once.',
    { policy: gaPolicyP6c(), faculty, demands: ds, placements: [atNew(ds[0], 'Monday', '08:00', 'room-lec-1'), atNew(ds[1], 'Monday', '10:00', 'room-lec-1'), atNew(ds[2], 'Tuesday', '08:00', 'room-lec-1')], expected: { HC10_PART_TIMER_SINGLE_DAY: 1 }, expectedSoft: { FACULTY_SINGLE_DAY: 7, SECTION_SINGLE_DAY: 9 } });
}
{
  const faculty = [{ facultyRef: 'fac-1', name: 'Test Full-Timer', fullTime: true, unavailable: [] }];
  const a = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'fac-1' });
  const b = demand({ sec: 'sec-b', subj: 's2', facultyRef: 'fac-1' });
  add('part-timer-hard-full-timer-not-bound', "The hard rule is the part-timers' only: a full-timer's two lone days break nothing and cost the full-timers' weight (pinned 4 here).",
    { policy: gaPolicyP6c(), faculty, demands: [a, b], placements: [atNew(a, 'Monday', '08:00', 'room-lec-1'), atNew(b, 'Tuesday', '08:00', 'room-lec-1')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 8, SECTION_SINGLE_DAY: 6 } });
}

// ---------------- Outside teachers (Phase 8 Part 8, decision 4) ----------------
// A GenEd class taught by a teacher from outside CCS carries `outsideTeacher` (a key of its own, never a
// facultyRef) and no professor. The teacher gets two rules only: never two classes at the same time, in
// any week group (HC3_FACULTY_CLASH), and the lunch hour (HC1_LUNCH); no unavailable times, no idle
// time, no single-class day (no Friday rule and no part-timers' rule either). Here the GenEd boxes are
// unticked, so the classes take no room. The Part 6 pinned weights and the hard rule are on.
const outsideGenEd = (o) => minorLec({ requiresRoom: false, allowedRoomTypes: [], outsideTeacher: 'out-1', outsideTeacherName: 'Test Outside Teacher', ...o });
{
  const a = outsideGenEd({ sec: 'sec-a', subj: 'g1', weekGroup: 'ODD' });
  const b = outsideGenEd({ sec: 'sec-b', subj: 'g2', weekGroup: 'EVEN' });
  add('outside-teacher-clash-across-week-groups', 'An outside teacher with two GenEd classes at Monday 08:00, one section in the odd weeks and one in the even weeks: the week groups never excuse a person, so it is one HC3_FACULTY_CLASH; the teacher has no single-class day (only the sections do).',
    { policy: gaPolicyP6c(), demands: [a, b], placements: [atNew(a, 'Monday', '08:00'), atNew(b, 'Monday', '08:00')], expected: { HC3_FACULTY_CLASH: 1 }, expectedSoft: { SECTION_SINGLE_DAY: 6 } });
}
{
  const a = outsideGenEd({ sec: 'sec-a', subj: 'g1' });
  const b = outsideGenEd({ sec: 'sec-b', subj: 'g2' });
  const c = outsideGenEd({ sec: 'sec-c', subj: 'g3', hours: 1 });
  add('outside-teacher-lunch-hour', 'An outside teacher with GenEd classes at 10:00-12:00, 12:00-14:00 and 14:00-15:00 on Monday has no free hour between 10:00 and 15:00: one HC1_LUNCH (each section has its own lunch hour).',
    { policy: gaPolicyP6c(), demands: [a, b, c], placements: [atNew(a, 'Monday', '10:00'), atNew(b, 'Monday', '12:00'), atNew(c, 'Monday', '14:00')], expected: { HC1_LUNCH: 1 }, expectedSoft: { SECTION_SINGLE_DAY: 9 } });
}
{
  const a = outsideGenEd({ sec: 'sec-a', subj: 'g1' });
  const c = outsideGenEd({ sec: 'sec-c', subj: 'g3' });
  const b = outsideGenEd({ sec: 'sec-b', subj: 'g2' });
  add('outside-teacher-no-other-rule', "An outside teacher with Monday 08:00-10:00 and 13:00-15:00 (three idle hours) and a lone Friday class: no conflict and no cost for the teacher (no idle time, no single-class day, no Friday rule); only the sections' lone days cost.",
    { policy: gaPolicyP6c(), demands: [a, c, b], placements: [atNew(a, 'Monday', '08:00'), atNew(c, 'Monday', '13:00'), atNew(b, 'Friday', '08:00')], expected: {}, expectedSoft: { SECTION_SINGLE_DAY: 9 } });
}
{
  const faculty = [{ facultyRef: 'shared-key', name: 'Test Full-Timer', fullTime: true, unavailable: [] }];
  const p = demand({ sec: 'sec-a', subj: 's1', facultyRef: 'shared-key' });
  const o = outsideGenEd({ sec: 'sec-b', subj: 'g2', outsideTeacher: 'shared-key' });
  add('outside-teacher-apart-from-professors', "A CCS professor and an outside teacher whose keys are the same text, both at Monday 08:00: the two lists never mix, so nothing clashes; the professor's lone day costs the full-timers' weight (pinned 4).",
    { policy: gaPolicyP6c(), faculty, demands: [p, o], placements: [atNew(p, 'Monday', '08:00', 'room-lec-1'), atNew(o, 'Monday', '08:00')], expected: {}, expectedSoft: { FACULTY_SINGLE_DAY: 4, SECTION_SINGLE_DAY: 6 } });
}

for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.json')) fs.unlinkSync(path.join(__dirname, f));
cases.forEach((c, i) => {
  const file = `${String(i + 1).padStart(2, '0')}-${c.name}.json`;
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(c, null, 2) + '\n');
});
console.log(`${cases.length} cases written to ${__dirname}`);
