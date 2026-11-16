// Phase 11.3: Administration -> System. Every route is the Dean's alone (system.manage, reading
// included; routes/systemRoutes.js). A password never leaves the gateway, never reaches a log or the
// Audit Trail, and every answer is in plain words.
//   GET  /system/about                       versions, the model, the database, the Python service
//   GET  /system/backups                     settings, folder check, the list, the password's state, warnings
//   PUT  /system/backup-settings             { folder?, daily?, keep? }
//   POST /system/backups                     Back up now: both files
//   GET  /system/backups/:name/download      one file of the folder
//   POST /system/restore/upload              the raw .isbak (application/octet-stream) -> { upload }
//   POST /system/restore/preview             { name | upload, password } -> the summary
//   POST /system/restore                     { name | upload, password, confirm: 'RESTORE' }
//   PUT  /system/backup-password             { loginPassword, next, confirm }
//   GET  /system/warnings                    the dashboard's lines
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { execFileSync } = require('child_process');
const { actorOf } = require('../utils/actor');
const S = require('../backup/settings');
const svc = require('../backup/service');
const ops = require('../backup/operations');
const sched = require('../backup/scheduler');
const activity = require('../backup/activity');
const IDLE_WORDS = (m) => (m === 'never' ? 'never close by itself' : `close after ${m} minutes without use`);

const fail = (res, err, fallback) => {
  if (err?.plain) {
    const status = { WRONG_PASSWORD: 400, BACKUP_DAMAGED: 400, BACKUP_TOO_NEW: 400, PASSWORD_REFUSED: 400, FOLDER: 409, BUSY: 409, NOT_FOUND: 404, RESTORE_ROLLED_BACK: 500, ROLLBACK_FAILED: 500, SAFETY_FAILED: 500, NO_SPACE: 409 }[err.code] || 400;
    return res.status(status).json({ success: false, code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) });
  }
  console.error('[System]', err?.message);
  return res.status(500).json({ success: false, message: fallback });
};

// ---------------------------------------------------------------- About
let gitFacts = null;
const commitFacts = () => {
  if (gitFacts) return gitFacts;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%h|%cI'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
    const [commit, date] = out.split('|');
    gitFacts = { commit, date };
  } catch { gitFacts = { commit: null, date: null }; }
  return gitFacts;
};

exports.about = async (req, res) => {
  try {
    const dbConn = mongoose.connection.db;
    const stats = await dbConn.stats();
    const counts = {};
    for (const name of svc.MAIN_COLLECTIONS) counts[name] = await dbConn.collection(name).countDocuments({});
    const meta = svc.readModelMeta();
    let python = { status: 'Offline' };
    try {
      const axios = require('axios');
      const r = await axios.get(`${require('../config/mlClient').BASE_URL}/api/health`, { timeout: 3000 });
      python = { status: r.data?.status === 'online' ? 'Online' : 'Standby' };
    } catch { /* Offline */ }
    const facts = commitFacts();
    res.status(200).json({
      success: true,
      app: { version: svc.APP_VERSION, commit: facts.commit, date: facts.date },
      model: meta ? {
        version: meta.engine4?.version || [meta.phase, meta.model_type].filter(Boolean).join(' · ') || 'Unknown',
        date: meta.engine4?.retrained_at || meta.engine4?.retrainedAt || meta.trained_at || null,
        retrained: Boolean(meta.engine4)
      } : null,
      database: { name: mongoose.connection.name, sizeBytes: stats.storageSize ?? stats.dataSize ?? null, counts },
      python
    });
  } catch (err) { fail(res, err, 'The system facts could not be read. Try again.'); }
};

// ---------------------------------------------------------------- the backups
const passwordState = (pw) => ({ isDefault: pw.isDefault, setOn: pw.setOn || null, fallback: pw.fallback });

