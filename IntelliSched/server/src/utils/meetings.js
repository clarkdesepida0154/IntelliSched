// The meeting rule: how one subject's weekly hours become class meetings. One pure function, shared
// by the demand builder and the pre-flight check, reading every number from the SchedulingPolicy.
const { hoursBetween } = require('./timeGrid');
const { resolveSubjectType } = require('./curriculumMatcher');

// Phase 3 Step 7: how a subject's lectures are held (SubjectCatalog.lectureMode). Only a Major that is
// not a practicum can be online; anything else, and a record without the field (lean reads skip
// defaults), is ON_CAMPUS. Labs always stay on campus.
const LECTURE_MODES = ['ON_CAMPUS', 'ONLINE_SCHEDULED', 'ONLINE_SELF_PACED'];
const lectureModeOf = (subject) => (resolveSubjectType(subject) === 'Major' && !subject?.isPracticum && LECTURE_MODES.includes(subject?.lectureMode)
  ? subject.lectureMode
  : 'ON_CAMPUS');

// Splits `hours` into `count` parts in 0.5 h steps, as equal as possible, larger parts first:
// (5, 3) -> [2, 1.5, 1.5]; (2.5, 2) -> [1.5, 1].
const splitEvenly = (hours, count) => {
  const halves = Math.round(hours * 2);
  const base = Math.floor(halves / count);
  const extra = halves % count;
  return Array.from({ length: count }, (_, i) => (base + (i < extra ? 1 : 0)) / 2);
};

// Lecture hours -> meeting lengths. kind is 'MAJOR' or 'MINOR' (GenEd, PE, Math, Filipino).
//   h <= lectureMaxMeetingHours -> one meeting; h = 3 -> threeHourLecture[kind];
//   otherwise ceil(h / lectureMaxMeetingHours) meetings, as equal as possible.
const lectureMeetings = (hours, kind, policy) => {
  const h = Number(hours) || 0;
  if (h <= 0) return [];
  const { lectureMaxMeetingHours, threeHourLecture } = policy.meetings;
  if (h <= lectureMaxMeetingHours) return [h];
  if (h === 3) return [...threeHourLecture[kind === 'MAJOR' ? 'MAJOR' : 'MINOR']];
  return splitEvenly(h, Math.ceil(h / lectureMaxMeetingHours));
};

// Lab hours -> meeting lengths: h <= labMaxMeetingHours -> one meeting; otherwise
// ceil(h / labMaxMeetingHours) meetings, as equal as possible.
const labMeetings = (hours, policy) => {
  const h = Number(hours) || 0;
  if (h <= 0) return [];
  const { labMaxMeetingHours } = policy.meetings;
  if (h <= labMaxMeetingHours) return [h];
  return splitEvenly(h, Math.ceil(h / labMaxMeetingHours));
};

// Every meeting of one catalog subject for one section:
//   [{ classType: 'LEC' | 'LAB', hours, meetingIndex, fixed: null | { day, start, end } }]
// Practicum subjects have none (they are never placed). NSTP is exactly one fixed block equal to
// the policy's NSTP window. meetingIndex counts within the class type (LEC 0, 1; LAB 0). A Major whose
// lectures are self-paced online (Phase 3 Step 7) has its labs only: its lecture hours get no day, time
// or room (they still count in the professor's load).
const meetingsForSubject = (subject, policy) => {
  if (subject?.isPracticum) return [];
  if (subject?.type === 'NSTP') {
    const { day, start, end } = policy.nstp;
    return [{ classType: 'LEC', hours: hoursBetween(start, end), meetingIndex: 0, fixed: { day, start, end } }];
  }
  const kind = subject?.type === 'Major' ? 'MAJOR' : 'MINOR';
  const lectures = lectureModeOf(subject) === 'ONLINE_SELF_PACED' ? [] : lectureMeetings(subject?.lecHours, kind, policy);
  return [
    ...lectures.map((hours, i) => ({ classType: 'LEC', hours, meetingIndex: i, fixed: null })),
    ...labMeetings(subject?.labHours, policy).map((hours, i) => ({ classType: 'LAB', hours, meetingIndex: i, fixed: null }))
  ];
};

module.exports = { splitEvenly, lectureMeetings, labMeetings, meetingsForSubject, LECTURE_MODES, lectureModeOf };
