// Phase 13 (decision 2): the university's academic calendar (Administration -> System, "Academic
// calendar"): the month and day the academic year, the 2nd semester and Summer start, as "MM-DD". ONE
// document (key 'calendar'); none stored = the defaults (June 1, November 1, April 1). It is the
// college's data, so it travels with the backups (unlike system_settings). No index: the one document
// is found by its key.
const mongoose = require('mongoose');

const academicCalendarSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, default: 'calendar' },
  yearStart: { type: String, required: true, trim: true },
  secondSemesterStart: { type: String, required: true, trim: true },
  summerStart: { type: String, trim: true }
}, { versionKey: false, timestamps: true, autoIndex: false });

module.exports = mongoose.model('AcademicCalendar', academicCalendarSchema, 'academic_calendar');
