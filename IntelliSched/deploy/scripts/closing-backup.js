// IntelliSched deployment kit (Phase 12.1, decision 4): the closing backup. Run by the supervisor after
// it stopped the gateway and the Python service (after the minutes without use, or "Stop
// IntelliSched"), before it stops the database: a full backup and a readable copy through the Phase
// 11.3 backup service, ONLY when data changed since the last successful backup.
//   node closing-backup.js --root <install>
// Exit 0 when a backup was made or none was needed; 1 when it failed (recorded in the Audit Trail and
// shown on the System page and the Term Checklist).
const { loadServerEnv, fromServer, connect, say, fail } = require('./kit-lib');

const main = async () => {
  loadServerEnv();
  const mongoose = await connect();
  const ops = fromServer('src/backup/operations.js');
  const r = await ops.backupIfChanged({ reason: 'closing' });
  await mongoose.disconnect();
  if (r.result === 'unchanged') say('No backup needed: nothing changed since the last backup.');
  else if (r.result === 'ran') say(`Closing backup made: ${r.full.name} and ${r.readable.name}`);
  else fail(`The closing backup failed: ${r.message}`);
};

main().then(() => process.exit(0)).catch((err) => fail(`The closing backup could not run: ${err.message}`));
