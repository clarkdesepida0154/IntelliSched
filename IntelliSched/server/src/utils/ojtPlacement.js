// The 4th-year On-The-Job Training as schedule records (Phase 8 Part 3, decision 2). The OJT blocks
// on a coordinator's Teachers' Program become schedule records of the SECTION — the practicum
// subject, the coordinator as professor, no room — saved with the version, so the coordinator's
// Teachers' Program and the section's Class Schedule read the same record, never a second copy.
// Placement happens after the GA (utils/gaRuns.js saveResult) and never moves a GA class:
//   - the hours are the coordinator's practicum hours for that section (the unscheduled item's,
//     policy.load.ojtCoordinatorHours);
//   - one weekday, as on all four coordinators' real forms: the coordinator's lightest day that has
//     classes (fewest class hours; Faculty's Thursday), never the weekday the Extension duty keeps
//     free (utils/ancillaryFill.js extensionDayOf), and a class-free day only when no class day fits;
//   - a morning block and an afternoon block around the kept lunch hour, in the coordinator's AND the
//     section's free time (Faculty's Thursday 8–12 and 1–3), the morning flush against the hour and
//     the afternoon flush after it;
//   - a coordinator with two sections gets a day for each, where possible;
//   - when no day holds all the hours, they are split over two days and the version's notes say so.
// The records ride the validator like the coordinator's classes: utils/versionCheck.js gives each one
// a demand of its own (ojtDemandsOf) — no room, its own meeting group (two blocks of one practicum on
// one day are the office's way, never an HC7 conflict), the weekday rule, the professor's and the
// section's clash and lunch rules. Deterministic: the same GA result always gives the same records.
const { toMinutes, fromMinutes, slotOfTime } = require('./timeGrid');
const { extensionDayOf, reservedLunchHour } = require('./ancillaryFill');
const { ancillaryByTypeOf } = require('./load');
// Phase 8 Part 4 (decision 4): the professor's set day for Extension, which the OJT avoids.
const { extensionDayFor } = require('./facultyAvailability');

