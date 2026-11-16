// The Generate Schedule page (Phase 2 Step 4's GA page, simple by default since Phase 3 Step 4): its
// settings and how a run reads. Every number the page offers (defaults, limits, modes) comes from the
// gateway, GET /api/schedule/ga-settings (the same content as shared/ga-settings.json); this file only
// names and explains the settings, checks what was typed against those limits, builds the request,
// and words a run's progress and outcome.
//
// Phase 3 Step 4: the GA settings, the TBA room mode and counts, and the technical results live in
// "Advanced (system team)", which only the roles of the permission map's advanced.edit open (Step 6:
// usePermission('advanced.edit'); the gateway refuses GA settings from anyone else: 403 ADVANCED_ONLY).
// Everyone else presses "Generate Mother Schedule" without settings: the run uses the defaults and a
// new random seed.

// How a run gets its TBA rooms (policy.overflowRooms.mode; the gateway resolves it before each run).
export const TBA_ROOM_MODES = ['auto', 'manual', 'off'];
export const TBA_ROOM_MODE_LABELS = { auto: 'Automatic', manual: 'Manual counts', off: 'Off' };
export const tbaRoomModeLabel = (mode) => TBA_ROOM_MODE_LABELS[mode] || TBA_ROOM_MODE_LABELS.auto;
// "3 TBA lab rooms and 1 TBA lecture room"
export const tbaRoomCountsText = ({ lab = 0, lec = 0 } = {}) => {
  const part = (n, type) => `${n} TBA ${type} room${n === 1 ? '' : 's'}`;
  return `${part(lab, 'lab')} and ${part(lec, 'lecture')}`;
};

// The settings the GA really uses, in the order the page shows them. `whole` = whole numbers only;
// `memeticOnly` = the Phase 1 GA (baseline mode) has its own fixed operators and ignores it.
export const GA_FIELDS = [
  {
    key: 'timeBudgetMinutes',
    label: 'Time budget',
    unit: 'minutes',
    step: 0.5,
    help: 'The GA stops when this time is used up, or earlier when it finds no better schedule.'
  },
  {
    key: 'populationSize',
    label: 'Population',
    unit: 'schedules',
    whole: true,
    step: 1,
    help: 'How many candidate schedules the GA keeps and improves at the same time.'
  },
  {
    key: 'mutationRate',
    label: 'Mutation rate',
    step: 0.01,
    help: 'The chance that a class is moved at random in a new schedule (higher for classes that break a hard rule).'
  },
  {
    key: 'crossoverRate',
    label: 'Crossover rate',
    step: 0.05,
    advanced: true,
    memeticOnly: true,
    help: "The chance that two schedules are combined into a new one (each section's classes come from one of them)."
  },
  {
    key: 'repairRate',
    label: 'Repair rate',
    step: 0.05,
    advanced: true,
    memeticOnly: true,
    help: 'The share of new schedules whose broken hard rules the GA tries to fix by moving classes (the best schedule is always repaired).'
  },
  {
    key: 'tournamentSize',
    label: 'Tournament size',
    unit: 'schedules',
    whole: true,
    step: 1,
    advanced: true,
    memeticOnly: true,
    help: 'How many schedules compete each time the GA picks a parent for a new schedule.'
  },
  {
    key: 'elitism',
    label: 'Elitism',
    unit: 'schedules',
    whole: true,
    step: 1,
    advanced: true,
    memeticOnly: true,
    help: 'How many of the best schedules are copied unchanged into the next generation.'
  }
];

export const MODE_LABELS = {
  memetic: 'Improved GA (memetic)',
  baseline: 'Phase 1 GA (for comparison)'
};
export const modeLabel = (mode) => MODE_LABELS[mode] || String(mode || '');

// The largest seed the GA accepts (the gateway draws a random one below 2^31 when none is given).
export const MAX_SEED = 2 ** 31 - 1;

// A run the gateway is still working on (the page follows it); anything else has ended.
export const isActiveRun = (run) => Boolean(run) && ['running', 'saving'].includes(run.status);

// The form (every value a string, as typed) filled with the gateway's defaults; the seed starts empty.
export const formFromDefaults = (defaults = {}) => ({
  mode: defaults.mode ?? '',
  ...Object.fromEntries(GA_FIELDS.map(f => [f.key, defaults[f.key] === undefined || defaults[f.key] === null ? '' : String(defaults[f.key])])),
  seed: ''
});

const toNumber = (value) => (String(value ?? '').trim() === '' ? NaN : Number(value));

