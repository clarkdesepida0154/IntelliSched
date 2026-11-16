// Phase 4 Part 1, Step 1 evidence: the Dean's path with Fill TBA rooms on the full-college demo, through
// the gateway (the same routes the pages call). Readiness Check -> generate with the seed (as the TEST
// Dean since Phase 8 Part 8; the next seed when a run ends with conflicts) -> add the borrowed lecture room "TEST
// Borrowed LEC" (free Monday-Friday 08:00-12:00, the Rooms page's free times) -> Fill TBA rooms: preview
// with every CCS room and the borrowed room ticked (the panel's default), then save as a new Draft (as the
// TEST Dean). Prints the numbers and writes a JSON record. Test data only: the demo's own _test database
// (it adds one room and saves two Drafts there).
//
// Usage (repo root): start a fresh demo with `npm run demo:full:reset`, then in a second terminal
//   node scripts/demo/fill-tba-rooms-run.js [--seed N] [--out <file.json>]
// It reads the demo's ports from .demo-data/run.json and the TEST logins from .demo-data/demo-secrets.json.
// The default output is .demo-data/fill-tba-rooms-run.json (gitignored with the rest of .demo-data).
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const seedWanted = Number(argOf('--seed', 1));
const OUT = path.resolve(REPO, argOf('--out', path.join('.demo-data', 'fill-tba-rooms-run.json')));
const secrets = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'demo-secrets.json'), 'utf8'));
const run = JSON.parse(fs.readFileSync(path.join(REPO, '.demo-data', 'run.json'), 'utf8'));
const API = `http://localhost:${run.ports.gateway}/api`;
const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const log = (m) => console.log(`[fill-run ${new Date().toISOString().slice(11, 19)}] ${m}`);

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

