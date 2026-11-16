// The three outputs of one schedule version (Phase 3 Step 1), all read from the same schedule records:
// the Mother Schedule (per section), the Teachers' Program (per professor) and the Room Program (per
// room), plus the "TBA rooms to request". GET /api/schedule/outputs (controllers/outputsController.js)
// loads a version and the records its classes name; this pure function (no database) joins them. The
// views, the print views and the CSV all read its answer, so every number is computed once, here.
//
// buildScheduleOutputs({ doc, policy, subjects, sections, faculty, facilities, settings, fallback })
//   doc         the version (lean): scheduleData, unscheduledItems, gaStats, status, term, timestamps
//   policy      the policy it was generated under (mergePolicy(doc.policySnapshot)), else the stored one
//   subjects, sections, faculty
//               the catalog subjects, sections and professors the version names, joined by _id (never
//               by code or name)
//   facilities  every active room, plus the inactive ones that hold classes (an inactive room without
//               classes is left out). A room with availability windows is BORROWED, otherwise CCS
//   settings    the Output Settings (utils/outputSettings.js: the stored document merged over its
//               defaults); anything not given has its OUTPUT_SETTING_DEFAULTS value
//   fallback    true when an official version was asked for and none exists (this is the draft choice)
// Returns { schedule, policy, classes, sections, faculty, rooms, tbaRequest, settings }, the Phase 3
// Step 1 contract, and on each professor the Teachers' Program contents (Step 2):
//   - header: the SF-029 facts (name, position, employment type, Major/Minor, co-curricular
//     activities, college, subjects taught, preparations);
//   - load: utils/load.js facultyLoad on this version's own assignments (termAssignments.js
//     versionAssignments), never on the newest Draft's locks; summary: its lines in the real form's
//     order, every value straight from the load;
//   - practicum (Phase 4 Part 4): a coordinator's On-The-Job Training boxes in free weekday time
//     (utils/practicumFill.js), placed before the duty blocks, and the hours that did not fit;
//   - ancillary: the duty blocks filled into free weekday time (utils/ancillaryFill.js, the office's
//     way since Phase 8 Part 3; part-timers get none), made here and never stored, and the hours that
//     did not fit (the form prints no note); dayTotals: the hours drawn per day — teaching only,
//     classes and On-The-Job Training, labs at the professor's lab factor, never the duty blocks
//     (Part 3 decision 1c) — and their sum.
// The Step 1 rules:
//   - names are today's: the catalog's code and title, the section's code and track, the professor's
//     name, position and employment type, the room's name. What the class stored is used only when the
//     record is gone;
//   - roomKind is CCS, BORROWED, TBA_ROOM (a TBA room to request, internally EXTRA-LAB-n / EXTRA-LEC-n),
//     ONLINE (Phase 3 Step 7: a Major lecture held online at a set day and time; the room line reads
//     "Online") or NO_ROOM (TBA: no CCS room needed, e.g. PE or NSTP). A TBA room's stored name ("Extra
//     LAB room 1 (TBA – to request)") is never shown: the class's roomName is null, and the rooms list
//     names the room with tbaRoomName ("TBA room 1 (lab)");
//   - self-paced online lectures (Phase 3 Step 7; the version's SELF_PACED unscheduled items) have no
//     day, time or room: each section and each professor lists them as selfPaced [{ subjectId,
//     subjectCode, subjectTitle, hours, sectionLabel, facultyName }] ("Online (self-paced)" under the
//     table), and their hours count in the professor's load (they are the subject's lecture hours);
//   - a room's hours available are the policy's weekday windows, plus the Saturday window while
//     Saturday overflow is on, cut to a borrowed room's availability windows (preflight.js hoursOn). A
//     TBA room has no windows, so it has the whole windows.
const { DAY_NAMES, hoursBetween } = require('./timeGrid');
const { officeOrderOf } = require('./officeOrder');
const { hoursOn } = require('./preflight');
const { extraRoomsOf, isExtraRoomKey, parseExtraRoomKey, tbaRoomName } = require('./gaRequest');
const { toProgramCode, toSemesterLabel, BSIT_TRACKS } = require('./curriculumMatcher');
const { weekGroupOf } = require('./policy');
// The outputs draw only the STORED unavailable times; the set Extension day is never drawn as
// unavailable (the EXTENSION duty fills it instead) — extensionDayFor resolves the day.
const { facultyUnavailableBlocks, extensionDayFor } = require('./facultyAvailability');
const { OUTPUT_SETTING_DEFAULTS } = require('./outputSettings');
const { facultyLoad, uniqueAssignments } = require('./load');
const { versionAssignments } = require('./termAssignments');
const { fillAncillary, extensionDayOf } = require('./ancillaryFill');
const { fillPracticum } = require('./practicumFill');
const { lastCheckOf } = require('./scheduleItems');

