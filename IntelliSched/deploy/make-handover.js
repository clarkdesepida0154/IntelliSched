// Phase 12.1 (decision 1): steps 3-7 of the office handover (make-handover.ps1 runs steps 1-2 first:
// npm run defense:backup, read only, then defense:restore --into intellisched_handover_test).
//   node deploy/make-handover.js --source-db <the backup's database> --out <folder> --passwords <file>
//        [--training <csv>] [--log-json <file>]
//   standard input: one line, base64 of JSON { handoverPassword?, deanPassword? }; whatever is missing
//   is generated (the handover password: 16 characters, the Dean's starting password: 14, both from an
//   alphabet without 0 O 1 l I).
// Works on the throwaway copy intellisched_handover_test only, on the demo's own MongoDB:
//   3. the accounts: exactly one is kept, the active Dean without a demo, practice or TEST marker
//      (several: the one who made the approvals, else the most recently signed in); every other
//      account is removed. None: "No real Dean account was found." and NOTHING is written (exit 4);
//   4. the Dean's starting password, with the gateway's own hashing (the User model), and
//      mustChangePassword: the Dean chooses a new one at the first sign-in;
//   5. handover.isbak through the Phase 11.3 backup service, encrypted with the handover password;
//      handover-training.enc: the file Engine 4's Retrain reads (docs/ml/private/dataset_full.csv),
//      sealed with the backup service's own AES-256-GCM/scrypt helper and the same password;
//   6. both files opened again and checked (one account, the starting password matches, the flag set);
//   7. OFFICE-PASSWORDS.txt (outside every kit folder); intellisched_handover_test dropped; the counts
//      and the SHA-256 printed. No password is ever printed or logged; e-mails are masked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const lib = require('./handover-lib');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const HANDOVER_DB = 'intellisched_handover_test';
const serverRequire = createRequire(path.join(SERVER, 'package.json'));
const { withDemoMongo } = require(path.join(REPO, 'scripts', 'demo', 'defense-backup.js'));

const argv = process.argv.slice(2);
const value = (flag, fallback = null) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const say = (line) => console.log(line);
const NO_DEAN = 4;

const readSecrets = () => new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve({});
  let data = '';
  process.stdin.setEncoding('latin1');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    const line = (data.split(/\r?\n/)[0] || '').replace(/[^A-Za-z0-9+/=]/g, '');
    try { resolve(line ? JSON.parse(Buffer.from(line, 'base64').toString('utf8')) : {}); } catch { resolve({}); }
  });
});

const table = (rows) => rows.map(r => `  ${r.action.padEnd(6)} ${String(r.user.name || '').padEnd(32)} ${lib.maskEmail(r.user.email).padEnd(9)} ${String(r.user.role || '').padEnd(18)} ${String(r.user.status || 'Active').padEnd(7)} ${r.reason}`);

