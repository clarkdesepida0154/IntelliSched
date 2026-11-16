// Phase 10, Step 1: the office's manual schedule of 2nd Sem AY 2025-26, digitised and counted.
//   ../intellisched_backend/.venv/Scripts/python scripts/eval/dump_docx_tables.py   (first: the Word tables)
//   node scripts/eval/manual-schedule.js        (the evaluation demo running: npm run demo:eval)
// Views: faculty = the transcription of Faculty Schedule.pdf (docs/data/past_class_blocks.csv), section =
// Class Schedule.docx, room = Room Schedule.docx. A meeting counts only when its class (section, subject,
// LEC/LAB) is also in the IntelliSched term (the evaluation database). Writes docs/eval/phase10/:
//   name_map.csv  not_compared.csv  manual_crosscheck.csv  compared_classes.json
//   meetings.csv (Source Manual, Run 0)  schedule_units.csv (the Manual rows; the run rows are added later)
const fs = require('fs');
const path = require('path');
const C = require('./phase10-common');
const P = require('./manual-parse');
const { scheduleUnits, unitCells, UNIT_COLUMNS } = require('./validator-counts');

const TABLES = path.join(C.OUT, 'manual_tables.json');
const BLOCKS_CSV = path.join(C.ROOT, 'docs', 'data', 'past_class_blocks.csv');
const TERM_FILE = path.join(C.ROOT, 'docs', 'eval', 'term_2nd_sem_AY2025_26_eval.json');
const TERM_LABEL = '2nd Sem AY 2025-26';
const DOC = { faculty: 'Faculty Schedule.pdf (transcription)', section: 'Class Schedule.docx', room: 'Room Schedule.docx' };
const say = (line) => console.log(`[manual] ${line}`);

