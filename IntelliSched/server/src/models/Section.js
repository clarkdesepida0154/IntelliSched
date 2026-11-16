const mongoose = require('mongoose');

// Sections saved before the short track codes stored long labels. They are read as codes (see the
// pre('init') hook below) instead of being rewritten in Atlas.
const LEGACY_TRACK_CODES = {
  'general track': 'NONE',
  'intelligence systems': 'IS',
  'web and mobile application development (wmad)': 'WMAD',
  'service management program (smp)': 'SMP',
  'animation and motion graphics (amg)': 'AMG'
};
const TRACK_CODES = ['NONE', 'WMAD', 'SMP', 'AMG', 'IS'];

// Any stored or submitted track value -> its code; '' when blank or unrecognised.
const normalizeTrack = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const code = raw.toUpperCase();
  if (TRACK_CODES.includes(code)) return code;
  return LEGACY_TRACK_CODES[raw.toLowerCase()] || '';
};

const sectionSchema = new mongoose.Schema({
  sectionCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  // Program code ('BSIT' | 'BSCS'), matched against CurriculumMapping.program. Older rows may
  // still hold the long name; the gateway normalizes it on every write.
  program: {
    type: String,
    required: true,
    default: 'BSIT',
    trim: true
  },
  yearLevel: {
    type: Number,
    required: true,
    min: 1,
    max: 4
  },
  // Specialization track. Forced by the gateway for BSCS (IS) and BSIT years 1-2 (NONE); chosen
  // by the Dean for BSIT years 3-4 (WMAD / SMP / AMG).
  track: {
    type: String,
    enum: TRACK_CODES,
    default: 'NONE'
  },
  // Optional and informational: the scheduler ignores it unless the Scheduling Policy's
  // enforceCapacity is on. No default: nothing invents a section size.
  studentCount: {
    type: Number,
    min: 1,
    max: 100
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

sectionSchema.index({ sectionCode: 1, isActive: 1 });

// Legacy long labels ('Web and Mobile Application Development (WMAD)', 'General Track', ...) load
// as their codes, so the new enum never fails a status toggle on an older section.
sectionSchema.pre('init', function normalizeLegacyTrack(raw) {
  if (raw && raw.track !== undefined && raw.track !== null) {
    raw.track = normalizeTrack(raw.track) || undefined;
  }
});

sectionSchema.statics.normalizeTrack = normalizeTrack;

module.exports = mongoose.model('Section', sectionSchema, 'sections');