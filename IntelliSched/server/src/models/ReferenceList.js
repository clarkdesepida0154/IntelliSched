const mongoose = require('mongoose');

// One reference list (collection reference_lists), e.g. specialization domains or position titles.
// Defaults and validation live in utils/referenceLists.js.
const referenceListSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true },
  label: { type: String, trim: true },
  items: { type: [String], default: [] },
  updatedBy: String
}, { timestamps: true });

module.exports = mongoose.model('ReferenceList', referenceListSchema, 'reference_lists');
