// Phase 8 Part 8 (decision 1d): npm run defense:save-default [-- --no-round-trip]
//
// Makes the defense database the default: it READS the defense database (never writes it), rewrites
// docs/data/term_2nd_sem_AY2026_27.json from it (server/scripts/term-file-export.js: the sections and
// their flags, the rooms, the Scheduling Policy, the faculty profiles' office facts, the Output Settings
// and every assignment with its source and reason; never a rating, an expertise list or anything else
// from the private faculty files), then proves the round trip: the new file is loaded into an empty
// throwaway database (intellisched_part8_roundtrip_test, the term loader with the private files, as the
// defense loads it) and compared with the defense database item by item. Every difference is printed.
// Run it again after any later change in the defense system; the team commits the new file. It starts
// the demo's MongoDB for the job alone and refuses while a demo or the defense runs. The proof is kept in
// .demo-data/logs/part8-save-default.json (counts and names only).
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { REPO_ROOT, SERVER_DIR, DEMO_DATA } = require('./paths');
const { withDemoMongo, DEFENSE_DB } = require('./defense-backup');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const { exportTermFile, lockSourceOf } = require(path.join(SERVER_DIR, 'scripts', 'term-file-export.js'));
const { mergePolicy, defaultPolicy } = require(path.join(SERVER_DIR, 'src', 'utils', 'policy.js'));
const { mergeOutputSettings } = require(path.join(SERVER_DIR, 'src', 'utils', 'outputSettings.js'));

const TERM_FILE = path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const SEED_FILE = path.join(REPO_ROOT, 'docs', 'data', 'intellisched_seed_data.json');
const PRIVATE_FILE = path.join(REPO_ROOT, 'docs', 'data', 'faculty_data.json');
const ROUND_TRIP_DB = 'intellisched_part8_roundtrip_test';
const PROOF = path.join(DEMO_DATA, 'logs', 'part8-save-default.json');
// Phase 8 Part 8 (decision 4): outsideteachers, the GenEd teachers from outside CCS (absent until one is added).
const COLLECTIONS = ['subject_catalog', 'curriculum_mappings', 'facilities', 'sections', 'faculty', 'scheduling_policies', 'output_settings', 'mother_schedules', 'demo_meta', 'users', 'outsideteachers'];
const say = (line) => console.log(`[defense:save-default] ${line}`);
const rel = (file) => path.relative(REPO_ROOT, file).split(path.sep).join('/');
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const keyOf = (code, title) => `${norm(code).toUpperCase()}|${norm(title).toLowerCase()}`;
const STRIP = new Set(['_id', '__v', 'key', 'createdAt', 'updatedAt', 'updatedBy', 'persisted']);
const clean = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (STRIP.has(k) ? undefined : x)));
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
// A list as the loader cleans it (each item trimmed, its spaces squeezed, each once): the private
// file's lists are compared the way they are loaded.
const listOf = (list) => [...new Set((Array.isArray(list) ? list : []).map(norm).filter(Boolean))];

const readAll = async (db) => {
  const out = {};
  for (const name of COLLECTIONS) out[name] = await db.collection(name).find({}).toArray();
  return out;
};

// The term's loads by professor name (the one load rule), from the database the default connection uses.
const termLoads = async (term) => {
  const { loadTermInputs } = require(path.join(SERVER_DIR, 'src', 'utils', 'termInputs.js'));
  const { buildTermAssignments } = require(path.join(SERVER_DIR, 'src', 'utils', 'termAssignments.js'));
  const { facultyLoad } = require(path.join(SERVER_DIR, 'src', 'utils', 'load.js'));
  const modelsDir = path.join(SERVER_DIR, 'src', 'models');
  for (const file of fs.readdirSync(modelsDir).filter(f => f.endsWith('.js'))) require(path.join(modelsDir, file));
  const { faculty, pairs, locks, policy } = await loadTermInputs(term);
  const assignments = buildTermAssignments({ faculty, pairs, locks });
  const out = {};
  for (const f of faculty) {
    const load = facultyLoad(f, assignments.get(String(f._id)) || [], policy);
    out[f.name] = { teaching: load.teaching, min: load.min, underMin: load.underMin || 0 };
  }
  return out;
};

