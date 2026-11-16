const mongoose = require('mongoose');

// Employment type decides the lab factor and the default teaching cap (Scheduling Policy load).
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME'];
// Phase 8 Part 8 (decision 3c): the program a professor teaches in, as the Teachers' Program's
// Major/Minor line prints it (last year's forms); absent means none.
const PROGRAMS = ['Information Technology', 'Computer Science'];
// Ancillary (non-teaching) hours are recorded by type, as on the SF-029 Teachers' Program.
const ANCILLARY_TYPES = ['MANAGEMENT_FUNCTION', 'RESEARCH', 'EXTENSION', 'CEE', 'CONSULTATION'];
const ANCILLARY_LABELS = {
  MANAGEMENT_FUNCTION: 'Management Function',
  RESEARCH: 'Research',
  EXTENSION: 'Extension',
  CEE: 'Competitive Edge Enhancement',
  CONSULTATION: 'Consultation/Preparation'
};

// One ancillary type and its weekly hours, e.g. { type: 'RESEARCH', hours: 10 }.
const ancillarySchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ANCILLARY_TYPES },
  hours: { type: Number, required: true, min: 0.5, max: 20 }
}, { _id: false });

// A time the professor cannot teach (another college, graduate classes, ...). Sunday blocks are
// stored for completeness; the scheduler never uses Sunday.
const unavailableBlockSchema = new mongoose.Schema({
  day: { type: String, required: true },
  start: { type: String, required: true },
  end: { type: String, required: true },
  note: { type: String, trim: true }
}, { _id: false });

// DEPRECATED (kept for rollback; the gateway stops reading it once a record is migrated).
const ancillaryBreakdownSchema = new mongoose.Schema({
  role: { type: String, required: true, trim: true },
  hours: {
    type: Number,
    required: true,
    min: 0,
    validate: { validator: Number.isInteger, message: 'Ancillary hours must be a whole number.' }
  }
}, { _id: false });

// One logged evaluation: the term it covers, the 1.00-5.00 score and when it was entered.
const evalHistoryEntrySchema = new mongoose.Schema({
  term: { type: String, trim: true },
  score: { type: Number, min: 1, max: 5 },
  dateAdded: { type: Date, default: Date.now }
});

const sumHours = (rows) => (Array.isArray(rows) ? rows : []).reduce((total, row) => total + (Number(row?.hours) || 0), 0);
const describeAncillary = (rows) => (Array.isArray(rows) && rows.length
  ? rows.map(row => ANCILLARY_LABELS[row.type] || row.type).join(' / ')
  : 'None');

