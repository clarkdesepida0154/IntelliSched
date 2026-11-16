// The demand builder: turns a term (sections, curriculum pairs, locks, rooms, faculty) and the
// SchedulingPolicy into Engine 3's request, all in slots. One run covers every program: sections of
// BSIT and BSCS share rooms and faculty. Constraints on the request are evaluated by
// utils/constraints.js here and by constraints.py in Engine 3, the same way.
const { DAY_NAMES, gridOrigin, slotOfTime, windowSlots, allowedDaysForSection, toMinutes } = require('./timeGrid');
const { meetingsForSubject, lectureModeOf } = require('./meetings');
const { weekGroupOf } = require('./policy');
const { resolveSubjectType, findLockFor } = require('./curriculumMatcher');
const { buildFacultyResolver, TBA_POOL_FACULTY_ID, OUTSIDE_FACULTY_ID } = require('./termAssignments');
// Phase 8 Part 4 (decision 4): the request carries the full-timer's Extension day as unavailable
// time, like any other block, so the GA itself is unchanged.
const { schedulingUnavailableBlocks } = require('./facultyAvailability');

const toSlots = (policy, minutes) => minutes / policy.slotMinutes;

// The last slot of the day (24:00) counted from the grid origin.
const dayEndSlot = (policy) => slotOfTime(policy, '23:30') + 1;

// A { day, start, end } time window -> { day, startSlot, endSlot } on the policy grid, clipped to the
// day: a stored window may start before the grid origin (it was saved under an earlier policy, or
// before 07:00), and only the part inside the grid matters. null when nothing is left.
const windowToSlots = (policy, w) => {
  const startSlot = Math.max(0, slotOfTime(policy, w.start));
  const endSlot = Math.min(dayEndSlot(policy), slotOfTime(policy, w.end));
  return endSlot > startSlot ? { day: w.day, startSlot, endSlot } : null;
};

// The policy part of the request: every day that has a window (weekdays, Saturday, the NSTP day),
// the lunch rule and the switches, in slots from the grid origin.
const buildGaPolicy = (policy, seed = null) => {
  const dayWindows = {};
  for (const day of DAY_NAMES) {
    const w = windowSlots(policy, day);
    if (w) dayWindows[day] = { startSlot: w.startSlot, endSlot: w.endSlot };
  }
  return {
    slotMinutes: policy.slotMinutes,
    origin: gridOrigin(policy),
    // Phase 8 (odd and even weeks): while the switch is on, a room clash counts only between classes
    // of the same week group (each demand carries its `weekGroup`; one without a group clashes with
    // both). The field is absent while the switch is off, so every request built before is unchanged.
    ...(policy.weekGroups?.enabled ? { weekGroupsEnabled: true } : {}),
    dayWindows,
    lunch: {
      enabled: Boolean(policy.lunch.enabled),
      startSlot: slotOfTime(policy, policy.lunch.windowStart),
      endSlot: slotOfTime(policy, policy.lunch.windowEnd),
      minFreeSlots: Math.ceil(toSlots(policy, policy.lunch.minFreeMinutes))
    },
    sameSubjectDifferentDays: Boolean(policy.meetings.sameSubjectDifferentDays),
    majorLectureInLab: policy.rooms.majorLectureInLab,
    enforceCapacity: Boolean(policy.rooms.enforceCapacity),
    // Phase 8 Part 6 (decision 5c): while the policy's switch is on, a part-timer's weekday with
    // exactly one class meeting is a hard conflict (HC10). Absent while off, so requests built before
    // (and the golden cases, which strip it) are unchanged.
    ...(policy.meetings?.partTimerNoSingleDay ? { partTimerSingleDayHard: true } : {}),
    softWeights: { ...policy.softWeights },
    // Phase 4 Part 1: a non-fixed block that starts before this slot costs the earlyStart penalty. Never
    // below 0 (a time before the grid origin, which validatePolicy refuses, would count nothing anyway).
    preferredEarliestStartSlot: Math.max(0, slotOfTime(policy, policy.preferredEarliestStart) ?? 0),
    seed
  };
};

