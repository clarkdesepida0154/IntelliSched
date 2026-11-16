// Phase 11.3: the settings that belong to this computer, not to the term's data — the backup folder,
// the automatic daily backup, how many to keep, the backup password (encrypted, never in plain text),
// the backups' last results, and the time before which every sign-in token is refused (after a
// restore). ONE document per key ('backup'). This collection is never inside a backup and never
// replaced by a restore: restoring an older backup must not bring back an older password or folder.
const mongoose = require('mongoose');

const systemSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true },
  folder: { type: String, default: null },
  daily: { type: Boolean, default: true },
  keep: { type: Number, default: 30, min: 5, max: 100 },
  // The backup password, sealed with a key derived from the server's own secret (utils of backup/password.js).
  password: {
    type: new mongoose.Schema({ sealed: String, setOn: Date, isDefault: Boolean }, { _id: false }),
    default: undefined
  },
  lastDailyDate: { type: String, default: null },        // YYYY-MM-DD, local time
  lastSuccess: { type: Date, default: null },
  lastFailure: {
    type: new mongoose.Schema({ at: Date, message: String, reason: String }, { _id: false }),
    default: undefined
  },
  sessionsValidAfter: { type: Date, default: null },
  // Phase 12.1 (decision 4): IntelliSched runs only while in use. The minutes without use before it
  // backs up and closes (30 / 60 / 120 or 'never'; absent = 60), the local dates it was used, and the
  // time of the last write that changed data (the closing backup runs only after a change).
  idleMinutes: { type: mongoose.Schema.Types.Mixed, default: undefined },
  daysUsed: { type: [String], default: undefined },
  lastDataChangeAt: { type: Date, default: undefined },
  // Phase 12.1 (decision 5): an optional second folder (a USB stick, a Google Drive for desktop folder)
  // that gets a copy of every backup; its last problem, cleared when a copy succeeds.
  secondFolder: { type: String, default: undefined },
  secondFolderProblem: {
    type: new mongoose.Schema({ at: Date, message: String }, { _id: false }),
    default: undefined
  }
}, { versionKey: false, timestamps: true });

module.exports = mongoose.model('SystemSetting', systemSettingSchema, 'system_settings');
