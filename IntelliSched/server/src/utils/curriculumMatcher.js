// Curriculum placement rules shared by the catalog/mapping controllers and the orchestrator.
// Mirrored for the browser by client/src/utils/sectionMatcher.js and client/src/utils/subjectType.js,
// so keep the copies in sync.

const SUBJECT_TYPES = ['Major', 'Minor', 'NSTP'];
const MAPPING_PROGRAMS = ['BSIT', 'BSCS', 'Both'];
const SUBJECT_TRACKS = ['CORE', 'WMAD', 'SMP', 'AMG', 'IS'];
const BSIT_TRACKS = ['WMAD', 'SMP', 'AMG'];
// Mapping labels. Sections and schedules keep numeric year levels and semesters, so every
// comparison goes through toYearLabel / toSemesterLabel.
const YEAR_LEVEL_LABELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMESTER_LABELS = ['1st Semester', '2nd Semester'];

const toYearLabel = (yearLevel) => YEAR_LEVEL_LABELS[Number(yearLevel) - 1] || null;
const toSemesterLabel = (semester) => SEMESTER_LABELS[Number(semester) - 1] || null;

// Section programs are compared as codes; older sections still store the long program name.
const SECTION_PROGRAM_CODES = {
  BSIT: 'BSIT',
  BSCS: 'BSCS',
  'BS INFORMATION TECHNOLOGY': 'BSIT',
  'BS COMPUTER SCIENCE': 'BSCS'
};
const toProgramCode = (value) => {
  const raw = String(value ?? '').trim().toUpperCase();
  return SECTION_PROGRAM_CODES[raw] || raw;
};

// The section programs one mapping serves: 'Both' is shorthand for BSIT and BSCS.
const mappingPrograms = (program) => (program === 'Both' ? ['BSIT', 'BSCS'] : [program]);

// A catalog subject's classification. The catalog enum always holds one of the three; anything
// else is treated as a Major so it is never silently dropped from staffing.
const resolveSubjectType = (subject) => (SUBJECT_TYPES.includes(subject?.type) ? subject.type : 'Major');

// Scenario A: Minor and NSTP subjects are always TBA (the GenEd departments staff them). Only a
// Major is ranked by Engines 1 & 2 or locked to a CCS professor.
const isTbaSubject = (subject) => resolveSubjectType(subject) !== 'Major';

// The Automated Section Matcher. A mapping places its subject in a section when one of the
// mapping's programs is the section's program, the year levels match, and the mapping is CORE or
// on the section's own track.
const mappingMatchesSection = (mapping, section) =>
  mappingPrograms(mapping.program).includes(toProgramCode(section.program)) &&
  mapping.yearLevel === toYearLabel(section.yearLevel) &&
  (mapping.track === 'CORE' || mapping.track === section.track);

// Every (section, subject) pair a term's mappings produce, once each: overlapping mappings (for
// example the same subject filed under BSIT and under Both) never schedule a subject twice. Only
// mappings whose populated subject exists and is active count.
const buildTermPairs = (sections, mappings) => {
  const pairs = [];
  const seen = new Set();
  for (const section of sections) {
    for (const mapping of mappings) {
      const subject = mapping.subject;
      if (!subject || subject.isActive === false || !mappingMatchesSection(mapping, section)) continue;
      const key = `${section.sectionCode}::${subject._id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ section, subject, mapping });
    }
  }
  return pairs;
};

// The lock that staffs one (section, subject) pair. A lock written with a subjectId matches that
// catalog subject only; an older lock without one matches by subject code, as before.
const findLockFor = (locks, sectionCode, subject) => (locks || []).find(lock =>
  lock.sectionCode === sectionCode && (lock.subjectId
    ? String(lock.subjectId) === String(subject._id)
    : lock.subjectCode === subject.subjectCode));

// Returns an error message when a program / year / track combination can never match a section,
// otherwise null. NSTP is a 1st-year subject; a specialization track belongs to exactly one program.
const validateMappingScope = ({ program, yearLevel, semester, track }, subject) => {
  if (!MAPPING_PROGRAMS.includes(program)) return 'Program must be BSIT, BSCS or Both.';
  if (!YEAR_LEVEL_LABELS.includes(yearLevel)) return 'Year level must be 1st, 2nd, 3rd or 4th Year.';
  if (!SEMESTER_LABELS.includes(semester)) return 'Semester must be 1st Semester or 2nd Semester.';
  if (!SUBJECT_TRACKS.includes(track)) return 'Track must be CORE, WMAD, SMP, AMG or IS.';
  if (BSIT_TRACKS.includes(track)) {
    if (program !== 'BSIT') return `${track} subjects belong to BSIT only.`;
    if (!['3rd Year', '4th Year'].includes(yearLevel)) return `${track} subjects are for 3rd and 4th year only.`;
  }
  if (track === 'IS' && program !== 'BSCS') return 'IS subjects belong to BSCS only.';
  if (subject && resolveSubjectType(subject) === 'NSTP' && yearLevel !== '1st Year') return 'NSTP is a 1st Year subject.';
  return null;
};

module.exports = {
  SUBJECT_TYPES,
  MAPPING_PROGRAMS,
  SUBJECT_TRACKS,
  BSIT_TRACKS,
  YEAR_LEVEL_LABELS,
  SEMESTER_LABELS,
  toYearLabel,
  toSemesterLabel,
  toProgramCode,
  mappingPrograms,
  resolveSubjectType,
  isTbaSubject,
  mappingMatchesSection,
  buildTermPairs,
  findLockFor,
  validateMappingScope
};