const main = async () => {
  const mongoose = await C.connect();
  const ctx = await C.loadContext(mongoose);
  const first = await mongoose.connection.db.collection('mother_schedules').findOne({ version: 'v1', 'scheduleData.0': { $exists: true } });
  if (!first) throw new Error('No generated Draft v1 in the evaluation database.');
  const sysClasses = await C.loadClasses(first._id);
  await mongoose.disconnect();

  // The IntelliSched term: each section's subjects and their class types.
  const sys = new Map(); const sysKeys = new Set();
  for (const c of sysClasses) {
    if (!sys.has(c.sectionCode)) sys.set(c.sectionCode, new Map());
    const subjects = sys.get(c.sectionCode);
    const id = String(c.subjectId);
    if (!subjects.has(id)) subjects.set(id, { subjectId: id, subjectCode: c.subjectCode, subjectTitle: c.subjectTitle, types: new Set() });
    subjects.get(id).types.add(C.classType(c));
    sysKeys.add(C.classKey(c.sectionCode, id, C.classType(c)));
  }
  const term = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  const sectionOf = P.sectionMapper(term.sections);
  const teacherOf = P.teacherMapper(ctx.faculty);
  const names = new Map();
  const note = (kind, doc, printed, system, rule) => {
    const k = `${kind}|${doc}|${printed}`;
    if (!names.has(k)) names.set(k, { kind, doc, printed, system: system || '', rule, count: 0 });
    names.get(k).count++;
  };
  const notCompared = [];
  const skip = (doc, b, reason) => void notCompared.push([doc, b.sectionPrinted || '', `${b.code || ''} ${b.title || ''}`.trim(), b.kind || '', b.day || '', b.start || '', b.end || '', b.teacher || '', b.roomPrinted || '', reason]);

  // A printed block -> a meeting of the IntelliSched term, or a reason it is not compared.
  const resolve = (doc, b) => {
    if (!b.section) return skip(doc, b, b.sectionPrinted ? 'section not mapped' : 'no section printed');
    const match = P.matchSubject({ code: b.code, title: b.title }, [...(sys.get(b.section) || new Map()).values()]);
    if (!match) return skip(doc, b, 'subject not in the IntelliSched term for this section');
    const s = match.subject;
    note('Subject', doc, `${b.code} ${b.title}`.trim(), `${s.subjectCode} ${s.subjectTitle}`, `title match ${match.score.toFixed(2)}`);
    const type = s.types.has('NSTP') ? 'NSTP' : s.types.has('OJT') ? 'OJT' : b.kind || (s.types.size === 1 && s.types.has('LEC') ? 'LEC' : null);
    if (!type) return skip(doc, b, 'LEC or LAB not printed');
    if (!sysKeys.has(C.classKey(b.section, s.subjectId, type))) return skip(doc, b, `${type} of this subject not in the IntelliSched term`);
    const professor = b.professor || null;
    return { doc, day: b.day, start: b.start, end: b.end, hours: b.hours, professor, partTime: professor ? !!ctx.people.get(professor)?.partTime : false,
      section: b.section, subject: s.subjectId, subjectCode: s.subjectCode, type, room: b.room || null, roomType: b.room ? ctx.roomType.get(b.room) || null : null,
      weekGroup: b.weekGroup && b.weekGroup !== 'ALL' ? b.weekGroup : null };
  };
  const teacher = (doc, printed) => {
    if (!printed) return null;
    const t = teacherOf(printed);
    note('Teacher', doc, printed, t.name, t.name ? t.rule : `unmapped: ${t.rule}`);
    return t.name;
  };

  // ---- section view: Class Schedule.docx
  const tables = JSON.parse(fs.readFileSync(TABLES, 'utf8'));
  const sectionView = [];
  for (const t of tables.class.tables) {
    const label = P.headingLabel(t.heading); const section = sectionOf(label);
    note('Section', DOC.section, label, section, section ? 'office label' : 'unmapped');
    for (const blk of P.tableBlocks(t.rows)) {
      const c = P.parseCell(blk.lines);
      const b = { ...blk, ...c, sectionPrinted: label, section, professor: teacher(DOC.section, c.teacher) };
      const m = resolve(DOC.section, b); if (m) sectionView.push(m);
    }
  }
  // ---- room view: Room Schedule.docx (the same meeting in the odd and the even table = every week)
  const roomRaw = [];
  for (const t of tables.room.tables) {
    const h = P.roomHeading(t.heading);
    note('Room', DOC.room, h.printedRoom, h.room, h.room ? 'room rule' : 'unmapped');
    for (const blk of P.tableBlocks(t.rows)) {
      const c = P.parseCell(blk.lines);
      const section = c.sectionText ? sectionOf(c.sectionText) : null;
      if (c.sectionText) note('Section', DOC.room, c.sectionText, section, section ? 'office label' : 'unmapped');
      const b = { ...blk, ...c, sectionPrinted: c.sectionText, section, professor: teacher(DOC.room, c.teacher), room: h.room, roomPrinted: h.printedRoom, weekGroup: h.weekGroup };
      if (!h.room) { skip(DOC.room, b, 'room not mapped'); continue; }
      const m = resolve(DOC.room, b); if (m) roomRaw.push({ ...m, weekGroup: h.weekGroup });
    }
  }
  const roomView = [];
  const byMeeting = new Map();
  for (const m of roomRaw) {
    const k = [m.room, m.section, m.subject, m.type, m.day, m.start, m.end].join('|');
    if (!byMeeting.has(k)) byMeeting.set(k, []);
    byMeeting.get(k).push(m);
  }
  for (const list of byMeeting.values()) {
    const groups = new Set(list.map(m => m.weekGroup));
    if (groups.has('ALL') || (groups.has('ODD') && groups.has('EVEN'))) roomView.push({ ...list[0], weekGroup: null });
    else roomView.push({ ...list[0], weekGroup: list[0].weekGroup });
  }
  // ---- faculty view: the transcription of the 22 SF-029 pages
  const facultyView = [];
  const surnames = new Map();
  for (const f of ctx.faculty) { const s = P.teacherMapper([f])(`X ${f.name.replace(/,.*$/, '').split(/\s+/).filter(w => !/^(jr|sr|phd)\.?$/i.test(w)).pop()}`); if (s.name) surnames.set(s.name, f.name); }
  for (const r of C.readCsv(BLOCKS_CSV).filter(x => x.semester === TERM_LABEL)) {
    const b = { day: r.day, start: r.start, end: r.end, hours: Number(r.hours), code: r.code, title: r.title, kind: ['LEC', 'LAB'].includes(r.kind) ? r.kind : null, teacher: r.faculty, sectionPrinted: r.section_as_printed };
    if (r.level !== 'UNDERGRAD') { skip(DOC.faculty, b, 'graduate class'); continue; }
    if (!['LEC', 'LAB', 'OJT', 'UNSPECIFIED'].includes(r.kind)) { skip(DOC.faculty, b, `duty block (${r.kind.toLowerCase()})`); continue; }
    if (r.section_as_printed && !/^BS(IT|CS)\b/i.test(r.section_as_printed)) { skip(DOC.faculty, b, 'other college'); continue; }
    const person = ctx.faculty.find(f => P.teacherMapper([f])(`X. ${r.faculty}`).name);
    note('Teacher', DOC.faculty, r.faculty, person && person.name, person ? 'surname' : 'unmapped: not on the faculty list');
    if (!person) { skip(DOC.faculty, b, 'teacher not on the faculty list'); continue; }
    const section = r.section_as_printed ? sectionOf(r.section_as_printed) : null;
    if (r.section_as_printed) note('Section', DOC.faculty, r.section_as_printed, section, section ? 'office label' : 'unmapped');
    const m = resolve(DOC.faculty, { ...b, section, professor: person.name });
    if (m) facultyView.push(m);
  }

  // ---- the compared classes per view; the IntelliSched classes the manual view lacks are listed too
  const keysOf = (list) => new Set(list.map(m => C.classKey(m.section, m.subject, m.type)));
  const views = { Faculty: keysOf(facultyView), Section: keysOf(sectionView), Room: keysOf(roomView) };
  const subjectCode = (id) => ctx.catalog.get(id)?.subjectCode || id;
  const sectionKeys = views.Section;
  for (const k of sysKeys) {
    if (sectionKeys.has(k)) continue;
    const [section, id, type] = k.split('|');
    notCompared.push(['IntelliSched term', section, subjectCode(id), type, '', '', '', '', '', 'class not found in Class Schedule.docx']);
  }
  fs.writeFileSync(C.COMPARED_FILE, `${JSON.stringify({ note: 'class keys section|subjectId|type compared in each view (Phase 10)', views: Object.fromEntries(Object.entries(views).map(([v, s]) => [v, [...s].sort()])) }, null, 1)}\n`);

  // ---- cross-check of the three documents: the same class with other days or times (or rooms)
  const timesOf = (list, key, withRoom = false) => [...new Set(list.filter(m => C.classKey(m.section, m.subject, m.type) === key)
    .map(m => `${m.day.slice(0, 3)} ${m.start}-${m.end}${withRoom ? ` ${m.room}${m.weekGroup ? ` (${m.weekGroup.toLowerCase()})` : ''}` : ''}`))].sort();
  const cross = [];
  const allKeys = new Set([...views.Faculty, ...views.Section, ...views.Room]);
  for (const key of [...allKeys].sort()) {
    const [section, id, type] = key.split('|');
    const f = timesOf(facultyView, key); const s = timesOf(sectionView, key); const r = timesOf(roomView, key);
    const rr = timesOf(roomView, key, true);
    const diffs = [];
    const differ = (a, b) => a.length && b.length && a.join(';') !== b.join(';');
    if (differ(f, s)) diffs.push('faculty vs section: other day or time');
    if (differ(s, r)) diffs.push('section vs room: other day or time');
    if (differ(f, r)) diffs.push('faculty vs room: other day or time');
    if (!s.length) diffs.push('not in the section view');
    const roomsPerTime = new Map();
    for (const m of roomView.filter(x => C.classKey(x.section, x.subject, x.type) === key)) {
      const t = `${m.day} ${m.start}`; if (!roomsPerTime.has(t)) roomsPerTime.set(t, new Set()); roomsPerTime.get(t).add(m.room);
    }
    if ([...roomsPerTime.values()].some(x => x.size > 1)) diffs.push('room view: two rooms at one time');
    if (diffs.length) cross.push([section, subjectCode(id), type, f.join('; '), s.join('; '), rr.join('; '), diffs.join(' | ')]);
  }

  // ---- meetings.csv (Manual, run 0): the section view, each meeting with its room(s) from the room view
  const meetingRows = [];
  for (const m of sectionView) {
    const rooms = roomView.filter(x => x.section === m.section && x.subject === m.subject && x.type === m.type && x.day === m.day && x.start === m.start && x.end === m.end);
    if (!rooms.length) meetingRows.push(C.meetingRow('Manual', 0, m, ctx));
    for (const r of rooms) meetingRows.push(C.meetingRow('Manual', 0, { ...m, room: r.room, weekGroup: r.weekGroup }, ctx));
  }
  // ---- schedule_units.csv, the Manual rows: each view from its own document
  const curriculum = C.curriculumOf(views.Section, ctx);
  const options = { curriculum, capOf: C.capOf(ctx) };
  const unitRows = [];
  for (const [view, list] of [['Faculty', facultyView], ['Section', sectionView], ['Room', roomView]]) {
    for (const r of scheduleUnits(list, options).filter(x => x.view === view)) unitRows.push(unitCells(r, 'Manual', 0));
  }

  const nameRows = [...names.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.doc.localeCompare(b.doc) || a.printed.localeCompare(b.printed))
    .map(n => [n.kind, n.doc, n.printed, n.system || 'UNMAPPED', n.rule, n.count]);
  C.writeCsv(path.join(C.OUT, 'name_map.csv'), ['Kind', 'Document', 'Printed', 'System', 'Rule', 'Blocks'], nameRows);
  C.writeCsv(path.join(C.OUT, 'not_compared.csv'), ['Document', 'Section (printed)', 'Subject (printed)', 'Type', 'Day', 'Start', 'End', 'Teacher (printed)', 'Room (printed)', 'Reason'], notCompared);
  C.writeCsv(path.join(C.OUT, 'manual_crosscheck.csv'), ['Section', 'Subject', 'Type', 'Faculty view', 'Section view', 'Room view', 'Difference'], cross);
  C.writeCsv(path.join(C.OUT, 'meetings.csv'), C.MEETING_COLUMNS, meetingRows);
  C.writeCsv(path.join(C.OUT, 'schedule_units.csv'), UNIT_COLUMNS, unitRows);

  const count = (rows, i) => rows.reduce((acc, r) => { acc[r[i]] = (acc[r[i]] || 0) + 1; return acc; }, {});
  const summary = {
    meetings: { faculty: facultyView.length, section: sectionView.length, room: roomView.length },
    comparedClasses: Object.fromEntries(Object.entries(views).map(([v, s]) => [v, s.size])), systemClasses: sysKeys.size,
    notCompared: count(notCompared, 9), notComparedByDocument: count(notCompared, 0),
    names: { mapped: nameRows.filter(r => r[3] !== 'UNMAPPED').length, unmapped: nameRows.filter(r => r[3] === 'UNMAPPED').length, unmappedByKind: count(nameRows.filter(r => r[3] === 'UNMAPPED'), 0) },
    crosscheck: { classes: cross.length, byDifference: count(cross.flatMap(r => r[6].split(' | ').map(d => [d])), 0) },
    units: count(unitRows, 0)
  };
  fs.mkdirSync(C.LOGS, { recursive: true });
  fs.writeFileSync(path.join(C.LOGS, 'phase10-manual-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  say(JSON.stringify(summary, null, 1));
};

main().catch((err) => { console.error(`[manual] ${err.stack || err.message}`); process.exit(1); });
