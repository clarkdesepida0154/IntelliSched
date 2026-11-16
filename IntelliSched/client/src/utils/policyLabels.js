// Display text for Scheduling Policy settings. Values always come from the policy document
// (GET /api/policy); this file only names and explains them.

// Soft-constraint weights (policy.softWeights), in the order the pages show them. Each weight is
// the penalty for one occurrence, counted per `unit`. `term` is the rule's code in a version's
// gaStats.softBreakdown and `countKey` its count in gaStats.softCounts (the GA and the gateway
// validator count them the same way). `addedInPhase2` marks the rules a policy saved in Phase 1
// may still hold at 0 (the pages then suggest setting them or pressing "Reset to defaults").
// `status` says what the scheduler does with the weight today, so no page claims more than is true:
//   'ga'  the GA uses it in its fitness and the gateway validator in its soft score
export const SOFT_WEIGHTS = [
  {
    key: 'saturdayBlock',
    label: 'Saturday class block',
    unit: 'per block',
    help: 'Penalty for each class block (other than NSTP) placed on Saturday as overflow.',
    term: 'SAT_BLOCK',
    countKey: 'saturdayBlocks',
    countUnit: 'blocks',
    status: 'ga'
  },
  {
    key: 'lectureInLab',
    label: 'Major lecture in a LAB room',
    unit: 'per meeting',
    help: 'Penalty for each Major lecture meeting placed in a LAB room (a CCS or a TBA lab room), when that is allowed with a penalty.',
    term: 'LEC_IN_LAB',
    countKey: 'lecturesInLab',
    countUnit: 'meetings',
    status: 'ga'
  },
  {
    // Phase 3 Step 4: Phase 2's "extra rooms" are TBA rooms; this is the one name of the weight on every
    // page (the Scheduling Policy, the Generate Schedule page's penalty weights, Versions).
    key: 'overflowRoomBlock',
    label: 'Class in a TBA room',
    unit: 'per meeting',
    help: 'Penalty for each class meeting placed in a TBA room instead of a CCS room. Keep it below the Saturday weight, so TBA rooms on weekdays come before Saturday.',
    term: 'EXTRA_ROOM',
    countKey: 'extraRoomBlocks',
    countUnit: 'meetings',
    addedInPhase2: true,
    status: 'ga'
  },
  {
    key: 'sectionGapHour',
    label: "Idle hour in a section's day",
    unit: 'per hour',
    help: "Penalty for each idle hour in a section's class day.",
    term: 'SECTION_IDLE',
    countKey: 'sectionIdleHours',
    countUnit: 'hours',
    addedInPhase2: true,
    status: 'ga'
  },
  {
    key: 'facultyGapHour',
    label: "Idle hour in a professor's day",
    unit: 'per hour',
    help: "Penalty for each idle hour in a professor's class day. TBA professors have none.",
    term: 'FACULTY_IDLE',
    countKey: 'facultyIdleHours',
    countUnit: 'hours',
    addedInPhase2: true,
    status: 'ga'
  },
  {
    // Phase 4 Part 1: fewer TBA rooms to request. Counted once per TBA room that holds a class.
    key: 'tbaRoomUsed',
    label: 'TBA room in use',
    unit: 'per room',
    help: 'Penalty for each TBA room (a room to request) that holds at least one class, so the schedule packs the classes it cannot fit into the CCS rooms into as few TBA rooms as possible.',
    term: 'TBA_ROOM',
    countKey: 'tbaRoomsUsed',
    countUnit: 'rooms',
    status: 'ga'
  },
  {
    // Phase 4 Part 1: fewer classes before 08:00 (the preferred earliest start, a setting next to it).
    key: 'earlyStart',
    label: 'Class before the preferred earliest start',
    unit: 'per class',
    help: 'Penalty for each class (other than NSTP) that starts before the preferred earliest start. Classes may still start when the class day starts, but it costs a little.',
    term: 'EARLY_START',
    countKey: 'earlyStarts',
    countUnit: 'classes',
    status: 'ga'
  },
  {
    // Phase 8 Part 5: no coming to school for one class (the College Secretary's rule). Phase 8
    // Part 6 (decision 5a) scoped it to part-timers, who come to campus only for their classes;
    // the full-timers' own weight is the next row.
    key: 'facultySingleClassDay',
    label: "Part-time professor's day with only one class",
    unit: 'per day',
    help: 'Penalty for each weekday on which a part-time professor has exactly one class meeting, so a lone class joins the rest of that professor’s week where it costs nothing. While “Part-time professors never have a day with only one class” (Meetings) is on, such a day is a conflict as well. A part-timer whose classes can’t all share days is exempt; NSTP’s Saturday block and the On-The-Job Training records never count.',
    term: 'FACULTY_SINGLE_DAY',
    countKey: 'facultySingleClassDaysPartTime',
    countUnit: 'days',
    status: 'ga'
  },
  {
    // Phase 8 Part 6 (decision 5a): the full-timers' own weight, 0 by default — they are on
    // campus for their duties anyway, so a lone class day is allowed unless the team prices it.
    key: 'fullTimerSingleClassDay',
    label: "Full-time professor's day with only one class",
    unit: 'per day',
    help: 'Penalty for each weekday on which a full-time professor has exactly one class meeting. 0 means such days are allowed: full-timers are on campus for their other duties anyway. Their count still shows on the Generate result as information.',
    term: 'FACULTY_SINGLE_DAY',
    countKey: 'facultySingleClassDaysFullTime',
    countUnit: 'days',
    status: 'ga'
  },
  {
    // Phase 8 Part 5: the lighter penalty of the pair, for a section's single-class day.
    key: 'sectionSingleClassDay',
    label: "Section's day with only one class",
    unit: 'per day',
    help: 'Penalty for each weekday on which a section has exactly one class meeting (lighter than the professor’s: students’ days are harder to free). NSTP’s Saturday block never counts.',
    term: 'SECTION_SINGLE_DAY',
    countKey: 'sectionSingleClassDays',
    countUnit: 'days',
    status: 'ga'
  }
];

