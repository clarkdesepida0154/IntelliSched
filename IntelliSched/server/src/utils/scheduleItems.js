// Turns Engine 3's placements into the items a Mother Schedule version stores (Phase 1 Step 7 fields,
// plus Phase 2's extra rooms), and lists which classes need an extra room and when ("Rooms to
// request"). Used when a GA run's result is saved.
const { timeOfSlot } = require('./timeGrid');
const { isExtraRoomKey, extraRoomName } = require('./gaRequest');

// The room name a class with no room stores: 'Online' for a lecture held online (Phase 3 Step 7),
// otherwise 'TBA' (no CCS room needed).
const noRoomName = (isOnline) => (isOnline ? 'Online' : 'TBA');

// placements [{ demandId, day, startSlot, roomId }] -> schedule items. A class in an extra room is
// stored with roomId null, extraRoomKey and the extra room's display name. A lecture held online keeps
// the mode it was generated with (isOnline, roomName 'Online'), whatever the catalog says later.
const buildScheduleItems = ({ placements, request, demandInfo, facilities, policy }) => {
  const roomsById = new Map(facilities.map(f => [String(f._id), f]));
  const durationById = new Map(request.demands.map(d => [d.demandId, d.durationSlots]));
  return placements.map(p => {
    const info = demandInfo.get(p.demandId);
    const durationSlots = durationById.get(p.demandId);
    const extraKey = isExtraRoomKey(p.roomId) ? p.roomId : null;
    const room = p.roomId && !extraKey ? roomsById.get(String(p.roomId)) : null;
    const isOnline = info.online === true;
    return {
      demandId: p.demandId,
      subjectCode: info.subjectCode,
      subjectId: info.subjectId,
      descriptiveTitle: info.descriptiveTitle,
      meetingIndex: info.meetingIndex,
      isFixed: info.isFixed,
      section: info.sectionCode,
      sectionId: info.sectionId,
      facultyRef: info.facultyRef || null,
      facultyId: info.facultyId,
      facultyName: info.facultyName,
      roomId: room ? room._id : null,
      ...(extraKey ? { extraRoomKey: extraKey } : {}),
      roomName: room ? room.roomName : extraKey ? extraRoomName(extraKey) : noRoomName(isOnline),
      day: p.day,
      startSlot: p.startSlot,
      durationSlots,
      type: info.classType,
      isMinor: info.isMinor,
      ...(isOnline ? { isOnline: true } : {}),
      // Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher.
      ...(info.outsideTeacherRef ? { outsideTeacherRef: info.outsideTeacherRef } : {}),
      // Stored as 24-hour "HH:MM", counted from the policy's grid origin.
      startTime: timeOfSlot(policy, p.startSlot),
      endTime: timeOfSlot(policy, p.startSlot + durationSlots)
    };
  });
};

// Legacy documents are read-only, read with lean(), and never saved or updated again by any code
// path: those saved before Phase 1 (no schemaVersion), and those whose items carry no demand ids
// (generated before Step 7, so no class can be named by its id). The outputs views never show them.
const isLegacySchedule = (doc) => !(Number(doc?.schemaVersion) >= 2) || (doc.scheduleData || []).some(item => !item.demandId);

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// "Rooms to request": each extra room that holds at least one class, with its classes and times, in
// key order (EXTRA-LAB-1, EXTRA-LAB-2, ..., EXTRA-LEC-1, ...), each room's classes by day and time.
const extraRoomUse = (items) => {
  const byKey = new Map();
  for (const item of items) {
    if (!item.extraRoomKey) continue;
    if (!byKey.has(item.extraRoomKey)) byKey.set(item.extraRoomKey, []);
    byKey.get(item.extraRoomKey).push({
      subjectCode: item.subjectCode,
      section: item.section,
      type: item.type,
      day: item.day,
      startTime: item.startTime,
      endTime: item.endTime
    });
  }
  const keyOrder = (key) => { const [, type, n] = /^EXTRA-(LAB|LEC)-(\d+)$/.exec(key); return [type === 'LAB' ? 0 : 1, Number(n)]; };
  return [...byKey.entries()]
    .sort(([a], [b]) => { const [ta, na] = keyOrder(a); const [tb, nb] = keyOrder(b); return ta - tb || na - nb; })
    .map(([key, classes]) => ({
      key,
      name: extraRoomName(key),
      type: key.includes('-LAB-') ? 'LAB' : 'LEC',
      classes: classes.sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.startTime.localeCompare(b.startTime))
    }));
};

