// Phase 11: the three forms downloaded from a RUNNING practice copy (npm run demo:sem2[:reset]) through
// the Export card's own route, into a folder git ignores, with the exports.json that compare.js reads —
// so `npm run forms:compare -- --dir <folder>` can measure the practice copy without making a copy of the
// defense data. Read only; refuses the defense demo.
//   node scripts/forms/export-demo.js [--out .demo-data/part11/export]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const { apiOf } = require(path.join(REPO, 'scripts', 'demo', 'deans-path'));
const { buildExportModel } = require(path.join(REPO, 'server', 'src', 'exports', 'pageModels'));
const args = process.argv.slice(2);
const valueOf = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const OUT = path.resolve(REPO, valueOf('--out') || path.join('.demo-data', 'part11', 'export'));

(async () => {
  const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
  if (run.mode === 'defense' || /defense/i.test(run.db || '')) throw new Error('Not on the defense demo.');
  if (run.state !== 'ready') throw new Error('No demo is running.');
  if (!execSync(`git check-ignore "${OUT}" || exit 0`, { cwd: REPO, shell: true, encoding: 'utf8' }).trim()) throw new Error(`--out must be a folder git ignores (got ${OUT}).`);
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  const { call, login } = apiOf(run);
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const outputs = (await call('GET', `/schedule/outputs?academicYear=${TERM.academicYear}&semester=${TERM.semester}`, { token: dean })).data;
  if (!outputs?.schedule?.generated) throw new Error('The term has no generated version yet.');
  // Phase 11.2: ONE Room Schedule file (the labs' week groups are pages of it).
  const groups = ['ALL'];
  const jobs = [{ view: 'class-schedule' }, ...groups.map(weekGroup => ({ view: 'room-schedule', weekGroup })), { view: 'teachers-program' }];
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const files = [];
  const shortened = [];
  for (const job of jobs) {
    const model = buildExportModel(outputs, job.view, { weekGroup: job.weekGroup || 'ALL' });
    shortened.push(...(model.shortened || []).map(s => ({ view: job.view, ...s })));
    for (const format of ['docx', 'pdf']) {
      const q = new URLSearchParams({ ...TERM, view: job.view, format, scheduleId: outputs.schedule.id, ...(job.weekGroup && job.weekGroup !== 'ALL' ? { weekGroup: job.weekGroup.toLowerCase() } : {}) });
      const res = await fetch(`http://localhost:${run.ports.gateway}/api/schedule/exports?${q}`, { headers: { authorization: `Bearer ${dean}` } });
      if (res.status !== 200) throw new Error(`${job.view} ${format}: ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1];
      fs.writeFileSync(path.join(OUT, name), Buffer.from(await res.arrayBuffer()));
      files.push({ view: job.view, weekGroup: job.weekGroup || null, format, file: name, pages: Number(res.headers.get('x-export-pages')), pageNames: model.pages.map(p => p.name) });
      console.log(`${name}: ${files[files.length - 1].pages} page(s)`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'exports.json'), `${JSON.stringify({ version: outputs.schedule.versionLabel || outputs.schedule.version, status: outputs.schedule.status, db: run.db, files, shortened }, null, 2)}\n`);
})().catch(err => { console.error(err.message); process.exit(1); });
