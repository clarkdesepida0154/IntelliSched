// The demo's modes (demo.js --mode <name>; normal by default). Each mode has:
//   dbName       its database in the demo's mongod; the name must end in "_test";
//   title, term  what the demo prints; term also sets the client's default term;
//   sections     the active sections after prepare (optional; check.js compares);
//   seedOptions  passed to server/scripts/seed-test-db.js seed(), e.g. activeWhen (who is active);
//   prepare(api) sets the term up through the gateway API as the TEST Dean, right after a fresh
//                seed (api(method, route, body) -> { status, data }); returns a summary;
//   describe(summary) the lines the demo prints about it.
// A mode's data is prepared once; later starts keep whatever the team changed.
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, SERVER_DIR, DEMO_DATA } = require('./paths');
const { buildTermPairs, resolveSubjectType } = require(path.join(SERVER_DIR, 'src', 'utils', 'curriculumMatcher.js'));

// The term we have real data for.
const TERM = { academicYear: '2025-2026', semester: 1, semesterLabel: '1st Semester' };

const ok = (res, what) => {
  if (res.status < 200 || res.status > 299) throw new Error(`Could not ${what} (${res.status}: ${res.data?.message || 'no message'}).`);
  return res.data;
};

// Only the named sections stay active.
const keepSections = async (api, keep) => {
  for (const section of ok(await api('GET', '/sections'), 'list the sections')) {
    const active = keep.includes(section.sectionCode);
    if (section.isActive !== active) ok(await api('PATCH', `/sections/${section._id}/toggle`), `switch ${section.sectionCode}`);
  }
  return ok(await api('GET', '/sections'), 'list the sections').filter(s => s.isActive).map(s => s.sectionCode);
};

// The (section, subject) pairs of the active sections whose subject is a Major (not a practicum).
const majorPairs = async (api, term) => {
  const active = ok(await api('GET', '/sections'), 'list the sections').filter(s => s.isActive);
  const mappings = ok(await api('GET', `/curriculum-mappings?semester=${encodeURIComponent(term.semesterLabel)}`), 'list the curriculum mappings');
  return buildTermPairs(active, mappings).filter(p => resolveSubjectType(p.subject) === 'Major' && !p.subject.isPracticum);
};

// A professor on every Major (non-practicum) pair of the active sections, as the UI audit does:
// round-robin over the active faculty. The Overload Guardian refuses a professor whose teaching cap
// would be passed; the next one is tried.
const lockEveryMajor = async (api, term) => {
  const pairs = await majorPairs(api, term);
  const termQuery = `academicYear=${term.academicYear}&semester=${term.semester}`;
  const locks = ok(await api('GET', `/schedule/locks?${termQuery}`), 'read the locks').locks || [];
  const faculty = ok(await api('GET', '/faculty'), 'list the faculty').filter(f => f.isActive && f.employmentType && Number.isFinite(f.teachingCapHours));
  if (!faculty.length) throw new Error('No active professor has an employment type and a teaching cap.');
  const unlocked = [];
  let next = 0;
  for (const { section, subject } of pairs) {
    if (locks.some(l => l.sectionCode === section.sectionCode && String(l.subjectId) === String(subject._id))) continue;
    let locked = false;
    for (let tries = 0; tries < faculty.length && !locked; tries += 1) {
      const prof = faculty[next % faculty.length];
      next += 1;
      const res = await api('POST', '/schedule/lock', {
        academicYear: term.academicYear, semester: term.semester,
        subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id,
        facultyId: prof.facultyId, facultyName: prof.name, classType: 'ALL', units: subject.units
      });
      locked = res.status === 200;
    }
    if (!locked) unlocked.push(`${section.sectionCode} ${subject.subjectCode}`);
  }
  const after = ok(await api('GET', `/schedule/locks?${termQuery}`), 'read the locks').locks || [];
  return { majorPairs: pairs.length, locks: after.length, unlocked };
};