const textOf = (value) => String(value ?? '').trim();
const byText = (a, b) => textOf(a).localeCompare(textOf(b), 'en', { numeric: true });
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// The free runs of one day inside [dayStart, dayEnd], minus the busy blocks, snapped to the grid.
const freeRuns = (busy, dayStart, dayEnd, slot) => {
  const sorted = [...busy].sort((a, b) => a.start - b.start || a.end - b.end);
  const runs = [];
  let cursor = dayStart;
  for (const b of sorted) {
    if (b.start > cursor) runs.push({ start: cursor, end: Math.min(b.start, dayEnd) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) runs.push({ start: cursor, end: dayEnd });
  return runs
    .map(r => ({ start: Math.ceil(r.start / slot) * slot, end: Math.floor(r.end / slot) * slot }))
    .filter(r => r.end > r.start);
};

// What one day can hold: the blocks (morning flush against the kept hour, afternoon flush after it)
// for up to `minutes` of OJT in the free time left by `busy` (the coordinator's and the section's
// drawn blocks and the coordinator's unavailable times). `drawn` (classes and OJT only) decides the
// kept lunch hour. Returns { blocks: [{ start, end }], minutes } — what fits, possibly 0.
const dayPlan = ({ minutes, busy, drawn, policy }) => {
  const slot = Number(policy.slotMinutes) || 30;
  const dayStart = toMinutes(policy.dayStart);
  const dayEnd = toMinutes(policy.dayEnd);
  const kept = reservedLunchHour(drawn, policy);
  const noon = kept ? null : (dayStart + dayEnd) / 2;
  const occupied = kept ? [...busy, kept] : busy;
  const runs = freeRuns(occupied, dayStart, dayEnd, slot);
  const morning = runs.filter(r => r.end <= (kept ? kept.start : noon)).sort((a, b) => b.end - a.end)[0] || null;
  const afternoon = runs.filter(r => r.start >= (kept ? kept.end : noon)).sort((a, b) => a.start - b.start)[0] || null;
  const morningTake = morning ? Math.min(morning.end - morning.start, minutes) : 0;
  const afternoonTake = afternoon ? Math.min(afternoon.end - afternoon.start, minutes - morningTake) : 0;
  const blocks = [];
  if (morningTake > 0) blocks.push({ start: morning.end - morningTake, end: morning.end });
  if (afternoonTake > 0) blocks.push({ start: afternoon.start, end: afternoon.start + afternoonTake });
  return { blocks, minutes: morningTake + afternoonTake };
};

// placeOjtRecords({ scheduleData, unscheduledItems, pairs, faculty, policy })
//   scheduleData     the GA's saved items (never moved; OJT goes into the free time around them)
//   unscheduledItems the run's practicum items ({ sectionId, subjectId, facultyRef, kind, hours })
//   pairs            the term's (section, subject) pairs (the records' codes and titles)
//   faculty          the active professors (unavailable times, employment type, ancillary hours)
//   policy           the run's policy
// Returns { items, notes }: the OJT schedule items to append, and the notes for the version (one per
// coordination whose hours did not fit one weekday).
const placeOjtRecords = ({ scheduleData = [], unscheduledItems = [], pairs = [], faculty = [], policy }) => {
  const slot = Number(policy.slotMinutes) || 30;
  const weekdays = (policy.weekdays || []).filter(d => d !== 'Saturday');
  const facultyById = new Map(faculty.map(f => [String(f._id), f]));
  const pairByKey = new Map(pairs.map(p => [`${p.section._id}:${p.subject._id}`, p]));

  // Busy time per professor and per section, from the saved items (and the records placed here).
  const minutesOf = (item) => ({ start: toMinutes(item.startTime ?? item.start), end: toMinutes(item.endTime ?? item.end), day: item.day });
  const profBusy = new Map();   // ref -> [{ day, start, end }]
  const sectionBusy = new Map();
  const add = (map, key, block) => {
    if (!key || block.start === null || block.end === null) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(block);
  };
  for (const item of scheduleData) {
    const block = minutesOf(item);
    add(profBusy, item.facultyRef ? String(item.facultyRef) : null, block);
    add(sectionBusy, item.sectionId ? String(item.sectionId) : null, block);
  }

  const coordinations = unscheduledItems
    .filter(u => u.kind === 'PRACTICUM' && u.facultyRef)
    .map(u => ({ ...u, pair: pairByKey.get(`${u.sectionId}:${u.subjectId}`) }))
    .filter(c => c.pair)
    .sort((a, b) => byText(a.pair.section.sectionCode, b.pair.section.sectionCode) || byText(a.pair.subject.subjectCode, b.pair.subject.subjectCode));

  const items = [];
  const notes = [];
  const daysTaken = new Map();   // ref -> Set of days this coordinator's OJT already holds

  for (const c of coordinations) {
    const ref = String(c.facultyRef);
    const prof = facultyById.get(ref) || {};
    const sectionKey = String(c.sectionId);
    const minutes = Math.max(0, Math.round(((Number(c.hours) || 0) * 60) / slot) * slot);
    if (!minutes) continue;
    const taken = daysTaken.get(ref) || new Set();
    const profBlocks = profBusy.get(ref) || [];
    const unavailable = (prof.unavailableBlocks || [])
      .map(w => ({ day: w.day, start: toMinutes(w.start), end: toMinutes(w.end) }))
      .filter(w => w.start !== null && w.end !== null && w.end > w.start);
    // The weekday the Extension duty keeps free, from the coordinator's drawn classes and the set
    // Extension day (the fill recomputes it the same way when the Teachers' Program is drawn, so
    // the two always agree).
    const extensionDay = prof.employmentType !== 'PART_TIME' && (ancillaryByTypeOf(prof).EXTENSION || 0) > 0
      ? extensionDayOf(profBlocks, policy, extensionDayFor(prof, policy)) : null;

    const classMinutes = (day) => profBlocks.filter(b => b.day === day).reduce((sum, b) => sum + (b.end - b.start), 0);
    const ordered = weekdays
      .filter(day => day !== extensionDay)
      .sort((a, b) => (Number(classMinutes(b) > 0) - Number(classMinutes(a) > 0))
        || (classMinutes(a) - classMinutes(b))
        || (weekdays.indexOf(a) - weekdays.indexOf(b)));

    const planOf = (day) => {
      const drawn = [...profBlocks, ...(sectionBusy.get(sectionKey) || [])].filter(b => b.day === day);
      const busy = [...drawn, ...unavailable.filter(w => w.day === day)];
      return dayPlan({ minutes: left, busy, drawn, policy });
    };
    const record = (day, block) => {
      const start = fromMinutes(block.start);
      const end = fromMinutes(block.end);
      const placed = { day, start: block.start, end: block.end };
      add(profBusy, ref, { day, start: block.start, end: block.end });
      add(sectionBusy, sectionKey, { day, start: block.start, end: block.end });
      taken.add(day);
      const index = items.filter(i => String(i.sectionId) === sectionKey && String(i.subjectId) === String(c.subjectId)).length;
      items.push({
        demandId: `${sectionKey}:${c.subjectId}:OJT:${index}`,
        subjectCode: c.pair.subject.subjectCode,
        subjectId: c.pair.subject._id,
        descriptiveTitle: c.pair.subject.descriptiveTitle,
        meetingIndex: index,
        isFixed: false,
        section: c.pair.section.sectionCode,
        sectionId: c.pair.section._id,
        facultyRef: c.facultyRef,
        facultyId: prof.facultyId || 'TBA',
        facultyName: prof.name || 'TBA',
        roomId: null,
        roomName: 'TBA',
        day,
        startSlot: slotOfTime(policy, start),
        durationSlots: slotOfTime(policy, end) - slotOfTime(policy, start),
        type: 'OJT',
        isMinor: false,
        startTime: start,
        endTime: end
      });
      return placed;
    };

    let left = minutes;
    const label = `${c.pair.subject.subjectCode} (${c.pair.section.sectionCode})`;
    // One whole weekday: a new day first (a coordinator with two sections gets a day for each), then
    // a day their other coordination already took.
    const passes = [ordered.filter(d => !taken.has(d)), ordered.filter(d => taken.has(d))];
    let wholeDay = null;
    for (const pass of passes) {
      wholeDay = pass.find(day => planOf(day).minutes >= left) ?? null;
      if (wholeDay) break;
    }
    if (wholeDay !== null) {
      for (const block of planOf(wholeDay).blocks) record(wholeDay, block);
      left = 0;
      daysTaken.set(ref, taken);
      continue;
    }
    // No day holds all the hours: split over two days (the most placeable first) and say so in the
    // version's notes; whatever still does not fit is noted too (the load counts it either way).
    const byCapacity = [...ordered].sort((a, b) => planOf(b).minutes - planOf(a).minutes || ordered.indexOf(a) - ordered.indexOf(b));
    for (const day of byCapacity.slice(0, 2)) {
      if (left <= 0) break;
      const plan = planOf(day);
      for (const block of plan.blocks) {
        if (left <= 0) break;
        const take = Math.min(left, block.end - block.start);
        record(day, { start: block.start, end: block.start + take });
        left -= take;
      }
    }
    daysTaken.set(ref, taken);
    if (left < minutes && left === 0) {
      notes.push(`The On-The-Job Training hours of ${label} did not fit one weekday, so they are split over two days.`);
    } else if (left > 0) {
      notes.push(`${(minutes - left) / 60 > 0 ? `Only ${(minutes - left) / 60} of ` : ''}${minutes / 60} On-The-Job Training hours of ${label} could be placed in ${prof.name || 'the coordinator'}'s free weekday time.`);
    }
  }
  return { items, notes };
};

// The version's OJT records as validator demands (utils/versionCheck.js): no room, its own meeting
// group, the weekdays, the stored coordinator — or the professor a checked change proposes for the
// pair, so Change professor judges the new coordinator's clashes, unavailable times and lunch.
const ojtDemandsOf = (scheduleData = [], { policy, facultyChanges = [] } = {}) => scheduleData
  .filter(item => item.type === 'OJT')
  .map(item => {
    const change = facultyChanges.find(ch => String(ch.sectionId) === String(item.sectionId) && String(ch.subjectId) === String(item.subjectId));
    const facultyRef = change !== undefined
      ? (change.facultyRef ? String(change.facultyRef) : null)
      : (item.facultyRef ? String(item.facultyRef) : null);
    return {
      demandId: item.demandId,
      subjectId: String(item.subjectId),
      subjectCode: item.subjectCode,
      sectionId: String(item.sectionId),
      sectionCode: item.section,
      sectionSize: null,
      classType: 'OJT',
      meetingGroup: item.demandId,
      durationSlots: item.durationSlots,
      facultyRef,
      isMinor: false,
      requiresRoom: false,
      allowedRoomTypes: [],
      allowedDays: (policy.weekdays || []).filter(d => d !== 'Saturday'),
      allowedStarts: null,
      fixed: null
    };
  });

module.exports = { placeOjtRecords, ojtDemandsOf, dayPlan };
