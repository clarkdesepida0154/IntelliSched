// Ports, child processes and process trees for the demo (Windows first; the team runs Windows).
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Something answers on host:port.
const answers = (port, host) => new Promise((resolve) => {
  const socket = net.connect({ port, host });
  const done = (result) => { socket.destroy(); resolve(result); };
  socket.setTimeout(700, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

// host:port can be bound. A missing address family (no IPv6) does not count against the port.
const canBind = (port, host) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', err => resolve(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(err.code)));
  server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
});

// Free means nobody answers on 127.0.0.1 or ::1, and every local address can be bound.
const isPortFree = async (port) => {
  for (const host of ['127.0.0.1', '::1']) if (await answers(port, host)) return false;
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) if (!(await canBind(port, host))) return false;
  return true;
};

// The preferred port, or the next free one after it (saying which port was taken).
const pickPort = async (label, preferred, reserved = new Set()) => {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (!reserved.has(port) && await isPortFree(port)) {
      if (port !== preferred) console.log(`[demo] Port ${preferred} (${label}) is in use, so the ${label} uses port ${port}.`);
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`No free port for the ${label} between ${preferred} and ${preferred + 49}.`);
};

// Starts one service with its output appended to logFile. Returns the ChildProcess.
const startService = ({ name, command, args, cwd, env, logFile }) => {
  fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ${name} =====\n`);
  const fd = fs.openSync(logFile, 'a');
  try {
    return spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
  } finally {
    fs.closeSync(fd); // the child keeps its own handle
  }
};

const isRunning = (child) => Boolean(child) && child.exitCode === null && child.signalCode === null;

// The last lines of a log file (for error messages).
const tailLog = (file, lines = 25) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
};

// Polls check() until it returns a truthy value. Fails when the child exits, when shouldStop()
// says so, or after timeoutMs.
const waitUntil = async ({ label, child, check, timeoutMs, shouldStop = () => false }) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (shouldStop()) throw Object.assign(new Error('Stopped by the user.'), { stopRequested: true });
    if (child && !isRunning(child)) throw new Error(`The ${label} stopped while starting (exit code ${child.exitCode ?? child.signalCode}).`);
    const result = await check().catch(() => null);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`The ${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`);
    await sleep(500);
  }
};

// GET a URL; resolves to { status, body } (body parsed as JSON when it is JSON).
const httpGet = async (url, timeoutMs = 3000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, contentType: res.headers.get('content-type') || '' };
};

// Every process on the computer: [{ pid, ppid, name, created }]. created is the start time (Windows file
// time; null elsewhere): Windows keeps a dead parent's PID in ParentProcessId and reuses PIDs, so an
// older, unrelated process (e.g. a sync service started hours before) can name a demo process as its
// parent; treeOf follows a child only when it started after its parent (Phase 6).
const processTable = () => {
  if (IS_WINDOWS) {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }),$($_.Name)" }'],
    { encoding: 'utf8', windowsHide: true });
    return String(out.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, created, ...name] = line.split(',');
      return { pid: Number(pid), ppid: Number(ppid), name: name.join(','), created: Number(created) || null };
    });
  }
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return String(out.stdout || '').split('\n').filter(Boolean).map((line) => {
    const [pid, ppid, ...name] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), name: name.join(' '), created: null };
  });
};

// A process and everything below it: [{ pid, name }]. A "child" that started before its parent is not
// one (its parent PID is a stale one Windows reused), so it is left out.
const treeOf = (rootPid, table = processTable()) => {
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const row = table.find(p => p.pid === pid);
    if (row && !found.some(p => p.pid === pid)) found.push({ pid, name: row.name });
    table.filter(p => p.ppid === pid && p.pid !== pid && !(row?.created && p.created && p.created < row.created)).forEach(p => queue.push(p.pid));
  }
  return found;
};

// True when pid is running and (if a name is given) is still that program.
const isAlive = (pid, name) => {
  if (!pid) return false;
  if (IS_WINDOWS) {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const row = String(out.stdout || '').split(/\r?\n/).find(line => line.startsWith('"'));
    if (!row) return false;
    const [image, rowPid] = row.split('","').map(cell => cell.replace(/"/g, ''));
    return Number(rowPid) === Number(pid) && (!name || image.toLowerCase() === String(name).toLowerCase());
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Stops a process and its children at once (synchronous, so it also works in an 'exit' handler).
const killTree = (pid) => {
  if (!pid) return;
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
};

module.exports = { isPortFree, pickPort, startService, isRunning, tailLog, waitUntil, httpGet, processTable, treeOf, isAlive, killTree, sleep };
