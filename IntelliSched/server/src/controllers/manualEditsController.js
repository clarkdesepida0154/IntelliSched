// The Dean's manual edits in a Draft, from the Schedule Views & Editor (Phase 4 Part 2): checked live
// and saved only when they cause no conflict the Draft does not already have, without generating again.
//
//   POST /schedule/change-professor/check  { scheduleId, sectionId, subjectId[, facultyRef | null] }
//       The verdict for one professor (facultyRef; null = TBA, Minors only), or, without facultyRef, for
//       every active professor (and TBA for a Minor): plain words such as "Free at these times",
//       "Clashes with ITEP 204 (BSIT 2A), Monday 8:00–10:00 AM", "Unavailable on Monday 8:00 AM–12:00 PM",
//       "Over the teaching cap: 22.5 of 21 hours", "No lunch hour on Tuesday". Saves nothing.
//   POST /schedule/change-professor        { scheduleId, sectionId, subjectId, facultyRef | null, reason?, mlTop1Faculty?, mlTop1Score?, telemetry? }
//       Runs the same checks again and, when they pass, changes the professor of every meeting of that
//       subject for that section (lecture and lab together, as Assign Faculty stores it) AND the term's
//       assignment, through the same path as Assign Faculty (orchestratorController.applyAssignment): a
//       replaced professor logs an 'override' decision that Engine 4 learns from. A faculty decision
//       (faculty.assign). The whole Draft is checked again and lastCheck kept.
//   POST /schedule/swap/check              { scheduleId, itemA, itemB }
//       The two classes exchange their day, start and room; if that breaks a room rule, each keeps its own
//       room. The verdict in plain words with both new places. Saves nothing.
//   POST /schedule/swap                    { scheduleId, itemA, itemB }
//       The same check, then both classes moved; one audit row. A schedule edit (schedule.move), never a
//       decision Engine 4 learns from.
// All four work only in a Draft (409 READ_ONLY_VERSION otherwise, as moves do). The checks are the
// gateway validator's own (utils/versionCheck.js checkScheduleVersion: the shared hard rules, the room
// rules, the lunch rule, the teaching cap with the lab factor), never a second copy of the rules; only
// the conflicts an edit ADDS count (utils/versionCheck.js newViolations).
const mongoose = require('mongoose');
const MotherSchedule = require('../models/MotherSchedule');
const SubjectCatalog = require('../models/SubjectCatalog');
const Section = require('../models/Section');
const Facility = require('../models/Facility');
const Faculty = require('../models/Faculty');
const AuditEvent = require('../models/AuditEvent');
const { checkScheduleVersion, loadVersionInputs, newViolations, LEGACY_READ_ONLY, NOT_IN_TERM, shownStatus } = require('../utils/versionCheck');
const { isExtraRoomKey, extraRoomName } = require('../utils/gaRequest');
const { extraRoomUse, resultCounts, isLegacySchedule, noRoomName } = require('../utils/scheduleItems');
const { SOFT_TERMS } = require('../utils/constraints');
const { findTermLockSource } = require('../utils/termInputs');
const { timeOfSlot, formatTime12, toMinutes } = require('../utils/timeGrid');
// Phase 8 Part 4 (decision 4): a checked edit sees the Extension day as unavailable time.
const { schedulingUnavailableBlocks } = require('../utils/facultyAvailability');
const { sectionLabelOf } = require('../utils/scheduleOutputs');
const { actorOf } = require('../utils/actor');
const orchestrator = require('./orchestratorController');

const { plainMessage } = require('../utils/messages');
// The page gets plain words; the raw error goes to the server log (utils/messages.js, Phase 4 Part 4).
const getSanitizedMessage = (err, fallback) => plainMessage(err, fallback, { label: '[Manual edits]' });

// ------------------------------------------------------------------------------------ words
// "8:00–10:00 AM", or "11:00 AM–1:00 PM" when the two ends differ in AM/PM (display only).
const rangeWords = (start, end) => {
  const a = formatTime12(start);
  const b = formatTime12(end);
  const [aTime, aMeridiem] = a.split(' ');
  return aMeridiem === b.split(' ')[1] ? `${aTime}–${b}` : `${a}–${b}`;
};
const whenWords = (place) => `${place.day} ${rangeWords(place.startTime, place.endTime)}`;
const classLabel = (item) => `${item.subjectCode} (${item.section})`;
const typeWord = (type) => ({ LEC: 'lecture', LAB: 'lab', ACTIVITY: 'activity' }[type] || 'class');
const roomKeyOf = (item) => item.extraRoomKey || (item.roomId ? String(item.roomId) : null);
const idText = (value) => (value === null || value === undefined ? null : String(value));

