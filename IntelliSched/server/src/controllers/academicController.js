const mongoose = require('mongoose');
const Faculty = require('../models/Faculty');
const Facility = require('../models/Facility');
const Section = require('../models/Section');
const { BSIT_TRACKS } = require('../utils/curriculumMatcher');
const { loadPolicy } = require('../utils/policy');
const { validateTimeWindows } = require('../utils/timeWindows');
const { parseEvalScore, NO_EVALUATION, EVAL_FIELD_MESSAGE } = require('../utils/evaluation');
const { ratingsHidden, RATINGS_HIDDEN } = require('../utils/presentation');
const { nextFacultyCode, highestFacultyNumber, ensureCounterAbove, CounterMissingError } = require('../utils/facultyCode');
const { normalizeName } = require('../utils/names');
const { findTermLockSource } = require('../utils/termInputs');
const SubjectCatalog = require('../models/SubjectCatalog');
const { isAcademicYear } = require('../utils/academicCalendar');

// A 400 answer that names every field to fix, for the form to show next to each field.
const fieldErrors = (res, errors) => res.status(400).json({
  success: false,
  message: errors.length === 1 ? errors[0].message : `${errors.length} fields need fixing: ${errors.map(e => e.message).join(' ')}`,
  errors
});

// --- FACULTY DIRECTORY ---

const toCleanList = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v ?? '').trim()).filter(Boolean);
};

// Inbound contract for the faculty collection. engine1Profile is deliberately absent: it is
// composed here. evalScore is accepted, but only as a single 1.0-5.0 number: the controller turns
// it into the schema's { average, history } object (see parseEvalScore below), so a raw client
// object can never overwrite the history. facultyId is assigned by the server (atomic counter) and
// never changes. The deprecated maxLoad, unavailableDays, ancillaryLoad and ancillaryBreakdown are
// no longer accepted. Anything outside this list is dropped at the gateway.
const FACULTY_FIELDS = [
  'name',
  'email',
  'department',
  'major',
  'degreeLevel',
  'degreeAfterName',
  'employmentType',
  'position',
  'teachingCapHours',
  'minTeachingHours',
  'extensionDay',
  'ancillary',
  'unavailableBlocks',
  'coCurricular',
  'specializations',
  'certifications',
  'trainings',
  'isActive',
  'evalScore',
  'pastSubjectsTaught',
  'program'
];

