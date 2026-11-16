// Phase 8 Part 8 (decision 6, live updates): the gateway's change feed. Every successful write's
// topics (utils/dataTopics.js) are kept in memory — the newest 500, each with a sequence number, the
// tab that made it (the X-Client-Id header) and the time — and every open tab asks
// GET /api/changes?since=N&boot=B about every 2 seconds, then reads again only what changed. A finished
// generation run is announced too (utils/gaRuns.js), since no request saves it.
// Nothing is stored in the database: a change is only a hint to read again, so a gateway restart (a new
// boot id) answers `reset` and the tabs read everything once.
const crypto = require('crypto');
const { topicsOfWrite } = require('./dataTopics');

const KEEP = 500;
const BOOT = crypto.randomBytes(6).toString('hex');
let seq = 0;
const entries = [];

// Records one change; returns its sequence number (null when there is nothing to say).
const record = (topics, clientId = null) => {
  const list = [...new Set((topics || []).filter(Boolean))];
  if (!list.length) return null;
  seq += 1;
  entries.push({ seq, topics: list, clientId: clientId ? String(clientId).slice(0, 64) : null, at: new Date().toISOString() });
  if (entries.length > KEEP) entries.splice(0, entries.length - KEEP);
  return seq;
};

// What came after `since` for a tab that read this gateway's feed (`boot`). A tab that has not read it
// yet, read another gateway's (a restart), or fell behind the kept list is told to `reset`.
const changesSince = ({ since, boot } = {}) => {
  const after = Number(since);
  const oldest = entries.length ? entries[0].seq : seq + 1;
  if (boot !== BOOT || !Number.isInteger(after) || after < 0 || after > seq || after < oldest - 1) {
    return { boot: BOOT, seq, reset: true, changes: [] };
  }
  return { boot: BOOT, seq, reset: false, changes: entries.filter(e => e.seq > after) };
};

// Express middleware (mounted once, after `protect`): when a write answers with success, its topics
// join the feed.
const trackWrites = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const { method, originalUrl } = req;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    const topics = topicsOfWrite(method, originalUrl);
    record(topics, req.get('x-client-id'));
    // Phase 12.1 (decision 4): a write that changed data (it has topics) stamps the change time the
    // closing backup compares with the last backup.
    if (topics.length) require('../backup/activity').dataChanged();
  });
  return next();
};

// GET /api/changes?since=N&boot=B
const getChanges = (req, res) => res.json({ success: true, ...changesSince(req.query) });

// For tests: an empty feed with the same boot id.
const resetFeed = () => { entries.length = 0; seq = 0; };

module.exports = { record, changesSince, trackWrites, getChanges, resetFeed, BOOT, KEEP };