// The policy fields the views read: the grid, the days and their windows, lunch, the TBA rooms,
// (Phase 8) the odd/even week groups and (Part 2) the load and meetings blocks — the exports' fixed
// "Total 40 hours" row, the "Standard load" information line, and the system check's independent pass
// (the lab start times) read them from the version's own policy. Part 4 adds extensionDay, so the
// system check's Extension-day re-check reads the day the version was generated under.
const POLICY_FIELDS = ['slotMinutes', 'dayStart', 'dayEnd', 'weekdays', 'saturdayOverflow', 'nstp', 'lunch', 'overflowRooms', 'weekGroups', 'load', 'meetings', 'extensionDay'];

const idOf = (value) => (value === null || value === undefined || value === '' ? null : String(value));
const round2 = (n) => Math.round(n * 100) / 100;
const isoOf = (date) => (date ? new Date(date).toISOString() : null);
// Natural order for codes and names ("BSIT 2A" before "BSIT 10A").
const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
// Missing values sort after the others.
const nullsLast = (a, b) => (a === null || a === undefined) - (b === null || b === undefined);
const dayOrder = (day) => (DAY_NAMES.includes(day) ? DAY_NAMES.indexOf(day) : DAY_NAMES.length);
const hoursOfClass = (item) => {
  const hours = hoursBetween(item.startTime, item.endTime);
  return Number.isFinite(hours) && hours > 0 ? round2(hours) : 0;
};

