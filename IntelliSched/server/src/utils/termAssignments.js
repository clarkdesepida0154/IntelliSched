// Turns a term's locks into each professor's assignments for the one load rule (utils/load.js).
// Used by the Overload Guardian (batch recommendations and the lock route), the loads endpoint
// (Course Matrix, Faculty roster), the validator (HC5) and the pre-flight check. A saved version's
// own assignments (versionLocks, versionAssignments) serve the version check and its Teachers' Programs.
const { resolveSubjectType, findLockFor } = require('./curriculumMatcher');
const { facultyLoad } = require('./load');

// The Course Matrix's "TBA (Institutional Pool)" card: a lock to it names no professor.
const TBA_POOL_FACULTY_ID = 'FAC-TBA';
// Phase 8 Part 8 (decision 4): the code an outside teacher's lock and class carry (source 'outside',
// outsideTeacherRef): never a CCS professor, so never a load, a cap or a Teachers' Program.
const OUTSIDE_FACULTY_ID = 'OUTSIDE';

// Resolves a lock's holder: by facultyRef (the _id), by faculty code, by Mongo id sent as the code,
// and, for locks written before codes were reliable, by display name.
const buildFacultyResolver = (faculty) => {
  const byRef = new Map();
  faculty.forEach(f => {
    byRef.set(String(f._id), f);
    if (f.facultyId) byRef.set(String(f.facultyId).trim().toUpperCase(), f);
  });
  return (lock) => {
    if (!lock || lock.facultyId === TBA_POOL_FACULTY_ID || lock.source === 'outside' || lock.facultyId === OUTSIDE_FACULTY_ID) return null;
    const ref = lock.facultyRef ? String(lock.facultyRef) : '';
    const code = String(lock.facultyId ?? '').trim();
    const name = String(lock.facultyName ?? '').trim();
    return (ref && byRef.get(ref)) || byRef.get(code) || byRef.get(code.toUpperCase())
      || (name ? faculty.find(f => f.name === name) : null) || null;
  };
};

// Which locked pairs count toward a load: every Major (the Dean's ranked assignment, practicum
// coordinators included) and a Minor only when the Dean assigned it manually. NSTP never counts.
const countsTowardLoad = (subject, lock) => {
  const type = resolveSubjectType(subject);
  if (type === 'NSTP') return false;
  if (type === 'Minor') return lock.source === 'manual';
  return true;
};

// Map String(faculty _id) -> [{ sectionKey, subjectId, subject, kind }] from the term's pairs and the
// locks on its newest Draft. Each (section, subject) appears once.
const buildTermAssignments = ({ faculty, pairs, locks }) => {
  const resolve = buildFacultyResolver(faculty);
  const byFaculty = new Map();
  for (const { section, subject } of pairs) {
    const lock = findLockFor(locks, section.sectionCode, subject);
    if (!lock || !countsTowardLoad(subject, lock)) continue;
    const owner = resolve(lock);
    if (!owner) continue;
    const id = String(owner._id);
    if (!byFaculty.has(id)) byFaculty.set(id, []);
    byFaculty.get(id).push({
      sectionKey: String(section._id ?? section.sectionCode),
      subjectId: String(subject._id),
      subject: {
        subjectCode: subject.subjectCode,
        lecHours: subject.lecHours,
        labHours: subject.labHours,
        isPracticum: Boolean(subject.isPracticum),
        type: resolveSubjectType(subject)
      },
      kind: subject.isPracticum ? 'PRACTICUM' : resolveSubjectType(subject) === 'Minor' ? 'MINOR' : 'MAJOR'
    });
  }
  return byFaculty;
};

// Phase 3 Step 4: how far a term's assignments are, one entry per (section, subject) pair, read the way
// the demand builder staffs a pair (utils/gaRequest.js): a Major (not a practicum) has a professor when
// its lock names an active professor; a Minor when a CCS professor was assigned to it by hand (source
// 'manual'); a practicum pair when it has a coordinator. A Major locked to the TBA pool (FAC-TBA), or to
// someone who is no longer an active professor, has no professor. NSTP is never assigned (its
// professor is TBA). `faculty` is the term's active professors.
//   [{ section, subject, kind: 'MAJOR' | 'MINOR' | 'PRACTICUM' | 'NSTP', lock, holder }]
const classifyTermPairs = ({ pairs = [], locks = [], faculty = [] }) => {
  const resolve = buildFacultyResolver(faculty);
  return pairs.map(({ section, subject }) => {
    const type = resolveSubjectType(subject);
    const kind = subject.isPracticum ? 'PRACTICUM' : type === 'NSTP' ? 'NSTP' : type === 'Minor' ? 'MINOR' : 'MAJOR';
    if (kind === 'NSTP') return { section, subject, kind, lock: null, holder: null };
    const found = findLockFor(locks, section.sectionCode, subject);
    const lock = found && (kind !== 'MINOR' || found.source === 'manual') ? found : null;
    return { section, subject, kind, lock, holder: lock ? resolve(lock) : null };
  });
};

// The counts Assign Faculty, the Term Checklist and the Readiness Check show, per pair:
// { majorPairs, majorAssigned, minorPairs, minorAssigned, practicumPairs, practicumWithCoordinator }.
const assignmentCounts = ({ pairs = [], locks = [], faculty = [] }) => {
  const classified = classifyTermPairs({ pairs, locks, faculty });
  const count = (kind, assigned) => classified.filter(p => p.kind === kind && (!assigned || Boolean(p.holder))).length;
  return {
    majorPairs: count('MAJOR'),
    majorAssigned: count('MAJOR', true),
    minorPairs: count('MINOR'),
    minorAssigned: count('MINOR', true),
    practicumPairs: count('PRACTICUM'),
    practicumWithCoordinator: count('PRACTICUM', true)
  };
};