// Extra rooms (Phase 2 Step 2): when the policy's "Use extra rooms when CCS rooms are full" is on,
// overflowRooms.lab LAB rooms and overflowRooms.lec LEC rooms are added as virtual rooms. They stand for
// rooms the Dean must request from outside CCS: they are not stored in Facilities, a class placed in
// one is saved with roomId null and its key (EXTRA-LAB-1 ...), and each class in one costs the
// EXTRA_ROOM soft penalty, so CCS (and borrowed) rooms are used first.
const EXTRA_ROOM_KEY = /^EXTRA-(LAB|LEC)-([1-9]\d*)$/;
const isExtraRoomKey = (value) => typeof value === 'string' && EXTRA_ROOM_KEY.test(value);
const extraRoomName = (key) => {
  const [, type, n] = EXTRA_ROOM_KEY.exec(key) || [];
  return type ? `Extra ${type} room ${n} (TBA – to request)` : 'TBA';
};
// { type: 'LAB' | 'LEC', number } of an extra room's key; null for anything else.
const parseExtraRoomKey = (key) => {
  const [, type, n] = EXTRA_ROOM_KEY.exec(String(key ?? '')) || [];
  return type ? { type, number: Number(n) } : null;
};
// Phase 3: the Dean's name for an extra room, a "TBA room to request": "TBA room 2 (lecture)",
// "TBA room 1 (lab)". The stored name above stays as saved; screens and prints show this one, and only
// the Room Program and the editor name the room (a class in it reads "TBA"). The one server copy of this
// wording: it equals the client's tbaRoomName (client/src/utils/scheduleDisplay.js; a unit test checks).
const tbaRoomName = (key) => {
  const room = parseExtraRoomKey(key);
  return room ? `TBA room ${room.number} (${room.type === 'LAB' ? 'lab' : 'lecture'})` : 'TBA';
};
const extraRoomsOf = (policy) => {
  const o = policy.overflowRooms || {};
  if (!o.enabled) return [];
  const make = (type, count) => Array.from({ length: Math.max(0, Number(count) || 0) }, (_, i) => {
    const roomId = `EXTRA-${type}-${i + 1}`;
    return { roomId, roomName: extraRoomName(roomId), roomType: type, capacity: null, availability: [], extra: true };
  });
  return [...make('LAB', o.lab), ...make('LEC', o.lec)];
};
// Phase 3 Step 4: { mode, lab, lec }, how a (resolved) policy sets its TBA rooms and how many of each
// type a run with it gets: what a run records as tbaRooms ("Advanced" shows it).
const tbaRoomCounts = (policy) => {
  const rooms = extraRoomsOf(policy);
  return { mode: policy.overflowRooms?.mode || 'auto', lab: rooms.filter(r => r.roomType === 'LAB').length, lec: rooms.filter(r => r.roomType === 'LEC').length };
};

// Room types a meeting may use: LAB -> LAB; Major LEC -> LEC (+ LAB unless NEVER), none when the
// Major's lectures are online (Phase 3 Step 7: a day and a time, no room); a Minor LEC -> LEC when the
// class needs a CCS room, otherwise none (TBA, no CCS room needed).
// Phase 8 (the per-class GenEd room rule, replacing the per-subject GenEd unticks of Parts 4.4 and 6):
// a Minor class needs a CCS lecture room when a CCS professor is assigned to it (`hasProfessor`), or
// when the Dean ticked the subject's "Needs a CCS room" box. With the professor TBA and the box
// unticked, another college teaches it in its own rooms. A saved version is judged by what it stored,
// not by today's locks: versionCheck.js pins each Minor pair's need as `subject.minorRoomPinned`
// (true/false), which wins here, so a professor change never re-labels a Draft's rooms.
const allowedRoomTypesOf = (subject, classType, policy, { hasProfessor = false } = {}) => {
  const type = resolveSubjectType(subject);
  if (type === 'NSTP') return [];
  if (classType === 'LAB') return ['LAB'];
  if (type === 'Major') {
    if (lectureModeOf(subject) === 'ONLINE_SCHEDULED') return [];
    return policy.rooms.majorLectureInLab === 'NEVER' ? ['LEC'] : ['LEC', 'LAB'];
  }
  const needsRoom = subject.minorRoomPinned !== undefined
    ? Boolean(subject.minorRoomPinned)
    : subject.requiresRoom === true || hasProfessor;
  return needsRoom ? ['LEC'] : [];
};