// A room as the Dean reads it: the room's name, a TBA room by its TBA name, "no room" or "online".
const tbaRoomWords = (key) => {
  const m = /^EXTRA-(LAB|LEC)-(\d+)$/.exec(key || '');
  return m ? `TBA room ${m[2]} (${m[1] === 'LAB' ? 'lab' : 'lecture'})` : 'TBA room';
};
const roomWords = (key, item, facilities) => {
  if (!key) return item.isOnline === true ? 'online' : 'no room';
  if (isExtraRoomKey(key)) return tbaRoomWords(key);
  const facility = facilities.find(f => String(f._id) === String(key));
  return facility?.roomName || (roomKeyOf(item) === key ? item.roomName : null) || 'the chosen room';
};

// The read-only refusal, worded for the edit (the move's words live in utils/versionCheck.js). An
// Approved version is final (Phase 8 Part 6; one stored as Published reads as Approved).
const readOnlyMessage = (stored, what) => {
  const status = shownStatus(stored);
  return status === 'Approved'
    ? `This version is Approved: ${what}. Restore it to make a new Draft.`
    : `This version is ${status || 'not a Draft'}: ${what}. Open a Draft first.`;
};
const WHAT = { professor: "the professor can't be changed", swap: "classes can't be swapped" };
// A stored class whose (section, subject) pair is no longer one of the term's has no demand for the
// validator to judge, so no edit of it is saved (NOT_IN_TERM, utils/versionCheck.js; the move route
// refuses it with the same words).

// The rules a swap retries without exchanging rooms when they break.
const ROOM_RULES = new Set(['HC2_ROOM_TYPE', 'HC3_ROOM_CLASH', 'HC4_ROOM_UNAVAILABLE', 'HC6_CAPACITY']);

// ------------------------------------------------------------------------------------ loading
// The Draft an edit works on: { doc }, or { status, body } to answer with. Only a Draft (schemaVersion 2).
const loadDraft = async (scheduleId, what, session = null) => {
  if (!mongoose.isValidObjectId(scheduleId)) return { status: 400, body: { success: false, message: 'Choose a schedule version first.' } };
  const query = MotherSchedule.findById(scheduleId);
  const doc = await (session ? query.session(session) : query);
  if (!doc) return { status: 404, body: { success: false, message: 'That schedule version no longer exists. Reload the page.' } };
  if (isLegacySchedule(doc)) return { status: 409, body: { success: false, legacy: true, code: 'LEGACY_VERSION', message: LEGACY_READ_ONLY } };
  if (doc.status !== 'Draft') return { status: 409, body: { success: false, code: 'READ_ONLY_VERSION', message: readOnlyMessage(doc.status, what) } };
  return { doc };
};

// One (section, subject) pair of the Draft: its classes, its catalog subject and section, its kind
// (MAJOR | MINOR), who teaches it now, the meetings that would change and their words.
const loadPair = async (doc, sectionId, subjectId, session = null) => {
  if (!mongoose.isValidObjectId(sectionId) || !mongoose.isValidObjectId(subjectId)) {
    return { status: 400, body: { success: false, message: 'Choose the class whose professor to change.' } };
  }
  const items = (doc.scheduleData || []).filter(i => idText(i.sectionId) === String(sectionId) && idText(i.subjectId) === String(subjectId));
  const subjectQuery = SubjectCatalog.findById(subjectId);
  const sectionQuery = Section.findById(sectionId);
  const [subject, section] = await Promise.all([session ? subjectQuery.session(session) : subjectQuery, session ? sectionQuery.session(session) : sectionQuery]);
  // What the subject is comes first: a practicum (one coordinator) and a self-paced lecture have no
  // class on the grid, and NSTP's professor is always TBA.
  const kind = subject ? orchestrator.lockKindOf(subject) : null;
  if (kind === 'NSTP') return { status: 400, body: { success: false, message: `${subject.subjectCode} is NSTP: its professor is always TBA.` } };
  if (kind === 'PRACTICUM') return { status: 400, body: { success: false, message: `${subject.subjectCode} is a practicum: its coordinator is assigned on Assign Faculty.` } };
  if (!items.length) {
    const selfPaced = (doc.unscheduledItems || []).some(u => u.kind === 'SELF_PACED' && idText(u.sectionId) === String(sectionId) && idText(u.subjectId) === String(subjectId));
    return { status: selfPaced ? 400 : 404, body: { success: false, message: selfPaced ? `${subject?.subjectCode || 'This subject'} is held online, self-paced: it has no class on the grid. Assign its professor on Assign Faculty.` : 'That class is not in this schedule version. Reload the page and try again.' } };
  }
  if (!subject) return { status: 404, body: { success: false, message: `${items[0].subjectCode} is no longer in the Master Catalog, so its professor cannot be changed here.` } };
  const sectionCode = section?.sectionCode || items[0].section;
  const sectionLabel = sectionLabelOf(sectionCode, section?.track);
  const currentRef = idText(items[0].facultyRef);
  const meetings = items.map(i => ({
    itemId: String(i._id), type: i.type, day: i.day, startTime: i.startTime, endTime: i.endTime, roomName: i.roomName,
    words: `the ${typeWord(i.type)} on ${i.day}`
  }));
  return {
    pair: {
      kind,
      subject,
      section: section || { _id: sectionId, sectionCode },
      sectionCode,
      sectionLabel,
      items,
      demandIds: new Set(items.map(i => i.demandId).filter(Boolean)),
      ids: { sectionId: String(sectionId), subjectId: String(subjectId), sectionCode, subjectCode: subject.subjectCode },
      current: { facultyRef: currentRef, facultyId: currentRef ? items[0].facultyId : 'TBA', name: currentRef ? items[0].facultyName : 'TBA' },
      meetings,
      changeText: `${subject.subjectCode} for ${sectionLabel}: ${meetings.map(m => m.words).join(' and ')}`
    }
  };
};

