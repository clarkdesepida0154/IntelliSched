// Fill TBA rooms (Phase 4 Part 1, Step 1): the classes a Draft placed in TBA rooms (rooms to request)
// are put into real rooms with free time, without changing any day, time, professor or section
// (utils/fillTbaRooms.js has the method). Two routes, both schedule.move (the route checks it):
//   POST /schedule/fill-tba-rooms/preview { scheduleId, roomIds, academicYear?, semester? }
//     saves nothing: the moves, the hours moved, the TBA rooms that become empty, "TBA rooms to
//     request" before -> after, and a previewHash;
//   POST /schedule/fill-tba-rooms  the same body plus previewHash
//     recomputes the moves (409 PREVIEW_STALE when they differ from the preview: the Draft or a room
//     changed meanwhile), saves them as a NEW Draft (the next v{n}, filledFrom naming the source, which
//     stays as it was), checks the whole new version with the gateway validator and stores lastCheck,
//     refuses (409 NEW_CONFLICTS) when the new version has a conflict the source did not have, and
//     writes one audit row ("Filled N TBA classes into ROOM A, ROOM B (Draft vX -> vY)"): a schedule
//     edit, never a faculty decision, so Engine 4 never learns from it.
// The version must be a Draft (409 READ_ONLY_VERSION otherwise, as moves do), of the term the body
// names when it names one (404 VERSION_NOT_IN_TERM otherwise), and never a legacy one.
const mongoose = require('mongoose');
const MotherSchedule = require('../models/MotherSchedule');
const Facility = require('../models/Facility');
const AuditEvent = require('../models/AuditEvent');
const { planFillTbaRooms } = require('../utils/fillTbaRooms');
const { buildVersionRequest, checkScheduleVersion, LEGACY_READ_ONLY, readOnlyVersionMessage } = require('../utils/versionCheck');
const { extraRoomUse, resultCounts, isLegacySchedule } = require('../utils/scheduleItems');
const { SOFT_TERMS } = require('../utils/constraints');
const { findTermLockSource, nextVersionName } = require('../utils/termInputs');
const { hashOf } = require('../utils/gaRuns');
const { actorOf } = require('../utils/actor');
const { toSemesterLabel } = require('../utils/curriculumMatcher');

