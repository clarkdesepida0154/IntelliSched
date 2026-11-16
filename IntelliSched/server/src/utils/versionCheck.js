// Re-checking a saved schedule version with the gateway validator (moved here from
// controllers/orchestratorController.js in Phase 4 Part 1, unchanged, so that Fill TBA rooms and the
// editor's moves judge a version the same way). The request is rebuilt by the demand builder from the
// term's current sections, curriculum, faculty and rooms, the version's own locks, the lecture modes it
// was generated with (withVersionLectureModes) and the policy it was generated under, so an edit is
// judged the same way the generate path judges Engine 3's answer.
const Facility = require('../models/Facility');
const Faculty = require('../models/Faculty');
const Section = require('../models/Section');
const { validateGeneratedSchedule } = require('./constraintValidator');
const { buildGaRequest } = require('./gaRequest');
const { lectureModeOf } = require('./meetings');
const { findTermMappings } = require('./termInputs');
const { loadPolicy, mergePolicy } = require('./policy');
const { buildTermAssignments, versionLocks } = require('./termAssignments');
const { buildTermPairs, resolveSubjectType } = require('./curriculumMatcher');
const { ojtDemandsOf } = require('./ojtPlacement');

const LEGACY_READ_ONLY = 'This schedule version was saved in an older format (before Phase 1 record ids), so it is read-only. Generate a new version to make changes.';

// A stored class whose (section, subject) pair is no longer one of the term's (the section deactivated,
// the mapping removed since the run) has no demand for the validator to judge, so no edit of it is
// saved: not a move (Phase 4 Part 3, closing Part 2's open question 1), not a professor change, not a
// swap (Part 2). The one wording for all three.
const NOT_IN_TERM = "This class is no longer part of the term's sections or curriculum, so it can't be checked. Generate the term again.";
// True when the validator judged this stored class (checkScheduleVersion's demandIds has its demand).
const isCheckedItem = (item, check) => Boolean(item?.demandId) && check.demandIds.has(item.demandId);

// Phase 8 Part 6 (decision 2): there is no Publish any more. A version stored as Published (before
// Part 6) reads as Approved wherever a status is shown or judged; nothing stored is changed.
const shownStatus = (status) => (status === 'Published' ? 'Approved' : status);

// Only a Draft's classes can be moved: a version under review, approved or archived refuses a move
// (409 READ_ONLY_VERSION), worded for its status. An Approved version is final: restore it to change it.
const readOnlyVersionMessage = (stored) => {
  const status = shownStatus(stored);
  return status === 'Approved'
    ? "This version is Approved: classes can't be moved. Restore it to make a new Draft."
    : `This version is ${status || 'not a Draft'}: classes can't be moved. Open a Draft to move classes.`;
};

// Phase 3 Step 7: the lecture mode each (section, subject) pair of a saved version was generated with,
// read from the version itself, never from today's Master Catalog: a pair with a SELF_PACED unscheduled
// item was self-paced, a pair whose lecture classes are online (isOnline) was online, a pair with
// on-campus lecture classes was on campus. A pair the version holds no lecture of (a lab-only subject, a
// pair added since) keeps the catalog's mode. Returns the pairs with each subject's lectureMode set that
// way, so a catalog change after the run never makes the saved classes look misplaced.
const withVersionLectureModes = (doc, pairs) => {
  const modes = new Map();
  for (const u of doc.unscheduledItems || []) {
    if (u.kind === 'SELF_PACED') modes.set(`${u.sectionId}:${u.subjectId}`, 'ONLINE_SELF_PACED');
  }
  for (const item of doc.scheduleData || []) {
    if (item.type === 'LEC' && item.sectionId && item.subjectId) modes.set(`${item.sectionId}:${item.subjectId}`, item.isOnline === true ? 'ONLINE_SCHEDULED' : 'ON_CAMPUS');
  }
  return pairs.map((pair) => {
    const mode = modes.get(`${pair.section._id}:${pair.subject._id}`);
    if (!mode || mode === lectureModeOf(pair.subject)) return pair;
    const subject = typeof pair.subject.toObject === 'function' ? pair.subject.toObject() : pair.subject;
    return { ...pair, subject: { ...subject, lectureMode: mode } };
  });
};

