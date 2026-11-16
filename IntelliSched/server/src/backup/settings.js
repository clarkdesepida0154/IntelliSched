// Phase 11.3: the backup settings (decisions 3 and 6) and the backup password's storage.
//   - the folder: default <the user's Documents>\IntelliSched Backups; for a throwaway "_test" database
//     (the demos, the E2E stack) .demo-data/system-backups/<db>/ instead, so a practice run never
//     writes into the person's Documents (decision taken without the team);
//   - the automatic daily backup (default on) and how many full backups to keep (default 30, 5-100);
//   - the backup password: "intellisched" until the Dean changes it. The current one is stored SEALED
//     (AES-256-GCM, the key derived by scrypt from the server's own JWT_SECRET), never in plain text
//     and never logged. When the stored one cannot be opened (the server secret changed: a fresh
//     install), the default is used again and the reminder shows.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const SystemSetting = require('../models/SystemSetting');

const DEFAULT_PASSWORD = 'intellisched';
const KEEP_RANGE = { min: 5, max: 100, default: 30 };
const SETTINGS_KEY = 'backup';
const REPO = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------- the sealed password
let boxKeyCache = null;
const boxKey = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('The server secret is not set.');
  if (!boxKeyCache || boxKeyCache.secret !== secret) {
    boxKeyCache = { secret, key: crypto.scryptSync(secret, 'intellisched-backup-password-box', 32) };
  }
  return boxKeyCache.key;
};
const sealText = (text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', boxKey(), iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
};
const openText = (sealed) => {
  const raw = Buffer.from(String(sealed || '').replace(/^v1:/, ''), 'base64');
  if (raw.length < 29) throw new Error('Not a sealed value.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', boxKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
};

// ---------------------------------------------------------------- the folder
const isTestDb = (name) => typeof name === 'string' && name.endsWith('_test');
const dbNameNow = () => mongoose.connection?.name || null;
const defaultFolder = (dbName = dbNameNow()) => (isTestDb(dbName)
  ? path.join(REPO, '.demo-data', 'system-backups', dbName)
  : path.join(os.homedir(), 'Documents', 'IntelliSched Backups'));

// Whether a folder exists (or can be made) and can be written: { exists, writable, problem }.
const checkFolder = (folder, { create = true } = {}) => {
  const out = { folder, exists: false, writable: false, problem: null };
  if (!folder || !path.isAbsolute(folder)) return { ...out, problem: 'Type the whole path of a folder, for example C:\\Users\\Dean\\Documents\\IntelliSched Backups.' };
  try {
    if (create) fs.mkdirSync(folder, { recursive: true });
    out.exists = fs.existsSync(folder) && fs.statSync(folder).isDirectory();
    if (!out.exists) return { ...out, problem: 'That folder does not exist.' };
    const probe = path.join(folder, `.write-check-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    out.writable = true;
  } catch (err) {
    out.problem = out.exists ? 'IntelliSched cannot write to that folder. Choose another folder, or ask for write access.' : 'That folder could not be created. Check the path.';
  }
  return out;
};

// ---------------------------------------------------------------- the settings document
const getSettings = async () => {
  const doc = await SystemSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $setOnInsert: { key: SETTINGS_KEY, daily: true, keep: KEEP_RANGE.default } },
    { upsert: true, new: true, lean: true }
  );
  return { ...doc, folder: doc.folder || defaultFolder(), folderIsDefault: !doc.folder };
};
const updateSettings = (set) => SystemSetting.updateOne({ key: SETTINGS_KEY }, { $set: set }, { upsert: true });
// Phase 12.1 (decision 4): one local date ("2026-11-16") on which IntelliSched was used.
const addDayUsed = (date) => SystemSetting.updateOne({ key: SETTINGS_KEY }, { $addToSet: { daysUsed: date } }, { upsert: true });

// The backup password now: { password, setOn, isDefault, fallback } (fallback: a stored one could not
// be opened, so the default is used). The password itself never leaves the gateway.
const currentPassword = async (settings = null) => {
  const s = settings || await getSettings();
  if (!s.password?.sealed || s.password.isDefault) return { password: DEFAULT_PASSWORD, setOn: s.password?.setOn || null, isDefault: true, fallback: false };
  try {
    return { password: openText(s.password.sealed), setOn: s.password.setOn || null, isDefault: false, fallback: false };
  } catch {
    return { password: DEFAULT_PASSWORD, setOn: null, isDefault: true, fallback: true };
  }
};

// The rule for a new backup password; returns the plain refusal or null.
const passwordProblem = (next, confirm) => {
  const text = String(next ?? '');
  if (text.length < 8) return 'Use at least 8 characters.';
  if (text === DEFAULT_PASSWORD) return 'Choose a password other than the default.';
  if (confirm !== undefined && text !== String(confirm ?? '')) return 'The two new passwords are not the same.';
  return null;
};
const storePassword = async (next, setOn = new Date()) => {
  await updateSettings({ password: { sealed: sealText(next), setOn, isDefault: false } });
  return setOn;
};

module.exports = {
  DEFAULT_PASSWORD, KEEP_RANGE, SETTINGS_KEY,
  sealText, openText, defaultFolder, checkFolder, isTestDb,
  getSettings, updateSettings, addDayUsed, currentPassword, passwordProblem, storePassword
};
