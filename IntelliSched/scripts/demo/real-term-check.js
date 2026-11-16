// Phase 8 Part 11, decision 5: the real term's sanity check. On a THROWAWAY copy of the defense data
// (a defense backup restored with `npm run defense:restore -- --from <folder> --into <name>_test`), for
// 2nd Sem AY 2026-27: the top 5 of the ranking for every section of Intermediate Programming (ITEC 103)
// and of 5 more Major subjects picked at random with a printed seed, each with every feature, the
// Overload Guardian's verdict for that section and the reason text, next to the professor the Dean
// assigned. Then the check by eye made mechanical: is the professor who taught the subject most (then
// most recently, then best rated) first? Each case where not is listed with its reason.
//
//   node scripts/demo/real-term-check.js --db <name>_test [--seed N] [--md docs/ml/REAL_TERM_CHECK.md]
//
// It starts the demo's MongoDB for the job alone (refused while a demo runs), reads only, and runs the
// Python ranking (../intellisched_backend/ml/real_term_rank.py) on the copy. The full record, ratings
// included, goes to .demo-data/logs/part11-real-term.json (gitignored); the Markdown shows "rated" /
// "not rated" and the ranks only, never a rating. Never the defense database, never intellisched_db.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const { REPO_ROOT, SERVER_DIR, LOG_DIR } = require('./paths');
const { withDemoMongo } = require('./defense-backup');

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const mongoose = serverRequire('mongoose');
const BACKEND_DIR = path.join(REPO_ROOT, '..', 'intellisched_backend');
const PYTHON = path.join(BACKEND_DIR, '.venv', 'Scripts', 'python.exe');
const REFUSED = new Set(['intellisched_db', 'intellisched_defense_test', 'intellisched_demo_test', 'intellisched_demo_full_test', 'intellisched_demo_sem2_test']);
const TERM = { academicYear: '2026-2027', semester: 2, label: '2nd Sem AY 2026-27' };
const FOCUS = 'ITEC 103';

const valueOf = (args, flag) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};

