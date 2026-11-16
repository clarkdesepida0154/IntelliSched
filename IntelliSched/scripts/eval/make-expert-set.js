// Phase 9: after the 20 runs. Picks each mode's median-fitness run, assigns the two audited schedules to
// P and Q at random (seeded by the clock, saved in the key), prints them with the existing exporters
// and layouts (nothing in a file name, title or footer names the source) and writes the validator's
// counts in the experts' checklist shape. Reads the evaluation demo's database (the demo must be
// running: `npm run demo:eval`), writes only files.
//   node scripts/eval/make-expert-set.js [--db intellisched_eval_test] [--uri mongodb://...]
//   docs/eval/expert_set/{P,Q}-Faculty.pdf  -Sections.pdf  -Rooms-Odd.pdf  -Rooms-Even.pdf  -classes.xlsx
//   docs/eval/KEY_DO_NOT_SHARE.json         docs/eval/validator_{faculty,section,room}.csv
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { writeXlsx } = require('./xlsx');
const { countAll } = require('./validator-counts');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const serverRequire = createRequire(path.join(SERVER, 'package.json'));
const mongoose = serverRequire('mongoose');
const EVAL = path.join(ROOT, 'docs', 'eval');
const SET_DIR = path.join(EVAL, 'expert_set');
const RUNS = path.join(ROOT, '.demo-data', 'logs', 'ga-eval-runs.json');

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const db = valueOf('--db', 'intellisched_eval_test');
const uri = valueOf('--uri', `mongodb://127.0.0.1:27037/${db}`);
const say = (line) => console.log(`[expert-set] ${line}`);
if (!/_test$/.test(db)) throw new Error(`Refusing the database "${db}": only a _test database.`);

// The run closest to the median fitness of its mode; with an even count the two middle runs are equally
// close and the lower seed wins (the rule fixed before any result).
const medianPick = (runs) => {
  const values = runs.map(r => r.fitness).sort((a, b) => a - b);
  const mid = values.length / 2;
  const median = values.length % 2 ? values[(values.length - 1) / 2] : (values[mid - 1] + values[mid]) / 2;
  const best = [...runs].sort((a, b) => Math.abs(a.fitness - median) - Math.abs(b.fitness - median) || a.seed - b.seed)[0];
  return { run: best, median };
};

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const csv = (header, rows) => `${[header.join(','), ...rows.map(r => r.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n')}\n`;
const tbaLabel = (key) => { const m = /^EXTRA-(LAB|LEC)-(\d+)$/.exec(key || ''); return m ? `TBA room ${m[2]} (${m[1] === 'LAB' ? 'lab' : 'lecture'})` : key; };
const weekWords = { ODD: 'Odd weeks', EVEN: 'Even weeks' };

