// Phase 10, Step 4: the planted faults. Pure: from one conflict-free schedule's meetings, every candidate
// case of a fault type, each changing exactly ONE thing (one class moved, or one class's teacher changed).
// Tested in server/tests/unit/evalFaultPlant.test.js; driven by scripts/eval/fault-injection.js.
//
// A meeting (as phase10-common meetingsFromClasses, plus): itemId, sectionId, subjectId, roomId, startSlot,
// durationSlots, isFixed. ctx: { rooms: [{ name, id, type }], loads: Map(professor -> hours), caps:
// Map(professor -> cap), partTime: Map(professor -> bool), facultyRef: Map(professor -> id), unavailable:
// Map(professor -> [{ day, start, end }]) (stored blocks + the Extension day), dayStart, dayEnd, labStarts }.
// A case: { type, shouldFlag, move?: { itemId, day, start, room }, facultyChange?: { sectionId, subjectId,
// section, subject, professor }, note }.
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const LUNCH_FROM = 600; const LUNCH_TO = 900;

const FAULTS = ['professor clash', 'section clash', 'room clash in the same week group', 'overload above the cap', 'lab in a lecture room',
  'outside the day window', 'no lunch break', 'lab start rule', 'same subject twice a day', 'part-timer single-class day'];
const CONTROLS = ['odd vs even week, same room and time', 'back-to-back meetings', 'a load exactly at the cap', 'an untouched copy'];

const sameGroup = (a, b) => !a || !b || a === b;
const lenOf = (m) => toMin(m.end) - toMin(m.start);
const at = (m, day, start) => ({ day, s: toMin(start), e: toMin(start) + lenOf(m) });
const movable = (m) => !m.isFixed && m.type !== 'OJT' && m.type !== 'NSTP' && WEEKDAYS.includes(m.day);

// Busy checks on the schedule WITHOUT the moved meeting.
const others = (all, m) => all.filter(x => x.itemId !== m.itemId);
const clashWith = (list, slot, keep) => list.some(x => keep(x) && x.day === slot.day && overlap(slot.s, slot.e, toMin(x.start), toMin(x.end)));
const sectionFree = (all, m, slot) => !clashWith(others(all, m), slot, x => x.section === m.section);
const profFree = (all, m, slot, prof = m.professor) => !prof || !clashWith(others(all, m), slot, x => x.professor === prof);
const roomFree = (all, m, slot, room, group = m.weekGroup) => !room || !clashWith(others(all, m), slot, x => x.room === room && sameGroup(x.weekGroup, group));
const available = (ctx, prof, slot) => !prof || !(ctx.unavailable.get(prof) || []).some(b => b.day === slot.day && overlap(slot.s, slot.e, toMin(b.start), toMin(b.end)));
const inWindow = (ctx, slot) => slot.s >= toMin(ctx.dayStart) && slot.e <= toMin(ctx.dayEnd);
const labOk = (ctx, m, slot) => m.type !== 'LAB' || ctx.labStarts.includes(fromMin(slot.s));
// A free continuous hour in 10:00-15:00 among `intervals` (the validator's rule; the checker's 30 minutes then holds too).
const freeHour = (intervals) => {
  const busy = intervals.map(([s, e]) => [Math.max(s, LUNCH_FROM), Math.min(e, LUNCH_TO)]).filter(([s, e]) => s < e).sort((a, b) => a[0] - b[0]);
  let t = LUNCH_FROM;
  for (const [s, e] of busy) { if (s - t >= 60) return true; t = Math.max(t, e); }
  return LUNCH_TO - t >= 60;
};
const dayIntervals = (list, day, keep, slot) => [...list.filter(x => keep(x) && x.day === day).map(x => [toMin(x.start), toMin(x.end)]), ...(slot && slot.day === day ? [[slot.s, slot.e]] : [])];
const lunchKept = (all, m, slot) => {
  const rest = others(all, m);
  return freeHour(dayIntervals(rest, slot.day, x => x.section === m.section, slot)) && (!m.professor || freeHour(dayIntervals(rest, slot.day, x => x.professor === m.professor, slot)));
};
const subjectNotThatDay = (all, m, day) => !others(all, m).some(x => x.section === m.section && x.subject === m.subject && x.day === day && x.type !== 'OJT');
const classCount = (list, prof, day) => list.filter(x => x.professor === prof && x.day === day && x.type !== 'OJT').length;
const noLoneDayFor = (ctx, list, prof, days) => !prof || !ctx.partTime.get(prof) || days.every(d => classCount(list, prof, d) !== 1);
// Every rule a clean move must keep (independent of both counters): the class's own rules and what moving it off its day leaves.
const cleanMove = (ctx, all, m, slot, room) => {
  const after = [...others(all, m), { ...m, day: slot.day, start: fromMin(slot.s), end: fromMin(slot.e), room }];
  return inWindow(ctx, slot) && labOk(ctx, m, slot) && sectionFree(all, m, slot) && profFree(all, m, slot) && roomFree(all, m, slot, room)
    && available(ctx, m.professor, slot) && subjectNotThatDay(all, m, slot.day) && lunchKept(all, m, slot)
    && noLoneDayFor(ctx, after, m.professor, [m.day, slot.day]) && (m.type !== 'LAB' || roomType(ctx, room) === 'LAB');
};
const roomType = (ctx, room) => (ctx.rooms.find(r => r.name === room) || {}).type || null;
const moveCase = (type, shouldFlag, m, slot, room, note) => ({ type, shouldFlag, move: { itemId: m.itemId, day: slot.day, start: fromMin(slot.s), room: room ?? m.room }, note: `${m.subjectCode} ${m.type} (${m.section}) -> ${slot.day} ${fromMin(slot.s)}${room && room !== m.room ? ` in ${room}` : ''}${note ? `: ${note}` : ''}` });
const starts = (ctx, m) => { const out = []; for (let s = toMin(ctx.dayStart); s + lenOf(m) <= toMin(ctx.dayEnd); s += 30) out.push(s); return out; };

