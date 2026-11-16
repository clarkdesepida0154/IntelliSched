// Phase 11.3 (decisions 4 and 7): when backups happen, and the Dean's warnings.
//   - daily (when on): at the first check after 12:00 noon local time; the gateway checks every 10
//     minutes while it runs (and once soon after it starts), so a noon missed while the PC was off is
//     made up at the next start. Never twice in one day: the day is marked before the backup runs, and
//     a failure is recorded and warned about, not retried every 10 minutes.
//   - after every approval: a full backup and a readable copy, after the approval is saved; a failure
//     never undoes the approval (it is recorded and shown).
// A plain timer (no scheduler package); BACKUP_TIMER=off switches it off (the tests never start it).
const S = require('./settings');
const ops = require('./operations');

const CHECK_EVERY_MS = 10 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;
const NOON = 12;
const STALE_DAYS = 3;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dailyDue = (settings, now) => Boolean(settings.daily) && now.getHours() >= NOON && settings.lastDailyDate !== localDate(now);

// One check. Returns 'ran' | 'failed' | 'not-due' | 'busy'.
const tick = async ({ now = new Date(), run = ops.backUpBoth } = {}) => {
  const settings = await S.getSettings();
  if (!dailyDue(settings, now)) return 'not-due';
  if (ops.isBusy()) return 'busy';
  await S.updateSettings({ lastDailyDate: localDate(now) });
  try {
    await run({ reason: 'daily' });
    return 'ran';
  } catch {
    return 'failed';      // recorded by backUpBoth (lastFailure + the Audit Trail)
  }
};

let timer = null;
const start = () => {
  if (process.env.BACKUP_TIMER === 'off' || timer) return null;
  const safeTick = () => tick().catch(err => console.error('[Backup] the daily check failed:', err.message));
  const first = setTimeout(safeTick, FIRST_CHECK_MS);
  timer = setInterval(safeTick, CHECK_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return timer;
};
const stop = () => { if (timer) clearInterval(timer); timer = null; };

// After an approval was saved: both files; never thrown back at the approval.
const afterApproval = async (actor, { run = ops.backUpBoth } = {}) => {
  try {
    await run({ actor, reason: 'approval' });
    return 'ran';
  } catch (err) {
    console.error('[Backup] the backup after the approval failed:', err?.plain ? err.message : 'see the Audit Trail');
    return 'failed';
  }
};

// The Dean's warnings (one line each, with the page to fix them): [{ code, text, fix }].
const FIX = '#/system';
const warningsOf = ({ settings, password, folder }, now = new Date()) => {
  const out = [];
  const last = settings.lastSuccess ? new Date(settings.lastSuccess) : null;
  if (!last) out.push({ code: 'NO_BACKUP', text: 'No full backup has been made yet.', fix: FIX });
  else if (Array.isArray(settings.daysUsed)) {
    // Phase 12.1 (decision 4): IntelliSched runs only while in use, so only the days it was used count;
    // a quiet month never nags.
    const used = settings.daysUsed.filter(d => d > localDate(last)).length;
    if (used > STALE_DAYS) out.push({ code: 'BACKUP_OLD', text: `No backup on the last ${used} days IntelliSched was used.`, fix: FIX });
  } else if (now - last > STALE_DAYS * 24 * 3600 * 1000) out.push({ code: 'BACKUP_OLD', text: `No backup for ${Math.floor((now - last) / (24 * 3600 * 1000))} days.`, fix: FIX });
  if (folder && !folder.writable) out.push({ code: 'FOLDER', text: 'The backup folder cannot be written.', fix: FIX });
  const failed = settings.lastFailure?.at ? new Date(settings.lastFailure.at) : null;
  if (failed && (!last || failed > last)) out.push({ code: 'LAST_FAILED', text: `The last backup failed: ${settings.lastFailure.message}`, fix: FIX });
  if (password?.isDefault) out.push({ code: 'DEFAULT_PASSWORD', text: 'Change the backup password.', fix: FIX });
  // Phase 12.1 (decision 5): the second folder (a USB stick not plugged in, Google Drive not running).
  if (settings.secondFolder && settings.secondFolderProblem) out.push({ code: 'SECOND_FOLDER', text: "The second backup folder can't be reached.", fix: FIX });
  // Phase 12.1 (decision 8): a PC clock before the newest backup or the build date. Backups still work.
  const clock = clockProblem(settings, now);
  if (clock) out.push({ code: 'CLOCK', text: clock, fix: FIX });
  return out;
};

// The newest date the PC's clock must not be before: the last backup, or this version's build date.
const buildDate = () => {
  try {
    const info = require('../../build-info.json');
    return info.builtAt ? new Date(info.builtAt) : null;
  } catch { return null; }
};
const clockProblem = (settings, now = new Date(), built = buildDate()) => {
  const marks = [settings.lastSuccess ? ['the newest backup was made on', new Date(settings.lastSuccess)] : null, built ? ['this version was built on', built] : null].filter(Boolean);
  const late = marks.filter(([, at]) => at - now > 60 * 60 * 1000).sort((a, b) => b[1] - a[1])[0];
  if (!late) return null;
  return `This computer's date looks wrong (it says ${localDate(now)}, but ${late[0]} ${localDate(late[1])}). Fix the date in Windows settings.`;
};

const warnings = async (now = new Date()) => {
  const settings = await S.getSettings();
  const password = await S.currentPassword(settings);
  const folder = S.checkFolder(settings.folder, { create: true });
  return warningsOf({ settings, password, folder }, now);
};

module.exports = { clockProblem, tick, start, stop, afterApproval, warnings, warningsOf, dailyDue, localDate, CHECK_EVERY_MS, STALE_DAYS };