const main = async () => {
  const log = JSON.parse(fs.readFileSync(RUNS, 'utf8'));
  const picks = {};
  for (const mode of ['memetic', 'baseline']) {
    const runs = log.runs.filter(r => r.mode === mode && r.fitness !== null);
    if (!runs.length) throw new Error(`No ${mode} runs recorded.`);
    picks[mode] = medianPick(runs);
    say(`${mode}: ${runs.length} runs, median fitness ${picks[mode].median} -> seed ${picks[mode].run.seed}`);
  }
  // P and Q: random, seeded by the current time.
  const assignmentSeed = Date.now();
  const basicIsP = mulberry32(assignmentSeed)() < 0.5;
  const codes = { P: basicIsP ? 'baseline' : 'memetic', Q: basicIsP ? 'memetic' : 'baseline' };

  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  const { loadScheduleOutputs } = require(path.join(SERVER, 'src', 'controllers', 'outputsController.js'));
  const { buildExport } = require(path.join(SERVER, 'src', 'exports'));
  const TERM = log.term;

  // The curriculum hours per section (lecture + lab, from the catalog and the mappings), for S2.
  const dbh = mongoose.connection.db;
  const catalog = new Map((await dbh.collection('subject_catalog').find({}).toArray()).map(s => [String(s._id), s]));
  const mappings = await dbh.collection('curriculum_mappings').find({ semester: TERM.semester === 2 ? '2nd Semester' : '1st Semester' }).toArray();
  const sections = await dbh.collection('sections').find({ isActive: true }).toArray();
  const facilities = await dbh.collection('facilities').find({ isActive: true }).toArray();
  const facilityType = new Map(facilities.map(f => [String(f._id), f.type]));
  const yearLabel = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
  const curriculum = new Map();
  for (const s of sections) {
    const subjects = new Map();
    for (const m of mappings) {
      if (!(m.program === s.program || m.program === 'Both') || m.yearLevel !== yearLabel[s.yearLevel - 1]) continue;
      if (!((m.track || 'CORE') === 'CORE' || m.track === s.track)) continue;
      const subj = catalog.get(String(m.subject));
      if (!subj || subj.isPracticum || subj.type === 'NSTP') continue;
      subjects.set(String(subj._id), (subj.lecHours || 0) + (subj.labHours || 0));
    }
    curriculum.set(s.sectionCode, subjects);
  }

  const key = { assignedAt: new Date(assignmentSeed).toISOString(), assignmentSeed, rule: 'Basic is P when the first draw of mulberry32(seed) is below 0.5, otherwise Q.', schedules: {} };
  const facultyRows = []; const sectionRows = []; const roomRows = [];
  fs.mkdirSync(SET_DIR, { recursive: true });
  for (const code of ['P', 'Q']) {
    const mode = codes[code];
    const run = picks[mode].run;
    const { outputs, error } = await loadScheduleOutputs({ academicYear: TERM.academicYear, semester: TERM.semester, scheduleId: run.scheduleId });
    if (error) throw new Error(error.payload.message);
    key.schedules[code] = { group: mode === 'baseline' ? 'B (Basic GA)' : 'C (Memetic GA)', mode, seed: run.seed, fitness: run.fitness, hFinal: run.hFinal };
    say(`${code} = ${key.schedules[code].group}, seed ${run.seed}`);

    const file = async (name, view, weekGroup) => {
      const out = await buildExport({ outputs, view, format: 'pdf', weekGroup });
      fs.writeFileSync(path.join(SET_DIR, name), out.buffer);
      say(`${name}: ${out.pages} page(s)`);
    };
    await file(`${code}-Faculty.pdf`, 'teachers-program', 'ALL');
    await file(`${code}-Sections.pdf`, 'class-schedule', 'ALL');
    await file(`${code}-Rooms-Odd.pdf`, 'room-schedule', 'ODD');
    await file(`${code}-Rooms-Even.pdf`, 'room-schedule', 'EVEN');

    const placed = (outputs.classes || []).filter(c => c.day && c.startTime && c.endTime);
    const roomName = (c) => (c.roomKey ? (c.roomName || tbaLabel(c.extraRoomKey)) : '');
    writeXlsx(path.join(SET_DIR, `${code}-classes.xlsx`), 'Classes', [
      ['Professor', 'FT/PT', 'Subject', 'Section', 'Type', 'Day', 'Start', 'End', 'Room', 'Week group', 'Hours'],
      ...placed.map(c => [c.facultyRef ? c.facultyName : 'TBA', c.employmentType ? (c.employmentType === 'PART_TIME' ? 'PT' : 'FT') : '',
        `${c.subjectCode} ${c.subjectTitle}`.trim(), c.sectionLabel || c.sectionCode, c.isNstp ? 'NSTP' : c.classType, c.day, c.startTime, c.endTime,
        roomName(c), weekWords[c.weekGroup] || 'Every week', c.hours])
    ]);

    const meetings = placed.map(c => ({
      day: c.day, start: c.startTime, end: c.endTime,
      professor: c.facultyRef ? c.facultyName : null, partTime: c.employmentType === 'PART_TIME',
      section: c.sectionCode, subject: String(c.subjectId), type: c.isNstp ? 'NSTP' : c.classType,
      room: c.roomKey, roomType: c.roomKey ? (/^EXTRA-LAB/.test(c.roomKey) ? 'LAB' : /^EXTRA-LEC/.test(c.roomKey) ? 'LEC' : facilityType.get(String(c.roomKey)) || null) : null,
      weekGroup: c.weekGroup || null, hours: c.hours
    }));
    const counts = countAll(meetings, { curriculum });
    for (const r of counts.faculty) facultyRows.push([code, r.professor, r.partTime ? 'PT' : 'FT', r.load, r.F1, r.F2, r.F3, r.F4, r.F5]);
    for (const r of counts.sections) sectionRows.push([code, r.section, r.S1, r.S2, r.S3, r.S4, r.S5, r.S6]);
    const keyName = new Map(facilities.map(f => [String(f._id), f.roomName]));
    const seen = new Set(counts.rooms.map(r => r.room));
    for (const r of counts.rooms) roomRows.push([code, keyName.get(String(r.room)) || tbaLabel(r.room), r.R1, r.R2, r.R3]);
    for (const f of facilities) if (!seen.has(String(f._id))) roomRows.push([code, f.roomName, 0, 0, 0]);
  }
  await mongoose.disconnect();

  const byName = (a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1]));
  fs.writeFileSync(path.join(EVAL, 'validator_faculty.csv'), csv(['Schedule', 'Professor', 'FT/PT', 'Load (h)', 'F1', 'F2', 'F3', 'F4', 'F5'], facultyRows.sort(byName)));
  fs.writeFileSync(path.join(EVAL, 'validator_section.csv'), csv(['Schedule', 'Section', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'], sectionRows.sort(byName)));
  fs.writeFileSync(path.join(EVAL, 'validator_room.csv'), csv(['Schedule', 'Room', 'R1', 'R2', 'R3'], roomRows.sort(byName)));
  fs.writeFileSync(path.join(EVAL, 'KEY_DO_NOT_SHARE.json'), `${JSON.stringify(key, null, 2)}\n`);
  say('Done: the print sets, the three validator files and the key.');
};

main().catch((err) => { console.error(`[expert-set] ${err.message}`); process.exit(1); });
