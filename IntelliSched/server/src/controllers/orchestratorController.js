const mongoose = require('mongoose');
const mlClient = require('../config/mlClient');
const SubjectCatalog = require('../models/SubjectCatalog');
const CurriculumMapping = require('../models/CurriculumMapping');
const Facility = require('../models/Facility');
const Faculty = require('../models/Faculty');
const Section = require('../models/Section');
const MotherSchedule = require('../models/MotherSchedule');
const AuditEvent = require('../models/AuditEvent');
const { checkScheduleVersion, LEGACY_READ_ONLY, NOT_IN_TERM, isCheckedItem, readOnlyVersionMessage, shownStatus } = require('../utils/versionCheck');
const { buildGaRequest, isExtraRoomKey, extraRoomName } = require('../utils/gaRequest');
const { extraRoomUse, resultCounts, lastCheckOf, isLegacySchedule, noRoomName } = require('../utils/scheduleItems');
const { SOFT_TERMS } = require('../utils/constraints');
const { runPreflight } = require('../utils/preflight');
const { loadTermInputs, findTermMappings, findTermDraft, findTermLockSource, nextVersionName, NEWEST_FIRST } = require('../utils/termInputs');
const { loadPolicy, mergePolicy } = require('../utils/policy');
const { timeOfSlot, DAY_NAMES } = require('../utils/timeGrid');
// Who made each decision (Phase 2 Step 0): every row written below stores the acting user.
const { actorOf } = require('../utils/actor');
// Who may sign each approval stage (Phase 3 Step 6: the one permission map).
const { can, reasonFor } = require('../utils/permissions');
const { notAllowed } = require('../middleware/roles');
// The one load rule and the term's lock-based assignments (Guardian, loads endpoint, validator HC5).
const { facultyLoad, weightedHoursOf, labFactorOf } = require('../utils/load');
const { nobodyTaughtBefore } = require('../utils/teachingRecord');
const { TBA_POOL_FACULTY_ID, OUTSIDE_FACULTY_ID, buildTermAssignments, termLoads, countsTowardLoad, namesSubject, versionLocks } = require('../utils/termAssignments');
// Subject classification (Scenario A: Minor and NSTP are TBA) and the Automated Section Matcher.
const {
  resolveSubjectType,
  isTbaSubject,
  toSemesterLabel,
  buildTermPairs,
  findLockFor
} = require('../utils/curriculumMatcher');

const { plainMessage, serviceWords } = require('../utils/messages');
// The page gets plain words; the raw error goes to the server log (utils/messages.js, Phase 4 Part 4).
const getSanitizedMessage = (err, defaultMsg) => plainMessage(err, defaultMsg, { label: '[Orchestrator]' });

// The subject code of the rows approve-stage writes (the Audit Trail shows them as "Approval stage
// signed").
const APPROVAL_CHAIN = 'APPROVAL-CHAIN';


const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// Resolves a faculty reference sent by the client (facultyId, Mongo _id or display name) to
// the stored document. Returns null when nothing matches; callers must never invent a value.
// The code and the _id are tried first: two profiles can share a name, and a name match must never
// win over the professor the code names. A name alone prefers an active profile.
const resolveFaculty = async (ref, nameHint) => {
  const cleanRef = String(ref ?? '').trim();
  const cleanName = String(nameHint ?? '').trim();

  if (cleanRef) {
    const byCode = await Faculty.findOne({ facultyId: cleanRef.toUpperCase() });
    if (byCode) return byCode;
    if (/^[a-f\d]{24}$/i.test(cleanRef)) {
      const byId = await Faculty.findById(cleanRef);
      if (byId) return byId;
    }
  }
  const names = [...new Set([cleanRef, cleanName].filter(Boolean))];
  if (!names.length) return null;
  return Faculty.findOne({ name: { $in: names } }).sort({ isActive: -1 });
};

// Distinct subject preparations already committed to a faculty member on this schedule:
// authoritative locks plus GA-placed teaching items. ACTIVITY chunks are not preparations. With
// `pairs` (the term's current (section, subject) pairs), a lock counts only while it still staffs a
// placement the load rule counts (a Major, a practicum, a manual Minor), so a lock left behind by a
// detached or disabled subject is not a preparation.
const countPreparations = (schedule, facultyDoc, pairs = null) => {
  if (!schedule || !facultyDoc) return null;
  const subjects = new Set();

  // A preparation is one catalog subject; entries written before subjectId existed count by code.
  const preparationKey = (entry) => (entry.subjectId ? `id:${entry.subjectId}` : `code:${entry.subjectCode}`);
  const staffsAPlacement = (lock) => !pairs || pairs.some(({ section, subject }) =>
    findLockFor([lock], section.sectionCode, subject) && countsTowardLoad(subject, lock));
  (schedule.lockedAssignments || []).forEach(lock => {
    if ((lock.facultyId === facultyDoc.facultyId || lock.facultyName === facultyDoc.name) && staffsAPlacement(lock)) {
      subjects.add(preparationKey(lock));
    }
  });
  (schedule.scheduleData || []).forEach(item => {
    if (item.type === 'ACTIVITY') return;
    if (item.facultyId === facultyDoc.facultyId || item.facultyName === facultyDoc.name) {
      subjects.add(preparationKey(item));
    }
  });

  return subjects.size;
};

// Engine 4 feature slice for one faculty member, read from stored facts only.
// evalScore stays on the institutional 1.0-5.0 scale, null for "no CCS evaluation yet" (a stored 0;
// Phase 4 Part 2: the retrainer reads null as its neutral default, never as a low rating);
// ancillaryHours are weekly hours.
const { ratingOrNone } = require('../utils/evaluation');
const { isAcademicYear, academicYearOf } = require('../utils/academicCalendar');
const buildFacultyTelemetry = (facultyDoc, schedule, pairs = null) => ({
  evalScore: ratingOrNone(facultyDoc?.evalScore?.average),
  // Phase 11.2: part-timers have no ancillary loads, so a stored value counts as 0.
  ancillaryHours: facultyDoc?.employmentType === 'PART_TIME' ? 0 : toFiniteNumber(facultyDoc?.ancillaryLoad?.hours),
  prepCount: countPreparations(schedule, facultyDoc, pairs)
});

// The term's pre-generation Draft: the one document the lock routes write, generateSchedule reads,
// and the lock list and the Overload Guardian display. Every lock path goes through here, so they
// can never disagree about which schedule holds a term's locks. A term is an academic year and a
// semester: one run covers BSIT and BSCS together, so no lookup filters by program (older documents
// say 'BSIT', new ones 'ALL'; a `program` sent by an older client is ignored).
const TERM_PROGRAM = 'ALL';
// That Draft is the term's newest Draft by age, and a version 2 Draft always wins over a legacy one
// (findTermDraft, utils/termInputs.js): moving a class in an older Draft never makes it the current one.

// Legacy documents (isLegacySchedule, utils/scheduleItems.js) are read-only, read with lean(), and
// never saved or updated again by any code path.
// The legacy read-only words, the read-only Draft words and the whole-version check (checkScheduleVersion)
// live in utils/versionCheck.js since Phase 4 Part 1 (Fill TBA rooms reuses them).
// Query filter for the documents a bulk update may touch (legacy ones never).
const WRITABLE_VERSIONS = { schemaVersion: { $gte: 2 } };

// The term a restore or an approval names (Phase 3 Step 5: a version is looked up in its term only,
// never guessed): { academicYear, semester } or null.
const termOfBody = (body) => {
  const academicYear = String(body?.academicYear ?? '').trim();
  const semester = Number(body?.semester);
  return isAcademicYear(academicYear) && [1, 2].includes(semester) ? { academicYear, semester } : null;
};
const NO_TERM = 'Choose an academic year (YYYY-YYYY) and a semester (1st or 2nd).';
// A version id that is not one of the term's (the words of GET /schedule/outputs).
const notInTerm = (term) => ({
  code: 'VERSION_NOT_IN_TERM',
  message: `That version does not belong to the ${toSemesterLabel(term.semester)}, AY ${term.academicYear}. Choose a version from the list.`
});
const versionName = (doc) => doc?.version || 'This version';
const conflictsText = (n) => `${n} ${n === 1 ? 'conflict' : 'conflicts'}`;
// The whole-version check as a version keeps it (lastCheck): "Validate schedule" (Phase 3 Step 4) and
// every approval stage (Step 5) store it the same way.
const lastCheckFrom = (result, checkedAt, req) => ({
  checkedAt,
  hardTotal: result.violationCount,
  violationCount: result.violations.length,
  by: actorOf(req)
});

// The Draft a lock or decision row is written to: the document holding the term's locks
// (findTermLockSource) when it is a Draft that is not legacy. Otherwise a new Draft (schemaVersion 2)
// takes its locks over, the way every GA version carries them forward: when the newest Draft is a legacy
// document (never re-saved), and (Phase 3 Step 8) when the newest version was sent for review,
// approved or published, which stays read-only. With create = false, null when the term has neither.
const isWritableDraft = (doc) => Boolean(doc) && doc.status === 'Draft' && !isLegacySchedule(doc);
const writableTermDraft = async (term, session, { create = true, actor = null } = {}) => {
  const draft = await findTermLockSource(term, session);
  if (isWritableDraft(draft)) return draft;
  if (!draft && !create) return null;
  const [fresh] = await MotherSchedule.create([{
    academicYear: term.academicYear,
    semester: Number(term.semester),
    program: TERM_PROGRAM,
    schemaVersion: 2,
    status: 'Draft',
    version: 'v0.1-pregen',
    scheduleData: [],
    overrideLogs: [],
    lockedAssignments: draft ? draft.toObject().lockedAssignments : [],
    // The user whose lock or decision needed this Draft.
    ...(actor ? { createdBy: actor } : {})
  }], { session });
  return fresh;
};

// The term's current (section, subject) pairs, the same set generateSchedule builds demands from.
const loadTermPairs = async (semester) => {
  const [sections, mappings] = await Promise.all([Section.find({ isActive: true }), findTermMappings(semester)]);
  return buildTermPairs(sections, mappings);
};

// A proposed move of one class in a saved version: { itemId, day, startSlot, roomId } where roomId is a
// room's id, an extra room's key ("EXTRA-LAB-1", Phase 2) or null (TBA). Returns { item, itemId, day,
// startSlot, roomId } or { error, status }; the validator then checks the room against the version's
// own rooms (an extra room exists only when the version's policy had it).
const parseItemChange = (doc, change) => {
  const item = (doc.scheduleData || []).find(i => i._id && String(i._id) === String(change?.itemId));
  if (!item) return { error: 'That class is not in this schedule version. Reload the page and try again.', status: 404 };
  if (item.isFixed) return { error: `${item.subjectCode} (${item.section}) is fixed by the Scheduling Policy and cannot be moved.`, status: 400 };
  if (!DAY_NAMES.includes(change.day)) return { error: 'Choose a day from the list.', status: 400 };
  const startSlot = Number(change.startSlot);
  if (!Number.isInteger(startSlot) || startSlot < 0 || startSlot > 47) return { error: 'Choose a start time from the list.', status: 400 };
  const roomId = change.roomId === null || change.roomId === undefined || change.roomId === '' ? null : String(change.roomId);
  if (roomId !== null && !mongoose.isValidObjectId(roomId) && !isExtraRoomKey(roomId)) return { error: 'Choose a room from the list, a TBA room, or TBA.', status: 400 };
  return { item, itemId: String(item._id), day: change.day, startSlot, roomId };
};

