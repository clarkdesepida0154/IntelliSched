// Phase 10, Step 2: IntelliSched's faculty assignment = what the office gets if it accepts IntelliSched's
// advice. With the evaluation demo running (npm run demo:eval, the held-out model copy in
// .demo-data/models/intellisched_eval_test/, saved by heldout_model.py):
//   node scripts/eval/assignment.js            plan only: reads the ranking the screen shows (the gateway's
//                                              batch recommendations, as the TEST Dean) and replays the Overload
//                                              Guardian's own rule (the lock route's code: utils/load.js on the
//                                              term's other locks); writes assignment_classes.csv,
//                                              assignment_faculty.csv and .demo-data/logs/phase10-assignment-plan.json
//   node scripts/eval/assignment.js --lock     then applies the plan through POST /schedule/lock, the route the
//                                              Recommendations page's Assign button calls (accept = the top pick,
//                                              override = a lower pick because the Guardian refused the ones above),
//                                              and checks that the Guardian answered as planned. Writes only through
//                                              the gateway, only to the _test database.
// The 70 test classes: the Majors of 2nd Sem AY 2025-26 in the held-out test set (docs/ml/private dataset),
// in the order Assign Faculty lists them (sections by code, then subjects by code); every other class
// (GenEd, coordinators, OJT) keeps the Dean's teacher.
const fs = require('fs');
const path = require('path');
const C = require('./phase10-common');
const P = require('./manual-parse');

const RANKINGS = path.join(C.LOGS, 'phase10-heldout-rankings.json');
const PLAN = path.join(C.LOGS, 'phase10-assignment-plan.json');
const say = (line) => console.log(`[assignment] ${line}`);
const round2 = (n) => Math.round(n * 100) / 100;