// { request, unscheduledItems, unassignedMajors, demandInfo }
//   request          { policy, faculty, rooms, demands }
//   unscheduledItems the pairs (or their lecture hours) never placed:
//                    { sectionId, subjectId, facultyRef, kind: 'PRACTICUM', hours: ojtCoordinatorHours } for
//                    a practicum, { ..., kind: 'SELF_PACED', hours: lecHours } for a Major whose lectures are
//                    self-paced online (Phase 3 Step 7; its labs are still demands)
//   unassignedMajors "CODE (SECTION)" for Major pairs without a lock
//   demandInfo       demandId -> display fields the gateway stores with each placed item
// A Major's scheduled online lecture (Phase 3 Step 7) is a demand with no room types; it carries
// `online: true`, on the demand and in demandInfo, and an on-campus demand never has the field, so every
// on-campus request is exactly what it was before (the recorded requests and the run hash stay).
const buildGaRequest = ({ policy, pairs, locks = [], faculty = [], facilities = [], seed = null }) => {
  const resolveHolder = buildFacultyResolver(faculty);
  const labStartSlots = policy.meetings.labStartTimes.map(t => slotOfTime(policy, t));
  const demands = [];
  const unscheduledItems = [];
  const unassignedMajors = [];
  const demandInfo = new Map();
  const usedFaculty = new Map();

  for (const { section, subject } of pairs) {
    const type = resolveSubjectType(subject);
    // The lock that staffs the pair: any Major lock, a Minor only when assigned manually, never NSTP.
    const found = type === 'NSTP' ? null : findLockFor(locks, section.sectionCode, subject);
    const lock = found && (type !== 'Minor' || found.source === 'manual') ? found : null;
    const holder = lock ? resolveHolder(lock) : null;
    const facultyRef = holder ? String(holder._id) : null;
    // Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher (a lock with source
    // 'outside'). No CCS professor (facultyRef null: no load, and no CCS room unless the box is
    // ticked); the demand carries `outsideTeacher` for the teacher's two rules (no double-booking in
    // any week group, the lunch hour) and never has the key otherwise, so every older request stays.
    const outside = type === 'Minor' && found && found.source === 'outside' && found.outsideTeacherRef ? String(found.outsideTeacherRef) : null;

    if (subject.isPracticum) {
      unscheduledItems.push({ sectionId: section._id, subjectId: subject._id, facultyRef: holder?._id || null, kind: 'PRACTICUM', hours: policy.load.ojtCoordinatorHours });
      continue;
    }
    if (type === 'NSTP' && !policy.nstp.yearLevels.includes(Number(section.yearLevel))) continue;
    if (type === 'Major' && !lock) unassignedMajors.push(`${subject.subjectCode} (${section.sectionCode})`);
    // A Major locked to someone who is no longer an active professor goes out as TBA too, and says so.
    else if (type === 'Major' && !holder && lock.facultyId !== TBA_POOL_FACULTY_ID) {
      unassignedMajors.push(`${subject.subjectCode} (${section.sectionCode}): locked to ${lock.facultyName}, who is not an active professor`);
    }
    if (holder) usedFaculty.set(facultyRef, holder);
    // Self-paced online lectures get no day, time or room (meetingsForSubject gives the labs only), but
    // the pair keeps its professor and its lecture hours (the load counts them; the outputs list them).
    const mode = lectureModeOf(subject);
    if (mode === 'ONLINE_SELF_PACED' && Number(subject.lecHours) > 0) {
      unscheduledItems.push({ sectionId: section._id, subjectId: subject._id, facultyRef: holder?._id || null, kind: 'SELF_PACED', hours: Number(subject.lecHours) });
    }

    const sectionId = String(section._id);
    const subjectId = String(subject._id);
    const meetingGroup = `${sectionId}:${subjectId}`;
    const allowedDays = type === 'NSTP' ? [policy.nstp.day] : allowedDaysForSection(policy, section);
    // Phase 8: the section's odd/even week group (null while the switch is off, or for a program and
    // year the table does not list).
    const weekGroup = weekGroupOf(policy, section);
    // The per-class GenEd room rule (Phase 8): a Minor class with a professor needs a room.
    const roomOpts = { hasProfessor: Boolean(facultyRef) };

    for (const m of meetingsForSubject(subject, policy)) {
      const demandId = `${sectionId}:${subjectId}:${m.classType}:${m.meetingIndex}`;
      const isFullLab = m.classType === 'LAB' && m.hours === policy.meetings.labMaxMeetingHours;
      const online = m.classType === 'LEC' && mode === 'ONLINE_SCHEDULED';
      demands.push({
        demandId,
        subjectId,
        subjectCode: subject.subjectCode,
        sectionId,
        sectionCode: section.sectionCode,
        sectionSize: Number.isFinite(section.studentCount) ? section.studentCount : null,
        classType: m.classType,
        meetingGroup,
        durationSlots: Math.round(toSlots(policy, m.hours * 60)),
        facultyRef,
        isMinor: type !== 'Major',
        requiresRoom: allowedRoomTypesOf(subject, m.classType, policy, roomOpts).length > 0,
        allowedRoomTypes: allowedRoomTypesOf(subject, m.classType, policy, roomOpts),
        allowedDays,
        ...(weekGroup ? { weekGroup } : {}),
        ...(outside ? { outsideTeacher: outside, outsideTeacherName: found.facultyName } : {}),
        // A full-length lab meeting starts only at the policy's lab start times.
        allowedStarts: isFullLab ? labStartSlots : null,
        fixed: m.fixed ? { day: m.fixed.day, startSlot: slotOfTime(policy, m.fixed.start) } : null,
        ...(online ? { online: true } : {})
      });
      demandInfo.set(demandId, {
        subjectId, sectionId, subjectCode: subject.subjectCode, descriptiveTitle: subject.descriptiveTitle, sectionCode: section.sectionCode,
        facultyRef, facultyName: holder?.name || (outside ? found.facultyName : 'TBA'), facultyId: holder?.facultyId || (outside ? OUTSIDE_FACULTY_ID : 'TBA'),
        isMinor: type !== 'Major', classType: m.classType, meetingIndex: m.meetingIndex, isFixed: Boolean(m.fixed),
        ...(online ? { online: true } : {}),
        ...(outside ? { outsideTeacherRef: outside } : {})
      });
    }
  }

  const request = {
    policy: buildGaPolicy(policy, seed),
    faculty: [...usedFaculty.entries()].map(([facultyRef, f]) => ({
      facultyRef,
      name: f.name,
      // Phase 8 Part 6 (decision 5): the single-class-day rule tells the employment types apart —
      // part-timers come to campus only for their classes. A faculty entry without the flag (the
      // pre-Part 6 golden cases) keeps the old counting.
      fullTime: f.employmentType !== 'PART_TIME',
      unavailable: schedulingUnavailableBlocks(f, policy)
        .filter(b => toMinutes(b.start) !== null && toMinutes(b.end) !== null)
        .map(b => windowToSlots(policy, b))
        .filter(Boolean)
    })),
    // A room whose availability windows all fall outside the grid is never usable, so it is left out
    // (an empty list would mean "available whenever the policy allows").
    rooms: [
      ...facilities
        .map(r => ({
          roomId: String(r._id),
          roomName: r.roomName,
          roomType: r.type,
          capacity: Number.isFinite(r.capacity) ? r.capacity : null,
          availability: (r.availability || []).map(w => windowToSlots(policy, w)).filter(Boolean),
          hadWindows: (r.availability || []).length > 0
        }))
        .filter(r => !r.hadWindows || r.availability.length > 0)
        .map(({ hadWindows, ...room }) => room),
      // The CCS and borrowed rooms first, then the extra rooms (when switched on).
      ...extraRoomsOf(policy)
    ],
    demands
  };
  return { request, unscheduledItems, unassignedMajors, demandInfo };
};

module.exports = { buildGaPolicy, buildGaRequest, allowedRoomTypesOf, windowToSlots, extraRoomsOf, tbaRoomCounts, extraRoomName, isExtraRoomKey, parseExtraRoomKey, tbaRoomName };