// ------------------------------------------------------------------------------------ the verdicts
// The classes as they would sit after the edit: demand id -> { day, startTime, endTime, subjectCode,
// section, demandId }, moved ones at their new place. Used to word the conflicts.
const placesAfter = (doc, moves, policy) => {
  const byItem = new Map((moves || []).map(m => [String(m.itemId), m]));
  const placed = new Map();
  for (const item of doc.scheduleData || []) {
    if (!item.demandId) continue;
    const move = byItem.get(String(item._id));
    placed.set(item.demandId, move
      ? { ...item.toObject?.() ?? item, day: move.day, startTime: timeOfSlot(policy, move.startSlot), endTime: timeOfSlot(policy, move.startSlot + item.durationSlots) }
      : item);
  }
  return placed;
};

// One added conflict in the Dean's words. ctx: { placed, editedDemandIds, unavailable (the professor's
// blocks, "HH:MM"), policy }.
const conflictWords = (v, ctx) => {
  const places = (v.demandIds || []).map(id => ctx.placed.get(id)).filter(Boolean);
  const edited = places.find(p => ctx.editedDemandIds.has(p.demandId)) || places[0] || null;
  const other = places.find(p => !ctx.editedDemandIds.has(p.demandId)) || null;
  // A clash between the two classes of a swap names them both.
  const between = places.length === 2 && !other ? `${classLabel(places[0])} and ${classLabel(places[1])} would overlap on ${places[0].day}` : null;
  switch (v.code) {
    case 'HC3_FACULTY_CLASH':
    case 'HC3_SECTION_CLASH':
      return other ? `Clashes with ${classLabel(other)}, ${whenWords(other)}` : between || v.message;
    case 'HC3_ROOM_CLASH':
      return other ? `The room is taken by ${classLabel(other)}, ${whenWords(other)}` : between ? `${between} in the same room` : v.message;
    case 'HC4_FACULTY_UNAVAILABLE': {
      const block = edited && ctx.unavailable.find(b => b.day === edited.day
        && toMinutes(b.start) < toMinutes(edited.endTime) && toMinutes(edited.startTime) < toMinutes(b.end));
      return block ? `Unavailable on ${block.day} ${rangeWords(block.start, block.end)}` : `Unavailable on ${edited?.day || 'that day'}`;
    }
    case 'HC1_LUNCH': {
      const day = edited?.day || 'that day';
      return /^Section /.test(v.message) ? `${edited?.section || 'The section'} would have no lunch hour on ${day}` : `No lunch hour on ${day}`;
    }
    case 'HC5_TEACHING_CAP':
      return `Over the teaching cap: ${v.teaching} of ${v.cap} hours`;
    case 'HC9_LAB_START': {
      const starts = (ctx.policy.meetings?.labStartTimes || []).map(formatTime12);
      return edited
        ? `The lab ${classLabel(edited)} can't start at ${formatTime12(edited.startTime)}: labs start at ${starts.join(', ')}`
        : v.message;
    }
    case 'HC7_SAME_DAY':
      return edited ? `${classLabel(edited)} would meet twice on ${edited.day}` : v.message;
    case 'HC8_WINDOW':
      return edited ? `${classLabel(edited)} would not fit inside the ${edited.day} class hours` : v.message;
    case 'HC4_DAY_NOT_ALLOWED':
      return edited ? `${classLabel(edited)} can't be held on ${edited.day}` : v.message;
    // Phase 8 Part 6 (decision 5c): a part-timer left with one class on a weekday.
    case 'HC10_PART_TIMER_SINGLE_DAY':
      return `${v.name || 'A part-time professor'} would have only one class on ${v.day}${places[0] ? ` (${classLabel(places[0])})` : ''}`;
    default:
      return v.message;
  }
};

