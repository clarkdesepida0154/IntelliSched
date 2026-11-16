// Phase 10, Step 4: the planted-fault test, the replacement for a human check of the counting. With
// npm run demo:eval running and the Dean-assignment runs recorded (.demo-data/logs/phase10-ui-dean.json):
//   node scripts/eval/fault-injection.js [--ui-drafts]
// Base: copies of the 10 Dean-assignment schedules (read only). 10 fault types x 10 cases (one per base
// schedule; the case is drawn with a seeded generator from every candidate scripts/eval/fault-plant.js finds)
// and 4 clean-control types x 5 cases (bases 1-5). Each case changes exactly one thing. For each case:
//   Validator flagged: the gateway's own check of the version with the change (utils/versionCheck.js
//     checkScheduleVersion with the move or the professor change, the check the editor and the Approval page
//     use) reports a conflict the base did not have; Rule code: those conflicts' codes.
//   Checker flagged: the independent counting helper (validator-counts.js scheduleUnits) counts more
//     problems (conflicts + overload + missing hours + rule breaks) after the change than before.
// Writes docs/eval/phase10/fault_injection.csv and .demo-data/logs/phase10-fault-cases.json (the UI cases for
// the Playwright part, PHASE10_PART=faults). --ui-drafts also saves each UI case's changed copy as a Draft named
// "fault-NN" in the _test database, dated before every run (so it never becomes the term's newest Draft), for
// the Approval page check; the UI columns are filled in by --merge-ui after the Playwright part.
const fs = require('fs');
const path = require('path');
const C = require('./phase10-common');
const F = require('./fault-plant');
const { scheduleUnits } = require('./validator-counts');

const CASES = path.join(C.LOGS, 'phase10-fault-cases.json');
const OUT_CSV = path.join(C.OUT, 'fault_injection.csv');
const UI_TYPES = ['professor clash', 'section clash', 'room clash in the same week group', 'lab in a lecture room', 'outside the day window', 'part-timer single-class day'];
const UI_CONTROLS = ['odd vs even week, same room and time', 'back-to-back meetings', 'back-to-back meetings'];
const COLUMNS = ['Case', 'Fault type', 'Should be flagged', 'Validator flagged', 'Checker flagged', 'UI flagged', 'Approve blocked', 'Rule code', 'Base seed'];
const say = (line) => console.log(`[faults] ${line}`);

const problems = (meetings, options) => scheduleUnits(meetings, options).reduce((sum, u) => sum + (u.conflicts || 0) + (u.overload || 0) + (u.missingHours || 0) + (u.ruleBreaks || 0), 0);

const mergeUi = () => {
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const ui = JSON.parse(fs.readFileSync(path.join(C.LOGS, 'phase10-ui-faults.json'), 'utf8'));
  const byCase = new Map(ui.map(u => [u.case, u]));
  const rows = cases.cases.map(c => { const u = byCase.get(c.case); return [c.case, c.type, c.shouldFlag ? 1 : 0, c.validator ? 1 : 0, c.checker ? 1 : 0, u ? (u.uiFlagged ? 1 : 0) : '', u && u.approveBlocked !== null && u.approveBlocked !== undefined ? (u.approveBlocked ? 1 : 0) : '', c.codes.join(' '), c.baseSeed]; });
  C.writeCsv(OUT_CSV, COLUMNS, rows);
  say(`merged ${byCase.size} UI cases into ${path.relative(C.ROOT, OUT_CSV)}`);
};