// Phase 8 (the per-class GenEd room rule): a Minor class needs a CCS lecture room when a professor is
// assigned to it, or when the subject's "Needs a CCS room" box is ticked. A saved version is judged by
// what it stored, like the lecture modes above: a Minor pair whose stored lecture classes sit in a room
// (roomId or extraRoomKey) needed one, a pair stored without a room needed none, so a later professor
// change (Change professor, Minor → TBA or TBA → professor) or a catalog tick never re-labels the
// Draft's rooms. The pin (`subject.minorRoomPinned`) wins inside allowedRoomTypesOf; a pair the version
// holds no lecture of keeps the live rule.
const withVersionRoomNeeds = (doc, pairs) => {
  const hadRoom = new Map();
  for (const item of doc.scheduleData || []) {
    if (item.type !== 'LEC' || !item.sectionId || !item.subjectId) continue;
    const key = `${item.sectionId}:${item.subjectId}`;
    hadRoom.set(key, Boolean(hadRoom.get(key)) || Boolean(item.roomId || item.extraRoomKey));
  }
  return pairs.map((pair) => {
    if (resolveSubjectType(pair.subject) !== 'Minor') return pair;
    const pinned = hadRoom.get(`${pair.section._id}:${pair.subject._id}`);
    if (pinned === undefined) return pair;
    const subject = typeof pair.subject.toObject === 'function' ? pair.subject.toObject() : pair.subject;
    return { ...pair, subject: { ...subject, minorRoomPinned: pinned } };
  });
};

// The placement of one stored class as the validator reads it: an extra (TBA) room is named by its key;
// clash checks never compare names.
const placementOfItem = (item) => ({
  demandId: item.demandId,
  day: item.day,
  startSlot: item.startSlot,
  roomId: item.extraRoomKey || (item.roomId ? String(item.roomId) : null)
});

// The version's request and everything the validator needs with it: { request, policy, pairs, locks,
// faculty, facilities, assignmentsByFaculty }. The policy is the one the version was generated under
// (its snapshot), else the stored one.
// The term's current records a version is checked against. Loaded once per request so that a check
// repeated for many candidates (Change professor's list, Phase 4 Part 2) reads the database once.
const loadVersionInputs = async (doc) => {
  const [facilities, faculty, sections, mappings] = await Promise.all([
    Facility.find({ isActive: true }),
    Faculty.find({ isActive: true }),
    Section.find({ isActive: true }),
    findTermMappings(doc.semester)
  ]);
  return { facilities, faculty, sections, mappings };
};

// The version's locks with some (section, subject) pairs given another professor (Phase 4 Part 2,
// "Change professor"): each change { sectionId, subjectId, sectionCode, subjectCode, facultyRef } replaces
// the pair's lock (null facultyRef = TBA: the lock is dropped). `faculty` names the new holder's code.
const withFacultyChanges = (locks, changes, faculty) => {
  if (!changes?.length) return locks;
  const byRef = new Map(faculty.map(f => [String(f._id), f]));
  let out = locks.map(l => (typeof l.toObject === 'function' ? l.toObject() : l));
  for (const change of changes) {
    const same = (l) => String(l.sectionId) === String(change.sectionId) && String(l.subjectId) === String(change.subjectId);
    const existing = out.find(same) || null;
    out = out.filter(l => !same(l));
    if (!change.facultyRef) continue;
    const prof = byRef.get(String(change.facultyRef)) || null;
    out.push({
      ...(existing || {}),
      subjectId: change.subjectId,
      subjectCode: existing?.subjectCode || change.subjectCode,
      sectionId: change.sectionId,
      sectionCode: existing?.sectionCode || change.sectionCode,
      facultyRef: String(change.facultyRef),
      facultyId: prof?.facultyId || existing?.facultyId || String(change.facultyRef),
      facultyName: prof?.name || '',
      source: 'manual',
      classType: 'ALL'
    });
  }
  return out;
};

