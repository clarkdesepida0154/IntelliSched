// Phase 11.3 (decisions 2-5): the full backup, the readable copy, the folder list and the retention.
//
// Full backup "IntelliSched-backup_YYYY-MM-DD_HHmm.isbak" (backupFile.js: always encrypted):
//   collections/<name>.json   every collection of the database as canonical Extended JSON (ids, dates
//                             and numbers survive exactly), sorted by _id; never system_settings (this
//                             computer's settings and the sealed password, models/SystemSetting.js)
//   model/<file>              the active Engine 2 model and its .meta.json, when found
//   manifest.json             the app and schema versions, the date, the database name, the record
//                             count per collection, the terms, a SHA-256 of every file inside, and the
//                             date the backup password was set (never the password)
// Readable copy "IntelliSched-readable_YYYY-MM-DD_HHmm.zip" (not encrypted, so it holds no rating,
// no password and no password hash): CSV files for Excel (UTF-8 with BOM) and the latest approved
// version's Teachers' Program, Class Schedule and Room Schedule from the existing exporters.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;
const { zipSync, unzipSync } = require('../exports/zip');
const { sealBackup, openBackup, readHeader, BackupFileError } = require('./backupFile');
const settingsStore = require('./settings');

const SERVER_PKG = require('../../package.json');
const APP_VERSION = SERVER_PKG.version;
// The backup's own schema: what collections/<name>.json and manifest.json mean. Raise it when the
// format changes; a backup with a higher number is refused (it was made by a newer IntelliSched).
const BACKUP_SCHEMA_VERSION = 1;
const EXCLUDED = new Set(['system_settings']);
const KEEP_BEFORE_RESTORE = 3;
const KEEP_READABLE = 10;
const MAIN_COLLECTIONS = ['faculty', 'sections', 'facilities', 'subject_catalog', 'curriculum_mappings', 'mother_schedules', 'users', 'audit_events'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
const FULL_RE = /^IntelliSched-backup_(\d{4}-\d{2}-\d{2}_\d{4})(-\d+)?(_before-restore)?\.isbak$/;
const READABLE_RE = /^IntelliSched-readable_(\d{4}-\d{2}-\d{2}_\d{4})(-\d+)?\.zip$/;

const db = () => {
  if (mongoose.connection.readyState !== 1) throw new BackupFileError('NO_DATABASE', 'The database is not connected.');
  return mongoose.connection.db;
};
const collectionNames = async () => (await db().listCollections({}, { nameOnly: true }).toArray())
  .map(c => c.name).filter(n => !n.startsWith('system.') && !EXCLUDED.has(n)).sort();

// ---------------------------------------------------------------- the model files
const MODEL_FILE = 'intellisched_gbdt_engine.joblib';
const MODEL_META = 'intellisched_gbdt_engine.meta.json';
const REPO = path.resolve(__dirname, '..', '..', '..');
// The model file Engine 2 uses: INTELLISCHED_MODEL_PATH or ML_MODEL_PATH when set, else a demo's own
// copy (.demo-data/models/<db>/), else the Python service's committed model.
const modelPathNow = () => {
  const given = process.env.INTELLISCHED_MODEL_PATH || process.env.ML_MODEL_PATH;
  if (given) return path.resolve(given);
  const dbName = mongoose.connection?.name;
  const demo = dbName ? path.join(REPO, '.demo-data', 'models', dbName, MODEL_FILE) : null;
  if (demo && fs.existsSync(demo)) return demo;
  return path.join(REPO, '..', 'intellisched_backend', MODEL_FILE);
};
const metaPathOf = (modelPath) => modelPath.replace(/\.joblib$/i, '.meta.json');
const readModelMeta = () => {
  try { return JSON.parse(fs.readFileSync(metaPathOf(modelPathNow()), 'utf8')); } catch { return null; }
};

// ---------------------------------------------------------------- dumping and loading collections
const dumpCollection = async (name) => {
  const docs = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
  return { count: docs.length, data: Buffer.from(EJSON.stringify(docs, { relaxed: false }), 'utf8') };
};

// A checksum of the database's content (every collection but the excluded ones), for the round-trip test
// and the restore's own check: { name: { count, sha256 } }.
const contentChecksum = async () => {
  const out = {};
  for (const name of await collectionNames()) {
    const { count, data } = await dumpCollection(name);
    // An empty collection is the same as none (a model may create its collection on first use).
    if (count) out[name] = { count, sha256: sha256(data) };
  }
  return out;
};

const termsOf = async () => {
  try {
    const rows = await db().collection('mother_schedules').aggregate([{ $group: { _id: { academicYear: '$academicYear', semester: '$semester' } } }]).toArray();
    return rows.map(r => r._id).filter(t => t.academicYear).sort((a, b) => `${a.academicYear}${a.semester}`.localeCompare(`${b.academicYear}${b.semester}`));
  } catch { return []; }
};

// The files of a full backup and its manifest (no encryption here).
const buildFullPayload = async ({ passwordSetOn = null, kind = 'full', now = new Date() } = {}) => {
  const entries = [];
  const counts = {};
  for (const name of await collectionNames()) {
    const { count, data } = await dumpCollection(name);
    counts[name] = count;
    entries.push({ name: `collections/${name}.json`, data });
  }
  const modelPath = modelPathNow();
  const model = [];
  for (const file of [modelPath, metaPathOf(modelPath)]) {
    if (fs.existsSync(file)) {
      entries.push({ name: `model/${path.basename(file)}`, data: fs.readFileSync(file) });
      model.push(path.basename(file));
    }
  }
  const manifest = {
    app: 'IntelliSched',
    appVersion: APP_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind,
    createdAt: now.toISOString(),
    dbName: mongoose.connection.name,
    terms: await termsOf(),
    counts,
    model,
    passwordSetOn: passwordSetOn ? new Date(passwordSetOn).toISOString() : null,
    files: Object.fromEntries(entries.map(e => [e.name, sha256(e.data)]))
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  return { entries, manifest };
};

// "1.2.3" > "1.2.0"?
const newerVersion = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

// Opens and checks a full backup: the password, every file's SHA-256, the schema and app versions.
// Returns { header, manifest, files: Map }; throws a BackupFileError in plain words, changing nothing.
const openFullBackup = (file, password) => {
  const { header, payload } = openBackup(file, password);
  let files;
  try { files = unzipSync(payload); } catch { throw new BackupFileError('BACKUP_DAMAGED', 'This backup is damaged: its contents cannot be read. Nothing was changed.'); }
  let manifest;
  try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); } catch { throw new BackupFileError('BACKUP_DAMAGED', 'This backup has no readable list of its contents. Nothing was changed.'); }
  if (Number(manifest.schemaVersion) > BACKUP_SCHEMA_VERSION || newerVersion(manifest.appVersion, APP_VERSION)) {
    throw new BackupFileError('BACKUP_TOO_NEW', `This backup was made by a newer IntelliSched (${manifest.appVersion}). Update IntelliSched first. Nothing was changed.`);
  }
  for (const [name, hash] of Object.entries(manifest.files || {})) {
    if (!files.has(name) || sha256(files.get(name)) !== hash) {
      throw new BackupFileError('BACKUP_DAMAGED', `This backup is damaged (${name} does not match its checksum). Nothing was changed.`);
    }
  }
  for (const name of files.keys()) {
    if (name !== 'manifest.json' && !(name in (manifest.files || {}))) throw new BackupFileError('BACKUP_DAMAGED', 'This backup holds a file its list does not name. Nothing was changed.');
  }
  return { header, manifest, files };
};

