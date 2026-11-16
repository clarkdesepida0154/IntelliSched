// IntelliSched deployment kit: "the Dean forgot his password" (reset-password.ps1 runs this).
//   node reset-password.js --root <install> --list
//   node reset-password.js --root <install> --set <email>     the new password on standard input
// The password is hashed by the gateway's own User model (bcrypt in its save hook); a hash is never
// printed. One Audit Trail row: "Password reset from the computer".
const { argValue, hasFlag, loadServerEnv, fromServer, readSecret, connect, say, fail } = require('./kit-lib');

const main = async () => {
  loadServerEnv();
  const mongoose = await connect();
  const User = fromServer('src/models/User.js');
  const AuditEvent = fromServer('src/models/AuditEvent.js');
  if (hasFlag('--list')) {
    const users = await User.find({}, { name: 1, email: 1, role: 1, status: 1 }).sort({ role: 1, name: 1 }).lean();
    users.forEach((u, i) => say(`${i + 1}\t${u.name}\t${u.email}\t${u.role}\t${u.status || 'Active'}`));
    await mongoose.disconnect();
    return 0;
  }
  const email = String(argValue('--set') || '').trim().toLowerCase();
  if (!email) fail('Name the account by its e-mail address.');
  const password = await readSecret();
  if (!password || password.length < 8) fail('Use at least 8 characters.');
  const user = await User.findOne({ email }).select('+password');
  if (!user) fail(`There is no account with the e-mail address ${email}.`);
  user.password = password;
  if (user.status === 'Locked') say('The account stays Locked: unlock it on Users & Roles after signing in with another account.');
  await user.save();
  await AuditEvent.create({
    action: 'Password reset from the computer',
    category: 'System',
    target: `${user.name} (${user.role})`,
    detail: `The password of ${user.email} was reset on this computer with reset-password.ps1.`,
    actor: { id: 'SYSTEM', name: 'System', role: 'System' },
    at: new Date(),
  });
  say(`The password of ${user.name} (${user.email}) was changed.`);
  await mongoose.disconnect();
  return 0;
};

main().then(code => process.exit(code)).catch((err) => fail(err.message));
