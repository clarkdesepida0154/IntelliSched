// Phase 9 (GA evaluation): the term of 2nd Semester AY 2025-26 as the office printed it, for the
// experts' audit. It is the loader's term file (docs/eval/term_2nd_sem_AY2025_26_eval.json), made from
//   - the Phase 6 fixture (server/tests/fixtures/term_2nd_sem_AY2025_26.json): all 19 sections of that
//     semester and the office's professors for every class, transcribed from the 22 SF-029 pages;
//   - the current term file's setup (the Part 7 fixture): the policy, the rooms (7 CCS rooms), the
//     faculty profiles, the catalog changes and the Output Settings, "as the system does today".
// Every assignment is a lock of the office's own, so only the day, time and room differ between the
// manual schedule and the GA's. Nothing is written to any database here; the output is a JSON file and
// docs/eval/expert_set/EXCLUDED_CLASSES.xlsx (the printed blocks the GA cannot model).
//   node scripts/eval/build-eval-term.js [--check]
const fs = require('fs');
const path = require('path');
const { writeXlsx } = require('./xlsx');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'server', 'tests', 'fixtures');
const OUT_TERM = path.join(ROOT, 'docs', 'eval', 'term_2nd_sem_AY2025_26_eval.json');
const OUT_EXCLUDED = path.join(ROOT, 'docs', 'eval', 'expert_set', 'EXCLUDED_CLASSES.xlsx');
const OUT_SUMMARY = path.join(ROOT, '.demo-data', 'logs', 'ga-eval-term.json');
const BLOCKS = path.join(ROOT, 'docs', 'data', 'past_class_blocks.csv');
const SEMESTER = '2nd Sem AY 2025-26';

const lastYear = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'term_2nd_sem_AY2025_26.json'), 'utf8'));
const current = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'term_2nd_sem_AY2026_27.part7.json'), 'utf8'));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Words without a plural "s", so "Application" and "Applications" match.
const stem = (s) => norm(s).split(' ').map(w => (w.length > 3 ? w.replace(/s$/, '') : w)).join(' ');

// ---- the term file
const buildTerm = () => {
  const sections = lastYear.sections.map(s => ({ ...s, enabled: true }));
  const term = {};
  for (const [key, value] of Object.entries(current)) {
    if (['unassignedMajors', 'unassignedMinors', 'unassignedCoordinations', 'partTimeBalance', 'teachingLoadBalance',
      'phase8Part4', 'phase8Part7', 'lastYearOutsideClasses', 'notes', 'assumptions', 'sources'].includes(key)) continue;
    term[key] = value;
  }
  term._readme = "Phase 9 evaluation term: 2nd Semester AY 2025-26 as the office printed it (the Phase 6 fixture's 19 sections and 71 + 1 + 4 locked assignments), on the current policy and rooms. Built by scripts/eval/build-eval-term.js. Test data only; no ratings.";
  term.term = { academicYear: '2025-2026', semester: '2nd Semester' };
  term.sections = sections;
  term.assignments = lastYear.assignments;
  term.minorAssignments = lastYear.minorAssignments;
  term.practicumCoordinators = lastYear.practicumCoordinators;
  term.unassignedMajors = [];
  term.unassignedCoordinations = [];
  term.assumptions = [
    'ITEP 205 Multimedia Systems (BSIT 2nd year) is on no 2nd Sem AY 2025-26 form (nobody taught it), so it is not part of this evaluation term: the eval database drops that one curriculum mapping, on the throwaway copy only.',
    'The current Scheduling Policy applies (the 08:00-17:00 day, Saturday off, lunch rule, Friday for Extension, odd/even weeks, the part-timer rule), as the system does today.'
  ];
  return term;
};

