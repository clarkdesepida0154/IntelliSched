// Phase 11.3: what the System page, the daily timer and the approval hook call. Every backup and every
// failure is written to the Audit Trail (category "System"); a password never is.
//   fullBackup({ actor, reason })      one encrypted .isbak in the folder; the retention runs after
//   readableCopy({ actor, reason })    one readable .zip in the folder
//   backUpBoth({ actor, reason })      both; a failure is recorded (lastFailure) and thrown
//   previewRestore(file, password)     opens and checks a backup, changes nothing: the summary
//   restore(file, password, { actor }) decision 5: the safety backup, the replace, the automatic
//                                      rollback, the count check, the audit row after, sign-out
// One operation at a time (a backup during a restore would read half-restored data).
const fs = require('fs');
const path = require('path');
const AuditEvent = require('../models/AuditEvent');
const { systemActor } = require('../utils/actor');
const S = require('./settings');
const svc = require('./service');
const { BackupFileError } = require('./backupFile');
const sessions = require('./sessions');

let busy = null;
const exclusive = async (what, fn) => {
  if (busy) throw new BackupFileError('BUSY', `A ${busy} is running. Try again in a minute.`);
  busy = what;
  try { return await fn(); } finally { busy = null; }
};
const isBusy = () => busy;

const audit = async (action, target, detail, actor) => {
  try {
    await AuditEvent.create({ action, category: 'System', target, detail, actor: actor || systemActor(), at: new Date() });
  } catch (err) {
    console.error('[Backup] The Audit Trail entry could not be written:', err.message);
  }
};

const REASON_WORDS = { manual: 'Back up now', daily: 'the daily backup', approval: 'after an approval', 'before-restore': 'the safety backup before a restore', closing: 'the closing backup', unclean: 'the backup after IntelliSched was not closed properly' };

const folderReady = (settings) => {
  const check = S.checkFolder(settings.folder);
  if (!check.writable) throw new BackupFileError('FOLDER', `The backup folder cannot be written: ${check.problem}`);
  return settings.folder;
};

// One full backup into the folder. Returns { name, file, size, counts }.
const writeFull = async ({ reason = 'manual', settings = null, password = null } = {}) => {
  const s = settings || await S.getSettings();
  const folder = folderReady(s);
  const pw = password || await S.currentPassword(s);
  const now = new Date();
  const { entries, manifest } = await svc.buildFullPayload({ passwordSetOn: pw.setOn, now, kind: reason === 'before-restore' ? 'before-restore' : 'full' });
  const sealed = svc.sealBackup(svc.zipSync(entries), pw.password, {
    passwordSetOn: manifest.passwordSetOn, createdAt: manifest.createdAt, appVersion: manifest.appVersion,
    schemaVersion: manifest.schemaVersion, dbName: manifest.dbName, kind: manifest.kind
  });
  const name = svc.uniqueName(folder, `IntelliSched-backup_${svc.stamp(now)}${reason === 'before-restore' ? '_before-restore' : ''}`, '.isbak');
  // A safety backup's name carries the suffix after any "-2" the clash rule adds.
  const finalName = reason === 'before-restore' && !/_before-restore\.isbak$/.test(name) ? name.replace(/(-\d+)\.isbak$/, '_before-restore$1.isbak') : name;
  const file = path.join(folder, finalName);
  svc.writeAtomically(file, sealed);
  svc.applyRetention(folder, s.keep);
  return { name: finalName, file, size: sealed.length, counts: manifest.counts, manifest };
};

const writeReadable = async ({ settings = null } = {}) => {
  const s = settings || await S.getSettings();
  const folder = folderReady(s);
  const now = new Date();
  const { entries } = await svc.buildReadablePayload({ withPdf: process.env.BACKUP_READABLE_PDF !== '0' });
  const zip = svc.zipSync(entries);
  const name = svc.uniqueName(folder, `IntelliSched-readable_${svc.stamp(now)}`, '.zip');
  svc.writeAtomically(path.join(folder, name), zip);
  svc.applyRetention(folder, s.keep);
  return { name, file: path.join(folder, name), size: zip.length, files: entries.map(e => e.name) };
};

const recordFailure = async (reason, err, actor) => {
  const message = err?.plain ? err.message : 'The backup could not be made.';
  if (!err?.plain) console.error('[Backup] failed:', err?.message);
  await S.updateSettings({ lastFailure: { at: new Date(), message, reason } });
  await audit('Backup failed', 'Backup', `${REASON_WORDS[reason] || reason}: ${message}`, actor);
  return message;
};