const uniqueWords = (violations, ctx) => [...new Set(violations.map(v => conflictWords(v, ctx)))];

// The verdict for one candidate professor (a Faculty record, or null for TBA) on a pair:
// { ok, same?, reasons, after? }. The teaching cap, the clashes, the professor's unavailable times and
// the lunch rule all come from the validator (the one set of rules, with the one load function).
const professorVerdict = async ({ doc, inputs, baseline, pair, candidate }) => {
  if (candidate && candidate.isActive === false) {
    return { ok: false, reasons: [`${candidate.name} is disabled. Enable the profile on the Faculty page first.`] };
  }
  if (candidate && (!Faculty.EMPLOYMENT_TYPES.includes(candidate.employmentType) || !Number.isFinite(candidate.teachingCapHours))) {
    return { ok: false, reasons: [`${candidate.name} has no employment type or teaching cap yet. Set both on the Faculty page first.`] };
  }
  const ref = candidate ? String(candidate._id) : null;
  if (ref === pair.current.facultyRef) {
    return { ok: false, same: true, reasons: [candidate ? `${candidate.name} already teaches this class.` : 'This class is already TBA.'] };
  }
  if (!ref && pair.kind !== 'MINOR') return { ok: false, reasons: ['A Major class needs a professor.'] };
  if (pair.items.some(i => !i.demandId || !baseline.demandIds.has(i.demandId))) return { ok: false, reasons: [NOT_IN_TERM] };
  const after = await checkScheduleVersion(doc, { facultyChanges: [{ ...pair.ids, facultyRef: ref }] }, inputs);
  const added = newViolations(baseline, after).filter(v => (v.demandIds || []).some(id => pair.demandIds.has(id))
    || (v.code === 'HC5_TEACHING_CAP' && ref && String(v.facultyRef) === ref));
  const ctx = { placed: placesAfter(doc, [], after.policy), editedDemandIds: pair.demandIds, unavailable: candidate ? schedulingUnavailableBlocks(candidate, after.policy) : [], policy: after.policy };
  const reasons = uniqueWords(added, ctx);
  return { ok: reasons.length === 0, reasons, after };
};

const verdictRow = (candidate, verdict) => ({
  facultyRef: candidate ? String(candidate._id) : null,
  facultyId: candidate?.facultyId || null,
  name: candidate?.name || 'TBA',
  employmentType: candidate?.employmentType || null,
  position: candidate?.position || null,
  ok: verdict.ok,
  same: Boolean(verdict.same),
  text: verdict.ok ? 'Free at these times' : verdict.reasons.join('; '),
  reasons: verdict.reasons
});

const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en');

// Whether this Draft holds the term's assignments (findTermLockSource): the professor is changed only
// there, so the term's assignments and the schedule can never disagree.
const newestDraftProblem = async (doc, session = null) => {
  const source = await findTermLockSource({ academicYear: doc.academicYear, semester: doc.semester }, session);
  if (source && String(source._id) === String(doc._id)) return null;
  if (source && source.status !== 'Draft') {
    return `The term's assignments are held by ${source.version || 'a newer version'} (${source.status}), not by this Draft. Assign the professor on Assign Faculty, which starts a new Draft from that version.`;
  }
  return `The professor can be changed only in the newest Draft${source?.version ? ` (${source.version})` : ''}, which holds the term's assignments, so the assignments and the schedule stay the same. Open the newest Draft.`;
};

// The run's recorded numbers follow the version as it is now (as a move does; the run's own numbers
// stay in generation_runs).
const refreshGaStats = (doc, check) => {
  if (!doc.gaStats) return;
  const items = doc.scheduleData.map(i => (i.toObject ? i.toObject() : i));
  doc.gaStats = {
    ...doc.gaStats,
    extraRoomUse: extraRoomUse(items),
    ...resultCounts(items),
    softBreakdown: Object.fromEntries(SOFT_TERMS.map(t => [t, check.soft[t]])),
    softTotal: check.soft.total,
    softCounts: check.softCounts,
    editedAfterRun: (Number(doc.gaStats.editedAfterRun) || 0) + 1
  };
  doc.markModified('gaStats');
};

const lastCheckOf = (check, checkedAt, actor) => ({ checkedAt, hardTotal: check.violationCount, violationCount: check.violations.length, by: actor });