// Phase 3 Step 4: both modes save the Scheduling Policy once through the gateway as the TEST Dean (an
// empty body: the defaults, TBA rooms automatic), so the Readiness Check's "The Scheduling Policy is
// saved" line passes on a fresh demo. A mode may pass its own plain settings (the full college below).
const savePolicy = async (api, body = {}) => {
  const saved = ok(await api('PUT', '/policy', body), 'save the Scheduling Policy');
  return { policySaved: saved.persisted === true, tbaRoomsMode: saved.overflowRooms?.mode || 'auto' };
};
// Phase 8: the full-college demo replays the real 1st Semester AY 2025-2026, which ran under the
// pre-Phase 8 rules — the 07:00–17:00 day, Saturday overflow on, no odd/even weeks. Under the Phase 8
// defaults (the 08:00 day, Saturday off) that term cannot even start: two part-timers' real 45-hour
// weeks no longer fit the weekday free time. So this mode saves the policy of its own era (a plain
// save any Dean could make: the Saturday WINDOW is an Advanced setting and stays the stored default,
// which only moves where Saturday classes may start); the 2nd-semester and defense modes load the
// term file's Phase 8 policy. Phase 8 Part 6: the part-timers' one-class-day rule (decision 5c, an
// Advanced setting the Dean may save since Part 6) did not exist then either, so it is saved off.
const FIRST_SEM_2025_POLICY = { dayStart: '07:00', saturdayOverflow: { enabled: true }, weekGroups: { enabled: false }, meetings: { partTimerNoSingleDay: false } };
const tbaRoomsWords = (mode) => ({ auto: 'on (automatic)', manual: 'on (manual counts)', off: 'off' }[mode] || mode);

const FOUR_SECTIONS = ['BSIT 1A', 'BSIT 2A', 'BSIT 3A WMAD', 'BSCS 1A'];

// ---------------------------------------------------------------------------- full college (Step 1)
// The real 1st Semester AY 2025-2026: all 20 sections with the professors who taught each pair,
// from the Step 1 fixture (shared/fixtures/full-college-2025-s1.json).
const FIXTURE_FILE = path.join(__dirname, '..', '..', 'shared', 'fixtures', 'full-college-2025-s1.json');
const readFixture = () => JSON.parse(require('fs').readFileSync(FIXTURE_FILE, 'utf8'));

// The surname in a name as printed or as entered: "ALEJANDRO Faculty, JR., MSIT" and
// "Alejandro V. Faculty Jr." -> Faculty. Suffixes such as Jr. are skipped.
const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV']);
const surnameOf = (name) => String(name || '').split(',')[0].split(/[\s.]+/)
  .filter(t => t && !NAME_SUFFIXES.has(t.toUpperCase())).at(-1)?.toUpperCase() || '';

// Who taught undergraduates in this term (fixture professors with teaching hours).
const taughtSurnames = () => new Set(readFixture().faculty.filter(f => f.teachingHours > 0).map(f => surnameOf(f.name)));

// Active in full mode: everyone active today, plus the professors who taught this term even if they
// have left since (FORMER in faculty_data.json).
const fullActiveWhen = (record, source) => {
  const taught = taughtSurnames();
  if (source === 'faculty_data') {
    return String(record.status || '').trim().toUpperCase() === 'ACTIVE' || taught.has(surnameOf(record.nameOnTeachersProgram || record.name));
  }
  return record.teachesUndergradIn1stSemAY2025_26 !== false || taught.has(surnameOf(record.displayName));
};

