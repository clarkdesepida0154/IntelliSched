// IntelliSched deployment kit (decision 6): keeps the Python service and the gateway running.
//   runtime\node\node.exe scripts\supervisor.js --root <install folder>
// - starts the Python service, then the gateway, each with its config\*.env settings;
// - their output goes to logs\backend.log and logs\server.log (rotated at 5 MB, 3 kept);
// - a child that exits is started again after 2 s, 4 s, 8 s ... up to 60 s; after 5 failures within
//   10 minutes it stops trying and writes the reason to logs\supervisor.log;
// - run\supervisor.pid holds its process id; stop.ps1 asks it to stop by writing run\stop.request,
//   and it stops both children before it exits (also on Ctrl+C).
// Phase 12.1 (decision 4): IntelliSched runs only while someone uses it.
// - one instance only: run\supervisor.pid is created exclusively (a lock with the PID); a file whose
//   process is gone is stale and is replaced;
// - every minute it reads the gateway's last real user request (the health route); after the System
//   setting's minutes without use (default 60, or never) it closes IntelliSched: the gateway and the
//   Python service stop, the closing backup runs (only when data changed since the last backup), then
//   the database stops;
// - "Stop IntelliSched" (stop.request) does the same at once; stop.request may say "nobackup" and
//   "keepdb" (the updater makes its own backup and needs the database);
// - run\session.json marks a running session; found at the next start it means the last session ended
//   uncleanly (a power cut), and the gateway then backs up in the background if data changed.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { P, serverEnv, backendEnv, readManifest } = require('./kit-lib');

const MAX_LOG = 5 * 1024 * 1024;
const KEEP_LOGS = 3;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const STOP_FILE = path.join(P.run, 'stop.request');
const PID_FILE = path.join(P.run, 'supervisor.pid');
const SESSION_FILE = path.join(P.run, 'session.json');
const CLOSING_FILE = path.join(P.run, 'closing');
const IDLE_CHECK_MS = Number(process.env.INTELLISCHED_IDLE_CHECK_MS) || 60 * 1000;
const NOT_USER = { 'X-IntelliSched-Not-User': 'supervisor' };

fs.mkdirSync(P.logs, { recursive: true });
fs.mkdirSync(P.run, { recursive: true });

// A log file that rotates at 5 MB: x.log -> x.log.1 -> x.log.2 -> x.log.3.
const rotatingLog = (name) => {
  const file = path.join(P.logs, name);
  return (text) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG) {
        for (let i = KEEP_LOGS; i >= 1; i -= 1) {
          const from = i === 1 ? file : `${file}.${i - 1}`;
          if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
        }
      }
      fs.appendFileSync(file, text);
    } catch { /* a log write never stops the system */ }
  };
};
const supLog = rotatingLog('supervisor.log');
const note = (line) => supLog(`${new Date().toISOString()} ${line}\r\n`);

// The child's environment: this computer's plain environment without anything that could make the
// private runtimes load another installation's modules, plus the settings file.
const childEnv = (extra) => {
  const env = { ...process.env };
  for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX']) delete env[k];
  return { ...env, ...extra };
};

