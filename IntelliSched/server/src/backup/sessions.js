// Phase 11.3 (decision 5, step 9): after a restore every user is signed out. A sign-in token issued
// before system_settings.sessionsValidAfter is refused by the auth middleware (401 SESSION_ENDED).
// The time is cached in memory, read once from the database, and set again by endAllSessions().
const SystemSetting = require('../models/SystemSetting');

let cached;   // undefined: not read yet; null: none; a Date: the cut-off
const validAfter = async () => {
  if (cached === undefined) {
    try {
      const doc = await SystemSetting.findOne({ key: 'backup' }).select('sessionsValidAfter').lean();
      cached = doc?.sessionsValidAfter ? new Date(doc.sessionsValidAfter) : null;
    } catch {
      return null;    // the database is not ready: nothing to refuse yet
    }
  }
  return cached;
};
// A token's "issued at" (seconds) against the cut-off.
const tokenEnded = async (iatSeconds) => {
  const cut = await validAfter();
  return Boolean(cut && Number.isFinite(iatSeconds) && iatSeconds * 1000 < cut.getTime());
};
const endAllSessions = async (at = new Date()) => {
  // Whole seconds, one past now, so a token signed in the same second is refused too.
  const cut = new Date(Math.floor(at.getTime() / 1000) * 1000 + 1000);
  await SystemSetting.updateOne({ key: 'backup' }, { $set: { sessionsValidAfter: cut } }, { upsert: true });
  cached = cut;
  return cut;
};
const forget = () => { cached = undefined; };

module.exports = { tokenEnded, endAllSessions, validAfter, forget };