// Replaces every collection with the backup's (and empties a collection the backup does not have),
// then writes the model files. hooks.beforeCollection(name, index) lets a test fail it halfway.
const replaceAll = async ({ manifest, files }, hooks = {}) => {
  const names = Object.keys(manifest.counts || {}).sort();
  const current = await collectionNames();
  let i = 0;
  for (const name of names) {
    if (hooks.beforeCollection) await hooks.beforeCollection(name, i);
    i += 1;
    const docs = EJSON.parse(files.get(`collections/${name}.json`).toString('utf8'), { relaxed: false });
    const coll = db().collection(name);
    await coll.deleteMany({});
    for (let k = 0; k < docs.length; k += 1000) await coll.insertMany(docs.slice(k, k + 1000), { ordered: true });
  }
  for (const name of current.filter(n => !names.includes(n))) await db().collection(name).deleteMany({});
  if ((manifest.model || []).length) {
    const modelPath = modelPathNow();
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    for (const base of manifest.model) {
      const target = base.endsWith('.meta.json') ? metaPathOf(modelPath) : modelPath;
      const tmp = `${target}.restore-tmp`;
      fs.writeFileSync(tmp, files.get(`model/${base}`));
      fs.renameSync(tmp, target);
    }
  }
  // The record counts re-checked against the manifest.
  const wrong = [];
  for (const name of names) {
    const n = await db().collection(name).countDocuments({});
    if (n !== manifest.counts[name]) wrong.push(`${name} ${n} of ${manifest.counts[name]}`);
  }
  if (wrong.length) throw new BackupFileError('RESTORE_COUNTS', `The restored record counts do not match the backup: ${wrong.join(', ')}.`);
  return { collections: names.length };
};