const api = (run) => {
  const base = `http://localhost:${run.ports.gateway}/api`;
  return async (method, route, body, token) => {
    const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
};

// Reciprocal rank of the positive with ties at their average rank.
const rrOf = (values, positive) => {
  const v = values[positive];
  const better = values.filter(x => x > v).length; const tied = values.filter(x => x === v).length;
  return 1 / (better + (tied + 1) / 2);
};
const harmonic = (n) => { let s = 0; for (let i = 1; i <= n; i++) s += 1 / i; return s; };

const main = async () => {
  const doLock = process.argv.includes('--lock');
  const { run } = C.evalDb();
  const secrets = JSON.parse(fs.readFileSync(path.resolve(C.ROOT, run.secretsFile || '.demo-data/demo-secrets.json'), 'utf8'));
  const call = api(run);
  const login = await call('POST', '/auth/login', { username: secrets.deanEmail, password: secrets.deanPassword });
  if (login.status !== 200) throw new Error(`login ${login.status}`);
  const token = login.data.token;

  const mongoose = await C.connect();
  const S = (p) => require(path.join(C.SERVER, 'src', p));
  S('models/SubjectCatalog'); S('models/Section'); S('models/Faculty');
  const { loadTermInputs } = S('utils/termInputs');
  const { buildTermAssignments, namesSubject } = S('utils/termAssignments');
  const { facultyLoad, weightedHoursOf } = S('utils/load');
  const ctx = await C.loadContext(mongoose);
  const inputs = await loadTermInputs(C.TERM);
  const { policy, faculty, pairs } = inputs;
  let locks = inputs.locks.map(l => (l.toObject ? l.toObject() : { ...l }));

  const teacherOf = P.teacherMapper(ctx.faculty);
  const nameOfSurname = (s) => teacherOf(`X. ${s}`).name;
  const ranked = JSON.parse(fs.readFileSync(RANKINGS, 'utf8')).classes;
  const subjectByCode = new Map();
  for (const s of ctx.catalog.values()) if (!subjectByCode.has(s.subjectCode) || s.type === 'Major') subjectByCode.set(s.subjectCode, s);
  const sectionByCode = new Map(ctx.sections.map(s => [s.sectionCode, s]));

  // The ranking the screen shows (Assign Faculty / Recommendations read the same batch answer).
  const batch = await call('POST', '/schedule/recommendations/batch', C.TERM, token);
  if (batch.status !== 200) throw new Error(`batch recommendations ${batch.status} ${JSON.stringify(batch.data).slice(0, 300)}`);
  const served = new Map((batch.data.predictions || []).map(p => [`${p.subjectId || ''}|${p.subjectCode}`, p]));
  const servedFor = (subject) => [...served.values()].find(p => String(p.subjectId) === String(subject._id)) || served.get(`|${subject.subjectCode}`) || [...served.values()].find(p => p.subjectCode === subject.subjectCode);

  const lockIndex = (sectionCode, subject) => locks.findIndex(l => l.sectionCode === sectionCode && namesSubject(l, subject._id, subject.subjectCode));
  const guardian = (person, sectionCode, subject) => {
    const others = locks.filter(l => !(l.sectionCode === sectionCode && namesSubject(l, subject._id, subject.subjectCode)));
    const assignments = buildTermAssignments({ faculty: [person], pairs, locks: others }).get(String(person._id)) || [];
    const current = facultyLoad(person, assignments, policy);
    const add = weightedHoursOf(subject, person, policy);
    const projected = round2(current.teaching + add);
    return { allowed: projected <= current.cap, projected, cap: current.cap };
  };
  const loadsNow = () => {
    const byFaculty = buildTermAssignments({ faculty, pairs, locks });
    return new Map(faculty.map(f => {
      const mine = byFaculty.get(String(f._id)) || [];
      return [f.name, { load: facultyLoad(f, mine, policy).teaching, preparations: new Set(mine.map(a => String(a.subjectId || a.subject?._id || a.subjectCode))).size, cap: f.teachingCapHours, partTime: f.employmentType === 'PART_TIME' }];
    }));
  };
  const before = loadsNow();

  // The dataset names two sections its own way (BSIT 3 AMG, BSIT 3A SMP): the system section of the same
  // program, year and track when exactly one exists.
  for (const q of ranked) {
    if (sectionByCode.has(q.section)) continue;
    const [prog, rest] = q.section.split(' ');
    const same = ctx.sections.filter(x => x.program === prog && String(x.yearLevel) === rest[0] && x.track === q.track);
    if (same.length === 1) { q.datasetSection = q.section; q.section = same[0].sectionCode; }
  }
  const order = [...ranked].sort((a, b) => a.section.localeCompare(b.section) || a.subjectCode.localeCompare(b.subjectCode));
  const plan = [];
  for (const q of order) {
    const own = locks.find(l => l.sectionCode === q.section && l.subjectCode === q.subjectCode);
    const subject = own ? ctx.catalog.get(String(own.subjectId)) : subjectByCode.get(q.subjectCode);
    const section = sectionByCode.get(q.section);
    const i = subject && section ? lockIndex(q.section, subject) : -1;
    const deanName = nameOfSurname(q.candidates.find(c => c.label === 1).surname);
    const entry = { section: q.section, subjectCode: q.subjectCode, subjectTitle: q.subjectTitle, dean: deanName, found: i >= 0, top3: [], chosen: null, refused: [], note: '' };
    if (i < 0) { entry.note = 'no lock for this class in the term'; entry.chosen = deanName; plan.push(entry); continue; }
    const p = servedFor(subject);
    entry.top3 = (p?.candidates || []).filter(c => c.id && c.id !== 'FAC-TBA').slice(0, 3).map(c => c.name);
    for (const name of entry.top3) {
      const person = faculty.find(f => f.name === name);
      if (!person) { entry.refused.push(`${name}: not on the faculty list`); continue; }
      const g = guardian(person, q.section, subject);
      if (!g.allowed) { entry.refused.push(`${name}: ${g.projected} of ${g.cap} h`); continue; }
      entry.chosen = name;
      entry.decision = name === entry.top3[0] ? 'accept' : 'override';
      locks[i] = { ...locks[i], facultyId: person.facultyId, facultyName: person.name, facultyRef: person._id };
      break;
    }
    if (!entry.chosen) { entry.chosen = deanName; entry.note = 'the Guardian refused all of the top 3: the Dean\'s teacher kept'; }
    entry.subjectId = String(subject._id); entry.sectionId = String(section._id);
    plan.push(entry);
  }
  const after = loadsNow();

  // ---- assignment_classes.csv: per test class, from the held-out model's own rows (the as-of features)
  const classRows = []; const notes = [];
  for (const e of plan) {
    const q = ranked.find(x => x.section === e.section && x.subjectCode === e.subjectCode);
    const cand = (name) => q.candidates.find(c => nameOfSurname(c.surname) === name);
    const dean = q.candidates.findIndex(c => c.label === 1);
    const mine = cand(e.chosen);
    if (!mine) notes.push(`${e.subjectCode} ${e.section}: ${e.chosen} is not among the 17 dataset candidates`);
    const rule = q.candidates.map(c => c.taught_it_last_same_semester * 1e6 + c.semesters_taught * 1e3 + c.sections_taught);
    const n = q.candidates.length;
    classRows.push([`${e.subjectCode} ${e.section}`, e.subjectCode, e.section, e.dean, e.chosen, n,
      round2(q.candidates[dean].semantic_match * 1000) / 1000, mine ? round2(mine.semantic_match * 1000) / 1000 : '',
      q.candidates[dean].semesters_taught, mine ? mine.semesters_taught : '',
      round2(rrOf(q.candidates.map(c => c.score), dean) * 10000) / 10000,
      round2(rrOf(q.candidates.map(c => c.semantic_match), dean) * 10000) / 10000,
      round2(rrOf(rule, dean) * 10000) / 10000, round2(harmonic(n) / n * 10000) / 10000]);
  }
  C.writeCsv(path.join(C.OUT, 'assignment_classes.csv'), ['Class', 'Subject', 'Section', 'Manual teacher', 'IntelliSched teacher', 'Candidates', 'Match manual', 'Match IntelliSched',
    'Taught before manual', 'Taught before IntelliSched', 'RR model', 'RR engine1', 'RR rule', 'RR random'], classRows);
  const teachers = [...new Set([...before.keys()])].filter(name => (before.get(name).load || after.get(name).load));
  C.writeCsv(path.join(C.OUT, 'assignment_faculty.csv'), ['Teacher', 'FT/PT', 'Cap (h)', 'Load manual (h)', 'Load IntelliSched (h)', 'Preparations manual', 'Preparations IntelliSched'],
    teachers.sort().map(name => { const b = before.get(name); const a = after.get(name); return [name, b.partTime ? 'PT' : 'FT', b.cap, b.load, a.load, b.preparations, a.preparations]; }));

  C.writeCsv(path.join(C.OUT, 'assignment_plan.csv'), ['Order', 'Section', 'Subject', "Dean's teacher", 'Screen top 3', 'Refused by the Guardian', 'IntelliSched teacher', 'Decision', 'Note'],
    plan.map((e, k) => [k + 1, e.section, e.subjectCode, e.dean, e.top3.join('; '), e.refused.join('; '), e.chosen, e.chosen === e.dean ? 'same as the Dean' : e.decision, e.note]));
  const changed = plan.filter(e => e.chosen !== e.dean);
  const summary = { classes: plan.length, sameAsDean: plan.length - changed.length, changed: changed.length,
    accepts: plan.filter(e => e.decision === 'accept').length, overrides: plan.filter(e => e.decision === 'override').length,
    keptBecauseRefused: plan.filter(e => /refused all/.test(e.note)).length, noLock: plan.filter(e => !e.found).length, notes };
  say(JSON.stringify(summary));

  if (doLock) {
    const results = [];
    for (const e of changed) {
      const person = faculty.find(f => f.name === e.chosen);
      const res = await call('POST', '/schedule/lock', {
        ...C.TERM, subjectId: e.subjectId, subjectCode: e.subjectCode, sectionCode: e.section, sectionId: e.sectionId,
        facultyId: person.facultyId, facultyName: person.name, classType: 'ALL', decision: e.decision,
        originalFacultyId: faculty.find(f => f.name === e.top3[0])?.facultyId, mlTop1Faculty: e.top3[0],
        reason: e.decision === 'override' ? 'Phase 10 evaluation: the highest-ranked professor the Overload Guardian allows' : undefined
      }, token);
      results.push({ class: `${e.subjectCode} ${e.section}`, to: e.chosen, status: res.status, message: res.data?.message || '' });
      if (res.status !== 200 && res.status !== 201) say(`${e.subjectCode} ${e.section} -> ${e.chosen}: ${res.status} ${res.data?.message || ''}`);
    }
    summary.lock = { sent: results.length, saved: results.filter(r => r.status < 300).length, refused: results.filter(r => r.status >= 300) };
    say(`Locked through the gateway: ${summary.lock.saved} of ${summary.lock.sent} saved.`);
  }
  fs.writeFileSync(PLAN, `${JSON.stringify({ summary, plan }, null, 1)}\n`);
  await mongoose.disconnect();
};

main().catch((err) => { console.error(`[assignment] ${err.stack || err.message}`); process.exit(1); });
