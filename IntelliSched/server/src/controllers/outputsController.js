// GET /api/schedule/outputs?academicYear&semester[&scheduleId][&prefer=draft|official] (Phase 3 Step 1):
// one schedule version joined for the three outputs (Mother Schedule, Teachers' Program, Room Program)
// and the "TBA rooms to request". This handler picks the version and loads the records its classes
// name, by id, and the Output Settings; utils/scheduleOutputs.js builds the answer. Reads only: no
// role guard, like /schedule/active.
const mongoose = require('mongoose');
const MotherSchedule = require('../models/MotherSchedule');
const SubjectCatalog = require('../models/SubjectCatalog');
const Section = require('../models/Section');
const Faculty = require('../models/Faculty');
const Facility = require('../models/Facility');
const { loadPolicy, mergePolicy } = require('../utils/policy');
const { isLegacySchedule } = require('../utils/scheduleItems');
const { buildScheduleOutputs } = require('../utils/scheduleOutputs');
const { loadOutputSettings } = require('../utils/outputSettings');
const { toSemesterLabel } = require('../utils/curriculumMatcher');
const { NEWEST_FIRST } = require('../utils/termInputs');

const { plainMessage } = require('../utils/messages');
const { isAcademicYear } = require('../utils/academicCalendar');
// The page gets plain words; the raw error goes to the server log (utils/messages.js, Phase 4 Part 4).
const sanitizedMessage = (err, fallback) => plainMessage(err, fallback, { label: '[Outputs]' });

const LEGACY_VERSION = 'This version was saved before the current schedule records and cannot be shown in these views.';
const NO_SCHEDULE = 'No schedule has been generated for this term yet.';
// The term has versions with classes, but every one is legacy or Archived, so none opens by default.
const NO_OPEN_VERSION = "This term's versions were saved in an older format or are archived, so none opens here. Generate a new Draft on the Generate Schedule page.";

// A version the views can show: schemaVersion 2, with classes, and every class named by its demand id
// (isLegacySchedule as a query).
const SHOWABLE = {
  schemaVersion: { $gte: 2 },
  'scheduleData.0': { $exists: true },
  scheduleData: { $not: { $elemMatch: { demandId: { $in: [null, ''] } } } }
};

// The newest showable version of the term with the given status, by the gateway's one "newest" rule
// (utils/termInputs.js): by createdAt, since a move saved on an older Draft changes its updatedAt,
// never its age.
const newestVersion = (term, statusFilter) =>
  MotherSchedule.findOne({ ...term, ...SHOWABLE, ...statusFilter }).sort(NEWEST_FIRST).lean();

// The version that opens when none is asked for.
//   draft (the views): the newest Draft with classes, else the newest other version with classes that
//     is not Archived;
//   official (printing): the newest Approved (Phase 8 Part 6: a version stored as Published reads as
//     Approved), else the draft choice, marked fallback.
const chooseVersion = async (term, prefer) => {
  if (prefer === 'official') {
    const official = await newestVersion(term, { status: { $in: ['Approved', 'Published'] } });
    if (official) return { doc: official, fallback: false };
  }
  const doc = (await newestVersion(term, { status: 'Draft' })) || (await newestVersion(term, { status: { $ne: 'Archived' } }));
  return { doc, fallback: prefer === 'official' && Boolean(doc) };
};

const uniqueIds = (values) => [...new Set(values.filter(Boolean).map(String))];

