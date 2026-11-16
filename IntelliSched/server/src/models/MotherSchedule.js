const mongoose = require('mongoose');
const { academicYearOf } = require('../utils/academicCalendar');

const scheduleItemSchema = new mongoose.Schema({
  subjectCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  // The SubjectCatalog entry behind the item (absent on ACTIVITY blocks and older schedules), which
  // tells apart subjects that share a code.
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubjectCatalog'
  },
  section: {
    type: String,
    required: true,
    trim: true
  },
  // Ids (schemaVersion 2). Clash checks compare these, never names. null = TBA (no professor / no room).
  sectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section'
  },
  facultyRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Faculty',
    default: undefined
  },
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Facility',
    default: undefined
  },
  // Phase 2: a class in an extra room (a room the Dean must request from outside CCS) has roomId
  // null and this key ("EXTRA-LAB-1", "EXTRA-LEC-2" ...); roomName holds its display name. Clash
  // checks use roomId or this key, never the name.
  extraRoomKey: {
    type: String,
    trim: true,
    match: /^EXTRA-(LAB|LEC)-[1-9]\d*$/,
    default: undefined
  },
  // The professor's code ("FAC-007"), or "TBA". Never the old placeholder "FAC-ASSIGNED".
  facultyId: {
    type: String,
    required: true,
    trim: true
  },
  facultyName: {
    type: String,
    required: true,
    trim: true
  },
  roomName: {
    type: String,
    required: true,
    trim: true
  },
  day: {
    type: String,
    required: true,
    // Sunday exists for fixed NSTP blocks.
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  // Slots are counted from the grid origin of the policy the version was generated under (see
  // policySnapshot); the grid length is the policy's, so only the day's 48 half-hours bound it.
  startSlot: {
    type: Number,
    min: 0,
    max: 47
  },
  durationSlots: {
    type: Number,
    min: 1,
    max: 12,
    validate: {
      validator: Number.isInteger,
      message: 'durationSlots must be a whole number of 30-minute slots.'
    }
  },
  type: {
    type: String,
    required: true,
    // 'OJT' (Phase 8 Part 3, decision 2): a 4th-year section's On-The-Job Training block — the
    // practicum subject, the coordinator as professor, no room — placed after the GA
    // (utils/ojtPlacement.js) and checked like the coordinator's classes.
    enum: ['LEC', 'LAB', 'ACTIVITY', 'OJT']
  },
  isMinor: {
    type: Boolean,
    default: false
  },
  // schemaVersion 2 (Phase 1 Step 7). Not schema-required, so the legacy Approved document stays
  // valid; the generate path and the validator enforce them on version 2 documents.
  descriptiveTitle: { type: String, trim: true },
  meetingIndex: { type: Number, min: 0 },
  // Engine 3's demand: "<sectionId>:<subjectId>:<LEC|LAB>:<meetingIndex>".
  demandId: { type: String, trim: true },
  // True for a block the policy fixes (NSTP): the editor does not move it.
  isFixed: { type: Boolean },
  // Phase 3 Step 7: a Major lecture held online (scheduled: a day and a time, no room; roomName
  // 'Online'). Snapshotted when the version is saved, so a later Master Catalog change never re-labels
  // it: the version check and the editor read the mode from the item. Absent on every on-campus class.
  isOnline: { type: Boolean, default: undefined },
  // Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher (facultyRef null,
  // facultyId 'OUTSIDE', facultyName the teacher's name when the version was saved; the outputs read
  // the current name from the list). Absent on every other class.
  outsideTeacherRef: { type: mongoose.Schema.Types.ObjectId, ref: 'OutsideTeacher', default: undefined }
});
// Items have their own _id (schemaVersion 2): the Timetable Editor names the class it moves by it.
// Legacy items have none, so legacy documents are read with lean() and never saved: hydrating them
// would invent a new _id for every item on every read.

// Who made a decision or wrote a row (Phase 2 Step 0): the signed-in user's id, name and role, or
// "System" with the user who started the action in startedBy. Rows written earlier have none and
// read "Not recorded".
const personSchema = new mongoose.Schema({ id: String, name: String, role: String }, { _id: false });
const actorSchema = new mongoose.Schema({
  id: String,
  name: String,
  role: String,
  startedBy: { type: personSchema, default: undefined }
}, { _id: false });

