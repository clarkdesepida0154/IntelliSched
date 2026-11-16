// Fill TBA rooms (Phase 4 Part 1, Step 1): the second half of the Dean's order, "times first, rooms
// second". A generated Draft keeps its times; this puts the classes that sit in a TBA room (a room to
// request, EXTRA-LAB-n / EXTRA-LEC-n) into real rooms that have free time, WITHOUT changing any day,
// time, professor or section. It is not the GA: a deterministic room assignment over fixed times, exact
// for each room and day. Pure: no database (controllers/fillTbaRoomsController.js loads the version and
// the rooms, and saves the result as a new Draft).
//
// planFillTbaRooms({ request, items, roomIds })
//   request   the version's GA request (utils/versionCheck.js buildVersionRequest): the demands (room
//             types, durations), the rooms in slots (a borrowed room's windows clipped to the grid) and
//             the policy's day windows
//   items     the version's classes (scheduleData, plain objects or subdocuments)
//   roomIds   the chosen real rooms (ids as strings), in any order
//
// The method:
//   1. Candidates: the classes in a TBA room. These never move: the other kind of TBA ("no CCS room
//      needed": a Minor whose box is unticked, NSTP, an online lecture), a class already in a real room.
//   2. Room order: the chosen CCS rooms, LEC rooms before LAB rooms (each by name), then the chosen
//      borrowed rooms the same way (Phase 4 Part 4), so a lecture takes a lecture room's free time
//      before a lab room's. A borrowed room is a room with free times (availability windows); a CCS
//      room has none.
//   3. For each room and each day:
//      - free time: the room's windows on that day (the whole policy day when it has none), minus the
//        times the Draft already uses in that room, in slots. Phase 8 (odd and even weeks): while the
//        request carries weekGroupsEnabled, the room is checked WITHIN the class's week group — a
//        class of the other group does not make the room busy (they alternate weeks), so the day is
//        filled per group (odd, then even, then the classes without a group, which meet every week
//        and conflict with everything);
//      - eligible candidates: the validator allows the room for the class (its room rules, read from
//        utils/constraints.js: the room type, the room's windows, capacity when enforced), and the
//        class's whole time lies inside one free interval;
//      - choice: the set of non-overlapping eligible classes with the most hours (weighted interval
//        scheduling), and among the sets with the most hours the one that ranks first class by class:
//        a class from the TBA room with the fewest hours left first (so whole TBA rooms empty), then by
//        section name, then by start time (then subject code and item id, so the answer is unique).
//   4. The chosen classes leave the candidates; the next room is filled the same way.
//   5. Nothing else changes: the day, start, end, professor and section stay as they are.
// The same input always gives the same result.
const { evaluatePlacements } = require('./constraints');
const { isExtraRoomKey, tbaRoomName } = require('./gaRequest');
const { DAY_NAMES } = require('./timeGrid');

// The validator's rules about the room of a class (the others do not change when only the room does).
const ROOM_RULE_CODES = ['HC2_ROOM_TYPE', 'HC4_ROOM_UNAVAILABLE', 'HC6_CAPACITY'];

const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
const round2 = (n) => Math.round(n * 100) / 100;

// The policy the request carries, as the version was generated under (slot length, day windows).
const slotHoursOf = (request) => (Number(request.policy?.slotMinutes) || 30) / 60;