exports.backups = async (req, res) => {
  try {
    const settings = await S.getSettings();
    const folder = S.checkFolder(settings.folder);
    const pw = await S.currentPassword(settings);
    res.status(200).json({
      success: true,
      settings: { folder: settings.folder, folderIsDefault: settings.folderIsDefault, daily: settings.daily !== false, keep: settings.keep || S.KEEP_RANGE.default, keepRange: S.KEEP_RANGE, idleMinutes: activity.IDLE_CHOICES.includes(settings.idleMinutes) ? settings.idleMinutes : activity.IDLE_DEFAULT, idleChoices: activity.IDLE_CHOICES },
      folder: { exists: folder.exists, writable: folder.writable, problem: folder.problem },
      // Phase 12.1 (decision 5): the optional second folder and whether the last copy reached it.
      secondFolder: settings.secondFolder ? { path: settings.secondFolder, problem: settings.secondFolderProblem?.message || null } : null,
      password: passwordState(pw),
      lastSuccess: settings.lastSuccess || null,
      lastFailure: settings.lastFailure?.at ? settings.lastFailure : null,
      busy: ops.isBusy(),
      files: svc.listFolder(settings.folder),
      warnings: sched.warningsOf({ settings, password: pw, folder })
    });
  } catch (err) { fail(res, err, 'The backups could not be listed. Try again.'); }
};

