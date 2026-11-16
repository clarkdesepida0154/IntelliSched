const mongoose = require('mongoose');
const { MAX_LENGTH, TEACHERS_PROGRAM_LAYOUTS, AUTO_PROFESSOR } = require('../utils/outputSettings');

// The one Output Settings document (collection output_settings, key 'active'): the titles, form codes,
// signatory lines and print choices of the three outputs, and the campus code. Its defaults and all of
// its validation live in utils/outputSettings.js; the gateway always writes a complete, validated
// document. GET /api/output-settings answers the defaults when no document exists and never creates
// one. No index: Atlas indexes change only through a migration (findOne by key, then an upsert).
const ACTIVE_KEY = 'active';

const text = (maxlength) => ({ type: String, trim: true, maxlength });

// One signatory line. auto: '' (a name typed by the Dean, or a blank line to sign on) or 'professor'
// (the Teachers' Program's "Conformed/Received by:", filled in when printed).
const signatorySchema = new mongoose.Schema({
  label: text(MAX_LENGTH.signatory.label),
  name: text(MAX_LENGTH.signatory.name),
  title: text(MAX_LENGTH.signatory.title),
  auto: { type: String, trim: true, enum: ['', AUTO_PROFESSOR] }
}, { _id: false });

// What every output has: its title, the form code, revision and date printed in the footer, and the
// signatory lines.
const formFields = () => ({
  title: text(MAX_LENGTH.form.title),
  formCode: text(MAX_LENGTH.form.formCode),
  revision: text(MAX_LENGTH.form.revision),
  date: text(MAX_LENGTH.form.date),
  signatories: [signatorySchema]
});

// Who saved the settings last (utils/actor.js actorOf).
const actorSchema = new mongoose.Schema({ id: String, name: String, role: String }, { _id: false });

const outputSettingsSchema = new mongoose.Schema({
  key: { type: String, default: ACTIVE_KEY },
  campusCode: text(MAX_LENGTH.campusCode),
  collegeName: text(MAX_LENGTH.collegeName),
  teachersProgram: { ...formFields(), showRooms: Boolean, layout: { type: String, enum: TEACHERS_PROGRAM_LAYOUTS } },
  motherSchedule: { ...formFields(), showSubjectList: Boolean },
  roomProgram: formFields(),
  // Phase 7, presentation mode: false hides every rating on screen (utils/presentation.js).
  showEvaluationRatings: Boolean,
  updatedBy: { type: actorSchema, default: null }
}, { timestamps: true, minimize: false });

const OutputSettings = mongoose.model('OutputSettings', outputSettingsSchema, 'output_settings');
OutputSettings.ACTIVE_KEY = ACTIVE_KEY;

module.exports = OutputSettings;
