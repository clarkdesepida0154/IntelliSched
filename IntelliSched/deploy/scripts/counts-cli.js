// IntelliSched deployment kit (UPDATE): the record count of every collection now, into
// data\update-counts.json, for the self-test after the update (counts only, never a document).
//   node counts-cli.js --root <install>
const path = require('path');
const { P, loadServerEnv, connect, writeFile, say, fail } = require('./kit-lib');

const main = async () => {
  loadServerEnv();
  const mongoose = await connect();
  const db = mongoose.connection.db;
  const counts = {};
  for (const c of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (c.name.startsWith('system.') || c.name === 'system_settings') continue;
    counts[c.name] = await db.collection(c.name).countDocuments({});
  }
  writeFile(path.join(P.data, 'update-counts.json'), `${JSON.stringify({ at: new Date().toISOString(), counts }, null, 2)}\n`);
  say(`Counted ${Object.keys(counts).length} collections`);
  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => fail(err.message));
