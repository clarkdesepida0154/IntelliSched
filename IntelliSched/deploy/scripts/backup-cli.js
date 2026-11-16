// IntelliSched deployment kit (UPDATE step 2): one full backup through the Phase 11.3 backup service,
// with the backup password the system already holds, into the System settings' backup folder.
//   node backup-cli.js --root <install> [--reason "before an update"]
const { argValue, loadServerEnv, fromServer, connect, say, fail } = require('./kit-lib');

const main = async () => {
  loadServerEnv();
  const mongoose = await connect();
  const ops = fromServer('src/backup/operations.js');
  const S = fromServer('src/backup/settings.js');
  const settings = await S.getSettings();
  const full = await ops.writeFull({ reason: 'manual', settings });
  await ops.audit('Backup made', 'Backup', `${argValue('--reason', 'from the computer')}: ${full.name}`, null);
  await S.updateSettings({ lastSuccess: new Date(), lastFailure: null });
  say(`Backup made: ${full.file} (${Math.round(full.size / 1024)} KB)`);
  await mongoose.disconnect();
};

main().then(() => process.exit(0)).catch((err) => fail(`The backup could not be made: ${err.message}`));