// ------------------------------------------------------------------------------------ change professor
exports.checkProfessorChange = async (req, res) => {
  try {
    const body = req.body || {};
    const loaded = await loadDraft(body.scheduleId, WHAT.professor);
    if (!loaded.doc) return res.status(loaded.status).json(loaded.body);
    const doc = loaded.doc;
    const pairInfo = await loadPair(doc, body.sectionId, body.subjectId);
    if (!pairInfo.pair) return res.status(pairInfo.status).json(pairInfo.body);
    const { pair } = pairInfo;

    const notNewest = await newestDraftProblem(doc);
    const inputs = await loadVersionInputs(doc);
    const baseline = await checkScheduleVersion(doc, null, inputs);

    let candidates;
    if ('facultyRef' in body) {
      if (body.facultyRef === null || body.facultyRef === '') candidates = [null];
      else {
        if (!mongoose.isValidObjectId(body.facultyRef)) return res.status(400).json({ success: false, message: 'Choose a professor from the list.' });
        const one = await Faculty.findById(body.facultyRef);
        if (!one) return res.status(404).json({ success: false, message: 'That professor no longer exists. Reload the page.' });
        candidates = [one];
      }
    } else {
      candidates = [...(pair.kind === 'MINOR' ? [null] : []), ...[...inputs.faculty].sort(byName)];
    }
    const verdicts = [];
    for (const candidate of candidates) {
      verdicts.push(verdictRow(candidate, await professorVerdict({ doc, inputs, baseline, pair, candidate })));
    }
    res.status(200).json({
      success: true,
      scheduleId: String(doc._id),
      version: doc.version,
      newestDraft: !notNewest,
      ...(notNewest ? { notNewestMessage: notNewest } : {}),
      pair: { ...pair.ids, sectionLabel: pair.sectionLabel, kind: pair.kind, current: pair.current },
      meetings: pair.meetings,
      changeText: pair.changeText,
      tbaAllowed: pair.kind === 'MINOR',
      verdicts
    });
  } catch (err) {
    console.error('[Manual Edits - Change Professor Check]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The professors could not be checked. Try again.') });
  }
};