// Every assignment of the fixture, locked through the gateway (Overload Guardian included). When the
// Guardian refuses because the real load is above the professor's default cap (the Dean sometimes
// went above it), the cap is raised to that load, rounded up to the half hour, and the lock retried.
const lockFixtureAssignments = async (api, term) => {
  const fx = readFixture();
  const sections = new Map(ok(await api('GET', '/sections'), 'list the sections').map(s => [s.sectionCode, s]));
  const catalog = ok(await api('GET', '/catalog'), 'list the catalog');
  const subjectOf = (a) => catalog.find(c => c.subjectCode === a.subjectCode && c.descriptiveTitle === a.title);
  const faculty = ok(await api('GET', '/faculty'), 'list the faculty');
  const bySurname = new Map(faculty.map(f => [surnameOf(f.name), f]));
  const raised = [];
  const problems = [];
  let locked = 0;
  for (const a of fx.assignments.filter(x => x.facultyName)) {
    const section = sections.get(a.sectionCode);
    const subject = subjectOf(a);
    const prof = bySurname.get(surnameOf(a.facultyName));
    if (!section || !subject || !prof) { problems.push(`${a.subjectCode} (${a.sectionCode}): ${!section ? 'no section' : !subject ? 'no catalog subject' : `no professor named ${a.facultyName}`}`); continue; }
    const body = {
      academicYear: term.academicYear, semester: term.semester,
      subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id,
      facultyId: prof.facultyId, facultyName: prof.name, classType: 'ALL', units: subject.units
    };
    let res = await api('POST', '/schedule/lock', body);
    if (res.status === 409 && res.data?.code === 'CAPACITY_EXCEEDED') {
      const cap = Math.ceil(res.data.load.projected * 2) / 2;
      ok(await api('PUT', `/faculty/${prof._id}`, { teachingCapHours: cap }), `raise ${prof.name}'s teaching cap`);
      raised.push(`${prof.name} ${res.data.load.cap} -> ${cap} h`);
      res = await api('POST', '/schedule/lock', body);
    }
    if (res.status === 200) locked += 1;
    else problems.push(`${a.subjectCode} (${a.sectionCode}) -> ${prof.name}: ${res.status} ${res.data?.message || ''}`);
  }
  return { locked, expected: fx.assignments.filter(x => x.facultyName).length, raised, problems };
};

const MODES = {
  normal: {
    dbName: 'intellisched_demo_test',
    title: '4 sections',
    term: TERM,
    sections: FOUR_SECTIONS, // the active sections after prepare (check.js compares)
    seedOptions: {},
    // The UI audit's state without a GA run: four sections, a professor on every Major, the Scheduling
    // Policy saved (TBA rooms automatic), no schedule.
    prepare: async (api) => {
      const sections = await keepSections(api, FOUR_SECTIONS);
      const policy = await savePolicy(api);
      const locks = await lockEveryMajor(api, TERM);
      return { activeSections: sections, ...policy, ...locks };
    },
    describe: (summary) => [
      `Prepared: active sections ${summary.activeSections.join(', ')}; ${summary.locks} professor assignments for ${summary.majorPairs} Major classes; Scheduling Policy saved, TBA rooms ${tbaRoomsWords(summary.tbaRoomsMode)}; no schedule yet.`,
      ...(summary.unlocked.length ? [`No professor within the teaching cap for: ${summary.unlocked.join(', ')}.`] : [])
    ]
  },
  // The whole college (npm run demo:full): 20 sections, the real assignments, the Scheduling Policy
  // saved with TBA rooms on (automatic), so the Readiness Check says how many classes the CCS rooms
  // can't hold and about how many TBA rooms to request.
  full: {
    dbName: 'intellisched_demo_full_test',
    title: 'full college, 20 sections',
    term: TERM,
    sections: readFixture().assignments.map(a => a.sectionCode).filter((c, i, all) => all.indexOf(c) === i),
    seedOptions: { activeWhen: fullActiveWhen },
    prepare: async (api) => {
      const all = readFixture().assignments.map(a => a.sectionCode).filter((c, i, list) => list.indexOf(c) === i);
      const sections = await keepSections(api, all);
      const policy = await savePolicy(api, FIRST_SEM_2025_POLICY);
      const locks = await lockFixtureAssignments(api, TERM);
      return { activeSections: sections, ...policy, ...locks };
    },
    describe: (summary) => [
      `Prepared: ${summary.activeSections.length} active sections; ${summary.locked} of ${summary.expected} real assignments locked (Majors and CCS-taught Minors); Scheduling Policy saved, TBA rooms ${tbaRoomsWords(summary.tbaRoomsMode)}.`,
      ...(summary.raised.length ? [`Teaching caps raised to the real load: ${summary.raised.join('; ')}.`] : []),
      ...(summary.problems.length ? [`Not locked: ${summary.problems.join('; ')}.`] : []),
      'Open Generate Schedule: the Readiness Check says how many classes will be TBA and about how many TBA rooms to request.'
    ]
  }
};