// ---------------------------------------------------------------- the folder
const uniqueName = (folder, base, ext) => {
  let name = `${base}${ext}`;
  for (let n = 2; fs.existsSync(path.join(folder, name)); n += 1) name = `${base}-${n}${ext}`;
  return name;
};
const writeAtomically = (file, buffer) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
};

// The folder's backups, newest first: [{ name, kind: 'full' | 'before-restore' | 'readable', size,
// createdAt, passwordSetOn }]. A file that cannot be read is listed with damaged: true.
const listFolder = (folder) => {
  if (!folder || !fs.existsSync(folder)) return [];
  const out = [];
  for (const name of fs.readdirSync(folder)) {
    const full = FULL_RE.exec(name);
    const readable = READABLE_RE.exec(name);
    if (!full && !readable) continue;
    const file = path.join(folder, name);
    const stat = fs.statSync(file);
    const entry = { name, kind: readable ? 'readable' : full[3] ? 'before-restore' : 'full', size: stat.size, createdAt: stat.mtime.toISOString(), passwordSetOn: null };
    if (full) {
      try {
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(Math.min(stat.size, 8192));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        const { header } = readHeader(Buffer.concat([head, Buffer.alloc(16)]));
        entry.createdAt = header.createdAt || entry.createdAt;
        entry.passwordSetOn = header.passwordSetOn || null;
        entry.appVersion = header.appVersion || null;
      } catch { entry.damaged = true; }
    }
    out.push(entry);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.name.localeCompare(a.name));
};

// Keeps the newest `keep` full backups, the newest 3 before-restore files and the newest 10 readable
// copies; deletes the older ones. Returns the names deleted.
const applyRetention = (folder, keep) => {
  const n = Math.min(settingsStore.KEEP_RANGE.max, Math.max(settingsStore.KEEP_RANGE.min, Number(keep) || settingsStore.KEEP_RANGE.default));
  const list = listFolder(folder);
  const deleted = [];
  for (const [kind, limit] of [['full', n], ['before-restore', KEEP_BEFORE_RESTORE], ['readable', KEEP_READABLE]]) {
    list.filter(e => e.kind === kind).slice(limit).forEach(e => { fs.rmSync(path.join(folder, e.name), { force: true }); deleted.push(e.name); });
  }
  return deleted;
};