const main = async () => {
  const sourceDb = value('--source-db');
  const outDir = path.resolve(value('--out', path.join(REPO, '.deploy-out', 'handover')));
  const passwordsFile = path.resolve(value('--passwords', path.join(REPO, '.deploy-out', 'OFFICE-PASSWORDS.txt')));
  const training = path.resolve(value('--training', path.join(REPO, 'docs', 'ml', 'private', 'dataset_full.csv')));
  const logJson = value('--log-json');
  if (!sourceDb) throw new Error('Name the backup\'s database (--source-db).');
  if (!fs.existsSync(training)) throw new Error(`The Retrain data was not found: ${path.basename(training)}.`);
  const given = await readSecrets();
  const handoverPassword = given.handoverPassword || lib.newPassword(16);
  const deanPassword = given.deanPassword || lib.newPassword(14);
  if (lib.passwordProblem(handoverPassword)) throw new Error(`The handover password: ${lib.passwordProblem(handoverPassword)}`);

  return withDemoMongo({
    runMode: 'make-handover',
    say,
    job: async ({ uriFor }) => {
      const demoModel = path.join(REPO, '.demo-data', 'models', sourceDb, 'intellisched_gbdt_engine.joblib');
      process.env.INTELLISCHED_MODEL_PATH = fs.existsSync(demoModel) ? demoModel : path.resolve(REPO, '..', 'intellisched_backend', 'intellisched_gbdt_engine.joblib');
      process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
      const mongoose = serverRequire('mongoose');
      await mongoose.connect(uriFor(HANDOVER_DB), { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 20000 });
      const record = { sourceDb, accounts: [], kept: null, counts: null, sha256: null, trainingSha256: null, result: null };
      try {
        const db = mongoose.connection.db;
        if (db.databaseName !== HANDOVER_DB) throw new Error(`Refused: ${db.databaseName} is not the throwaway copy.`);
        const users = db.collection('users');

        // ------------------------------------------------------ 3. the accounts
        const all = await users.find({}, { projection: { name: 1, email: 1, role: 1, status: 1, lastLogin: 1 } }).sort({ role: 1, name: 1 }).toArray();
        const approvals = {};
        for (const row of await db.collection('audit_events').find({ category: 'Approval' }, { projection: { 'actor.id': 1 } }).toArray()) {
          const id = row.actor?.id;
          if (id) approvals[id] = (approvals[id] || 0) + 1;
        }
        const { kept, rows } = lib.chooseAccounts(all, approvals);
        record.accounts = rows.map(r => ({ name: r.user.name, email: lib.maskEmail(r.user.email), role: r.user.role, status: r.user.status || 'Active', action: r.action, reason: r.reason }));
        say('');
        say('Step 3: the accounts (e-mails masked)');
        say(`  ${'ACTION'.padEnd(6)} ${'NAME'.padEnd(32)} ${'E-MAIL'.padEnd(9)} ${'ROLE'.padEnd(18)} ${'STATUS'.padEnd(7)} REASON`);
        table(rows).forEach(say);
        if (!kept) {
          say('');
          say('No real Dean account was found. Nothing was written.');
          record.result = 'refused';
          return NO_DEAN;
        }
        record.kept = { name: kept.name, role: kept.role };
        const removed = await users.deleteMany({ _id: { $ne: kept._id } });
        say(`  kept 1 account (${kept.name}, ${kept.role}); removed ${removed.deletedCount}`);

        // ------------------------------------------------------ 4. the starting password
        const User = serverRequire(path.join(SERVER, 'src', 'models', 'User.js'));
        const dean = await User.findById(kept._id);
        dean.password = deanPassword;
        dean.mustChangePassword = true;
        await dean.save({ validateModifiedOnly: true });
        say('Step 4: the Dean\'s starting password is set (changed at the first sign-in)');

        // ------------------------------------------------------ 5. the two files
        const svc = serverRequire(path.join(SERVER, 'src', 'backup', 'service.js'));
        const { sealBackup, openBackup } = serverRequire(path.join(SERVER, 'src', 'backup', 'backupFile.js'));
        const { zipSync, unzipSync } = serverRequire(path.join(SERVER, 'src', 'exports', 'zip.js'));
        const { entries, manifest } = await svc.buildFullPayload({ passwordSetOn: null, kind: 'full' });
        const sealed = sealBackup(zipSync(entries), handoverPassword, {
          passwordSetOn: null, createdAt: manifest.createdAt, appVersion: manifest.appVersion,
          schemaVersion: manifest.schemaVersion, dbName: manifest.dbName, kind: manifest.kind
        });
        const csv = fs.readFileSync(training);
        const trainingSealed = sealBackup(zipSync([{ name: 'dataset_full.csv', data: csv }]), handoverPassword, {
          createdAt: new Date().toISOString(), appVersion: manifest.appVersion, kind: 'training'
        });
        fs.mkdirSync(outDir, { recursive: true });
        const isbak = path.join(outDir, 'handover.isbak');
        const enc = path.join(outDir, 'handover-training.enc');
        for (const [file, data] of [[isbak, sealed], [enc, trainingSealed]]) {
          fs.writeFileSync(`${file}.tmp`, data);
          fs.renameSync(`${file}.tmp`, file);
        }
        say('Step 5: handover.isbak and handover-training.enc written (encrypted with the handover password)');

        // ------------------------------------------------------ 6. check both
        const opened = svc.openFullBackup(fs.readFileSync(isbak), handoverPassword);
        const usersFile = [...opened.files.keys()].find(n => /(^|\/)users\.json$/.test(n));
        const { EJSON } = mongoose.mongo.BSON;
        const inFile = EJSON.parse(opened.files.get(usersFile).toString('utf8'));
        const bcrypt = serverRequire('bcryptjs');
        if (inFile.length !== 1) throw new Error(`The handover holds ${inFile.length} accounts, not 1.`);
        if (!inFile[0].mustChangePassword || !(await bcrypt.compare(deanPassword, inFile[0].password))) throw new Error('The Dean\'s starting password did not check out in handover.isbak.');
        const back = unzipSync(openBackup(fs.readFileSync(enc), handoverPassword).payload).get('dataset_full.csv');
        if (!back || !back.equals(csv)) throw new Error('handover-training.enc did not open to the same Retrain data.');
        say('Step 6: both files open with the handover password; one account, the starting password and its flag check out');

        // ------------------------------------------------------ 7. the paper, the report
        record.sha256 = crypto.createHash('sha256').update(sealed).digest('hex');
        record.trainingSha256 = crypto.createHash('sha256').update(trainingSealed).digest('hex');
        record.counts = opened.manifest.counts;
        record.model = opened.manifest.model || [];
        fs.mkdirSync(path.dirname(passwordsFile), { recursive: true });
        fs.writeFileSync(passwordsFile, lib.officePasswordsText({ handoverPassword, deanEmail: kept.email, deanPassword, madeAt: new Date().toISOString(), sha256: record.sha256 }), 'utf8');
        say('');
        say('Step 7: the record counts in handover.isbak');
        for (const [name, n] of Object.entries(record.counts)) say(`  ${name}: ${n}`);
        say(`  model files: ${record.model.join(', ') || 'none'}`);
        say(`handover.isbak: ${isbak}`);
        say(`  SHA-256 ${record.sha256}`);
        say(`handover-training.enc: ${enc}`);
        say(`  SHA-256 ${record.trainingSha256}`);
        say(`The passwords are in ${passwordsFile} (print it; keep it apart from the USB sticks).`);
        record.result = 'written';
        return 0;
      } finally {
        if (logJson) { fs.mkdirSync(path.dirname(path.resolve(logJson)), { recursive: true }); fs.writeFileSync(path.resolve(logJson), JSON.stringify(record, null, 2)); }
        await mongoose.connection.db.dropDatabase().then(() => say(`Dropped ${HANDOVER_DB}`)).catch(() => {});
        await mongoose.disconnect().catch(() => {});
      }
    }
  });
};

main().then(code => process.exit(code || 0)).catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