// Phase 3 Step 4: the plain result of a version's classes, for the Generate Schedule page and the Term
// Checklist: { classesInTbaRooms, tbaRoomsUsed: { lab, lec }, saturdayClasses, noRoomClasses }, where
// classes in TBA rooms sit in a room to request (extraRoomKey), the TBA rooms used are those that
// received classes (as "TBA rooms to request"), Saturday classes leave out NSTP (fixed by the policy),
// and no-room classes are TBA with no CCS room needed (no room id and no TBA room: NSTP, a Minor whose
// "Needs a CCS room" is unticked). Phase 3 Step 7: a lecture held online is not TBA: it is counted as
// onlineClasses instead, a field present only when the version has online classes (so every version
// without them keeps exactly the fields it had).
const resultCounts = (allItems) => {
  // Phase 8 Part 3: the On-The-Job Training records (type 'OJT') are not the GA's classes and never
  // take a room, so the run's numbers leave them out — a version before and after the records carries
  // the same counts for the same GA answer.
  const items = allItems.filter(i => i.type !== 'OJT');
  const used = new Set(items.map(i => i.extraRoomKey).filter(isExtraRoomKey));
  const online = items.filter(i => i.isOnline === true).length;
  return {
    classesInTbaRooms: items.filter(i => isExtraRoomKey(i.extraRoomKey)).length,
    tbaRoomsUsed: { lab: [...used].filter(k => k.includes('-LAB-')).length, lec: [...used].filter(k => k.includes('-LEC-')).length },
    saturdayClasses: items.filter(i => i.day === 'Saturday' && !i.isFixed).length,
    noRoomClasses: items.filter(i => !i.roomId && !isExtraRoomKey(i.extraRoomKey) && i.isOnline !== true).length,
    ...(online ? { onlineClasses: online } : {})
  };
};

// A version's last "Validate schedule" as the pages read it (GET /schedule/versions, /schedule/outputs):
// { checkedAt (ISO), hardTotal, violationCount, by: { id, name, role } | null }, or null when the version
// was never checked as a whole.
const lastCheckOf = (doc) => {
  const c = doc?.lastCheck;
  if (!c || !c.checkedAt) return null;
  return {
    checkedAt: new Date(c.checkedAt).toISOString(),
    hardTotal: Number.isFinite(c.hardTotal) ? c.hardTotal : null,
    violationCount: Number.isFinite(c.violationCount) ? c.violationCount : null,
    by: c.by ? { id: c.by.id ?? null, name: c.by.name ?? null, role: c.by.role ?? null } : null
  };
};

// Engine 3's answer must follow the Phase 2 contract: a Python service still running older code
// (started by hand, not restarted after an update) accepts the new request but ignores the extra-room
// penalty, the idle rules and the stop rule. Returns { problem } when the answer is from older code,
// otherwise { warnings } (empty when Engine 3's soft numbers equal the gateway's shared counting).
const checkEngineStats = (stats, soft) => {
  if (!stats || !stats.softBreakdown || !stats.stopReason) {
    return { problem: 'Engine 3 answered in an older format (no soft-rule breakdown), so the Python service is probably running old code. Restart it (in intellisched_backend: .venv/Scripts/python main.py), then run the GA again. Nothing was saved.' };
  }
  const differs = Math.abs(Number(stats.soft) - Math.round(soft.total * 100) / 100) > 0.01
    || Object.keys(stats.softBreakdown).some(term => Math.abs(Number(stats.softBreakdown[term]) - Math.round((soft[term] || 0) * 100) / 100) > 0.01);
  return { warnings: differs ? [`Engine 3 and the gateway disagree on the soft score (${stats.soft} and ${Math.round(soft.total * 100) / 100}); the gateway's numbers are shown. Report this: the two must count the same way.`] : [] };
};

module.exports = { buildScheduleItems, extraRoomUse, resultCounts, lastCheckOf, checkEngineStats, isLegacySchedule, noRoomName };