// The room's usable intervals on a day, in slots: its windows (already clipped to the grid by the demand
// builder) cut to the policy's day window, or the whole day window when it has none; [] on a day the
// policy never uses.
const roomIntervals = (request, room, day) => {
  const w = request.policy?.dayWindows?.[day];
  if (!w) return [];
  const windows = room.availability || [];
  if (!windows.length) return [[w.startSlot, w.endSlot]];
  return windows
    .filter(a => a.day === day)
    .map(a => [Math.max(w.startSlot, a.startSlot), Math.min(w.endSlot, a.endSlot)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
};

// `intervals` minus `busy` ([start, end) pairs), as sorted [start, end) pairs.
const subtractBusy = (intervals, busy) => {
  const sortedBusy = [...busy].sort((a, b) => a[0] - b[0]);
  const free = [];
  for (const [start, end] of intervals) {
    let cursor = start;
    for (const [bs, be] of sortedBusy) {
      if (be <= cursor || bs >= end) continue;
      if (bs > cursor) free.push([cursor, bs]);
      cursor = Math.max(cursor, be);
      if (cursor >= end) break;
    }
    if (cursor < end) free.push([cursor, end]);
  }
  return free;
};

// Whether the validator's room rules allow this class in this room (the class keeps its day and time).
const roomAllowed = (request, item, roomId) => {
  const { violations } = evaluatePlacements(request, [{ demandId: item.demandId, day: item.day, startSlot: item.startSlot, roomId }]);
  return !violations.some(v => ROOM_RULE_CODES.includes(v.code));
};

// Lexicographic comparison of two ascending rank lists: negative when a ranks before b.
const compareRanks = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
// Inserts a rank into an ascending list (a new list).
const withRank = (list, rank) => {
  const out = [...list];
  let i = out.length;
  while (i > 0 && out[i - 1] > rank) i -= 1;
  out.splice(i, 0, rank);
  return out;
};
// The better of two solutions { slots, ranks, chosen }: more slots first, then the rank list that comes
// first (the one holding the better-ranked classes).
const better = (x, y) => (x.slots !== y.slots ? x.slots > y.slots : compareRanks(x.ranks, y.ranks) < 0);

// Weighted interval scheduling over the eligible candidates of one (room, day), each { item, rank,
// start, end }: the non-overlapping set with the most slots, ties broken by the rank lists (above).
const bestNonOverlapping = (eligible) => {
  const sorted = [...eligible].sort((a, b) => a.end - b.end || a.start - b.start || a.rank - b.rank);
  const n = sorted.length;
  // p[i]: the number of candidates (in sorted order) that end at or before sorted[i] starts.
  const p = sorted.map((c) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].end <= c.start) lo = mid + 1; else hi = mid;
    }
    return lo;
  });
  const empty = { slots: 0, ranks: [], chosen: [] };
  const best = [empty];
  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    const without = best[i];
    const base = best[p[i]];
    const withIt = { slots: base.slots + (c.end - c.start), ranks: withRank(base.ranks, c.rank), chosen: [...base.chosen, c] };
    best.push(better(withIt, without) ? withIt : without);
  }
  return best[n].chosen;
};

// A class's stored facts for a move ("ITEC 101 LEC, BSIT 1A, Monday 08:00–10:00").
const describeItem = (request, item) => ({
  itemId: String(item._id),
  demandId: item.demandId,
  subjectCode: item.subjectCode,
  descriptiveTitle: item.descriptiveTitle || null,
  section: item.section,
  classType: item.type,
  facultyName: item.facultyName,
  facultyId: item.facultyId,
  day: item.day,
  startSlot: item.startSlot,
  durationSlots: item.durationSlots,
  startTime: item.startTime,
  endTime: item.endTime,
  hours: round2(item.durationSlots * slotHoursOf(request))
});

// The "TBA rooms to request" of a set of classes: { classCount, labRooms, lecRooms, keys }, counting only
// the TBA rooms that hold at least one class (utils/scheduleItems.js resultCounts counts the same way).
const tbaRequestOf = (items) => {
  const keys = [...new Set(items.map(i => i.extraRoomKey).filter(isExtraRoomKey))].sort(byText);
  return {
    classCount: items.filter(i => isExtraRoomKey(i.extraRoomKey)).length,
    labRooms: keys.filter(k => k.includes('-LAB-')).length,
    lecRooms: keys.filter(k => k.includes('-LEC-')).length,
    keys
  };
};