// Phase 12.1 (decision 8): before every backup, at least 3 times the last backup's size must be free
// in the folder's drive (the last full backup and readable copy together); otherwise the backup is
// skipped and the failure says why. `space.freeBytes` is replaced by the tests.
const space = {
  freeBytes: (folder) => {
    try {
      const st = fs.statfsSync(folder);
      return Number(st.bavail) * Number(st.bsize);
    } catch { return null; }
  }
};
const checkSpace = (folder) => {
  const list = svc.listFolder(folder);
  const lastFull = list.find(e => e.kind === 'full');
  const lastReadable = list.find(e => e.kind === 'readable');
  const need = 3 * ((lastFull?.size || 0) + (lastReadable?.size || 0));
  if (!need) return;
  const free = space.freeBytes(folder);
  if (free !== null && free < need) throw new BackupFileError('NO_SPACE', 'Not enough free space for a backup. Free some space on the backup folder\'s drive, then press Back up now.');
};

// Phase 12.1 (decision 5): the optional second folder (a USB stick, or a Google Drive for desktop
// folder, which Google's own app uploads). After each backup both files are copied there, with any
// earlier backup the folder missed (caught up), and the folder keeps its own newest 30 / 10. A folder
// that can't be reached never fails the backup: the problem is stored and warned about, and the copy
// is tried again at the next backup. IntelliSched itself never uploads anything.
const copyToSecond = async (settings) => {
  const second = settings.secondFolder;
  if (!second) return { copied: [], skipped: true };
  try {
    if (!fs.existsSync(second) || !fs.statSync(second).isDirectory()) throw new Error('missing');
    const there = new Set(fs.readdirSync(second));
    const copied = [];
    const local = svc.listFolder(settings.folder).filter(e => e.kind !== 'before-restore');
    for (const e of local) {
      if (there.has(e.name)) continue;
      const tmp = path.join(second, `${e.name}.copying`);
      fs.copyFileSync(path.join(settings.folder, e.name), tmp);
      fs.renameSync(tmp, path.join(second, e.name));
      copied.push(e.name);
    }
    svc.applyRetention(second, settings.keep);
    if (settings.secondFolderProblem) await S.updateSettings({ secondFolderProblem: null });
    return { copied };
  } catch (err) {
    console.error('[Backup] the second folder:', err.message);
    await S.updateSettings({ secondFolderProblem: { at: new Date(), message: SECOND_FOLDER_PROBLEM } });
    return { copied: [], problem: SECOND_FOLDER_PROBLEM };
  }
};
const SECOND_FOLDER_PROBLEM = "The second backup folder can't be reached.";

// Both files. Returns { full, readable }; on a failure records it and throws.
const backUpBoth = ({ actor = null, reason = 'manual' } = {}) => exclusive('backup', async () => {
  try {
    const settings = await S.getSettings();
    checkSpace(folderReady(settings));
    const full = await writeFull({ reason, settings });
    const readable = await writeReadable({ settings });
    await S.updateSettings({ lastSuccess: new Date(), lastFailure: null });
    await audit('Backup made', 'Backup', `${REASON_WORDS[reason] || reason}: ${full.name} and ${readable.name}`, actor);
    const second = await copyToSecond(settings);
    if (second.problem) await audit('Backup copy failed', 'Backup', `${full.name} and ${readable.name} stay in the backup folder. ${second.problem} The copy is tried again at the next backup.`, actor);
    return { full: { name: full.name, size: full.size }, readable: { name: readable.name, size: readable.size }, secondFolder: second.skipped ? null : { copied: second.copied.length, problem: second.problem || null } };
  } catch (err) {
    err.recorded = await recordFailure(reason, err, actor);
    throw err;
  }
});

// Phase 12.1 (decision 4): the closing backup (IntelliSched closes itself after a while without use,
// or "Stop IntelliSched") and the backup at the start after an unclean end both run only when data
// changed since the last successful backup. Returns { result: 'unchanged' | 'ran' | 'failed', ... };
// never throws (a failure is recorded by backUpBoth).
const backupIfChanged = async ({ reason = 'closing', actor = null } = {}) => {
  const activity = require('./activity');
  if (!(await activity.changedSinceLastBackup())) return { result: 'unchanged' };
  try {
    return { result: 'ran', ...(await backUpBoth({ actor, reason })) };
  } catch (err) {
    return { result: 'failed', message: err.recorded || (err.plain ? err.message : 'The backup could not be made.') };
  }
};