const pairsOf = (all, keep) => { const ms = all.filter(movable); const out = []; for (const a of ms) for (const b of ms) if (a !== b && keep(a, b)) out.push([a, b]); return out; };

// The professor's hours for one (section, subject) pair: lecture hours + lab hours x their lab factor.
const pairHours = (all, sectionId, subjectId, partTime) => all.filter(x => x.sectionId === sectionId && x.subjectId === subjectId && x.type !== 'OJT')
  .reduce((sum, x) => sum + (x.type === 'LAB' ? x.hours * (partTime ? 0.75 : 1) : x.hours), 0);
const pairMeetings = (all, sectionId, subjectId) => all.filter(x => x.sectionId === sectionId && x.subjectId === subjectId);
const restaffCases = (ctx, all, wanted) => {
  const out = [];
  const seen = new Set();
  for (const m of all.filter(x => x.professor && x.type !== 'OJT' && x.type !== 'NSTP')) {
    const k = `${m.sectionId}|${m.subjectId}`;
    if (seen.has(k)) continue; seen.add(k);
    const meetings = pairMeetings(all, m.sectionId, m.subjectId);
    for (const q of ctx.caps.keys()) {
      if (q === m.professor) continue;
      const add = pairHours(all, m.sectionId, m.subjectId, ctx.partTime.get(q));
      const after = Math.round(((ctx.loads.get(q) || 0) + add) * 100) / 100;
      if (!wanted(after, ctx.caps.get(q))) continue;
      const free = meetings.every(x => profFree(all, x, { day: x.day, s: toMin(x.start), e: toMin(x.end) }, q) && available(ctx, q, { day: x.day, s: toMin(x.start), e: toMin(x.end) }));
      if (!free) continue;
      const list = all.map(x => (x.sectionId === m.sectionId && x.subjectId === m.subjectId ? { ...x, professor: q } : x));
      const days = [...new Set(meetings.map(x => x.day))];
      const lunch = days.every(d => freeHour(dayIntervals(list, d, x => x.professor === q)));
      const oldDays = days;
      const lone = noLoneDayFor(ctx, list, q, days) && noLoneDayFor(ctx, list, m.professor, oldDays);
      out.push({ facultyChange: { sectionId: m.sectionId, subjectId: m.subjectId, section: m.section, subject: m.subjectCode, from: m.professor, professor: q }, after, cap: ctx.caps.get(q), clean: lunch && lone });
    }
  }
  return out;
};