// ---- the printed blocks and what is left out
const parseCsv = (text) => {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

// A printed block -> the term's section: program + year + track, then the letter when several remain.
const sectionOf = (row, sections) => {
  if (!row.program || !row.year) return null;
  const pool = sections.filter(s => s.program === row.program && String(s.yearLevel) === String(row.year)
    && (s.track === (row.track || (row.program === 'BSCS' ? 'IS' : 'NONE')) || (row.program === 'BSCS' && s.track === 'IS' && !row.track)));
  if (pool.length <= 1) return pool[0] || null;
  const letterOf = (s) => (/(?:^|\s)([A-D])(?:\s|$)/.exec(String(s.sameAsLastYear || '').replace(/^BSIT |^BSCS /, '').replace(/^[IV]+\s*/, ' ')) || [])[1] || '';
  const byLetter = pool.filter(s => letterOf(s) === (row.letter || '').toUpperCase());
  return byLetter.length === 1 ? byLetter[0] : null;
};

const titleMatch = (a, b) => { const x = stem(a); const y = stem(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };

const classify = (rows, term) => {
  const locks = [
    ...term.assignments.map(a => ({ ...a, kind: 'Major' })),
    ...term.minorAssignments.map(a => ({ ...a, kind: 'Minor' })),
    ...term.practicumCoordinators.map(a => ({ ...a, kind: 'Practicum' }))
  ];
  const surname = (n) => norm(String(n).split(',')[0]).split(' ').filter(w => w && !['jr', 'sr', 'ii', 'iii'].includes(w)).pop();
  const roster = new Set(term.faculty.map(f => surname(f.name)));
  const used = new Set();
  const included = []; const excluded = [];
  for (const row of rows) {
    const printed = `${row.day} ${row.start}-${row.end}`;
    const base = { professor: row.faculty, subject: [row.code, row.title].filter(Boolean).join(' '), section: row.section_as_printed || '', printed };
    if (row.level === 'GRADUATE' || /^(Saturday|Sunday)$/.test(row.day) && /^(MIT|DST)/.test(row.code)) { excluded.push({ ...base, why: 'Graduate class (weekend batch); not modelled' }); continue; }
    if (!row.code) { excluded.push({ ...base, why: 'Duty block (research, extension, consultation, management or similar); not a class' }); continue; }
    const section = sectionOf(row, term.sections);
    const mine = locks.filter(l => surname(l.faculty) === norm(row.faculty) && (titleMatch(l.descriptiveTitle, row.title) || l.subjectCode === row.code));
    // A block with no (or an unknown) section printed: the professor's one class of that title.
    const lock = section
      ? mine.find(l => l.sectionCode === section.sectionCode)
      : (mine.length === 1 && !row.section_as_printed.match(/^BS(BA|F|ND|TM)/) ? mine[0] : null);
    if (!lock && !section) { excluded.push({ ...base, why: "Another college's section, or no section printed; not a CCS class" }); continue; }
    if (!lock && !roster.has(norm(row.faculty))) { excluded.push({ ...base, why: 'Professor is not on the current faculty list: P and Q schedule this class with a TBA professor, so skip it in the Faculty view only' }); continue; }
    if (!lock) { excluded.push({ ...base, why: 'No matching class in the curriculum for this section and professor; not modelled' }); continue; }
    used.add(`${lock.sectionCode}|${lock.subjectCode}`);
    included.push({ ...base, sectionCode: lock.sectionCode, lock: `${lock.sectionCode} ${lock.subjectCode}` });
  }
  const unmatchedLocks = locks.filter(l => !used.has(`${l.sectionCode}|${l.subjectCode}`)).map(l => `${l.sectionCode} ${l.subjectCode} (${l.faculty})`);
  return { included, excluded, unmatchedLocks, lockCount: locks.length };
};

const main = () => {
  const term = buildTerm();
  const rows = parseCsv(fs.readFileSync(BLOCKS, 'utf8')).filter(r => r.semester === SEMESTER);
  const { included, excluded, unmatchedLocks, lockCount } = classify(rows, term);
  const summary = {
    sections: term.sections.length, professors: term.faculty.length, locks: lockCount,
    printedBlocks: rows.length, includedBlocks: included.length, excludedBlocks: excluded.length,
    excludedByReason: excluded.reduce((acc, e) => ({ ...acc, [e.why]: (acc[e.why] || 0) + 1 }), {}),
    locksWithoutAPrintedBlock: unmatchedLocks
  };
  if (process.argv.includes('--check')) { console.log(JSON.stringify(summary, null, 2)); return; }
  fs.mkdirSync(path.dirname(OUT_TERM), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_EXCLUDED), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_SUMMARY), { recursive: true });
  fs.writeFileSync(OUT_TERM, `${JSON.stringify(term, null, 2)}\n`);
  fs.writeFileSync(OUT_SUMMARY, `${JSON.stringify({ ...summary, excluded }, null, 2)}\n`);
  const header = ['Professor', 'Subject', 'Section', 'Day/time as printed', 'Why it is left out'];
  writeXlsx(OUT_EXCLUDED, 'Excluded classes', [header, ...excluded.map(e => [e.professor, e.subject, e.section, e.printed, e.why])]);
  console.log(JSON.stringify(summary, null, 2));
};

if (require.main === module) main();
module.exports = { buildTerm, classify, parseCsv, sectionOf };