// "1 to 10 minutes", "0 to 1"
export const rangeText = (field, limit) => {
  if (!limit) return '';
  return `${limit.min} to ${limit.max}${field.unit ? ` ${field.unit}` : ''}`;
};

// Fields the current mode does not use (the Phase 1 GA keeps its own operators).
export const unusedInMode = (field, mode) => Boolean(field.memeticOnly) && mode === 'baseline';

// Problems with what was typed, per field ({ key: message }), checked against the gateway's limits.
export const settingProblems = (form, limits = {}, modes = []) => {
  const problems = {};
  if (modes.length && !modes.includes(form.mode)) problems.mode = 'Choose the GA to run.';
  for (const field of GA_FIELDS) {
    if (unusedInMode(field, form.mode)) continue;
    const n = toNumber(form[field.key]);
    const limit = limits[field.key];
    const inRange = Number.isFinite(n) && (!limit || (n >= limit.min && n <= limit.max));
    if (!inRange || (field.whole && !Number.isInteger(n))) {
      problems[field.key] = limit
        ? `Enter ${field.whole ? 'a whole number' : 'a number'} from ${rangeText(field, limit)}.`
        : `Enter ${field.whole ? 'a whole number' : 'a number'}.`;
    }
  }
  const elitismField = GA_FIELDS.find(f => f.key === 'elitism');
  if (!problems.elitism && !problems.populationSize && !unusedInMode(elitismField, form.mode)
    && toNumber(form.elitism) > toNumber(form.populationSize) - 2) {
    // The gateway's rule (server/src/utils/gaSettings.js): room for the repaired best and a new child.
    problems.elitism = 'Keep elitism at least 2 below the population, so the GA still makes new schedules.';
  }
  const seed = String(form.seed ?? '').trim();
  if (seed !== '') {
    const n = Number(seed);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SEED) {
      problems.seed = `Leave it empty for a new random seed, or enter a whole number from 0 to ${MAX_SEED}.`;
    }
  }
  return problems;
};

// hyperparameters for POST /api/schedule/generate. The seed is left out when empty (the gateway then
// draws one and records it with the run); settings the chosen mode does not use are left out too.
export const buildHyperparameters = (form) => {
  const out = { mode: form.mode };
  for (const field of GA_FIELDS) {
    if (unusedInMode(field, form.mode)) continue;
    out[field.key] = Number(form[field.key]);
  }
  const seed = String(form.seed ?? '').trim();
  if (seed !== '') out.seed = Number(seed);
  return out;
};

// What a start sends (Phase 3 Step 4): the Advanced settings only when they differ from the
// gateway's defaults (a typed seed counts); null otherwise, so the run is the same as the Dean's (the
// defaults and a new random seed). `withSeed: false` is "Try again": the same settings, a new seed.
export const settingsToSend = (form, defaults, { withSeed = true } = {}) => {
  if (!form || !defaults) return null;
  const sent = buildHyperparameters(withSeed ? form : { ...form, seed: '' });
  const plain = buildHyperparameters(formFromDefaults(defaults));
  const same = Object.keys(sent).length === Object.keys(plain).length && Object.keys(sent).every(key => sent[key] === plain[key]);
  return same ? null : sent;
};