const buildFacultyPayload = (body = {}) => {
  const payload = {};
  for (const field of FACULTY_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  // evalScore arrives as a plain number and is handled separately by the create/update paths.
  delete payload.evalScore;
  // Phase 8 Part 8 (decision 3a): the name in one style, "First M. Last"; a degree typed inside the
  // name moves to "Degree after the name" (degreeFromName: the create and update paths fill an empty
  // degree with it).
  if (payload.name !== undefined) {
    const { name, degree } = normalizeName(payload.name);
    payload.name = name;
    if (degree) Object.defineProperty(payload, 'degreeFromName', { value: degree, enumerable: false });
  }
  // Optional text fields: blank means "not recorded" (removed from the document).
  for (const key of ['email', 'position', 'coCurricular', 'degreeAfterName', 'extensionDay', 'program']) {
    if (payload[key] !== undefined) payload[key] = String(payload[key] ?? '').trim() || null;
  }
  if (payload.email) payload.email = payload.email.toLowerCase();
  if (payload.teachingCapHours !== undefined) {
    payload.teachingCapHours = payload.teachingCapHours === '' || payload.teachingCapHours === null ? null : Number(payload.teachingCapHours);
  }
  // Phase 8 Part 4: an empty minimum means "use the policy default" (the field is removed).
  if (payload.minTeachingHours !== undefined) {
    payload.minTeachingHours = payload.minTeachingHours === '' || payload.minTeachingHours === null ? null : Number(payload.minTeachingHours);
  }
  if (payload.isActive !== undefined) payload.isActive = payload.isActive === true || payload.isActive === 'true';
  return payload;
};

const MAX_ANCILLARY_TOTAL = 40;
const isHalfHourStep = (n) => Number.isFinite(n) && Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;

// The evaluation is parsed by utils/evaluation.js: 0 = "no CCS evaluation yet" (the default of a new
// profile since Phase 4 Part 2), else the latest SET rating from 1.00 to 5.00 (rounded to 2 dp).
const invalidEvalScore = (res, message = EVAL_FIELD_MESSAGE) =>
  res.status(400).json({ success: false, message, errors: [{ field: 'evalScore', message }] });
// A logged evaluation is a real one: Log Evaluation never records 0.
const LOGGED_EVAL_MESSAGE = 'Enter the SET rating from 1.00 to 5.00. A professor with no CCS evaluation yet keeps 0 on the profile; log nothing.';

// Checks the whole profile (stored record merged with the change). Returns { errors, ancillary,
// unavailableBlocks } with the cleaned lists. requireExpertise: a new profile, and an edit that sends
// the major or the specializations (the Faculty form always does), must name at least one
// specialization; an update that only changes something else (e.g. the teaching cap) is not refused
// because a stored profile has none yet.
const validateFaculty = (view, policy, { requireExpertise = true } = {}) => {
  const errors = [];
  if (!String(view.name ?? '').trim()) errors.push({ field: 'name', message: 'Enter the full name.' });
  if (!Faculty.EMPLOYMENT_TYPES.includes(view.employmentType)) {
    errors.push({ field: 'employmentType', message: 'Choose full-time or part-time.' });
  }
  const cap = view.teachingCapHours;
  if (cap === null || cap === undefined || !(typeof cap === 'number' && isHalfHourStep(cap) && cap >= 0 && cap <= 40)) {
    errors.push({ field: 'teachingCapHours', message: 'Enter the maximum teaching hours per week, from 0 to 40 in steps of 0.5.' });
  }
  // Phase 8 Part 4 (decision 1): the minimum is optional (empty = the policy default) and must sit
  // inside the cap, so the professor's load range reads minimum–cap.
  const min = view.minTeachingHours;
  if (min !== null && min !== undefined) {
    if (!(typeof min === 'number' && isHalfHourStep(min) && min >= 0 && min <= 40)) {
      errors.push({ field: 'minTeachingHours', message: 'Enter the minimum teaching hours per week, from 0 to 40 in steps of 0.5, or leave it empty for the default.' });
    } else if (typeof cap === 'number' && min > cap) {
      errors.push({ field: 'minTeachingHours', message: 'The minimum cannot be above the teaching cap.' });
    }
  }
  if (view.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(view.email)) {
    errors.push({ field: 'email', message: 'Enter a valid email address, or leave it blank.' });
  }
  if (view.position && view.position.length > 80) errors.push({ field: 'position', message: 'Keep the position under 80 characters.' });
  if (view.coCurricular && view.coCurricular.length > 500) errors.push({ field: 'coCurricular', message: 'Keep co-curricular notes under 500 characters.' });
  // Phase 8 Part 3 (decision 1d): the degree after the name ("MSIT", "PhD"), shown only on the SF-029.
  if (view.degreeAfterName && view.degreeAfterName.length > 40) errors.push({ field: 'degreeAfterName', message: 'Keep the degree under 40 characters.' });
  // Phase 8 Part 4 (decision 4): the professor's own day for Extension, overriding the policy's.
  if (view.extensionDay && !['None', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].includes(view.extensionDay)) {
    errors.push({ field: 'extensionDay', message: 'Choose a weekday, None, or leave it on the policy\'s day.' });
  }
  // Phase 8 Part 8 (decision 3c): the program printed on the Teachers' Program's Major/Minor line.
  if (view.program && !Faculty.PROGRAMS.includes(view.program)) {
    errors.push({ field: 'program', message: `Choose ${Faculty.PROGRAMS.join(', ')}, or none.` });
  }
  if (requireExpertise && !String(view.major ?? '').trim() && !toCleanList(view.specializations).length) {
    errors.push({ field: 'specializations', message: 'Choose at least one specialization.' });
  }

  // Ancillary hours by type: one row per type, 0.5-20 h each, at most 40 h in total.
  const ancillary = [];
  if (view.ancillary !== undefined && view.ancillary !== null) {
    if (!Array.isArray(view.ancillary)) {
      errors.push({ field: 'ancillary', message: 'Send ancillary hours as a list.' });
    } else {
      const seen = new Set();
      view.ancillary.forEach((row, i) => {
        const type = String(row?.type ?? '').trim();
        const hours = Number(row?.hours);
        if (!Faculty.ANCILLARY_TYPES.includes(type)) errors.push({ field: `ancillary.${i}.type`, message: 'Choose an ancillary type.' });
        else if (seen.has(type)) errors.push({ field: `ancillary.${i}.type`, message: `${Faculty.ANCILLARY_LABELS[type]} is listed twice; list each type once.` });
        seen.add(type);
        if (!(isHalfHourStep(hours) && hours >= 0.5 && hours <= 20)) {
          errors.push({ field: `ancillary.${i}.hours`, message: 'Enter 0.5 to 20 hours per week, in steps of 0.5.' });
        }
        ancillary.push({ type, hours });
      });
      const total = ancillary.reduce((sum, row) => sum + (Number.isFinite(row.hours) ? row.hours : 0), 0);
      if (total > MAX_ANCILLARY_TOTAL) errors.push({ field: 'ancillary', message: `Ancillary hours add up to ${total}; the most allowed is ${MAX_ANCILLARY_TOTAL} per week.` });
    }
  }

  const { windows, errors: blockErrors } = validateTimeWindows(view.unavailableBlocks ?? [], {
    field: 'unavailableBlocks', slotMinutes: policy.slotMinutes, keep: ['note']
  });
  return { errors: [...errors, ...blockErrors], ancillary, unavailableBlocks: windows };
};

// Engine 1 (TF-IDF) corpus text for one faculty member. Composed here, and only here, so the
// stored string always mirrors the structured fields it is derived from. The degree token is
// deliberately omitted: it carries no subject-matter signal and skews term frequencies.
const buildEngine1Profile = (source = {}) => {
  const major = String(source.major ?? '').trim();
  return [
    ...(major ? [major] : []),
    ...toCleanList(source.specializations),
    ...toCleanList(source.certifications),
    ...toCleanList(source.trainings),
    ...toCleanList(source.pastSubjectsTaught)
  ].filter(Boolean).join(' ');
};

// Answers a duplicate email with 409 on the email field. Returns true when it answered.
const duplicateFaculty = (err, res) => {
  if (err?.code !== 11000) return false;
  const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'email';
  const message = field === 'email' ? 'Another profile already uses this email address.' : 'That faculty code is already in use.';
  res.status(409).json({ success: false, message, errors: [{ field, message }] });
  return true;
};

// Blank optional fields are removed from the document rather than stored as null (an absent
// minTeachingHours means "the policy default", so blank must remove it, never store null).
const OPTIONAL_TEXT = ['email', 'position', 'coCurricular', 'degreeAfterName', 'minTeachingHours', 'extensionDay', 'program'];
const splitUnset = (payload) => {
  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(payload)) {
    if (OPTIONAL_TEXT.includes(key) && value === null) $unset[key] = '';
    else $set[key] = value;
  }
  return { $set, $unset };
};

