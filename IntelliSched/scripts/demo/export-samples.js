// Phase 8 Part 2, Step 8: the committed sample exports. On a running `npm run demo:sem2:reset --
// --faculty-seed`, it follows the Dean's path the rehearsal's way (the ITEP 205 classes to Mr. Faculty
// as her recorded override, the Readiness Check, one generation as the TEST Dean — or the
// term's Draft when one exists), then downloads the complete next-semester set from the export routes
// (all sections, all professors, all rooms for the odd and the even weeks, each as DOCX and PDF) and
// writes it to docs/outputs-samples/exports/ with its README.
// Safety rules (committed evidence): the files are staged in .demo-data/export-samples/ first and
// copied only when every file and check passed; the committed folder is refused unless the demo's
// faculty came from the tracked seed file (--faculty-seed), and the defense database is refused;
// `--out <a folder git ignores>` makes a private set instead. The forms carry no rating.
// Usage: npm run demo:sem2:reset -- --faculty-seed, then in a second terminal
//   node scripts/demo/export-samples.js [--seed 1] [--out <folder>]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const { apiOf, readiness, assignUnassignedMajors, generateSeed } = require('./deans-path');
const { pdfInfo } = require(path.join(REPO, 'server', 'src', 'exports', 'pdf'));

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const SEED = Number(argOf('--seed', 1));
// Phase 8 Part 9: each committed set is named by its data source; this one is the practice copy
// (tracked seed faculty), beside defense-data-copy/ (a throwaway copy of the defense data, made by
// scripts/forms/export-copy.js).
const OUT = path.resolve(REPO, argOf('--out', path.join('docs', 'outputs-samples', 'exports', 'practice-copy-seed-faculty')));
const COMMITTED = path.resolve(REPO, 'docs', 'outputs-samples', 'exports', 'practice-copy-seed-faculty');
const STAGE = path.join(REPO, '.demo-data', 'export-samples');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const TERM_FILE = path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const log = (m) => console.log(`[export-samples ${new Date().toISOString().slice(11, 19)}] ${m}`);

const EXPORT_SET = [
  { view: 'class-schedule', per: 'section' },
  { view: 'teachers-program', per: 'professor' },
  { view: 'room-schedule', per: 'room', weekGroup: 'odd' },
  { view: 'room-schedule', per: 'room', weekGroup: 'even' }
];

