// The go-live kit's shared pieces (Phase 4 Part 4, Step 4). Every script here is for a person, on
// Windows PowerShell, against the live database; each one that writes says first exactly what it will
// do, asks the person to type YES, makes a backup first, and prints names and counts only: never a
// secret, a password or a rating. The scripts take their answers from `io` so the tests can drive them
// on temporary copies and `_test` databases; a person types them in the console.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');
const BACKEND_DIR = path.resolve(REPO_ROOT, '..', 'intellisched_backend');
// Every backup of the kit goes under here (git ignores it): backups/<name>-<date-time>/.
const BACKUPS_DIR = path.join(REPO_ROOT, 'backups');
const LIVE_DB_NAME = 'intellisched_db';

// "2026-10-02T20-15-30" (file-name safe, local time).
const stamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
};
const backupFolder = (name, date) => path.join(BACKUPS_DIR, `${name}-${stamp(date)}`);

// ---------------------------------------------------------------- the console
// io: { say(line), ask(question) -> Promise<string>, askHidden(question) -> Promise<string> }. The CLI's
// io reads the console (the hidden one shows nothing while typing); a test's io answers from a list.
const consoleIo = () => {
  const say = (line = '') => console.log(line);
  const ask = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(String(answer ?? '').trim()); });
  });
  const askHidden = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let hidden = false;
    rl._writeToOutput = (text) => { if (!hidden) rl.output.write(text); };
    rl.question(question, (answer) => { hidden = false; rl.output.write('\n'); rl.close(); resolve(String(answer ?? '')); });
    hidden = true;
  });
  return { say, ask, askHidden, interactive: Boolean(process.stdin.isTTY) };
};
// A test's io: answers in order; everything said is kept.
const scriptedIo = (answers = []) => {
  const queue = [...answers];
  const said = [];
  const next = (question) => {
    said.push(question);
    if (!queue.length) throw new Error(`No scripted answer for: ${question}`);
    return Promise.resolve(String(queue.shift()));
  };
  return { say: (line = '') => said.push(String(line)), ask: next, askHidden: next, said, interactive: true };
};

// The YES question every writing script asks. Anything but YES stops with "nothing was changed".
const confirmYes = async (io, what) => {
  const answer = await io.ask(`Type YES to ${what}, or anything else to stop: `);
  return answer === 'YES';
};