exports.getFaculty = async (req, res, next) => {
  try {
    const faculty = await Faculty.find().sort({ name: 1 });
    res.status(200).json(faculty);
  } catch (err) {
    next(err);
  }
};

exports.createFaculty = async (req, res, next) => {
  try {
    // Phase 7: while the ratings are hidden on screen (presentation mode) the form shows no rating and
    // sends none; one sent anyway is left out, so a new profile starts at 0.
    const evalScore = (await ratingsHidden()) ? undefined : parseEvalScore(req.body.evalScore);
    if (evalScore === null) return invalidEvalScore(res);
    // A new profile starts at 0 ("no CCS evaluation yet") unless a rating was sent.
    const initialScore = evalScore ?? NO_EVALUATION;

    const inbound = buildFacultyPayload(req.body);
    if (inbound.degreeFromName && !inbound.degreeAfterName) inbound.degreeAfterName = inbound.degreeFromName;
    // Phase 8 Part 8: a new profile is never created archived (Archive is its own action).
    if (!inbound.major && toCleanList(inbound.specializations).length) inbound.major = toCleanList(inbound.specializations)[0];
    // Phase 11.2 (decision 1): part-timers have no ancillary loads; hours sent for one are ignored,
    // never a reason to refuse the save.
    if (inbound.employmentType === 'PART_TIME') delete inbound.ancillary;
    const { errors, ancillary, unavailableBlocks } = validateFaculty(inbound, await loadPolicy());
    if (errors.length) return fieldErrors(res, errors);

    const doc = {
      ...inbound,
      ancillary,
      unavailableBlocks,
      engine1Profile: buildEngine1Profile(inbound),
      // The Add form carries no term, so the opening entry is recorded without one; 0 is no
      // evaluation, so it is never an entry (the history holds real ratings only).
      evalScore: { average: initialScore, history: initialScore > NO_EVALUATION ? [{ score: initialScore, dateAdded: new Date() }] : [] }
    };
    OPTIONAL_TEXT.forEach(key => { if (doc[key] === null) delete doc[key]; });

    // A code taken by a record the counter did not know about is skipped once.
    let created = null;
    for (let attempt = 0; attempt < 2 && !created; attempt += 1) {
      try {
        created = await Faculty.create({ ...doc, facultyId: await nextFacultyCode() });
      } catch (err) {
        if (err?.code === 11000 && err.keyPattern?.facultyId && attempt === 0) {
          await ensureCounterAbove(await highestFacultyNumber());
          continue;
        }
        throw err;
      }
    }
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof CounterMissingError) return res.status(503).json({ success: false, message: err.message });
    if (!duplicateFaculty(err, res)) next(err);
  }
};