// Log rows a released or replaced lock takes back with it, so Engine 4 never trains on an
// assignment the Dean reversed.
const RETRACTABLE_ENTRY_TYPES = ['lock', 'accept', 'override'];

// namesSubject (utils/termAssignments.js): a lock or log entry names this subject by catalog id when
// both sides have one, otherwise by subject code.
const isRetractable = (entry, { sectionCode, subjectId, subjectCode, since }) =>
  RETRACTABLE_ENTRY_TYPES.includes(entry.entryType) &&
  (entry.sectionCode || entry.section) === sectionCode &&
  namesSubject(entry, subjectId, subjectCode) &&
  new Date(entry.timestamp).getTime() >= since;

// Removes those rows from every schedule document of the term: Engine 4 reads the logs of all of
// them, and a decision may have been logged on a Draft that a later GA run has since superseded.
// `current` (the Draft the caller is editing and will save) is filtered in memory; the others are
// written directly, without validation and without touching their updatedAt (their own last change).
const retractDecisionRows = async ({ term, current, session, ...target }) => {
  current.overrideLogs = current.overrideLogs.filter(entry => !isRetractable(entry, target));
  const others = await MotherSchedule.find({
    academicYear: term.academicYear,
    semester: Number(term.semester),
    _id: { $ne: current._id },
    ...WRITABLE_VERSIONS
  }).select('overrideLogs').session(session);
  for (const doc of others) {
    const kept = doc.overrideLogs.filter(entry => !isRetractable(entry, target));
    if (kept.length !== doc.overrideLogs.length) {
      await MotherSchedule.updateOne({ _id: doc._id }, { $set: { overrideLogs: kept } }, { session, timestamps: false });
    }
  }
};

// The distinct active catalog subjects a set of mappings places, in first-seen order.
const uniqueActiveSubjects = (mappings) => {
  const subjects = new Map();
  mappings.forEach(mapping => {
    const subject = mapping.subject;
    if (subject && subject.isActive !== false && !subjects.has(String(subject._id))) subjects.set(String(subject._id), subject);
  });
  return [...subjects.values()];
};

// Identity and hours of the catalog subject behind a prediction. Several catalog subjects can share
// one code (e.g. ITST 301 on each BSIT track), so the client pairs rows by subjectId.
const describeSubject = (subject) => {
  const lecHours = toFiniteNumber(subject.lecHours) || 0;
  const labHours = toFiniteNumber(subject.labHours) || 0;
  return {
    subjectId: String(subject._id),
    subjectTitle: subject.descriptiveTitle,
    type: resolveSubjectType(subject),
    lecHours,
    labHours,
    contactHours: lecHours + labHours
  };
};

// Engines 1 & 2 read subjectTitle / subjectDescription; the catalog calls the title descriptiveTitle.
// Phase 5: the catalog id (Engine 2 matches the professors' teaching history by it) and the programs
// whose sections take the subject (its program experience feature).
const toEngineSubject = (subject, programs = []) => ({
  subjectCode: subject.subjectCode,
  subjectTitle: subject.descriptiveTitle,
  subjectDescription: subject.subjectDescription || subject.descriptiveTitle,
  subjectId: String(subject._id),
  programs: [...new Set(programs.filter(Boolean).map(p => String(p).toUpperCase()))]
});

// The programs of a subject in a set of curriculum mappings (populated `subject`, or a bare subjectId).
const programsOf = (subject, mappings) => mappings
  .filter(m => String(m.subject?._id ?? m.subject ?? '') === String(subject._id))
  .map(m => m.program);

const tbaCandidate = (subject, detail = '') => ({
  id: 'TBA',
  name: 'TBA',
  score: 100,
  reason: `${resolveSubjectType(subject)} subject: TBA (Institutional Pool)${detail}.`,
  rank: 1,
  dataQualityFlag: true
});

// Resolves a faculty reference (facultyId, Mongo _id or, failing both, the display name) against an
// already loaded roster.
const buildFacultyIndex = (faculty) => {
  const byRef = new Map();
  faculty.forEach(f => {
    byRef.set(String(f._id), f);
    if (f.facultyId) byRef.set(String(f.facultyId).trim().toUpperCase(), f);
  });
  return (ref, name) => {
    const cleanRef = String(ref ?? '').trim();
    const cleanName = String(name ?? '').trim();
    return byRef.get(cleanRef) || byRef.get(cleanRef.toUpperCase())
      || (cleanName ? faculty.find(f => f.name === cleanName) : null) || null;
  };
};


// =========================================================================
// 1. RECOMMENDATION ROUTES (Engines 1 & 2 via mlClient)
// =========================================================================

exports.getRecommendations = async (req, res, next) => {
  try {
    const { subjectId, subjectCode, academicYear, semester } = req.body || {};

    // A catalog subject by id; a caller that only knows the code gets the first active match.
    const course = mongoose.isValidObjectId(subjectId)
      ? await SubjectCatalog.findOne({ _id: subjectId, isActive: true })
      : await SubjectCatalog.findOne({ subjectCode: String(subjectCode ?? '').trim().toUpperCase(), isActive: true });
    if (!course) {
      return res.status(404).json({ message: `Subject ${subjectCode || subjectId || '(none given)'} not found or inactive.` });
    }

    if (isTbaSubject(course)) {
      return res.status(200).json({
        subjectCode: course.subjectCode,
        ...describeSubject(course),
        candidates: [tbaCandidate(course, ', staffed by the GenEd departments')]
      });
    }

    // Phase 5: the programs whose curricula place the subject, and the term when the caller names one
    // (the Schedule Views' change-professor panel sends its version's term; the history features count
    // the terms before it).
    const mappings = await CurriculumMapping.find({ subject: course._id }).select('program subject').lean();
    const termSemester = [1, 2].includes(Number(semester)) ? Number(semester) : null;
    const aiRes = await mlClient.post('/api/get_recommendations', {
      subjects: [toEngineSubject(course, programsOf(course, mappings))],
      ...(academicYear && termSemester ? { academicYear: String(academicYear), semester: termSemester } : {})
    });
    const prediction = aiRes.data.predictions?.[0] || { subjectCode: course.subjectCode, candidates: [] };

    res.status(200).json({ ...prediction, ...describeSubject(course) });
  } catch (err) {
    console.error('[Orchestrator Error - Recommendations]', err);
    res.status(502).json({
      success: false,
      message: getSanitizedMessage(err, 'The recommendations could not be loaded because the ranking service did not answer. Try again in a minute.')
    });
  }
};

exports.getBatchRecommendations = async (req, res, next) => {
  try {
    // The term whose curriculum is ranked and whose draft locks count toward each candidate's
    // currentLoad (the Candidate Ranking page sends the Global Term Context).
    const { academicYear = academicYearOf(new Date()), semester = 1 } = req.body || {};
    const termSemester = Number(semester);
    if (![1, 2].includes(termSemester)) {
      return res.status(400).json({ success: false, message: 'Semester must be 1st Semester (1) or 2nd Semester (2).' });
    }

    // The catalog is timeless, so only the subjects the term's curriculum places are ranked.
    const termMappings = await findTermMappings(termSemester);
    const termSubjects = uniqueActiveSubjects(termMappings);
    if (!termSubjects.length) {
      return res.status(200).json({
        status: 'success',
        predictions: [],
        message: `No active subjects are mapped to the ${toSemesterLabel(termSemester)} in the Curriculum Builder.`
      });
    }

    // Scenario A: only Majors reach Engines 1 & 2. Minor and NSTP subjects get a fixed TBA answer.
    // Practicum subjects are not ranked at all: their coordinator is chosen on the Course Matrix.
    const majorsToScore = termSubjects.filter(s => !isTbaSubject(s) && !s.isPracticum);
    const minorResults = termSubjects.filter(isTbaSubject).map(s => ({
      subjectCode: s.subjectCode,
      ...describeSubject(s),
      candidates: [tbaCandidate(s)]
    }));

    let majorResults = [];
    let facultyLoads = [];
    if (majorsToScore.length > 0) {
      const [facultyList, sections, draft, policy] = await Promise.all([
        Faculty.find({ isActive: true }),
        Section.find({ isActive: true }),
        findTermLockSource({ academicYear, semester: termSemester }),
        loadPolicy()
      ]);
      // Engine 2 prints the teaching cap in its reason text.
      const facultyLimits = {};
      facultyList.forEach(f => {
        if (Number.isFinite(f.teachingCapHours)) facultyLimits[f.name] = f.teachingCapHours;
      });

      const aiRes = await mlClient.post('/api/get_recommendations', {
        subjects: majorsToScore.map(s => toEngineSubject(s, programsOf(s, termMappings))),
        facultyLimits,
        // Phase 5: the term the ranking is for (the history features count the terms before it).
        academicYear: String(academicYear),
        semester: termSemester
      });
      const predictions = aiRes.data.predictions || [];

      // Real-Time Overload Guardian, the one load rule (utils/load.js): every candidate carries
      // their teaching hours already committed this term (currentLoad, from the term's locks,
      // findTermLockSource) next to their teaching cap, and addHours, what THIS subject would add for them
      // (lab hours x their lab factor). Ancillary hours are reported but are not part of the cap.
      // Caps are read from the database rather than the Python roster, which can lag behind edits.
      const pairs = buildTermPairs(sections, termMappings);
      const locks = draft?.lockedAssignments || [];
      const assignmentsByFaculty = buildTermAssignments({ faculty: facultyList, pairs, locks });
      const loadOf = (f) => facultyLoad(f, assignmentsByFaculty.get(String(f._id)) || [], policy);
      const resolve = buildFacultyIndex(facultyList);
      const withLoad = (candidate, subject) => {
        const owner = resolve(candidate?.id, candidate?.name);
        if (!owner) return { ...candidate, currentLoad: null, assignedHours: null, ancillaryHours: null, maxWeeklyHours: null, addHours: null };
        const load = loadOf(owner);
        return {
          ...candidate,
          currentLoad: load.teaching,
          assignedHours: load.teaching,
          ancillaryHours: load.ancillary,
          maxWeeklyHours: load.cap,
          // Phase 8 Part 4: the lower end of the professor's range ("14 of 18–21 h").
          minTeachingHours: load.min,
          employmentType: load.employmentType,
          addHours: subject ? weightedHoursOf(subject, owner, policy) : null
        };
      };
      facultyLoads = facultyList.map(f => ({ id: f.facultyId, facultyRef: String(f._id), name: f.name, ...loadOf(f) }));

      majorResults = predictions.map((prediction, index) => {
        // Engine 2 answers in the order the subjects were sent, so the index pairs each prediction
        // with its own catalog subject even when several subjects share a code.
        const subject = majorsToScore[index]?.subjectCode === prediction.subjectCode
          ? majorsToScore[index]
          : majorsToScore.find(s => s.subjectCode === prediction.subjectCode);
        return {
          ...prediction,
          ...(subject ? describeSubject(subject) : {}),
          // Phase 6: true when nobody on the current faculty has taught this subject before (the page
          // then calls the ranking weak); null when no teaching history is on record.
          nobodyTaughtBefore: subject ? nobodyTaughtBefore(subject, facultyList) : null,
          candidates: (prediction.candidates || []).map(c => withLoad(c, subject))
        };
      });
    }

    res.status(200).json({
      status: 'success',
      predictions: [...majorResults, ...minorResults],
      // Every active professor's current load, so the page can move loads optimistically for
      // any holder (also one who is not among a row's top candidates).
      facultyLoads
    });
  } catch (err) {
    console.error('[Orchestrator Error - Batch Recommendations]', err);
    res.status(502).json({
      success: false,
      message: getSanitizedMessage(err, 'The recommendations could not be loaded because the ranking service did not answer. Try again in a minute.')
    });
  }
};

