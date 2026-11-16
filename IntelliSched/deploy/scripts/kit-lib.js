// IntelliSched deployment kit: what the kit's Node scripts share (run by the private Node in
// runtime\node). Every script takes --root <install folder>; the settings come from config\*.env,
// which only these scripts and the two services read. Nothing here prints a secret.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const argv = process.argv.slice(2);
const argValue = (flag, fallback = null) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const hasFlag = (flag) => argv.includes(flag);

const ROOT = path.resolve(argValue('--root') || path.join(__dirname, '..'));
const P = {
  root: ROOT,
  app: path.join(ROOT, 'app'),
  server: path.join(ROOT, 'app', 'server'),
  backend: path.join(ROOT, 'app', 'backend'),
  config: path.join(ROOT, 'config'),
  logs: path.join(ROOT, 'logs'),
  data: path.join(ROOT, 'data'),
  run: path.join(ROOT, 'run'),
  node: path.join(ROOT, 'runtime', 'node', 'node.exe'),
  python: path.join(ROOT, 'runtime', 'python', 'python.exe'),
  manifest: path.join(ROOT, 'install-manifest.json'),
};

const readEnvFile = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
};
const serverEnv = () => readEnvFile(path.join(P.config, 'server.env'));
const backendEnv = () => readEnvFile(path.join(P.config, 'backend.env'));

// The gateway's own settings into this process (so its modules behave exactly as in the gateway).
const loadServerEnv = () => {
  for (const [k, v] of Object.entries(serverEnv())) process.env[k] = v;
  // The installed copy never runs its daily timer from a helper script.
  process.env.BACKUP_TIMER = 'off';
};

const readManifest = () => {
  try { return JSON.parse(fs.readFileSync(P.manifest, 'utf8')); } catch { return null; }
};

// The gateway's modules (mongoose, the backup service, the exports) from app\server.
const serverRequire = createRequire(path.join(P.server, 'package.json'));
const fromServer = (rel) => serverRequire(path.join(P.server, rel));

// A secret on standard input: one line, base64 of its UTF-8 bytes (install.ps1 writes it so).
const readSecret = () => new Promise((resolve) => {
  let data = '';
  if (process.stdin.isTTY) return resolve('');
  process.stdin.setEncoding('latin1');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    // Only base64 characters count: .NET may write a byte-order mark before the line.
    const line = (data.split(/\r?\n/)[0] || '').replace(/[^A-Za-z0-9+/=]/g, '');
    resolve(line ? Buffer.from(line, 'base64').toString('utf8') : '');
  });
});

// The gateway's database connection (same options as the gateway: autoIndex and autoCreate off).
const connect = async () => {
  const mongoose = serverRequire('mongoose');
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, autoIndex: false, autoCreate: false });
  return mongoose;
};

// Every model file of the gateway, so its indexes can be built on a fresh database.
const loadModels = () => {
  const dir = path.join(P.server, 'src', 'models');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) fromServer(path.join('src', 'models', f));
  return serverRequire('mongoose');
};

const say = (line) => console.log(line);
const fail = (message, code = 1) => { console.error(`FAIL: ${message}`); process.exit(code); };

// Writes a JSON or text file as UTF-8 without a BOM.
const writeFile = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { encoding: 'utf8' }); };

module.exports = { argv, argValue, hasFlag, P, readEnvFile, serverEnv, backendEnv, loadServerEnv, readManifest, serverRequire, fromServer, readSecret, connect, loadModels, say, fail, writeFile };