export const SOFT_WEIGHT_STATUS_LABELS = {
  ga: 'Used when the schedule is generated and checked'
};

// One plain sentence on idle time, with the policy's lunch numbers.
export const idleTimeExplanation = (policy) => {
  const lunch = policy?.lunch;
  const lunchPart = lunch?.enabled
    ? `, minus the ${lunch.minFreeMinutes}-minute lunch break of the lunch rule`
    : ' (the lunch rule is off, so no lunch break is subtracted)';
  return `Idle time is the time between a day's first class and its last class that is not class time${lunchPart}.`;
};

// The new rules (added in Phase 2) that a saved policy holds at 0: [{ key, label }].
export const zeroNewSoftWeights = (softWeights) =>
  SOFT_WEIGHTS.filter(w => w.addedInPhase2 && softWeights?.[w.key] === 0);

export const MAJOR_LECTURE_IN_LAB_OPTIONS = [
  { value: 'NEVER', label: 'Never: LEC rooms only' },
  { value: 'PENALTY', label: 'Allowed, with a penalty' },
  { value: 'FREE', label: 'Allowed freely' }
];

// Meeting patterns offered for a 3-hour lecture (hours per meeting).
export const THREE_HOUR_PATTERNS = [
  { value: [3], label: 'One 3-hour meeting' },
  { value: [2, 1], label: '2 h + 1 h' },
  { value: [1.5, 1.5], label: '1.5 h + 1.5 h' },
  { value: [1, 1, 1], label: '1 h + 1 h + 1 h' }
];

// Ancillary (non-teaching) hour types, as on the SF-029 Teachers' Program. The keys are the
// Faculty.ancillary[].type values the gateway accepts.
export const ANCILLARY_TYPE_LABELS = {
  MANAGEMENT_FUNCTION: 'Management Function',
  RESEARCH: 'Research',
  EXTENSION: 'Extension',
  CEE: 'Competitive Edge Enhancement',
  CONSULTATION: 'Consultation / Preparation'
};

export const EMPLOYMENT_LABELS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