const candidates = (type, all, ctx) => {
  const out = [];
  const tryMove = (m, slot, room, ok, note) => { if (ok) out.push(moveCase(type, FAULTS.includes(type), m, slot, room, note)); };
  switch (type) {
    case 'professor clash':
      for (const [a, b] of pairsOf(all, (a, b) => a.professor && a.professor === b.professor && a.section !== b.section && a.day !== b.day)) {
        const slot = at(a, b.day, b.start); tryMove(a, slot, a.room, inWindow(ctx, slot) && sectionFree(all, a, slot) && roomFree(all, a, slot, a.room), `onto ${b.subjectCode} (${b.section}) of the same teacher`);
      } break;
    case 'section clash':
      for (const [a, b] of pairsOf(all, (a, b) => a.section === b.section && a.subject !== b.subject && a.professor !== b.professor && a.day !== b.day)) {
        const slot = at(a, b.day, b.start); tryMove(a, slot, a.room, inWindow(ctx, slot) && profFree(all, a, slot) && roomFree(all, a, slot, a.room), `onto ${b.subjectCode} of the same section`);
      } break;
    case 'room clash in the same week group':
      for (const [a, b] of pairsOf(all, (a, b) => a.room && b.room && a.section !== b.section && a.professor !== b.professor && sameGroup(a.weekGroup, b.weekGroup) && roomType(ctx, a.room) === roomType(ctx, b.room) && a.room !== b.room)) {
        const slot = at(a, b.day, b.start); tryMove(a, slot, b.room, inWindow(ctx, slot) && labOk(ctx, a, slot) && sectionFree(all, a, slot) && profFree(all, a, slot), `into ${b.subjectCode} (${b.section})'s room and time`);
      } break;
    case 'overload above the cap':
      for (const c of restaffCases(ctx, all, (after, cap) => after > cap)) out.push({ type, shouldFlag: true, facultyChange: c.facultyChange, note: `${c.facultyChange.subject} (${c.facultyChange.section}) to ${c.facultyChange.professor}: ${c.after} of ${c.cap} h` });
      break;
    case 'lab in a lecture room':
      for (const m of all.filter(x => movable(x) && x.type === 'LAB')) for (const r of ctx.rooms.filter(x => x.type === 'LEC')) {
        const slot = at(m, m.day, m.start); tryMove(m, slot, r.name, roomFree(all, m, slot, r.name));
      } break;
    case 'outside the day window':
      for (const m of all.filter(movable)) {
        const slot = { day: m.day, s: toMin(ctx.dayEnd) - lenOf(m) + 30, e: toMin(ctx.dayEnd) + 30 };
        tryMove(m, slot, m.room, sectionFree(all, m, slot) && profFree(all, m, slot) && roomFree(all, m, slot, m.room), 'ends 30 minutes after the day');
      } break;
    case 'no lunch break':
      for (const m of all.filter(movable)) for (const day of WEEKDAYS) for (const s of starts(ctx, m)) {
        const slot = { day, s, e: s + lenOf(m) };
        if (!overlap(slot.s, slot.e, LUNCH_FROM, LUNCH_TO)) continue;
        const covered = dayIntervals(others(all, m), day, x => x.section === m.section, slot).filter(([a, b]) => a < LUNCH_TO && b > LUNCH_FROM).sort((x, y) => x[0] - y[0]);
        let t = LUNCH_FROM; for (const [a, b] of covered) if (a <= t) t = Math.max(t, b);
        tryMove(m, slot, m.room, t >= LUNCH_TO && labOk(ctx, m, slot) && sectionFree(all, m, slot) && profFree(all, m, slot) && roomFree(all, m, slot, m.room), 'the section has no free time 10:00-15:00 that day');
      } break;
    case 'lab start rule':
      for (const m of all.filter(x => movable(x) && x.type === 'LAB')) for (const s of starts(ctx, m).filter(t => !ctx.labStarts.includes(fromMin(t)))) {
        const slot = { day: m.day, s, e: s + lenOf(m) }; tryMove(m, slot, m.room, sectionFree(all, m, slot) && profFree(all, m, slot) && roomFree(all, m, slot, m.room));
      } break;
    case 'same subject twice a day':
      for (const [a, b] of pairsOf(all, (a, b) => a.section === b.section && a.subject === b.subject && a.day !== b.day)) for (const s of starts(ctx, a)) {
        const slot = { day: b.day, s, e: s + lenOf(a) };
        tryMove(a, slot, a.room, labOk(ctx, a, slot) && sectionFree(all, a, slot) && profFree(all, a, slot) && roomFree(all, a, slot, a.room) && !overlap(slot.s, slot.e, toMin(b.start), toMin(b.end)), `the day of its ${b.type}`);
      } break;
    case 'part-timer single-class day':
      for (const m of all.filter(x => movable(x) && x.professor && ctx.partTime.get(x.professor))) for (const day of WEEKDAYS.filter(d => classCount(all, m.professor, d) === 0)) for (const s of starts(ctx, m)) {
        const slot = { day, s, e: s + lenOf(m) };
        tryMove(m, slot, m.room, inWindow(ctx, slot) && labOk(ctx, m, slot) && sectionFree(all, m, slot) && roomFree(all, m, slot, m.room) && available(ctx, m.professor, slot) && subjectNotThatDay(all, m, day), 'a weekday with only this class');
      } break;
    case 'odd vs even week, same room and time':
      for (const [a, b] of pairsOf(all, (a, b) => a.weekGroup && b.weekGroup && a.weekGroup !== b.weekGroup && a.room && b.room && roomType(ctx, a.room) === roomType(ctx, b.room))) {
        const slot = at(a, b.day, b.start); tryMove(a, slot, b.room, cleanMove(ctx, all, a, slot, b.room) && classCount(others(all, a), a.professor, b.day) > 0, `beside ${b.subjectCode} (${b.section}, ${b.weekGroup.toLowerCase()} weeks)`);
      } break;
    case 'back-to-back meetings':
      for (const [a, c] of pairsOf(all, (a, c) => a.section === c.section && a.subject !== c.subject)) {
        for (const s of [toMin(c.end), toMin(c.start) - lenOf(a)]) {
          const slot = { day: c.day, s, e: s + lenOf(a) };
          tryMove(a, slot, a.room, !(slot.day === a.day && slot.s === toMin(a.start)) && cleanMove(ctx, all, a, slot, a.room) && classCount(others(all, a), a.professor, c.day) > 0, `touching ${c.subjectCode}`);
        }
      } break;
    case 'a load exactly at the cap':
      for (const c of restaffCases(ctx, all, (after, cap) => after === cap).filter(x => x.clean)) out.push({ type, shouldFlag: false, facultyChange: c.facultyChange, note: `${c.facultyChange.subject} (${c.facultyChange.section}) to ${c.facultyChange.professor}: ${c.after} of ${c.cap} h` });
      break;
    case 'an untouched copy':
      out.push({ type, shouldFlag: false, note: 'no change' });
      break;
    default: throw new Error(`unknown case type ${type}`);
  }
  return out;
};

// The meetings after a case (the checker's side).
const applyCase = (all, c, ctx) => {
  if (c.move) {
    return all.map((x) => {
      if (x.itemId !== c.move.itemId) return x;
      const s = toMin(c.move.start);
      return { ...x, day: c.move.day, start: c.move.start, end: fromMin(s + lenOf(x)), room: c.move.room, roomType: roomType(ctx, c.move.room) || x.roomType };
    });
  }
  if (c.facultyChange) {
    const f = c.facultyChange;
    return all.map(x => (x.sectionId === f.sectionId && x.subjectId === f.subjectId ? { ...x, professor: f.professor, partTime: !!ctx.partTime.get(f.professor) } : x));
  }
  return all;
};

const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

module.exports = { FAULTS, CONTROLS, candidates, applyCase, freeHour, cleanMove, mulberry32, toMin, fromMin };
