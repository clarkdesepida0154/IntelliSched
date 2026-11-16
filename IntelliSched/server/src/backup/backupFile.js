// Phase 11.3 (decision 2): the full backup's file format, ".isbak". Always encrypted with the backup
// password: AES-256-GCM (Node's built-in crypto), the key derived from the password by scrypt with a
// random salt per file.
//
//   bytes 0-15   MAGIC "INTELLISCHED-BAK" (ASCII)
//   byte  16     the format version (1)
//   bytes 17-20  the header's length (UInt32 BE)
//   ...          the header, JSON (UTF-8): { format, salt, iv, check, passwordSetOn, createdAt,
//                appVersion, schemaVersion, dbName, kind } — salt / iv / check in base64
//   ...          the GCM tag (16 bytes)
//   ...          the ciphertext: a ZIP (exports/zip.js) of the backup's files
//
// The whole header (magic and length included) is the cipher's additional data, so a changed header
// fails like a changed body. `check` is an HMAC of a fixed text under the derived key: a wrong password
// is told apart from a damaged file before decrypting. The password is never stored in the file; only
// the date it was set ("passwordSetOn"), so the restore list can say which password a file needs.
const crypto = require('crypto');

const MAGIC = Buffer.from('INTELLISCHED-BAK', 'ascii');
const FORMAT_VERSION = 1;
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };
const CHECK_TEXT = 'intellisched-backup-key-check';

class BackupFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.plain = true;
  }
}

const deriveKey = (password, salt) => crypto.scryptSync(String(password), salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
const keyCheck = (key) => crypto.createHmac('sha256', key).update(CHECK_TEXT).digest();

const headerBytes = (header) => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC.length + 5);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt8(FORMAT_VERSION, MAGIC.length);
  prefix.writeUInt32BE(json.length, MAGIC.length + 1);
  return Buffer.concat([prefix, json]);
};

// Encrypts the payload (a Buffer) into an .isbak file. meta: the header's plain facts.
const sealBackup = (payload, password, meta = {}) => {
  if (!password) throw new BackupFileError('NO_PASSWORD', 'No backup password is set.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const header = {
    format: FORMAT_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    check: keyCheck(key).toString('base64'),
    passwordSetOn: meta.passwordSetOn || null,
    createdAt: meta.createdAt || new Date().toISOString(),
    appVersion: meta.appVersion || null,
    schemaVersion: meta.schemaVersion ?? null,
    dbName: meta.dbName || null,
    kind: meta.kind || 'full'
  };
  const head = headerBytes(header);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([head, cipher.getAuthTag(), body]);
};

// The header of an .isbak file, read without the password; throws BACKUP_DAMAGED for anything else.
const readHeader = (file) => {
  const damaged = () => new BackupFileError('BACKUP_DAMAGED', 'This file is not an IntelliSched backup, or it is damaged.');
  if (!Buffer.isBuffer(file) || file.length < MAGIC.length + 5) throw damaged();
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw damaged();
  const version = file.readUInt8(MAGIC.length);
  if (version > FORMAT_VERSION) throw new BackupFileError('BACKUP_TOO_NEW', 'This backup was made by a newer version of IntelliSched. Update IntelliSched first.');
  const length = file.readUInt32BE(MAGIC.length + 1);
  const start = MAGIC.length + 5;
  if (length <= 0 || start + length + 16 > file.length) throw damaged();
  let header;
  try {
    header = JSON.parse(file.subarray(start, start + length).toString('utf8'));
  } catch {
    throw damaged();
  }
  if (!header || !header.salt || !header.iv || !header.check) throw damaged();
  return { header, headLength: start + length };
};

// Decrypts an .isbak file. Throws WRONG_PASSWORD, BACKUP_DAMAGED or BACKUP_TOO_NEW (plain words).
const openBackup = (file, password) => {
  const { header, headLength } = readHeader(file);
  const key = deriveKey(password ?? '', Buffer.from(header.salt, 'base64'));
  const expected = Buffer.from(header.check, 'base64');
  const got = keyCheck(key);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw new BackupFileError('WRONG_PASSWORD', 'That is not this backup\'s password. Nothing was changed.');
  }
  const tag = file.subarray(headLength, headLength + 16);
  const body = file.subarray(headLength + 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(file.subarray(0, headLength));
    decipher.setAuthTag(tag);
    return { header, payload: Buffer.concat([decipher.update(body), decipher.final()]) };
  } catch {
    throw new BackupFileError('BACKUP_DAMAGED', 'This backup is damaged: its contents do not match its seal. Nothing was changed.');
  }
};

module.exports = { MAGIC, FORMAT_VERSION, BackupFileError, sealBackup, openBackup, readHeader };