// =========================================================================
// 2. AUTHORITATIVE PRE-GENERATION LOCK PIPELINE (Transactional)
// =========================================================================

exports.getLocks = async (req, res, next) => {
  try {
    const { academicYear = academicYearOf(new Date()), semester = 1 } = req.query;
    const draft = await findTermLockSource({ academicYear, semester });

    res.status(200).json({
      success: true,
      locks: draft?.lockedAssignments || []
    });
  } catch (err) {
    console.error('[Orchestrator Error - Get Locks]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, "The term's assignments could not be loaded. Try again.")
    });
  }
};

// A lock written from Candidate Ranking carries the Dean's decision ('accept' or 'override'). It is
// logged here, inside the lock transaction and from telemetry read before the lock applies, as the
// one Engine 4 row for that decision: prepCount then reflects the load the Dean saw, and a decision
// never produces a second training row. Course Matrix locks of a Major carry no decision and are
// logged as 'lock' bookkeeping. A manual Minor and a practicum coordinator are never ranked, so they
// write no overrideLogs row at all (Engine 4 trains on every row it finds there).
const DECISION_TYPES = ['accept', 'override'];
const LOCK_CLASS_TYPES = ['LEC', 'LAB', 'ALL'];

// What kind of lock a catalog subject takes: MAJOR (ranked), MINOR (manual), PRACTICUM (one
// coordinator) or NSTP (never locked).
const lockKindOf = (subject) => {
  const type = resolveSubjectType(subject);
  if (type === 'NSTP') return 'NSTP';
  if (type === 'Minor') return 'MINOR';
  return subject.isPracticum ? 'PRACTICUM' : 'MAJOR';
};

// Writes one (section, subject) assignment into the term's Draft the way Assign Faculty does, and is the
// one path for it (Phase 4 Part 2: "Change professor" in the Schedule Views & Editor goes through here
// too, controllers/manualEditsController.js): the lock replaced or added (a replaced lock takes its
// decision rows back), the overrideLogs row (an 'accept' or 'override' decision for a Major with a
// decision, else a 'lock' row; Engine 4 trains on the decisions) and the audit event for a Minor or a
// practicum coordinator. The caller has resolved and checked everything (the section, the catalog
// subject, the professor, the Overload Guardian) and runs inside a transaction. Returns the lock written.
const applyAssignment = async ({
  draft, session, term, cleanSubject, cleanSection, section, lockedSubject, classType, kind, cleanFacultyId, lockedFaculty,
  facultyName, units = 3, isDecision, facultyChanged, originalFacultyId, rejectedFaculty, mlTop1Faculty, mlTop1Score, reason,
  telemetry, selected, rejected, actor, now, lockedBy
}) => {
  const { academicYear, semester } = term;
  const lockSubjectId = lockedSubject?._id || null;
  const lockIndex = draft.lockedAssignments.findIndex(l =>
    l.sectionCode === cleanSection &&
    namesSubject(l, lockSubjectId, cleanSubject) &&
    (l.classType === classType || classType === 'ALL'));

  const lockPayload = {
    subjectCode: cleanSubject,
    ...(lockSubjectId ? { subjectId: lockSubjectId } : {}),
    sectionCode: cleanSection,
    sectionId: section._id,
    facultyId: cleanFacultyId,
    facultyRef: cleanFacultyId === TBA_POOL_FACULTY_ID ? null : lockedFaculty?._id || null,
    facultyName: String(facultyName).trim(),
    source: { MAJOR: isDecision ? 'ranking' : 'matrix', MINOR: 'manual', PRACTICUM: 'coordinator' }[kind],
    classType,
    units: Number(units) || 3,
    lockedBy: lockedBy || 'Dean',
    lockedAt: now
  };

  if (lockIndex !== -1) {
    // A reassignment supersedes the earlier decision: its rows go with the lock they belonged to,
    // so only the decision that now holds the lock stays in Engine 4's data.
    const replaced = draft.lockedAssignments[lockIndex];
    await retractDecisionRows({
      term: { academicYear, semester },
      current: draft,
      session,
      sectionCode: cleanSection,
      subjectId: lockSubjectId,
      subjectCode: cleanSubject,
      since: new Date(replaced.lockedAt || 0).getTime()
    });
    draft.lockedAssignments[lockIndex] = lockPayload;
  } else {
    draft.lockedAssignments.push(lockPayload);
  }

  const assignedName = lockedFaculty?.name || lockPayload.facultyName;
  if (kind === 'MAJOR') draft.overrideLogs.push(isDecision
    ? {
      entryType: facultyChanged ? 'override' : 'accept',
      subjectCode: cleanSubject,
      ...(lockSubjectId ? { subjectId: lockSubjectId } : {}),
      section: cleanSection,
      sectionCode: cleanSection,
      aiRecommendedFacultyId: originalFacultyId ? String(originalFacultyId) : undefined,
      aiRecommendedFacultyName: rejectedFaculty?.name || undefined,
      assignedFacultyId: cleanFacultyId,
      assignedFacultyName: assignedName,
      mlTop1Faculty: mlTop1Faculty || undefined,
      mlTop1Score: toFiniteNumber(mlTop1Score),
      deanSelectedFaculty: assignedName,
      reason: String(reason ?? '').trim() || (facultyChanged ? 'Manual Dean override' : 'Accepted the top recommendation'),
      selectedSemanticScore: toFiniteNumber(telemetry?.selectedSemanticScore),
      selectedEvalScore: selected.evalScore,
      selectedPrepCount: selected.prepCount,
      selectedAncillaryHours: selected.ancillaryHours,
      rejectedSemanticScore: facultyChanged ? toFiniteNumber(telemetry?.rejectedSemanticScore) : null,
      rejectedEvalScore: rejected.evalScore,
      rejectedPrepCount: rejected.prepCount,
      rejectedAncillaryHours: rejected.ancillaryHours,
      actor,
      timestamp: now
    }
    // A plain lock has no ML counterpart, so the rejected half of the vector and the semantic
    // score are left null rather than filled with placeholders.
    : {
      entryType: 'lock',
      subjectCode: cleanSubject,
      ...(lockSubjectId ? { subjectId: lockSubjectId } : {}),
      section: cleanSection,
      sectionCode: cleanSection,
      assignedFacultyId: cleanFacultyId,
      assignedFacultyName: assignedName,
      deanSelectedFaculty: lockPayload.facultyName,
      reason: String(reason ?? '').trim() || `Assigned on Assign Faculty (${{ LEC: 'lecture', LAB: 'lab' }[classType] || 'lecture and lab'})`,
      selectedEvalScore: selected.evalScore,
      selectedPrepCount: selected.prepCount,
      selectedAncillaryHours: selected.ancillaryHours,
      actor,
      timestamp: now
    });
  // A manual Minor and a practicum coordinator write no overrideLogs row (Engine 4 trains on those
  // rows), so the Audit Trail's record of who assigned them is an audit event.
  if (kind !== 'MAJOR') {
    await AuditEvent.create([{
      action: kind === 'MINOR' ? 'manual-assignment' : 'coordinator-assignment',
      category: 'Assignments',
      target: `${cleanSubject} (${cleanSection})`,
      detail: kind === 'MINOR'
        ? `${assignedName} assigned to teach this Minor subject (manual).`
        : `${assignedName} assigned as practicum coordinator.`,
      term: { academicYear: String(academicYear), semester: Number(semester) },
      actor,
      at: now
    }], { session });
  }
  return lockPayload;
};