// ---------------------------------------------------------------- the readable copy
const BOM = '﻿';
const csvCell = (v) => {
  const text = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = (header, rows) => `${BOM}${[header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
const EMPLOYMENT = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };

// The latest approved version (an old stored "Published" counts), non-legacy.
const latestApproved = async () => {
  const MotherSchedule = require('../models/MotherSchedule');
  return MotherSchedule.findOne({ status: { $in: ['Approved', 'Published'] }, schemaVersion: 2 })
    .sort({ updatedAt: -1, createdAt: -1 }).select('_id academicYear semester version status').lean();
};

const buildReadablePayload = async ({ withPdf = true } = {}) => {
  const Faculty = require('../models/Faculty');
  const Section = require('../models/Section');
  const Facility = require('../models/Facility');
  const SubjectCatalog = require('../models/SubjectCatalog');
  const entries = [];
  // Only the fields below are read: never evalScore, a password or a hash.
  const faculty = await Faculty.find({}).select('facultyId name employmentType position program degreeAfterName teachingCapHours minTeachingHours isActive archived').sort({ name: 1 }).lean();
  entries.push({ name: 'faculty.csv', data: csv(['Faculty code', 'Name', 'Employment type', 'Position', 'Program', 'Degree', 'Teaching cap (h)', 'Minimum (h)', 'Status'],
    faculty.map(f => [f.facultyId, f.name, EMPLOYMENT[f.employmentType] || '', f.position, f.program, f.degreeAfterName, f.teachingCapHours, f.minTeachingHours, f.archived ? 'Archived' : f.isActive === false ? 'Disabled' : 'Active'])) });
  const sections = await Section.find({}).select('sectionCode program yearLevel track isActive').sort({ program: 1, yearLevel: 1, sectionCode: 1 }).lean();
  entries.push({ name: 'sections.csv', data: csv(['Section', 'Program', 'Year', 'Track', 'Enabled'], sections.map(s => [s.sectionCode, s.program, s.yearLevel, s.track, s.isActive === false ? 'No' : 'Yes'])) });
  const rooms = await Facility.find({}).select('roomName type capacity building isActive').sort({ roomName: 1 }).lean();
  entries.push({ name: 'rooms.csv', data: csv(['Room', 'Type', 'Capacity', 'Building', 'Active'], rooms.map(r => [r.roomName, r.type, r.capacity, r.building, r.isActive === false ? 'No' : 'Yes'])) });
  const subjects = await SubjectCatalog.find({}).select('subjectCode descriptiveTitle type lecHours labHours units isActive').sort({ subjectCode: 1 }).lean();
  entries.push({ name: 'subjects.csv', data: csv(['Code', 'Title', 'Type', 'Lecture hours', 'Lab hours', 'Units', 'Active'], subjects.map(s => [s.subjectCode, s.descriptiveTitle, s.type, s.lecHours, s.labHours, s.units, s.isActive === false ? 'No' : 'Yes'])) });

  const approved = await latestApproved();
  const notes = [];
  if (approved) {
    const { loadScheduleOutputs } = require('../controllers/outputsController');
    const { outputs, error } = await loadScheduleOutputs({ academicYear: approved.academicYear, semester: approved.semester, scheduleId: String(approved._id) });
    if (error) notes.push(`The approved version could not be read: ${error.payload?.message || 'unknown reason'}.`);
    else {
      const classes = outputs.classes || [];
      const roomOf = (c) => (c.roomKind === 'ONLINE' ? 'Online' : c.roomName || 'TBA');
      const pairs = new Map();
      for (const c of classes) {
        const key = `${c.sectionLabel}|${c.subjectCode}|${c.classType}`;
        if (!pairs.has(key)) pairs.set(key, [c.sectionLabel, c.subjectCode, c.subjectTitle, c.classType, c.facultyName || 'TBA']);
      }
      entries.push({ name: 'assignments.csv', data: csv(['Section', 'Subject', 'Title', 'LEC/LAB', 'Professor'], [...pairs.values()].sort((a, b) => a.join('|').localeCompare(b.join('|')))) });
      entries.push({ name: 'schedule.csv', data: csv(['Section', 'Subject', 'Title', 'LEC/LAB', 'Day', 'Start', 'End', 'Room', 'Professor', 'Weeks'],
        classes.map(c => [c.sectionLabel, c.subjectCode, c.subjectTitle, c.classType, c.day, c.startTime, c.endTime, roomOf(c), c.facultyName || 'TBA', c.weekGroup === 'ODD' ? 'Weeks 1 and 3' : c.weekGroup === 'EVEN' ? 'Weeks 2 and 4' : 'Every week'])) });
      const { buildExport } = require('../exports');
      for (const view of ['teachers-program', 'class-schedule', 'room-schedule']) {
        for (const format of withPdf ? ['docx', 'pdf'] : ['docx']) {
          try {
            const file = await buildExport({ outputs, view, format });
            entries.push({ name: `forms/${file.fileName}`, data: file.buffer });
          } catch (err) {
            notes.push(`${view} ${format.toUpperCase()} could not be made (${format === 'pdf' ? 'no browser for PDFs on this computer' : 'export error'}).`);
          }
        }
      }
      notes.unshift(`The schedule and the forms are the approved version ${approved.version || ''} of the ${approved.semester === 1 ? '1st' : '2nd'} Semester, AY ${approved.academicYear}.`);
    }
  } else notes.push('No version is approved yet, so there is no schedule or form in this copy.');
  const readme = [
    'IntelliSched: a readable copy of the data, for people. Open the CSV files in Excel.',
    'It holds no evaluation rating, no password and no password hash. To restore the system, use a full backup (.isbak) instead.',
    `Made ${new Date().toLocaleString()}.`,
    ...notes
  ].join('\r\n');
  entries.push({ name: 'README.txt', data: `${BOM}${readme}\r\n` });
  return { entries };
};

module.exports = {
  APP_VERSION, BACKUP_SCHEMA_VERSION, EXCLUDED, MAIN_COLLECTIONS, KEEP_BEFORE_RESTORE, KEEP_READABLE,
  FULL_RE, READABLE_RE, stamp, sha256, uniqueName, writeAtomically,
  collectionNames, contentChecksum, buildFullPayload, openFullBackup, replaceAll,
  listFolder, applyRetention, buildReadablePayload, modelPathNow, readModelMeta, termsOf, newerVersion,
  sealBackup, zipSync
};
