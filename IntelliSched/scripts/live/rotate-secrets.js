// npm run rotate-secrets (Phase 4 Part 4, Step 4; Phase 6: the order on screen, the password test and the
// writes as the team decided them): new secrets in the two .env files, for a person. On screen, in order:
//   1. two lines on what it does;
//   2. the NEW Atlas password, typed hidden, twice;
//   3. the test: it connects with the new password and sends a ping (it reads and writes nothing). If
//      Atlas refuses the password it waits 30 seconds and tries once more, because a new password can
//      take a minute to reach the cluster. Then "The new password works.", or it stops with what to do
//      (Atlas refused it / this computer could not reach Atlas) and nothing is changed;
//   4. the names of what will change: server/.env MONGODB_URI, JWT_SECRET and the key names the gateway
//      sends to the Python service (PYTHON_ML_API_KEY / ML_SERVICE_API_KEY / FASTAPI_API_KEY, whichever
//      are present), ../intellisched_backend/.env MONGO_URI and ADMIN_API_KEY;
//   5. "Type YES to change them";
//   6. the writes: the backup first (both files copied to backups/env-<date-time>/, which git ignores),
//      then each .env file written to a temporary file next to it (".env.rotate-tmp", which git ignores
//      as ".env.*") and renamed over it. The new password goes into both MongoDB addresses,
//      percent-encoded; JWT_SECRET gets a new random value (48 bytes) and the shared key one new random
//      value, the same in every name of both files;
//   7. the end: "Done.", the two files it updated and the backup folder; a key that belongs to an outside
//      service (PROVIDER_KEYS) is never changed and is listed under "Change these on the provider's
//      website:".
// It never prints a value.
//
// Tests drive it on temporary copies with a fake connection: run({ files: { server, python }, io, now,
// backupsDir, ping, wait }) (scripts/live/kit.js; server/tests/integration/liveKit.test.js).
const fs = require('fs');
const path = require('path');
const kit = require('./kit');

// Keys of outside services the code might read one day; never rotated here.
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SENDGRID_API_KEY', 'SMTP_PASSWORD'];
const PASSWORD_MIN = 8;
const RETRY_WAIT_MS = 30000;

// The words a person reads, as docs/GO_LIVE.md step 1 quotes them.
const WORDS = {
  intro: [
    'rotate-secrets puts a new Atlas password into server/.env and ../intellisched_backend/.env, and new random keys for the gateway and the Python service.',
    'It tests the new password first, backs up both files, and changes nothing until you type YES.'
  ],
  testing: 'Testing the new password on Atlas (this reads and writes nothing)...',
  retrying: 'Atlas refused it. A new password can take a minute to reach the cluster, so this tries once more in 30 seconds...',
  works: 'The new password works.',
  refused: 'Atlas refused this password. Nothing was changed. In Atlas, copy the password again (or make a new one), then run npm run rotate-secrets again.',
  unreachable: 'This computer could not reach Atlas. Nothing was changed. Check the internet connection. In Atlas, open Network Access (IP Access List) and add this computer with "Add Current IP Address". Then run npm run rotate-secrets again.',
  willChange: 'These will change (the values are never shown):',
  confirm: 'Type YES to change them',
  stopped: 'Nothing was changed.',
  done: 'Done.',
  providers: "Change these on the provider's website:"
};
const LABELS = { server: 'server/.env', python: '../intellisched_backend/.env' };

// Atlas refusing the user name and password: the server's AuthenticationFailed (code 18), Atlas's own
// "bad auth : authentication failed" (code 8000, AtlasError), or the driver's authentication error.
// Anything else (no network, a blocked IP address, a DNS failure, a timeout) means Atlas was not reached.
const isRefused = (err) => {
  if ([18, 8000].includes(err?.code)) return true;
  const text = [err?.codeName, err?.message, err?.cause?.message].filter(Boolean).join(' ');
  return /AuthenticationFailed|bad auth|authentication failed/i.test(text);
};

// The real test: the MongoDB driver (the gateway's own) connects with the new address and sends
// { ping: 1 } to the admin database: it reads and writes nothing. Resolves 'works', 'refused' or
// 'unreachable'; never throws, never prints.
const pingAtlas = async (uri, { timeoutMs = 20000 } = {}) => {
  let client = null;
  try {
    const { MongoClient } = require(path.join(kit.SERVER_DIR, 'node_modules', 'mongodb'));
    client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs, retryWrites: false, appName: 'intellisched-rotate-secrets' });
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return 'works';
  } catch (err) {
    return isRefused(err) ? 'refused' : 'unreachable';
  } finally {
    if (client) await client.close().catch(() => {});
  }
};