exports.lockAssignment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      academicYear = academicYearOf(new Date()),
      semester = 1,
      subjectId,
      subjectCode,
      sectionCode,
      sectionId,
      facultyId,
      facultyName,
      classType: requestedClassType = 'ALL',
      units = 3,
      decision,
      originalFacultyId,
      mlTop1Faculty,
      mlTop1Score,
      reason,
      telemetry
    } = req.body;

    // Awaited at every call site: a bare `return refuse(...)` would let finally end the session
    // while the abort is still in flight.
    const refuse = async (status, message) => {
      await session.abortTransaction();
      return res.status(status).json({ success: false, message });
    };

    if (!subjectCode || !sectionCode || !facultyId || !facultyName) {
      return await refuse(400, 'Choose the subject, the section and the professor to assign.');
    }
    if (!LOCK_CLASS_TYPES.includes(requestedClassType)) return await refuse(400, 'Choose what to assign: the lecture, the lab or both.');

    const cleanSubject = String(subjectCode).trim().toUpperCase();
    const cleanSection = String(sectionCode).trim();

    // Every lock stores the section's _id. A sectionId pins it; otherwise the (unique) code finds it.
    let section = null;
    if (sectionId !== undefined && sectionId !== null && sectionId !== '') {
      if (!mongoose.isValidObjectId(sectionId)) return await refuse(400, 'That section could not be found. Reload the page and try again.');
      section = await Section.findById(sectionId).session(session);
      if (section && section.sectionCode !== cleanSection) return await refuse(400, `The section ${cleanSection} does not match ${section.sectionCode}. Reload the page and try again.`);
    } else {
      section = await Section.findOne({ sectionCode: cleanSection }).session(session);
    }
    if (!section) return await refuse(404, `No section ${cleanSection} exists. Add it on the Sections page first.`);

    // The catalog subject being locked. A subjectId pins it exactly (subjects can share a code); a
    // caller that sends only the code gets that code's Major.
    let lockedSubject = null;
    if (subjectId !== undefined && subjectId !== null && subjectId !== '') {
      if (!mongoose.isValidObjectId(subjectId)) return await refuse(400, 'That subject could not be found. Reload the page and try again.');
      lockedSubject = await SubjectCatalog.findById(subjectId).session(session);
      if (!lockedSubject) return await refuse(404, 'That subject no longer exists in the Master Catalog.');
      if (lockedSubject.subjectCode !== cleanSubject) return await refuse(400, `The subject ${cleanSubject} does not match ${lockedSubject.subjectCode} in the Master Catalog. Reload the page and try again.`);
    } else {
      const sameCode = await SubjectCatalog.find({ subjectCode: cleanSubject }).session(session);
      lockedSubject = sameCode.find(s => !isTbaSubject(s)) || sameCode[0] || null;
    }

    // NSTP is never locked (its professor is TBA). A Minor may be staffed manually by a CCS professor
    // and a practicum gets one coordinator; neither can go to the institutional pool card (leaving
    // them TBA means releasing the lock). Both are one lock per (section, subject).
    const kind = lockedSubject ? lockKindOf(lockedSubject) : 'MAJOR';
    if (kind === 'NSTP') {
      return await refuse(400, `${lockedSubject.subjectCode} is NSTP: its professor is TBA and it cannot be locked to a professor.`);
    }
    const cleanFacultyId = String(facultyId).trim();
    if (kind !== 'MAJOR' && cleanFacultyId === TBA_POOL_FACULTY_ID) {
      return await refuse(400, `Choose a professor for ${lockedSubject.subjectCode}, or release its lock to leave it TBA.`);
    }
    const classType = kind === 'MAJOR' ? requestedClassType : 'ALL';

    const actor = actorOf(req);
    const draft = await writableTermDraft({ academicYear, semester }, session, { actor });

    // Telemetry is read before the lock is applied so prepCount reflects the load the Dean saw at
    // decision time, not the load after this subject was added. Only locks that still staff one of
    // the term's placements count as preparations.
    const pairs = await loadTermPairs(semester);
    const lockedFaculty = await resolveFaculty(cleanFacultyId, facultyName);
    const selected = buildFacultyTelemetry(lockedFaculty, draft, pairs);
    // Only a Major is ranked, so only a Major lock can carry a decision for Engine 4.
    const isDecision = kind === 'MAJOR' && DECISION_TYPES.includes(decision);
    const facultyChanged = isDecision && Boolean(originalFacultyId) && String(originalFacultyId) !== cleanFacultyId;
    const rejectedFaculty = facultyChanged ? await resolveFaculty(originalFacultyId, mlTop1Faculty) : null;
    const rejected = buildFacultyTelemetry(rejectedFaculty, draft, pairs);

    // Overload Guardian (the one load rule, utils/load.js): the professor's teaching hours may not
    // pass their teaching cap. The pair being (re)assigned is left out of their current load first.
    if (cleanFacultyId !== TBA_POOL_FACULTY_ID) {
      if (!lockedSubject) return await refuse(404, `${cleanSubject} is not in the Master Catalog, so it cannot be locked.`);
      if (!lockedFaculty) return await refuse(404, `No faculty record matches ${String(facultyName).trim()}.`);
      if (lockedFaculty.isActive === false) return await refuse(400, `${lockedFaculty.name} is disabled. Enable the profile on the Faculty page before assigning classes.`);
      if (!Faculty.EMPLOYMENT_TYPES.includes(lockedFaculty.employmentType) || !Number.isFinite(lockedFaculty.teachingCapHours)) {
        return await refuse(400, `${lockedFaculty.name} has no employment type or teaching cap yet. Set both on the Faculty page before assigning classes.`);
      }
      const policy = await loadPolicy();
      const otherLocks = draft.lockedAssignments.filter(l => !(l.sectionCode === cleanSection && namesSubject(l, lockedSubject._id, cleanSubject)));
      const assignments = buildTermAssignments({ faculty: [lockedFaculty], pairs, locks: otherLocks }).get(String(lockedFaculty._id)) || [];
      const current = facultyLoad(lockedFaculty, assignments, policy);
      const add = weightedHoursOf(lockedSubject, lockedFaculty, policy);
      const projected = Math.round((current.teaching + add) * 100) / 100;
      if (projected > current.cap) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          code: 'CAPACITY_EXCEEDED',
          message: `Capacity Exceeded: ${lockedFaculty.name} teaches ${current.teaching} h; ${cleanSubject} (${cleanSection}) adds ${add} h (${kind === 'PRACTICUM' ? 'practicum coordination' : `lab hours × ${labFactorOf(lockedFaculty, policy)}`}), which makes ${projected} h, above the ${current.cap} h teaching cap.`,
          load: { teaching: current.teaching, add, projected, cap: current.cap }
        });
      }
    }

    const now = new Date();
    const lockPayload = await applyAssignment({
      draft, session, term: { academicYear, semester }, cleanSubject, cleanSection, section, lockedSubject, classType, kind,
      cleanFacultyId, lockedFaculty, facultyName, units, isDecision, facultyChanged, originalFacultyId, rejectedFaculty,
      mlTop1Faculty, mlTop1Score, reason, telemetry, selected, rejected, actor, now, lockedBy: req.user?.name || 'Dean'
    });

    await draft.save({ session });
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `${cleanSubject} (${cleanSection}) is assigned to ${lockPayload.facultyName}.`,
      locks: draft.lockedAssignments
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Orchestrator Error - Lock Assignment]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The assignment could not be saved. Try again.')
    });
  } finally {
    session.endSession();
  }
};

// POST /schedule/lock-outside { academicYear, semester, sectionId, sectionCode, subjectId, subjectCode,
// outsideTeacherId | name } (Phase 8 Part 8, decision 4): a GenEd (Minor) class taught by an outside
// teacher. The teacher comes from the list, or a typed name joins it; the term's Draft gets the pair's
// lock with source 'outside' (facultyId OUTSIDE, facultyRef null, outsideTeacherRef), replacing any
// earlier one, so the class has no CCS professor: no load, cap or minimum, and no CCS room unless its
// "Needs a CCS room" box is ticked. An audit event records it (never a decision row: Engine 4 learns
// from the Majors only). Releasing it is DELETE /schedule/lock, as for a CCS professor.
exports.lockOutsideTeacher = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { academicYear = academicYearOf(new Date()), semester = 1, subjectId, subjectCode, sectionCode, sectionId, outsideTeacherId, name, units = 3 } = req.body || {};
    const refuse = async (status, message, code) => {
      await session.abortTransaction();
      return res.status(status).json({ success: false, ...(code ? { code } : {}), message });
    };
    if (!subjectCode || !sectionCode) return await refuse(400, 'Choose the class (the subject and the section) first.');
    const cleanSubject = String(subjectCode).trim().toUpperCase();
    const cleanSection = String(sectionCode).trim();
    const section = sectionId && mongoose.isValidObjectId(sectionId)
      ? await Section.findById(sectionId).session(session)
      : await Section.findOne({ sectionCode: cleanSection }).session(session);
    if (!section || section.sectionCode !== cleanSection) return await refuse(404, `No section ${cleanSection} exists. Reload the page and try again.`);
    if (!subjectId || !mongoose.isValidObjectId(subjectId)) return await refuse(400, 'That subject could not be found. Reload the page and try again.');
    const subject = await SubjectCatalog.findById(subjectId).session(session);
    if (!subject || subject.subjectCode !== cleanSubject) return await refuse(404, `${cleanSubject} is not in the Master Catalog. Reload the page and try again.`);
    if (lockKindOf(subject) !== 'MINOR') {
      return await refuse(400, `${cleanSubject} is not a GenEd class: only a GenEd (Minor) class can have an outside teacher.`, 'NOT_A_GENED_CLASS');
    }

    const { findOrCreate } = require('./outsideTeachersController');
    const OutsideTeacher = require('../models/OutsideTeacher');
    let teacher = null;
    let created = false;
    if (outsideTeacherId) {
      if (!mongoose.isValidObjectId(outsideTeacherId)) return await refuse(404, 'That outside teacher is not on the list. Reload the page.');
      teacher = await OutsideTeacher.findById(outsideTeacherId).session(session);
      if (!teacher) return await refuse(404, 'That outside teacher is not on the list. Reload the page.');
    } else {
      const found = await findOrCreate(name, session);
      if (found.error) return await refuse(found.status, found.error, 'NAME_REQUIRED');
      ({ teacher, created } = found);
    }

    const actor = actorOf(req);
    const term = { academicYear, semester };
    const draft = await writableTermDraft(term, session, { actor });
    const now = new Date();
    const lockPayload = {
      subjectCode: cleanSubject,
      subjectId: subject._id,
      sectionCode: cleanSection,
      sectionId: section._id,
      facultyId: OUTSIDE_FACULTY_ID,
      facultyRef: null,
      facultyName: teacher.name,
      outsideTeacherRef: teacher._id,
      source: 'outside',
      classType: 'ALL',
      units: Number(units) || 3,
      lockedBy: req.user?.name || 'Dean',
      lockedAt: now
    };
    const index = draft.lockedAssignments.findIndex(l => l.sectionCode === cleanSection && namesSubject(l, subject._id, cleanSubject));
    if (index !== -1) draft.lockedAssignments[index] = lockPayload;
    else draft.lockedAssignments.push(lockPayload);
    await AuditEvent.create([{
      action: 'outside-assignment',
      category: 'Assignments',
      target: `${cleanSubject} (${cleanSection})`,
      detail: `${teacher.name} (outside teacher${created ? ', added to the list' : ''}) assigned to teach this GenEd subject.`,
      term: { academicYear: String(academicYear), semester: Number(semester) },
      actor,
      at: now
    }], { session });
    await draft.save({ session });
    await session.commitTransaction();
    res.status(200).json({
      success: true,
      created,
      teacher: { _id: String(teacher._id), name: teacher.name },
      message: `${cleanSubject} (${cleanSection}) is assigned to ${teacher.name} (outside teacher).`,
      locks: draft.lockedAssignments
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Orchestrator Error - Outside teacher]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The outside teacher could not be assigned. Try again.') });
  } finally {
    session.endSession();
  }
};

