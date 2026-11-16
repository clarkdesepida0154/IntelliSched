// Phase 4 Part 2, Step 2 evidence: the Dean's manual edits on the full-college demo, through the gateway
// (the same routes the Schedule Views & Editor calls). Readiness Check -> generate with the seed (as the
// TEST Dean since Phase 8 Part 8; the next seed when a run ends with conflicts) unless the term already has a generated
// Draft -> as the TEST Dean: "Change professor" on one Major class (every professor's live verdict; one
// change saved; one refused by the gateway's own check), then "Swap with another class" (one swap saved).
// Prints the words the pages show and writes a JSON record. Test data only: the demo's own _test database.
//
// Usage (repo root): start a fresh demo with `npm run demo:full:reset` (or `-- --faculty-seed`), then in a
// second terminal:   node scripts/demo/manual-edits-run.js [--seed N] [--out <file.json>]
// It reads the demo's ports from .demo-data/run.json and the TEST logins from .demo-data/demo-secrets.json.
// The default output is .demo-data/manual-edits-run.json (gitignored with the rest of .demo-data).
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const seedWanted = Number(argOf('--seed', 1));
const OUT = path.resolve(REPO, argOf('--out', path.join('.demo-data', 'manual-edits-run.json')));
const secrets = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'demo-secrets.json'), 'utf8'));
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
const API = `http://localhost:${run.ports.gateway}/api`;
const log = (m) => console.log(`[edits-run ${new Date().toISOString().slice(11, 19)}] ${m}`);