// A .env file is written to a temporary file next to it, then renamed over it, so it is never left half
// written.
const writeReplacing = (file, text) => {
  const tmp = `${file}.rotate-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};

const run = async ({
  files = kit.ENV_FILES, io = kit.consoleIo(), now = new Date(), backupsDir = kit.BACKUPS_DIR,
  ping = pingAtlas, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) => {
  const say = io.say;
  // 1. What it does.
  WORDS.intro.forEach(line => say(line));
  for (const [name, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) { say(`The ${name} .env file does not exist: ${file}. ${WORDS.stopped}`); return { ok: false, reason: 'missing' }; }
  }
  const server = kit.readEnvFile(files.server);
  const python = kit.readEnvFile(files.python);

  // What will change, by name only.
  const serverKeys = kit.GATEWAY_KEY_NAMES.filter(k => k in server.values);
  const plan = {
    server: [...('MONGODB_URI' in server.values ? ['MONGODB_URI'] : []), 'JWT_SECRET', ...(serverKeys.length ? serverKeys : ['PYTHON_ML_API_KEY'])],
    python: [...('MONGO_URI' in python.values ? ['MONGO_URI'] : []), 'ADMIN_API_KEY']
  };
  const addresses = [
    ['server', 'MONGODB_URI', server.values.MONGODB_URI],
    ['python', 'MONGO_URI', python.values.MONGO_URI]
  ].filter(([which, name]) => plan[which].includes(name));
  if (!addresses.length) { say(`Neither file holds a MongoDB address (MONGODB_URI, MONGO_URI). ${WORDS.stopped}`); return { ok: false, reason: 'no address' }; }
  const providers = [...new Set([...Object.keys(server.values), ...Object.keys(python.values)].filter(k => PROVIDER_KEYS.includes(k)))];

  // 2. The new password, hidden, twice.
  const first = await io.askHidden('New Atlas password (nothing shows while you type): ');
  const second = await io.askHidden('The same password again: ');
  if (first !== second) { say(`The two passwords differ. ${WORDS.stopped}`); return { ok: false, reason: 'passwords differ' }; }
  if (first.length < PASSWORD_MIN) { say(`The password is shorter than ${PASSWORD_MIN} characters. ${WORDS.stopped}`); return { ok: false, reason: 'too short' }; }
  const newAddress = {};
  for (const [which, name, uri] of addresses) {
    newAddress[name] = kit.withPassword(uri, first);
    if (!newAddress[name]) {
      say(`${LABELS[which]} ${name} has no "user:password@" part, so the password cannot be put in. ${WORDS.stopped}`);
      return { ok: false, reason: 'uri without credentials' };
    }
  }

  // 3. The test: each distinct address once (both files normally name the same cluster).
  say(WORDS.testing);
  for (const uri of [...new Set(Object.values(newAddress))]) {
    let outcome = await ping(uri);
    if (outcome === 'refused') {
      say(WORDS.retrying);
      await wait(RETRY_WAIT_MS);
      outcome = await ping(uri);
    }
    if (outcome !== 'works') {
      say(outcome === 'refused' ? WORDS.refused : WORDS.unreachable);
      return { ok: false, reason: outcome === 'refused' ? 'refused' : 'unreachable' };
    }
  }
  say(WORDS.works);

  // 4. The names of what will change; 5. YES.
  say(WORDS.willChange);
  say(`  ${LABELS.server}: ${plan.server.join(', ')}`);
  say(`  ${LABELS.python}: ${plan.python.join(', ')}`);
  const answer = await io.ask(`${WORDS.confirm}: `);
  if (String(answer).trim() !== 'YES') { say(WORDS.stopped); return { ok: false, reason: 'not confirmed' }; }

  // 6. The writes: the backup first, then each file through a temporary file.
  const folder = path.join(backupsDir, `env-${kit.stamp(now)}`);
  const folderText = `${path.relative(kit.REPO_ROOT, folder) || folder}${path.sep}`;
  kit.ensureDir(folder);
  fs.copyFileSync(files.server, path.join(folder, 'server.env'));
  fs.copyFileSync(files.python, path.join(folder, 'intellisched_backend.env'));
  fs.writeFileSync(path.join(folder, 'README.txt'), `Copies of the two .env files before rotate-secrets ran on ${now.toISOString()}.\nTo undo: copy server.env back to server/.env and intellisched_backend.env back to ../intellisched_backend/.env, then restart the services.\n`);
  // The new values, the same shared key in both files.
  const jwt = kit.randomSecret();
  const shared = kit.randomSecret();
  const serverChanges = {};
  if (newAddress.MONGODB_URI) serverChanges.MONGODB_URI = newAddress.MONGODB_URI;
  serverChanges.JWT_SECRET = jwt;
  for (const key of (serverKeys.length ? serverKeys : ['PYTHON_ML_API_KEY'])) serverChanges[key] = shared;
  const pythonChanges = {};
  if (newAddress.MONGO_URI) pythonChanges.MONGO_URI = newAddress.MONGO_URI;
  pythonChanges.ADMIN_API_KEY = shared;
  const written = [];
  try {
    writeReplacing(files.server, kit.withEnvValues(server, serverChanges));
    written.push(LABELS.server);
    writeReplacing(files.python, kit.withEnvValues(python, pythonChanges));
    written.push(LABELS.python);
  } catch (err) {
    say(`Writing the settings stopped: ${kit.redact(err.message)}. Updated so far: ${written.join(', ') || 'nothing'}. The backup is in ${folderText}: copy its files back as its README.txt says, then run npm run rotate-secrets again.`);
    return { ok: false, reason: 'write failed', backup: folder, written };
  }

  // 7. The end.
  say(WORDS.done);
  say(`Updated: ${LABELS.server} and ${LABELS.python}`);
  say(`Backup: ${folderText}`);
  if (providers.length) {
    say(WORDS.providers);
    providers.forEach(name => say(`  ${name}`));
  }
  return { ok: true, changed: { server: Object.keys(serverChanges), python: Object.keys(pythonChanges) }, backup: folder, providers };
};

if (require.main === module) {
  run().then((r) => process.exit(r.ok ? 0 : 1)).catch((err) => { console.error(`rotate-secrets stopped: ${kit.redact(err.message)}`); process.exit(1); });
}

module.exports = { run, pingAtlas, isRefused, writeReplacing, WORDS, PROVIDER_KEYS, PASSWORD_MIN, RETRY_WAIT_MS };