const facultySchema = new mongoose.Schema({
  // The human-readable code ("FAC-007"). New codes come from the atomic counter in
  // utils/facultyCode.js, never from a count. facultyRef means this document's _id.
  facultyId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Optional; unique only when present (partial index below). On Atlas the old unique email
  // index is swapped for this one by the Phase 1 migration.
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  department: {
    type: String,
    default: 'BSIT',
    trim: true
  },
  // Printed as "Major/Minor" on the Teachers' Program (else the specializations). Not required here:
  // the gateway requires a major or a specialization whenever the Dean saves the profile
  // (academicController validateFaculty), and empty prints nothing, never a placeholder.
  major: {
    type: String,
    default: '',
    trim: true
  },
  // Highest academic attainment. Stored on its own field so it no longer has to be smuggled
  // into engine1Profile, where it polluted the Engine 1 TF-IDF corpus.
  degreeLevel: {
    type: String,
    enum: ['BS', 'MS', 'PhD'],
    trim: true
  },
  // "Degree after the name" (Phase 8 Part 3, decision 1d), as the office's SF-029s write it next to
  // the professor's name: "FacultyMember, MSIT". Only the Teachers' Program shows it; the term
  // loader fills it from the term file where empty, and the Secretary types it on the Faculty page.
  degreeAfterName: {
    type: String,
    trim: true
  },
  // Required on every save through the gateway (checked there, not here, so an unmigrated record
  // can still be enabled or disabled). The migration lists records without it for the Dean.
  employmentType: {
    type: String,
    enum: EMPLOYMENT_TYPES
  },
  // Printed on SF-029, e.g. "Instructor I", "Assistant Professor III", "Part-time Instructor".
  position: {
    type: String,
    trim: true
  },
  // Maximum teaching hours per week (lab hours count x lab factor). Required on save through the
  // gateway; the form pre-fills policy.load.defaultTeachingCap[employmentType].
  teachingCapHours: {
    type: Number,
    min: 0,
    max: 40
  },
  // Minimum teaching hours per week (Phase 8 Part 4, decision 1): the lower end of the professor's
  // range. Optional: absent means the policy default (load.defaultMinTeachingHours, a full-timer's
  // lowered by their Management Function hours — utils/load.js minTeachingHoursOf). A load below it
  // warns and feeds the balance; nothing is blocked.
  minTeachingHours: {
    type: Number,
    min: 0,
    max: 40
  },
  // The professor's own day for Extension (Phase 8 Part 4, decision 4), overriding the Scheduling
  // Policy's "Full-time faculty's day for Extension": a weekday name, 'None' (no day for this
  // professor), or absent (follow the policy). Full-timers only; the scheduler keeps the day
  // class-free like an unavailable time (utils/facultyAvailability.js).
  extensionDay: {
    type: String,
    enum: ['None', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    trim: true
  },
  // Ancillary hours by type. No default: an absent list means "not migrated yet", which the
  // gateway tells apart from an empty list ("no ancillary duty").
  ancillary: {
    type: [ancillarySchema],
    default: undefined
  },
  // No default, for the same reason as `ancillary`.
  unavailableBlocks: {
    type: [unavailableBlockSchema],
    default: undefined
  },
  coCurricular: {
    type: String,
    trim: true
  },
  specializations: [{
    type: String,
    trim: true
  }],
  certifications: [{
    type: String,
    trim: true
  }],
  // Subjects this instructor has taught before. Folded into engine1Profile so Engine 1 can match
  // new subjects against historical teaching experience.
  pastSubjectsTaught: {
    type: [String],
    default: []
  },
  // Phase 5: the teaching history the ranking's features read (Engine 2 at request time, Engine 4 at
  // retraining): per catalog subject, the terms in which the professor taught it to a CCS section, and
  // per program the terms with any class. Written by the term loader from the past Teachers' Programs
  // (docs/ml/teaching_history.json, built from docs/data/past_class_blocks.csv); never by the Faculty form.
  teachingHistory: {
    type: [new mongoose.Schema({
      subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubjectCatalog', default: null },
      subjectCode: { type: String, trim: true },
      descriptiveTitle: { type: String, trim: true },
      terms: { type: [String], default: [] },
      // Phase 8 Part 11: the sections of the subject taught in each of those terms (Engine 2's
      // sections_taught). A record written before it has none: each term then counts as 1 section.
      termSections: {
        type: [new mongoose.Schema({ term: { type: String, required: true }, sections: { type: Number, min: 1, default: 1 } }, { _id: false })],
        default: undefined
      },
      timesTaught: { type: Number, default: 0 },
      lastTerm: { type: String, default: null }
    }, { _id: false })],
    default: undefined
  },
  programHistory: {
    type: [new mongoose.Schema({
      program: { type: String, required: true, trim: true },
      terms: { type: [String], default: [] }
    }, { _id: false })],
    default: undefined
  },
  trainings: [{
    type: String,
    trim: true
  }],
  engine1Profile: {
    type: String,
    required: true,
    trim: true
  },
  // average is the value the Python engines read (Engine 1 roster -> Engine 2 GBDT). It always
  // holds the MOST RECENT score, never a lifetime mean, so the ranker sees current performance.
  // history is the Dean-facing log behind it; the roster's trend arrow compares its last two scores.
  evalScore: {
    average: {
      type: Number,
      default: 0,
      min: 0,
      max: 5.0
    },
    history: [evalHistoryEntrySchema]
  },
  // DEPRECATED (kept for rollback). Replaced by `ancillary`.
  ancillaryBreakdown: {
    type: [ancillaryBreakdownSchema],
    default: undefined
  },
  // DEPRECATED as an input. Still written as a mirror of `ancillary` (total hours and type names)
  // because the Python engines read ancillaryLoad.hours until they read `ancillary` (Phase 1 Step 9).
  ancillaryLoad: {
    hours: {
      type: Number,
      default: 0,
      min: 0
    },
    designation: {
      type: String,
      default: 'None',
      trim: true
    }
  },
  // DEPRECATED (kept for rollback). maxLoad was enforced as a TOTAL cap (teaching + ancillary);
  // the migration proposes teachingCapHours = maxLoad - ancillary hours. No longer required or
  // defaulted, so nothing invents a value for new profiles.
  maxLoad: {
    type: Number,
    min: 6,
    max: 30
  },
  // DEPRECATED (kept for rollback). Replaced by unavailableBlocks (whole days become whole-day blocks).
  unavailableDays: [{
    type: String,
    enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  // Phase 8 Part 8 (decision 3c): "Program", printed on the Teachers' Program's Major/Minor line as last
  // year's forms did: Information Technology, Computer Science, or absent (none). The `major` text above
  // stays in the profile because the recommendations (Engine 1) read it; it no longer prints.
  program: {
    type: String,
    enum: PROGRAMS,
    trim: true
  },
  // Phase 8 Part 8 (decision 3d): Archived — transferred or removed from CCS — a third state besides
  // Active and Inactive (on leave). An archived profile is also inactive, so Assign Faculty, the
  // Teaching loads, the Readiness Check, the GA and the recommendations leave it out; saved versions and
  // their printed forms keep it. wasActive is the state Restore puts back.
  archived: { type: Boolean, default: undefined },
  archivedAt: { type: Date, default: undefined },
  wasActive: { type: Boolean, default: undefined }
}, { timestamps: true });

facultySchema.index({ facultyId: 1, isActive: 1 });
// Unique only when an email is recorded, so any number of profiles can have none.
facultySchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

// Profiles written before the history became structured store bare numbers ([4.5, 4.7]).
// Without this they would load as empty entries and lose their scores. They are read as
// { score } entries with no term and no date instead of being rewritten in Atlas, so older
// branches that still expect numbers keep working against the same database.
facultySchema.pre('init', function normalizeLegacyEvalHistory(raw) {
  const history = raw?.evalScore?.history;
  if (!Array.isArray(history)) return;
  raw.evalScore.history = history.map(entry => (
    typeof entry === 'number' ? { score: entry, dateAdded: null } : entry
  ));
});

// Document saves keep the ancillaryLoad mirror equal to `ancillary`.
facultySchema.pre('validate', function syncAncillaryMirror(next) {
  if (this.isModified('ancillary') && Array.isArray(this.ancillary)) {
    this.set('ancillaryLoad.hours', sumHours(this.ancillary));
    this.set('ancillaryLoad.designation', describeAncillary(this.ancillary));
  }
  next();
});

// Query updates that $set `ancillary` (the path updateFaculty uses) sync the same mirror.
facultySchema.pre('findOneAndUpdate', function syncAncillaryMirrorOnUpdate(next) {
  const update = this.getUpdate() || {};
  const set = update.$set || update;
  if (!Array.isArray(set.ancillary)) return next();
  set['ancillaryLoad.hours'] = sumHours(set.ancillary);
  set['ancillaryLoad.designation'] = describeAncillary(set.ancillary);
  delete set.ancillaryLoad;
  next();
});

const Faculty = mongoose.model('Faculty', facultySchema, 'faculty');
Faculty.EMPLOYMENT_TYPES = EMPLOYMENT_TYPES;
Faculty.PROGRAMS = PROGRAMS;
Faculty.ANCILLARY_TYPES = ANCILLARY_TYPES;
Faculty.ANCILLARY_LABELS = ANCILLARY_LABELS;

module.exports = Faculty;