// ---------------------------------------------------------------------- 2nd Semester AY 2026-2027 (Phase 4 Part 3)
// The real term of the final defense: the base seed makes the logins only (seedOptions data 'none'), then
// the term loader (server/scripts/load-term.js, --apply) puts the term file's data in, with the private
// files (docs/data/faculty_data.json, faculty_data.ratings.json) when they are present, unless the demo
// was started with --faculty-seed (tracked data only, for committed evidence). Phase 8 Part 7: the term
// file copies last year's Teachers' Program and leaves 8 classes for the College Secretary (the 4 ITEP
// 205 classes, the Dean's decision; BSIT 1D's 3; the 4th-year WMAD B coordination), so the Readiness
// Check says "not ready" until the Major ones are assigned.
const SEM2_TERM = { academicYear: '2026-2027', semester: 2, semesterLabel: '2nd Semester' };
const TERM_FILE = path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const readTermFile = () => JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
const TERM_FILE_WORDS = 'the term file (docs/data/term_2nd_sem_AY2026_27.json)';

// Runs the loader on the demo's database. Returns { result, facultySource, facultyWords }.
const loadTermFile = async ({ uri, facultySeedOnly, log }) => {
  const { loadTerm } = require(path.join(SERVER_DIR, 'scripts', 'load-term.js'));
  const result = await loadTerm({ uri, termFile: TERM_FILE, apply: true, privateFiles: !facultySeedOnly, log });
  const privateRead = result.sources.privateFaculty === 'read' || result.sources.ratings === 'read';
  return { result, facultySource: privateRead ? 'faculty_data' : 'seed' };
};
// The "Faculty from:" words of these modes (facultySource 'faculty_data' | 'seed').
const termFacultyWords = (source) => (source === 'faculty_data'
  ? `${TERM_FILE_WORDS} with the private docs/data/faculty_data.json and faculty_data.ratings.json`
  : `${TERM_FILE_WORDS} with the seed file's expertise and no ratings (tracked data only)`);

