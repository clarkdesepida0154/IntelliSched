// On-The-Job Training boxes on the Teachers' Program (Phase 4 Part 4, Step 1). The real SF-029s draw a
// practicum coordinator's hours on the grid as boxes reading the practicum code, "On-The-Job Training"
// and the section ("ITEP 503 / On-The-Job Training / BSIT 4B AMG"); in 2nd Sem AY 2025-26 every
// coordinator had 4 h + 2 h on one weekday (docs/data/past_class_blocks.csv, kind OJT). Since Phase 8
// Part 3 this print-time fill serves only versions saved without On-The-Job Training records (decision
// 2 places real schedule records at save time; a version that has them never calls this). It puts each
// coordination's hours (policy.load.ojtCoordinatorHours, 6 by default) into the professor's free
// weekday time:
//   - weekdays only, inside the policy's weekday window, on the policy's slot grid;
//   - blocks of 2 to 4 hours (6 h = 4 h + 2 h), the second block on the same day as the first when it
//     fits there, as on the real forms;
//   - the days with classes first, the lightest first (the office's own practice: Faculty's OJT sits
//     on her Thursday next to one lecture), and never the weekday the Extension duty keeps free
//     (`reservedDay`, utils/ancillaryFill.js extensionDayOf) unless nothing else fits — Phase 8
//     Part 3, so an old version's print matches the office's way like a new one's records;
//   - never over a class, an unavailable time or another box, and every day that gets a box keeps the
//     lunch rule's continuous free time inside its window (only drawn blocks make time busy, as in the
//     validator's lunch rule);
//   - placed BEFORE the ancillary fill (utils/ancillaryFill.js takes these boxes as classes), so the
//     duty blocks go around them;
//   - deterministic: the same input always gives the same picture. Computed for a view or a print and
//     never stored. Hours that fit nowhere are returned as `unplaced`; the load summary (utils/load.js)
//     still counts them.
const { toMinutes, fromMinutes, hasFreeRun } = require('./timeGrid');

const PRACTICUM_LABEL = 'On-The-Job Training';
const MIN_BLOCK = 120;
const MAX_BLOCK = 240;
// The real forms' starts: the morning block at 08:00, the afternoon one at 13:00.
const PREFERRED_STARTS = ['08:00', '13:00', '11:00'];

// Minutes as blocks of 2 to 4 hours: 4-hour blocks, the last one 2 to 4 hours (6 h -> 4 + 2, 5 h -> 3 + 2,
// 8 h -> 4 + 4). Under 2 hours in all, one short block.
const chunksFor = (minutes) => {
  if (minutes <= 0) return [];
  if (minutes <= MAX_BLOCK) return [minutes];
  const chunks = [];
  let left = minutes;
  while (left > MAX_BLOCK) {
    chunks.push(MAX_BLOCK);
    left -= MAX_BLOCK;
  }
  if (left >= MIN_BLOCK) chunks.push(left);
  else {
    // A short tail takes what it needs from the block before it (both stay 2 h or more).
    const need = MIN_BLOCK - left;
    chunks[chunks.length - 1] -= need;
    chunks.push(left + need);
  }
  return chunks;
};

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const byText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });

