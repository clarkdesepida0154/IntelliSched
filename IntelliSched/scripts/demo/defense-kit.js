// Phase 8 Part 12 (Session B): the defense kit for the other laptops.
//
// Git carries both repositories; it does not carry what the defense needs besides them: the private
// faculty files (with the evaluation ratings), the private dataset, the two .env files, the defense's
// login, the defense's model copy and the newest backup of the defense database. This script packs
// them into ONE zip that travels by USB, and unpacks it into a fresh clone.
//
//   npm run defense:kit:pack
//       Collects what exists of the list below, writes kit-manifest.json (each file's destination,
//       size and SHA-256; both repositories' commit and branch; the date; this laptop's Node and Python
//       versions) and zips everything to .demo-data/kit/intellisched-defense-kit-<yyyy-mm-dd_HH-mm>.zip
//       with PowerShell's Compress-Archive (no new package). It re-reads the zip's entry list against the
//       manifest. It prints the path, the file list with sizes and the total; never a file's contents.
//
//   npm run defense:kit:unpack -- <zip> [--force]
//       From the root of a fresh clone of IntelliSched with intellisched_backend cloned beside it.
//       Expands the zip into a temporary folder under .demo-data/kit/, checks every file's SHA-256
//       against the manifest, and places each one at its destination (folders made as needed), checking
//       the SHA-256 again after the copy. An existing file is never overwritten without --force (one
//       with the same SHA-256 is reported as already there). It prints what it placed and skipped, the
//       kit's commits next to the clone's (a warning when they differ) and the next three commands.
//
// The kit holds ratings and secrets: it stays in the gitignored .demo-data/kit/, is never committed,
// pushed, emailed or uploaded. Nothing here prints a file's contents, only paths, sizes and hashes.
// The procedure for a person is docs/SETUP_LAPTOP.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { REPO_ROOT, BACKEND_DIR, DEMO_DATA } = require('./paths');
const { BACKUPS_DIR, DEFENSE_DB, localStamp } = require('./defense-backup');

const KIT_DIR = path.join(DEMO_DATA, 'kit');
const say = (line) => console.log(`[defense:kit] ${line}`);
const slash = (p) => p.split(path.sep).join('/');
const ROOTS = { repo: REPO_ROOT, backend: BACKEND_DIR };
const ROOT_NAMES = { repo: 'IntelliSched', backend: 'intellisched_backend' };

// The single files of the kit, { root, path } (a file that does not exist is left out and said so).
const SINGLE_FILES = [
  { root: 'repo', path: 'docs/data/faculty_data.json' },
  { root: 'repo', path: 'docs/data/faculty_data.ratings.json' },
  { root: 'repo', path: 'docs/data/faculty_data.ratings_history.json' },
  { root: 'repo', path: 'docs/ml/private/dataset_full.csv' },
  { root: 'repo', path: 'server/.env' },
  { root: 'backend', path: '.env' },
  { root: 'repo', path: '.demo-data/defense-secrets.json' },
  { root: 'backend', path: 'intellisched_gbdt_engine.joblib' },
  { root: 'backend', path: 'intellisched_gbdt_engine.meta.json' },
  { root: 'backend', path: 'intellisched_gbdt_engine.phase5.joblib' }
];
const MODEL_COPY_DIR = `.demo-data/models/${DEFENSE_DB}`;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sizeWords = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);
const minuteStamp = (date = new Date()) => localStamp(date).slice(0, 16); // 2026-10-17_18-05
const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(full) : [full];
});

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};
const repoState = (dir) => ({ commit: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') });
const pythonVersion = () => {
  const venv = path.join(BACKEND_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  for (const [cmd, args] of [[venv, ['--version']], ['py', ['-3.12', '--version']], ['python', ['--version']]]) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0 && text) return text.replace(/^Python\s+/i, '');
  }
  return 'unknown';
};

// PowerShell with the paths in its environment (the folder names hold an apostrophe: never quoted).
const powershell = (script, env) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`PowerShell failed: ${(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || `exit ${result.status}`}`);
  return result.stdout;
};
const ZIP_ENTRIES = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:KIT_ZIP); try { $z.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName } } finally { $z.Dispose() }";

// The newest backup folder whose manifest names the defense database (by the manifest's createdAt).
const newestDefenseBackup = () => {
  if (!fs.existsSync(BACKUPS_DIR)) return null;
  const found = [];
  for (const name of fs.readdirSync(BACKUPS_DIR)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, name, 'manifest.json'), 'utf8'));
      if (manifest.database === DEFENSE_DB) found.push({ name, createdAt: manifest.createdAt || '' });
    } catch { /* no manifest: not a database backup */ }
  }
  found.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return found.length ? found[found.length - 1].name : null;
};

