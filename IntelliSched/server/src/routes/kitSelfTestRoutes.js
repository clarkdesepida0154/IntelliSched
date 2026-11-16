// Phase 12.2 (decision 3): the kit's self-test asks the RUNNING gateway — the daily user's own,
// non-elevated process — for the checks whose result depends on who runs them: who it runs as, one
// PDF and "Back up now" (whose readable copy holds PDFs). An installer or updater runs elevated, and
// Edge started from an elevated process writes no PDF, so these never run in the installer's process.
//
// Only for the kit's own scripts on this computer: the request must come from 127.0.0.1 and carry
// X-IntelliSched-Selftest = HMAC-SHA256(JWT_SECRET, "intellisched-kit-selftest") in hex (the scripts
// read config\server.env, which only Administrators and the daily user can open). Anything else
// answers 404. Mounted before the sign-in check and before the activity tracker (it is not a user).
const crypto = require('crypto');
const express = require('express');

const router = express.Router();

const tokenOf = (secret) => crypto.createHmac('sha256', String(secret)).update('intellisched-kit-selftest').digest('hex');

const allowed = (req) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;
  const addr = req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
  const given = Buffer.from(String(req.get('x-intellisched-selftest') || ''));
  const want = Buffer.from(tokenOf(secret));
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

router.use((req, res, next) => (allowed(req) ? next() : res.status(404).json({ success: false, message: 'Not found.' })));

router.get('/identity', (req, res) => {
  const { processIdentity } = require('../utils/elevation');
  const { warmUpState } = require('../exports/pdf');
  res.json({ ...processIdentity(), pdfWarmUp: warmUpState() });
});

// One small PDF, after the warm-up has ended.
router.post('/pdf', async (req, res) => {
  const pdf = require('../exports/pdf');
  await pdf.warmUp();
  const started = Date.now();
  try {
    const buf = await pdf.htmlToPdf('<!doctype html><html><body><h1>IntelliSched self-test</h1><p>One page.</p></body></html>');
    const browser = pdf.findBrowser();
    res.json({ ok: true, bytes: buf.length, ms: Date.now() - started, browser: browser ? require('path').basename(browser) : null, warmUp: pdf.warmUpState() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message, ms: Date.now() - started, warmUp: pdf.warmUpState() });
  }
});

// "Back up now" in the gateway: the .isbak and the readable copy (with its PDFs), after the warm-up.
router.post('/backup', async (req, res) => {
  await require('../exports/pdf').warmUp();
  try {
    const ops = require('../backup/operations');
    const S = require('../backup/settings');
    // The gateway's own backup may be running (the day's first start after noon runs the daily one,
    // an unclean end its own): wait for it (up to 15 minutes), then make the self-test's.
    let made = null;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!made) {
      if (ops.isBusy() && Date.now() < deadline) { await new Promise(r => setTimeout(r, 2000)); continue; }
      try { made = await ops.backUpBoth({ reason: 'manual' }); } catch (err) {
        if (err.code !== 'BUSY' || Date.now() >= deadline) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    const settings = await S.getSettings();
    res.json({ ok: true, folder: settings.folder, full: { name: made.full.name }, readable: { name: made.readable.name } });
  } catch (err) {
    res.status(500).json({ ok: false, code: err.code || null, message: err.message });
  }
});

module.exports = { router, tokenOf };
