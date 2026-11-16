const mongoose = require('mongoose');
const SubjectCatalog = require('../models/SubjectCatalog');
const CurriculumMapping = require('../models/CurriculumMapping');
const { SUBJECT_TYPES, SUBJECT_TRACKS, mappingPrograms, validateMappingScope } = require('../utils/curriculumMatcher');
const { LECTURE_MODES } = require('../utils/meetings');
const { loadPolicy } = require('../utils/policy');

// Schema validation and cast failures are the client's input errors, so they answer 400 with the
// schema's own message instead of reaching the generic 500 handler.
const handleWriteError = (err, res, next) => {
  if (err?.name === 'ValidationError') {
    const message = Object.values(err.errors || {})[0]?.message || err.message;
    return res.status(400).json({ success: false, message });
  }
  if (err?.name === 'CastError') {
    return res.status(400).json({ success: false, message: `Invalid value for ${err.path}.` });
  }
  return next(err);
};

// =========================================================================
// MASTER CATALOG (SubjectCatalog)
// =========================================================================

// Explicit inbound contract; anything else is dropped at the gateway. NSTP timing comes from the
// Scheduling Policy, so the old per-subject isFixedTime / fixedDay / fixedStartSlot fields are no
// longer accepted or written (values already stored are left as they are).
const CATALOG_FIELDS = [
  'subjectCode',
  'descriptiveTitle',
  'subjectDescription',
  'type',
  'lecHours',
  'labHours',
  'units',
  'requiresRoom',
  // Phase 3 Step 7: how a Major's lectures are held (ON_CAMPUS, ONLINE_SCHEDULED, ONLINE_SELF_PACED).
  'lectureMode',
  'isPracticum',
  'isActive'
];
const LECTURE_MODE_MESSAGE = 'Choose a lecture mode: On campus, Online (scheduled) or Online (self-paced).';

const isHalfStep = (value) => Number.isFinite(value) && value >= 0 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

