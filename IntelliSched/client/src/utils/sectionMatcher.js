// Client copy of the gateway's curriculum rules (server/src/utils/curriculumMatcher.js), so pages that
// preview demands (Course Matrix, Candidate Ranking) show exactly the (section, subject) pairs the GA
// will receive, and the Curriculum Builder offers only placements the gateway accepts. Keep in sync.

export const MAPPING_PROGRAMS = ['BSIT', 'BSCS', 'Both'];
export const SUBJECT_TRACKS = ['CORE', 'WMAD', 'SMP', 'AMG', 'IS'];
export const BSIT_TRACKS = ['WMAD', 'SMP', 'AMG'];
// Mapping labels. Sections and schedules keep numeric year levels and semesters.
export const YEAR_LEVEL_LABELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
export const SEMESTER_LABELS = ['1st Semester', '2nd Semester'];

export const toYearLabel = (yearLevel) => YEAR_LEVEL_LABELS[Number(yearLevel) - 1] || null;
export const toSemesterLabel = (semester) => SEMESTER_LABELS[Number(semester) - 1] || null;

const PROGRAM_CODES = { BSIT: 'BSIT', BSCS: 'BSCS', 'BS INFORMATION TECHNOLOGY': 'BSIT', 'BS COMPUTER SCIENCE': 'BSCS' };

export const toProgramCode = (value) => {
  const raw = String(value ?? '').trim().toUpperCase();
  return PROGRAM_CODES[raw] || raw;
};

// The section programs one mapping serves: 'Both' is shorthand for BSIT and BSCS.
export const mappingPrograms = (program) => (program === 'Both' ? ['BSIT', 'BSCS'] : [program]);

// Whether a track can hold subjects for this program and year level: the BSIT specialisations are
// 3rd-4th year BSIT only, IS is BSCS only, CORE fits every block.
export const isTrackAllowed = (program, yearLabel, track) => {
  if (BSIT_TRACKS.includes(track)) return program === 'BSIT' && ['3rd Year', '4th Year'].includes(yearLabel);
  if (track === 'IS') return program === 'BSCS';
  return track === 'CORE';
};

export const mappingMatchesSection = (mapping, section) =>
  mappingPrograms(mapping.program).includes(toProgramCode(section.program)) &&
  mapping.yearLevel === toYearLabel(section.yearLevel) &&
  (mapping.track === 'CORE' || mapping.track === section.track);

// Every (section, subject) pair a term's populated mappings produce, once each; mappings whose
// subject is missing or disabled are skipped, exactly as the gateway skips them.
export const buildTermPairs = (sections, mappings) => {
  const pairs = [];
  const seen = new Set();
  sections.forEach(section => {
    mappings.forEach(mapping => {
      const subject = mapping.subject;
      if (!subject || subject.isActive === false || !mappingMatchesSection(mapping, section)) return;
      const key = `${section.sectionCode}::${subject._id}`;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ section, subject, mapping });
    });
  });
  return pairs;
};

// The lock that staffs one (section, subject) pair: by catalog id when the lock has one, otherwise
// (locks written before subjectId existed) by subject code.
export const findLockFor = (locks, sectionCode, subject) => (locks || []).find(lock =>
  lock.sectionCode === sectionCode && (lock.subjectId
    ? String(lock.subjectId) === String(subject._id)
    : lock.subjectCode === subject.subjectCode));
