// IntelliSched deployment kit (Phase 12.1, decision 3): the Office kit's Retrain data. Opens
// data\handover-training.enc with the handover password (standard input, kit-lib readSecret) through the
// backup service's own AES-256-GCM/scrypt helper and writes its file into <install>\private\
// (install.ps1 locks that folder to Administrators, SYSTEM and the daily user, and points the Python
// service's ML_DATASET there). Prints the file's name and size, never its contents.
//   node training-cli.js --root <install> --file <handover-training.enc>
const fs = require('fs');
const path = require('path');
const { P, argValue, fromServer, readSecret, say, fail } = require('./kit-lib');

const main = async () => {
  const file = path.resolve(argValue('--file') || '');
  if (!fs.existsSync(file)) fail(`The Retrain data file was not found: ${file}`);
  const password = await readSecret();
  if (!password) fail('No handover password was given.');
  const { openBackup } = fromServer('src/backup/backupFile.js');
  const { unzipSync } = fromServer('src/exports/zip.js');
  let files;
  try {
    const opened = openBackup(fs.readFileSync(file), password);
    if (opened.header.kind !== 'training') fail('This is not the Retrain data file.', 3);
    files = unzipSync(opened.payload);
  } catch (err) {
    fail(err.plain ? err.message : `The Retrain data could not be opened: ${err.message}`, 3);
  }
  const dir = path.join(P.root, 'private');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of files) {
    const target = path.join(dir, path.basename(name));
    fs.writeFileSync(`${target}.tmp`, data);
    fs.renameSync(`${target}.tmp`, target);
    say(`Retrain data: private\\${path.basename(name)} (${Math.round(data.length / 1024)} KB)`);
  }
};

main().then(() => process.exit(0)).catch((err) => fail(err.message));