const call = async (method, route, { token, body } = {}) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};
const login = async (who, email, password) => {
  if (!email || !password) throw new Error(`No ${who} login in .demo-data/demo-secrets.json. Start the demo once to create it.`);
  const res = await call('POST', '/auth/login', { body: { username: email, password } });
  if (res.status !== 200) throw new Error(`${who} login: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.token;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (what, res) => new Error(`${what}: ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`);
const timeWords = (start, end) => {
  const f = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  return `${f(start)} – ${f(end)}`;
};

(async () => {
  if (!Number.isInteger(seedWanted) || seedWanted < 0) throw new Error('--seed needs a whole number, e.g. --seed 1.');
  if (run.state !== 'ready' || run.mode !== 'full') throw new Error(`The demo is not a ready full-college demo (mode ${run.mode}, state ${run.state}). Start npm run demo:full:reset first.`);
  const term = { academicYear: '2025-2026', semester: 1 };
  const record = { startedAt: new Date().toISOString(), term, facultySource: run.facultySource, seed: null };
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  const secretary = dean; // Phase 8 Part 8: one account — the TEST Dean starts the runs with a seed too
  log('signed in as the TEST Dean');

  // 1. A generated Draft: the newest one, or one run (seed, next seed on conflicts) after the Readiness Check.
  const versions = (await call('GET', `/schedule/versions?academicYear=${term.academicYear}&semester=${term.semester}`, { token: dean })).data.versions || [];
  let draft = versions.find(v => !v.legacy && v.gaStats && v.workflowStatus === 'Draft' && v.totalScheduled > 0) || null;
  if (draft) {
    log(`the term already has a generated Draft (${draft.id}); using it`);
    record.draft = { id: draft.mongoId, version: draft.id, reused: true };
  } else {
    const pre = await call('POST', '/schedule/preflight', { token: dean, body: term });
    if (pre.status !== 200) throw fail('preflight', pre);
    const readiness = pre.data.report.readiness;
    log(`Readiness: ${readiness.verdict}`);
    if (readiness.verdict !== 'ready') throw new Error('The term is not ready to generate; see the Readiness Check.');
    let saved = null;
    record.runs = [];
    for (let seed = seedWanted; seed < seedWanted + 5 && !saved; seed++) {
      const start = await call('POST', '/schedule/generate', { token: secretary, body: { targetAcademicYear: term.academicYear, targetSemester: term.semester, hyperparameters: { seed } } });
      if (start.status !== 202) throw fail('generate', start);
      log(`run ${start.data.runId} started with seed ${seed}`);
      let runDoc;
      for (;;) {
        await sleep(2000);
        runDoc = (await call('GET', `/schedule/runs/${start.data.runId}`, { token: dean })).data.run;
        if (['done', 'failed', 'cancelled'].includes(runDoc.status)) break;
      }
      const runtimeMs = runDoc.runtimeMs ?? runDoc.gaStats?.runtimeMs ?? null;
      log(`run ${runDoc.status}: ${runDoc.message}${runtimeMs ? ` (${Math.round(runtimeMs / 100) / 10} s)` : ''}`);
      record.runs.push({ seed, status: runDoc.status, message: runDoc.message, runtimeMs, version: runDoc.version });
      if (runDoc.status === 'done') { saved = runDoc; record.seed = seed; }
    }
    if (!saved) throw new Error('No run ended without conflicts (5 seeds tried).');
    record.draft = { id: saved.scheduleId, version: saved.version, reused: false };
  }
  const scheduleId = record.draft.id;
  const outputsOf = async () => (await call('GET', `/schedule/outputs?academicYear=${term.academicYear}&semester=${term.semester}&scheduleId=${scheduleId}`, { token: dean })).data;
  let outputs = await outputsOf();
  if (!outputs?.classes) throw new Error('The Draft\'s outputs could not be read.');
  log(`Draft ${outputs.schedule.version}: ${outputs.classes.length} classes`);

  // 2. "Change professor" on one Major class with a professor (the first Major pair with both a lecture
  //    and a lab, so the change names more than one meeting).
  const pairKey = (c) => `${c.sectionId}:${c.subjectId}`;
  const byPair = new Map();
  for (const c of outputs.classes) {
    if (c.isMinor || c.isFixed || !c.facultyRef) continue;
    if (!byPair.has(pairKey(c))) byPair.set(pairKey(c), []);
    byPair.get(pairKey(c)).push(c);
  }
  // The full college is dense: the first pair with at least one free professor is the one shown (pairs
  // with both a lecture and a lab first, so the change names more than one meeting).
  const candidates = [...byPair.values()].sort((x, y) => Number(y.some(i => i.classType === 'LAB') && y.some(i => i.classType === 'LEC')) - Number(x.some(i => i.classType === 'LAB') && x.some(i => i.classType === 'LEC')));
  if (!candidates.length) throw new Error('No Major class with a professor in the Draft.');
  let pairItems = null;
  let check = null;
  let pairsTried = 0;
  for (const items of candidates.slice(0, 60)) {
    pairsTried += 1;
    const res = await call('POST', '/schedule/change-professor/check', { token: dean, body: { scheduleId, sectionId: items[0].sectionId, subjectId: items[0].subjectId } });
    if (res.status !== 200) throw fail('change-professor/check', res);
    if (res.data.verdicts.some(v => v.ok && v.facultyRef)) { pairItems = items; check = res; break; }
  }
  if (!pairItems) throw new Error(`No Major class among the first ${pairsTried} pairs has a free professor.`);
  const cls = pairItems[0];
  log(`Change professor (${pairsTried} pair${pairsTried === 1 ? '' : 's'} checked for one with a free professor): ${cls.subjectCode} (${cls.sectionLabel}), now ${cls.facultyName}: ${pairItems.map(i => `${i.classType} ${i.day} ${timeWords(i.startTime, i.endTime)}`).join(', ')}`);
  const verdicts = check.data.verdicts;
  log(`changes: ${check.data.changeText}`);
  verdicts.forEach(v => log(`  ${v.ok ? 'OK ' : '✖  '} ${v.name}: ${v.text}`));
  record.changeProfessor = { class: `${cls.subjectCode} (${cls.sectionLabel})`, now: cls.facultyName, pairsTried, changeText: check.data.changeText, verdicts: verdicts.map(v => ({ name: v.name, ok: v.ok, text: v.text })) };

  // A refused save first (the gateway runs its own check again): the first professor the check refused.
  const refusedCandidate = verdicts.find(v => !v.ok && !v.same && v.facultyRef);
  if (refusedCandidate) {
    const refused = await call('POST', '/schedule/change-professor', { token: dean, body: { scheduleId, sectionId: cls.sectionId, subjectId: cls.subjectId, facultyRef: refusedCandidate.facultyRef, reason: 'Demo of a refused change' } });
    log(`refused save (${refused.status} ${refused.data?.code}): ${refused.data?.message}`);
    record.changeProfessor.refused = { professor: refusedCandidate.name, status: refused.status, code: refused.data?.code, message: refused.data?.message };
    if (refused.status !== 409) throw fail('a refused change should answer 409', refused);
  } else log('no professor was refused by the check (nothing to show for a refused save)');

  // Then one change saved: the first professor the check allows.
  const okCandidate = verdicts.find(v => v.ok && v.facultyRef);
  if (!okCandidate) throw new Error('No professor is free for this class.');
  const savedChange = await call('POST', '/schedule/change-professor', { token: dean, body: { scheduleId, sectionId: cls.sectionId, subjectId: cls.subjectId, facultyRef: okCandidate.facultyRef, reason: 'Demo of a saved change' } });
  if (savedChange.status !== 200) throw fail('change-professor', savedChange);
  log(`saved: ${savedChange.data.message}`);
  record.changeProfessor.saved = { professor: okCandidate.name, message: savedChange.data.message, lastCheck: savedChange.data.lastCheck };
  const locks = (await call('GET', `/schedule/locks?academicYear=${term.academicYear}&semester=${term.semester}`, { token: dean })).data.locks || [];
  const lock = locks.find(l => l.sectionCode === cls.sectionCode && String(l.subjectId) === String(cls.subjectId));
  log(`the term's assignment now: ${lock ? `${lock.facultyName} (${lock.facultyId}, ${lock.source})` : 'none'}`);
  record.changeProfessor.termAssignment = lock ? { facultyName: lock.facultyName, facultyId: lock.facultyId, source: lock.source } : null;
  outputs = await outputsOf();
  const after = outputs.classes.filter(c => pairKey(c) === pairKey(cls));
  log(`the classes now: ${after.map(i => `${i.classType} ${i.day} ${timeWords(i.startTime, i.endTime)} ${i.facultyName}`).join('; ')}`);
  record.changeProfessor.classesAfter = after.map(i => ({ type: i.classType, day: i.day, start: i.startTime, end: i.endTime, professor: i.facultyName }));

  // 3. "Swap with another class": a class of one section with another of the same section, the first pair
  //    the check allows (the pages offer the same section's and the same professor's classes).
  // The classes the panel offers for a swap: the same section's and the same professor's; Majors with a
  // professor first (a Minor without a room rarely fits a room's rules).
  const movable = outputs.classes.filter(c => !c.isFixed);
  const starters = [...movable.filter(c => !c.isMinor && c.facultyRef), ...movable.filter(c => c.isMinor || !c.facultyRef)];
  let swapped = null;
  record.swap = { tried: [] };
  outer: for (const a of starters) {
    const others = movable.filter(b => b.itemId !== a.itemId && (b.sectionId === a.sectionId || (a.facultyRef && b.facultyRef === a.facultyRef)));
    for (const b of others) {
      const sc = await call('POST', '/schedule/swap/check', { token: dean, body: { scheduleId, itemA: a.itemId, itemB: b.itemId } });
      if (sc.status !== 200) throw fail('swap/check', sc);
      record.swap.tried.push({ a: `${a.subjectCode} ${a.classType} (${a.sectionLabel}) ${a.day} ${timeWords(a.startTime, a.endTime)}`, b: `${b.subjectCode} ${b.classType} (${b.sectionLabel}) ${b.day} ${timeWords(b.startTime, b.endTime)}`, ok: sc.data.ok, plan: sc.data.plan, text: sc.data.text });
      if (!sc.data.ok) {
        if (record.swap.tried.length <= 2) log(`swap refused: ${a.subjectCode} ${a.classType} (${a.sectionLabel}) ↔ ${b.subjectCode} ${b.classType} (${b.sectionLabel}): ${sc.data.text}`);
        continue;
      }
      log(`swap check OK (${sc.data.plan}): ${sc.data.text}`);
      const save = await call('POST', '/schedule/swap', { token: dean, body: { scheduleId, itemA: a.itemId, itemB: b.itemId } });
      if (save.status !== 200) throw fail('swap', save);
      log(`saved: ${save.data.message}`);
      swapped = { a: record.swap.tried[record.swap.tried.length - 1].a, b: record.swap.tried[record.swap.tried.length - 1].b, plan: save.data.plan, message: save.data.message, lastCheck: save.data.lastCheck };
      break outer;
    }
    if (record.swap.tried.length > 300) break;
  }
  if (!swapped) throw new Error(`No swap the check allows was found among the first ${record.swap.tried.length} pairs tried.`);
  record.swap.saved = swapped;
  record.swap.triedCount = record.swap.tried.length;
  delete record.swap.tried;

  // 4. The Audit Trail's newest rows for the three edits.
  const audit = (await call('GET', '/audit/logs', { token: dean })).data;
  const rows = (audit?.logs || audit?.entries || audit?.data || []).slice(0, 6).map(r => `${r.action}: ${r.target || ''} — ${(r.detail || r.reason || '').slice(0, 160)}`);
  rows.forEach(r => log(`audit: ${r}`));
  record.auditTop = rows;

  record.endedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`record written to ${path.relative(REPO, OUT)}`);
})().catch((err) => {
  console.error(`[edits-run] ${err.message}`);
  process.exit(1);
});