exports.updateFaculty = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Faculty not found' });
    const existing = await Faculty.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Faculty not found' });

    // Partial updates are allowed, so the profile is validated and recomputed from the merged view
    // of the stored document and the incoming changes, never from the request body alone. Phase 7:
    // while the ratings are hidden on screen, a rating in the body is left out, so the stored one stays
    // (the form saw "Hidden (presentation mode)", never the value).
    const evalScore = (await ratingsHidden()) ? undefined : parseEvalScore(req.body.evalScore);
    if (evalScore === null) return invalidEvalScore(res);

    const inbound = buildFacultyPayload(req.body);
    // Phase 8 Part 8 (decision 3a): a degree typed inside the name fills an empty degree (the stored one
    // and the one sent with the form win).
    if (inbound.degreeFromName && !inbound.degreeAfterName && !existing.degreeAfterName) inbound.degreeAfterName = inbound.degreeFromName;
    // Phase 8 Part 8 (decision 3d): an archived profile stays inactive until it is restored.
    if (existing.archived) delete inbound.isActive;
    if (inbound.specializations !== undefined && !inbound.major && toCleanList(inbound.specializations).length) {
      inbound.major = toCleanList(inbound.specializations)[0];
    }
    // Phase 11.2 (decision 1): hours sent for a part-timer are ignored (the stored ones stay, unread
    // by every load), so they never refuse the save.
    const partTimeAfter = (inbound.employmentType ?? existing.employmentType) === 'PART_TIME';
    if (partTimeAfter) delete inbound.ancillary;
    const merged = { ...existing.toObject(), ...inbound };
    if (partTimeAfter) delete merged.ancillary;
    const requireExpertise = inbound.major !== undefined || inbound.specializations !== undefined;
    const { errors, ancillary, unavailableBlocks } = validateFaculty(merged, await loadPolicy(), { requireExpertise });
    if (errors.length) return fieldErrors(res, errors);
    if (inbound.ancillary !== undefined) inbound.ancillary = ancillary;
    if (inbound.unavailableBlocks !== undefined) inbound.unavailableBlocks = unavailableBlocks;

    const { $set, $unset } = splitUnset(inbound);
    // A profile with no expertise text at all keeps the matching profile it has (the field is required).
    const update = { $set: { ...$set, engine1Profile: buildEngine1Profile(merged) || existing.engine1Profile } };
    if (Object.keys($unset).length) update.$unset = $unset;

    // A changed evaluation replaces the average and is appended to the history, so the table can
    // show the trend. An unchanged (or absent) score leaves both untouched. The Edit form has no
    // term picker, so this entry has no term; Log Evaluation is the term-tagged path.
    const currentAverage = Number(existing.evalScore?.average);
    if (evalScore !== undefined && evalScore !== currentAverage) {
      update.$set['evalScore.average'] = evalScore;
      // Back to 0 ("no CCS evaluation yet") replaces the average and logs nothing.
      if (evalScore > NO_EVALUATION) update.$push = { 'evalScore.history': { score: evalScore, dateAdded: new Date() } };
    }

    const updated = await Faculty.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    res.status(200).json(updated);
  } catch (err) {
    if (!duplicateFaculty(err, res)) next(err);
  }
};