// The summary before a restore: the backup's date, terms and counts beside the database's now.
const previewRestore = async (file, password) => {
  const { manifest } = svc.openFullBackup(file, password);
  const now = await svc.contentChecksum();
  const names = [...new Set([...svc.MAIN_COLLECTIONS.filter(n => n in manifest.counts || n in now)])];
  return {
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    dbName: manifest.dbName,
    terms: manifest.terms || [],
    passwordSetOn: manifest.passwordSetOn,
    model: manifest.model || [],
    counts: names.map(name => ({ collection: name, backup: manifest.counts[name] ?? 0, current: now[name]?.count ?? 0 })),
    collections: Object.keys(manifest.counts).length
  };
};

// Decision 5: restore one backup. hooks.beforeCollection is for the tests (a failure halfway).
const restore = (file, password, { actor = null, fileName = 'an uploaded file', hooks = {} } = {}) => exclusive('restore', async () => {
  const opened = svc.openFullBackup(file, password);          // refuses a wrong password, damage, a newer version
  const settings = await S.getSettings();
  const current = await S.currentPassword(settings);
  // The safety backup of the current state, with the current backup password, kept in memory too so
  // the rollback never depends on reading the folder again.
  const { entries, manifest } = await svc.buildFullPayload({ passwordSetOn: current.setOn, kind: 'before-restore' });
  const safetyFiles = new Map(entries.map(e => [e.name, e.data]));
  let safety;
  try {
    safety = await writeFull({ reason: 'before-restore', settings, password: current });
  } catch (err) {
    await recordFailure('before-restore', err, actor);
    throw new BackupFileError('SAFETY_FAILED', `The safety backup could not be made, so nothing was restored. ${err.plain ? err.message : ''}`.trim());
  }
  try {
    await svc.replaceAll(opened, hooks);
  } catch (err) {
    console.error('[Backup] restore failed, rolling back:', err.message);
    try {
      await svc.replaceAll({ manifest, files: safetyFiles });
    } catch (rollbackErr) {
      console.error('[Backup] ROLLBACK FAILED:', rollbackErr.message);
      await audit('Restore failed', 'Backup', `${fileName}: the restore failed and the automatic rollback failed too. Restore ${safety.name} by hand.`, actor);
      throw new BackupFileError('ROLLBACK_FAILED', `The restore failed, and putting the data back failed too. Restore ${safety.name} from the backup folder.`);
    }
    await audit('Restore failed', 'Backup', `${fileName}: the restore failed; the data before it was put back from ${safety.name}.`, actor);
    throw new BackupFileError('RESTORE_ROLLED_BACK', `The restore failed, so the data was put back as it was (from ${safety.name}). Nothing changed.`);
  }
  // Written after the restore, so the entry survives it.
  await audit('Backup restored', 'Backup', `${fileName} (made ${opened.manifest.createdAt}) was restored. Safety backup: ${safety.name}.`, actor);
  await sessions.endAllSessions();
  return { restored: fileName, createdAt: opened.manifest.createdAt, safety: safety.name, collections: Object.keys(opened.manifest.counts).length, modelRestored: (opened.manifest.model || []).length > 0 };
});

// Decision 6: the Dean changes the backup password with his own login password. New backups use the
// new one; old backups keep theirs. Returns { setOn }; throws a plain refusal with a `field`.
const changePassword = async ({ userId, loginPassword, next, confirm, actor = null }) => {
  const User = require('../models/User');
  const refuse = (field, message) => Object.assign(new BackupFileError('PASSWORD_REFUSED', message), { field });
  const user = userId && require('mongoose').isValidObjectId(userId) ? await User.findById(userId).select('+password') : null;
  if (!user || !loginPassword || !(await user.matchPassword(String(loginPassword)))) throw refuse('loginPassword', 'That is not your sign-in password.');
  const problem = S.passwordProblem(next, confirm);
  if (problem) throw refuse(problem.includes('same') ? 'confirm' : 'next', problem);
  const setOn = await S.storePassword(String(next));
  await audit('Backup password changed', 'Backup', 'The backup password was changed. New backups use it; backups made before keep their own password.', actor);
  return { setOn };
};

const readFolderFile = async (name) => {
  if (!svc.FULL_RE.test(name) && !svc.READABLE_RE.test(name)) throw new BackupFileError('NOT_FOUND', 'That file is not a backup in the folder.');
  const settings = await S.getSettings();
  const file = path.join(settings.folder, path.basename(name));
  if (!fs.existsSync(file)) throw new BackupFileError('NOT_FOUND', 'That backup is no longer in the folder.');
  return { file, buffer: fs.readFileSync(file) };
};

module.exports = { space, copyToSecond, SECOND_FOLDER_PROBLEM, changePassword, backUpBoth, backupIfChanged, writeFull, writeReadable, previewRestore, restore, readFolderFile, audit, isBusy, recordFailure };