const buildCatalogPayload = (body = {}) => {
  const payload = {};
  for (const field of CATALOG_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (payload.subjectCode !== undefined) payload.subjectCode = String(payload.subjectCode ?? '').trim().toUpperCase();
  if (payload.descriptiveTitle !== undefined) payload.descriptiveTitle = String(payload.descriptiveTitle ?? '').trim();
  if (payload.subjectDescription !== undefined) payload.subjectDescription = String(payload.subjectDescription ?? '').trim();
  for (const field of ['lecHours', 'labHours', 'units']) {
    if (payload[field] !== undefined) payload[field] = Number(payload[field]);
  }
  if (payload.requiresRoom !== undefined) payload.requiresRoom = payload.requiresRoom === true || payload.requiresRoom === 'true';
  // An empty choice is the default (on campus); any other value is checked by validateCatalogSubject.
  if (payload.lectureMode !== undefined) payload.lectureMode = payload.lectureMode === null || String(payload.lectureMode).trim() === '' ? 'ON_CAMPUS' : String(payload.lectureMode).trim();
  if (payload.isPracticum !== undefined) payload.isPracticum = payload.isPracticum === true || payload.isPracticum === 'true';
  if (payload.isActive !== undefined) payload.isActive = payload.isActive === true || payload.isActive === 'true';
  return payload;
};

// Behaviour-driven routing: the type alone decides room handling, so no client can store a
// contradictory combination. Hours and units stay as entered. NSTP needs no room and meets in the
// policy's NSTP block. A practicum Major has no contact hours and no room (it is never scheduled).
// Only a Major that is not a practicum may hold its lectures online (Phase 3 Step 7): every other
// subject is stored on campus.
const routeByType = (view) => {
  if (view.type === 'Major' && view.isPracticum === true) return { requiresRoom: false, lecHours: 0, labHours: 0, lectureMode: 'ON_CAMPUS' };
  if (view.type === 'Major') return { requiresRoom: true };
  if (view.type === 'Minor') return { requiresRoom: view.requiresRoom === true, lectureMode: 'ON_CAMPUS' };
  if (view.type === 'NSTP') return { requiresRoom: false, lectureMode: 'ON_CAMPUS' };
  return {};
};

// Returns an error message for an unschedulable subject, otherwise null. `view` is the whole subject
// (the stored record merged with the change), so a partial update is checked in full.
const validateCatalogSubject = (view, policy) => {
  if (!String(view.subjectCode ?? '').trim()) return 'Subject code is required.';
  if (!String(view.descriptiveTitle ?? '').trim()) return 'Descriptive title is required.';
  if (!SUBJECT_TYPES.includes(view.type)) return 'Subject type must be Major, Minor or NSTP.';
  if (view.isPracticum === true && view.type !== 'Major') return 'Only a Major can be a practicum (OJT) subject.';
  // A stored record without the field reads as on campus.
  if (view.lectureMode !== undefined && view.lectureMode !== null && !LECTURE_MODES.includes(view.lectureMode)) return LECTURE_MODE_MESSAGE;

  const units = Number(view.units ?? 3);
  const unitsError = (!Number.isInteger(units) || units < 1 || units > 12) ? 'Credit units must be a whole number between 1 and 12.' : null;
  // Practicum hours are not entered or checked: the routing above stores 0 / 0. Units are kept.
  if (view.isPracticum === true) return unitsError;

  const lec = Number(view.lecHours ?? 0);
  const lab = Number(view.labHours ?? 0);
  if (!isHalfStep(lec) || !isHalfStep(lab)) {
    return 'Lecture and laboratory hours must be whole or half hours (for example 2 or 1.5): classes are scheduled in half-hour steps.';
  }
  if (lec + lab <= 0) return 'A subject must carry at least one contact hour.';
  // Sanity cap from the Scheduling Policy on weekly lecture hours and on weekly lab hours. Longer
  // subjects are split into several meetings by the meeting rule; practicum subjects are exempt.
  const cap = policy.catalog.maxWeeklyHoursPerType;
  if (lec > cap || lab > cap) {
    return `Lecture hours and laboratory hours can each be at most ${cap} hours per week (Scheduling Policy). Check the hours entered.`;
  }
  // Minor and NSTP are lecture-only.
  if (view.type !== 'Major' && lab > 0) return `${view.type} subjects are lecture-only: laboratory hours must be 0.`;
  return unitsError;
};

exports.getCatalog = async (req, res, next) => {
  try {
    const subjects = await SubjectCatalog.find().sort({ subjectCode: 1, descriptiveTitle: 1 });
    res.status(200).json(subjects);
  } catch (err) {
    next(err);
  }
};

exports.createCatalogSubject = async (req, res, next) => {
  try {
    const payload = buildCatalogPayload(req.body);
    Object.assign(payload, routeByType(payload));
    const view = { lecHours: 0, labHours: 0, units: 3, ...payload };
    const error = validateCatalogSubject(view, await loadPolicy());
    if (error) return res.status(400).json({ success: false, message: error });

    // Phase 4 Part 4: the box "Needs a CCS room" is the Dean's on a subject the page creates, so a term
    // file's catalog change never changes it (scripts/load-term.js).
    const created = await SubjectCatalog.create({ ...view, isActive: payload.isActive ?? true, roomFlagSource: 'user' });
    res.status(201).json(created);
  } catch (err) {
    handleWriteError(err, res, next);
  }
};

exports.updateCatalogSubject = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Subject not found.' });
    const stored = await SubjectCatalog.findById(req.params.id).lean();
    if (!stored) return res.status(404).json({ success: false, message: 'Subject not found.' });

    const payload = buildCatalogPayload(req.body);
    // Routing and validation use the merged record, so a partial update is checked in full.
    Object.assign(payload, routeByType({ ...stored, ...payload }));
    const error = validateCatalogSubject({ ...stored, ...payload }, await loadPolicy());
    if (error) return res.status(400).json({ success: false, message: error });
    // Phase 4 Part 4: a change of "Needs a CCS room" from the page is the Dean's; a term file's catalog
    // change then leaves the box alone (scripts/load-term.js reads roomFlagSource).
    if (payload.requiresRoom !== undefined && Boolean(payload.requiresRoom) !== Boolean(stored.requiresRoom)) payload.roomFlagSource = 'user';

    // NSTP is a 1st Year subject, so it cannot become NSTP while placed in a later year. The check
    // and the write share one transaction that bumps placementRevision, the same document every
    // placement write bumps, so a placement in a later year cannot slip in between them.
    if (payload.type === 'NSTP' && stored.type !== 'NSTP') {
      const session = await mongoose.startSession();
      try {
        let updated = null;
        await session.withTransaction(async () => {
          await SubjectCatalog.updateOne({ _id: stored._id }, { $inc: { placementRevision: 1 } }, { session });
          const laterPlacement = await CurriculumMapping.findOne({ subject: stored._id, yearLevel: { $ne: '1st Year' } }).session(session).lean();
          if (laterPlacement) {
            throw new MappingRejection({
              status: 400,
              message: `NSTP is a 1st Year subject. Detach ${stored.subjectCode} from ${laterPlacement.program} ${laterPlacement.yearLevel} ${laterPlacement.semester} first.`
            });
          }
          updated = await SubjectCatalog.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true, session });
        });
        if (!updated) return res.status(404).json({ success: false, message: 'Subject not found.' });
        return res.status(200).json(updated);
      } catch (err) {
        if (err instanceof MappingRejection) return res.status(err.failure.status).json({ success: false, message: err.failure.message });
        throw err;
      } finally {
        await session.endSession();
      }
    }

    const updated = await SubjectCatalog.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Subject not found.' });
    res.status(200).json(updated);
  } catch (err) {
    handleWriteError(err, res, next);
  }
};

