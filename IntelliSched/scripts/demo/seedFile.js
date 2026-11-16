// Which seed file a demo database was seeded from (Phase 3, 1 Oct 2026). A database the demo keeps
// keeps the data it was seeded with, so a newer docs/data/intellisched_seed_data.json (for example the
// subject descriptions the team added on 1 Oct 2026) reaches it only through a reset. demo.js records
// the file's hash in demo_meta (seedFileHash) when it seeds and, on a database it keeps, says when the
// file has changed since; it never reseeds by itself.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('./paths');

const SEED_FILE = path.join(REPO_ROOT, 'docs', 'data', 'intellisched_seed_data.json');

// The file's SHA-256, line endings ignored (a checkout with CRLF is the same file).
const seedFileHash = (file = SEED_FILE) => crypto.createHash('sha256')
  .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');

// The npm command that reseeds a mode ('normal' -> npm run demo:reset, 'full' -> npm run demo:full:reset,
// 'defense' -> npm run defense:reset).
const resetOf = (modeName) => `npm run ${{ normal: 'demo', defense: 'defense' }[modeName] || `demo:${modeName}`}:reset`;

// What the demo says about a database it keeps: '' when it was seeded from the current file.
const seedFileNotice = ({ meta, hash, dbName, modeName }) => {
  if (meta?.seedFileHash && meta.seedFileHash === hash) return '';
  return meta?.seedFileHash
    ? `The seed file (docs/data/intellisched_seed_data.json) changed after ${dbName} was seeded: ${resetOf(modeName)} loads the new data. Nothing was changed.`
    : `${dbName} was seeded before the demo recorded its seed file, so newer seed data (such as the subject descriptions) may be missing: ${resetOf(modeName)} loads the current file. Nothing was changed.`;
};

module.exports = { SEED_FILE, seedFileHash, seedFileNotice, resetOf };