// 65000 -> "1:05" (minutes:seconds), for elapsed time against the budget.
export const formatClock = (ms) => {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// 4200 -> "4.2 s", 125000 -> "2 min 5 s".
export const formatDuration = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  const seconds = Math.round(n / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

// The run's time budget in milliseconds (the run record, else its progress, else its settings).
export const budgetMsOf = (run) => {
  const candidates = [run?.budgetMs, run?.progress?.budgetMs, Number(run?.settings?.timeBudgetSeconds) * 1000, Number(run?.settings?.timeBudgetMinutes) * 60000];
  return candidates.find(v => Number.isFinite(v) && v > 0) ?? null;
};

// Why a run stopped, in plain words.
export const stopReasonText = (stats) => {
  const stall = stats?.settings?.stallGenerations;
  const cap = stats?.settings?.maxGenerations;
  switch (stats?.stopReason) {
    case 'converged':
      return Number.isFinite(stall)
        ? `no better schedule found for ${stall} generations`
        : 'no better schedule found';
    case 'time-budget':
      return 'time budget used up';
    case 'generation-cap':
      return Number.isFinite(cap) ? `generation limit reached (${cap})` : 'generation limit reached';
    case 'cancelled':
      return 'cancelled';
    case 'no-demands':
      return 'there were no classes to place';
    default:
      return stats?.stopReason ? String(stats.stopReason) : 'not recorded';
  }
};

// The soft rules in the Dean's words: the code in gaStats.softBreakdown (penalty) and its count in
// gaStats.softCounts (the GA and the gateway validator count them the same way).
export const SOFT_RULE_ROWS = [
  { term: 'SAT_BLOCK', label: 'Saturday class blocks', countKey: 'saturdayBlocks', unit: ['block', 'blocks'] },
  { term: 'LEC_IN_LAB', label: 'Major lectures in a LAB room', countKey: 'lecturesInLab', unit: ['meeting', 'meetings'] },
  { term: 'EXTRA_ROOM', label: 'Classes in TBA rooms', countKey: 'extraRoomBlocks', unit: ['meeting', 'meetings'] },
  { term: 'SECTION_IDLE', label: "Idle hours in sections' days", countKey: 'sectionIdleHours', unit: ['hour', 'hours'] },
  { term: 'FACULTY_IDLE', label: "Idle hours in professors' days", countKey: 'facultyIdleHours', unit: ['hour', 'hours'] },
  // Phase 4 Part 1: once per TBA room in use, once per class before the preferred earliest start.
  { term: 'TBA_ROOM', label: 'TBA rooms in use', countKey: 'tbaRoomsUsed', unit: ['room', 'rooms'] },
  { term: 'EARLY_START', label: 'Classes before the preferred earliest start', countKey: 'earlyStarts', unit: ['class', 'classes'] },
  // Phase 8 Part 5: once per weekday on which a professor (or a section) has exactly one class.
  { term: 'FACULTY_SINGLE_DAY', label: "Professors' days with only one class", countKey: 'facultySingleClassDays', unit: ['day', 'days'] },
  { term: 'SECTION_SINGLE_DAY', label: "Sections' days with only one class", countKey: 'sectionSingleClassDays', unit: ['day', 'days'] }
];

// "3 blocks", "1 hour"; '' when not recorded.
export const countText = (count, unit) => (Number.isFinite(count) ? `${count} ${count === 1 ? unit[0] : unit[1]}` : '');

// A number as recorded, rounded for display ("—" when missing).
export const shownNumber = (value) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—');

// "10:42 AM" today, "Sep 29, 10:42 AM" on another day ('' when missing).
export const timeOf = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-US', sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// "Test Dean (Dean)"
export const personText = (person) => {
  if (!person?.name) return 'someone';
  return person.role ? `${person.name} (${person.role})` : person.name;
};

// The total number of hard rules a failed run's result broke ({ code: count } from the validator).
export const hardTotalOf = (run) => {
  const values = Object.values(run?.hard || {}).filter(Number.isFinite);
  if (values.length) return values.reduce((sum, v) => sum + v, 0);
  return Array.isArray(run?.violations) ? run.violations.length : null;
};

// ---------------------------------------------------------------- the plain words (Phase 3 Step 4)
// "3 conflicts", "1 conflict", "0 conflicts" (a conflict is a broken hard rule).
export const conflictsText = (n) => `${n} conflict${n === 1 ? '' : 's'}`;
const classesText = (n) => `${n} class${n === 1 ? '' : 'es'}`;

// A run record made before Phase 3 Step 4 (Phase 2): the gateway records the TBA rooms of every run it
// starts since then (tbaRooms) and the technical cause of a failure apart (detail); a Phase 2 record has
// neither, and its message is the technical text of that time.
const isPhase2Record = (run) => !run?.tbaRooms && !run?.detail;
// Phase 2's failure messages (server/src/utils/gaRuns.js at the time) and the gateway's words for the
// same outcome since Step 4.
const PHASE2_FAILURES = [
  [/^The term's data changed while the GA was running/, "The term's data changed while the schedule was being generated, so the result no longer matches it. Nothing was saved. Generate again."],
  [/^The GA returned no classes/, 'The scheduling service returned no classes, so nothing was saved. Try again.'],
  [/^The Python service no longer has this run/, 'The scheduling service no longer has this run (it may have restarted), so nothing was saved. Generate again.'],
  [/^The Python service stopped answering/, 'The scheduling service stopped answering during the run, so nothing was saved. Try again.'],
  [/^The result could not be saved/, 'The result could not be saved. Try again.'],
  [/after its time budget, so it was stopped/, 'The run went far past its time limit, so it was stopped. Nothing was saved. Try again.']
];
// The title of a failed run in the Dean's words: the gateway's own message since Step 4 ("The schedule
// still has 3 conflicts"); for a Phase 2 record, the same words built from what it recorded (its
// conflicts, else its known message), never its technical text.
export const failedRunTitle = (run) => {
  const message = String(run?.message || '').trim();
  if (!isPhase2Record(run)) return message || 'The run ended without saving a schedule.';
  const conflicts = hardTotalOf(run);
  if (conflicts > 0) return `The schedule still has ${conflictsText(conflicts)}`;
  return PHASE2_FAILURES.find(([pattern]) => pattern.test(message))?.[1] || 'The run ended without saving a schedule.';
};
// The technical cause of a failed run, for "Advanced" only: its detail, or the text a Phase 2 record
// stored as its message.
export const failedRunDetail = (run) => {
  if (run?.status !== 'failed') return run?.detail || '';
  return run.detail || (isPhase2Record(run) ? String(run.message || '').trim() : '');
};

// The progress line while a run goes: "Placing classes… 12 conflicts left", then "No conflicts.
// Improving the schedule…" (the best schedule so far, from the run's progress).
export const progressLine = (run) => {
  if (run?.cancelRequested) return 'Stopping the run… Nothing will be saved.';
  if (run?.status === 'saving') return 'Finished. Checking the result once more and saving it as a Draft…';
  const hard = run?.progress?.bestHard;
  if (!Number.isFinite(hard)) return 'Placing classes…';
  return hard > 0 ? `Placing classes… ${conflictsText(hard)} left` : 'No conflicts. Improving the schedule…';
};

// The facts of a saved run in the Dean's words, read from the run record (Phase 3 Step 4 fields), else
// from its gaStats (the same fields), else from what a Phase 2 run recorded (the classes in TBA rooms
// and on Saturday from the soft-rule counts, the TBA rooms used from "TBA rooms to request"). A fact
// that was not recorded is null.
export const runFacts = (run) => {
  const stats = run?.gaStats || {};
  const pick = (key) => (run?.[key] ?? stats[key] ?? null);
  const counts = stats.softCounts || {};
  const used = pick('tbaRoomsUsed') || (Array.isArray(stats.extraRoomUse) ? {
    lab: stats.extraRoomUse.filter(r => r.type === 'LAB').length,
    lec: stats.extraRoomUse.filter(r => r.type === 'LEC').length
  } : null);
  const number = (value) => (Number.isFinite(value) ? value : null);
  return {
    classesInTbaRooms: number(pick('classesInTbaRooms') ?? counts.extraRoomBlocks),
    tbaRoomsUsed: used && Number.isFinite(used.lab) && Number.isFinite(used.lec) ? { lab: used.lab, lec: used.lec } : null,
    saturdayClasses: number(pick('saturdayClasses') ?? counts.saturdayBlocks),
    noRoomClasses: number(pick('noRoomClasses')),
    // Phase 3 Step 7: the lectures held online (no room); the gateway records it only when there are some.
    onlineClasses: number(pick('onlineClasses')),
    runtimeMs: number(pick('runtimeMs')),
    // Phase 8 Part 5: the single-class days (professors' and sections'), with last year's manual
    // schedule's count beside them where the gateway has it. Part 6 (decision 5): a run that
    // recorded the professors' split carries it too — the part-timers' count must be 0, the
    // full-timers' is information only; a run from before the split keeps the two numbers.
    singleClassDays: (() => {
      const own = pick('singleClassDays');
      const split = (from) => (Number.isFinite(from.partTimers) && Number.isFinite(from.fullTimers)
        ? { partTimers: from.partTimers, fullTimers: from.fullTimers }
        : {});
      if (own && Number.isFinite(own.professors) && Number.isFinite(own.sections)) {
        return { professors: own.professors, sections: own.sections, ...split(own) };
      }
      return Number.isFinite(counts.facultySingleClassDays) && Number.isFinite(counts.sectionSingleClassDays)
        ? {
            professors: counts.facultySingleClassDays,
            sections: counts.sectionSingleClassDays,
            ...split({ partTimers: counts.facultySingleClassDaysPartTime, fullTimers: counts.facultySingleClassDaysFullTime })
          }
        : null;
    })(),
    lastYearSingleClassDays: pick('lastYearSingleClassDays')
  };
};

// "3 lab and 3 lecture rooms", "1 lab room", "2 lecture rooms".
const tbaRoomsWords = (lab, lec) => {
  const parts = [lab > 0 ? `${lab} lab` : null, lec > 0 ? `${lec} lecture` : null].filter(Boolean);
  return `${parts.join(' and ')} ${lab + lec === 1 ? 'room' : 'rooms'}`;
};
// Phase 4 Part 1 (Step 3): what the run really did, in the Dean's words. "85 classes are in TBA rooms:
// 3 lab and 3 lecture rooms to request." (the Readiness Check before the run gives minimums).
export const tbaClassesSentence = (facts) => {
  const n = facts.classesInTbaRooms;
  const rooms = facts.tbaRoomsUsed;
  if (n === null) return 'The classes in TBA rooms were not recorded for this run.';
  if (n === 0) return 'Every class that needs a room is in a CCS room: no TBA room to request.';
  const total = rooms ? rooms.lab + rooms.lec : null;
  return `${classesText(n)} ${n === 1 ? 'is' : 'are'} in ${n === 1 ? 'a TBA room' : 'TBA rooms'}${total ? `: ${tbaRoomsWords(rooms.lab, rooms.lec)} to request` : ''}.`;
};
// "30 classes need no CCS room, so they show TBA." (null when not recorded or none)
export const noRoomSentence = (facts) => (facts.noRoomClasses
  ? `${classesText(facts.noRoomClasses)} ${facts.noRoomClasses === 1 ? 'needs' : 'need'} no CCS room, so ${facts.noRoomClasses === 1 ? 'it shows' : 'they show'} TBA.`
  : null);
// "8 classes are held online, with no room." (null when not recorded or none)
export const onlineSentence = (facts) => (facts.onlineClasses
  ? `${classesText(facts.onlineClasses)} ${facts.onlineClasses === 1 ? 'is' : 'are'} held online, with no room.`
  : null);
// "4 classes are on Saturday (NSTP not counted)."
export const saturdaySentence = (facts) => {
  const n = facts.saturdayClasses;
  if (n === null) return 'The Saturday classes were not recorded for this run.';
  return n === 0 ? 'No class is on Saturday (NSTP not counted).' : `${classesText(n)} ${n === 1 ? 'is' : 'are'} on Saturday (NSTP not counted).`;
};
// Phase 8 Part 5: "Days with only one class: 4 for professors, 7 for sections (last year's manual
// schedule had 15 and 38)." Null for a run recorded before the counts existed. Part 6 (decision 5):
// a run that recorded the professors' split leads with the part-timers' count, which must be 0
// (part-timers come to campus only for their classes); the full-timers' and the sections' counts
// are information only. A run from before the split keeps the Part 5 sentence.
export const singleClassDaysSentence = (facts) => {
  const own = facts.singleClassDays;
  if (!own) return null;
  const lastYear = facts.lastYearSingleClassDays;
  const beside = lastYear && Number.isFinite(lastYear.professors) && Number.isFinite(lastYear.sections)
    ? ` (last year's manual schedule had ${lastYear.professors} and ${lastYear.sections})`
    : '';
  if (Number.isFinite(own.partTimers) && Number.isFinite(own.fullTimers)) {
    const partText = own.partTimers === 0
      ? 'No part-time professor has a day with only one class.'
      : `${own.partTimers} part-time professor day${own.partTimers === 1 ? ' has' : 's have'} only one class — this should be 0: move a class in the editor, or generate again.`;
    return `${partText} Days with only one class, information only: ${own.fullTimers} for full-time professors, ${own.sections} for sections${beside}.`;
  }
  return `Days with only one class: ${own.professors} for professors, ${own.sections} for sections${beside}.`;
};

// ---------------------------------------------------------------- the Chapter 4 numbers ("Advanced")
// The conflict resolution rate: (conflicts in the best starting schedule − conflicts at the end) /
// conflicts at the start × 100%, one decimal (as benchmarks/phase2_benchmark.py reports it).
export const resolutionRateText = (stats) => {
  const start = stats?.initialHard;
  const end = stats?.finalHard;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'not recorded';
  if (start === 0) return 'n/a (no conflict in the starting schedule)';
  return `${Math.round(((start - end) / start) * 1000) / 10}% (${start - end} of ${start} resolved)`;
};
// The GA's fitness: −(100000 × conflicts + soft penalty), the formula of Engine 3 (constraints.py
// HARD_WEIGHT) and the gateway's validator (server/src/utils/constraints.js); null when not recorded.
const HARD_WEIGHT = 100000;
export const fitnessOf = (stats) => {
  const hard = stats?.finalHard;
  const soft = stats?.soft ?? stats?.softTotal;
  return Number.isFinite(hard) && Number.isFinite(soft) ? -(HARD_WEIGHT * hard + soft) : null;
};