// A small seeded generator (mulberry32), so the same seed picks the same subjects.
const seeded = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const runPython = (uri, request) => new Promise((resolve, reject) => {
  const child = spawn(PYTHON, ['-m', 'ml.real_term_rank'], { cwd: BACKEND_DIR, env: { ...process.env, MONGO_URI: uri }, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', reject);
  child.on('exit', (code) => {
    if (code !== 0) return reject(new Error(`The ranking failed (exit ${code}): ${err.split('\n').slice(-4).join(' ')}`));
    const last = out.trim().split('\n').pop();
    try { resolve(JSON.parse(last)); } catch (e) { reject(new Error(`The ranking's answer could not be read: ${e.message}`)); }
  });
  child.stdin.end(JSON.stringify(request));
});

// The office's own order (the team's example): most sections taught, then most recently, then the
// evaluation, then the specialization match.
const officeOrder = (a, b) => (b.features.sections_taught - a.features.sections_taught)
  || (a.features.terms_since_last_taught - b.features.terms_since_last_taught)
  || (b.features.eval_rating - a.features.eval_rating)
  || (b.features.semantic_match - a.features.semantic_match);

const matchWord = (s) => (s >= 0.15 ? 'high' : s >= 0.05 ? 'medium' : 'low');
const ago = (n) => (n >= 99 ? 'never' : `${n}`);

// Why the model's first is not the office's first, in words (no rating).
const whyNot = (top, expected, nobodyTaught = false) => {
  const t = top.features;
  const e = expected.features;
  const reasons = [];
  if (!nobodyTaught && t.sections_taught === e.sections_taught && t.terms_since_last_taught === e.terms_since_last_taught) {
    if (t.eval_missing !== e.eval_missing) reasons.push(`same history; ${top.name} is ${t.eval_missing ? 'not rated (takes the median)' : 'rated'} and ${expected.name} ${e.eval_missing ? 'not rated (takes the median)' : 'rated'}`);
    else reasons.push('same history; the evaluation decides the office\'s order, the model weighs it with the other features');
  }
  if (t.taught_it_last_same_semester > e.taught_it_last_same_semester) reasons.push(`${top.name} taught it last year's same semester and ${expected.name} did not`);
  if (t.semantic_match > e.semantic_match && matchWord(t.semantic_match) !== matchWord(e.semantic_match)) reasons.push(`specialization match ${matchWord(t.semantic_match)} against ${matchWord(e.semantic_match)}`);
  if (t.is_full_time !== e.is_full_time) reasons.push(`${top.name} is ${t.is_full_time ? 'full-time' : 'part-time'}, ${expected.name} ${e.is_full_time ? 'full-time' : 'part-time'}`);
  if (t.program_experience > e.program_experience) reasons.push(`more terms in the program (${t.program_experience} against ${e.program_experience})`);
  if (!reasons.length) reasons.push('the model\'s combined score (no single feature)');
  return reasons.join('; ');
};

const run = async () => {
  const args = process.argv.slice(2);
  const db = valueOf(args, '--db');
  if (!db || !/_test$/.test(db) || REFUSED.has(db)) {
    throw new Error('Name a throwaway copy with --db <name>_test (a restored defense backup); the defense database, the demos\' and intellisched_db are refused.');
  }
  const seed = Number(valueOf(args, '--seed') || 11);
  const mdOut = path.join(REPO_ROOT, valueOf(args, '--md') || path.join('docs', 'ml', 'REAL_TERM_CHECK.md'));
  const logOut = path.join(LOG_DIR, 'part11-real-term.json');
  const say = (line) => console.log(`[real-term] ${line}`);

  const record = await withDemoMongo({ runMode: 'real-term-check', say, job: async ({ uriFor }) => {
    const uri = uriFor(db);
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    try {
      ['SubjectCatalog', 'CurriculumMapping', 'MotherSchedule', 'SchedulingPolicy'].forEach(m => { try { serverRequire(path.join(SERVER_DIR, 'src', 'models', m)); } catch { /* not a model file here */ } });
      const Faculty = serverRequire(path.join(SERVER_DIR, 'src', 'models', 'Faculty'));
      const Section = serverRequire(path.join(SERVER_DIR, 'src', 'models', 'Section'));
      const { findTermMappings, findTermLockSource } = serverRequire(path.join(SERVER_DIR, 'src', 'utils', 'termInputs'));
      const { loadPolicy } = serverRequire(path.join(SERVER_DIR, 'src', 'utils', 'policy'));
      const { isTbaSubject, buildTermPairs, findLockFor } = serverRequire(path.join(SERVER_DIR, 'src', 'utils', 'curriculumMatcher'));
      const { buildTermAssignments, buildFacultyResolver } = serverRequire(path.join(SERVER_DIR, 'src', 'utils', 'termAssignments'));
      const { facultyLoad, weightedHoursOf } = serverRequire(path.join(SERVER_DIR, 'src', 'utils', 'load'));

      const [mappings, faculty, sections, source, policy] = await Promise.all([
        findTermMappings(TERM.semester), Faculty.find({ isActive: true }), Section.find({ isActive: true }),
        findTermLockSource({ academicYear: TERM.academicYear, semester: TERM.semester }), loadPolicy()
      ]);
      const pairs = buildTermPairs(sections, mappings);
      const locks = source?.lockedAssignments || [];
      const assignments = buildTermAssignments({ faculty, pairs, locks });
      const resolve = buildFacultyResolver(faculty);
      const byCode = new Map(faculty.map(f => [String(f.facultyId), f]));
      const majors = [...new Map(pairs.filter(p => !isTbaSubject(p.subject) && !p.subject.isPracticum)
        .map(p => [String(p.subject._id), p.subject])).values()]
        .sort((a, b) => String(a.subjectCode).localeCompare(String(b.subjectCode), 'en', { numeric: true }) || String(a._id).localeCompare(String(b._id)));
      const focus = majors.filter(s => s.subjectCode === FOCUS);
      const pool = majors.filter(s => s.subjectCode !== FOCUS);
      const random = seeded(seed);
      const picked = [];
      while (picked.length < 5 && pool.length) picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
      const chosen = [...focus, ...picked];
      say(`Seed ${seed}: ${focus.length ? FOCUS : `(${FOCUS} is not in the term)`} + ${picked.map(s => s.subjectCode).join(', ')}`);

      const programsOf = (s) => [...new Set(mappings.filter(m => String(m.subject?._id ?? m.subject) === String(s._id)).map(m => String(m.program).toUpperCase()))];
      const answer = await runPython(uri, {
        academicYear: TERM.academicYear, semester: TERM.semester,
        subjects: chosen.map(s => ({ subjectId: String(s._id), subjectCode: s.subjectCode, subjectTitle: s.descriptiveTitle, subjectDescription: s.subjectDescription || s.descriptiveTitle, programs: programsOf(s) }))
      });

      const subjects = chosen.map((subject, i) => {
        const ranked = answer.subjects[i].candidates;
        const officeRanked = [...ranked].sort(officeOrder);
        const expected = officeRanked[0];
        // Nobody on the faculty taught it: the history decides nothing, and the office's order falls to
        // the evaluation alone (the Dean decides; ITEP 205 is the case).
        const nobodyTaught = ranked.every(c => c.features.sections_taught === 0);
        const subjectPairs = pairs.filter(p => String(p.subject._id) === String(subject._id))
          .sort((a, b) => String(a.section.sectionCode).localeCompare(String(b.section.sectionCode), 'en', { numeric: true }));
        const perSection = subjectPairs.map(({ section }) => {
          const lock = findLockFor(locks, section.sectionCode, subject);
          const holder = lock ? resolve(lock) : null;
          const top5 = ranked.slice(0, 5).map((c) => {
            const owner = byCode.get(String(c.id)) || faculty.find(f => f.name === c.name);
            const load = owner ? facultyLoad(owner, assignments.get(String(owner._id)) || [], policy) : null;
            const add = owner ? weightedHoursOf(subject, owner, policy) : null;
            const holds = holder && owner && String(holder._id) === String(owner._id);
            const after = load ? Math.round(((load.teaching - (holds ? add : 0)) + add) * 100) / 100 : null;
            return { ...c, currentHours: load ? load.teaching : null, cap: load ? load.cap : null, wouldReach: after, guardian: load ? (after <= load.cap ? 'allowed' : 'over the cap') : 'unknown', holdsIt: Boolean(holds) };
          });
          const holderRank = holder ? (ranked.find(c => String(c.id) === String(holder.facultyId))?.rank ?? null) : null;
          return { section: section.sectionCode, assigned: holder ? holder.name : null, assignedRank: holderRank, top5 };
        });
        const top = ranked[0];
        const agrees = String(top.id) === String(expected.id);
        return {
          subjectCode: subject.subjectCode, title: subject.descriptiveTitle, candidates: ranked.length,
          officeFirst: { name: expected.name, rank: expected.rank }, modelFirst: top.name, agrees, nobodyTaught,
          officeTop3: officeRanked.slice(0, 3).map(c => ({ name: c.name, rank: c.rank })), modelTop3: ranked.slice(0, 3).map(c => c.name),
          deansChoices: [...new Set(perSection.filter(p => p.assigned).map(p => `${p.assigned} (${p.assignedRank ?? '—'})`))],
          why: agrees ? null : (nobodyTaught ? 'nobody on the faculty has taught it, so the office\'s order is the evaluation alone; ' : '') + whyNot(top, expected, nobodyTaught),
          sections: perSection
        };
      });
      const now = new Date();
      const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return { recordedAt: now.toISOString(), localDate, db, term: TERM.label, seed, subjects };
    } finally {
      await mongoose.disconnect();
    }
  } });

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(logOut, `${JSON.stringify(record, null, 2)}\n`);
  say(`Full record (ratings included, gitignored): ${path.relative(REPO_ROOT, logOut)}`);
  // The hand-written "## Reading the check" section is kept across runs.
  const kept = fs.existsSync(mdOut) ? (/\n## Reading the check\n[\s\S]*$/.exec(fs.readFileSync(mdOut, 'utf8')) || [''])[0] : '';
  fs.writeFileSync(mdOut, markdown(record) + kept);
  say(`Written: ${path.relative(REPO_ROOT, mdOut)}`);
  for (const s of record.subjects) say(`${s.subjectCode}: model 1st ${s.modelFirst}; office 1st ${s.officeFirst.name} (model rank ${s.officeFirst.rank}) ${s.agrees ? 'AGREE' : `DIFFER: ${s.why}`}`);
};

const markdown = (record) => {
  const lines = [
    '# The real term: the ranking checked by eye (Phase 8 Part 11, decision 5)',
    '',
    `Made by \`node scripts/demo/real-term-check.js --db ${record.db} --seed ${record.seed}\` on ${record.localDate}: a throwaway copy of the defense data (the backup of 14 Oct 2026 01:39 with the teaching history refreshed by the loader's own function), term ${record.term}. The ranking is the service's own path (Engine 1's match, Engine 2's monotonic model and reason text) with every professor scored; the Overload Guardian's verdict is the gateway's load rule (\`utils/load.js\`): the professor's teaching hours this term without this class, plus what this class adds, against their cap.`,
    '',
    `Subjects: ${FOCUS} (Intermediate Programming) and five Major subjects drawn with seed ${record.seed}. No rating is printed: "rated" / "not rated" only (the full record stays in \`.demo-data/logs/part11-real-term.json\`). "Sections" and "semesters" count the 4 transcribed semesters before the term; "last" is how many terms ago the professor last taught it.`,
    '',
    '**The office\'s order** (the team\'s rule for "who should be first"): most sections taught, then most recently, then the evaluation, then the specialization match. The check compares the model\'s first with that order\'s first.',
    '',
    '## Summary',
    '',
    '| Subject | Model\'s top 3 | Office\'s top 3 (model rank) | First agrees | Dean\'s choice on 9 Oct (model rank) | Why not |',
    '|---|---|---|---|---|---|'
  ];
  for (const s of record.subjects) {
    lines.push(`| ${s.subjectCode} ${s.title} | ${s.modelTop3.join(', ')} | ${s.officeTop3.map(c => `${c.name} (${c.rank})`).join(', ')} | ${s.agrees ? 'yes' : 'no'} | ${s.deansChoices.join(', ') || 'nobody'} | ${s.why || ''} |`);
  }
  const agree = record.subjects.filter(s => s.agrees).length;
  lines.push('', `${agree} of ${record.subjects.length} subjects agree.`, '');
  for (const s of record.subjects) {
    lines.push(`## ${s.subjectCode} ${s.title}`, '', `${s.candidates} professors ranked. The ranking is per subject, so the top 5 is the same for every section; the Guardian's verdict and the assigned professor are per section.`, '');
    const first = s.sections[0];
    if (!first) { lines.push('No section takes it this term.', ''); continue; }
    lines.push('| Rank | Professor | Likelihood | Sections | Semesters | Last (terms ago) | Last same sem. | Evaluation | Match | Full-time | Program terms | Reason |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of first.top5) {
      const f = c.features;
      const reason = String(c.reason).replace(/Student evaluation: [0-9.]+ of 5/, 'Student evaluation: on record');
      lines.push(`| ${c.rank} | ${c.name} | ${c.score.toFixed(1)}% | ${f.sections_taught} | ${f.semesters_taught} | ${ago(f.terms_since_last_taught)} | ${f.taught_it_last_same_semester ? 'yes' : 'no'} | ${f.eval_missing ? 'not rated' : 'rated'} | ${matchWord(f.semantic_match)} | ${f.is_full_time ? 'yes' : 'no'} | ${f.program_experience} | ${reason} |`);
    }
    lines.push('', '| Section | Assigned by the Dean (model rank) | Guardian, top 5 in order (hours this class would bring them to / cap) |', '|---|---|---|');
    for (const sec of s.sections) {
      const verdicts = sec.top5.map(c => `${c.rank}. ${c.guardian === 'allowed' ? 'allowed' : '**over the cap**'} (${c.wouldReach} / ${c.cap})`).join('; ');
      lines.push(`| ${sec.section} | ${sec.assigned ? `${sec.assigned} (${sec.assignedRank ?? '—'})` : 'nobody'} | ${verdicts} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

run().catch((err) => { console.error(`[real-term] ${err.message}`); process.exitCode = 1; });