exports.changeProfessor = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const refuse = async (status, body) => {
    await session.abortTransaction();
    return res.status(status).json(body);
  };
  try {
    const body = req.body || {};
    const loaded = await loadDraft(body.scheduleId, WHAT.professor, session);
    if (!loaded.doc) return await refuse(loaded.status, loaded.body);
    const doc = loaded.doc;
    const notNewest = await newestDraftProblem(doc, session);
    if (notNewest) return await refuse(409, { success: false, code: 'NOT_NEWEST_DRAFT', message: `${notNewest} Nothing was saved.` });
    const pairInfo = await loadPair(doc, body.sectionId, body.subjectId, session);
    if (!pairInfo.pair) return await refuse(pairInfo.status, pairInfo.body);
    const { pair } = pairInfo;

    const facultyRef = body.facultyRef === undefined || body.facultyRef === '' ? null : body.facultyRef;
    if (facultyRef !== null && !mongoose.isValidObjectId(facultyRef)) return await refuse(400, { success: false, message: 'Choose a professor from the list.' });
    if (facultyRef === null && pair.kind !== 'MINOR') return await refuse(400, { success: false, message: `${pair.subject.subjectCode} is a Major: it needs a professor. Choose one.` });
    const candidate = facultyRef ? await Faculty.findById(facultyRef).session(session) : null;
    if (facultyRef && !candidate) return await refuse(404, { success: false, message: 'That professor no longer exists. Reload the page.' });

    const inputs = await loadVersionInputs(doc);
    const baseline = await checkScheduleVersion(doc, null, inputs);
    const verdict = await professorVerdict({ doc, inputs, baseline, pair, candidate });
    const who = candidate ? candidate.name : 'TBA';
    if (!verdict.ok) {
      return await refuse(verdict.same ? 400 : 409, {
        success: false,
        code: verdict.same ? 'NO_CHANGE' : 'CHANGE_REFUSED',
        message: verdict.same ? `${verdict.reasons[0]} Nothing was saved.` : `${who} can't take ${pair.subject.subjectCode} (${pair.sectionLabel}): ${verdict.reasons.join('; ')}. Nothing was saved.`,
        reasons: verdict.reasons
      });
    }

    const actor = actorOf(req);
    const now = new Date();
    const term = { academicYear: doc.academicYear, semester: doc.semester };
    const reasonText = String(body.reason ?? '').trim();

    // 1. Every meeting of the subject for the section (and its unscheduled item, a self-paced lecture).
    for (const item of pair.items) {
      item.facultyRef = candidate ? candidate._id : undefined;
      item.facultyId = candidate ? candidate.facultyId : 'TBA';
      item.facultyName = candidate ? candidate.name : 'TBA';
    }
    for (const u of doc.unscheduledItems || []) {
      if (idText(u.sectionId) === pair.ids.sectionId && idText(u.subjectId) === pair.ids.subjectId) u.facultyRef = candidate ? candidate._id : null;
    }

    // 2. The term's assignment, through Assign Faculty's own path: the lock and, for a Major that had a
    //    professor, the 'override' decision row Engine 4 learns from (its facts from the Faculty records).
    const pairs = await orchestrator.loadTermPairs(doc.semester);
    const replaced = pair.current.facultyRef && mongoose.isValidObjectId(pair.current.facultyRef)
      ? await Faculty.findById(pair.current.facultyRef).session(session)
      : null;
    let lock = null;
    if (candidate) {
      const hadProfessor = Boolean(pair.current.facultyRef);
      const isDecision = pair.kind === 'MAJOR' && hadProfessor;
      lock = await orchestrator.applyAssignment({
        draft: doc,
        session,
        term,
        cleanSubject: pair.subject.subjectCode,
        cleanSection: pair.sectionCode,
        section: pair.section,
        lockedSubject: pair.subject,
        classType: 'ALL',
        kind: pair.kind,
        cleanFacultyId: candidate.facultyId,
        lockedFaculty: candidate,
        facultyName: candidate.name,
        units: pair.subject.units,
        isDecision,
        facultyChanged: isDecision && String(pair.current.facultyId) !== String(candidate.facultyId),
        originalFacultyId: hadProfessor ? pair.current.facultyId : undefined,
        rejectedFaculty: replaced,
        mlTop1Faculty: body.mlTop1Faculty,
        mlTop1Score: body.mlTop1Score,
        reason: reasonText ? `Changed in the Schedule Views & Editor: ${reasonText}` : 'Changed in the Schedule Views & Editor',
        telemetry: body.telemetry,
        selected: orchestrator.buildFacultyTelemetry(candidate, doc, pairs),
        rejected: orchestrator.buildFacultyTelemetry(replaced, doc, pairs),
        actor,
        now,
        lockedBy: req.user?.name || 'Dean'
      });
    } else {
      // A Minor back to TBA: its lock released, as "Release assignment" does on Assign Faculty, and the
      // decision rows of that lock taken back.
      const isTarget = (l) => l.sectionCode === pair.sectionCode && (l.subjectId ? idText(l.subjectId) === pair.ids.subjectId : l.subjectCode === pair.subject.subjectCode);
      const released = doc.lockedAssignments.filter(isTarget);
      doc.lockedAssignments = doc.lockedAssignments.filter(l => !isTarget(l));
      // Older Drafts of the term hold copies of the lock (every run carries the locks forward); they are
      // released too, as Assign Faculty's release does, written without touching their updatedAt.
      const olderDrafts = await MotherSchedule.find({ academicYear: term.academicYear, semester: Number(term.semester), status: 'Draft', _id: { $ne: doc._id }, schemaVersion: { $gte: 2 } })
        .select('lockedAssignments').session(session);
      for (const older of olderDrafts) {
        const releasedHere = older.lockedAssignments.filter(isTarget);
        if (!releasedHere.length) continue;
        released.push(...releasedHere);
        await MotherSchedule.updateOne({ _id: older._id }, { $set: { lockedAssignments: older.lockedAssignments.filter(l => !isTarget(l)) } }, { session, timestamps: false });
      }
      if (released.length) {
        await orchestrator.retractDecisionRows({
          term, current: doc, session, sectionCode: pair.sectionCode, subjectId: pair.ids.subjectId, subjectCode: pair.subject.subjectCode,
          since: Math.min(...released.map(l => new Date(l.lockedAt || 0).getTime()))
        });
      }
      await AuditEvent.create([{
        action: 'lock-release',
        category: 'Assignments',
        target: `${pair.subject.subjectCode} (${pair.sectionCode})`,
        detail: `Assignment to ${pair.current.name} released in the Schedule Views & Editor; the class is TBA until someone is assigned.`,
        term: { academicYear: String(term.academicYear), semester: Number(term.semester) },
        actor,
        at: now
      }], { session });
    }

    // 3. The whole Draft as it is now: the check kept on it, the run's numbers refreshed.
    const after = verdict.after;
    doc.lastCheck = lastCheckOf(after, now, actor);
    refreshGaStats(doc, after);
    await doc.save({ session });
    await session.commitTransaction();

    const message = candidate
      ? `${pair.subject.subjectCode} (${pair.sectionLabel}) is now taught by ${candidate.name}: ${pair.meetings.map(m => m.words).join(' and ')}. Times and rooms stay the same.`
      : `${pair.subject.subjectCode} (${pair.sectionLabel}) is now TBA: ${pair.meetings.map(m => m.words).join(' and ')}. Times and rooms stay the same.`;
    res.status(200).json({
      success: true,
      message,
      scheduleId: String(doc._id),
      pair: { ...pair.ids, sectionLabel: pair.sectionLabel, kind: pair.kind },
      professor: candidate ? { facultyRef: String(candidate._id), facultyId: candidate.facultyId, name: candidate.name } : null,
      meetings: pair.meetings,
      lock,
      locks: doc.lockedAssignments,
      lastCheck: { checkedAt: now.toISOString(), hardTotal: after.violationCount, violationCount: after.violations.length }
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Manual Edits - Change Professor]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The professor could not be changed. Try again.') });
  } finally {
    session.endSession();
  }
};