const TERM_PROGRAM = 'ALL';
const { plainMessage } = require('../utils/messages');
const { isAcademicYear } = require('../utils/academicCalendar');
// The page gets plain words; the raw error goes to the server log (utils/messages.js, Phase 4 Part 4).
const sanitizedMessage = (err, fallback) => plainMessage(err, fallback, { label: '[Fill TBA rooms]' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NOTHING_FITS = 'No TBA class fits the free times of these rooms.';
const STALE = 'The schedule changed since the preview. Preview again.';

// The term the body names, or null when it names none (the version's own term then applies).
const termOfBody = (body) => {
  if (body?.academicYear === undefined && body?.semester === undefined) return null;
  const academicYear = String(body?.academicYear ?? '').trim();
  const semester = Number(body?.semester);
  return isAcademicYear(academicYear) && [1, 2].includes(semester) ? { academicYear, semester } : { invalid: true };
};

// "ROOM 47, TSL" in the order the rooms were filled.
const roomNames = (plan) => plan.rooms.filter(r => r.classCount > 0).map(r => r.roomName).join(', ');

// What the preview and the save hash: the version, the rooms and the moves themselves (class -> room).
const previewHashOf = (doc, roomIds, plan) => hashOf({
  scheduleId: String(doc._id),
  roomIds: [...new Set(roomIds.map(String))].sort(),
  moves: plan.moves.map(m => ({ itemId: m.itemId, toRoomId: m.toRoomId }))
});

// Loads and checks the request's version and rooms, and plans the moves. Returns { doc, rooms, plan,
// previewHash } or { status, body } for a refusal.
const loadAndPlan = async (body, session = null) => {
  const scheduleId = String(body?.scheduleId ?? '').trim();
  if (!mongoose.isValidObjectId(scheduleId)) return { status: 400, body: { message: 'Choose a schedule version (a Draft) to fill.' } };
  const roomIds = Array.isArray(body?.roomIds) ? body.roomIds.map(String) : null;
  if (!roomIds || !roomIds.length) return { status: 400, body: { message: 'Choose at least one room with free time.' } };
  if (roomIds.some(id => !mongoose.isValidObjectId(id))) return { status: 400, body: { message: 'Choose rooms from the list.' } };
  const term = termOfBody(body);
  if (term?.invalid) return { status: 400, body: { message: 'Choose an academic year (YYYY-YYYY) and a semester (1st or 2nd).' } };

  const doc = await MotherSchedule.findById(scheduleId).session(session);
  if (!doc) return { status: 404, body: { message: 'That schedule version no longer exists. Reload the page.' } };
  if (term && (doc.academicYear !== term.academicYear || Number(doc.semester) !== term.semester)) {
    return { status: 404, body: { code: 'VERSION_NOT_IN_TERM', message: `That version does not belong to the ${toSemesterLabel(term.semester)}, AY ${term.academicYear}. Choose a version from the list.` } };
  }
  if (isLegacySchedule(doc)) return { status: 409, body: { legacy: true, message: LEGACY_READ_ONLY } };
  if (doc.status !== 'Draft') return { status: 409, body: { code: 'READ_ONLY_VERSION', message: readOnlyVersionMessage(doc.status) } };
  // Phase 4 Part 4 (Part 1's open question 5): a Draft is filled once. A second fill from the same source
  // would only make another copy; the Dean fills the filled Draft instead (its link is given).
  const filledInto = await MotherSchedule.findOne({ 'filledFrom.id': doc._id }).sort({ createdAt: 1 }).select('_id version status').session(session).lean();
  if (filledInto) {
    const name = filledInto.version || 'the filled Draft';
    return {
      status: 409,
      body: {
        code: 'ALREADY_FILLED',
        message: `This Draft was already filled into ${name}. Open ${name} to fill more.`,
        filledInto: { id: String(filledInto._id), version: filledInto.version || null, status: filledInto.status || null }
      }
    };
  }

  const rooms = await Facility.find({ _id: { $in: roomIds }, isActive: true }).session(session);
  if (rooms.length !== new Set(roomIds).size) return { status: 400, body: { message: 'One of the chosen rooms is not an active room any more. Reload the page and choose again.' } };

  const { request } = await buildVersionRequest(doc);
  const items = doc.scheduleData.map(i => i.toObject());
  const plan = planFillTbaRooms({ request, items, roomIds });
  return { doc, rooms, plan, previewHash: previewHashOf(doc, roomIds, plan), roomIds };
};

const planBody = (doc, plan, previewHash) => ({
  scheduleId: String(doc._id),
  version: doc.version || null,
  status: doc.status,
  moves: plan.moves,
  byRoom: plan.byRoom,
  rooms: plan.rooms,
  classCount: plan.classCount,
  hoursMoved: plan.hoursMoved,
  emptiedTbaRooms: plan.emptiedTbaRooms,
  tbaRequest: plan.tbaRequest,
  previewHash,
  // "12 classes (24 hours) move. TBA rooms to request: 6 -> 4. Times and professors stay the same.
  // Only the room changes."
  message: plan.classCount
    ? `${plural(plan.classCount, 'class', 'classes')} (${plan.hoursMoved} ${plan.hoursMoved === 1 ? 'hour' : 'hours'}) move. TBA rooms to request: ${plan.tbaRequest.before.labRooms + plan.tbaRequest.before.lecRooms} → ${plan.tbaRequest.after.labRooms + plan.tbaRequest.after.lecRooms}. Times and professors stay the same. Only the room changes.`
    : NOTHING_FITS
});

// POST /schedule/fill-tba-rooms/preview
exports.previewFillTbaRooms = async (req, res) => {
  try {
    const loaded = await loadAndPlan(req.body);
    if (loaded.status) return res.status(loaded.status).json({ success: false, ...loaded.body });
    res.status(200).json({ success: true, ...planBody(loaded.doc, loaded.plan, loaded.previewHash) });
  } catch (err) {
    console.error('[Fill TBA rooms - preview]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The preview could not be made. Try again.') });
  }
};

// A violation as a comparable key: its rule and the classes it names (the order of the pair does not matter).
const violationKey = (v) => `${v.code}|${[...(v.demandIds || [])].sort().join(',')}${v.facultyRef ? `|${v.facultyRef}` : ''}`;
// The violations of `after` that `before` does not have (as a multiset).
const newViolations = (before, after) => {
  const seen = new Map();
  for (const v of before) seen.set(violationKey(v), (seen.get(violationKey(v)) || 0) + 1);
  return after.filter(v => {
    const key = violationKey(v);
    const left = seen.get(key) || 0;
    if (left > 0) { seen.set(key, left - 1); return false; }
    return true;
  });
};