const overrideLogSchema = new mongoose.Schema({
  // Kind of decision this row records. Lets the Engine 4 retrainer separate genuine
  // accept/override pairs from lock, editor and approval bookkeeping without parsing text.
  entryType: {
    type: String,
    enum: ['accept', 'override', 'lock', 'schedule-edit', 'approval']
  },
  subjectCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubjectCatalog'
  },
  section: {
    type: String,
    trim: true
  },
  sectionCode: {
    type: String,
    trim: true
  },
  aiRecommendedFacultyId: {
    type: String,
    trim: true
  },
  aiRecommendedFacultyName: {
    type: String,
    trim: true
  },
  mlTop1Faculty: {
    type: String,
    trim: true
  },
  mlTop1Score: {
    type: Number
  },
  assignedFacultyId: {
    type: String,
    required: true,
    trim: true
  },
  assignedFacultyName: {
    type: String,
    trim: true
  },
  deanSelectedFaculty: {
    type: String,
    trim: true
  },
  reason: {
    type: String,
    required: [true, 'Give a reason for this decision.'],
    trim: true
  },
  // Engine 4 Adaptive Learning Feature Vector.
  // No numeric defaults: a value the gateway could not resolve is persisted as null so the
  // retrainer can mask it, instead of learning from a fabricated constant.
  // Scales: semantic scores are 0-1 (candidate score / 100); eval scores are the Faculty
  // evalScore.average on the institutional 1.0-5.0 scale; ancillary hours are weekly hours.
  selectedSemanticScore: { type: Number, default: null },
  selectedEvalScore: { type: Number, default: null },
  selectedPrepCount: { type: Number, default: null },
  selectedAncillaryHours: { type: Number, default: null },
  rejectedSemanticScore: { type: Number, default: null },
  rejectedEvalScore: { type: Number, default: null },
  rejectedPrepCount: { type: Number, default: null },
  rejectedAncillaryHours: { type: Number, default: null },
  // Phase 11.4: on an approval row, the stage it signed (2 Review, 3 Approve); absent on older rows.
  approvalStep: { type: Number, default: undefined },
  // Who made this decision (absent on rows written before Phase 2).
  actor: { type: actorSchema, default: undefined },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

// A (section, subject) the GA never places: a practicum and its coordinator (PRACTICUM, counts
// ojtCoordinatorHours), or (Phase 3 Step 7) a Major's self-paced online lecture hours (SELF_PACED, hours
// = its lecture hours; its labs are classes as usual). Both still count in the professor's load.
const unscheduledItemSchema = new mongoose.Schema({
  sectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubjectCatalog', required: true },
  facultyRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', default: null },
  kind: { type: String, enum: ['PRACTICUM', 'SELF_PACED'], required: true },
  hours: { type: Number, min: 0 }
}, { _id: false });

const lockedAssignmentSchema = new mongoose.Schema({
  subjectCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  // The locked SubjectCatalog entry. A lock with a subjectId staffs that subject only; an older lock
  // without one staffs every subject with its code in the section.
  subjectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubjectCatalog'
  },
  sectionCode: {
    type: String,
    required: true,
    trim: true
  },
  // The Section's _id. Locks written before Phase 1 Step 5 lack it; the migration fills it in.
  sectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Section'
  },
  facultyId: {
    type: String,
    required: true,
    trim: true
  },
  // The professor's _id (null for the FAC-TBA institutional pool card).
  facultyRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Faculty',
    default: null
  },
  facultyName: {
    type: String,
    required: true,
    trim: true
  },
  // How the lock was made: 'ranking' (Candidate Ranking decision) or 'matrix' (Course Matrix) for a
  // Major, 'manual' for a Minor the Dean staffed with a CCS professor, 'coordinator' for a practicum,
  // 'outside' for a Minor taught by an outside teacher (Phase 8 Part 8, decision 4: facultyId 'OUTSIDE',
  // facultyRef null, outsideTeacherRef below). Older locks have none and are Majors.
  source: {
    type: String,
    enum: ['ranking', 'matrix', 'manual', 'coordinator', 'outside']
  },
  outsideTeacherRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OutsideTeacher',
    default: undefined
  },
  classType: {
    type: String,
    enum: ['LEC', 'LAB', 'ALL'],
    default: 'ALL'
  },
  units: {
    type: Number,
    default: 3
  },
  lockedBy: {
    type: String,
    default: 'Dean'
  },
  lockedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

// The last whole-version check: when, how many hard violations, and who pressed "Validate schedule"
// (or signed an approval stage, which runs the same check first).
const lastCheckSchema = new mongoose.Schema({
  checkedAt: { type: Date, required: true },
  hardTotal: { type: Number, min: 0 },
  violationCount: { type: Number, min: 0 },
  by: { type: actorSchema, default: null }
}, { _id: false });