// Item by item: { area, items, identical, differences: [words] } for each part of the term data.
const compareTerm = (a, b) => {
  const areas = [];
  const area = (name, keysA, keysB, fieldsOf) => {
    const differences = [];
    const mapA = new Map(keysA);
    const mapB = new Map(keysB);
    for (const [k, x] of mapA) {
      if (!mapB.has(k)) { differences.push(`${k}: missing after the round trip`); continue; }
      const fa = fieldsOf(x);
      const fb = fieldsOf(mapB.get(k));
      for (const field of Object.keys(fa)) if (!same(fa[field], fb[field])) differences.push(`${k}: ${field}`);
    }
    for (const k of mapB.keys()) if (!mapA.has(k)) differences.push(`${k}: only after the round trip`);
    areas.push({ area: name, items: mapA.size, identical: mapA.size - new Set(differences.map(d => d.split(':')[0])).size, differences });
  };
  area('sections', a.sections.map(s => [s.sectionCode, s]), b.sections.map(s => [s.sectionCode, s]),
    s => ({ program: s.program, yearLevel: s.yearLevel, track: s.track, isActive: s.isActive !== false, studentCount: s.studentCount ?? null }));
  area('rooms', a.facilities.map(r => [r.roomName, r]), b.facilities.map(r => [r.roomName, r]),
    r => ({ type: r.type, capacity: r.capacity ?? null, building: r.building ?? null, isActive: r.isActive !== false, availability: (r.availability || []).map(w => ({ day: w.day, start: w.start, end: w.end })) }));
  const policyOf = (docs) => clean(docs.scheduling_policies[0] ? mergePolicy(docs.scheduling_policies[0], undefined) : defaultPolicy());
  area('Scheduling Policy', [['the policy', policyOf(a)]], [['the policy', policyOf(b)]], p => ({ policy: p }));
  area('Master Catalog', a.subject_catalog.map(c => [keyOf(c.subjectCode, c.descriptiveTitle), c]), b.subject_catalog.map(c => [keyOf(c.subjectCode, c.descriptiveTitle), c]),
    c => ({ type: c.type, lecHours: c.lecHours, labHours: c.labHours, units: c.units, requiresRoom: Boolean(c.requiresRoom), isPracticum: Boolean(c.isPracticum), lectureMode: c.lectureMode || 'ON_CAMPUS', isActive: c.isActive !== false, subjectDescription: norm(c.subjectDescription) }));
  const subjectKey = (docs) => new Map(docs.subject_catalog.map(c => [String(c._id), keyOf(c.subjectCode, c.descriptiveTitle)]));
  const mapKeys = (docs) => { const k = subjectKey(docs); return docs.curriculum_mappings.map(m => [`${m.program}|${m.yearLevel}|${m.semester}|${m.track || 'CORE'}|${k.get(String(m.subject))}`, m]); };
  area('curriculum mappings', mapKeys(a), mapKeys(b), () => ({}));
  const historyOf = (list) => (list || []).map(h => ({ subjectCode: h.subjectCode, descriptiveTitle: h.descriptiveTitle, terms: h.terms, termSections: (h.termSections || []).map(t => ({ term: t.term, sections: t.sections })), timesTaught: h.timesTaught, lastTerm: h.lastTerm }));
  area('faculty profiles', a.faculty.map(f => [f.name, f]), b.faculty.map(f => [f.name, f]), f => ({
    employmentType: f.employmentType, position: f.position ?? null, teachingCapHours: f.teachingCapHours, minTeachingHours: f.minTeachingHours ?? null,
    extensionDay: f.extensionDay ?? null, ancillary: [...(f.ancillary || [])].map(x => ({ type: x.type, hours: x.hours })).sort((x, y) => x.type.localeCompare(y.type)),
    unavailableBlocks: (f.unavailableBlocks || []).map(x => ({ day: x.day, start: x.start, end: x.end, note: norm(x.note) })),
    degreeAfterName: f.degreeAfterName ?? null, program: f.program ?? null, coCurricular: f.coCurricular ?? null, isActive: f.isActive !== false, archived: Boolean(f.archived),
    degreeLevel: f.degreeLevel ?? null, email: f.email ?? null, major: norm(f.major), specializations: listOf(f.specializations), certifications: listOf(f.certifications),
    pastSubjectsTaught: listOf(f.pastSubjectsTaught), teachingHistory: historyOf(f.teachingHistory), programHistory: (f.programHistory || []).map(p => ({ program: p.program, terms: p.terms })),
    // the ratings are compared, never shown: true when equal
    rating: `${Number(f.evalScore?.average) || 0}|${(f.evalScore?.history || []).length}`
  }));
  const settingsOf = (docs) => clean(docs.output_settings[0] ? mergeOutputSettings(docs.output_settings[0], undefined) : null);
  area('Output Settings', [['the settings', settingsOf(a)]], [['the settings', settingsOf(b)]], s => ({ settings: s }));
  const term = { academicYear: '2026-2027', semester: 2 };
  const locksOf = (docs) => {
    const k = subjectKey(docs);
    const byId = new Map(docs.faculty.map(f => [String(f._id), f.name]));
    const source = lockSourceOf(docs.mother_schedules, term);
    return (source?.lockedAssignments || []).map(l => [`${l.sectionCode} ${k.get(String(l.subjectId))}`, { faculty: byId.get(String(l.facultyRef)) || l.facultyName, source: l.source || null, classType: l.classType || 'ALL' }]);
  };
  area('assignments', locksOf(a), locksOf(b), l => ({ faculty: l.faculty, source: l.source, classType: l.classType }));
  return areas;
};

