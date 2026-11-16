// npm run live:start (Phase 4 Part 4, Step 4): starts the Python service, the gateway and the web client
// against the live database, for a person, and stops them all on Ctrl+C.
//   - each service runs from its own folder and reads its own .env there (../intellisched_backend/.env,
//     server/.env, client/.env), as it does when started by hand; this launcher reads from those files
//     only the addresses it needs to wait for them (ports, URLs) and prints no secret;
//   - ALLOW_LIVE_DB=1 is given to the Python service and the gateway processes only (never written to a
//     file), so they accept intellisched_db;
//   - it waits until each answers (the Python service's and the gateway's /api/health, the client's page),
//     checks the gateway reports the live database, prints the address, and on Ctrl+C stops every process
//     it started (the whole process tree, as the demo does).
// Usage: npm run live:start    (the client on client/.env's port, 5173 by default)
//        npm run live:start -- --client-port 5173 --no-client   (the gateway and the Python service only)
const fs = require('fs');
const path = require('path');
const kit = require('./kit');
const procs = require(path.join(kit.REPO_ROOT, 'scripts', 'demo', 'processes.js'));

const LOG_DIR = path.join(kit.REPO_ROOT, '.demo-data', 'logs');
const PYTHON_EXE = process.platform === 'win32' ? path.join(kit.BACKEND_DIR, '.venv', 'Scripts', 'python.exe') : path.join(kit.BACKEND_DIR, '.venv', 'bin', 'python');
const VITE_BIN = path.join(kit.CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

const argOf = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const values = (file) => (fs.existsSync(file) ? kit.readEnvFile(file).values : {});
const portOf = (url, fallback) => { try { return Number(new URL(url).port) || fallback; } catch { return fallback; } };

// What the launcher will do, from the three .env files (addresses only, never a secret).
const plan = ({ args = [], serverEnv = kit.ENV_FILES.server, pythonEnv = kit.ENV_FILES.python, clientEnv = path.join(kit.CLIENT_DIR, '.env') } = {}) => {
  const s = values(serverEnv);
  const p = values(pythonEnv);
  const c = values(clientEnv);
  const gatewayPort = Number(s.PORT) || 5000;
  const pythonUrl = s.PYTHON_ML_SERVICE_URL || s.FASTAPI_URL || 'http://127.0.0.1:8001';
  const pythonPort = Number(p.PORT) || portOf(pythonUrl, 8001);
  const clientPort = Number(argOf(args, '--client-port', null)) || portOf(s.CLIENT_URL, 5173);
  const withClient = !args.includes('--no-client');
  const dbName = kit.databaseNameOf(s.MONGODB_URI) || '(not set in server/.env)';
  const pythonDb = kit.databaseNameOf(p.MONGO_URI) || '(not set in ../intellisched_backend/.env)';
  const missing = [];
  if (!s.MONGODB_URI) missing.push('server/.env MONGODB_URI');
  if (!s.JWT_SECRET) missing.push('server/.env JWT_SECRET');
  if (!kit.GATEWAY_KEY_NAMES.some(k => s[k])) missing.push(`server/.env ${kit.GATEWAY_KEY_NAMES.join(' or ')}`);
  if (!p.MONGO_URI) missing.push('../intellisched_backend/.env MONGO_URI');
  if (!p.ADMIN_API_KEY) missing.push('../intellisched_backend/.env ADMIN_API_KEY');
  const keysMatch = kit.GATEWAY_KEY_NAMES.some(k => s[k] && s[k] === p.ADMIN_API_KEY);
  return {
    gatewayPort, pythonPort, pythonUrl, clientPort, withClient, dbName, pythonDb, missing, keysMatch,
    clientUrl: withClient ? `http://localhost:${clientPort}` : null,
    gatewayHealth: `http://127.0.0.1:${gatewayPort}/api/health`,
    pythonHealth: `http://127.0.0.1:${pythonPort}/api/health`,
    viteApi: c.VITE_API_BASE_URL || `http://localhost:${gatewayPort}/api`,
    sameDb: dbName === pythonDb
  };
};

const run = async ({ args = process.argv.slice(2), io = kit.consoleIo() } = {}) => {
  const say = io.say;
  const p = plan({ args });
  say('live:start will start, against the live database:');
  say(`  the Python service on port ${p.pythonPort} (database ${p.pythonDb}), the gateway on port ${p.gatewayPort} (database ${p.dbName})${p.withClient ? `, the web client on port ${p.clientPort}` : ''}.`);
  say('  Each reads its own .env; ALLOW_LIVE_DB=1 is given to the Python service and the gateway processes only.');
  if (p.missing.length) { say(`Cannot start: these are not set: ${p.missing.join('; ')}.`); return { ok: false, reason: 'missing', missing: p.missing }; }
  if (!p.sameDb) { say(`Cannot start: server/.env names the database ${p.dbName} but ../intellisched_backend/.env names ${p.pythonDb}. They must be the same.`); return { ok: false, reason: 'databases differ' }; }
  if (!p.keysMatch) { say('Cannot start: the key in server/.env (PYTHON_ML_API_KEY / ML_SERVICE_API_KEY / FASTAPI_API_KEY) does not equal ADMIN_API_KEY in ../intellisched_backend/.env. Run npm run rotate-secrets to set both.'); return { ok: false, reason: 'keys differ' }; }
  for (const [label, port] of [['Python service', p.pythonPort], ['gateway', p.gatewayPort], ...(p.withClient ? [['web client', p.clientPort]] : [])]) {
    if (!(await procs.isPortFree(port))) { say(`Cannot start: port ${port} (${label}) is in use. Stop what uses it, or change the port in that service's .env.`); return { ok: false, reason: 'port in use', port }; }
  }

  kit.ensureDir(LOG_DIR);
  const children = [];
  let stopping = false;
  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    say('Stopping everything live:start started ...');
    for (const child of children.reverse()) { try { procs.killTree(child.pid); } catch { /* already gone */ } }
  };
  process.on('SIGINT', () => { stopAll(); setTimeout(() => process.exit(0), 1500); });
  process.on('SIGTERM', () => { stopAll(); setTimeout(() => process.exit(0), 1500); });

  const start = async ({ name, label, command, cmdArgs, cwd, extraEnv, ready, timeoutMs }) => {
    say(`Starting the ${label} ...`);
    const logFile = path.join(LOG_DIR, `live-${name}.log`);
    const child = procs.startService({ name, command, args: cmdArgs, cwd, env: { ...process.env, ...extraEnv }, logFile });
    children.push(child);
    const result = await procs.waitUntil({ label, child, check: ready, timeoutMs, shouldStop: () => stopping });
    say(`  ${label}: ready (log: ${path.relative(kit.REPO_ROOT, logFile)}).`);
    return result;
  };
  try {
    const py = await start({
      name: 'python', label: 'Python service', command: PYTHON_EXE, cmdArgs: ['main.py'], cwd: kit.BACKEND_DIR,
      extraEnv: { ALLOW_LIVE_DB: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }, timeoutMs: 180000,
      ready: async () => { const r = await procs.httpGet(p.pythonHealth); return r.status === 200 && r.body?.status === 'online' ? r.body : null; }
    });
    if (py.database && py.database !== p.pythonDb) say(`  Note: the Python service reports the database "${py.database}".`);
    const gw = await start({
      name: 'gateway', label: 'gateway', command: process.execPath, cmdArgs: [path.join('src', 'app.js')], cwd: kit.SERVER_DIR,
      extraEnv: { ALLOW_LIVE_DB: '1' }, timeoutMs: 90000,
      ready: async () => { const r = await procs.httpGet(p.gatewayHealth, 5000); return r.status === 200 && r.body?.database ? r.body : null; }
    });
    say(`  The gateway reports the database "${gw.database}"${gw.services?.python?.database ? ` and the Python service on "${gw.services.python.database}"` : ''}.`);
    if (p.withClient) {
      await start({
        name: 'vite', label: 'web client', command: process.execPath, cmdArgs: [VITE_BIN, '--port', String(p.clientPort), '--strictPort'], cwd: kit.CLIENT_DIR,
        extraEnv: { NO_COLOR: '1' }, timeoutMs: 90000,
        ready: async () => { const r = await procs.httpGet(p.clientUrl); return r.status === 200 && r.contentType.includes('html'); }
      });
    }
    say('');
    say(`IntelliSched is running on the live database (${gw.database}).`);
    say(`  Open: ${p.withClient ? p.clientUrl : `${p.viteApi} (no web client started)`}`);
    say('  Press Ctrl+C to stop everything live:start started.');
    await new Promise(() => {}); // until Ctrl+C
    return { ok: true };
  } catch (err) {
    say(`live:start stopped: ${err.message}`);
    stopAll();
    return { ok: false, reason: err.message };
  }
};

if (require.main === module) {
  run().then((r) => { if (!r.ok) process.exit(1); }).catch((err) => { console.error(`live:start stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run, plan };
