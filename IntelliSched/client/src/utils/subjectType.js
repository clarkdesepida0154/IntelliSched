// Subject classification shared by every page that reads the Master Catalog. The gateway applies the
// same rule (server/src/utils/curriculumMatcher.js), so keep the two in sync.

export const SUBJECT_TYPE_VALUES = ['Major', 'Minor', 'NSTP'];

// Catalog subjects always carry one of the three types; anything else reads as a Major so it is never
// silently dropped from staffing.
export const resolveSubjectType = (subject) =>
  (SUBJECT_TYPE_VALUES.includes(subject?.type) ? subject.type : 'Major');

// Scenario A: Minor and NSTP subjects are always TBA (the GenEd departments staff them), so only a
// Major is ranked by the AI or locked to a CCS professor.
export const isTbaSubject = (subject) => resolveSubjectType(subject) !== 'Major';

// How a (section, subject) pair is staffed (the gateway's lock route uses the same rule):
// MAJOR (ranked, then locked), MINOR (TBA unless the Dean assigns a CCS professor manually),
// PRACTICUM (one coordinator, never scheduled) or NSTP (always TBA, never locked).
export const subjectKindOf = (subject) => {
  const type = resolveSubjectType(subject);
  if (type === 'NSTP') return 'NSTP';
  if (type === 'Minor') return 'MINOR';
  return subject?.isPracticum ? 'PRACTICUM' : 'MAJOR';
};