exports.toggleCatalogSubject = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Subject not found.' });
    const subject = await SubjectCatalog.findById(req.params.id).select('isActive');
    if (!subject) return res.status(404).json({ success: false, message: 'Subject not found.' });
    // A targeted update, so a status flip never re-validates the whole document.
    const updated = await SubjectCatalog.findByIdAndUpdate(req.params.id, { isActive: !subject.isActive }, { new: true });
    res.status(200).json({ message: 'Status toggled', isActive: updated.isActive });
  } catch (err) {
    next(err);
  }
};

// =========================================================================
// CURRICULUM BUILDER (CurriculumMapping)
// =========================================================================

const MAPPING_FILTERS = ['program', 'yearLevel', 'semester', 'track'];

const buildMappingPayload = (body = {}) => {
  const payload = {};
  for (const field of [...MAPPING_FILTERS, 'subject']) {
    if (body[field] !== undefined) payload[field] = typeof body[field] === 'string' ? body[field].trim() : body[field];
  }
  if (payload.track !== undefined) payload.track = String(payload.track || 'CORE').toUpperCase();
  return payload;
};

// A placement that repeats or overlaps an existing one would schedule the subject twice for the
// same sections: same subject, year, semester and track, and a program in common ('Both' overlaps
// BSIT and BSCS). Returns that mapping, or null.
const findOverlappingMapping = (view, excludeId = null, session = null) => {
  const programs = view.program === 'Both' ? ['BSIT', 'BSCS', 'Both'] : [view.program, 'Both'];
  return CurriculumMapping.findOne({
    subject: view.subject,
    yearLevel: view.yearLevel,
    semester: view.semester,
    track: view.track,
    program: { $in: programs },
    ...(excludeId ? { _id: { $ne: excludeId } } : {})
  }).session(session).lean();
};

// Checks a full mapping view; resolves to { status, message } on failure, otherwise null.
const checkMapping = async (view, excludeId = null, session = null) => {
  if (!SUBJECT_TRACKS.includes(view.track)) return { status: 400, message: 'Track must be CORE, WMAD, SMP, AMG or IS.' };
  if (!mongoose.isValidObjectId(view.subject)) return { status: 400, message: 'Choose a subject from the Master Catalog.' };
  const subject = await SubjectCatalog.findById(view.subject).session(session).lean();
  if (!subject) return { status: 404, message: 'That subject no longer exists in the Master Catalog.' };
  if (!subject.isActive) return { status: 400, message: `${subject.subjectCode} is disabled in the Master Catalog. Enable it before attaching it.` };
  const scopeError = validateMappingScope(view, subject);
  if (scopeError) return { status: 400, message: scopeError };
  const overlap = await findOverlappingMapping(view, excludeId, session);
  if (overlap) {
    const where = overlap.program === view.program ? 'this curriculum block' : `the ${overlap.program} block`;
    return {
      status: 409,
      message: `${subject.subjectCode} is already attached to ${where} (${overlap.yearLevel}, ${overlap.semester}, ${overlap.track}), which covers ${mappingPrograms(view.program).join(' and ')}.`
    };
  }
  return null;
};