const pack = () => {
  const entries = [];
  const missing = [];
  const add = (root, rel) => {
    const source = path.join(ROOTS[root], rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) { missing.push(`${ROOT_NAMES[root]}/${rel}`); return; }
    entries.push({ root, path: rel, source });
  };
  for (const item of SINGLE_FILES) add(item.root, item.path);
  const modelDir = path.join(REPO_ROOT, MODEL_COPY_DIR);
  if (fs.existsSync(modelDir)) for (const file of filesUnder(modelDir)) add('repo', slash(path.relative(REPO_ROOT, file)));
  else missing.push(`IntelliSched/${MODEL_COPY_DIR}/`);
  const backup = newestDefenseBackup();
  if (backup) for (const file of filesUnder(path.join(BACKUPS_DIR, backup))) add('repo', slash(path.relative(REPO_ROOT, file)));
  else missing.push(`IntelliSched/.demo-data/backups/ (no backup of ${DEFENSE_DB})`);

  const now = new Date();
  const stamp = minuteStamp(now);
  const zip = path.join(KIT_DIR, `intellisched-defense-kit-${stamp}.zip`);
  if (fs.existsSync(zip)) throw new Error(`${slash(path.relative(REPO_ROOT, zip))} already exists; a kit is never overwritten. Wait a minute or move it, then pack again.`);
  const staging = path.join(KIT_DIR, `.staging-${localStamp(now)}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const files = entries.map((entry) => {
      const target = path.join(staging, entry.root, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(entry.source, target);
      const hash = sha256(target);
      if (hash !== sha256(entry.source)) throw new Error(`${entry.path} changed while it was copied; pack again.`);
      return { root: entry.root, path: entry.path, size: fs.statSync(target).size, sha256: hash };
    });
    const manifest = {
      kind: 'intellisched-defense-kit',
      createdAt: now.toISOString(),
      createdOn: os.hostname(),
      defenseBackup: backup ? `.demo-data/backups/${backup}` : null,
      repositories: { repo: { name: 'IntelliSched', ...repoState(REPO_ROOT) }, backend: { name: 'intellisched_backend', ...repoState(BACKEND_DIR) } },
      versions: { node: process.version, python: pythonVersion() },
      roots: { repo: 'the IntelliSched clone (where this script runs)', backend: 'intellisched_backend, cloned beside it' },
      files
    };
    fs.writeFileSync(path.join(staging, 'kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    powershell("Get-ChildItem -LiteralPath $env:KIT_SRC -Force | Compress-Archive -DestinationPath $env:KIT_ZIP -CompressionLevel Optimal", { KIT_SRC: staging, KIT_ZIP: zip });
    // The zip's own entry list, read back against the manifest.
    const inZip = new Set(powershell(ZIP_ENTRIES, { KIT_ZIP: zip }).split(/\r?\n/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean));
    const absent = ['kit-manifest.json', ...files.map(f => `${f.root}/${f.path}`)].filter(name => !inZip.has(name));
    if (absent.length) { fs.rmSync(zip, { force: true }); throw new Error(`The zip lacks ${absent.length} file(s) (${absent.slice(0, 3).join(', ')}); nothing was kept. Pack again.`); }

    say(`Kit: ${slash(path.relative(REPO_ROOT, zip))} (${sizeWords(fs.statSync(zip).size)}; ${files.length} files, ${sizeWords(files.reduce((s, f) => s + f.size, 0))} before compression)`);
    for (const f of files) say(`  ${ROOT_NAMES[f.root]}/${f.path}  ${sizeWords(f.size)}`);
    for (const m of missing) say(`  not found, left out: ${m}`);
    for (const [key, repo] of Object.entries(manifest.repositories)) say(`${repo.name}: ${repo.branch || '?'} at ${repo.commit || '?'}${key === 'backend' && !repo.commit ? ' (not found beside this repository)' : ''}`);
    say(`Node ${manifest.versions.node}, Python ${manifest.versions.python}.`);
    say('It holds ratings and secrets: copy it by USB only, never by email, chat or an upload. Unpack on the other laptop with: npm run defense:kit:unpack -- .demo-data\\kit\\' + path.basename(zip));
    return 0;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

const unpack = (zipArg, force) => {
  if (!zipArg) throw new Error('Name the kit: npm run defense:kit:unpack -- .demo-data\\kit\\intellisched-defense-kit-<date>.zip');
  const zip = path.resolve(zipArg);
  if (!fs.existsSync(zip)) throw new Error(`No file ${zipArg}. Copy the kit from the USB drive into .demo-data\\kit\\ first.`);
  if (!fs.existsSync(BACKEND_DIR)) throw new Error(`intellisched_backend is not beside this repository (${slash(BACKEND_DIR)}). Clone it there first (docs/SETUP_LAPTOP.md step 2). Nothing was placed.`);
  const temp = path.join(KIT_DIR, `.unpack-${localStamp()}`);
  fs.mkdirSync(temp, { recursive: true });
  try {
    powershell('Expand-Archive -LiteralPath $env:KIT_ZIP -DestinationPath $env:KIT_OUT -Force', { KIT_ZIP: zip, KIT_OUT: temp });
    const manifestFile = path.join(temp, 'kit-manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('This zip has no kit-manifest.json: it is not a defense kit. Nothing was placed.');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.kind !== 'intellisched-defense-kit' || !Array.isArray(manifest.files)) throw new Error('kit-manifest.json is not a defense kit\'s manifest. Nothing was placed.');
    // Every file is checked before anything is placed.
    for (const f of manifest.files) {
      if (!ROOTS[f.root] || path.isAbsolute(f.path) || f.path.split('/').includes('..')) throw new Error(`The manifest names an unsafe path (${f.root}/${f.path}). Nothing was placed.`);
      const extracted = path.join(temp, f.root, f.path);
      if (!fs.existsSync(extracted)) throw new Error(`${f.root}/${f.path} is missing from the zip. Nothing was placed; copy the kit again.`);
      if (sha256(extracted) !== f.sha256) throw new Error(`${f.root}/${f.path} does not match its SHA-256: the zip is damaged. Nothing was placed; copy the kit again.`);
    }
    const placed = []; const same = []; const skipped = [];
    for (const f of manifest.files) {
      const shown = `${ROOT_NAMES[f.root]}/${f.path}`;
      const dest = path.join(ROOTS[f.root], f.path);
      if (fs.existsSync(dest)) {
        if (sha256(dest) === f.sha256) { same.push(shown); continue; }
        if (!force) { skipped.push(shown); continue; }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(temp, f.root, f.path), dest);
      if (sha256(dest) !== f.sha256) throw new Error(`${shown} does not match its SHA-256 after the copy. Unpack again with --force.`);
      placed.push(`${shown}  ${sizeWords(f.size)}`);
    }
    say(`Kit of ${manifest.createdAt} (${manifest.files.length} files, every SHA-256 checked):`);
    for (const line of placed) say(`  placed: ${line}`);
    for (const line of same) say(`  already there (the same file): ${line}`);
    for (const line of skipped) say(`  SKIPPED, a different file is there: ${line} (add --force to replace it)`);
    say(`Placed ${placed.length}, already there ${same.length}, skipped ${skipped.length}.`);
    let differ = false;
    for (const [key, dir] of Object.entries(ROOTS)) {
      const kit = manifest.repositories?.[key] || {};
      const here = repoState(dir);
      const match = kit.commit && here.commit === kit.commit;
      if (!match) differ = true;
      say(`${ROOT_NAMES[key]}: kit ${kit.branch || '?'} ${String(kit.commit || '?').slice(0, 7)}, this clone ${here.branch || '?'} ${String(here.commit || '?').slice(0, 7)}${match ? ' (the same)' : ' (DIFFERENT)'}`);
    }
    if (differ) say('WARNING: the clone is not at the kit\'s commits. Run git checkout phase-8 and git pull in both repositories, or ask for a new kit.');
    say('Next (docs/SETUP_LAPTOP.md steps 5-6):');
    say('  1. npm run demo:sem2:reset -- --faculty-seed     (once, online: downloads MongoDB; Ctrl+C when it is ready)');
    say(`  2. npm run defense:restore -- --from ${manifest.defenseBackup ? manifest.defenseBackup.replace(/\//g, '\\') : '.demo-data\\backups\\<the kit\'s defense folder>'}     (type RESTORE)`);
    say('  3. npm run defense');
    return 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let code;
  try {
    if (args.includes('--pack')) code = pack();
    else if (args.includes('--unpack')) code = unpack(args[args.indexOf('--unpack') + 1] && !args[args.indexOf('--unpack') + 1].startsWith('--') ? args[args.indexOf('--unpack') + 1] : null, args.includes('--force'));
    else throw new Error('Use --pack, or --unpack <zip> [--force] (npm run defense:kit:pack / npm run defense:kit:unpack -- <zip>).');
  } catch (err) {
    say(err.message);
    code = 1;
  }
  process.exit(code);
}

module.exports = { newestDefenseBackup, SINGLE_FILES };
