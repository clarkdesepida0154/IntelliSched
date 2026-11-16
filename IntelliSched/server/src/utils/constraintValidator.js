/**
 * The gateway validator: re-checks a GA result independently before anything is saved.
 * It counts the shared hard constraints exactly as Engine 3 does (utils/constraints.js; golden cases
 * in shared/constraint-cases/), plus two checks only the gateway makes:
 *   COMPLETENESS       every demand is placed exactly once (and nothing else is placed)
 *   HC5_TEACHING_CAP   teaching hours from the locks (utils/load.js) against each teaching cap
 */
const { evaluatePlacements } = require('./constraints');
const { facultyLoad } = require('./load');

// HC5 from the locks with the one load rule: teaching = lecture + lab x labFactor + practicum
// coordination, against teachingCapHours. `assignmentsByFaculty` maps a faculty _id to its
// assignments (utils/termAssignments.js).
const checkTeachingCap = (faculty, assignmentsByFaculty, policy) => {
  const violations = [];
  if (!assignmentsByFaculty) return violations;
  for (const f of faculty) {
    const assignments = assignmentsByFaculty.get(String(f._id));
    if (!assignments?.length) continue;
    const load = facultyLoad(f, assignments, policy);
    if (load.cap !== null && load.teaching > load.cap) {
      violations.push({
        code: 'HC5_TEACHING_CAP',
        demandIds: [],
        facultyRef: String(f._id),
        teaching: load.teaching,
        cap: load.cap,
        message: `${f.name} has ${load.teaching} teaching hours, above the ${load.cap} h teaching cap.`
      });
    }
  }
  return violations;
};

// Every demand placed exactly once; a placement for an unknown demand is reported too.
const checkCompleteness = (request, placements) => {
  const counts = new Map(request.demands.map(d => [d.demandId, 0]));
  const violations = [];
  for (const p of placements) {
    if (!counts.has(p.demandId)) {
      violations.push({ code: 'COMPLETENESS', demandIds: [p.demandId], message: `The result places a class this term does not have (${p.demandId}).` });
      continue;
    }
    counts.set(p.demandId, counts.get(p.demandId) + 1);
  }
  const byId = new Map(request.demands.map(d => [d.demandId, d]));
  for (const [demandId, n] of counts) {
    if (n === 1) continue;
    const d = byId.get(demandId);
    violations.push({
      code: 'COMPLETENESS',
      demandIds: [demandId],
      message: `${d.subjectCode} ${d.classType} (${d.sectionCode}) was placed ${n === 0 ? 'nowhere' : `${n} times`}.`
    });
  }
  return violations;
};

// { isValid, violationCount, hard: {code: count}, soft, violations: [{ code, demandIds, message }] }
const validateGeneratedSchedule = ({ request, placements, faculty = [], assignmentsByFaculty = null, policy }) => {
  const shared = evaluatePlacements(request, placements);
  const violations = [
    ...checkCompleteness(request, placements),
    ...shared.violations,
    ...checkTeachingCap(faculty, assignmentsByFaculty, policy)
  ];
  const hard = {};
  for (const v of violations) hard[v.code] = (hard[v.code] || 0) + 1;
  // partTimerSingleDays (Phase 8 Part 6): each non-exempt part-timer's lone weekday, whether or not
  // the hard rule is on (the editor's warning reads it while the rule is off).
  return { isValid: violations.length === 0, violationCount: violations.length, hard, soft: shared.soft, softCounts: shared.softCounts, violations, partTimerSingleDays: shared.partTimerSingleDays };
};

module.exports = { validateGeneratedSchedule, checkTeachingCap, checkCompleteness };