// A check that fails inside the placement transaction; it aborts the transaction and is answered
// with its own status.
class MappingRejection extends Error {
  constructor(failure) {
    super(failure.message);
    this.failure = failure;
  }
}

// Every placement write runs in a transaction that first bumps the subject's placementRevision. Two
// concurrent placements of the same subject therefore write the same catalog document: all but one
// abort and are retried by withTransaction, and each retry sees the committed placement, so the
// overlap check answers 409 instead of storing a duplicate. No unique index is involved, so this can
// never surface as an E11000 error. `viewOf` is the mapping to write, or a function that builds it
// from a read inside the transaction (an update re-reads the stored mapping there, so a concurrent
// change is never overwritten from a stale copy). Resolves to { result } or { failure: { status, message } }.
const writeMapping = async (viewOf, excludeId, write) => {
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      const view = typeof viewOf === 'function' ? await viewOf(session) : viewOf;
      if (!view) throw new MappingRejection({ status: 404, message: 'Curriculum mapping not found.' });
      if (!SUBJECT_TRACKS.includes(view.track)) throw new MappingRejection({ status: 400, message: 'Track must be CORE, WMAD, SMP, AMG or IS.' });
      if (!mongoose.isValidObjectId(view.subject)) throw new MappingRejection({ status: 400, message: 'Choose a subject from the Master Catalog.' });
      await SubjectCatalog.updateOne({ _id: view.subject }, { $inc: { placementRevision: 1 } }, { session });
      const failure = await checkMapping(view, excludeId, session);
      if (failure) throw new MappingRejection(failure);
      result = await write(session);
    });
    return { result };
  } catch (err) {
    if (err instanceof MappingRejection) return { failure: err.failure };
    throw err;
  } finally {
    await session.endSession();
  }
};

exports.getMappings = async (req, res, next) => {
  try {
    const query = {};
    for (const field of MAPPING_FILTERS) {
      if (typeof req.query[field] === 'string' && req.query[field].trim()) query[field] = req.query[field].trim();
    }
    if (typeof req.query.subject === 'string' && mongoose.isValidObjectId(req.query.subject)) query.subject = req.query.subject;
    const mappings = await CurriculumMapping.find(query).populate('subject').sort({ createdAt: 1 });
    res.status(200).json(mappings);
  } catch (err) {
    next(err);
  }
};

exports.createMapping = async (req, res, next) => {
  try {
    const view = { track: 'CORE', ...buildMappingPayload(req.body) };
    const { failure, result: created } = await writeMapping(view, null, async (session) => {
      const [doc] = await CurriculumMapping.create([view], { session });
      return doc;
    });
    if (failure) return res.status(failure.status).json({ success: false, message: failure.message });
    await created.populate('subject');
    res.status(201).json(created);
  } catch (err) {
    handleWriteError(err, res, next);
  }
};

exports.updateMapping = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Curriculum mapping not found.' });
    const payload = buildMappingPayload(req.body);
    const viewOf = async (session) => {
      const stored = await CurriculumMapping.findById(req.params.id).session(session).lean();
      return stored ? { ...stored, ...payload } : null;
    };
    const { failure, result: updated } = await writeMapping(viewOf, req.params.id, (session) =>
      CurriculumMapping.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true, session }));
    if (failure) return res.status(failure.status).json({ success: false, message: failure.message });
    if (!updated) return res.status(404).json({ success: false, message: 'Curriculum mapping not found.' });
    await updated.populate('subject');
    res.status(200).json(updated);
  } catch (err) {
    handleWriteError(err, res, next);
  }
};

exports.deleteMapping = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: 'Curriculum mapping not found.' });
    const deleted = await CurriculumMapping.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'Curriculum mapping not found.' });
    res.status(200).json({ success: true, id: deleted._id });
  } catch (err) {
    next(err);
  }
};