// The NSTP component a title names, by its code or its full name, when it names exactly one of them;
// null otherwise (the seed's "CWTS 1 / ROTC 1" names two).
const NSTP_COMPONENTS = [
  ['CWTS', /\bCWTS\b|civic\s+welfare\s+training\s+service/i],
  ['ROTC', /\bROTC\b|reserve\s+officers?['’]?\s+training\s+corps/i],
  ['LTS', /\bLTS\b|literacy\s+training\s+service/i]
];
const nstpComponentOf = (title) => {
  const named = NSTP_COMPONENTS.filter(([, pattern]) => pattern.test(String(title ?? ''))).map(([code]) => code);
  return named.length === 1 ? named[0] : null;
};

// "BSIT 3A WMAD": the section code, plus its BSIT specialization track (WMAD, SMP or AMG) when the code
// does not already say it. Never IS: every BSCS section is on the IS track, so "BSCS 1A IS" would say
// nothing more (the college's forms print "BSCS IIIA"). The section's `track` is sent next to the
// label, so a page can still name the track.
const sectionLabelOf = (code, track) => {
  const text = String(code ?? '').trim();
  const trackCode = String(track ?? '').trim().toUpperCase();
  if (!BSIT_TRACKS.includes(trackCode)) return text;
  return text.toUpperCase().split(/[^A-Z0-9]+/).includes(trackCode) ? text : `${text} ${trackCode}`;
};

// Where a class sits. A room id names a CCS room, or a borrowed one when that room has availability
// windows; an extra-room key names a TBA room to request; a lecture held online (the item's isOnline,
// snapshotted when the version was saved) is ONLINE; anything else is TBA with no CCS room needed.
const roomKindOf = (roomId, extraRoomKey, facility, isOnline = false) => {
  if (roomId) return (facility?.availability || []).length ? 'BORROWED' : 'CCS';
  if (extraRoomKey) return 'TBA_ROOM';
  return isOnline ? 'ONLINE' : 'NO_ROOM';
};

const ROOM_KIND_ORDER = { CCS: 0, BORROWED: 1, TBA: 2 };
const ROOM_TYPE_ORDER = { LAB: 0, LEC: 1 };

const EMPLOYMENT_LABELS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
const textOf = (value) => String(value ?? '').trim();

// "Major/Minor" on the Teachers' Program (Phase 8 Part 8, decision 3c): the professor's Program, as last
// year's forms printed it ("Information Technology", "Computer Science"); blank when none. The old
// `major` text stays in the profile for the recommendations and no longer prints.
const majorMinorOf = (prof) => textOf(prof?.program);

// The professor's name as the SF-029's name lines write it (Phase 8 Part 3, decision 1d): the name in
// capitals, a comma and the degree — "FacultyMember, MSIT" — with the degree's own case kept
// ("PhD", "EdD", as on the scans). The office writes a comma BEFORE a generational suffix and none
// after it (Phase 8 Part 4, Step 0): "FacultyMember MSIT". A name that already carries the
// degree ("FacultyMember, PhD") is not given it twice. Without a degree, the name in capitals alone.
const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
// "Faculty JR." -> "Faculty, JR." (a stored comma is kept, never doubled).
const withSuffixComma = (upper) => upper.replace(/([^\s,])\s+((?:JR|SR|II|III|IV|V)\.?)$/, '$1, $2');
const sf029NameWithDegree = (name, degree) => {
  const deg = textOf(degree);
  let base = textOf(name);
  if (!deg) return withSuffixComma(base.toUpperCase());
  const carried = new RegExp(`[,\\s]+${deg.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.?$`, 'i');
  base = base.replace(carried, '').trim();
  const lastWord = (base.split(/\s+/).pop() || '').replace(/[.,]/g, '').toUpperCase();
  return NAME_SUFFIXES.has(lastWord) ? `${withSuffixComma(base.toUpperCase())} ${deg}` : `${base.toUpperCase()}, ${deg}`;
};

// The SF-029 load summary box as the real forms fill it (Phase 4 Part 4, Step 1; the 2nd Sem AY 2025-26
// forms in docs/data/past_faculty_loads.csv). Every number is the load's own (utils/load.js): the
// presentation differs by employment type, the rule does not.
//   Full-time (and a profile with no employment type, whose lab hours count in full):
//     "Teaching Duties (Lecture)" = ALL teaching hours (lecture + lab x 1 + practicum coordination);
//     "(Lab.) ___ x .75 =" is left blank; the ancillary areas show their hours; TOTAL = teaching +
//     ancillary; Excess = TOTAL - the standard week, blank when there is none.
//   Part-time:
//     "Teaching Duties (Lecture)" = the class hours that are not lab (lecture, and practicum coordination
//     if ever); "(Lab.) N x .75 = M" filled in; the ancillary areas blank; TOTAL = lecture + M (the
//     teaching hours); Excess blank (Phase 11.2: part-timers have no ancillary loads).
//   The big number next to "SUMMARY OF TEACHING LOAD" = the teaching hours either way.
// There is no "Practicum coordination" line: the real forms have none (the coordination hours sit
// inside "Teaching Duties" and are drawn on the grid as On-The-Job Training boxes).
const SUMMARY_AREAS = [
  ['MANAGEMENT_FUNCTION', 'Management Function'],
  ['EXTENSION', 'Extension'],
  ['RESEARCH', 'Research'],
  ['CEE', 'Competitive Edge Enhancement'],
  ['CONSULTATION', 'Consultation/Preparation']
];
const loadSummary = (load, policy = null) => {
  // Phase 11.2 (decision 1): part-timers have no ancillary loads. Their five duty lines are blank,
  // TOTAL = the teaching load and Excess is blank (Phase 11.1's part-timer totals are undone; hours
  // stored on a part-time profile are already ignored by utils/load.js ancillaryByTypeOf).
  const partTime = load.employmentType === 'PART_TIME';
  const total = partTime ? load.teaching : load.total;
  const excess = partTime ? 0 : load.excess;
  const dutyHours = (key) => (partTime ? null : (load.ancillaryByType[key] > 0 ? load.ancillaryByType[key] : 0));
  return [
    // Phase 8 Part 3 (decision 1e): a full-timer's duty rows always carry their hours, 0 included
    // ("0 Hours" on the form, as Faculty's Management Function line); a part-timer's stay null and
    // print "Hours" with no number, as on Faculty's form.
    ...SUMMARY_AREAS.map(([key, label]) => ({ key, label, hours: dutyHours(key) })),
    { key: 'LECTURE', label: 'Teaching Duties (Lecture)', hours: partTime ? round2(load.lecHours + load.ojtHours) : load.teaching },
    partTime
      ? { key: 'LAB', label: '(Lab.)', hours: load.labHours, factor: load.labFactor, weighted: load.labWeighted }
      : { key: 'LAB', label: '(Lab.)', hours: null, factor: load.labFactor, weighted: null },
    { key: 'TEACHING', label: 'SUMMARY OF TEACHING LOAD', hours: load.teaching },
    { key: 'TOTAL', label: 'TOTAL NO. OF HOURS', hours: total },
    { key: 'EXCESS', label: 'Excess No. of Hours', hours: excess > 0 ? excess : null }
  ];
};

// The settings the outputs use: what was given over OUTPUT_SETTING_DEFAULTS, so a setting not given
// (or given as null) has its default. A copy: the answer shares no object with the defaults.
const outputSettingsOf = (settings) => {
  const given = Object.entries(settings || {}).filter(([, value]) => value !== undefined && value !== null);
  return JSON.parse(JSON.stringify({ ...OUTPUT_SETTING_DEFAULTS, ...Object.fromEntries(given) }));
};

const buildScheduleOutputs = ({ doc, policy, subjects = [], sections = [], faculty = [], facilities = [], settings = OUTPUT_SETTING_DEFAULTS, fallback = false, outsideTeachers = [] }) => {
  const byId = (list) => new Map(list.map(x => [String(x._id), x]));
  const subjectById = byId(subjects);
  const sectionById = byId(sections);
  const facultyById = byId(faculty);
  const facilityById = byId(facilities);
  // Phase 8 Part 8 (decision 4): the outside teachers the classes name, for their current names.
  const outsideById = byId(outsideTeachers);

  // A section as the outputs name it: today's code, program, year and track (the stored code alone
  // when the section record is gone).
  const sectionFacts = (sectionId, storedCode) => {
    const s = sectionById.get(sectionId);
    const code = s?.sectionCode || storedCode || '';
    const track = s ? s.track || 'NONE' : null;
    return {
      code,
      label: sectionLabelOf(code, track),
      program: s ? toProgramCode(s.program) : null,
      yearLevel: s ? Number(s.yearLevel) : null,
      track,
      isActive: s ? s.isActive !== false : false
    };
  };

  // ---------------------------------------------------------------- Classes (one per schedule item)
  const classes = (doc.scheduleData || []).map(item => {
    const subjectId = idOf(item.subjectId);
    const subject = subjectById.get(subjectId);
    const sectionId = idOf(item.sectionId);
    const section = sectionFacts(sectionId, item.section);
    const facultyRef = idOf(item.facultyRef);
    const prof = facultyRef ? facultyById.get(facultyRef) : null;
    // Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher prints the teacher's
    // name like a CCS professor's ("R. Santos" on the Class Schedule), but no CCS professor holds it:
    // no Teachers' Program, load or cap reads it.
    const outsideRef = facultyRef ? null : idOf(item.outsideTeacherRef);
    const outsideName = outsideRef ? outsideById.get(outsideRef)?.name || item.facultyName || 'TBA' : null;
    const roomId = idOf(item.roomId);
    const extraRoomKey = !roomId && isExtraRoomKey(item.extraRoomKey) ? item.extraRoomKey : null;
    const facility = roomId ? facilityById.get(roomId) : null;
    const roomKind = roomKindOf(roomId, extraRoomKey, facility, item.isOnline === true);
    const subjectTitle = subject?.descriptiveTitle || item.descriptiveTitle || '';
    // Only NSTP is fixed by the policy, so a fixed class counts as NSTP when its catalog entry is gone.
    const isNstp = subject ? subject.type === 'NSTP' : Boolean(item.isFixed);
    return {
      itemId: idOf(item._id),
      demandId: item.demandId || null,
      subjectId,
      subjectCode: subject?.subjectCode || item.subjectCode || '',
      subjectTitle,
      classType: item.type,
      isMinor: Boolean(item.isMinor),
      isNstp,
      isFixed: Boolean(item.isFixed),
      nstpComponent: isNstp ? nstpComponentOf(subjectTitle) : null,
      day: item.day,
      startTime: item.startTime,
      endTime: item.endTime,
      startSlot: item.startSlot ?? null,
      durationSlots: item.durationSlots ?? null,
      hours: hoursOfClass(item),
      sectionId,
      sectionCode: section.code,
      sectionLabel: section.label,
      program: section.program,
      yearLevel: section.yearLevel,
      track: section.track,
      // Phase 8: the section's odd/even week group under the version's policy (null while the switch
      // is off, for a program and year the table does not list, or when the section record is gone).
      weekGroup: weekGroupOf(policy, { program: section.program, yearLevel: section.yearLevel }),
      facultyRef,
      facultyId: facultyRef ? prof?.facultyId || item.facultyId || null : outsideRef ? 'OUTSIDE' : 'TBA',
      facultyName: facultyRef ? prof?.name || item.facultyName || 'TBA' : outsideName || 'TBA',
      ...(outsideRef ? { outsideTeacherRef: outsideRef, outsideTeacher: true } : {}),
      facultyPosition: prof?.position || null,
      employmentType: prof?.employmentType || null,
      roomKind,
      roomId,
      extraRoomKey,
      // The real room's name only (a room gone from Facilities keeps the name the class stored with it).
      roomName: roomKind === 'CCS' || roomKind === 'BORROWED' ? facility?.roomName || item.roomName || null : null,
      roomKey: roomId || extraRoomKey || null
    };
  }).sort((a, b) => byText(a.sectionLabel, b.sectionLabel)
    || dayOrder(a.day) - dayOrder(b.day)
    || byText(a.startTime, b.startTime)
    || byText(a.subjectCode, b.subjectCode)
    || byText(a.itemId, b.itemId));

  // ---------------------------------------------------------------- Sections (Mother Schedule)
  // Every section with classes or unscheduled items (practicum), with its subjects once each and the
  // catalog's units and hours.
  const sectionEntries = new Map();
  const sectionEntry = (sectionId, storedCode) => {
    if (!sectionEntries.has(sectionId)) {
      const { code, label, program, yearLevel, track, isActive } = sectionFacts(sectionId, storedCode);
      // Phase 8: the section's odd/even week group, for the Mother Schedule's note on its weeks.
      const weekGroup = weekGroupOf(policy, { program, yearLevel });
      sectionEntries.set(sectionId, { id: sectionId, code, label, program, yearLevel, track, weekGroup, isActive, classCount: 0, subjects: new Map() });
    }
    return sectionEntries.get(sectionId);
  };
  const addSubject = (entry, subjectId, stored, professor) => {
    const key = subjectId || `code:${stored.subjectCode}`;
    if (!entry.subjects.has(key)) {
      const subject = subjectById.get(subjectId);
      const catalogNumber = (value) => (subject && Number.isFinite(Number(value)) ? Number(value) : null);
      entry.subjects.set(key, {
        subjectId,
        subjectCode: subject?.subjectCode || stored.subjectCode || '',
        subjectTitle: subject?.descriptiveTitle || stored.subjectTitle || '',
        units: catalogNumber(subject?.units),
        lecHours: catalogNumber(subject?.lecHours),
        labHours: catalogNumber(subject?.labHours),
        professors: []
      });
    }
    const row = entry.subjects.get(key);
    if (professor && !row.professors.includes(professor)) row.professors.push(professor);
  };
  for (const cls of classes) {
    if (!cls.sectionId) continue;
    const entry = sectionEntry(cls.sectionId, cls.sectionCode);
    entry.classCount += 1;
    addSubject(entry, cls.subjectId, cls, cls.facultyName);
  }
  // Nothing to name without the section and catalog records (an unscheduled item stores no codes).
  const nameable = (u) => {
    const sectionId = idOf(u.sectionId);
    return Boolean(sectionId) && subjectById.has(idOf(u.subjectId)) && (sectionById.has(sectionId) || sectionEntries.has(sectionId));
  };
  for (const u of doc.unscheduledItems || []) {
    if (!nameable(u)) continue;
    const ref = idOf(u.facultyRef);
    addSubject(sectionEntry(idOf(u.sectionId), null), idOf(u.subjectId), {}, ref ? facultyById.get(ref)?.name || null : 'TBA');
  }
  // Phase 3 Step 7: the self-paced online lectures (SELF_PACED unscheduled items), named like the classes:
  // today's catalog code and title, the section's label, the professor's name (TBA when none).
  const selfPacedRows = (doc.unscheduledItems || []).filter(u => u.kind === 'SELF_PACED' && nameable(u)).map(u => {
    const subject = subjectById.get(idOf(u.subjectId));
    const facultyRef = idOf(u.facultyRef);
    return {
      sectionId: idOf(u.sectionId),
      facultyRef,
      row: {
        subjectId: idOf(u.subjectId),
        subjectCode: subject.subjectCode || '',
        subjectTitle: subject.descriptiveTitle || '',
        hours: round2(Number(u.hours) || 0),
        sectionLabel: sectionEntries.get(idOf(u.sectionId))?.label || '',
        facultyName: facultyRef ? facultyById.get(facultyRef)?.name || 'TBA' : 'TBA'
      }
    };
  }).sort((a, b) => byText(a.row.subjectCode, b.row.subjectCode) || byText(a.row.subjectTitle, b.row.subjectTitle) || byText(a.row.sectionLabel, b.row.sectionLabel));
  const selfPacedOf = (keep) => selfPacedRows.filter(keep).map(r => ({ ...r.row }));
  const sectionsOut = [...sectionEntries.values()].map(entry => {
    const list = [...entry.subjects.values()].sort((a, b) => byText(a.subjectCode, b.subjectCode) || byText(a.subjectTitle, b.subjectTitle) || byText(a.subjectId, b.subjectId));
    const total = (field) => round2(list.reduce((sum, s) => sum + (s[field] || 0), 0));
    return { ...entry, subjects: list, totals: { units: total('units'), lecHours: total('lecHours'), labHours: total('labHours') }, selfPaced: selfPacedOf(r => r.sectionId === entry.id) };
  }).sort((a, b) => nullsLast(a.program, b.program) || byText(a.program, b.program)
    || nullsLast(a.yearLevel, b.yearLevel) || (a.yearLevel ?? 0) - (b.yearLevel ?? 0)
    || byText(a.code, b.code) || byText(a.id, b.id));

  // ---------------------------------------------------------------- Professors (Teachers' Program)
  // Every professor with a class or an unscheduled item (a practicum coordinator); TBA is nobody.
  const facultyEntries = new Map();
  const facultyEntry = (ref, cls) => {
    if (!facultyEntries.has(ref)) {
      const prof = facultyById.get(ref);
      const name = prof?.name || cls?.facultyName;
      if (!name) return null;
      facultyEntries.set(ref, {
        id: ref,
        facultyId: prof?.facultyId || cls?.facultyId || null,
        name,
        position: prof?.position || null,
        employmentType: prof?.employmentType || null,
        isActive: prof ? prof.isActive !== false : false,
        classCount: 0,
        unavailable: prof ? facultyUnavailableBlocks(prof, policy) : []
      });
    }
    return facultyEntries.get(ref);
  };
  for (const cls of classes) {
    const entry = cls.facultyRef ? facultyEntry(cls.facultyRef, cls) : null;
    if (entry) entry.classCount += 1;
  }
  for (const u of doc.unscheduledItems || []) {
    const ref = idOf(u.facultyRef);
    if (ref) facultyEntry(ref, null);
  }

  // Each professor's Teachers' Program contents: the load of this version (its own assignments), the
  // SF-029 summary, the duty blocks and the day totals. A professor whose profile is gone keeps the
  // classes stored under their name: they count, with no position, employment type (lab hours count
  // in full), ancillary hours or cap.
  const settingsOut = outputSettingsOf(settings);
  const profiles = [...faculty, ...[...facultyEntries.values()].filter(e => !facultyById.has(e.id)).map(e => ({ _id: e.id, name: e.name }))];
  const assignmentsByFaculty = versionAssignments({ schedule: doc, subjects, sections, faculty: profiles });
  const classesOf = new Map();
  for (const cls of classes) {
    if (!cls.facultyRef || !facultyEntries.has(cls.facultyRef)) continue;
    if (!classesOf.has(cls.facultyRef)) classesOf.set(cls.facultyRef, []);
    classesOf.get(cls.facultyRef).push(cls);
  }
  const teachersProgramOf = (entry) => {
    const prof = facultyById.get(entry.id) || null;
    const assignments = assignmentsByFaculty.get(entry.id) || [];
    const load = facultyLoad(prof || {}, assignments, policy);
    const own = classesOf.get(entry.id) || [];
    const ownTimes = own.map(c => ({ day: c.day, start: c.startTime, end: c.endTime }));
    // Phase 4 Part 4: a coordinator's practicum hours (policy.load.ojtCoordinatorHours per practicum, the
    // same hours the load counts) are drawn as On-The-Job Training boxes in free weekday time, BEFORE the
    // ancillary fill, so the duty blocks go around them (utils/practicumFill.js).
    // Phase 8 Part 3 (decision 2): a coordination whose On-The-Job Training is a schedule record of
    // this version is already drawn with the classes — the print-time fill serves only the pairs
    // without records (a version saved before this part keeps its current look).
    const recordedOjt = new Set(classes.filter(c => c.classType === 'OJT').map(c => `${c.sectionId}:${c.subjectId}`));
    const coordinations = assignments.filter(a => a.kind === 'PRACTICUM' && !recordedOjt.has(`${a.sectionKey}:${a.subjectId}`)).map(a => {
      const section = sectionById.has(a.sectionKey) ? sectionFacts(a.sectionKey, null) : null;
      return {
        subjectCode: a.subject?.subjectCode || '',
        subjectTitle: subjectById.get(a.subjectId)?.descriptiveTitle || '',
        sectionId: section ? a.sectionKey : null,
        sectionLabel: section ? section.label : String(a.sectionKey ?? ''),
        hours: Number(policy.load?.ojtCoordinatorHours) || 0
      };
    });
    // The weekday the Extension duty will keep free (Phase 8 Part 3): the boxes stay off it, so the
    // fill's Friday (or latest class-free day) is still whole when the duties are drawn. Part 4
    // (decision 4): the set Extension day (the policy's, or the profile's override) comes first.
    const setExtensionDay = extensionDayFor(prof || { employmentType: entry.employmentType }, policy);
    const reservedDay = entry.employmentType !== 'PART_TIME' && load.ancillaryByType.EXTENSION > 0
      ? extensionDayOf(ownTimes, policy, setExtensionDay) : null;
    const practicum = fillPracticum({ coordinations, classes: ownTimes, unavailable: entry.unavailable, policy, reservedDay });
    const ancillary = fillAncillary({
      ancillaryByType: load.ancillaryByType,
      classes: [...ownTimes, ...practicum.blocks.map(b => ({ day: b.day, start: b.start, end: b.end }))],
      unavailable: entry.unavailable,
      policy,
      extensionDay: setExtensionDay,
      employmentType: prof?.employmentType || entry.employmentType || null
    });
    // The hours drawn on each day: teaching only — classes and On-The-Job Training, never the duty
    // blocks (Phase 8 Part 3, decision 1c, replacing the Phase 6 choice of counting the duties: the
    // real forms' day totals count the classes and the On-The-Job Training boxes alone — Faculty's
    // read 3, 6, 4, 8, 0, her 21 teaching hours). A lab class counts at the professor's lab factor,
    // as the real forms total it (a part-timer's 3-hour lab is 2.25 h), so the row's sum is the
    // teaching load whenever every hour fits on the grid. Unavailable times are never counted.
    const days = Object.fromEntries(DAY_NAMES.map(day => [day, 0]));
    const counted = (cls) => (cls.classType === 'LAB' ? cls.hours * load.labFactor : cls.hours);
    for (const cls of own) if (Object.hasOwn(days, cls.day)) days[cls.day] += counted(cls);
    for (const { day, hours } of practicum.blocks) if (Object.hasOwn(days, day)) days[day] += hours;
    DAY_NAMES.forEach(day => { days[day] = round2(days[day]); });
    return {
      header: {
        name: entry.name,
        // Phase 8 Part 3 (decision 1d): the SF-029's name lines carry the degree after the name.
        degree: textOf(prof?.degreeAfterName),
        nameWithDegree: sf029NameWithDegree(entry.name, prof?.degreeAfterName),
        position: textOf(prof?.position),
        employmentType: entry.employmentType,
        employmentLabel: EMPLOYMENT_LABELS[entry.employmentType] || '',
        majorMinor: majorMinorOf(prof),
        coCurricular: textOf(prof?.coCurricular),
        college: textOf(settingsOut.collegeName),
        // Each code once, in the load's order (practicum included). ITST 301 is a different subject
        // on each BSIT track, so there can be fewer codes than preparations.
        subjectsTaught: [...new Set(uniqueAssignments(assignments).map(a => a.subject?.subjectCode).filter(Boolean))],
        preparations: load.preparations
      },
      load,
      summary: loadSummary(load, policy),
      practicum,
      ancillary,
      dayTotals: { days, total: round2(DAY_NAMES.reduce((sum, day) => sum + days[day], 0)) }
    };
  };
  const facultyOut = [...facultyEntries.values()]
    .sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id))
    .map(entry => ({ ...entry, ...teachersProgramOf(entry), selfPaced: selfPacedOf(r => r.facultyRef === entry.id) }));

  // ---------------------------------------------------------------- Rooms (Room Program)
  // Phase 4 Part 4 (Part 1's open question 2, the audit's N27): a room's hours used and available are
  // counted on weekdays and on Saturday apart (hoursUsedWeekdays / hoursUsedSaturday, hoursAvailableWeekdays
  // / hoursAvailableSaturday); hoursUsed and hoursAvailable stay their sums.
  const usage = new Map();
  for (const cls of classes) {
    if (!cls.roomKey) continue;
    const used = usage.get(cls.roomKey) || { classCount: 0, hours: 0, hoursWeekdays: 0, hoursSaturday: 0 };
    used.classCount += 1;
    used.hours += cls.hours;
    if (cls.day === 'Saturday') used.hoursSaturday += cls.hours; else used.hoursWeekdays += cls.hours;
    usage.set(cls.roomKey, used);
  }
  const usedIn = (key) => usage.get(key) || { classCount: 0, hours: 0, hoursWeekdays: 0, hoursSaturday: 0 };
  const weekdays = (policy.weekdays || []).filter(day => day !== 'Saturday');
  const saturdayOpen = Boolean(policy.saturdayOverflow?.enabled) || (policy.weekdays || []).includes('Saturday');
  const hoursAvailableOn = (room, days) => round2(days.reduce((sum, day) => sum + hoursOn(policy, room, day), 0));
  const hoursAvailableIn = (room) => round2(hoursAvailableOn(room, weekdays) + (saturdayOpen ? hoursAvailableOn(room, ['Saturday']) : 0));
  const hoursFields = (key, room) => ({
    classCount: usedIn(key).classCount,
    hoursUsed: round2(usedIn(key).hours),
    hoursUsedWeekdays: round2(usedIn(key).hoursWeekdays),
    hoursUsedSaturday: round2(usedIn(key).hoursSaturday),
    hoursAvailable: hoursAvailableIn(room),
    hoursAvailableWeekdays: hoursAvailableOn(room, weekdays),
    hoursAvailableSaturday: saturdayOpen ? hoursAvailableOn(room, ['Saturday']) : 0,
    saturdayOpen
  });

  const facilityRooms = facilities
    .filter(r => r.isActive !== false || usage.has(String(r._id)))
    .map(r => {
      const key = String(r._id);
      const availability = (r.availability || []).map(w => ({ day: w.day, start: w.start, end: w.end }));
      return {
        key,
        roomId: key,
        extraRoomKey: null,
        name: r.roomName,
        kind: availability.length ? 'BORROWED' : 'CCS',
        type: r.type,
        tbaNumber: null,
        isActive: r.isActive !== false,
        ...hoursFields(key, r),
        availability
      };
    });
  // The policy's TBA rooms, and any TBA room a class sits in (a version saved under other counts).
  const tbaKeys = [...new Set([...extraRoomsOf(policy).map(r => r.roomId), ...classes.map(c => c.extraRoomKey).filter(Boolean)])];
  const tbaRooms = tbaKeys.map(key => {
    const { type, number } = parseExtraRoomKey(key);
    return {
      key,
      roomId: null,
      extraRoomKey: key,
      name: tbaRoomName(key),
      kind: 'TBA',
      type,
      tbaNumber: number,
      isActive: true,
      ...hoursFields(key, { availability: [] }),
      availability: []
    };
  });
  // CCS rooms by name, borrowed rooms by name, then the TBA rooms (LAB first, by number).
  const rooms = [...facilityRooms, ...tbaRooms].sort((a, b) => ROOM_KIND_ORDER[a.kind] - ROOM_KIND_ORDER[b.kind]
    || (a.kind === 'TBA' ? (ROOM_TYPE_ORDER[a.type] - ROOM_TYPE_ORDER[b.type]) || (a.tbaNumber - b.tbaNumber) : byText(a.name, b.name))
    || byText(a.key, b.key));

  // ---------------------------------------------------------------- TBA rooms to request
  // Only the TBA rooms that received classes, in the rooms' order.
  const requested = rooms.filter(r => r.kind === 'TBA' && r.classCount > 0);
  const tbaRequest = {
    classCount: classes.filter(c => c.roomKind === 'TBA_ROOM').length,
    labRooms: requested.filter(r => r.type === 'LAB').length,
    lecRooms: requested.filter(r => r.type === 'LEC').length,
    rooms: requested.map(r => ({ key: r.key, type: r.type, number: r.tbaNumber, name: r.name, classCount: r.classCount, hours: r.hoursUsed }))
  };

  // Phase 8 Part 6 (decision 2): no Publish — a version stored as Published reads as Approved (as
  // utils/versionCheck.js shownStatus); an Approved version is final.
  const status = doc.status === 'Published' ? 'Approved' : (doc.status || null);
  return {
    schedule: {
      id: idOf(doc._id),
      version: doc.version || null,
      status,
      academicYear: doc.academicYear,
      semester: Number(doc.semester),
      semesterLabel: toSemesterLabel(doc.semester),
      createdAt: isoOf(doc.createdAt),
      updatedAt: isoOf(doc.updatedAt),
      generated: Boolean(doc.gaStats),
      finalHard: doc.gaStats?.finalHard ?? null,
      editedAfterRun: Number(doc.gaStats?.editedAfterRun) || 0,
      // Phase 3 Step 4: the last "Validate schedule" of this version (null when never checked).
      lastCheck: lastCheckOf(doc),
      // Phase 4 Part 1: the Draft this one was filled from (Fill TBA rooms), else null.
      filledFrom: doc.filledFrom?.id ? { id: idOf(doc.filledFrom.id), version: doc.filledFrom.version || null, classCount: Number.isFinite(doc.filledFrom.classCount) ? doc.filledFrom.classCount : null } : null,
      // Phase 8 Part 3: the version's notes (today only the OJT placement writes one).
      notes: Array.isArray(doc.notes) ? [...doc.notes] : [],
      editable: status === 'Draft',
      isOfficial: status === 'Approved',
      fallback: Boolean(fallback)
    },
    policy: Object.fromEntries(POLICY_FIELDS.map(field => [field, structuredClone(policy[field])])),
    classes,
    sections: sectionsOut,
    faculty: facultyOut,
    rooms,
    tbaRequest,
    // Phase 11.1: the office's order for the printed sets and Print Outputs' pickers (ids and keys).
    officeOrder: officeOrderOf({ sections: sectionsOut, faculty: facultyOut, rooms }),
    settings: settingsOut
  };
};

module.exports = { buildScheduleOutputs, loadSummary, sectionLabelOf, nstpComponentOf, sf029NameWithDegree };