// POST /schedule/fill-tba-rooms
exports.fillTbaRooms = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const refuse = async (status, body) => {
      await session.abortTransaction();
      return res.status(status).json({ success: false, ...body });
    };
    const previewHash = String(req.body?.previewHash ?? '').trim();
    if (!previewHash) return await refuse(400, { message: 'Preview the moves first, then save.' });
    const loaded = await loadAndPlan(req.body, session);
    if (loaded.status) return await refuse(loaded.status, loaded.body);
    const { doc, plan } = loaded;
    if (loaded.previewHash !== previewHash) return await refuse(409, { code: 'PREVIEW_STALE', message: STALE });
    if (!plan.classCount) return await refuse(409, { code: 'NOTHING_FITS', message: NOTHING_FITS });

    const term = { academicYear: doc.academicYear, semester: Number(doc.semester) };
    const source = doc.toObject();
    const roomById = new Map(loaded.rooms.map(r => [String(r._id), r]));
    const moveByItem = new Map(plan.moves.map(m => [m.itemId, m]));
    // The same classes with the moved ones in their new rooms; each gets its own item id in the new version.
    const scheduleData = source.scheduleData.map(({ _id, ...item }) => {
      const move = moveByItem.get(String(_id));
      if (!move) return item;
      const room = roomById.get(move.toRoomId);
      const { extraRoomKey, ...rest } = item;
      return { ...rest, roomId: room._id, roomName: room.roomName };
    });

    // The whole new version against the whole source: a conflict the source did not have refuses the save.
    const [checkBefore, checkAfter] = [await checkScheduleVersion(source), await checkScheduleVersion({ ...source, scheduleData })];
    const added = newViolations(checkBefore.violations, checkAfter.violations);
    if (added.length) {
      return await refuse(409, {
        code: 'NEW_CONFLICTS',
        message: `Filling these rooms would cause ${plural(added.length, 'conflict')} the Draft does not have, so nothing was saved.`,
        violations: added
      });
    }

    const actor = actorOf(req);
    const version = await nextVersionName(term, session);
    // The term's locks (findTermLockSource), as a restore does, so the Dean's later assignments never revert.
    const lockSource = await findTermLockSource(term, session);
    const checkedAt = new Date();
    const gaStats = source.gaStats ? {
      ...source.gaStats,
      extraRoomUse: extraRoomUse(scheduleData),
      ...resultCounts(scheduleData),
      softBreakdown: Object.fromEntries(SOFT_TERMS.map(t => [t, checkAfter.soft[t]])),
      softTotal: checkAfter.soft.total,
      softCounts: checkAfter.softCounts
    } : undefined;
    const [copy] = await MotherSchedule.create([{
      academicYear: term.academicYear,
      semester: term.semester,
      program: TERM_PROGRAM,
      schemaVersion: 2,
      status: 'Draft',
      version,
      scheduleData,
      ...(source.unscheduledItems ? { unscheduledItems: source.unscheduledItems } : {}),
      ...(source.policySnapshot ? { policySnapshot: source.policySnapshot } : {}),
      ...(gaStats ? { gaStats } : {}),
      ...(source.hyperparameters ? { hyperparameters: source.hyperparameters } : {}),
      overrideLogs: [],
      lockedAssignments: lockSource ? lockSource.toObject().lockedAssignments || [] : source.lockedAssignments || [],
      filledFrom: { id: doc._id, version: doc.version, status: doc.status, classCount: plan.classCount, hours: plan.hoursMoved },
      lastCheck: { checkedAt, hardTotal: checkAfter.violationCount, violationCount: checkAfter.violations.length, by: actor },
      ...(actor ? { createdBy: actor } : {})
    }], { session });

    const summary = `Filled ${plural(plan.classCount, 'TBA class', 'TBA classes')} into ${roomNames(plan)} (Draft ${doc.version || 'the source'} → ${version})`;
    await AuditEvent.create([{
      action: 'fill-tba-rooms',
      category: 'Timetable',
      target: `${version} (${term.academicYear} Sem ${term.semester})`,
      detail: `${summary}. ${plan.hoursMoved} hours; TBA rooms to request ${plan.tbaRequest.before.labRooms + plan.tbaRequest.before.lecRooms} → ${plan.tbaRequest.after.labRooms + plan.tbaRequest.after.lecRooms}. Times and professors stay the same. Only the room changes. ${doc.version || 'The source'} itself did not change.`,
      term,
      actor
    }], { session });
    await session.commitTransaction();

    // The plan's words (moves, hours, TBA rooms before -> after), then the NEW Draft's facts.
    res.status(200).json({
      success: true,
      ...planBody(doc, plan, previewHash),
      message: `${summary}. Times and professors stay the same. Only the room changes.`,
      sourceId: String(doc._id),
      sourceVersion: doc.version || null,
      scheduleId: String(copy._id),
      version,
      status: copy.status,
      schedule: { id: String(copy._id), version, status: copy.status, filledFrom: { id: String(doc._id), version: doc.version || null } },
      lastCheck: { checkedAt: checkedAt.toISOString(), hardTotal: checkAfter.violationCount, violationCount: checkAfter.violations.length }
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error('[Fill TBA rooms - save]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The rooms could not be filled. Try again.') });
  } finally {
    session.endSession();
  }
};