// ------------------------------------------------------------------------------------ swap two classes
// The two classes of a swap: { a, b }, or { status, body }.
const parseSwap = (doc, body) => {
  const find = (id) => (mongoose.isValidObjectId(id) ? (doc.scheduleData || []).find(i => String(i._id) === String(id)) : null);
  const a = find(body.itemA);
  const b = find(body.itemB);
  if (!a || !b) return { status: 404, body: { success: false, message: 'Choose two classes of this schedule version. Reload the page and try again.' } };
  if (String(a._id) === String(b._id)) return { status: 400, body: { success: false, message: 'Choose two different classes to swap.' } };
  const fixed = [a, b].find(i => i.isFixed);
  if (fixed) return { status: 400, body: { success: false, message: `${classLabel(fixed)} is fixed by the Scheduling Policy (the NSTP block) and cannot be swapped.` } };
  return { a, b };
};

// The plan and verdict of a swap: the classes exchange day, start and room; when that breaks a room rule
// (and the rooms differ), each keeps its own room. { ok, kind, moves, places, reasons, after, swapText }.
const planSwap = async (doc, a, b, inputs) => {
  const baseline = await checkScheduleVersion(doc, null, inputs);
  if ([a, b].some(i => !i.demandId || !baseline.demandIds.has(i.demandId))) {
    const notInTerm = [a, b].filter(i => !i.demandId || !baseline.demandIds.has(i.demandId)).map(classLabel).join(' and ');
    return { ok: false, kind: 'rooms-exchanged', moves: [], places: null, reasons: [`${notInTerm}: ${NOT_IN_TERM}`], after: baseline, swapText: '', roomText: '' };
  }
  const movesOf = (exchangeRooms) => [
    { itemId: String(a._id), day: b.day, startSlot: b.startSlot, roomId: exchangeRooms ? roomKeyOf(b) : roomKeyOf(a) },
    { itemId: String(b._id), day: a.day, startSlot: a.startSlot, roomId: exchangeRooms ? roomKeyOf(a) : roomKeyOf(b) }
  ];
  const ids = new Set([String(a._id), String(b._id)]);
  const evaluate = async (kind, moves) => {
    const after = await checkScheduleVersion(doc, { moves }, inputs);
    const added = newViolations(baseline, after).filter(v => (v.itemIds || []).some(id => ids.has(id)));
    return { kind, moves, after, added };
  };
  let plan = await evaluate('rooms-exchanged', movesOf(true));
  if (plan.added.some(v => ROOM_RULES.has(v.code)) && roomKeyOf(a) !== roomKeyOf(b)) {
    plan = await evaluate('rooms-kept', movesOf(false));
  }
  const demandIds = new Set([a.demandId, b.demandId].filter(Boolean));
  const placed = placesAfter(doc, plan.moves, plan.after.policy);
  const unavailable = [a, b].flatMap(i => (i.facultyRef ? schedulingUnavailableBlocks(inputs.faculty.find(f => String(f._id) === String(i.facultyRef)) || null, plan.after.policy) : []));
  const reasons = uniqueWords(plan.added, { placed, editedDemandIds: demandIds, unavailable, policy: plan.after.policy });
  const placeOf = (item, move) => ({
    itemId: String(item._id),
    subjectCode: item.subjectCode,
    section: item.section,
    type: item.type,
    day: move.day,
    startSlot: move.startSlot,
    startTime: timeOfSlot(plan.after.policy, move.startSlot),
    endTime: timeOfSlot(plan.after.policy, move.startSlot + item.durationSlots),
    roomKey: move.roomId,
    roomWords: roomWords(move.roomId, item, inputs.facilities)
  });
  const places = { a: placeOf(a, plan.moves[0]), b: placeOf(b, plan.moves[1]) };
  const moveWords = (p) => `${p.subjectCode} (${p.section}) moves to ${whenWords(p)}, ${p.roomWords}`;
  return {
    ok: reasons.length === 0,
    kind: plan.kind,
    moves: plan.moves,
    places,
    reasons,
    after: plan.after,
    swapText: `${moveWords(places.a)}; ${moveWords(places.b)}.`,
    roomText: plan.kind === 'rooms-exchanged' ? 'The rooms are exchanged too.' : 'Each class keeps its own room.'
  };
};