const planFillTbaRooms = ({ request, items = [], roomIds = [] }) => {
  const slotHours = slotHoursOf(request);
  const demandsById = new Map((request.demands || []).map(d => [d.demandId, d]));
  const roomsById = new Map((request.rooms || []).filter(r => !r.extra).map(r => [String(r.roomId), r]));
  const chosen = [...new Set(roomIds.map(String))].map(id => roomsById.get(id)).filter(Boolean);
  // Phase 4 Part 4 (Part 1's open question 1): CCS rooms first, LEC rooms before LAB rooms (each by name),
  // then the borrowed rooms (with windows) the same way, so a lecture takes a lecture room's free time
  // before a lab room's (a lecture in a LAB room keeps the usual penalty; a lab fits LAB rooms only).
  const isBorrowed = (room) => (room.availability || []).length > 0;
  const typeRank = (room) => (room.roomType === 'LEC' ? 0 : 1);
  const byTypeThenName = (a, b) => (typeRank(a) - typeRank(b)) || byText(a.roomName, b.roomName) || byText(a.roomId, b.roomId);
  const order = [...chosen.filter(r => !isBorrowed(r)).sort(byTypeThenName), ...chosen.filter(isBorrowed).sort(byTypeThenName)];

  // 1. Candidates: the classes in a TBA room that the request knows (every class of a version 2 Draft).
  let candidates = items.filter(i => isExtraRoomKey(i.extraRoomKey) && demandsById.has(i.demandId) && i._id);
  const hoursOf = (item) => item.durationSlots * slotHours;
  const before = tbaRequestOf(items);
  const tbaHoursBefore = new Map();
  for (const c of candidates) tbaHoursBefore.set(c.extraRoomKey, (tbaHoursBefore.get(c.extraRoomKey) || 0) + hoursOf(c));

  const moves = [];
  const byRoom = [];
  for (const room of order) {
    const roomId = String(room.roomId);
    // The hours each TBA room still holds, for the ties: the smallest TBA room empties first.
    const tbaHours = new Map();
    for (const c of candidates) tbaHours.set(c.extraRoomKey, (tbaHours.get(c.extraRoomKey) || 0) + hoursOf(c));
    const ranked = [...candidates].sort((a, b) => (tbaHours.get(a.extraRoomKey) - tbaHours.get(b.extraRoomKey))
      || byText(a.section, b.section) || (a.startSlot - b.startSlot)
      || byText(a.subjectCode, b.subjectCode) || byText(a.extraRoomKey, b.extraRoomKey) || byText(String(a._id), String(b._id)));
    const rankOf = new Map(ranked.map((c, i) => [String(c._id), i]));
    const roomMoves = [];
    // Phase 8: with odd and even weeks on, the room is checked within each class's week group (the
    // demand's weekGroup): odd first, then even, then the classes without a group, which meet every
    // week. Two blocks conflict unless both have a group and the groups differ.
    const weekGroupsOn = request.policy?.weekGroupsEnabled === true;
    const groupOfItem = (i) => (weekGroupsOn ? demandsById.get(i.demandId)?.weekGroup || null : undefined);
    const passes = weekGroupsOn ? ['ODD', 'EVEN', null] : [undefined];
    const conflicts = (g, other) => !(weekGroupsOn && g != null && other != null && g !== other);
    for (const day of DAY_NAMES) {
      const dayItems = items.filter(i => i.day === day && i.roomId && String(i.roomId) === roomId);
      const pickedThisDay = [];
      for (const g of passes) {
        // Free time: the room's intervals minus the blocks that conflict with this group — the classes
        // the Draft already holds in the room, and the classes this fill just placed in it.
        const busy = [
          ...dayItems.filter(i => conflicts(g, groupOfItem(i))).map(i => [i.startSlot, i.startSlot + i.durationSlots]),
          ...pickedThisDay.filter(p => conflicts(g, p.group)).map(p => [p.start, p.end])
        ];
        const free = subtractBusy(roomIntervals(request, room, day), busy);
        if (!free.length) continue;
        const eligible = candidates
          .filter(i => i.day === day)
          .filter(i => g === undefined || groupOfItem(i) === g)
          .filter(i => free.some(([s, e]) => s <= i.startSlot && i.startSlot + i.durationSlots <= e))
          .filter(i => roomAllowed(request, i, roomId))
          .map(i => ({ item: i, rank: rankOf.get(String(i._id)), start: i.startSlot, end: i.startSlot + i.durationSlots }));
        if (!eligible.length) continue;
        const picked = bestNonOverlapping(eligible).map(c => c.item);
        const pickedIds = new Set(picked.map(i => String(i._id)));
        candidates = candidates.filter(i => !pickedIds.has(String(i._id)));
        for (const item of picked) {
          pickedThisDay.push({ start: item.startSlot, end: item.startSlot + item.durationSlots, group: groupOfItem(item) });
          roomMoves.push({
            ...describeItem(request, item),
            fromKey: item.extraRoomKey,
            fromName: tbaRoomName(item.extraRoomKey),
            toRoomId: roomId,
            toRoomName: room.roomName,
            toRoomType: room.roomType
          });
        }
      }
    }
    roomMoves.sort((a, b) => DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day) || a.startSlot - b.startSlot || byText(a.section, b.section));
    moves.push(...roomMoves);
    byRoom.push({
      roomId,
      roomName: room.roomName,
      roomType: room.roomType,
      kind: isBorrowed(room) ? 'BORROWED' : 'CCS',
      classCount: roomMoves.length,
      hours: round2(roomMoves.reduce((sum, m) => sum + m.hours, 0)),
      moves: roomMoves
    });
  }

  const movedIds = new Set(moves.map(m => m.itemId));
  const after = tbaRequestOf(items.map(i => (movedIds.has(String(i._id)) ? { ...(i.toObject ? i.toObject() : i), extraRoomKey: undefined } : i)));
  const emptiedTbaRooms = before.keys.filter(k => !after.keys.includes(k)).map(key => ({ key, name: tbaRoomName(key), hours: round2(tbaHoursBefore.get(key) || 0) }));
  return {
    moves,
    byRoom,
    classCount: moves.length,
    hoursMoved: round2(moves.reduce((sum, m) => sum + m.hours, 0)),
    emptiedTbaRooms,
    tbaRequest: {
      before: { classCount: before.classCount, labRooms: before.labRooms, lecRooms: before.lecRooms },
      after: { classCount: after.classCount, labRooms: after.labRooms, lecRooms: after.lecRooms }
    },
    rooms: byRoom.map(({ moves: _m, ...r }) => r)
  };
};

module.exports = { planFillTbaRooms, bestNonOverlapping, subtractBusy, roomIntervals, roomAllowed, tbaRequestOf, ROOM_RULE_CODES };