// GET /schedule/loads?academicYear&semester&program
// Every professor's load for the term by the one load rule, from the term's locks (findTermLockSource). The
// Course Matrix, the Faculty roster and the pre-flight check read the same numbers.
exports.getTermLoads = async (req, res, next) => {
  try {
    const { academicYear = academicYearOf(new Date()), semester = 1 } = req.query;
    const termSemester = Number(semester);
    if (![1, 2].includes(termSemester)) {
      return res.status(400).json({ success: false, message: 'Semester must be 1st Semester (1) or 2nd Semester (2).' });
    }
    const [faculty, sections, mappings, draft, policy] = await Promise.all([
      Faculty.find().sort({ name: 1 }),
      Section.find({ isActive: true }),
      findTermMappings(termSemester),
      findTermLockSource({ academicYear, semester: termSemester }),
      loadPolicy()
    ]);
    const loads = termLoads({ faculty, pairs: buildTermPairs(sections, mappings), locks: draft?.lockedAssignments || [], policy });
    res.status(200).json({ success: true, standardWeeklyHours: policy.load.standardWeeklyHours, loads });
  } catch (err) {
    console.error('[Orchestrator Error - Term Loads]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, "The faculty loads could not be worked out. Try again.") });
  }
};

exports.unlockAssignment = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      academicYear = academicYearOf(new Date()),
      semester = 1,
      subjectId,
      subjectCode,
      sectionCode
    } = req.body;

    if (!subjectCode || !sectionCode) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Choose the subject and the section whose assignment to release.' });
    }

    const term = { academicYear, semester };
    const cleanSubject = String(subjectCode).trim().toUpperCase();
    const cleanSection = String(sectionCode).trim();
    const targetId = mongoose.isValidObjectId(subjectId) ? String(subjectId) : null;
    const isTarget = (l) => l.sectionCode === cleanSection && namesSubject(l, targetId, cleanSubject);

    // The term's locks (findTermLockSource). When they sit on a version that is read-only (legacy, or
    // sent for review, approved or published), a new Draft takes them over first, but only when there
    // is something to release there: a release that finds nothing makes no Draft.
    const source = await findTermLockSource(term, session);
    if (!source) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'This term has no assignments yet, so there is nothing to release.' });
    }
    if (!isWritableDraft(source) && !(source.lockedAssignments || []).some(isTarget)) {
      await session.abortTransaction();
      return res.status(200).json({
        success: true,
        released: 0,
        message: `No lock was stored for ${cleanSubject} (${cleanSection}).`,
        locks: source.lockedAssignments || []
      });
    }
    const draft = await writableTermDraft(term, session, { create: false });

    // Every GA run carries the locks forward into a new Draft, so older Drafts of the term hold
    // copies. They are released too: otherwise the lock would come back as soon as the newest Draft
    // leaves Draft status. Older Drafts are written without touching their updatedAt (the newest
    // Draft is the newest by age either way, findTermDraft).
    const olderDrafts = await MotherSchedule.find({
      academicYear,
      semester: Number(semester),
      status: 'Draft',
      _id: { $ne: draft._id },
      ...WRITABLE_VERSIONS
    }).select('lockedAssignments').session(session);
    const released = draft.lockedAssignments.filter(isTarget);
    draft.lockedAssignments = draft.lockedAssignments.filter(l => !isTarget(l));
    for (const older of olderDrafts) {
      const releasedHere = older.lockedAssignments.filter(isTarget);
      if (!releasedHere.length) continue;
      released.push(...releasedHere);
      await MotherSchedule.updateOne(
        { _id: older._id },
        { $set: { lockedAssignments: older.lockedAssignments.filter(l => !isTarget(l)) } },
        { session, timestamps: false }
      );
    }

    // Take back the decision rows those locks produced (from the moment each was locked), on every
    // schedule document of the term, so Engine 4 never trains on an assignment the Dean reversed.
    if (released.length) {
      await retractDecisionRows({
        term,
        current: draft,
        session,
        sectionCode: cleanSection,
        subjectId: targetId,
        subjectCode: cleanSubject,
        since: Math.min(...released.map(l => new Date(l.lockedAt || 0).getTime()))
      });
      await AuditEvent.create([{
        action: 'lock-release',
        category: 'Assignments',
        target: `${cleanSubject} (${cleanSection})`,
        detail: `Assignment to ${released[0].facultyName} released; the class is TBA until someone is assigned.`,
        term: { academicYear: String(academicYear), semester: Number(semester) },
        actor: actorOf(req)
      }], { session });
    }

    await draft.save({ session });
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      released: released.length,
      message: released.length
        ? `Lock removed for ${cleanSubject} (${cleanSection}).`
        : `No lock was stored for ${cleanSubject} (${cleanSection}).`,
      locks: draft.lockedAssignments
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Orchestrator Error - Unlock Assignment]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The assignment could not be released. Try again.')
    });
  } finally {
    session.endSession();
  }
};

// =========================================================================
// 3. AUTHORITATIVE TIMETABLE GENERATION (Engine 3: GA)
// =========================================================================

// POST /schedule/generate runs the GA as a background job: controllers/generationController.js and
// utils/gaRuns.js (Phase 2 Step 4).

// =========================================================================
// 4. TELEMETRY, INGESTION & RETRAINING (Transactional)
// =========================================================================

// POST /schedule/validate { scheduleId, change?: { itemId, day, startSlot, roomId } }: the real
// validator on a saved version, optionally with one class moved (the Schedule Views & Editor's live
// check, on any version; only a Draft then saves the move). A check of the whole version is kept on it
// as lastCheck (Phase 3 Step 4); a preview of a move saves nothing.
// POST /schedule/preflight { academicYear, semester }: the Readiness Check's report for a term
// ({ ok, errors, warnings, info, checks, numbers, extraRooms, policySaved, dataLine, readiness }). Reads
// only; generate runs the same check on the same inputs, TBA rooms resolved the same way.
exports.preflightCheck = async (req, res) => {
  try {
    const academicYear = String(req.body?.academicYear ?? req.body?.targetAcademicYear ?? '').trim();
    const semester = Number(req.body?.semester ?? req.body?.targetSemester);
    if (!isAcademicYear(academicYear) || ![1, 2].includes(semester)) {
      return res.status(400).json({ success: false, message: 'Choose an academic year (YYYY-YYYY) and a semester (1st or 2nd).' });
    }
    // Full documents, exactly as generate loads them: the Section init hook turns old long track
    // labels into codes, which lean() would skip.
    const inputs = await loadTermInputs({ academicYear, semester });
    const report = runPreflight({ ...inputs, academicYear, semesterLabel: toSemesterLabel(semester) });
    res.status(200).json({ success: true, academicYear, semester, report });
  } catch (err) {
    console.error('[Orchestrator Error - Preflight]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The Readiness Check could not run. Try again.') });
  }
};

// Phase 8 Part 6 (decision 5): a move that takes a class to another day can leave a part-time
// professor with a weekday holding only one class meeting — on the day it left (another class of
// theirs stays alone) or on the day it joins (it is alone there). The validator lists every such
// day (partTimerSingleDays, exempt part-timers excluded); while the hard rule is on (5c) each one is
// also HC10, which names the lone class, so a conflict on the day the class LEFT is matched by the
// professor and the day.
const leftAloneBy = (v, move) => v.code === 'HC10_PART_TIMER_SINGLE_DAY' && Boolean(move.item?.facultyRef)
  && String(v.facultyRef) === String(move.item.facultyRef) && move.day !== move.item.day && v.day === move.item.day;
const blockingOf = (violations, move) => violations.filter(v => v.itemIds.includes(move.itemId) || leftAloneBy(v, move));
// While the rule is off, the same days are a warning in the move preview, never a refusal.
const partTimerLoneDayWarning = (result, move) => {
  const ref = move.item?.facultyRef;
  if (!ref || move.day === move.item.day) return null;
  const days = (result.partTimerSingleDays || []).filter(e => String(e.facultyRef) === String(ref) && (e.day === move.day || e.day === move.item.day));
  if (!days.length) return null;
  const named = DAY_NAMES.filter(day => days.some(e => e.day === day));
  return `${days[0].name} is a part-time professor, and this move leaves them with only one class on ${named.join(' and ')}. Part-timers come to campus only for their classes, so use a day they already teach where you can. The move can still be saved.`;
};

exports.validateSchedule = async (req, res) => {
  try {
    const { scheduleId, change } = req.body || {};
    if (!mongoose.isValidObjectId(scheduleId)) {
      return res.status(400).json({ success: false, message: 'Choose a schedule version to check.' });
    }
    const doc = await MotherSchedule.findById(scheduleId).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'That schedule version no longer exists. Reload the page.' });
    if (isLegacySchedule(doc)) return res.status(409).json({ success: false, legacy: true, message: LEGACY_READ_ONLY });

    const move = change ? parseItemChange(doc, change) : null;
    if (move?.error) return res.status(move.status).json({ success: false, message: move.error });
    const result = await checkScheduleVersion(doc, move);
    const movedViolations = move ? blockingOf(result.violations, move) : [];
    // The live preview of a move says when the class can't be checked at all (the move route refuses it).
    const notInTerm = Boolean(move) && !isCheckedItem(move.item, result);
    // Phase 8 Part 6 (decision 5): with the hard rule off, warn — never refuse — when an allowed
    // move leaves a part-timer with only one class on a weekday, naming the day.
    const partTimerWarning = move && movedViolations.length === 0 && !notInTerm
      ? partTimerLoneDayWarning(result, move)
      : null;
    const checkedAt = new Date();
    // Phase 3 Step 4: the "Validate schedule" result of the whole version is kept on it (the Term
    // Checklist's Review step, Step 5's approval page). A preview of a move stores nothing. Written
    // without timestamps, so updatedAt and the newest-Draft order stay as they are.
    if (!move) {
      await MotherSchedule.updateOne({ _id: doc._id }, { $set: { lastCheck: lastCheckFrom(result, checkedAt, req) } }, { timestamps: false });
    }
    res.status(200).json({
      success: true,
      scheduleId,
      valid: result.isValid,
      hardTotal: result.violationCount,
      hard: result.hard,
      violations: result.violations,
      ...(move ? { itemId: move.itemId, movedViolations, changeAllowed: movedViolations.length === 0 && !notInTerm, ...(partTimerWarning ? { partTimerWarning } : {}), ...(notInTerm ? { notInTerm: true, message: NOT_IN_TERM } : {}) } : {}),
      checkedAt: checkedAt.toISOString()
    });
  } catch (err) {
    console.error('[Orchestrator Error - Validate Schedule]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The schedule could not be checked. Try again.') });
  }
};