const main = async () => {
  if (process.argv.includes('--merge-ui')) return mergeUi();
  const mongoose = await C.connect();
  const S = (p) => require(path.join(C.SERVER, 'src', p));
  S('models/SubjectCatalog'); S('models/Section'); S('models/Faculty');
  const MotherSchedule = S('models/MotherSchedule');
  const Faculty = S('models/Faculty');
  const { checkScheduleVersion, newViolations } = S('utils/versionCheck');
  const { slotOfTime } = S('utils/timeGrid');
  const { schedulingUnavailableBlocks } = S('utils/facultyAvailability');
  const ctxDb = await C.loadContext(mongoose);
  const compared = C.readCompared();
  const options = { curriculum: C.curriculumOf(compared.Section, ctxDb), capOf: C.capOf(ctxDb) };
  const facultyDocs = await Faculty.find({ isActive: true });
  const runs = JSON.parse(fs.readFileSync(path.join(C.LOGS, 'phase10-ui-dean.json'), 'utf8')).filter(r => r.scheduleId).sort((a, b) => a.run - b.run);
  if (runs.length < 10) say(`only ${runs.length} Dean-assignment schedules: the cases use what there is`);

  const bases = [];
  for (const r of runs) {
    const doc = await MotherSchedule.findById(r.scheduleId).lean();
    const policy = doc.policySnapshot;
    const classes = await C.loadClasses(r.scheduleId);
    const all = C.meetingsFromClasses(classes, ctxDb).map((m) => {
      const c = classes.find(x => x.itemId === m.itemId);
      return { ...m, sectionId: String(c.sectionId), subjectId: String(c.subjectId), roomId: c.roomId ? String(c.roomId) : null, startSlot: c.startSlot, durationSlots: c.durationSlots, isFixed: !!c.isFixed };
    });
    const loads = new Map(scheduleUnits(all, options).filter(u => u.view === 'Faculty').map(u => [u.unit, u.load]));
    const ctx = {
      rooms: ctxDb.facilities.map(f => ({ name: f.roomName, id: String(f._id), type: f.type })), loads,
      caps: new Map(facultyDocs.map(f => [f.name, f.teachingCapHours])), partTime: new Map(facultyDocs.map(f => [f.name, f.employmentType === 'PART_TIME'])),
      facultyRef: new Map(facultyDocs.map(f => [f.name, String(f._id)])), unavailable: new Map(facultyDocs.map(f => [f.name, schedulingUnavailableBlocks(f, policy)])),
      dayStart: policy.dayStart, dayEnd: policy.dayEnd, labStarts: policy.meetings?.labStartTimes || ['08:00', '11:00', '14:00']
    };
    bases.push({ run: r.run, seed: r.seed, doc, all, ctx, policy, check: await checkScheduleVersion(doc), problems: problems(all, options) });
  }

  const cases = [];
  const plant = async (type, typeIndex, k) => {
    // Base k; when it offers no candidate, the next bases in turn.
    for (let step = 0; step < bases.length; step++) {
      const b = bases[(k + step) % bases.length];
      const list = F.candidates(type, b.all, b.ctx);
      if (!list.length) continue;
      const rnd = F.mulberry32(1000 * (k + 1) + typeIndex);
      const c = list[Math.floor(rnd() * list.length)];
      const change = c.move
        ? { moves: [{ itemId: c.move.itemId, day: c.move.day, startSlot: slotOfTime(b.policy, c.move.start), roomId: c.move.room ? (b.ctx.rooms.find(r => r.name === c.move.room)?.id || null) : null }] }
        : c.facultyChange ? { facultyChanges: [{ sectionId: c.facultyChange.sectionId, subjectId: c.facultyChange.subjectId, facultyRef: b.ctx.facultyRef.get(c.facultyChange.professor) }] } : null;
      const after = change ? await checkScheduleVersion(b.doc, change) : b.check;
      const added = change ? newViolations(b.check, after) : [];
      const changed = F.applyCase(b.all, c, b.ctx);
      const checker = problems(changed, options) > b.problems;
      return { ...c, case: '', baseRun: b.run, baseSeed: b.seed, candidates: list.length, validator: added.length > 0, codes: [...new Set(added.map(v => v.code))], checker, change };
    }
    return { type, shouldFlag: F.FAULTS.includes(type), case: '', note: 'no candidate on any base schedule', validator: false, checker: false, codes: [], baseSeed: '' };
  };
  for (const [i, type] of F.FAULTS.entries()) for (let k = 0; k < 10; k++) cases.push(await plant(type, i, k));
  for (const [i, type] of F.CONTROLS.entries()) for (let k = 0; k < 5; k++) cases.push(await plant(type, 100 + i, k));
  cases.forEach((c, i) => { c.case = `C${String(i + 1).padStart(3, '0')}`; });

  // The UI cases: the first 3 of each editor-made fault type and 3 controls.
  const ui = [];
  for (const t of UI_TYPES) ui.push(...cases.filter(c => c.type === t && c.move).slice(0, 3));
  const used = new Set();
  for (const t of UI_CONTROLS) { const c = cases.find(x => x.type === t && x.move && !used.has(x.case)); if (c) { used.add(c.case); ui.push(c); } }
  if (process.argv.includes('--ui-drafts')) {
    const oldest = (await MotherSchedule.find({ academicYear: C.TERM.academicYear, semester: C.TERM.semester }).sort({ createdAt: 1 }).limit(1).lean())[0];
    for (const [n, c] of ui.entries()) {
      const b = bases.find(x => x.run === c.baseRun);
      const room = c.move.room ? b.ctx.rooms.find(r => r.name === c.move.room) : null;
      const slot = slotOfTime(b.policy, c.move.start);
      const scheduleData = b.doc.scheduleData.map((it) => {
        if (String(it._id) !== c.move.itemId) return it;
        const end = F.fromMin(F.toMin(c.move.start) + (F.toMin(it.endTime) - F.toMin(it.startTime)));
        return { ...it, day: c.move.day, startSlot: slot, startTime: c.move.start, endTime: end, ...(room ? { roomId: room.id, roomName: room.name, extraRoomKey: null } : {}) };
      });
      const { _id, createdAt, updatedAt, lastCheck, __v, generationRunId, ...rest } = b.doc;
      const name = `fault-${String(n + 1).padStart(2, '0')}`;
      await MotherSchedule.deleteMany({ academicYear: C.TERM.academicYear, semester: C.TERM.semester, version: name });
      const saved = await MotherSchedule.create({ ...rest, version: name, status: 'Draft', scheduleData, notes: [`Phase 10 planted fault ${c.case}: ${c.type}`],
        createdAt: new Date(new Date(oldest.createdAt).getTime() - (ui.length - n) * 1000) });
      c.uiDraftId = String(saved._id); c.uiDraft = name;
    }
    say(`saved ${ui.length} UI-case Drafts (fault-01..fault-${String(ui.length).padStart(2, '0')}), dated before every run`);
  }
  for (const c of ui) {
    const b = bases.find(x => x.run === c.baseRun);
    c.ui = { baseScheduleId: String(b.doc._id), baseVersion: b.doc.version, itemId: c.move.itemId, sectionId: b.all.find(m => m.itemId === c.move.itemId).sectionId, day: c.move.day, start: c.move.start, room: c.move.room, roomId: c.move.room ? b.ctx.rooms.find(r => r.name === c.move.room)?.id || null : null, draftId: c.uiDraftId || null };
  }
  fs.writeFileSync(CASES, `${JSON.stringify({ cases: cases.map(({ change, ...c }) => c), ui: ui.map(c => ({ case: c.case, type: c.type, shouldFlag: c.shouldFlag, ...c.ui })) }, null, 1)}\n`);
  C.writeCsv(OUT_CSV, COLUMNS, cases.map(c => [c.case, c.type, c.shouldFlag ? 1 : 0, c.validator ? 1 : 0, c.checker ? 1 : 0, '', '', c.codes.join(' '), c.baseSeed]));
  const tally = {};
  for (const c of cases) { const t = (tally[c.type] ||= { n: 0, validator: 0, checker: 0, none: 0 }); t.n++; t.validator += c.validator ? 1 : 0; t.checker += c.checker ? 1 : 0; if (c.note === 'no candidate on any base schedule') t.none++; }
  say(JSON.stringify(tally, null, 1));
  await mongoose.disconnect();
};

main().catch((err) => { console.error(`[faults] ${err.stack || err.message}`); process.exit(1); });
