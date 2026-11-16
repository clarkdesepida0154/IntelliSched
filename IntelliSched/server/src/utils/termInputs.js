// Loads everything a term's pre-flight check and GA run read, the one way both do it (Phase 2): the
// active rooms, professors and sections, the term's curriculum placements, its newest Draft, the locks
// that staff the pairs (findTermLockSource, Phase 3 Step 8) and the Scheduling Policy. Full documents, not lean(): the Section init hook
// turns old long track labels into codes. The Step 1 full-college fixture is built through this too,
// so it is exactly what the gateway would send.
//
// Phase 3 Step 4: the policy it returns carries the RESOLVED TBA rooms (overflowRooms { mode, enabled,
// lab, lec }: 'auto' -> the Readiness Check's weekday suggestion + 1 of each type it needs, 'manual' ->
// the saved counts, 'off' -> none; utils/preflight.js resolveTbaRooms). This is the one place the mode
// is resolved, so the Readiness Check (preflightCheck), generateSchedule, the request rebuilt at save
// time (gaRuns.buildRunRequest, whose hash must equal the start's), the policySnapshot a version stores
// (which the editor and checkScheduleVersion rebuild the TBA rooms from) and the fixture builder all see
// the same counts. policySaved: a Scheduling Policy document is stored (Readiness line 7).
const Facility = require('../models/Facility');
const Faculty = require('../models/Faculty');
const Section = require('../models/Section');
const CurriculumMapping = require('../models/CurriculumMapping');
const MotherSchedule = require('../models/MotherSchedule');
const { loadStoredPolicy } = require('./policy');
const { resolveTbaRooms } = require('./preflight');
const { buildTermPairs, toSemesterLabel } = require('./curriculumMatcher');

// A term's curriculum placements with their catalog subjects populated.
const findTermMappings = (semester) =>
  CurriculumMapping.find({ semester: toSemesterLabel(semester) }).populate('subject');

// The order that picks a term's newest Draft everywhere in the gateway (and the views' newest
// version): by age (createdAt), a version 2 document before a legacy one (a missing schemaVersion
// sorts last), the later _id on a tie. Never by updatedAt: a class moved in an older Draft changes
// that Draft's updatedAt, never its age, and the Draft a GA run saves is always the newest.
const NEWEST_FIRST = { schemaVersion: -1, createdAt: -1, _id: -1 };

// The term's current Draft: the one a restore archives and the Versions page marks as current. Its
// locks are the term's assignments unless a newer version left Draft status (findTermLockSource,
// below). A term is an academic year and a semester; no lookup filters by program.
const findTermDraft = ({ academicYear, semester }, session = null) =>
  MotherSchedule.findOne({ academicYear, semester: Number(semester), status: 'Draft' })
    .sort(NEWEST_FIRST)
    .session(session);

// The statuses a version passes through after the review (Published only on versions stored before
// Phase 8 Part 6, which read as Approved). It keeps the term's assignments: the
// Draft that was sent for review leaves Draft status with the newest locks on it.
const SIGNED_OFF = ['Under Review', 'Approved', 'Published'];
// A version 2 document whose every class names its demand id (utils/scheduleItems.js isLegacySchedule
// as a query).
const NOT_LEGACY = {
  schemaVersion: { $gte: 2 },
  scheduleData: { $not: { $elemMatch: { demandId: { $in: [null, ''] } } } }
};
// True when a comes before b in NEWEST_FIRST (a version 2 document first, then the later createdAt,
// then the later _id).
const comesFirst = (a, b) => {
  const version = (doc) => (Number(doc?.schemaVersion) >= 2 ? 2 : 0);
  if (version(a) !== version(b)) return version(a) > version(b);
  const age = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  if (age !== 0) return age > 0;
  return String(a._id) > String(b._id);
};

// Phase 3 Step 8: the document that holds the term's assignments (locks) now. That is the term's
// newest Draft (findTermDraft), unless a newer version of the term was sent for review, approved or
// published (not archived, not legacy): sending a Draft for review takes it, and its locks, out of
// Draft status, and the next older Draft holds older locks or none. Every reader of the term's locks
// goes through here: loadTermInputs (the Readiness Check, the Term Checklist's counts and the GA),
// GET /schedule/locks, the rankings' and GET /schedule/loads' current loads, the lock, release and
// decision routes (writableTermDraft) and restore. Null when the term has neither.
// One query after the other: inside a transaction (the lock routes, restore) a session runs one
// operation at a time.
const findTermLockSource = async ({ academicYear, semester }, session = null) => {
  const draft = await findTermDraft({ academicYear, semester }, session);
  const signedOff = await MotherSchedule.findOne({ academicYear, semester: Number(semester), status: { $in: SIGNED_OFF }, ...NOT_LEGACY })
    .sort(NEWEST_FIRST)
    .session(session);
  if (signedOff && (!draft || comesFirst(signedOff, draft))) return signedOff;
  return draft;
};

// The name of the term's next version, in its one "v{n}" sequence: n counts the term's versions that
// carry run statistics (gaStats), that is the GA's Drafts and (Phase 3 Step 5) the Drafts restored
// from them, so a restored copy takes the next number and the next run the one after it.
const nextVersionName = async ({ academicYear, semester }, session = null) => {
  const n = await MotherSchedule.countDocuments({ academicYear, semester: Number(semester), gaStats: { $exists: true } }).session(session);
  return `v${n + 1}`;
};

const loadTermInputs = async ({ academicYear, semester }) => {
  const [facilities, faculty, sections, termMappings, draft, lockSource, stored] = await Promise.all([
    Facility.find({ isActive: true }),
    Faculty.find({ isActive: true }),
    Section.find({ isActive: true }),
    findTermMappings(semester),
    findTermDraft({ academicYear, semester }),
    findTermLockSource({ academicYear, semester }),
    loadStoredPolicy()
  ]);
  // The term's assignments: the locks of its newest Draft, or of a newer version under review,
  // approved or published (findTermLockSource).
  const locks = lockSource?.lockedAssignments || [];
  // The Automated Section Matcher: one (section, subject) pair per placement that fits the section's
  // program, year level and track (CORE + the section's own track).
  const pairs = buildTermPairs(sections, termMappings);
  const policy = { ...stored.policy, overflowRooms: resolveTbaRooms({ policy: stored.policy, pairs, locks, faculty, facilities }) };
  return {
    facilities,
    faculty,
    sections,
    termMappings,
    draft,
    policy,
    policySaved: stored.persisted,
    locks,
    pairs
  };
};

module.exports = { loadTermInputs, findTermMappings, findTermDraft, findTermLockSource, nextVersionName, NEWEST_FIRST };