const children = {
  backend: {
    name: 'backend',
    log: rotatingLog('backend.log'),
    command: P.python,
    args: ['-s', '-u', path.join(P.backend, 'main.py')],
    cwd: P.backend,
    env: () => childEnv({ ...backendEnv(), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
  },
  server: {
    name: 'server',
    log: rotatingLog('server.log'),
    command: P.node,
    args: [path.join(P.server, 'src', 'app.js')],
    cwd: P.server,
    // The first start after an unclean end tells the gateway to back up (in the background) if data
    // changed since the last backup.
    // Phase 12.2 (decision 2): the PDF browser's profile lives in the install (run\browser-profile),
    // written by the daily user, never in the temp folder of whoever started IntelliSched.
    env: () => childEnv({ ...serverEnv(), PDF_PROFILE_DIR: path.join(P.run, 'browser-profile'), ...(uncleanEnd ? { INTELLISCHED_UNCLEAN_END: '1' } : {}) }),
  },
};
for (const c of Object.values(children)) Object.assign(c, { proc: null, failures: [], gaveUp: false, timer: null });

let stopping = false;
let uncleanEnd = false;

const start = (c) => {
  if (stopping || c.gaveUp) return;
  c.log(`\r\n===== ${new Date().toISOString()} starting ${c.name} =====\r\n`);
  let proc;
  try {
    proc = spawn(c.command, c.args, { cwd: c.cwd, env: c.env(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    note(`${c.name} could not start: ${err.message}`);
    return onExit(c, -1);
  }
  c.proc = proc;
  c.startedAt = Date.now();
  proc.stdout.on('data', d => c.log(d.toString()));
  proc.stderr.on('data', d => c.log(d.toString()));
  proc.on('error', (err) => { note(`${c.name} error: ${err.message}`); });
  proc.on('exit', (code) => onExit(c, code));
  note(`${c.name} started (pid ${proc.pid})`);
};

const onExit = (c, code) => {
  c.proc = null;
  if (stopping) return;
  const now = Date.now();
  c.failures = c.failures.filter(t => now - t < FAILURE_WINDOW_MS);
  c.failures.push(now);
  if (c.failures.length >= MAX_FAILURES) {
    c.gaveUp = true;
    note(`${c.name} stopped ${c.failures.length} times within 10 minutes (last exit code ${code}); not starting it again. See logs\\${c.name}.log. Restart IntelliSched after fixing the cause.`);
    return;
  }
  const delay = Math.min(60, 2 ** c.failures.length) * 1000;
  note(`${c.name} exited with code ${code}; starting it again in ${delay / 1000} s`);
  c.timer = setTimeout(() => start(c), delay);
};

// Stops a child and every process it started.
const kill = (c) => {
  if (c.timer) clearTimeout(c.timer);
  if (!c.proc) return;
  try { execFileSync('taskkill.exe', ['/PID', String(c.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
};

// The kit's own Node and PowerShell steps, waited for, with their output in supervisor.log.
const runStep = (command, args, timeoutMs) => {
  const r = spawnSync(command, args, { cwd: P.root, env: childEnv({}), windowsHide: true, encoding: 'utf8', timeout: timeoutMs });
  for (const line of `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter(Boolean)) note(`  ${line}`);
  return r.status;
};
const closingBackup = () => runStep(P.node, [path.join(P.root, 'scripts', 'closing-backup.js'), '--root', P.root], 20 * 60 * 1000);
const stopDatabase = () => runStep(
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(P.root, 'scripts', 'stop.ps1'), '-Root', P.root, '-DatabaseOnly', '-Quiet'],
  2 * 60 * 1000
);

const removeRunFiles = () => {
  for (const f of [SESSION_FILE, STOP_FILE, CLOSING_FILE, PID_FILE]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
};

// Closes IntelliSched: the two services, then (unless told otherwise) the closing backup and the
// database. `fast` (Ctrl+C, a signal) only stops the services.
const shutdown = (why, { backup = true, database = true, fast = false } = {}) => {
  if (stopping) return;
  stopping = true;
  note(`stopping (${why})`);
  // start.ps1 waits while this file is there (an icon click during the closing backup).
  try { fs.writeFileSync(CLOSING_FILE, why); } catch { /* ignore */ }
  kill(children.server);
  kill(children.backend);
  if (!fast) {
    if (backup) {
      note('the closing backup (only when data changed since the last backup)');
      const code = closingBackup();
      if (code !== 0) note(`the closing backup did not finish (exit code ${code}); see the lines above`);
    }
    if (database) {
      note('stopping the database');
      stopDatabase();
    }
  }
  removeRunFiles();
  note('stopped');
  setTimeout(() => process.exit(0), 300);
};

process.on('SIGINT', () => shutdown('Ctrl+C', { fast: true }));
process.on('SIGTERM', () => shutdown('SIGTERM', { fast: true }));
process.on('SIGBREAK', () => shutdown('SIGBREAK', { fast: true }));

// One supervisor at a time: the PID file is created exclusively. A file whose process is gone (a power
// cut, a killed supervisor) is stale: it is replaced once.
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
const takeLock = () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(PID_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let other = 0;
      try { other = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { /* being written */ }
      if (other && other !== process.pid && alive(other)) return false;
      if (!other) {
        // Another supervisor is writing it this very moment: let it win.
        try { if (Date.now() - fs.statSync(PID_FILE).mtimeMs < 5000) return false; } catch { /* gone */ }
      }
      try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
    }
  }
  return false;
};
if (!takeLock()) {
  let other = '?';
  try { other = fs.readFileSync(PID_FILE, 'utf8').trim(); } catch { /* ignore */ }
  note(`another supervisor runs (pid ${other}); exiting`);
  process.exit(0);
}
try { fs.rmSync(STOP_FILE, { force: true }); } catch { /* ignore */ }

// The last session's marker: still there means it did not end cleanly.
if (fs.existsSync(SESSION_FILE)) {
  uncleanEnd = true;
  note('the last session did not end cleanly (a power cut, or Windows shut down while it ran); the gateway backs up if data changed');
}
fs.writeFileSync(SESSION_FILE, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }));
note(`supervisor started (pid ${process.pid}) in ${P.root}`);
// Phase 12.2: normal priority for the supervisor and the services it starts (they inherit it), even
// when something started it below normal (a scheduled task's default).
try {
  const os = require('os');
  if (os.getPriority() !== os.constants.priority.PRIORITY_NORMAL) {
    os.setPriority(os.constants.priority.PRIORITY_NORMAL);
    note('priority set to normal');
  }
} catch (err) { note(`priority not changed: ${err.message}`); }
const manifest = readManifest();
if (manifest) note(`install: ${manifest.portable ? 'portable test install' : 'office install'}, version ${manifest.version}`);

// The Python service first, the gateway a moment later (it asks the service on its health route).
start(children.backend);
setTimeout(() => start(children.server), 3000);

setInterval(() => {
  if (stopping || !fs.existsSync(STOP_FILE)) return;
  let words = '';
  try { words = fs.readFileSync(STOP_FILE, 'utf8'); } catch { /* ignore */ }
  shutdown('Stop IntelliSched', { backup: !/nobackup/.test(words), database: !/keepdb/.test(words) });
}, 1000);

// The idle check: the gateway's last real user request against the System setting.
const port = Number(serverEnv().PORT) || 0;
const health = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: NOT_USER, timeout: 10000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.on('error', () => resolve(null));
});
setInterval(async () => {
  if (stopping || !port) return;
  const h = await health();
  const a = h?.activity;
  if (!a || a.idleMinutes === 'never' || !Number(a.idleMinutes)) return;
  const quietMs = Date.now() - new Date(a.lastUserRequestAt).getTime();
  if (quietMs >= Number(a.idleMinutes) * 60 * 1000) {
    shutdown(`no use for ${Math.round(quietMs / 60000)} minutes (the setting: ${a.idleMinutes})`);
  }
}, IDLE_CHECK_MS);