exports.updateSettings = async (req, res) => {
  try {
    const { folder, daily, keep, idleMinutes, secondFolder } = req.body || {};
    const set = {};
    const changes = [];
    if (folder !== undefined) {
      const text = String(folder ?? '').trim();
      if (text && !path.isAbsolute(text)) return res.status(400).json({ success: false, field: 'folder', message: S.checkFolder('').problem });
      const target = text ? path.resolve(text) : null;
      if (target) {
        const check = S.checkFolder(target);
        if (!check.writable) return res.status(400).json({ success: false, field: 'folder', message: check.problem });
      }
      set.folder = target;
      changes.push(`the folder to ${target || `the default (${S.defaultFolder()})`}`);
    }
    if (daily !== undefined) {
      if (typeof daily !== 'boolean') return res.status(400).json({ success: false, field: 'daily', message: 'Choose on or off.' });
      set.daily = daily;
      changes.push(`the daily backup ${daily ? 'on' : 'off'}`);
    }
    if (keep !== undefined) {
      const n = Number(keep);
      if (!Number.isInteger(n) || n < S.KEEP_RANGE.min || n > S.KEEP_RANGE.max) return res.status(400).json({ success: false, field: 'keep', message: `Keep ${S.KEEP_RANGE.min} to ${S.KEEP_RANGE.max} backups.` });
      set.keep = n;
      changes.push(`keep ${n} backups`);
    }
    // Phase 12.1 (decision 5): "Also copy backups to (optional)": a folder that can be written now (a
    // USB stick, a Google Drive for desktop folder), or empty for none.
    if (secondFolder !== undefined) {
      const text = String(secondFolder ?? '').trim();
      if (text && !path.isAbsolute(text)) return res.status(400).json({ success: false, field: 'secondFolder', message: S.checkFolder('').problem });
      const target = text ? path.resolve(text) : null;
      if (target) {
        const now = await S.getSettings();
        if (path.resolve(now.folder).toLowerCase() === target.toLowerCase()) return res.status(400).json({ success: false, field: 'secondFolder', message: 'Choose a folder other than the backup folder.' });
        const check = S.checkFolder(target);
        if (!check.writable) return res.status(400).json({ success: false, field: 'secondFolder', message: check.problem });
      }
      set.secondFolder = target;
      set.secondFolderProblem = null;
      changes.push(target ? `the second folder to ${target}` : 'no second folder');
    }
    // Phase 12.1 (decision 4): how long IntelliSched waits without use before it backs up and closes.
    if (idleMinutes !== undefined) {
      const choice = idleMinutes === 'never' ? 'never' : Number(idleMinutes);
      if (!activity.IDLE_CHOICES.includes(choice)) return res.status(400).json({ success: false, field: 'idleMinutes', message: 'Choose 30, 60 or 120 minutes, or never.' });
      set.idleMinutes = choice;
      changes.push(IDLE_WORDS(choice));
    }
    if (!changes.length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    const before = await S.getSettings();
    await S.updateSettings(set);
    await ops.audit('Backup settings changed', 'Backup', `Set ${changes.join(', ')} (was: folder ${before.folder}, daily ${before.daily !== false ? 'on' : 'off'}, keep ${before.keep || S.KEEP_RANGE.default}).`, actorOf(req));
    const after = await S.getSettings();
    res.status(200).json({ success: true, message: 'Saved.', settings: { folder: after.folder, folderIsDefault: after.folderIsDefault, daily: after.daily !== false, keep: after.keep, idleMinutes: activity.IDLE_CHOICES.includes(after.idleMinutes) ? after.idleMinutes : activity.IDLE_DEFAULT } });
  } catch (err) { fail(res, err, 'The settings could not be saved. Try again.'); }
};

exports.backUpNow = async (req, res) => {
  try {
    const made = await ops.backUpBoth({ actor: actorOf(req), reason: 'manual' });
    res.status(201).json({ success: true, message: 'Backup made.', ...made });
  } catch (err) { fail(res, err, err?.recorded || 'The backup could not be made. Try again.'); }
};

exports.download = async (req, res) => {
  try {
    const { file } = await ops.readFolderFile(req.params.name);
    res.status(200);
    res.setHeader('Content-Type', file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
    fs.createReadStream(file).pipe(res);
  } catch (err) { fail(res, err, 'The file could not be read.'); }
};

// ---------------------------------------------------------------- restore
// An uploaded file waits in the system's temp folder under a random id (an hour at most).
const UPLOADS = path.join(os.tmpdir(), 'intellisched-restore-uploads');
const MAX_UPLOAD = 512 * 1024 * 1024;
const cleanUploads = () => {
  try {
    for (const n of fs.readdirSync(UPLOADS)) {
      const f = path.join(UPLOADS, n);
      if (Date.now() - fs.statSync(f).mtimeMs > 3600 * 1000) fs.rmSync(f, { force: true });
    }
  } catch { /* none yet */ }
};
exports.upload = async (req, res) => {
  try {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ success: false, message: 'Choose an .isbak file.' });
    try { require('../backup/backupFile').readHeader(body); } catch (err) { return fail(res, err, 'This file is not an IntelliSched backup.'); }
    fs.mkdirSync(UPLOADS, { recursive: true });
    cleanUploads();
    const id = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(UPLOADS, `${id}.isbak`), body);
    const { header } = require('../backup/backupFile').readHeader(body);
    res.status(201).json({ success: true, upload: id, createdAt: header.createdAt, passwordSetOn: header.passwordSetOn || null });
  } catch (err) { fail(res, err, 'The file could not be uploaded. Try again.'); }
};
const chosenFile = async (body) => {
  if (body?.upload) {
    if (!/^[a-f0-9]{24}$/.test(String(body.upload))) throw Object.assign(new Error('Upload the file again.'), { plain: true, code: 'NOT_FOUND' });
    const file = path.join(UPLOADS, `${body.upload}.isbak`);
    if (!fs.existsSync(file)) throw Object.assign(new Error('The uploaded file has expired. Upload it again.'), { plain: true, code: 'NOT_FOUND' });
    return { buffer: fs.readFileSync(file), fileName: 'an uploaded file' };
  }
  const { file, buffer } = await ops.readFolderFile(String(body?.name || ''));
  return { buffer, fileName: path.basename(file) };
};
exports.preview = async (req, res) => {
  try {
    const { buffer } = await chosenFile(req.body);
    res.status(200).json({ success: true, summary: await ops.previewRestore(buffer, req.body?.password ?? '') });
  } catch (err) { fail(res, err, 'The backup could not be read.'); }
};
exports.restore = async (req, res) => {
  try {
    if (req.body?.confirm !== 'RESTORE') return res.status(400).json({ success: false, field: 'confirm', message: 'Type RESTORE to confirm.' });
    const { buffer, fileName } = await chosenFile(req.body);
    const result = await ops.restore(buffer, req.body?.password ?? '', { actor: actorOf(req), fileName });
    if (req.body?.upload) fs.rmSync(path.join(UPLOADS, `${req.body.upload}.isbak`), { force: true });
    res.status(200).json({ success: true, message: 'Restored. Everyone signs in again.', ...result });
  } catch (err) { fail(res, err, 'The restore could not run.'); }
};

// ---------------------------------------------------------------- the password and the warnings
exports.changePassword = async (req, res) => {
  try {
    const { loginPassword, next, confirm } = req.body || {};
    const { setOn } = await ops.changePassword({ userId: req.user?._id, loginPassword, next, confirm, actor: actorOf(req) });
    res.status(200).json({ success: true, message: 'Backup password changed. Backups made before today still need the old password.', password: { isDefault: false, setOn } });
  } catch (err) { fail(res, err, 'The password could not be changed. Try again.'); }
};

exports.warnings = async (req, res) => {
  try {
    res.status(200).json({ success: true, warnings: await sched.warnings() });
  } catch (err) { fail(res, err, 'The backup warnings could not be read.'); }
};
