const mongoose = require('mongoose');
const { MAPPING_PROGRAMS, YEAR_LEVEL_LABELS, SEMESTER_LABELS, SUBJECT_TRACKS } = require('../utils/curriculumMatcher');

// One placement of a catalog subject in a curriculum block (program + year level + semester +
// track). The subject is referenced by ObjectId, so placements never depend on the subject code
// being unique. The controller refuses a placement that repeats or overlaps an existing one with a
// 409; there is no unique index, so a write here can never raise an E11000 duplicate-key error.
const curriculumMappingSchema = new mongoose.Schema({
  // 'Both' places the subject in BSIT and BSCS sections alike.
  program: {
    type: String,
    required: [true, 'Program is required'],
    enum: { values: MAPPING_PROGRAMS, message: 'Program must be BSIT, BSCS or Both' }
  },
  yearLevel: {
    type: String,
    required: [true, 'Year level is required'],
    enum: { values: YEAR_LEVEL_LABELS, message: 'Year level must be 1st, 2nd, 3rd or 4th Year' }
  },
  semester: {
    type: String,
    required: [true, 'Semester is required'],
    enum: { values: SEMESTER_LABELS, message: 'Semester must be 1st Semester or 2nd Semester' }
  },
  // CORE goes to every section of the program(s); a specialization track only to its own sections.
  track: {
    type: String,
    enum: { values: SUBJECT_TRACKS, message: 'Track must be CORE, WMAD, SMP, AMG or IS' },
    default: 'CORE'
  },
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubjectCatalog',
    required: [true, 'A catalog subject is required']
  }
}, { timestamps: true });

// Lookup only; deliberately not unique.
curriculumMappingSchema.index({ semester: 1, program: 1, yearLevel: 1, track: 1 });
curriculumMappingSchema.index({ subject: 1 });

module.exports = mongoose.model('CurriculumMapping', curriculumMappingSchema, 'curriculum_mappings');