(async () => {
  if (!Number.isInteger(seedWanted) || seedWanted < 0) throw new Error('--seed needs a whole number, e.g. --seed 1.');
  if (run.state !== 'ready' || run.mode !== 'full') throw new Error(`The demo is not a ready full-college demo (mode ${run.mode}, state ${run.state}). Start npm run demo:full:reset first.`);
  const term = { academicYear: '2025-2026', semester: 1 };
  const record = { startedAt: new Date().toISOString(), term, seed: null };
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  const secretary = dean; // Phase 8 Part 8: one account — the TEST Dean starts the runs with a seed too
  log('signed in as the TEST Dean');

  // 1. The Readiness Check (the Dean).
  const pre = await call('POST', '/schedule/preflight', { token: dean, body: term });
  if (pre.status !== 200) throw fail('preflight', pre);
  const readiness = pre.data.report.readiness;
  record.readiness = { verdict: readiness.verdict, lines: readiness.lines.map(l => `${l.status}: ${l.text}`), extraRooms: pre.data.report.extraRooms, tbaClassesEstimate: pre.data.report.numbers.tbaClassesEstimate };
  log(`Readiness: ${readiness.verdict}; rooms line: ${readiness.lines.find(l => l.id === 'rooms')?.text}`);
  if (readiness.verdict !== 'ready') throw new Error('The term is not ready to generate; see the Readiness Check.');

  // 2. Generate with the seed (the TEST Dean); the next seed when a run ends with conflicts.
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
    record.runs.push({ seed, status: runDoc.status, message: runDoc.message, runtimeMs, classesInTbaRooms: runDoc.classesInTbaRooms, tbaRoomsUsed: runDoc.tbaRoomsUsed, saturdayClasses: runDoc.saturdayClasses, version: runDoc.version });
    if (runDoc.status === 'done') { saved = runDoc; record.seed = seed; }
  }
  if (!saved) throw new Error('No run ended without conflicts (5 seeds tried).');

  // 3. The borrowed lecture room (the Dean, the Rooms page): free Monday-Friday 08:00-12:00.
  const existing = (await call('GET', '/facilities', { token: dean })).data;
  const rooms0 = Array.isArray(existing) ? existing : existing.facilities || existing.data || [];
  let borrowed = rooms0.find(r => r.roomName === 'TEST BORROWED LEC');
  if (!borrowed) {
    const made = await call('POST', '/facilities', { token: dean, body: { roomName: 'TEST Borrowed LEC', type: 'LEC', availability: WEEK.map(day => ({ day, start: '08:00', end: '12:00' })) } });
    if (![200, 201].includes(made.status)) throw fail('room', made);
    borrowed = made.data.facility || made.data.data || made.data;
    log(`borrowed room added: ${borrowed.roomName} (${borrowed._id})`);
  } else log(`borrowed room already there: ${borrowed.roomName}`);

  // 4. The Room Program's rooms and "TBA rooms to request" before.
  const outputsOf = async (scheduleId) => (await call('GET', `/schedule/outputs?academicYear=${term.academicYear}&semester=${term.semester}&scheduleId=${scheduleId}`, { token: dean })).data;
  const outputs = await outputsOf(saved.scheduleId);
  const realRooms = outputs.rooms.filter(r => r.kind !== 'TBA' && r.isActive);
  const free = (r) => Math.round((r.hoursAvailable - r.hoursUsed) * 100) / 100;
  record.before = { version: outputs.schedule.version, tbaRequest: outputs.tbaRequest, rooms: realRooms.map(r => ({ name: r.name, kind: r.kind, type: r.type, hoursUsed: r.hoursUsed, hoursAvailable: r.hoursAvailable, free: free(r) })) };
  log(`before: ${outputs.tbaRequest.classCount} classes in ${outputs.tbaRequest.labRooms} lab + ${outputs.tbaRequest.lecRooms} lecture TBA rooms; real rooms: ${realRooms.map(r => `${r.name} ${free(r)} h free`).join(', ')}`);

  // 5. Preview, every CCS room and the borrowed room ticked (the panel's default).
  const roomIds = realRooms.map(r => r.roomId);
  const preview = await call('POST', '/schedule/fill-tba-rooms/preview', { token: dean, body: { ...term, scheduleId: saved.scheduleId, roomIds } });
  if (preview.status !== 200) throw fail('preview', preview);
  const p = preview.data;
  record.preview = { message: p.message, classCount: p.classCount, hoursMoved: p.hoursMoved, tbaRequest: p.tbaRequest, emptiedTbaRooms: p.emptiedTbaRooms, byRoom: p.byRoom.map(r => ({ roomName: r.roomName, kind: r.kind, classCount: r.classCount, hours: r.hours })), moves: p.moves.map(m => `${m.subjectCode} ${m.classType} · ${m.section} · ${m.day} ${m.startTime}–${m.endTime} · ${m.facultyName} · ${m.fromName} → ${m.toRoomName}`) };
  log(`preview: ${p.message}`);
  for (const r of p.byRoom) log(`  ${r.roomName} (${r.kind}): ${r.classCount} classes, ${r.hours} h`);
  if (!p.classCount) {
    record.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
    log(`nothing to save; written ${path.relative(REPO, OUT)}`);
    return;
  }

  // 6. Save as a new Draft.
  const savedFill = await call('POST', '/schedule/fill-tba-rooms', { token: dean, body: { ...term, scheduleId: saved.scheduleId, roomIds, previewHash: p.previewHash } });
  if (savedFill.status !== 200) throw fail('save', savedFill);
  record.saved = { version: savedFill.data.version, sourceVersion: savedFill.data.sourceVersion, message: savedFill.data.message, lastCheck: savedFill.data.lastCheck, scheduleId: savedFill.data.scheduleId };
  log(`saved: ${savedFill.data.message} Whole-version check: ${savedFill.data.lastCheck.hardTotal} conflicts.`);
  const after = await outputsOf(savedFill.data.scheduleId);
  record.after = { version: after.schedule.version, filledFrom: after.schedule.filledFrom, tbaRequest: after.tbaRequest, rooms: after.rooms.filter(r => r.kind !== 'TBA').map(r => ({ name: r.name, kind: r.kind, hoursUsed: r.hoursUsed, hoursAvailable: r.hoursAvailable })) };
  log(`after: ${after.tbaRequest.classCount} classes in ${after.tbaRequest.labRooms} lab + ${after.tbaRequest.lecRooms} lecture TBA rooms (Draft ${after.schedule.version}, filled from ${after.schedule.filledFrom?.version})`);
  record.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  log(`written ${path.relative(REPO, OUT)}`);
})().catch((err) => {
  console.error(`[fill-run] Failed: ${err.message}`);
  process.exit(1);
});