// PATCH /api/faculty/:id/evaluation  { term, score }
// Logs one term's evaluation: the entry is pushed onto evalScore.history and evalScore.average
// is set to this NEW score (not a lifetime mean) because Engine 2 ranks on current performance.
// One atomic update, so a concurrent edit can never interleave between the push and the set.
const MAX_TERM_LENGTH = 60;

exports.logEvaluation = async (req, res, next) => {
  try {
    // Phase 7: no rating is logged from the screen while the ratings are hidden (presentation mode).
    if (await ratingsHidden()) return res.status(409).json(RATINGS_HIDDEN);
    // Types are checked, not coerced: a boolean score would otherwise log as 1.00 and an object
    // term would be stored as '[object Object]'.
    const rawTerm = req.body?.term;
    const term = typeof rawTerm === 'string' ? rawTerm.trim() : '';
    if (!term || term.length > MAX_TERM_LENGTH) {
      return res.status(400).json({ success: false, message: 'Choose the semester this evaluation belongs to.' });
    }
    const rawScore = req.body?.score;
    const isNumericInput = typeof rawScore === 'number' || (typeof rawScore === 'string' && rawScore.trim() !== '');
    const score = isNumericInput ? parseEvalScore(rawScore) : null;
    if (score === undefined || score === null || score === NO_EVALUATION) return invalidEvalScore(res, LOGGED_EVAL_MESSAGE);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Faculty not found' });
    }

    const updated = await Faculty.findByIdAndUpdate(
      req.params.id,
      {
        $push: { 'evalScore.history': { term, score, dateAdded: new Date() } },
        $set: { 'evalScore.average': score }
      },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: 'Faculty not found' });
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
};

// A targeted update, so enabling or disabling an unmigrated profile (no employmentType yet) never
// re-validates the whole document.
exports.toggleFacultyStatus = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Faculty not found' });
    const faculty = await Faculty.findById(req.params.id).select('isActive archived name').lean();
    if (!faculty) return res.status(404).json({ message: 'Faculty not found' });
    // Phase 8 Part 8 (decision 3d): Disable and Enable keep their meaning; an archived profile is
    // restored first.
    if (faculty.archived) return res.status(409).json({ success: false, code: 'ARCHIVED', message: `${faculty.name} is archived. Restore the profile from the Archived list first.` });
    const updated = await Faculty.findByIdAndUpdate(req.params.id, { $set: { isActive: !faculty.isActive } }, { new: true }).select('isActive').lean();
    res.status(200).json({ message: 'Status toggled', isActive: updated.isActive });
  } catch (err) {
    next(err);
  }
};