// After the loader: what the term looks like through the gateway (the Readiness Check's verdict and
// its lines that need fixing, the assignments), as the Dean sees it.
const describeTerm = async (api) => {
  const sections = ok(await api('GET', '/sections'), 'list the sections').filter(s => s.isActive).map(s => s.sectionCode);
  const faculty = ok(await api('GET', '/faculty'), 'list the faculty').filter(f => f.isActive).length;
  const termQuery = `academicYear=${SEM2_TERM.academicYear}&semester=${SEM2_TERM.semester}`;
  const locks = ok(await api('GET', `/schedule/locks?${termQuery}`), 'read the assignments').locks || [];
  const report = ok(await api('POST', '/schedule/preflight', { academicYear: SEM2_TERM.academicYear, semester: SEM2_TERM.semester }), 'run the Readiness Check').report;
  // The readiness lines are pass | warn | fail (utils/preflight.js); the ones that are not a pass.
  const lines = (report?.readiness?.lines || []).filter(l => l.status !== 'pass').map(l => `${l.status === 'fail' ? '✖' : '⚠'} ${l.text}`);
  return { activeSections: sections, activeFaculty: faculty, locks: locks.length, verdict: report?.readiness?.verdict || 'unknown', lines };
};
// Phase 8 Part 7: the classes the term file leaves for the College Secretary, in plain words.
const openClassWords = (termFile) => {
  const open = [...(termFile.unassignedMajors || []), ...(termFile.unassignedMinors || []), ...(termFile.unassignedCoordinations || [])];
  // Phase 8 Part 8: the saved default (the Dean's session) leaves nothing open.
  if (!open.length) return "every class is assigned (the Dean's session of 9 Oct 2026, saved as the default)";
  const deans = open.filter(u => !u.reasonKind || u.reasonKind === 'nobody-taught');
  const sections = [...new Set(open.filter(u => !deans.includes(u)).map(u => u.sectionCode))];
  return `${open.length} classes are left for the College Secretary to assign by hand: ${deans.length} ITEP 205 (the Dean's decision)${sections.length ? `, and ${open.length - deans.length} of ${sections.join(' and ')}` : ''}`;
};
const describeTermLines = (summary) => [
  `Loaded: ${summary.activeSections.length} sections, ${summary.activeFaculty} active professors, ${summary.locks} assignments (from the term file); ${openClassWords(readTermFile())}.`,
  `Readiness Check: ${summary.verdict === 'ready' ? 'Ready to generate' : 'not ready yet'}${summary.lines.length ? `: ${summary.lines.join(' | ')}` : ''}.`
];
const TERM_MODE = {
  term: SEM2_TERM,
  // Phase 8: the term file carries the Dean's full set; only the enabled sections are active.
  sections: readTermFile().sections.filter(s => s.enabled !== false).map(s => s.sectionCode),
  // The Major classes the term file leaves for the Secretary (Phase 8 Part 7: ITEP 205 for BSIT 2A–2D
  // and BSIT 1D's three; check.js expects exactly these without a professor). The open coordination
  // is not a Major class, so it is not among them.
  unassignedMajors: readTermFile().unassignedMajors.map(u => `${u.sectionCode} ${u.subjectCode}`),
  // check.js counts the active professors (Phase 8 Part 8: the saved default lists the inactive ones too).
  expect: { faculty: readTermFile().faculty.filter(f => (f.status || 'ACTIVE') === 'ACTIVE').length, locks: readTermFile().assignments.length + readTermFile().minorAssignments.length + readTermFile().practicumCoordinators.length },
  seedOptions: { data: 'none' },
  load: loadTermFile,
  facultyWords: termFacultyWords,
  prepare: describeTerm,
  describe: describeTermLines
};
MODES.sem2 = {
  ...TERM_MODE,
  dbName: 'intellisched_demo_sem2_test',
  title: '2nd Semester AY 2026-2027, the real term data'
};
// The team's final defense (npm run defense): the same term on its own database, kept between starts,
// with ONE account (Phase 8 Part 8; Part 6 had two): the Dean (person@example.test, named "Dean", no
// "TEST" on screen), its password random, kept in .demo-data/defense-secrets.json and printed at the
// start. Every start ensures that account and adds no other; an account kept from before (the Part 8
// migration locks a College Secretary account and keeps its audit rows) stays, and check.js defense
// expects exactly one ACTIVE account. npm run defense:reset backs the database up, wipes it after
// "RESET" is typed (or with --yes) and rewrites the secrets file with this login only. presentationMode: when it loads the term, the Output Setting "Show
// evaluation ratings on screen" is switched off, so no rating reaches the projector (the Dean can
// switch it on again in Output Settings; the ranking uses the ratings either way).
MODES.defense = {
  ...TERM_MODE,
  dbName: 'intellisched_defense_test',
  title: 'final defense: 2nd Semester AY 2026-2027',
  secretsFile: path.join(DEMO_DATA, 'defense-secrets.json'),
  resetPrompt: true,
  presentationMode: true,
  logins: {
    dean: { key: 'dean', label: 'Dean', email: 'person@example.test', name: 'Dean', role: 'Dean' },
    extra: []
  }
};

