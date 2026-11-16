const mongoose = require('mongoose');

// Phase 8 Part 8 (decision 4): a GenEd class's teacher from outside CCS (another college's), on its own
// list, never in the CCS faculty table: no Teachers' Program, load, cap or minimum. A GenEd (Minor)
// class assigned to one keeps a lock with source 'outside' and outsideTeacherRef (MotherSchedule.js),
// stays without a CCS room unless its "Needs a CCS room" box is ticked, and prints on the Class Schedule
// like a CCS professor ("R. Santos"). The GA and the validator give the teacher two rules only: never
// two classes at the same time (in any week group), and the lunch hour.
// The name is unique on the list without regard to case; the controller checks it (no unique index, so
// no index change reaches Atlas outside a migration).
const outsideTeacherSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 }
}, { timestamps: true });

module.exports = mongoose.model('OutsideTeacher', outsideTeacherSchema);