// ---------------------------------------------------------------- .env files
// Read as lines, so a rewrite keeps the order, the comments and the keys we do not touch. A value is
// everything after the first "=", quotes kept as they were; this kit writes values without quotes
// unless the old value had them.
const parseEnvLines = (text) => text.split(/\r?\n/).map((line) => {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!m || /^\s*#/.test(line)) return { raw: line };
  return { raw: line, key: m[1], value: m[2] };
});
const stripQuotes = (value) => {
  const v = String(value ?? '').trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
};
const readEnvFile = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const lines = parseEnvLines(text);
  const values = {};
  for (const line of lines) if (line.key && !(line.key in values)) values[line.key] = stripQuotes(line.value);
  return { file, text, lines, values, eol: text.includes('\r\n') ? '\r\n' : '\n' };
};
// The file with these keys set (a key not in the file is added at the end). Returns the new text.
const withEnvValues = (env, changes) => {
  const done = new Set();
  const lines = env.lines.map((line) => {
    if (!line.key || !(line.key in changes) || done.has(line.key)) return line.raw;
    done.add(line.key);
    const quoted = /^\s*(['"])/.test(line.value);
    const q = quoted ? line.value.trim()[0] : '';
    return `${line.key}=${q}${changes[line.key]}${q}`;
  });
  for (const [key, value] of Object.entries(changes)) if (!done.has(key)) lines.push(`${key}=${value}`);
  const text = lines.join(env.eol);
  return env.text.endsWith(env.eol) && !text.endsWith(env.eol) ? text + env.eol : text;
};

// ---------------------------------------------------------------- MongoDB addresses
// The password part of a MongoDB URI must be percent-encoded (RFC 3986): "p@ss:w/rd" -> "p%40ss%3Aw%2Frd".
const encodePassword = (password) => encodeURIComponent(String(password)).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// Replaces the password in "mongodb[+srv]://user:password@host/..." (the user part is kept, encoded as it
// was). Returns null when the address has no "user:password@" part.
const withPassword = (uri, password) => {
  const m = /^(mongodb(?:\+srv)?:\/\/)([^:@/]+):([^@]*)@(.+)$/.exec(String(uri ?? '').trim());
  if (!m) return null;
  return `${m[1]}${m[2]}:${encodePassword(password)}@${m[4]}`;
};
const databaseNameOf = (uri) => {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(String(uri ?? '').trim());
  return m && m[1] ? decodeURIComponent(m[1]) : null;
};
// "cluster0.abcd.mongodb.net/intellisched_db" without the credentials, for messages.
const describeUri = (uri) => {
  const text = String(uri ?? '').trim();
  const m = /^mongodb(?:\+srv)?:\/\/(.*)$/.exec(text);
  if (!m) return '(no address)';
  // The credentials end at the LAST "@" (a host never holds one, a hand-written password may hold "/");
  // what follows is the host list and the database, without the query.
  const rest = m[1].split('?')[0];
  const at = rest.lastIndexOf('@');
  return at >= 0 ? rest.slice(at + 1) : rest;
};
// Any MongoDB address with credentials inside a text (a driver's parse error, a thrown message) loses them.
const redact = (text) => String(text ?? '').replace(/mongodb(\+srv)?:\/\/[^\s"']*@[^\s"']*/g, (uri) => `mongodb://…@${describeUri(uri)}`);

// ---------------------------------------------------------------- secrets
const randomSecret = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------- running a script as a child
// Runs `node <script> <args>` from `cwd` with `extraEnv` on top of the shell's environment (so
// ALLOW_LIVE_DB=1 lives in that one process and in no file). stdin is handed over so the child's own
// questions reach the person. Resolves with the exit code.
const runNode = ({ script, args = [], cwd, extraEnv = {}, stdio = 'inherit' }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...extraEnv }, stdio, windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code === null ? 1 : code, signal));
});

// Which variables the two .env files hold for the kit (found in the code, never from the real values):
//   server/.env                  MONGODB_URI (the live database), JWT_SECRET (the gateway's sessions), and
//                                the key the gateway sends to the Python service: PYTHON_ML_API_KEY, or
//                                ML_SERVICE_API_KEY, or FASTAPI_API_KEY (config/mlClient.js reads them in
//                                that order; every one present is kept equal)
//   ../intellisched_backend/.env MONGO_URI (the same database), ADMIN_API_KEY (what the gateway's key
//                                must equal)
const ENV_FILES = {
  server: path.join(SERVER_DIR, '.env'),
  python: path.join(BACKEND_DIR, '.env')
};
const GATEWAY_KEY_NAMES = ['PYTHON_ML_API_KEY', 'ML_SERVICE_API_KEY', 'FASTAPI_API_KEY'];

// A value is written where a name appears in the output only through these helpers: the kit prints
// names and counts, never a value.
const nameList = (names) => names.map(n => `  - ${n}`).join('\n');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

module.exports = {
  REPO_ROOT, SERVER_DIR, CLIENT_DIR, BACKEND_DIR, BACKUPS_DIR, LIVE_DB_NAME, ENV_FILES, GATEWAY_KEY_NAMES,
  stamp, backupFolder, consoleIo, scriptedIo, confirmYes,
  parseEnvLines, stripQuotes, readEnvFile, withEnvValues,
  encodePassword, withPassword, databaseNameOf, describeUri, redact, randomSecret, runNode, nameList, ensureDir, isInside,
  tmpDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'intellisched-live-'))
};