// A faculty decision row (POST /schedule/override without `updates`) is an 'accept' or an 'override'.
// Every other kind of row has its own writer, so this route never writes one, whatever the request
// names (Phase 3 Step 6 review): a lock only the lock route, an approval row only approve-stage, a class
// move only a request with the move itself. Returns the refusal's plain words, or null.
const notADecision = (entryType, subjectCode) => {
  if (entryType === 'approval' || String(subjectCode ?? '').trim().toUpperCase() === APPROVAL_CHAIN) {
    return "Approval stages are signed on the Approval page, not recorded here. Record a decision: 'accept' or 'override'.";
  }
  if (entryType === 'lock') return "A lock is saved by assigning a professor on Assign Faculty, not recorded here. Record a decision: 'accept' or 'override'.";
  if (entryType === 'schedule-edit') return "A class move is saved from the Schedule Views & Editor, with the move itself. Record a decision here: 'accept' or 'override'.";
  if (entryType !== undefined && entryType !== null && entryType !== '' && !DECISION_TYPES.includes(entryType)) {
    return "Choose the decision to record: 'accept' or 'override'.";
  }
  return null;
};

exports.recordOverride = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      scheduleId,
      academicYear = academicYearOf(new Date()),
      semester = 1,
      subjectCode,
      sectionCode,
      originalFacultyId,
      newFacultyId,
      mlTop1Faculty,
      mlTop1Score,
      deanSelectedFaculty,
      reason,
      telemetry,
      updates,
      decision
    } = req.body;

    // The row's kind follows the permission the route checked (schedulerRoutes.js), never the request:
    // with `updates` this is a class move (schedule.move), always a 'schedule-edit' row that names the
    // moved class as the version stores it; without, a faculty decision (faculty.assign), 'accept' or
    // 'override'. A move ignores the body's decision, entry type, subject, section, professors and
    // scores.
    const isScheduleEdit = Boolean(updates);
    // The Candidate Ranking UI sent a `decision` flag; older callers may send `entryType`.
    const entryType = req.body.entryType || decision;

    if (!isScheduleEdit) {
      if (!subjectCode || !newFacultyId) {
        await session.abortTransaction();
        return res.status(400).json({
          message: 'Choose the subject and the professor for this decision.'
        });
      }
      const problem = notADecision(entryType, subjectCode);
      if (problem) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: problem });
      }
    }

    let targetSchedule = null;

    if (scheduleId && mongoose.Types.ObjectId.isValid(scheduleId)) {
      targetSchedule = await MotherSchedule.findById(scheduleId).session(session);
    }

    // A legacy version is read-only: an editor move on it is refused, and a decision row goes to the
    // term's writable Draft instead.
    if (targetSchedule && isLegacySchedule(targetSchedule)) {
      if (updates) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, legacy: true, message: LEGACY_READ_ONLY });
      }
      targetSchedule = null;
    }

    // A move is saved only into a Draft. The status is read here, never taken from the page: it can
    // change while the page is open (an approval stage, a restore).
    if (updates && targetSchedule && targetSchedule.status !== 'Draft') {
      await session.abortTransaction();
      return res.status(409).json({ success: false, code: 'READ_ONLY_VERSION', message: readOnlyVersionMessage(targetSchedule.status) });
    }
    // A decision row never goes into a version under review, approved, published or archived (read-only
    // since Phase 3 Step 5): like a legacy version's, it goes to the term's writable Draft.
    if (!updates && targetSchedule && targetSchedule.status !== 'Draft') targetSchedule = null;

    if (!targetSchedule) {
      // The same Draft the lock routes write and the GA reads (created when the term has none).
      targetSchedule = await writableTermDraft({ academicYear, semester }, session, { actor: actorOf(req) });
    }

    // An editor move names its class by item _id (a subject meets more than once a week) and is
    // re-checked by the validator first: a move that breaks a hard rule for that class is refused.
    let move = null;
    if (updates) {
      move = parseItemChange(targetSchedule, updates);
      if (move.error) {
        await session.abortTransaction();
        return res.status(move.status).json({ success: false, message: move.error });
      }
      const check = await checkScheduleVersion(targetSchedule, move);
      // A class whose section or curriculum mapping left the term after the run has no demand, so the
      // validator never judged it: the move is refused rather than trusted (as a professor change or a
      // swap of it is, Phase 4 Part 2).
      if (!isCheckedItem(move.item, check)) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, code: 'NOT_IN_TERM', message: NOT_IN_TERM });
      }
      const blocking = blockingOf(check.violations, move);
      if (blocking.length) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: `This move would cause ${conflictsText(blocking.length)} for ${move.item.subjectCode} (${move.item.section}), so it was not saved.`,
          violations: blocking
        });
      }
      move.policy = check.policy;
      // The shared counting of the version with the class moved (the soft numbers after the move).
      move.soft = check.soft;
      move.softCounts = check.softCounts;
    }

    const scheduleItem = move
      ? targetSchedule.scheduleData.id(move.itemId)
      : (targetSchedule.scheduleData || []).find(item => item.subjectCode === subjectCode && item.section === (sectionCode || item.section)) || null;
    // Preparations count only locks that still staff one of the term's placements.
    const pairs = await loadTermPairs(targetSchedule.semester);

    let overrideEntry;
    if (move) {
      // A move changes when and where the class meets, never who teaches it: the row names the moved
      // class and its professor as the version stores them (the professor by _id). Engine 4 trains on
      // every row, so nothing in it comes from the request: no semantic scores, no recommended or
      // rejected professor; the professor's own facts are read from the Faculty record.
      const professor = scheduleItem.facultyRef ? await Faculty.findById(scheduleItem.facultyRef) : null;
      const facts = buildFacultyTelemetry(professor, targetSchedule, pairs);
      overrideEntry = {
        entryType: 'schedule-edit',
        subjectCode: scheduleItem.subjectCode,
        ...(scheduleItem.subjectId ? { subjectId: scheduleItem.subjectId } : {}),
        section: scheduleItem.section,
        sectionCode: scheduleItem.section,
        assignedFacultyId: scheduleItem.facultyId,
        assignedFacultyName: professor?.name || undefined,
        deanSelectedFaculty: professor?.name || undefined,
        reason: String(reason ?? '').trim() || 'Schedule editor move',
        selectedEvalScore: facts.evalScore,
        selectedPrepCount: facts.prepCount,
        selectedAncillaryHours: facts.ancillaryHours,
        actor: actorOf(req),
        timestamp: new Date()
      };
    } else {
      // A faculty decision: the client may state it ('accept' or 'override', checked above); otherwise
      // it is inferred from the shape of the request so the retrainer never has to parse free-text
      // reasons.
      const facultyChanged = Boolean(originalFacultyId) && String(originalFacultyId) !== String(newFacultyId);
      const resolvedEntryType = DECISION_TYPES.includes(entryType) ? entryType : (facultyChanged ? 'override' : 'accept');

      // Engine 4 feature vector from stored Faculty facts. The client's eval/prep/ancillary
      // values are ignored; only its semantic (candidate) scores are accepted. Anything the
      // gateway cannot resolve is persisted as null, never as a placeholder number.
      const [selectedFaculty, rejectedFaculty] = await Promise.all([
        resolveFaculty(newFacultyId, deanSelectedFaculty || scheduleItem?.facultyName),
        facultyChanged ? resolveFaculty(originalFacultyId, mlTop1Faculty) : Promise.resolve(null)
      ]);
      const selected = buildFacultyTelemetry(selectedFaculty, targetSchedule, pairs);
      const rejected = buildFacultyTelemetry(rejectedFaculty, targetSchedule, pairs);

      overrideEntry = {
        entryType: resolvedEntryType,
        subjectCode,
        sectionCode: sectionCode || undefined,
        aiRecommendedFacultyId: originalFacultyId || undefined,
        aiRecommendedFacultyName: rejectedFaculty?.name || undefined,
        assignedFacultyId: newFacultyId,
        assignedFacultyName: selectedFaculty?.name || undefined,
        mlTop1Faculty: mlTop1Faculty || undefined,
        mlTop1Score: toFiniteNumber(mlTop1Score),
        deanSelectedFaculty: deanSelectedFaculty || selectedFaculty?.name || undefined,
        reason: reason || 'Manual Dean override',
        selectedSemanticScore: toFiniteNumber(telemetry?.selectedSemanticScore),
        selectedEvalScore: selected.evalScore,
        selectedPrepCount: selected.prepCount,
        selectedAncillaryHours: selected.ancillaryHours,
        rejectedSemanticScore: facultyChanged ? toFiniteNumber(telemetry?.rejectedSemanticScore) : null,
        rejectedEvalScore: rejected.evalScore,
        rejectedPrepCount: rejected.prepCount,
        rejectedAncillaryHours: rejected.ancillaryHours,
        actor: actorOf(req),
        timestamp: new Date()
      };
    }

    targetSchedule.overrideLogs.push(overrideEntry);

    if (move) {
      const extraKey = isExtraRoomKey(move.roomId) ? move.roomId : null;
      const room = move.roomId && !extraKey ? await Facility.findById(move.roomId).session(session) : null;
      scheduleItem.day = move.day;
      scheduleItem.startSlot = move.startSlot;
      scheduleItem.roomId = room ? room._id : null;
      scheduleItem.extraRoomKey = extraKey || undefined;
      // A lecture held online stays online (it takes no room; the validator refused one above).
      scheduleItem.roomName = room ? room.roomName : extraKey ? extraRoomName(extraKey) : noRoomName(scheduleItem.isOnline === true);
      // 24-hour "HH:MM" on the grid of the policy the version was generated under; length unchanged.
      scheduleItem.startTime = timeOfSlot(move.policy, move.startSlot);
      scheduleItem.endTime = timeOfSlot(move.policy, move.startSlot + scheduleItem.durationSlots);
      // "Rooms to request", the soft breakdown and (Phase 3 Step 4) the classes in TBA rooms and on
      // Saturday follow the version as it is now, not only as the GA left it; the run's own numbers stay
      // in generation_runs. The TBA rooms the run had (tbaRooms) never change.
      if (targetSchedule.gaStats) {
        const items = targetSchedule.scheduleData.map(i => (i.toObject ? i.toObject() : i));
        targetSchedule.gaStats = {
          ...targetSchedule.gaStats,
          extraRoomUse: extraRoomUse(items),
          ...resultCounts(items),
          softBreakdown: Object.fromEntries(SOFT_TERMS.map(t => [t, move.soft[t]])),
          softTotal: move.soft.total,
          softCounts: move.softCounts,
          editedAfterRun: (Number(targetSchedule.gaStats.editedAfterRun) || 0) + 1
        };
        targetSchedule.markModified('gaStats');
      }
    }

    await targetSchedule.save({ session });
    await session.commitTransaction();

    res.status(200).json({
      status: 'success',
      message: isScheduleEdit ? 'The class move is saved.' : 'The decision is saved.',
      scheduleId: targetSchedule._id,
      override: overrideEntry
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('[Orchestrator Error - Record Override]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The change could not be saved. Try again.')
    });
  } finally {
    session.endSession();
  }
};

