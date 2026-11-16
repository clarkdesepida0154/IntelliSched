// Phase 10: what the manual schedule, the runs and the planted-fault test share. Reads the evaluation
// database (intellisched_eval_test, the demo started by `npm run demo:eval`); writes nothing to it.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const OUT = path.join(ROOT, 'docs', 'eval', 'phase10');
const LOGS = path.join(ROOT, '.demo-data', 'logs');
const TERM = { academicYear: '2025-2026', semester: 2 };
const serverRequire = createRequire(path.join(SERVER, 'package.json'));
const DAY_SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const WEEK_WORD = { ODD: 'Odd', EVEN: 'Even' };

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (file, header, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[header, ...rows].map(r => r.map(csvCell).join(',')).join('\n')}\n`);
};
const readCsv = (file) => {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
};

const evalDb = () => {
  const run = fs.existsSync(path.join(ROOT, '.demo-data', 'run.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, '.demo-data', 'run.json'), 'utf8')) : null;
  const db = 'intellisched_eval_test';
  if (run && run.database !== db) throw new Error(`The running demo is ${run.database}, not the evaluation demo (npm run demo:eval).`);
  return { db, uri: `mongodb://127.0.0.1:${run?.ports?.mongo || 27037}/${db}`, run };
};
const connect = async () => {
  const mongoose = serverRequire('mongoose');
  const { db, uri } = evalDb();
  if (!/_test$/.test(db)) throw new Error(`Refusing the database "${db}".`);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  return mongoose;
};

const classType = (c) => (c.isNstp ? 'NSTP' : c.classType);
const classKey = (section, subjectId, type) => `${section}|${subjectId}|${type}`;

// The term as the database holds it: sections, faculty, rooms, catalog, and each section's curriculum
// hours per (subject, type) for "Missing hours".
const loadContext = async (mongoose) => {
  const dbh = mongoose.connection.db;
  const sections = (await dbh.collection('sections').find({ isActive: true }).toArray()).map(s => ({ ...s, _id: String(s._id) }));
  const faculty = (await dbh.collection('faculty').find({}).toArray()).filter(f => f.isActive !== false && f.status !== 'ARCHIVED');
  const facilities = await dbh.collection('facilities').find({ isActive: true }).toArray();
  const catalog = new Map((await dbh.collection('subject_catalog').find({}).toArray()).map(s => [String(s._id), s]));
  const roomType = new Map(facilities.map(f => [f.roomName, f.type]));
  const people = new Map(faculty.map(f => [f.name, { partTime: f.employmentType === 'PART_TIME', cap: f.teachingCapHours ?? (f.employmentType === 'PART_TIME' ? 40 : 21) }]));
  return { sections, faculty, facilities, catalog, roomType, people };
};

const tbaLabel = (key) => { const m = /^EXTRA-(LAB|LEC)-(\d+)$/.exec(key || ''); return m ? `TBA room ${m[2]} (${m[1] === 'LAB' ? 'lab' : 'lecture'})` : null; };
// One saved schedule's classes (outputs.classes) -> the counting helper's meetings.
const meetingsFromClasses = (classes, ctx) => classes.filter(c => c.day && c.startTime && c.endTime).map((c) => {
  const room = c.roomKey ? (c.roomName || tbaLabel(c.extraRoomKey) || String(c.roomKey)) : null;
  const rt = !room ? null : /^EXTRA-LAB/.test(c.extraRoomKey || '') ? 'LAB' : /^EXTRA-LEC/.test(c.extraRoomKey || '') ? 'LEC' : ctx.roomType.get(room) || null;
  return {
    day: c.day, start: c.startTime, end: c.endTime, professor: c.facultyRef ? c.facultyName : null,
    partTime: c.employmentType === 'PART_TIME', section: c.sectionCode, subject: String(c.subjectId), subjectCode: c.subjectCode,
    type: classType(c), room, roomType: rt, weekGroup: c.weekGroup || null, hours: c.hours, itemId: c.itemId
  };
});
const loadClasses = async (scheduleId) => {
  const { loadScheduleOutputs } = require(path.join(SERVER, 'src', 'controllers', 'outputsController.js'));
  const { outputs, error } = await loadScheduleOutputs({ ...TERM, scheduleId: String(scheduleId) });
  if (error) throw new Error(error.payload?.message || 'outputs failed');
  return outputs.classes || [];
};

// Missing hours: per section, the curriculum's hours of the compared (subject, type) pairs; NSTP and OJT not checked.
const curriculumOf = (compared, ctx) => {
  const map = new Map();
  for (const key of compared) {
    const [section, subjectId, type] = key.split('|');
    if (type !== 'LEC' && type !== 'LAB') continue;
    const s = ctx.catalog.get(subjectId);
    if (!s || s.isPracticum || s.type === 'NSTP') continue;
    if (!map.has(section)) map.set(section, new Map());
    const hours = type === 'LAB' ? (s.labHours || 0) : (s.lecHours || 0);
    map.get(section).set(subjectId, (map.get(section).get(subjectId) || 0) + hours);
  }
  return map;
};
const capOf = (ctx) => (name, partTime) => (ctx.people.get(name)?.cap ?? (partTime ? 40 : 21));

// The compared classes per view (written by manual-schedule.js), and the filter both sides go through.
const COMPARED_FILE = path.join(OUT, 'compared_classes.json');
const readCompared = () => { const j = JSON.parse(fs.readFileSync(COMPARED_FILE, 'utf8')); return Object.fromEntries(Object.entries(j.views).map(([v, keys]) => [v, new Set(keys)])); };
const onlyCompared = (meetings, set) => meetings.filter(m => set.has(classKey(m.section, m.subject, m.type)));

const meetingRow = (source, run, m, ctx) => [source, run, m.professor || 'TBA', m.subjectCode || ctx.catalog.get(m.subject)?.subjectCode || m.subject, m.section, m.type,
  DAY_SHORT[m.day] || m.day, m.start, m.end, m.room || 'TBA', WEEK_WORD[m.weekGroup] || 'All'];
const MEETING_COLUMNS = ['Source', 'Run', 'Professor', 'Subject', 'Section', 'Type', 'Day', 'Start', 'End', 'Room', 'Week group'];

module.exports = { ROOT, SERVER, OUT, LOGS, TERM, serverRequire, writeCsv, readCsv, connect, evalDb, loadContext, meetingsFromClasses, loadClasses, classKey, classType, curriculumOf, capOf, readCompared, onlyCompared, meetingRow, MEETING_COLUMNS, COMPARED_FILE };