// The classes a professor has in a term (Phase 8 Part 8, decision 3d): the term's assignments (the
// lock source: the newest Draft, or a newer version under review or approved), lecture and lab as one
// class, practicum coordinations included. [{ sectionCode, subjectCode, descriptiveTitle }].
const classesInTerm = async (facultyId, term) => {
  const source = await findTermLockSource(term);
  const mine = (source?.lockedAssignments || []).filter(l => String(l.facultyRef) === String(facultyId));
  const seen = new Set();
  const rows = [];
  const titles = new Map((await SubjectCatalog.find({ _id: { $in: mine.map(l => l.subjectId).filter(Boolean) } }).select('descriptiveTitle').lean()).map(s => [String(s._id), s.descriptiveTitle]));
  for (const l of mine) {
    const key = `${l.sectionCode}|${l.subjectId || l.subjectCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ sectionCode: l.sectionCode, subjectCode: l.subjectCode, descriptiveTitle: titles.get(String(l.subjectId)) || '' });
  }
  return rows.sort((a, b) => a.sectionCode.localeCompare(b.sectionCode) || a.subjectCode.localeCompare(b.subjectCode));
};
const termOf = (body = {}) => {
  const academicYear = String(body.academicYear ?? '').trim();
  const semester = Number(body.semester);
  return isAcademicYear(academicYear) && [1, 2].includes(semester) ? { academicYear, semester } : null;
};

// PATCH /api/faculty/:id/archive { academicYear, semester } (data.edit; Phase 8 Part 8, decision 3d):
// Archived = transferred or removed from CCS. A professor with classes in the term is not archived:
// the answer (409 HAS_CLASSES) lists them, to be reassigned first. Otherwise the profile becomes
// archived and inactive; the state it had is kept for Restore.
exports.archiveFaculty = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Faculty not found' });
    const term = termOf(req.body);
    if (!term) return res.status(400).json({ success: false, message: 'Choose the term first: archiving checks the professor\'s classes in it.' });
    const faculty = await Faculty.findById(req.params.id).select('name isActive archived').lean();
    if (!faculty) return res.status(404).json({ success: false, message: 'Faculty not found' });
    if (faculty.archived) return res.status(200).json({ success: true, archived: true, isActive: false, message: `${faculty.name} is already archived.` });
    const classes = await classesInTerm(faculty._id, term);
    if (classes.length) {
      return res.status(409).json({
        success: false,
        code: 'HAS_CLASSES',
        classes,
        message: `${faculty.name} has ${classes.length} ${classes.length === 1 ? 'class' : 'classes'} this term (${classes.map(c => `${c.subjectCode} for ${c.sectionCode}`).join('; ')}). Reassign ${classes.length === 1 ? 'it' : 'them'} on Assign Faculty first, then archive the profile.`
      });
    }
    const updated = await Faculty.findByIdAndUpdate(req.params.id, { $set: { archived: true, archivedAt: new Date(), wasActive: faculty.isActive !== false, isActive: false } }, { new: true }).lean();
    res.status(200).json({ success: true, archived: true, isActive: updated.isActive, message: `${faculty.name} was archived: the profile leaves Assign Faculty, the loads, the Readiness Check and the schedule. Saved versions keep it.` });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/faculty/:id/restore (data.edit; Phase 8 Part 8, decision 3d): back from the archive, as
// Active or Inactive as it was when it was archived.
exports.restoreFaculty = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Faculty not found' });
    const faculty = await Faculty.findById(req.params.id).select('name archived wasActive').lean();
    if (!faculty) return res.status(404).json({ success: false, message: 'Faculty not found' });
    if (!faculty.archived) return res.status(200).json({ success: true, archived: false, message: `${faculty.name} is not archived.` });
    const isActive = faculty.wasActive !== false;
    const updated = await Faculty.findByIdAndUpdate(req.params.id, { $set: { isActive }, $unset: { archived: '', archivedAt: '', wasActive: '' } }, { new: true }).lean();
    res.status(200).json({ success: true, archived: false, isActive: updated.isActive, message: `${faculty.name} was restored (${isActive ? 'active' : 'inactive'}).` });
  } catch (err) {
    next(err);
  }
};

// --- FACILITIES (ROOMS) ---


// Inbound contract for rooms; anything else is dropped at the gateway.
const FACILITY_FIELDS = ['roomName', 'type', 'capacity', 'building', 'availability', 'isActive'];

const buildFacilityPayload = (body = {}) => {
  const payload = {};
  for (const field of FACILITY_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.roomName !== undefined) payload.roomName = String(payload.roomName ?? '').trim().toUpperCase();
  if (payload.type !== undefined) payload.type = String(payload.type ?? '').trim().toUpperCase();
  // Capacity and building are optional: a blank value means "not recorded".
  if (payload.capacity !== undefined) payload.capacity = payload.capacity === '' || payload.capacity === null ? null : Number(payload.capacity);
  if (payload.building !== undefined) payload.building = String(payload.building ?? '').trim() || null;
  if (payload.isActive !== undefined) payload.isActive = payload.isActive === true || payload.isActive === 'true';
  return payload;
};

// Checks the whole room (stored record merged with the change). Returns { errors, availability }.
const validateFacility = (view, policy) => {
  const errors = [];
  if (!String(view.roomName ?? '').trim()) errors.push({ field: 'roomName', message: 'Enter the room name.' });
  if (!['LEC', 'LAB'].includes(view.type)) errors.push({ field: 'type', message: 'Choose LEC or LAB as the room type.' });
  if (view.capacity !== null && view.capacity !== undefined &&
      !(Number.isInteger(view.capacity) && view.capacity >= 1 && view.capacity <= 300)) {
    errors.push({ field: 'capacity', message: 'Capacity must be a whole number from 1 to 300, or left blank.' });
  }
  const { windows, errors: windowErrors } = validateTimeWindows(view.availability ?? [], { field: 'availability', slotMinutes: policy.slotMinutes });
  return { errors: [...errors, ...windowErrors], availability: windows };
};

// A blank optional field is removed from the document rather than stored as null.
const toRoomUpdate = (payload) => {
  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(payload)) {
    if ((key === 'capacity' || key === 'building') && value === null) $unset[key] = '';
    else $set[key] = value;
  }
  return Object.keys($unset).length ? { $set, $unset } : { $set };
};

const duplicateRoom = (err, res, roomName) => {
  if (err?.code !== 11000) return false;
  res.status(409).json({ success: false, message: `A room named ${roomName} already exists.`, errors: [{ field: 'roomName', message: `A room named ${roomName} already exists.` }] });
  return true;
};

exports.getFacilities = async (req, res, next) => {
  try {
    const rooms = await Facility.find().sort({ roomName: 1 });
    res.status(200).json(rooms);
  } catch (err) {
    next(err);
  }
};

exports.createFacility = async (req, res, next) => {
  const payload = buildFacilityPayload(req.body);
  try {
    const { errors, availability } = validateFacility(payload, await loadPolicy());
    if (errors.length) return fieldErrors(res, errors);
    const doc = { ...payload, availability, isActive: payload.isActive ?? true };
    if (doc.capacity === null) delete doc.capacity;
    if (doc.building === null) delete doc.building;
    const newRoom = await Facility.create(doc);
    res.status(201).json(newRoom);
  } catch (err) {
    if (!duplicateRoom(err, res, payload.roomName)) next(err);
  }
};

exports.updateFacility = async (req, res, next) => {
  const payload = buildFacilityPayload(req.body);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Room not found' });
    const existing = await Facility.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ message: 'Room not found' });
    const { errors, availability } = validateFacility({ ...existing, ...payload }, await loadPolicy());
    if (errors.length) return fieldErrors(res, errors);
    if (payload.availability !== undefined) payload.availability = availability;
    const updated = await Facility.findByIdAndUpdate(req.params.id, toRoomUpdate(payload), { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Room not found' });
    res.status(200).json(updated);
  } catch (err) {
    if (!duplicateRoom(err, res, payload.roomName)) next(err);
  }
};

exports.toggleFacilityStatus = async (req, res, next) => {
  try {
    const room = await Facility.findById(req.params.id);
    if (!room) return res.status(404).json({ message: 'Room not found' });
    room.isActive = !room.isActive;
    await room.save();
    res.status(200).json({ message: 'Status toggled', isActive: room.isActive });
  } catch (err) {
    next(err);
  }
};

// --- SECTIONS ---

// Inbound contract for sections; anything else is dropped at the gateway.
const SECTION_FIELDS = ['sectionCode', 'program', 'yearLevel', 'track', 'studentCount', 'isActive'];

const SECTION_PROGRAM_CODES = {
  BSIT: 'BSIT',
  BSCS: 'BSCS',
  'BS INFORMATION TECHNOLOGY': 'BSIT',
  'BS COMPUTER SCIENCE': 'BSCS'
};
const toSectionProgram = (value) => SECTION_PROGRAM_CODES[String(value ?? '').trim().toUpperCase()] || null;

const buildSectionPayload = (body = {}) => {
  const payload = {};
  for (const field of SECTION_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.sectionCode !== undefined) payload.sectionCode = String(payload.sectionCode).trim().toUpperCase();
  if (payload.yearLevel !== undefined) payload.yearLevel = Number(payload.yearLevel);
  // Optional and informational: a blank value means "not recorded".
  if (payload.studentCount !== undefined) payload.studentCount = payload.studentCount === '' || payload.studentCount === null ? null : Number(payload.studentCount);
  return payload;
};

// Track rule (CLAUDE.md): BSCS -> IS; BSIT years 1-2 -> NONE; BSIT years 3-4 -> WMAD, SMP or AMG.
// A track that is fixed by program and year is filled in when none is sent; a track that is SENT
// and contradicts the rule is refused. `view` is the full section (stored record merged with the
// change); `sentTrack` is the track in the request, if any. Returns { program, track } or { error }.
const resolveSectionScope = (view, sentTrack) => {
  const program = toSectionProgram(view.program ?? 'BSIT');
  if (!program) return { error: 'Program must be BSIT or BSCS.', field: 'program' };
  const year = Number(view.yearLevel);
  if (!Number.isInteger(year) || year < 1 || year > 4) return { error: 'Year level must be 1, 2, 3 or 4.', field: 'yearLevel' };
  const sent = sentTrack === undefined || sentTrack === null || String(sentTrack).trim() === ''
    ? null
    : (Section.normalizeTrack(sentTrack) || String(sentTrack).trim().toUpperCase());
  if (program === 'BSCS') {
    if (sent && sent !== 'IS') return { error: `BSCS sections are on the IS track; ${sent} is a BSIT track.`, field: 'track' };
    return { program, track: 'IS' };
  }
  if (year === 1 || year === 2) {
    if (sent && sent !== 'NONE') return { error: `1st and 2nd year BSIT sections have no specialization track; ${sent} starts in 3rd year.`, field: 'track' };
    return { program, track: 'NONE' };
  }
  const track = sent ?? Section.normalizeTrack(view.track);
  if (!BSIT_TRACKS.includes(track)) {
    return { error: 'Select a specialization track (WMAD, SMP or AMG) for 3rd and 4th year BSIT sections.', field: 'track' };
  }
  return { program, track };
};

const checkStudentCount = (value) => (value === null || value === undefined ||
  (Number.isInteger(value) && value >= 1 && value <= 100)
  ? null
  : { field: 'studentCount', message: 'Number of students must be a whole number from 1 to 100, or left blank.' });

exports.getSections = async (req, res, next) => {
  try {
    const sections = await Section.find().sort({ sectionCode: 1 });
    res.status(200).json(sections);
  } catch (err) {
    next(err);
  }
};

const duplicateSection = (err, res, sectionCode) => {
  if (err?.code !== 11000) return false;
  res.status(409).json({ success: false, message: `A section named ${sectionCode} already exists.`, errors: [{ field: 'sectionCode', message: `A section named ${sectionCode} already exists.` }] });
  return true;
};

exports.createSection = async (req, res, next) => {
  const payload = buildSectionPayload(req.body);
  try {
    if (!payload.sectionCode) return fieldErrors(res, [{ field: 'sectionCode', message: 'Enter the section code.' }]);
    const scope = resolveSectionScope(payload, payload.track);
    if (scope.error) return fieldErrors(res, [{ field: scope.field, message: scope.error }]);
    const countError = checkStudentCount(payload.studentCount);
    if (countError) return fieldErrors(res, [countError]);
    const doc = { ...payload, program: scope.program, track: scope.track };
    if (doc.studentCount === null) delete doc.studentCount;
    const newSection = await Section.create(doc);
    res.status(201).json(newSection);
  } catch (err) {
    if (!duplicateSection(err, res, payload.sectionCode)) next(err);
  }
};

exports.updateSection = async (req, res, next) => {
  const payload = buildSectionPayload(req.body);
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Section not found' });
    const existing = await Section.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Section not found' });
    // The track depends on program and year level together, so it is resolved from the merged
    // view: changing only the year level of a BSIT section can still require a track choice.
    const scope = resolveSectionScope({ ...existing.toObject(), ...payload }, payload.track);
    if (scope.error) return fieldErrors(res, [{ field: scope.field, message: scope.error }]);
    const countError = checkStudentCount(payload.studentCount);
    if (countError) return fieldErrors(res, [countError]);
    const { studentCount, ...rest } = payload;
    const update = { $set: { ...rest, program: scope.program, track: scope.track } };
    if (studentCount === null) update.$unset = { studentCount: '' };
    else if (studentCount !== undefined) update.$set.studentCount = studentCount;
    const updated = await Section.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Section not found' });
    res.status(200).json(updated);
  } catch (err) {
    if (!duplicateSection(err, res, payload.sectionCode)) next(err);
  }
};

exports.toggleSectionStatus = async (req, res, next) => {
  try {
    const section = await Section.findById(req.params.id);
    if (!section) return res.status(404).json({ message: 'Section not found' });
    section.isActive = !section.isActive;
    await section.save();
    res.status(200).json({ message: 'Status toggled', isActive: section.isActive });
  } catch (err) {
    next(err);
  }
};
