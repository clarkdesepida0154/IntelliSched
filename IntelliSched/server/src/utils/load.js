// The one faculty load rule (CLAUDE.md "Faculty load"). Every screen and the validator use it:
//   teaching  = lecture hours + lab hours x labFactor[employmentType] + practicum coordination hours
//   total     = teaching + ancillary;  excess = max(0, total - standardWeeklyHours)
//   the teaching cap (teachingCapHours) limits teaching only; Excess is reported, never blocked.
//
// An assignment is one (section, subject) a professor is locked to on the term's newest Draft, or
// holds in a saved version (utils/termAssignments.js versionAssignments, for its Teachers' Programs):
//   { sectionKey, subjectId, subject: { lecHours, labHours, isPracticum, type } }
// A practicum (OJT) coordinator assignment counts policy.load.ojtCoordinatorHours only.
//
// client/src/utils/load.js is an identical mirror: the code between the SHARED markers must be
// byte-for-byte the same in both files (server/tests/unit/load.test.js checks it and runs the same
// cases against both).

// ---- BEGIN SHARED ----
const ANCILLARY_TYPE_ORDER = ['MANAGEMENT_FUNCTION', 'RESEARCH', 'EXTENSION', 'CEE', 'CONSULTATION'];

// Legacy ancillary roles and free-text designations -> types (the Phase 1 migration's mapping;
// Administrative -> MANAGEMENT_FUNCTION). Only unmigrated profiles need it.
const LEGACY_ROLE_TYPES = {
  Research: 'RESEARCH',
  Extension: 'EXTENSION',
  Administrative: 'MANAGEMENT_FUNCTION',
  Admin: 'MANAGEMENT_FUNCTION',
  Consultation: 'CONSULTATION'
};
const legacyRoleType = (role) => {
  const stored = String(role || '').trim();
  if (LEGACY_ROLE_TYPES[stored]) return LEGACY_ROLE_TYPES[stored];
  if (/research/i.test(stored)) return 'RESEARCH';
  if (/extension/i.test(stored)) return 'EXTENSION';
  if (/consult|prepar/i.test(stored)) return 'CONSULTATION';
  if (/competitive|\bcee\b/i.test(stored)) return 'CEE';
  return 'MANAGEMENT_FUNCTION';
};

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// { TYPE: hours } for a profile: `ancillary` once migrated; otherwise the legacy breakdown or the
// single legacy total, read with the migration's mapping. Phase 11.2 (decision 1): part-timers have
// no ancillary loads, so hours stored on a part-time profile (old or demo data) are ignored here,
// and with them in every load, summary and output that reads this function.
const ancillaryByTypeOf = (faculty) => {
  const byType = {};
  if (faculty?.employmentType === 'PART_TIME') return byType;
  const add = (type, hours) => { byType[type] = round2((byType[type] || 0) + num(hours)); };
  if (Array.isArray(faculty?.ancillary)) {
    faculty.ancillary.forEach(row => add(row.type, row.hours));
  } else if (Array.isArray(faculty?.ancillaryBreakdown) && faculty.ancillaryBreakdown.some(r => r?.role)) {
    faculty.ancillaryBreakdown.filter(r => r?.role).forEach(r => add(legacyRoleType(r.role), r.hours));
  } else if (num(faculty?.ancillaryLoad?.hours) > 0) {
    add(legacyRoleType(faculty.ancillaryLoad.designation), faculty.ancillaryLoad.hours);
  }
  return byType;
};

// How much one lab hour counts for this professor (1 when the employment type is not set yet).
const labFactorOf = (faculty, policy) => {
  const factor = policy?.load?.labFactor?.[faculty?.employmentType];
  return Number.isFinite(factor) ? factor : 1;
};