// The outputs of one version, loaded for a query: picks the version, loads the records its classes
// name and the Output Settings, and builds the one answer every view reads. Returns { outputs } or
// { error: { status, payload } } with the refusal to send as it is. GET /schedule/outputs and the
// exports (Phase 8 Part 2) both go through here, never a second copy.
const loadScheduleOutputs = async (query) => {
  const refuse = (status, payload) => ({ error: { status, payload: { success: false, ...payload } } });
  const academicYear = String(query.academicYear ?? '').trim();
  if (!isAcademicYear(academicYear)) {
    return refuse(400, { message: 'Choose an academic year, for example 2025-2026.' });
  }
  const semester = Number(query.semester);
  if (![1, 2].includes(semester)) {
    return refuse(400, { message: 'Choose the 1st or the 2nd semester.' });
  }
  const prefer = String(query.prefer || 'draft').trim();
  if (!['draft', 'official'].includes(prefer)) {
    return refuse(400, { message: 'Choose which version opens first: draft or official.' });
  }
  const term = { academicYear, semester };
  const scheduleId = String(query.scheduleId ?? '').trim();

  let doc;
  let fallback = false;
  if (scheduleId) {
    // A version asked for by id must belong to this term: never fall back to another one silently.
    doc = mongoose.isObjectIdOrHexString(scheduleId) ? await MotherSchedule.findOne({ _id: scheduleId, ...term }).lean() : null;
    if (!doc) {
      return refuse(404, {
        code: 'VERSION_NOT_IN_TERM',
        message: `That version does not belong to the ${toSemesterLabel(semester)}, AY ${academicYear}. Choose a version from the list.`
      });
    }
    if (isLegacySchedule(doc)) return refuse(409, { code: 'LEGACY_VERSION', message: LEGACY_VERSION });
  } else {
    ({ doc, fallback } = await chooseVersion(term, prefer));
    if (!doc) {
      // "Nothing generated" only when no version of the term has classes; otherwise they are all
      // legacy or Archived.
      const hasClasses = await MotherSchedule.exists({ ...term, 'scheduleData.0': { $exists: true } });
      return refuse(404, hasClasses
        ? { code: 'NO_OPEN_VERSION', message: NO_OPEN_VERSION }
        : { code: 'NO_SCHEDULE', message: NO_SCHEDULE });
    }
  }

  // The policy the version was generated under; the stored one for a version without a snapshot.
  const policy = doc.policySnapshot ? mergePolicy(doc.policySnapshot, undefined) : await loadPolicy();
  const items = doc.scheduleData || [];
  const unscheduled = doc.unscheduledItems || [];
  const OutsideTeacher = require('../models/OutsideTeacher');
  const [subjects, sections, faculty, facilities, settings, outsideTeachers] = await Promise.all([
    SubjectCatalog.find({ _id: { $in: uniqueIds([...items.map(i => i.subjectId), ...unscheduled.map(u => u.subjectId)]) } }).lean(),
    // Full documents: the Section init hook reads old long track labels as codes (lean() skips it).
    Section.find({ _id: { $in: uniqueIds([...items.map(i => i.sectionId), ...unscheduled.map(u => u.sectionId)]) } }),
    Faculty.find({ _id: { $in: uniqueIds([...items.map(i => i.facultyRef), ...unscheduled.map(u => u.facultyRef)]) } }).lean(),
    // Every active room, plus the inactive ones that hold classes of this version.
    Facility.find({ $or: [{ isActive: true }, { _id: { $in: uniqueIds(items.map(i => i.roomId)) } }] }).lean(),
    // What the outputs print besides the classes (the defaults until the Dean saves them).
    loadOutputSettings(),
    // Phase 8 Part 8 (decision 4): the outside teachers the classes name (their current names).
    OutsideTeacher.find({ _id: { $in: uniqueIds(items.map(i => i.outsideTeacherRef)) } }).lean()
  ]);

  return {
    outputs: buildScheduleOutputs({
      doc,
      policy,
      subjects,
      sections: sections.map(s => s.toObject()),
      faculty,
      facilities,
      settings,
      fallback,
      outsideTeachers
    })
  };
};

exports.loadScheduleOutputs = loadScheduleOutputs;

exports.getScheduleOutputs = async (req, res) => {
  try {
    const { outputs, error } = await loadScheduleOutputs(req.query);
    if (error) return res.status(error.status).json(error.payload);
    res.status(200).json({ success: true, ...outputs });
  } catch (err) {
    console.error('[Outputs Error - Schedule Outputs]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The schedule views could not be loaded. Try again.') });
  }
};
