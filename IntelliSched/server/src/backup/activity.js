// Phase 12.1 (decision 4): IntelliSched runs only while someone uses it.
//   - track: the time of the last REAL user request (any /api request except the health route, the
//     live-update feed and requests marked X-IntelliSched-Not-User, which the kit's self-test and
//     supervisor send). The kit's supervisor reads it on the health route and closes IntelliSched after
//     the System setting's minutes without use (30 / 60 / 120 or never; default 60).
//   - the days IntelliSched was used (system_settings.daysUsed, local dates): the "no backup" warning
//     counts only those, so a quiet month never nags.
//   - dataChanged: every successful write stamps system_settings.lastDataChangeAt, so the closing
//     backup (and the backup after an unclean end) runs only when data changed since the last backup.
// system_settings is this computer's own document: never in a backup, never replaced by a restore.
const S = require('./settings');

const IDLE_CHOICES = [30, 60, 120, 'never'];
const IDLE_DEFAULT = 60;
const NOT_USER_HEADER = 'x-intellisched-not-user';
const NOT_COUNTED = new Set(['/health', '/changes']);

const startedAt = Date.now();
let lastUserRequestAt = startedAt;
let lastDayMarked = null;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const markDayUsed = async (date = localDate()) => {
  if (lastDayMarked === date || require('mongoose').connection.readyState !== 1) return;
  lastDayMarked = date;
  try {
    await S.addDayUsed(date);
  } catch (err) {
    lastDayMarked = null;
    console.error('[Activity] the day could not be recorded:', err.message);
  }
};

// Express middleware, mounted on /api before the sign-in check (a sign-in is use too).
const track = (req, res, next) => {
  if (!NOT_COUNTED.has(req.path) && !req.get(NOT_USER_HEADER)) {
    lastUserRequestAt = Date.now();
    markDayUsed();
  }
  next();
};

// After a successful write (utils/changeFeed.js trackWrites).
const dataChanged = (at = new Date()) => {
  if (require('mongoose').connection.readyState !== 1) return;
  S.updateSettings({ lastDataChangeAt: at }).catch(err => console.error('[Activity] the change time could not be recorded:', err.message));
};

// The minutes without use before IntelliSched closes itself: the System setting, or
// INTELLISCHED_IDLE_MINUTES (the kit's tests only).
const idleMinutesOf = (settings) => {
  const forced = process.env.INTELLISCHED_IDLE_MINUTES;
  if (forced) return forced === 'never' ? 'never' : Number(forced);
  return IDLE_CHOICES.includes(settings?.idleMinutes) ? settings.idleMinutes : IDLE_DEFAULT;
};

// What the health route tells the supervisor.
const state = async () => {
  let idleMinutes = IDLE_DEFAULT;
  try { idleMinutes = idleMinutesOf(await S.getSettings()); } catch { /* the default */ }
  return { lastUserRequestAt: new Date(lastUserRequestAt).toISOString(), startedAt: new Date(startedAt).toISOString(), idleMinutes };
};

// Whether data changed since the last successful backup: the newest Audit Trail entry (other than the
// backups' own rows) or the last write, after lastSuccess. Never backed up: changed.
const changedSinceLastBackup = async (settings = null) => {
  const s = settings || await S.getSettings();
  const last = s.lastSuccess ? new Date(s.lastSuccess) : null;
  if (!last) return true;
  if (s.lastDataChangeAt && new Date(s.lastDataChangeAt) > last) return true;
  const AuditEvent = require('../models/AuditEvent');
  const newest = await AuditEvent.findOne({ $nor: [{ category: 'System', target: 'Backup' }] }).sort({ at: -1 }).select('at').lean();
  return Boolean(newest?.at && new Date(newest.at) > last);
};

// For the tests.
const _reset = () => { lastUserRequestAt = Date.now(); lastDayMarked = null; };
const _lastUserRequestAt = () => lastUserRequestAt;

module.exports = { IDLE_CHOICES, IDLE_DEFAULT, NOT_USER_HEADER, track, dataChanged, markDayUsed, idleMinutesOf, state, changedSinceLastBackup, localDate, _reset, _lastUserRequestAt };