exports.syncRoster = async (req, res, next) => {
  try {
    const aiRes = await mlClient.post('/api/sync_roster', {});
    res.status(200).json(aiRes.data);
  } catch (err) {
    console.error('[Orchestrator Error - Sync Roster]', err);
    res.status(502).json({
      success: false,
      message: getSanitizedMessage(err, 'The faculty list could not be sent to the ranking service. Try again in a minute.')
    });
  }
};

exports.retrainModel = async (req, res, next) => {
  try {
    const aiRes = await mlClient.post('/api/retrain', {});
    res.status(200).json(aiRes.data);
  } catch (err) {
    // The Python service's own plain words when it answered (e.g. the decisions could not be read), else ours.
    res.status(502).json({
      success: false,
      message: serviceWords(err) || getSanitizedMessage(err, 'The ranking could not learn from the decisions this time. Try again in a minute.')
    });
  }
};

// =========================================================================
// 5. SCHEDULE RETRIEVAL, VERSIONS & MONOTONIC APPROVALS (Transactional)
// =========================================================================

exports.getActiveSchedule = async (req, res, next) => {
  try {
    const { academicYear = academicYearOf(new Date()), semester = 1 } = req.query;

    // The term's version to show, in this order: a version 2 document under review, approved or
    // published; a version 2 Draft with classes; then a legacy one the same way; then any Draft
    // (lock-only). lean(): a legacy document is shown exactly as stored (hydrating it would invent
    // item ids).
    const term = { academicYear, semester: Number(semester) };
    // A version asked for by id is shown when it belongs to this term; otherwise the term's version is
    // chosen as below.
    const { scheduleId } = req.query;
    if (scheduleId && mongoose.Types.ObjectId.isValid(String(scheduleId))) {
      const asked = await MotherSchedule.findOne({ _id: String(scheduleId), ...term }).lean();
      // Phase 8 Part 6: a version stored as Published reads as Approved (the rest as stored).
      if (asked) return res.status(200).json({ success: true, legacy: isLegacySchedule(asked), schedule: { ...asked, status: shownStatus(asked.status) } });
    }
    const ACTIVE = { $in: ['Approved', 'Published', 'Under Review'] };
    const HAS_ITEMS = { 'scheduleData.0': { $exists: true } };
    const V2 = { schemaVersion: { $gte: 2 } };
    const LEGACY = { schemaVersion: { $not: { $gte: 2 } } };
    let schedule = null;
    for (const filter of [
      { ...V2, status: ACTIVE },
      { ...V2, status: 'Draft', ...HAS_ITEMS },
      { ...LEGACY, status: ACTIVE },
      { ...LEGACY, status: 'Draft', ...HAS_ITEMS },
      { status: 'Draft' }
    ]) {
      // A Draft by age, the gateway's one "newest Draft" rule (findTermDraft); a version under review,
      // approved or published by its last change (the one signed off last; Phase 3 Step 5: a restore
      // makes a new Draft and never changes these).
      const order = filter.status === 'Draft' ? NEWEST_FIRST : { updatedAt: -1 };
      schedule = await MotherSchedule.findOne({ ...term, ...filter }).sort(order).lean();
      if (schedule) break;
    }

    if (!schedule) {
      return res.status(200).json({
        success: false,
        message: 'No schedule generated yet for this term.',
        schedule: null
      });
    }

    res.status(200).json({
      success: true,
      legacy: isLegacySchedule(schedule),
      schedule: { ...schedule, status: shownStatus(schedule.status) }
    });
  } catch (err) {
    console.error('[Orchestrator Error - Get Active Schedule]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The schedule could not be loaded. Try again.')
    });
  }
};

// Phase 11.4: the latest Approve row of a version (approvalStep 3; an older row by its words).
const approvedByOf = (v) => {
  const logs = v.overrideLogs || [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const row = logs[i];
    const isApproval = row.entryType === 'approval' || row.subjectCode === APPROVAL_CHAIN;
    if (!isApproval) continue;
    const step = Number(row.approvalStep) || (/^Dean sign-off:/.test(String(row.reason || '')) ? 3 : null);
    if (step !== 3) continue;
    const actor = row.actor || (row.deanSelectedFaculty ? { name: row.deanSelectedFaculty, role: row.aiRecommendedFacultyId || null } : null);
    return {
      name: actor?.name || null,
      role: actor?.role || null,
      at: row.timestamp ? new Date(row.timestamp).toISOString() : null,
      auditId: `LOG-${String(v._id)}-${i}`
    };
  }
  return null;
};

exports.getScheduleVersions = async (req, res, next) => {
  try {
    const { academicYear = academicYearOf(new Date()), semester = 1 } = req.query;
    const term = { academicYear, semester: Number(semester) };

    // Each class's demand id only: enough to count the classes and to tell a legacy version apart.
    const [versions, currentDraft] = await Promise.all([
      MotherSchedule.find(term)
        .select('version status academicYear semester program schemaVersion scheduleData.demandId gaStats hyperparameters lastCheck restoredFrom filledFrom notes createdAt updatedAt overrideLogs.entryType overrideLogs.approvalStep overrideLogs.subjectCode overrideLogs.reason overrideLogs.actor overrideLogs.timestamp overrideLogs.deanSelectedFaculty overrideLogs.aiRecommendedFacultyId')
        .sort({ createdAt: -1 })
        .lean(),
      findTermDraft(term).select('_id').lean()
    ]);

    // Only recorded facts: Engine 3's run statistics (none for a legacy document or a lock-only
    // Draft), the stored GA settings, the number of classes, and (Phase 3 Step 4) the last "Validate
    // schedule" of the version (null when never checked) and the classes moved since its run.
    // Phase 3 Step 5: `status` is the version's real status (Draft, Under Review, Approved, Archived;
    // Phase 8 Part 6: one stored as Published reads as Approved); `currentDraft` marks the term's
    // current Draft (findTermDraft: the one new assignments go to and a restore archives);
    // `restoredFrom` names the version a restored Draft copies.
    const formatted = versions.map((v) => {
      const totalClasses = v.scheduleData?.length || 0;
      const legacy = isLegacySchedule(v);
      const restoredFrom = v.restoredFrom?.id
        ? { id: String(v.restoredFrom.id), version: v.restoredFrom.version || null, status: shownStatus(v.restoredFrom.status) || null }
        : null;
      // Phase 4 Part 1: a Draft made by Fill TBA rooms names its source Draft and the classes it moved.
      const filledFrom = v.filledFrom?.id
        ? { id: String(v.filledFrom.id), version: v.filledFrom.version || null, classCount: Number.isFinite(v.filledFrom.classCount) ? v.filledFrom.classCount : null, hours: Number.isFinite(v.filledFrom.hours) ? v.filledFrom.hours : null }
        : null;
      return {
        id: v.version || `v1.${v._id.toString().slice(-2)}`,
        mongoId: v._id,
        date: new Date(v.createdAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        status: shownStatus(v.status),
        workflowStatus: shownStatus(v.status),
        legacy,
        currentDraft: Boolean(currentDraft) && String(currentDraft._id) === String(v._id),
        source: legacy
          ? 'Legacy record (before Phase 1)'
          : restoredFrom ? `Restored from ${restoredFrom.version || 'an earlier version'}`
            : filledFrom ? `TBA rooms filled from ${filledFrom.version || 'an earlier Draft'}`
              : v.gaStats ? 'Generated' : 'Assignments only (no timetable)',
        restoredFrom,
        filledFrom,
        gaStats: legacy ? null : v.gaStats || null,
        hyperparameters: v.gaStats ? v.hyperparameters || null : null,
        totalScheduled: totalClasses,
        // Phase 8 Part 3: the version's notes (the OJT placement writes one when a coordination's
        // hours did not fit one weekday).
        notes: Array.isArray(v.notes) ? v.notes : [],
        lastCheck: legacy ? null : lastCheckOf(v),
        editedAfterRun: legacy ? 0 : Number(v.gaStats?.editedAfterRun) || 0,
        // Phase 11.4: who approved this version (the latest Approve row): the account, its role, when,
        // and the Audit Trail entry's id (auditController's LOG-<version>-<row>); null when never approved.
        approvedBy: approvedByOf(v),
        updatedAt: v.updatedAt ? new Date(v.updatedAt).toISOString() : null
      };
    });

    res.status(200).json({
      success: true,
      count: formatted.length,
      versions: formatted
    });
  } catch (err) {
    console.error('[Orchestrator Error - Get Schedule Versions]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The versions could not be loaded. Try again.')
    });
  }
};

// POST /schedule/restore { mongoId, academicYear, semester } (Phase 3 Step 5; version.restore, the System
// Admin or the Dean, checked by the route since Step 6). Restoring a version makes a NEW Draft, a copy of
// it; a restore never approves or publishes anything (only the approval stages do, after their check).
// The copy:
//   - takes the version's classes, practicum lines, policy snapshot, run statistics and GA settings,
//     names the version it copies (restoredFrom), is created by the user who restored it, and takes
//     the next name in the term's v{n} sequence (nextVersionName, shared with the GA's Drafts);
//   - takes the term's locks (findTermLockSource: the current Draft's, or a newer version's under review,
//     approved or published), the assignments the Dean sees and works on now (the version's own may be
//     older: copying them would silently undo the Dean's later assignments), or the term's newest
//     version's when it has neither;
//   - starts with no decision rows: Engine 4 and the Audit Trail read the rows of every version, so a
//     copy of them would count every decision twice.
// The current Draft it replaces is archived (a legacy one is never changed). The chosen version and the
// term's Approved or Published version stay as they are. The version is looked up in the term only; a
// legacy version, a version with no classes and the current Draft itself are refused.
exports.restoreScheduleVersion = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Awaited at every call site, so finally never ends the session while the abort is in flight.
    const refuse = async (status, body) => {
      await session.abortTransaction();
      return res.status(status).json({ success: false, ...body });
    };
    const term = termOfBody(req.body);
    if (!term) return await refuse(400, { message: NO_TERM });
    const targetId = req.body.mongoId ?? req.body.scheduleId;
    if (!mongoose.isValidObjectId(targetId)) return await refuse(400, { message: 'Choose the version to restore.' });

    const target = await MotherSchedule.findOne({ _id: String(targetId), ...term }).session(session);
    if (!target) return await refuse(404, notInTerm(term));
    if (isLegacySchedule(target)) return await refuse(409, { legacy: true, message: LEGACY_READ_ONLY });
    const name = versionName(target);
    if (!target.scheduleData.length) {
      return await refuse(409, { code: 'NO_CLASSES', message: `${name} holds assignments only (no classes), so there is nothing to restore.` });
    }
    const current = await findTermDraft(term, session);
    if (current && String(current._id) === String(target._id)) {
      return await refuse(409, { code: 'ALREADY_CURRENT_DRAFT', message: `${name} is already the current Draft. Open it in the Schedule Views & Editor to change it.` });
    }
    // The term's locks (findTermLockSource: the current Draft's, or a newer version's under review,
    // approved or published), else the newest version's when the term has only archived ones.
    const lockSource = (await findTermLockSource(term, session)) || await MotherSchedule.findOne(term).sort(NEWEST_FIRST).session(session);

    const actor = actorOf(req);
    const version = await nextVersionName(term, session);
    const copied = target.toObject();
    const [copy] = await MotherSchedule.create([{
      academicYear: term.academicYear,
      semester: term.semester,
      program: TERM_PROGRAM,
      schemaVersion: 2,
      status: 'Draft',
      version,
      // The same classes; each gets its own item id in the new version.
      scheduleData: copied.scheduleData.map(({ _id, ...item }) => item),
      ...(copied.unscheduledItems ? { unscheduledItems: copied.unscheduledItems } : {}),
      ...(copied.policySnapshot ? { policySnapshot: copied.policySnapshot } : {}),
      ...(copied.gaStats ? { gaStats: copied.gaStats } : {}),
      ...(copied.hyperparameters ? { hyperparameters: copied.hyperparameters } : {}),
      overrideLogs: [],
      lockedAssignments: lockSource ? lockSource.toObject().lockedAssignments || [] : [],
      restoredFrom: { id: target._id, version: target.version, status: shownStatus(target.status) },
      ...(actor ? { createdBy: actor } : {})
    }], { session });

    // The Draft the copy replaces as the term's current one.
    const replaced = current && !isLegacySchedule(current) ? current : null;
    if (replaced) await MotherSchedule.updateOne({ _id: replaced._id }, { $set: { status: 'Archived' } }, { session });
    const replacedText = replaced ? ` ${versionName(replaced)} (the Draft it replaces) is archived.` : '';

    await AuditEvent.create([{
      action: 'version-restore',
      category: 'Approval',
      target: `${name} (${term.academicYear} Sem ${term.semester})`,
      detail: `${name} (${shownStatus(target.status)}) was restored as the new Draft ${version}.${replacedText} ${name} itself did not change.`,
      term,
      actor
    }], { session });
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      message: `${name} was restored as the new Draft ${version}.${replacedText} ${name} itself did not change.`,
      schedule: copy,
      archived: replaced ? { id: String(replaced._id), version: replaced.version || null } : null
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Orchestrator Error - Restore Version]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The version could not be restored. Try again.')
    });
  } finally {
    session.endSession();
  }
};