// Phase 9 (the GA evaluation set): 2nd Semester AY 2025-26 as the office printed it, on its own
// throwaway database. The term file is docs/eval/term_2nd_sem_AY2025_26_eval.json (scripts/eval/
// build-eval-term.js): last year's 19 sections with the office's professors locked, on the current
// policy and rooms; tracked data only (no private files, no ratings). ITEP 205 is on no 2025-26 form,
// so the one curriculum mapping that places it in BSIT 2nd year, 2nd semester is dropped from THIS
// database after the loader (it would otherwise be a Major class with nobody to teach it).
const EVAL_TERM = { academicYear: '2025-2026', semester: 2, semesterLabel: '2nd Semester' };
const EVAL_TERM_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'term_2nd_sem_AY2025_26_eval.json');
const readEvalTerm = () => JSON.parse(fs.readFileSync(EVAL_TERM_FILE, 'utf8'));
const loadEvalTerm = async ({ uri, log }) => {
  const { loadTerm } = require(path.join(SERVER_DIR, 'scripts', 'load-term.js'));
  const result = await loadTerm({ uri, termFile: EVAL_TERM_FILE, apply: true, privateFiles: false, log });
  const mongoose = require(path.join(SERVER_DIR, 'node_modules', 'mongoose'));
  const conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false }).asPromise();
  try {
    const subject = await conn.collection('subject_catalog').findOne({ subjectCode: 'ITEP 205' });
    if (subject) {
      const gone = await conn.collection('curriculum_mappings').deleteMany({ subject: subject._id, program: 'BSIT', yearLevel: '2nd Year', semester: '2nd Semester' });
      log(`Dropped ITEP 205 from BSIT 2nd Year, 2nd Semester in this throwaway database (${gone.deletedCount} mapping): it is on no 2nd Sem AY 2025-26 form.`);
    }
  } finally { await conn.close(); }
  return { result, facultySource: 'seed' };
};
const prepareEvalTerm = async (api) => {
  const sections = ok(await api('GET', '/sections'), 'list the sections').filter(s => s.isActive).map(s => s.sectionCode);
  const faculty = ok(await api('GET', '/faculty'), 'list the faculty').filter(f => f.isActive).length;
  const locks = ok(await api('GET', `/schedule/locks?academicYear=${EVAL_TERM.academicYear}&semester=${EVAL_TERM.semester}`), 'read the assignments').locks || [];
  const report = ok(await api('POST', '/schedule/preflight', { academicYear: EVAL_TERM.academicYear, semester: EVAL_TERM.semester }), 'run the Readiness Check').report;
  const lines = (report?.readiness?.lines || []).filter(l => l.status !== 'pass').map(l => `${l.status === 'fail' ? '✖' : '⚠'} ${l.text}`);
  return { activeSections: sections, activeFaculty: faculty, locks: locks.length, verdict: report?.readiness?.verdict || 'unknown', lines };
};
MODES.eval = {
  ...TERM_MODE,
  term: EVAL_TERM,
  dbName: 'intellisched_eval_test',
  title: 'GA evaluation: 2nd Semester AY 2025-2026, the office assignments',
  sections: readEvalTerm().sections.map(s => s.sectionCode),
  unassignedMajors: [],
  expect: { faculty: readEvalTerm().faculty.filter(f => (f.status || 'ACTIVE') === 'ACTIVE').length, locks: readEvalTerm().assignments.length + readEvalTerm().minorAssignments.length + readEvalTerm().practicumCoordinators.length },
  load: loadEvalTerm,
  facultyWords: () => 'the evaluation term file (docs/eval/term_2nd_sem_AY2025_26_eval.json) with the seed expertise and no ratings',
  prepare: prepareEvalTerm,
  describe: (summary) => [`Loaded: ${summary.activeSections.length} sections, ${summary.activeFaculty} active professors, ${summary.locks} assignments (the office's, 2nd Sem AY 2025-26).`, `Readiness Check: ${summary.verdict === 'ready' ? 'Ready to generate' : 'not ready yet'}${summary.lines.length ? `: ${summary.lines.join(' | ')}` : ''}.`]
};

// The npm script that starts a mode, and the one that resets it.
const startScriptOf = (modeName) => ({ normal: 'demo', defense: 'defense' }[modeName] || `demo:${modeName}`);
const resetScriptOf = (modeName) => `${startScriptOf(modeName)}:reset`;

module.exports = { MODES, TERM, SEM2_TERM, TERM_FILE, keepSections, majorPairs, lockEveryMajor, surnameOf, fullActiveWhen, startScriptOf, resetScriptOf };
