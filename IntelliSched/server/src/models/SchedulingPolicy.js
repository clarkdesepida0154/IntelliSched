const mongoose = require('mongoose');

// The one active SchedulingPolicy (collection scheduling_policies). Its defaults and all of its
// validation live in utils/policy.js; the gateway always writes a complete, validated document, so
// this schema only describes the shape. GET /api/policy answers the defaults when no document exists
// and never creates one.
const ACTIVE_KEY = 'ACTIVE';

const schedulingPolicySchema = new mongoose.Schema({
  key: { type: String, default: ACTIVE_KEY },
  slotMinutes: Number,
  dayStart: String,
  dayEnd: String,
  weekdays: [String],
  nstp: { day: String, start: String, end: String, yearLevels: [Number] },
  saturdayOverflow: { enabled: Boolean, yearLevels: [Number], start: String, end: String },
  lunch: { enabled: Boolean, windowStart: String, windowEnd: String, minFreeMinutes: Number },
  meetings: {
    lectureMaxMeetingHours: Number,
    threeHourLecture: { MAJOR: [Number], MINOR: [Number] },
    labMaxMeetingHours: Number,
    labStartTimes: [String],
    sameSubjectDifferentDays: Boolean,
    // Phase 8 Part 6 (decision 5c): no part-timer weekday with one class (HC10).
    partTimerNoSingleDay: Boolean
  },
  // Phase 4 Part 1: a class that starts before this time costs the earlyStart penalty (Advanced).
  preferredEarliestStart: String,
  rooms: { majorLectureInLab: String, enforceCapacity: Boolean },
  load: {
    labFactor: { FULL_TIME: Number, PART_TIME: Number },
    standardWeeklyHours: Number,
    // Phase 8 Part 2 (F2): missing from this strict schema until Part 4, so a saved edit was silently
    // dropped and read back as the default through mergePolicy.
    standardTeachingHours: Number,
    ojtCoordinatorHours: Number,
    defaultTeachingCap: { FULL_TIME: Number, PART_TIME: Number },
    // Phase 8 Part 4 (decision 1): the default minimum teaching load per employment type.
    defaultMinTeachingHours: { FULL_TIME: Number, PART_TIME: Number },
    standardAncillary: { RESEARCH: Number, EXTENSION: Number, CEE: Number, CONSULTATION: Number }
  },
  catalog: { maxWeeklyHoursPerType: Number },
  // Phase 8 Part 4 (decision 4): the full-time faculty's day for Extension ('none' or a weekday).
  extensionDay: String,
  // Phase 8: the odd/even week groups (the office's practice when rooms are short). A document saved
  // before reads the defaults (on, with the office's groups) through mergePolicy.
  weekGroups: { enabled: Boolean, groups: [{ _id: false, program: String, yearLevel: Number, weeks: String }] },
  // Phase 4 Part 1 adds tbaRoomUsed (per TBA room that holds a class) and earlyStart (per class before
  // preferredEarliestStart); Phase 8 Part 5 adds facultySingleClassDay and sectionSingleClassDay (per
  // weekday with exactly one class meeting). A document saved before reads their defaults (mergePolicy).
  softWeights: { saturdayBlock: Number, lectureInLab: Number, sectionGapHour: Number, facultyGapHour: Number, overflowRoomBlock: Number, tbaRoomUsed: Number, earlyStart: Number, facultySingleClassDay: Number, fullTimerSingleClassDay: Number, sectionSingleClassDay: Number },
  // TBA rooms (Phase 3 Step 4 adds `mode`: 'auto' | 'manual' | 'off'; Phase 8 Part 5 adds the headroom
  // rule). The schema is strict, so a field missing here would be dropped on save; a document saved
  // before Step 4 has no mode and reads as 'auto', one saved before Part 5 reads headroom on at 85%.
  overflowRooms: { mode: String, enabled: Boolean, lab: Number, lec: Number, headroom: { enabled: Boolean, percent: Number } },
  updatedBy: String
}, { timestamps: true, minimize: false });

const SchedulingPolicy = mongoose.model('SchedulingPolicy', schedulingPolicySchema, 'scheduling_policies');
SchedulingPolicy.ACTIVE_KEY = ACTIVE_KEY;

module.exports = SchedulingPolicy;
