// The Dean's decisions on a ranking (Phase 3 Step 8, item 7): which overrideLogs rows Engine 4
// retrains on. The same rule as ../intellisched_backend/engine4_retrainer.py is_training_decision, on
// the same pinned cases (shared/decision-cases.json; server tests/unit/decisions.test.js and the Python
// tests/test_engine4_decisions.py):
//   - entryType 'accept' or 'override': a decision;
//   - entryType 'lock' made by a PERSON (Phase 8 Part 11): a hand assignment, a decision ('assigned').
//     A person = an actor with a name and an id (a signed-in user) that is not the System actor (a row
//     written on someone's behalf; the term loader's rows carry no id); the lock names a professor
//     (not the TBA pool or an outside teacher); and its reason is not a practice-copy script's
//     ("Practice copy only: …");
//   - any other entryType ('lock' nobody signed, 'schedule-edit', 'approval'): not a decision;
//   - no entryType (rows written before the field existed): a decision, as before, unless its subject
//     code is APPROVAL-CHAIN (an approval row of that time).
const DECISION_ENTRY_TYPES = ['accept', 'override'];
const APPROVAL_CHAIN = 'APPROVAL-CHAIN';
const NOT_A_PROFESSOR = ['FAC-TBA', 'OUTSIDE'];
const PRACTICE_PREFIX = 'practice copy only';

const entryTypeOf = (entry) => String(entry?.entryType ?? '').trim().toLowerCase();

const isHandAssignment = (entry) => {
  if (entryTypeOf(entry) !== 'lock') return false;
  const actor = entry?.actor;
  if (!actor || typeof actor !== 'object' || !String(actor.name ?? '').trim()) return false;
  // A signed-in user always has an id; the term loader calls the lock handler as a user with none.
  const actorId = String(actor.id ?? '').trim();
  if (!actorId || actorId.toUpperCase() === 'SYSTEM' || String(actor.role ?? '').trim().toLowerCase() === 'system') return false;
  const professor = String(entry?.assignedFacultyId ?? '').trim().toUpperCase();
  if (!professor || NOT_A_PROFESSOR.includes(professor)) return false;
  return !String(entry?.reason ?? '').trim().toLowerCase().startsWith(PRACTICE_PREFIX);
};

const isTrainingDecision = (entry) => {
  const type = entryTypeOf(entry);
  if (type) return DECISION_ENTRY_TYPES.includes(type) || isHandAssignment(entry);
  return String(entry?.subjectCode ?? '').trim().toUpperCase() !== APPROVAL_CHAIN;
};

// What a row is, for the Model Feedback page's counts: 'accept' | 'override' | 'assigned' (a hand
// assignment by a person) | 'unrecorded' (a decision without an entryType) | 'lock' (a lock nobody
// signed, or a script's) | 'schedule-edit' | 'approval' | 'other'.
const kindOf = (entry) => {
  const type = entryTypeOf(entry);
  if (!type) return isTrainingDecision(entry) ? 'unrecorded' : 'approval';
  if (isHandAssignment(entry)) return 'assigned';
  return ['accept', 'override', 'lock', 'schedule-edit', 'approval'].includes(type) ? type : 'other';
};

module.exports = { DECISION_ENTRY_TYPES, APPROVAL_CHAIN, isTrainingDecision, isHandAssignment, kindOf };
