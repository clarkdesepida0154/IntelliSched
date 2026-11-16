const mongoose = require('mongoose');

// The timeless Master Catalog: what a subject is, never where it sits. Program, year level,
// semester and track live on CurriculumMapping, which references a catalog entry by ObjectId, so one
// subject code (e.g. GEC 106, or ITST 301 on each BSIT track) can exist and be placed any number of
// times. No index on this collection is unique (subjectCode included), so writes here can never
// raise an E11000 duplicate-key error.

// Half-hour steps: the GA schedules in 30-minute slots (durationSlots = hours * 2).
const isHalfStep = (value) => Number.isFinite(value) && value >= 0 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

const subjectCatalogSchema = new mongoose.Schema({
  subjectCode: {
    type: String,
    required: [true, 'Subject code is required'],
    trim: true,
    uppercase: true
  },
  descriptiveTitle: {
    type: String,
    required: [true, 'Descriptive title is required'],
    trim: true
  },
  // Optional: the course description helps match professors to the subject (the title is used
  // when it is empty). Pages show "No description yet" for an empty one.
  subjectDescription: {
    type: String,
    trim: true,
    default: ''
  },
  // Routing is derived from the type by the gateway: Major -> physical room; Minor -> TBA, room
  // optional (requiresRoom); NSTP -> TBA with no room in the policy's NSTP block.
  type: {
    type: String,
    required: [true, 'Subject type (Major, Minor or NSTP) is required'],
    enum: {
      values: ['Major', 'Minor', 'NSTP'],
      message: 'Subject type must be Major, Minor or NSTP'
    }
  },
  lecHours: {
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: isHalfStep, message: 'Lecture hours must be a multiple of 0.5.' }
  },
  labHours: {
    type: Number,
    default: 0,
    min: 0,
    validate: { validator: isHalfStep, message: 'Laboratory hours must be a multiple of 0.5.' }
  },
  units: {
    type: Number,
    default: 3,
    min: 1,
    max: 12
  },
  // Practicum / OJT (e.g. ITEP 503, CMSC 503). Majors only: no contact hours (0 / 0, units kept), no
  // room, never a GA demand. One coordinator per section counts policy.load.ojtCoordinatorHours.
  isPracticum: {
    type: Boolean,
    default: false
  },
  // Always true for a Major (false for a practicum), the Dean's checkbox for a Minor (e.g. PATHFIT),
  // always false for NSTP.
  requiresRoom: {
    type: Boolean,
    default: false
  },
  // Phase 4 Part 4: who last set "Needs a CCS room": 'user' (the Curriculum & Subjects page, on a create or
  // a change of the box) or 'term-file' (the term loader's catalog changes). The loader changes the box only
  // where it is not 'user', so a box the Dean ticked or unticked is never changed by a term file.
  roomFlagSource: {
    type: String,
    enum: ['user', 'term-file']
  },
  // Phase 3 Step 7: how a Major's lectures are held (the Dean's choice when rooms are short; CHED CMO
  // No. 4, s. 2020 allows flexible learning). ON_CAMPUS: in a room, as before. ONLINE_SCHEDULED: a day
  // and a time, no room. ONLINE_SELF_PACED: no day, time or room (still counted in the professor's
  // load). Labs always stay on campus. Majors only (the controller stores ON_CAMPUS for anything else);
  // a record without the field (lean reads skip defaults) reads as ON_CAMPUS everywhere.
  lectureMode: {
    type: String,
    enum: {
      values: ['ON_CAMPUS', 'ONLINE_SCHEDULED', 'ONLINE_SELF_PACED'],
      message: 'Choose a lecture mode: On campus, Online (scheduled) or Online (self-paced).'
    },
    default: 'ON_CAMPUS'
  },
  // RETIRED (Phase 1): NSTP timing now comes from the Scheduling Policy's NSTP block. These three
  // fields are kept only so values already stored survive; the gateway no longer reads or writes them.
  isFixedTime: {
    type: Boolean,
    default: false
  },
  fixedDay: {
    type: String,
    enum: ['Saturday', 'Sunday', null],
    default: null
  },
  fixedStartSlot: {
    type: Number,
    min: 0,
    max: 19,
    default: null
  },
  // Soft-disable: a disabled subject keeps its mappings but is never ranked or scheduled.
  isActive: {
    type: Boolean,
    default: true
  },
  // Concurrency guard, not a business field: every CurriculumMapping write bumps it inside its
  // transaction, so concurrent placements of one subject collide on this document and run one after
  // another (see catalogController.writeMapping). Hidden from API responses.
  placementRevision: {
    type: Number,
    default: 0,
    select: false
  }
}, { timestamps: true });

// Lookup only; deliberately not unique.
subjectCatalogSchema.index({ subjectCode: 1 });

module.exports = mongoose.model('SubjectCatalog', subjectCatalogSchema, 'subject_catalog');