const buildVersionRequest = async (doc, { facultyChanges = [], inputs = null } = {}) => {
  const policy = doc.policySnapshot ? mergePolicy(doc.policySnapshot, undefined) : await loadPolicy();
  // Phase 8 Part 6 (decision 5c): a version is judged by the rules it was made under — one whose
  // policy snapshot predates the part-timers' one-class-day rule never gains its conflicts.
  if (doc.policySnapshot && doc.policySnapshot.meetings?.partTimerNoSingleDay === undefined) policy.meetings.partTimerNoSingleDay = false;
  const { facilities, faculty, sections, mappings } = inputs || await loadVersionInputs(doc);
  const pairs = withVersionRoomNeeds(doc, withVersionLectureModes(doc, buildTermPairs(sections, mappings)));
  // The professors are the ones stored on the classes, not today's locks; a pair with no items
  // (practicum) keeps the version's own lock for the teaching-cap check (utils/termAssignments.js
  // versionLocks, which the version's Teachers' Programs use too).
  const locks = withFacultyChanges(versionLocks(doc), facultyChanges, faculty);
  const { request } = buildGaRequest({ policy, pairs, locks, faculty, facilities });
  // Phase 8 Part 3 (decision 2): the version's On-The-Job Training records ride the validator like
  // the coordinator's classes — each gets a demand of its own (no room, its own meeting group, the
  // weekday rule; a professor change under check restaffs it), so the completeness, clash, window
  // and lunch rules all see them. The GA's own request never carries these: they are placed after it.
  request.demands.push(...ojtDemandsOf(doc.scheduleData || [], { policy, facultyChanges }));
  const assignmentsByFaculty = buildTermAssignments({ faculty, pairs, locks });
  return { request, policy, pairs, locks, faculty, facilities, assignmentsByFaculty };
};

// An edit to check: one move ({ itemId, day, startSlot, roomId }, the editor's parsed change) or several
// ({ moves: [...], facultyChanges: [...] }, Phase 4 Part 2: a swap moves two classes, a professor change
// restaffs a pair). Null = the version as it is.
const normalizeChange = (change) => {
  if (!change) return { moves: [], facultyChanges: [] };
  if (Array.isArray(change.moves) || Array.isArray(change.facultyChanges)) {
    return { moves: change.moves || [], facultyChanges: change.facultyChanges || [] };
  }
  return { moves: [change], facultyChanges: [] };
};

// Re-checks a saved version (schemaVersion 2) with the gateway validator, optionally with classes
// moved and pairs restaffed (normalizeChange). Returns the validator result; each violation also names
// its schedule items (itemIds). `inputs` (loadVersionInputs) spares the reads when checking many edits.
const checkScheduleVersion = async (doc, change = null, inputs = null) => {
  const edit = normalizeChange(change);
  const { request, policy, faculty, assignmentsByFaculty } = await buildVersionRequest(doc, { facultyChanges: edit.facultyChanges, inputs });
  const movesById = new Map(edit.moves.map(m => [String(m.itemId), m]));
  const itemIdByDemand = new Map();
  const placements = (doc.scheduleData || []).map(item => {
    if (item.demandId) itemIdByDemand.set(item.demandId, String(item._id));
    const moved = movesById.get(String(item._id));
    return moved
      ? { demandId: item.demandId, day: moved.day, startSlot: moved.startSlot, roomId: moved.roomId }
      : placementOfItem(item);
  });
  const result = validateGeneratedSchedule({ request, placements, faculty, assignmentsByFaculty, policy });
  const violations = result.violations.map(v => ({ ...v, itemIds: (v.demandIds || []).map(id => itemIdByDemand.get(id)).filter(Boolean) }));
  // The demands the validator judged: a stored class whose (section, subject) pair is no longer one of
  // the term's (its section deactivated, its mapping removed) has none and is never checked, so an edit
  // of it must be refused rather than trusted (Phase 4 Part 2 review).
  const demandIds = new Set((request.demands || []).map(d => d.demandId));
  return { ...result, violations, policy, demandIds };
};

// One violation's identity, to tell the conflicts an edit adds from the ones a version already has. The
// message is part of it: a section's and a professor's lunch violation can name the same two classes,
// and a teaching cap passed by more hours than before is a new conflict.
const violationKey = (v) => `${v.code}|${[...(v.demandIds || [])].sort().join(',')}|${v.facultyRef || ''}|${v.message || ''}`;

// The violations of `after` that `before` does not have.
const newViolations = (before, after) => {
  const had = new Set((before.violations || []).map(violationKey));
  return (after.violations || []).filter(v => !had.has(violationKey(v)));
};

module.exports = {
  LEGACY_READ_ONLY, NOT_IN_TERM, isCheckedItem, readOnlyVersionMessage, shownStatus, withVersionLectureModes, withVersionRoomNeeds, placementOfItem, loadVersionInputs,
  buildVersionRequest, checkScheduleVersion, normalizeChange, violationKey, newViolations
};