(async () => {
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.mode === 'defense') throw new Error('The defense database is never written by evidence scripts. Run this on npm run demo:sem2:reset -- --faculty-seed.');
  if (run.state !== 'ready' || run.mode !== 'sem2') throw new Error(`The demo is not a ready 2nd-semester demo (mode ${run.mode}, state ${run.state}).`);
  if (OUT === COMMITTED && run.facultySource !== 'seed') {
    throw new Error('docs/outputs-samples/exports/practice-copy-seed-faculty/ is committed evidence, made from tracked data only: start the demo with `npm run demo:sem2:reset -- --faculty-seed`, or write a private set with --out <a folder git ignores>.');
  }
  if (OUT !== COMMITTED) {
    const ignored = execSync(`git check-ignore "${OUT}" || exit 0`, { cwd: REPO, shell: true, encoding: 'utf8' }).trim();
    if (!ignored) throw new Error(`--out must name a folder git ignores (got ${OUT}).`);
  }
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const { call, login } = apiOf(run);
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));

  // The Dean's path, the rehearsal's way: the ITEP 205 override, readiness, then the term's generated
  // Draft (kept when one exists) or one generation with the seed (Phase 8 Part 8: as the TEST Dean).
  await assignUnassignedMajors({ call, dean, TERM, term: termFile, log });
  const ready = await readiness(call, dean, TERM);
  if (ready.verdict !== 'ready') throw new Error(`The Readiness Check says "${ready.verdict}".`);
  const existing = (await call('GET', `/schedule/outputs?${termQuery}`, { token: dean }));
  let scheduleId;
  let version;
  let seedUsed = null;
  if (existing.status === 200 && existing.data.schedule?.generated) {
    scheduleId = existing.data.schedule.id;
    version = existing.data.schedule.version;
    log(`using the term's generated Draft ${version}`);
  } else {
    const row = await generateSeed({ call, dean, TERM, seed: SEED, log });
    if (row.status !== 'done' || !row.scheduleId) throw new Error(`The run ended "${row.status}": ${row.message}`);
    if (row.checkedConflicts !== 0) throw new Error(`The saved Draft has ${row.checkedConflicts} conflicts: not sample material. Try another seed.`);
    scheduleId = row.scheduleId;
    version = row.version;
    seedUsed = SEED;
    log(`generated ${version} with seed ${SEED}: 0 conflicts`);
  }

  // The expected page counts, from the same outputs the exports read.
  const outputs = (await call('GET', `/schedule/outputs?${termQuery}&scheduleId=${scheduleId}`, { token: dean })).data;
  const printableProfessors = (outputs.faculty || []).filter(f => f.classCount > 0 || (f.selfPaced || []).length > 0 || (f.practicum?.blocks || []).length > 0);
  const roomsInGroup = (group) => {
    const inGroup = (c) => !c.weekGroup || c.weekGroup === group;
    const tbaWithClasses = new Set((outputs.classes || []).filter(c => c.extraRoomKey && inGroup(c)).map(c => c.roomKey));
    return (outputs.rooms || []).filter(r => (r.kind === 'TBA' ? tbaWithClasses.has(r.key) : true)).length;
  };
  const expectedPages = {
    'class-schedule': (outputs.sections || []).filter(s => s.classCount > 0).length,
    'teachers-program': printableProfessors.length,
    'room-schedule:odd': roomsInGroup('ODD'),
    'room-schedule:even': roomsInGroup('EVEN')
  };

  // Download the set into the stage; copy only when everything passed.
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const files = [];
  for (const target of EXPORT_SET) {
    for (const format of ['docx', 'pdf']) {
      const q = new URLSearchParams({ ...TERM, view: target.view, format, scheduleId, ...(target.weekGroup ? { weekGroup: target.weekGroup } : {}) });
      const res = await fetch(`http://localhost:${run.ports.gateway}/api/schedule/exports?${q}`, { headers: { authorization: `Bearer ${dean}` } });
      if (res.status !== 200) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`${target.view} (${format}${target.weekGroup ? `, ${target.weekGroup} weeks` : ''}): ${body.message || res.status}`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1];
      const buffer = Buffer.from(await res.arrayBuffer());
      const expected = expectedPages[target.weekGroup ? `${target.view}:${target.weekGroup}` : target.view];
      const pages = format === 'pdf' ? pdfInfo(buffer).pages : Number(res.headers.get('x-export-pages'));
      if (!name || buffer.length < 10_000) throw new Error(`${target.view} (${format}): the file came back too small (${buffer.length} bytes).`);
      if (pages !== expected) throw new Error(`${name}: ${pages} pages, ${expected} expected (one per ${target.per}).`);
      fs.writeFileSync(path.join(STAGE, name), buffer);
      files.push({ name, format, pages, per: target.per, weekGroup: target.weekGroup || null, kb: Math.round(buffer.length / 1024) });
      log(`staged ${name} (${pages} pages, ${Math.round(buffer.length / 1024)} KB)`);
    }
  }

  // Every check passed: replace the set and write the README.
  fs.mkdirSync(OUT, { recursive: true });
  for (const old of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, old), { force: true });
  for (const f of files) fs.copyFileSync(path.join(STAGE, f.name), path.join(OUT, f.name));
  const readme = `# Sample exports: the practice copy (seed faculty)

The complete next-semester set of the office's three files (Phase 8 Part 2; the page layout of Phase 8 Part 9), exported from
IntelliSched's own export routes on the 2nd Semester AY 2026-2027 demo — the same files the Export
card on Print Outputs downloads. Made from tracked data only (the demo seeded with \`--faculty-seed\`);
the forms carry no rating.

- **Version:** ${version}${seedUsed !== null ? `, generated with seed ${seedUsed}` : ' (the demo’s generated Draft)'} — a Draft, so every page carries the small DRAFT line until a version is approved.
- **Term:** 2nd Semester AY ${TERM.academicYear}; the ITEP 205 classes assigned to Morris Virtus Faculty first (the Dean’s planned override, with the reason recorded).
- **References:** the office’s own files in \`docs/formats/\` (LSPU-ACAD-SF-003, the two room-schedule files, the SF-029 scans).

| File | Pages | One per |
|---|---|---|
${files.map(f => `| \`${f.name}\` | ${f.pages} | ${f.per}${f.weekGroup ? ` (${f.weekGroup} weeks)` : ''} |`).join('\n')}

## Make them again
1. \`npm run demo:sem2:reset -- --faculty-seed\` (repo root), wait for "Press Ctrl+C to stop".
2. In a second terminal: \`node scripts/demo/export-samples.js [--seed 1]\`. It stages every file in
   \`.demo-data/export-samples/\` and replaces this folder only when every file and page count passed;
   it refuses this committed folder unless the demo’s faculty came from the tracked seed file
   (\`--out <a folder git ignores>\` writes a private set instead).
3. Stop the demo with Ctrl+C.

\`npm run system-check\` makes the same set on a fresh practice copy, with the full diagnostic report
(docs/SYSTEM_CHECK.md).
`;
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);
  log(`wrote ${files.length} files + README.md to ${path.relative(REPO, OUT)}`);
})().catch((err) => {
  console.error(`[export-samples] ${err.stack || err.message}`);
  process.exit(1);
});