// The professor's minimum teaching hours (Phase 8 Part 4, decision 1): the stored minTeachingHours
// when the Secretary typed one, else the policy default for their employment type
// (load.defaultMinTeachingHours), lowered for a full-timer by their Management Function hours (a
// designation: Faculty, Faculty) and never below 0. 0 while the profile has no employment type, or
// while the policy carries no default (an old stored snapshot). Never above the profile's own cap
// (a range must hold at least one load), so a cap below the policy default reads "cap–cap".
const minTeachingHoursOf = (faculty, policy) => {
  const cap = Number.isFinite(faculty?.teachingCapHours) ? faculty.teachingCapHours : Infinity;
  const stored = faculty?.minTeachingHours;
  if (Number.isFinite(stored)) return Math.max(0, Math.min(stored, cap));
  const byType = Number(policy?.load?.defaultMinTeachingHours?.[faculty?.employmentType]);
  if (!Number.isFinite(byType)) return 0;
  const management = faculty?.employmentType === 'FULL_TIME' ? num(ancillaryByTypeOf(faculty).MANAGEMENT_FUNCTION) : 0;
  return Math.max(0, Math.min(round2(byType - management), cap));
};

// The teaching hours one (section, subject) adds for this professor.
const weightedHoursOf = (subject, faculty, policy) => (subject?.isPracticum
  ? num(policy.load.ojtCoordinatorHours)
  : round2(num(subject?.lecHours) + num(subject?.labHours) * labFactorOf(faculty, policy)));

// Each (section, subject) counts once, however many locks or class-type rows name it.
const uniqueAssignments = (assignments) => {
  const seen = new Set();
  return (assignments || []).filter(a => {
    const key = `${a.sectionKey}|${a.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// { lecHours, labHours, labWeighted, ojtHours, teaching }
const teachingHours = (assignments, faculty, policy) => {
  let lecHours = 0;
  let labHours = 0;
  let ojtHours = 0;
  uniqueAssignments(assignments).forEach(({ subject }) => {
    if (subject?.isPracticum) ojtHours += num(policy.load.ojtCoordinatorHours);
    else {
      lecHours += num(subject?.lecHours);
      labHours += num(subject?.labHours);
    }
  });
  const labWeighted = round2(labHours * labFactorOf(faculty, policy));
  return { lecHours: round2(lecHours), labHours: round2(labHours), labWeighted, ojtHours: round2(ojtHours), teaching: round2(lecHours + labWeighted + ojtHours) };
};

// { teaching, lecHours, labHours, labWeighted, labFactor, ojtHours, ancillaryByType, ancillary, total,
//   cap, remaining, excess, preparations, employmentType, min, underMin }
// cap and remaining are null while the profile has no teaching cap. labFactor is the factor the lab
// hours were weighted with (SF-029's "(Lab.) 15 x .75 = 11.25"). min is the minimum teaching load
// (Phase 8 Part 4, minTeachingHoursOf) and underMin how far the teaching sits below it (0 at or above).
const facultyLoad = (faculty, assignments, policy) => {
  const unique = uniqueAssignments(assignments);
  const teachingParts = teachingHours(unique, faculty, policy);
  const ancillaryByType = ancillaryByTypeOf(faculty);
  const ancillary = round2(Object.values(ancillaryByType).reduce((a, b) => a + b, 0));
  const total = round2(teachingParts.teaching + ancillary);
  const cap = Number.isFinite(faculty?.teachingCapHours) ? faculty.teachingCapHours : null;
  const min = minTeachingHoursOf(faculty, policy);
  return {
    ...teachingParts,
    labFactor: labFactorOf(faculty, policy),
    ancillaryByType,
    ancillary,
    total,
    cap,
    remaining: cap === null ? null : round2(cap - teachingParts.teaching),
    excess: round2(Math.max(0, total - num(policy.load.standardWeeklyHours))),
    preparations: new Set(unique.map(a => a.subjectId)).size,
    employmentType: faculty?.employmentType || null,
    min,
    underMin: round2(Math.max(0, min - teachingParts.teaching))
  };
};
// ---- END SHARED ----

module.exports = {
  ANCILLARY_TYPE_ORDER,
  legacyRoleType,
  ancillaryByTypeOf,
  labFactorOf,
  minTeachingHoursOf,
  weightedHoursOf,
  uniqueAssignments,
  teachingHours,
  facultyLoad
};