// The approval stages of a version (the stages are those of Phase 1; Phase 3 Step 5 words): the status
// a stage starts from and ends in, the permission it needs (who may sign it: utils/permissions.js,
// Phase 8 Part 8: both stages are the Dean's — the review, then the approval),
// and how its result reads. Phase 8 Part 6 (decision 2): there is no Publish stage — an Approved
// version is final; it is exported and printed as it is. A version stored as Published (before Part
// 6) reads as Approved (shownStatus).
const APPROVAL_STAGES = {
  2: {
    name: 'Review', from: 'Draft', to: 'Under Review', action: 'approval.chairReview',
    done: 'is now Under Review: the Dean approves it next', logged: 'sent to the Dean (Under Review)'
  },
  3: {
    name: 'Dean sign-off', from: 'Under Review', to: 'Approved', action: 'approval.deanSignOff',
    done: "is approved: it is the term's final Mother Schedule, ready to export and print", logged: 'approved'
  }
};
const NEXT_STAGE_RULE = {
  2: 'only a Draft can be sent for review',
  3: 'only a version under review can be approved'
};
// Why a version in this status can't take this stage, and what to do instead.
const wrongStatusMessage = (step, name, stored) => {
  const status = shownStatus(stored);
  if (status === APPROVAL_STAGES[step].to) return `${name} is already ${status}.`;
  const hint = status === 'Draft' ? ' Send it for review first.'
    : status === 'Under Review' ? ' Approve it first.'
      : ' To change it, restore it as a new Draft on the Versions page.';
  return `${name} is ${status === 'Draft' ? 'a Draft' : status}: ${NEXT_STAGE_RULE[step]}.${hint}`;
};
// " v2 (Approved before) is archived." for the versions an approval archived.
const archivedText = (archived) => (archived.length
  ? ` ${archived.map(a => `${a.version || 'An earlier version'} (${shownStatus(a.status)} before)`).join(' and ')} ${archived.length === 1 ? 'is' : 'are'} archived.`
  : '');

// POST /schedule/approve-stage { scheduleId, academicYear, semester, stepNumber, notes } (Phase 3 Step 5):
// one approval stage of one version of the term; the version is always named, never guessed.
//   2  Review (the Dean: the conflicts and the corrections checked): Draft -> Under Review
//   3  Dean sign-off (the Dean): Under Review -> Approved, final (Phase 8 Part 6: no Publish stage)
// A role that may not sign the stage is refused with the permission map's 403 NOT_ALLOWED (its reason,
// then the role the user is signed in as), before the version is looked up.
// Every stage first checks the whole version (checkScheduleVersion, as "Validate schedule" does) and
// keeps the result on it as lastCheck either way: a version with conflicts is refused (409
// HAS_CONFLICTS) and nothing else changes. A version with no classes (assignments only) is never signed
// off. On Approve the term's earlier Approved version (or one stored as Published) is archived, so a
// term has one official version (a legacy one is never changed).
exports.advanceApprovalStage = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Awaited at every call site, so finally never ends the session while the abort is in flight.
    const refuse = async (status, body) => {
      await session.abortTransaction();
      return res.status(status).json({ success: false, ...body });
    };
    const user = req.user;
    if (!user) return await refuse(401, { message: 'Sign in to sign off a version.' });
    const term = termOfBody(req.body);
    if (!term) return await refuse(400, { message: NO_TERM });
    const { scheduleId, stepNumber, notes } = req.body;
    if (!mongoose.isValidObjectId(scheduleId)) return await refuse(400, { message: 'Choose the version to sign off.' });
    const step = Number(stepNumber);
    const stage = APPROVAL_STAGES[step];
    if (step === 4) return await refuse(400, { code: 'NO_PUBLISH', message: 'An Approved version is final: there is no Publish stage. Export and print it from Print Outputs.' });
    if (!stage) return await refuse(400, { message: 'Choose an approval stage: 2 (Review) or 3 (Dean sign-off).' });
    if (!can(user.role, stage.action)) {
      return await refuse(403, notAllowed(stage.action, `${reasonFor(stage.action)} You are signed in as ${user.role || 'a user with no role'}.`));
    }

    const schedule = await MotherSchedule.findOne({ _id: String(scheduleId), ...term }).session(session);
    if (!schedule) return await refuse(404, notInTerm(term));
    if (isLegacySchedule(schedule)) return await refuse(409, { legacy: true, message: LEGACY_READ_ONLY });
    const name = versionName(schedule);
    if (schedule.status !== stage.from) {
      return await refuse(409, { code: 'WRONG_STATUS', status: schedule.status, message: wrongStatusMessage(step, name, schedule.status) });
    }
    if (!schedule.scheduleData.length) {
      return await refuse(409, { code: 'NO_CLASSES', message: `${name} has no classes (it holds assignments only), so it can't be signed off. Generate a schedule first.` });
    }

    // The whole-version check, kept on the version whatever it finds (without touching updatedAt when
    // the stage is refused: nothing else about the version changes).
    const result = await checkScheduleVersion(schedule);
    const checkedAt = new Date();
    const lastCheck = lastCheckFrom(result, checkedAt, req);
    if (!result.isValid) {
      await session.abortTransaction();
      await MotherSchedule.updateOne({ _id: schedule._id }, { $set: { lastCheck } }, { timestamps: false });
      return res.status(409).json({
        success: false,
        code: 'HAS_CONFLICTS',
        hardTotal: result.violationCount,
        hard: result.hard,
        violations: result.violations,
        checkedAt: checkedAt.toISOString(),
        lastCheck: lastCheckOf({ lastCheck }),
        message: `This version has ${conflictsText(result.violationCount)}. Fix ${result.violationCount === 1 ? 'it' : 'them'} in the Schedule Views & Editor, then check again.`
      });
    }

    // One official version per term: approving archives the term's earlier Approved version, or one
    // stored as Published (never a legacy one).
    let archived = [];
    if (stage.to === 'Approved') {
      const earlier = await MotherSchedule.find({ ...term, _id: { $ne: schedule._id }, status: { $in: ['Approved', 'Published'] }, ...WRITABLE_VERSIONS })
        .select('version status schemaVersion scheduleData.demandId')
        .session(session)
        .lean();
      archived = earlier.filter(doc => !isLegacySchedule(doc)).map(doc => ({ id: String(doc._id), version: doc.version || null, status: shownStatus(doc.status) }));
      if (archived.length) {
        await MotherSchedule.updateMany({ _id: { $in: archived.map(a => a.id) } }, { $set: { status: 'Archived' } }, { session });
      }
    }

    schedule.status = stage.to;
    schedule.lastCheck = lastCheck;
    const remarks = String(notes ?? '').trim();
    // Approval bookkeeping carries no faculty decision, so the whole feature vector stays null.
    schedule.overrideLogs.push({
      entryType: 'approval',
      approvalStep: step,
      subjectCode: APPROVAL_CHAIN,
      section: 'ALL',
      aiRecommendedFacultyId: user.role,
      assignedFacultyId: String(user._id),
      deanSelectedFaculty: user.name,
      reason: `${stage.name}: ${name} ${stage.logged}.${archivedText(archived)}${remarks ? ` Remarks: ${remarks}` : ''}`,
      actor: actorOf(req),
      timestamp: checkedAt
    });

    await schedule.save({ session });
    await session.commitTransaction();

    res.status(200).json({
      success: true,
      status: schedule.status,
      message: `${name} ${stage.done}.${archivedText(archived)}`,
      archived,
      lastCheck: lastCheckOf({ lastCheck }),
      schedule
    });
    // Phase 11.3 (decision 4): a full backup and a readable copy after every approval, once it is saved
    // and answered; a failure is recorded and shown, never undoing the approval.
    if (stage.to === 'Approved' && process.env.BACKUP_AFTER_APPROVAL !== 'off') setImmediate(() => { require('../backup/scheduler').afterApproval(actorOf(req)); });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Orchestrator Error - Advance Approval]', err);
    res.status(500).json({
      success: false,
      message: getSanitizedMessage(err, 'The sign-off could not be saved. Try again.')
    });
  } finally {
    session.endSession();
  }
};
// Shared with controllers/manualEditsController.js (Phase 4 Part 2: "Change professor" writes the term's
// assignment and its decision row through the same path as Assign Faculty).
exports.applyAssignment = applyAssignment;
exports.buildFacultyTelemetry = buildFacultyTelemetry;
exports.loadTermPairs = loadTermPairs;
exports.lockKindOf = lockKindOf;
exports.retractDecisionRows = retractDecisionRows;