// coordinations: [{ subjectCode, subjectTitle?, sectionId?, sectionLabel, hours }], one per practicum the
//   professor coordinates (the load's practicum assignments, hours = policy.load.ojtCoordinatorHours).
// classes: [{ day, start, end }] the professor's class blocks in the version ("HH:MM").
// unavailable: [{ day, start, end }] the profile's unavailable times.
// reservedDay: the weekday the Extension duty keeps free (null when none): tried last.
// Returns { blocks: [{ kind: 'practicum', subjectCode, subjectTitle, label, sectionId, sectionLabel, day,
//   start, end, hours }], unplaced: [{ subjectCode, sectionLabel, label, hours }] }.
const fillPracticum = ({ coordinations = [], classes = [], unavailable = [], policy, reservedDay = null }) => {
  const slot = policy.slotMinutes;
  const dayStart = toMinutes(policy.dayStart);
  const dayEnd = toMinutes(policy.dayEnd);
  const days = [...(policy.weekdays || [])];
  const lunch = policy.lunch || {};
  const lunchStart = toMinutes(lunch.windowStart);
  const lunchEnd = toMinutes(lunch.windowEnd);

  // occupied: what a box may not cover (classes, unavailable times, other boxes).
  // drawn: what makes time busy for the lunch rule (classes and boxes).
  const occupied = Object.fromEntries(days.map(d => [d, []]));
  const drawn = Object.fromEntries(days.map(d => [d, []]));
  const classMinutes = Object.fromEntries(days.map(d => [d, 0]));
  const addTo = (targets, list, countClass = false) => (list || []).forEach(b => {
    const start = toMinutes(b?.start);
    const end = toMinutes(b?.end);
    if (!occupied[b?.day] || start === null || end === null || end <= start) return;
    targets.forEach(t => t[b.day].push({ start, end }));
    if (countClass) classMinutes[b.day] += end - start;
  });
  addTo([occupied, drawn], classes, true);
  addTo([occupied], unavailable);
  const lunchKept = (list) => !lunch.enabled || hasFreeRun(list, lunchStart, lunchEnd, lunch.minFreeMinutes);

  const starts = (len) => {
    const out = [];
    const add = (m) => { if (m !== null && m >= dayStart && m + len <= dayEnd && m % slot === 0 && !out.includes(m)) out.push(m); };
    PREFERRED_STARTS.forEach(t => add(toMinutes(t)));
    for (let m = Math.ceil(dayStart / 60) * 60; m < dayEnd; m += 60) add(m);
    for (let m = dayStart; m < dayEnd; m += slot) add(m);
    return out;
  };

  const blocks = [];
  // The day the coordination's first box took, tried first for its next box (one day per coordination,
  // as on the real forms); then the days WITH classes, the lightest first (Phase 8 Part 3: the office
  // puts the OJT next to a class day, as Faculty's Thursday); then the class-free days in the week's
  // order; the Extension duty's day (`reservedDay`) always last.
  const place = (coordination, len, sameDay) => {
    const order = [...days].sort((a, b) =>
      (Number(b === sameDay) - Number(a === sameDay)) ||
      (Number(a === reservedDay) - Number(b === reservedDay)) ||
      (Number(classMinutes[b] > 0) - Number(classMinutes[a] > 0)) ||
      (classMinutes[a] - classMinutes[b]) ||
      (days.indexOf(a) - days.indexOf(b)));
    for (const day of order) {
      for (const start of starts(len)) {
        const block = { start, end: start + len };
        if (occupied[day].some(b => overlaps(b, block))) continue;
        if (!lunchKept([...drawn[day], block])) continue;
        occupied[day].push(block);
        drawn[day].push(block);
        blocks.push({
          kind: 'practicum',
          subjectCode: coordination.subjectCode,
          subjectTitle: coordination.subjectTitle || '',
          label: PRACTICUM_LABEL,
          sectionId: coordination.sectionId ?? null,
          sectionLabel: coordination.sectionLabel,
          day,
          start: fromMinutes(start),
          end: fromMinutes(start + len),
          hours: len / 60
        });
        return day;
      }
    }
    return null;
  };

  const unplaced = [];
  const ordered = [...coordinations].sort((a, b) => byText(a.sectionLabel, b.sectionLabel) || byText(a.subjectCode, b.subjectCode));
  for (const coordination of ordered) {
    const minutes = Math.round(((Number(coordination.hours) || 0) * 60) / slot) * slot;
    if (!(minutes > 0)) continue;
    const queue = chunksFor(minutes);
    let sameDay = null;
    let left = 0;
    while (queue.length) {
      const len = queue.shift();
      const day = place(coordination, len, sameDay);
      if (day) {
        sameDay = sameDay || day;
        continue;
      }
      // A block that fits nowhere is tried as two shorter ones of 2 h or more.
      if (len >= 2 * MIN_BLOCK) queue.unshift(MIN_BLOCK, len - MIN_BLOCK);
      else left += len;
    }
    if (left > 0) unplaced.push({ subjectCode: coordination.subjectCode, sectionLabel: coordination.sectionLabel, label: PRACTICUM_LABEL, hours: left / 60 });
  }

  blocks.sort((a, b) => (days.indexOf(a.day) - days.indexOf(b.day)) || (toMinutes(a.start) - toMinutes(b.start)));
  return { blocks, unplaced };
};

module.exports = { PRACTICUM_LABEL, chunksFor, fillPracticum };