const main = async () => {
  const roundTrip = !process.argv.includes('--no-round-trip');
  const previous = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const privateFaculty = fs.existsSync(PRIVATE_FILE) ? (JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf8')).faculty || []) : [];
  const term = { academicYear: String(previous.term.academicYear), semester: /^2/.test(String(previous.term.semester)) ? 2 : 1 };
  return withDemoMongo({
    runMode: 'defense-save-default',
    say,
    job: async ({ uriFor }) => {
      // 1. read the defense database (read only)
      await mongoose.connect(uriFor(DEFENSE_DB), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
      let defense;
      let loads;
      try {
        defense = await readAll(mongoose.connection.db);
        loads = await termLoads(term);
      } finally {
        mongoose.connection.removeAllListeners('disconnected');
        await mongoose.disconnect();
      }
      if (!defense.faculty.length || !defense.sections.length) throw new Error(`${DEFENSE_DB} holds no term (no faculty or sections): nothing was written.`);
      // 2. the term file
      const file = exportTermFile({ docs: defense, previous, privateFaculty, seed, loads, sourceDb: DEFENSE_DB });
      fs.writeFileSync(TERM_FILE, `${JSON.stringify(file, null, 2)}\n`);
      const c = file.phase8Part8.counts;
      say(`Wrote ${rel(TERM_FILE)} from ${DEFENSE_DB}: ${c.sections} sections (${c.enabled} enabled), ${c.rooms} rooms, ${c.faculty} professors (${c.active} active), ${c.majors} Major assignments, ${c.minors} Minor, ${c.coordinators} coordinators; ${c.openMajors} Major classes and ${c.openCoordinations} coordinations without a professor; ${file.catalogChanges.length} catalog changes.`);
      const proof = { savedAt: file.phase8Part8.savedAt, from: DEFENSE_DB, file: rel(TERM_FILE), counts: c, roundTrip: null };
      if (!roundTrip) return { code: 0, proof };
      // 3. the round trip: the file into an empty throwaway database, as the defense loads it
      const empty = await mongoose.createConnection(uriFor(ROUND_TRIP_DB), { autoIndex: false, autoCreate: false }).asPromise();
      await empty.db.dropDatabase();
      await empty.close();
      const { loadTerm } = require(path.join(SERVER_DIR, 'scripts', 'load-term.js'));
      const lines = [];
      const loaded = await loadTerm({ uri: uriFor(ROUND_TRIP_DB), termFile: TERM_FILE, apply: true, privateFiles: true, log: line => lines.push(String(line)) });
      const conn = await mongoose.createConnection(uriFor(ROUND_TRIP_DB), { autoIndex: false, autoCreate: false }).asPromise();
      let after;
      try { after = await readAll(conn.db); } finally { await conn.close(); }
      const areas = compareTerm(defense, after);
      const differences = areas.reduce((n, x) => n + x.differences.length, 0);
      say(`Round trip (the file loaded into an empty ${ROUND_TRIP_DB}, with the private files; the loader's problems: ${loaded.problems.length}):`);
      for (const x of areas) say(`  ${x.area}: ${x.identical} of ${x.items} identical${x.differences.length ? ` — ${x.differences.join('; ')}` : ''}`);
      say(differences ? `${differences} differences (listed above).` : 'Every item is identical: loading the file reproduces the term data.');
      proof.roundTrip = { database: ROUND_TRIP_DB, loaderProblems: loaded.problems, areas, differences, loaderLines: lines.filter(l => /^(Faculty|Assignments|Sections|Rooms|Master Catalog|Scheduling Policy|Output Settings|  By source|  Ratings)/.test(l)) };
      return { code: 0, proof };
    }
  });
};

main().then(({ code, proof } = {}) => {
  if (proof) {
    fs.mkdirSync(path.dirname(PROOF), { recursive: true });
    fs.writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`);
    say(`The proof: ${rel(PROOF)}. Commit ${rel(TERM_FILE)}.`);
  }
  process.exit(code ?? 0);
}).catch((err) => { say(err.message); process.exit(1); });
