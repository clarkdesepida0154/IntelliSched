// IntelliSched deployment kit (decision 7, install step 11): the self-test of an installed copy.
//   node selftest.js --root <install folder> [--no-backup]
// Every line is PASS or FAIL; logs\selftest.json keeps the result (no secret, no rating, no document).
// The services must be running (start.ps1). Exit code 0 only when every line passes.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { P, argValue, hasFlag, loadServerEnv, backendEnv, readManifest, fromServer, connect, writeFile } = require('./kit-lib');

const results = [];
const line = (ok, name, detail = '') => {
  results.push({ status: ok ? 'PASS' : 'FAIL', name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const check = async (name, fn) => {
  try {
    const out = await fn();
    line(true, name, out || '');
  } catch (err) {
    line(false, name, err.message);
  }
};
const getJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
  if (!res.ok) throw new Error(`${url.replace(/\?.*/, '')} answered ${res.status}`);
  return res.json();
};

// Whether something answers on host:port (a TCP connect within 2 s).
const answers = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(2000, () => done(false));
  s.on('connect', () => done(true));
  s.on('error', () => done(false));
});

const main = async () => {
  loadServerEnv();
  const manifest = readManifest() || {};
  const gwPort = Number(process.env.PORT);
  const pyEnv = backendEnv();
  const pyPort = Number(pyEnv.PORT);
  const gw = `http://127.0.0.1:${gwPort}`;
  const py = `http://127.0.0.1:${pyPort}`;

  // 1. Both health routes.
  await check('Gateway health route', async () => {
    const h = await getJson(`${gw}/api/health`);
    if (h.status !== 'Operational') throw new Error(`status ${h.status}`);
    return `${h.status}, database ${h.database}, port ${gwPort}`;
  });
  await check('Python service health route', async () => {
    const h = await getJson(`${py}/api/health`);
    if (h.status !== 'online' || h.engines?.gbdt_engine !== 'loaded') throw new Error(`status ${h.status}, model ${h.engines?.gbdt_engine}`);
    return `online, model loaded, port ${pyPort}`;
  });
  await check('The web page', async () => {
    const res = await fetch(`${gw}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (!res.ok || !/<div id="root">/.test(text)) throw new Error(`answered ${res.status} without the app`);
    return `http://localhost:${gwPort}/`;
  });

  const mongoose = await connect();
  const db = mongoose.connection.db;

  // 2. The database counts against the restored backup's manifest (audit_events only grows).
  await check('Database counts equal the backup', async () => {
    // After an update: the counts taken just before it (update.ps1); else the restored backup's manifest.
    const asked = argValue('--counts');
    const countsFile = asked && fs.existsSync(asked) ? asked : path.join(P.data, 'restored-manifest.json');
    const restored = JSON.parse(fs.readFileSync(countsFile, 'utf8'));
    const wrong = [];
    let total = 0;
    for (const [name, want] of Object.entries(restored.counts)) {
      const n = await db.collection(name).countDocuments({});
      total += n;
      if (name === 'audit_events' ? n < want : n !== want) wrong.push(`${name} ${n} of ${want}`);
    }
    if (wrong.length) throw new Error(wrong.join(', '));
    return `${Object.keys(restored.counts).length} collections, ${total} records`;
  });

  // 3. The Python service ranks one subject with the model.
  await check('Python service ranks with the model', async () => {
    const subject = await db.collection('subject_catalog').findOne({}, { projection: { subjectCode: 1, descriptiveTitle: 1 } });
    if (!subject) throw new Error('no subject in the catalog');
    const latest = await db.collection('mother_schedules').find({}, { projection: { academicYear: 1, semester: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
    const body = {
      subjects: [{ subjectCode: subject.subjectCode, subjectTitle: subject.descriptiveTitle || subject.subjectCode, subjectDescription: '', subjectId: String(subject._id), programs: [] }],
      ...(latest[0] ? { academicYear: latest[0].academicYear, semester: latest[0].semester } : {}),
    };
    const out = await getJson(`${py}/api/get_recommendations`, { method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'x-api-key': pyEnv.ADMIN_API_KEY }, body: JSON.stringify(body) });
    const n = out.predictions?.[0]?.candidates?.length || 0;
    if (out.status !== 'success' || !n) throw new Error('no ranking came back');
    return `${subject.subjectCode}: ${n} professors ranked`;
  });

  // Phase 12.2 (decision 3): the checks whose result depends on who runs them ask the RUNNING gateway
  // (the daily user's process), never this one (an installer or updater runs elevated).
  const kitToken = require('crypto').createHmac('sha256', String(process.env.JWT_SECRET)).update('intellisched-kit-selftest').digest('hex');
  const kitHeaders = { 'x-intellisched-selftest': kitToken, 'x-intellisched-not-user': '1', 'content-type': 'application/json' };
  const askGateway = async (route, method, timeout) => {
    const res = await fetch(`${gw}/api/kit/selftest/${route}`, { method, headers: kitHeaders, signal: AbortSignal.timeout(timeout) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('the running gateway is older than this self-test (no self-test route)');
    if (!res.ok) throw new Error(body.message || `the gateway answered ${res.status}`);
    return body;
  };

  // 3b. Who runs it: the daily user, not elevated (the gateway's process and its health route).
  await check('Runs as the daily user, not as administrator', async () => {
    const h = await getJson(`${gw}/api/health`);
    const id = await askGateway('identity', 'GET', 15000);
    const account = id.domain ? `${id.domain}\\${id.user}` : id.user;
    const daily = String(manifest.dailyUser || '');
    const sameUser = daily && (daily.toLowerCase() === String(account).toLowerCase() || daily.toLowerCase().split('\\').pop() === String(id.user).toLowerCase());
    if (h.elevated !== false || id.elevated !== false) throw new Error(`the gateway (pid ${id.pid}) runs as administrator (${id.integrity || 'elevated'}); start IntelliSched from the desktop icon`);
    if (!sameUser) throw new Error(`the gateway runs as ${account}, not as the daily user ${daily}`);
    return `${account}, not elevated (gateway pid ${id.pid})`;
  });

  // 4. The PDF browser, in the gateway, after its warm-up.
  await check('PDF export (Edge or Chrome)', async () => {
    const out = await askGateway('pdf', 'POST', 300000);
    const warm = out.warmUp?.state === 'ok' ? `, warm-up ${Math.round(out.warmUp.ms / 100) / 10} s` : out.warmUp?.state ? `, warm-up ${out.warmUp.state}` : '';
    return `${out.browser || 'browser'}, ${Math.round(out.bytes / 1024)} KB in ${Math.round(out.ms / 100) / 10} s${warm}`;
  });

  // 5. A Word export of one Teachers' Program from the newest approved (else newest) version.
  await check("Word export of a Teachers' Program", async () => {
    const versions = await db.collection('mother_schedules').find({ schemaVersion: 2 }, { projection: { academicYear: 1, semester: 1, status: 1 } }).sort({ createdAt: -1 }).toArray();
    const v = versions.find(x => ['Approved', 'Published'].includes(x.status)) || versions[0];
    if (!v) throw new Error('no schedule version in the database');
    const { loadScheduleOutputs } = fromServer('src/controllers/outputsController.js');
    const { outputs, error } = await loadScheduleOutputs({ academicYear: v.academicYear, semester: v.semester, scheduleId: String(v._id), prefer: 'official' });
    if (error) throw new Error(error.payload?.message || 'the outputs could not be read');
    const { buildExport } = fromServer('src/exports/index.js');
    const file = await buildExport({ outputs, view: 'teachers-program', format: 'docx' });
    if (file.buffer.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('not a Word file');
    return `${file.pages} pages, ${Math.round(file.buffer.length / 1024)} KB (${v.status} version of ${v.academicYear} semester ${v.semester})`;
  });

  // Phase 12.1 (decision 3): the Office install's Retrain data (handover-training.enc, opened into private\).
  if (manifest.mode === 'office') {
    await check('Retrain data present', async () => {
      const f = pyEnv.ML_DATASET;
      if (!f || !fs.existsSync(f)) throw new Error('the Retrain data is not on this computer (Retrain will say so; the ranking works)');
      return `private\\${path.basename(f)},${Math.round(fs.statSync(f).size / 1024)} KB`;
    });
  }

  // 6. Back up now: an .isbak and a readable .zip in the backup folder, both readable.
  if (!hasFlag('--no-backup')) {
    // Phase 12.2: made by the gateway (its readable copy holds PDFs), then opened here.
    await check('Back up now', async () => {
      const S = fromServer('src/backup/settings.js');
      const svc = fromServer('src/backup/service.js');
      const { unzipSync } = fromServer('src/exports/zip.js');
      const made = await askGateway('backup', 'POST', 1200000);
      const settings = await S.getSettings();
      const full = path.join(made.folder || settings.folder, made.full.name);
      const readable = path.join(made.folder || settings.folder, made.readable.name);
      const pw = await S.currentPassword(settings);
      const opened = svc.openFullBackup(fs.readFileSync(full), pw.password);
      const files = unzipSync(fs.readFileSync(readable));
      if (!files.size) throw new Error('the readable copy is empty');
      // Every form the readable copy should hold was made (its README names any that could not be).
      const readme = files.get('README.txt') ? files.get('README.txt').toString('utf8') : '';
      const missing = readme.split(/\r?\n/).filter(l => /could not be made/.test(l));
      if (missing.length) throw new Error(`the readable copy ${made.readable.name} lacks forms: ${missing.join(' ')}`);
      const pdfs = [...files.keys()].filter(n => n.toLowerCase().endsWith('.pdf')).length;
      return `${made.full.name} (${Object.keys(opened.manifest.counts).length} collections) and ${made.readable.name} (${files.size} files, ${pdfs} PDFs) in the backup folder`;
    });
  }

  // 7. Only this computer can reach it.
  await check('Reachable on 127.0.0.1 only', async () => {
    if (!(await answers('127.0.0.1', gwPort))) throw new Error('the gateway does not answer on 127.0.0.1');
    const lan = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
    const open = [];
    for (const addr of lan) {
      for (const port of [gwPort, pyPort, Number(new URL(process.env.MONGODB_URI).port)]) {
        if (await answers(addr, port)) open.push(`${addr}:${port}`);
      }
    }
    if (open.length) throw new Error(`reachable from the network at ${open.join(', ')}`);
    return lan.length ? `not on the LAN address(es) ${lan.join(', ')}` : 'no LAN address on this PC';
  });

  await mongoose.disconnect();
  const ok = results.every(r => r.status === 'PASS');
  writeFile(path.join(P.logs, 'selftest.json'), `${JSON.stringify({ at: new Date().toISOString(), version: manifest.version || null, ok, results }, null, 2)}\n`);
  console.log(ok ? 'SELF-TEST: PASS' : 'SELF-TEST: FAIL');
  return ok ? 0 : 1;
};

main().then(code => process.exit(code)).catch((err) => { console.error(`FAIL self-test: ${err.message}`); process.exit(1); });
