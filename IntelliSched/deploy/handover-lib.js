// Phase 12.1 (decision 1): the parts of the office handover that need no database, shared by
// make-handover.js and its tests.
//   markOf(user)            the demo / practice / TEST marker the seed and demo scripts give accounts
//   chooseAccounts(users, approvalsById)
//                           exactly one account is kept: the active, unmarked Dean (several: the one
//                           with the most approvals, else the most recently signed in); every other
//                           account is removed. No unmarked active Dean: { kept: null } (refused).
//   maskEmail(email)        "l***@…" for the report
//   newPassword(length)     from an alphabet without 0 O 1 l I
//   passwordProblem(text)   the rule for a handover password the user types
const crypto = require('crypto');

// The markers: "TEST ..." / "(demo only)" names, "PRACTICE ..." names or practice.* e-mails, and
// e-mails at example.test or any *.test domain (the demos, the E2E seed, the practice kit).
const markOf = (u) => {
  const name = String(u?.name || '');
  const email = String(u?.email || '').toLowerCase();
  if (/^TEST\b|\(demo only\)|\(TEST\)/i.test(name)) return 'TEST/demo account';
  if (/^PRACTICE\b/i.test(name) || /^practice\./.test(email)) return 'practice account';
  if (/@example\.test$|\.test$/.test(email)) return 'demo/test e-mail';
  return null;
};

const isActive = (u) => (u?.status || 'Active') === 'Active';
const idOf = (u) => String(u?._id ?? u?.id ?? '');

const chooseAccounts = (users, approvalsById = {}) => {
  const candidates = users.filter(u => u.role === 'Dean' && isActive(u) && !markOf(u));
  let kept = null;
  let why = '';
  if (candidates.length === 1) {
    [kept] = candidates;
    why = 'the active Dean without a demo, practice or TEST marker';
  } else if (candidates.length > 1) {
    const approvals = (u) => Number(approvalsById[idOf(u)] || 0);
    const signedIn = (u) => (u.lastLogin ? new Date(u.lastLogin).getTime() : 0);
    const ranked = [...candidates].sort((a, b) => approvals(b) - approvals(a) || signedIn(b) - signedIn(a));
    [kept] = ranked;
    why = approvals(kept) > 0
      ? `one of ${candidates.length} unmarked Deans: the one who made the approvals (${approvals(kept)})`
      : `one of ${candidates.length} unmarked Deans: the most recently signed in`;
  }
  const rows = users.map((u) => {
    const mark = markOf(u);
    if (kept && idOf(u) === idOf(kept)) return { user: u, action: 'KEEP', reason: why };
    let reason;
    if (mark) reason = mark;
    else if (u.role !== 'Dean') reason = `not the Dean (${u.role})`;
    else if (!isActive(u)) reason = `a Dean account that is ${u.status}`;
    else reason = 'another unmarked Dean (one Dean account is kept)';
    return { user: u, action: 'REMOVE', reason };
  });
  return { kept, rows };
};

const maskEmail = (email) => {
  const text = String(email || '');
  const at = text.indexOf('@');
  if (at < 1) return '***';
  return `${text[0]}***@…`;
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const newPassword = (length) => {
  let out = '';
  while (out.length < length) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
};

const passwordProblem = (text, confirm) => {
  const t = String(text ?? '');
  if (t.length < 8) return 'Use at least 8 characters.';
  if (t.toLowerCase() === 'intellisched') return 'Choose a password other than "intellisched".';
  if (confirm !== undefined && t !== String(confirm ?? '')) return 'The two passwords are not the same.';
  return null;
};

const OFFICE_LINE = 'Keep this paper separate from the USB sticks. After install day, shred it.';
const officePasswordsText = ({ handoverPassword, deanEmail, deanPassword, madeAt, sha256 }) => [
  'IntelliSched - office passwords (install day)',
  `Made: ${madeAt}`,
  '',
  `Handover password (INSTALL.bat asks for it): ${handoverPassword}`,
  '',
  `The Dean's sign-in email: ${deanEmail}`,
  `The Dean's starting password: ${deanPassword}`,
  '(IntelliSched asks the Dean to choose a new password at the first sign-in.)',
  '',
  `handover.isbak SHA-256: ${sha256}`,
  '',
  OFFICE_LINE,
  ''
].join('\r\n');

// The Dean's starting password kept from an earlier OFFICE-PASSWORDS.txt, or null.
const startingPasswordIn = (text) => {
  const m = /^The Dean's starting password: (\S+)\s*$/m.exec(String(text || ''));
  return m ? m[1] : null;
};

module.exports = { markOf, chooseAccounts, maskEmail, newPassword, passwordProblem, officePasswordsText, startingPasswordIn, ALPHABET, OFFICE_LINE };