const planBody = (doc, plan) => ({
  success: true,
  scheduleId: String(doc._id),
  version: doc.version,
  ok: plan.ok,
  plan: plan.kind,
  places: plan.places,
  text: plan.ok ? `${plan.swapText} ${plan.roomText}` : plan.reasons.join('; '),
  reasons: plan.reasons,
  swapText: plan.swapText,
  roomText: plan.roomText
});

exports.checkSwap = async (req, res) => {
  try {
    const body = req.body || {};
    const loaded = await loadDraft(body.scheduleId, WHAT.swap);
    if (!loaded.doc) return res.status(loaded.status).json(loaded.body);
    const doc = loaded.doc;
    const parsed = parseSwap(doc, body);
    if (!parsed.a) return res.status(parsed.status).json(parsed.body);
    const inputs = await loadVersionInputs(doc);
    const plan = await planSwap(doc, parsed.a, parsed.b, inputs);
    res.status(200).json(planBody(doc, plan));
  } catch (err) {
    console.error('[Manual Edits - Swap Check]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The swap could not be checked. Try again.') });
  }
};

// Puts one class at a move's place (as the editor's move does): day, start, room and the stored names.
const placeItem = async (item, move, policy, session) => {
  const extraKey = isExtraRoomKey(move.roomId) ? move.roomId : null;
  const room = move.roomId && !extraKey ? await Facility.findById(move.roomId).session(session) : null;
  item.day = move.day;
  item.startSlot = move.startSlot;
  item.roomId = room ? room._id : undefined;
  item.extraRoomKey = extraKey || undefined;
  item.roomName = room ? room.roomName : extraKey ? extraRoomName(extraKey) : noRoomName(item.isOnline === true);
  item.startTime = timeOfSlot(policy, move.startSlot);
  item.endTime = timeOfSlot(policy, move.startSlot + item.durationSlots);
};

exports.swapClasses = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  const refuse = async (status, body) => {
    await session.abortTransaction();
    return res.status(status).json(body);
  };
  try {
    const body = req.body || {};
    const loaded = await loadDraft(body.scheduleId, WHAT.swap, session);
    if (!loaded.doc) return await refuse(loaded.status, loaded.body);
    const doc = loaded.doc;
    const parsed = parseSwap(doc, body);
    if (!parsed.a) return await refuse(parsed.status, parsed.body);
    const { a, b } = parsed;
    const inputs = await loadVersionInputs(doc);
    const plan = await planSwap(doc, a, b, inputs);
    if (!plan.ok) {
      return await refuse(409, {
        success: false,
        code: 'SWAP_REFUSED',
        message: `${classLabel(a)} and ${classLabel(b)} can't be swapped: ${plan.reasons.join('; ')}. Nothing was saved.`,
        reasons: plan.reasons,
        places: plan.places
      });
    }

    const actor = actorOf(req);
    const now = new Date();
    const term = { academicYear: doc.academicYear, semester: doc.semester };
    await placeItem(a, plan.moves[0], plan.after.policy, session);
    await placeItem(b, plan.moves[1], plan.after.policy, session);
    doc.lastCheck = lastCheckOf(plan.after, now, actor);
    refreshGaStats(doc, plan.after);
    await doc.save({ session });
    // One audit row: a schedule edit, never a decision Engine 4 learns from.
    await AuditEvent.create([{
      action: 'swap-classes',
      category: 'Timetable',
      target: `${classLabel(a)} ↔ ${classLabel(b)}`,
      detail: `${plan.swapText} ${plan.roomText} Professors stay the same. (Draft ${doc.version || ''})`.replace(/\s+\)/, ')'),
      term: { academicYear: String(term.academicYear), semester: Number(term.semester) },
      actor,
      at: now
    }], { session });
    await session.commitTransaction();

    res.status(200).json({
      ...planBody(doc, plan),
      message: `Swapped: ${plan.swapText} ${plan.roomText} Professors stay the same.`,
      lastCheck: { checkedAt: now.toISOString(), hardTotal: plan.after.violationCount, violationCount: plan.after.violations.length }
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Manual Edits - Swap]', err);
    res.status(500).json({ success: false, message: getSanitizedMessage(err, 'The classes could not be swapped. Try again.') });
  } finally {
    session.endSession();
  }
};

// For the unit tests: the words and the plan, without the routes.
exports.conflictWords = conflictWords;
exports.rangeWords = rangeWords;
exports.ROOM_RULES = ROOM_RULES;
