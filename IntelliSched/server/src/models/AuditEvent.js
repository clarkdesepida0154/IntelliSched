const mongoose = require('mongoose');

// Decisions that are not rows on a schedule document (Phase 2 Step 0): policy saves, reference-list
// saves, version restores, lock releases and the assignments that write no overrideLogs row (a
// manually staffed Minor, a practicum coordinator). Rows are only ever inserted, never edited.
// Collection audit_events. No index: the Audit Trail reads the whole (small) collection.
const actorSchema = new mongoose.Schema({
  id: { type: String, default: null },
  name: { type: String, default: null },
  role: { type: String, default: null },
  // Set on rows the system writes on someone's behalf: the user who started the action.
  startedBy: {
    type: new mongoose.Schema({ id: String, name: String, role: String }, { _id: false }),
    default: undefined
  }
}, { _id: false });

const auditEventSchema = new mongoose.Schema({
  // Machine-readable kind, e.g. 'policy-save', 'version-restore', 'lock-release', 'manual-assignment'.
  action: { type: String, required: true, trim: true },
  // The Audit Trail's category filter: 'Assignments', 'GA Scheduling', 'Approval', 'Settings'.
  category: { type: String, required: true, trim: true },
  // What the row is about, in words ("ITEP 308 (BSIT 3A WMAD)", "Scheduling Policy", "v1.2").
  target: { type: String, required: true, trim: true },
  detail: { type: String, trim: true },
  term: {
    type: new mongoose.Schema({ academicYear: String, semester: Number }, { _id: false }),
    default: undefined
  },
  actor: { type: actorSchema, default: null },
  at: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('AuditEvent', auditEventSchema, 'audit_events');