// The Major pairs without a professor (the Readiness Check's "N Major classes have no professor"):
// [{ section, subject, lock }], lock null when the pair was never assigned.
const unassignedMajorPairs = ({ pairs = [], locks = [], faculty = [] }) =>
  classifyTermPairs({ pairs, locks, faculty }).filter(p => p.kind === 'MAJOR' && !p.holder).map(({ section, subject, lock }) => ({ section, subject, lock }));

// [{ facultyRef, facultyId, name, isActive, ...facultyLoad }] for the given faculty.
const termLoads = ({ faculty, pairs, locks, policy }) => {
  const assignments = buildTermAssignments({ faculty, pairs, locks });
  return faculty.map(f => ({
    facultyRef: String(f._id),
    facultyId: f.facultyId,
    name: f.name,
    isActive: f.isActive !== false,
    ...facultyLoad(f, assignments.get(String(f._id)) || [], policy)
  }));
};

// True when a lock or log entry names this subject: by catalog id when both sides have one,
// otherwise by subject code (entries written before subjectId existed).
const namesSubject = (entry, subjectId, subjectCode) => (subjectId && entry.subjectId
  ? String(entry.subjectId) === String(subjectId)
  : entry.subjectCode === subjectCode);

// The locks of one saved version (schemaVersion 2). The professors are the ones stored on its
// classes, not today's locks: a lock changed after the run moves the version's locks but not its
// classes. One lock per (section, subject) from the classes ('manual', so a Minor the Dean staffed
// counts); a pair with no classes (a practicum) keeps the version's own lock. Used to re-check a
// version (orchestratorController checkScheduleVersion) and for the load on its Teachers' Programs.
const versionLocks = (schedule) => {
  const items = schedule?.scheduleData || [];
  const itemLocks = new Map();
  for (const item of items) {
    const key = `${item.sectionId}:${item.subjectId}`;
    if (item.facultyRef && !itemLocks.has(key)) {
      itemLocks.set(key, {
        subjectCode: item.subjectCode, subjectId: item.subjectId, sectionCode: item.section, sectionId: item.sectionId,
        facultyId: item.facultyId, facultyRef: item.facultyRef, facultyName: item.facultyName, source: 'manual', classType: 'ALL'
      });
    }
  }
  const namesAnItemPair = (l) => items.some(i => i.section === l.sectionCode && namesSubject(l, i.subjectId, i.subjectCode));
  return [...itemLocks.values(), ...(schedule?.lockedAssignments || []).filter(l => !namesAnItemPair(l))];
};

// Each professor's assignments in one saved version (Map String(faculty _id) -> assignments, as
// buildTermAssignments): the version's own (section, subject) pairs, from its classes and its
// unscheduled items (practicum), staffed by versionLocks. So a Teachers' Program's load is the load
// of the version shown, never of the newest Draft's locks (GET /schedule/loads). A practicum's
// coordinator is first the one the version stored with it (its unscheduled item, as a class stores
// its professor; the outputs list that coordinator too), then the version's own lock. subjects and
// sections are the catalog and Section records, joined by _id; a pair whose catalog subject is gone is
// left out (its hours are unknown). A class's pair names its section by the code the class stored, the
// code its lock carries. The pairs are ordered by subject code, then section, so the same records
// always list the same assignments in the same order.
const versionAssignments = ({ schedule, subjects = [], sections = [], faculty = [] }) => {
  const subjectById = new Map(subjects.map(s => [String(s._id), s]));
  const sectionCodeOf = new Map(sections.map(s => [String(s._id), s.sectionCode]));
  const pairs = new Map();
  // An unscheduled item stores no section code: without its Section record it cannot be named, and is
  // left out (as on the section's subject list).
  const addPair = (sectionId, subjectId, sectionCode) => {
    const subject = subjectById.get(String(subjectId));
    const key = `${sectionId}:${subjectId}`;
    if (!sectionId || !sectionCode || !subject || pairs.has(key)) return;
    pairs.set(key, { section: { _id: String(sectionId), sectionCode }, subject });
  };
  const unscheduled = (schedule?.unscheduledItems || []).filter(u => sectionCodeOf.get(String(u.sectionId)));
  (schedule?.scheduleData || []).forEach(i => addPair(i.sectionId, i.subjectId, i.section));
  unscheduled.forEach(u => addPair(u.sectionId, u.subjectId, sectionCodeOf.get(String(u.sectionId))));
  const coordinatorLocks = unscheduled.filter(u => u.facultyRef).map(u => ({
    subjectId: u.subjectId, sectionCode: sectionCodeOf.get(String(u.sectionId)), sectionId: u.sectionId, facultyRef: u.facultyRef, source: 'coordinator'
  }));
  const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
  const ordered = [...pairs.values()].sort((a, b) => byText(a.subject.subjectCode, b.subject.subjectCode)
    || byText(a.section.sectionCode, b.section.sectionCode)
    || byText(a.section._id, b.section._id)
    || byText(a.subject._id, b.subject._id));
  return buildTermAssignments({ faculty, pairs: ordered, locks: [...coordinatorLocks, ...versionLocks(schedule)] });
};

module.exports = {
  TBA_POOL_FACULTY_ID,
  OUTSIDE_FACULTY_ID,
  buildFacultyResolver,
  buildTermAssignments,
  classifyTermPairs,
  assignmentCounts,
  unassignedMajorPairs,
  termLoads,
  countsTowardLoad,
  namesSubject,
  versionLocks,
  versionAssignments
};