// The version a restored Draft is a copy of: its id, its name and the status it had when it was restored.
const restoredFromSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'MotherSchedule', required: true },
  version: { type: String, trim: true },
  status: { type: String, trim: true }
}, { _id: false });

// Phase 4 Part 1: the Draft a filled Draft is a copy of (Fill TBA rooms): its id, name and status, with the
// number of classes (and their hours) put into real rooms.
const filledFromSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'MotherSchedule', required: true },
  version: { type: String, trim: true },
  status: { type: String, trim: true },
  classCount: { type: Number, min: 0 },
  hours: { type: Number, min: 0 }
}, { _id: false });

const motherScheduleSchema = new mongoose.Schema({
  academicYear: {
    type: String,
    required: true,
    // Phase 13: never a fixed year; the academic year in progress (the default calendar) when none is given.
    default: () => academicYearOf(new Date()),
    trim: true
  },
  semester: {
    type: Number,
    required: true,
    enum: [1, 2],
    default: 1
  },
  // One run covers both programs: new documents are 'ALL'. Older documents say 'BSIT'; term lookups
  // no longer filter by program, so they are still found.
  program: {
    type: String,
    required: true,
    default: 'ALL',
    trim: true
  },
  // 2 = items carry subjectId / sectionId / facultyRef / roomId (Phase 1). Older documents have none
  // and are read-only.
  schemaVersion: { type: Number },
  status: {
    type: String,
    required: true,
    enum: ['Draft', 'Under Review', 'Approved', 'Published', 'Archived'],
    default: 'Draft'
  },
  version: {
    type: String,
    default: 'v1.0'
  },
  scheduleData: [scheduleItemSchema],
  overrideLogs: [overrideLogSchema],
  lockedAssignments: [lockedAssignmentSchema],
  unscheduledItems: { type: [unscheduledItemSchema], default: undefined },
  // Engine 3's run statistics: { initialHard, finalHard, soft, generations, runtimeMs, seed }.
  gaStats: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // The GA settings the run used, exactly as sent (Phase 2: mode, populationSize, mutationRate,
  // crossoverRate, repairRate, tournamentSize, elitism, timeBudgetSeconds, maxGenerations, seed).
  // No defaults: a version that was not generated has none (older documents keep what they stored).
  hyperparameters: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // The SchedulingPolicy a generated version was built under (absent on older documents).
  policySnapshot: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Who created this document: "System" with the user who started the GA run, or the user whose
  // lock created a pre-generation Draft (absent on documents written before Phase 2).
  createdBy: { type: actorSchema, default: undefined },
  // The GA run (generation_runs) that saved this version (Phase 2 Step 4; absent on older documents).
  generationRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'GenerationRun', default: undefined },
  // Phase 3 Step 4: the last "Validate schedule" of the whole version (POST /schedule/validate without a
  // change; a preview of a move stores nothing). Written with timestamps off, so updatedAt keeps the
  // version's own last change. Absent until the version is first checked.
  lastCheck: { type: lastCheckSchema, default: undefined },
  // Phase 3 Step 5: a restore makes a new Draft, a copy of the chosen version, and this names that
  // version (POST /schedule/restore). Absent on every other version.
  restoredFrom: { type: restoredFromSchema, default: undefined },
  // Phase 4 Part 1: Fill TBA rooms saves a new Draft, a copy of a Draft with its TBA classes put into real
  // rooms (POST /schedule/fill-tba-rooms), and this names that source Draft. Absent on every other version.
  filledFrom: { type: filledFromSchema, default: undefined },
  // Phase 8 Part 3 (decision 2): the version's notes, plain sentences for the Dean — today only the
  // On-The-Job Training placement writes one, when a coordination's hours did not fit one weekday.
  // Absent when there is nothing to say.
  notes: { type: [String], default: undefined }
}, { timestamps: true });

// Lookup index for a term's schedules by status. Deliberately NOT unique: every GA run saves a new
// Draft version next to the earlier ones (version history), and the lock routes read the newest
// Draft (orchestratorController.findTermDraft). A unique index here made the second run of a term
// fail with E11000 on any freshly built database. Live Atlas already holds this index non-unique.
motherScheduleSchema.index({ academicYear: 1, semester: 1, program: 1, status: 1 });

module.exports = mongoose.model('MotherSchedule', motherScheduleSchema, 'mother_schedules');