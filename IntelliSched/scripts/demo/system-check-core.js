// The system check's report builder (Phase 8 Part 2, decision 5): pure functions, no network and no
// database, so the server test suite can run them on made-up schedules. The orchestrator
// (system-check.js) gathers the facts through the same routes as the pages and hands them here; this
// file re-checks the saved schedule INDEPENDENTLY — its own small re-implementation of the Dean's
// rules, on the saved classes, next to (never instead of) the validator's verdict — and words every
// line ✔ or ✖ with its number. Nothing here ever prints a rating.
const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const overlap = (a, b) => a.day === b.day && toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime);
const hoursOf = (c) => (toMinutes(c.endTime) - toMinutes(c.startTime)) / 60;
const round2 = (n) => Math.round(n * 100) / 100;
const numberText = (n) => String(round2(Number(n) || 0));
const time12 = (t) => { const m = toMinutes(t); const h = Math.floor(m / 60); return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const classWord = (c) => `${c.subjectCode} (${c.sectionLabel || c.sectionCode}), ${c.day} ${time12(c.startTime)}–${time12(c.endTime)}`;

const pass = (text) => ({ status: 'pass', text });
const failLine = (text) => ({ status: 'fail', text });
// A rule line: ✔ with its count when nothing broke it, ✖ naming the first offenders otherwise.
const ruleLine = (okText, problems, { show = 3 } = {}) => (problems.length === 0
  ? pass(okText)
  : failLine(`${problems.length} ${problems.length === 1 ? 'class breaks' : 'classes break'} this rule: ${problems.slice(0, show).join('; ')}${problems.length > show ? `; and ${problems.length - show} more` : ''}`));

// ---------------------------------------------------------------- the independent pass
// Re-checks the saved schedule with its own code (the prompt's seven re-checks, plus Part 4's
// Extension-day re-check and Part 5's single-class-day counts), reading the limits from the
// version's own policy so the lines quote the real numbers. `professors` (Phase 8 Part 4): the
// faculty records ({ id, name, employmentType, extensionDay }) for the Extension-day rule — the day
// is resolved here, independently. `lastYearSingleDays` (Phase 8 Part 5): last year's manual
// schedule's single-class days ({ professors, sections }), shown beside this schedule's own counts.
const independentScheduleChecks = ({ classes = [], policy = {}, catalog = [], professors = [], lastYearSingleDays = null }) => {
  const lines = [];
  const weekdays = (policy.weekdays || []).filter(d => d !== 'Saturday');
  const dayStart = policy.dayStart || '08:00';
  const dayEnd = policy.dayEnd || '17:00';
  const nstp = policy.nstp || { day: 'Saturday', start: '08:00', end: '12:00' };
  const saturday = policy.saturdayOverflow || { enabled: false };
  const placed = classes.filter(c => c.day && c.startTime && c.endTime);

  // 1. Every class on a weekday inside the day window, except NSTP in its Saturday block (and, only
  // while the Saturday switch is on, overflow classes in the Saturday window).
  const windowProblems = [];
  for (const c of placed) {
    if (c.isNstp || c.isFixed) {
      if (c.day !== nstp.day || toMinutes(c.startTime) < toMinutes(nstp.start) || toMinutes(c.endTime) > toMinutes(nstp.end)) {
        windowProblems.push(`${classWord(c)} is outside the NSTP block (${nstp.day} ${time12(nstp.start)}–${time12(nstp.end)})`);
      }
      continue;
    }
    const inWeekdays = weekdays.includes(c.day) && toMinutes(c.startTime) >= toMinutes(dayStart) && toMinutes(c.endTime) <= toMinutes(dayEnd);
    const inSaturday = saturday.enabled && c.day === 'Saturday' && toMinutes(c.startTime) >= toMinutes(saturday.start) && toMinutes(c.endTime) <= toMinutes(saturday.end);
    if (!inWeekdays && !inSaturday) windowProblems.push(`${classWord(c)} sits outside Monday–Friday ${time12(dayStart)}–${time12(dayEnd)}`);
  }
  // Class meetings and On-The-Job Training records are counted APART (Phase 8 Part 4, Step 0): a
  // coordination is usually two records (morning + afternoon on one day), but one split over two days
  // adds a third, so folding them into one number made the totals look wrong next to Part 2's.
  const ojtPlaced = placed.filter(c => c.classType === 'OJT').length;
  const placedWord = ojtPlaced > 0
    ? `All ${placed.length - ojtPlaced} class meetings and ${ojtPlaced} On-The-Job Training record${ojtPlaced === 1 ? '' : 's'}`
    : `All ${placed.length} class meetings`;
  lines.push(ruleLine(`${placedWord} sit Monday–Friday ${time12(dayStart)}–${time12(dayEnd)}, except NSTP in its Saturday ${time12(nstp.start)}–${time12(nstp.end)} block.`, windowProblems));

  // 2. Full-length labs start only at the policy's lab start times (08:00, 11:00 or 14:00).
  const labStarts = (policy.meetings?.labStartTimes || ['08:00', '11:00', '14:00']);
  const labWords = labStarts.map(time12).join(', ');
  const fullLabs = placed.filter(c => c.classType === 'LAB' && hoursOf(c) >= 3);
  const labProblems = fullLabs.filter(c => !labStarts.includes(c.startTime)).map(c => `${classWord(c)} starts at ${time12(c.startTime)}`);
  lines.push(ruleLine(`All ${fullLabs.length} three-hour labs start at ${labWords}.`, labProblems));

  // 3. A continuous free hour between the lunch window's ends, for every section and professor, on
  // each day they have classes.
  const lunch = policy.lunch || {};
  const lunchStart = toMinutes(lunch.start || '10:00');
  const lunchEnd = toMinutes(lunch.end || '15:00');
  const minFree = Number(lunch.minFreeMinutes) || 60;
  const hasFreeRun = (busy) => {
    const clipped = busy
      .map(b => ({ start: Math.max(toMinutes(b.startTime), lunchStart), end: Math.min(toMinutes(b.endTime), lunchEnd) }))
      .filter(b => b.end > b.start)
      .sort((a, b) => a.start - b.start);
    let cursor = lunchStart;
    for (const b of clipped) {
      if (b.start - cursor >= minFree) return true;
      cursor = Math.max(cursor, b.end);
    }
    return lunchEnd - cursor >= minFree;
  };
  const lunchProblems = [];
  const whoDays = new Map(); // "section:<id>" / "professor:<ref>" -> day -> classes
  for (const c of placed) {
    // Phase 8 Part 8 (decision 4): an outside teacher (a GenEd class's teacher from outside CCS) keeps
    // the lunch hour too.
    const keys = [c.sectionId ? `section ${c.sectionLabel || c.sectionCode}|section:${c.sectionId}` : null, c.facultyRef ? `${c.facultyName}|professor:${c.facultyRef}` : null, !c.facultyRef && c.outsideTeacherRef ? `${c.facultyName} (outside teacher)|outside:${c.outsideTeacherRef}` : null].filter(Boolean);
    for (const key of keys) {
      if (!whoDays.has(key)) whoDays.set(key, new Map());
      const days = whoDays.get(key);
      if (!days.has(c.day)) days.set(c.day, []);
      days.get(c.day).push(c);
    }
  }
  let lunchDaysChecked = 0;
  for (const [key, days] of whoDays) {
    for (const [day, list] of days) {
      lunchDaysChecked += 1;
      if (!hasFreeRun(list)) lunchProblems.push(`${key.split('|')[0]} has no free hour between ${time12(lunch.start || '10:00')} and ${time12(lunch.end || '15:00')} on ${day}`);
    }
  }
  lines.push(lunchProblems.length === 0
    ? pass(`Every section and professor keeps a free hour between ${time12(lunch.start || '10:00')} and ${time12(lunch.end || '15:00')} on each of their ${lunchDaysChecked} class days.`)
    : failLine(`${lunchProblems.length} class day${lunchProblems.length === 1 ? '' : 's'} without the free lunch hour: ${lunchProblems.slice(0, 3).join('; ')}${lunchProblems.length > 3 ? `; and ${lunchProblems.length - 3} more` : ''}`));

  // 4. A subject's meetings for one section fall on different days. The On-The-Job Training records
  // (Phase 8 Part 3) stay out: a coordination's morning and afternoon blocks share one weekday on
  // purpose, as on all four coordinators' real forms (Faculty's Thursday 8–12 and 1–3).
  const meetingDays = new Map();
  for (const c of placed.filter(c => !c.isNstp && c.classType !== 'OJT')) {
    const key = `${c.subjectCode} (${c.sectionLabel || c.sectionCode})|${c.subjectId}|${c.sectionId}`;
    if (!meetingDays.has(key)) meetingDays.set(key, []);
    meetingDays.get(key).push(c.day);
  }
  const sameDay = [...meetingDays.entries()].filter(([, days]) => new Set(days).size !== days.length);
  lines.push(sameDay.length === 0
    ? pass(`Every subject's meetings for one section fall on different days (${meetingDays.size} subject-section pairs).`)
    : failLine(`${sameDay.length} subject${sameDay.length === 1 ? ' has' : 's have'} two meetings on one day: ${sameDay.slice(0, 3).map(([key, days]) => `${key.split('|')[0]} on ${days.join(', ')}`).join('; ')}`));

  // 5. No professor or section double-booked.
  const clashProblems = [];
  const byKey = (keyOf) => {
    const groups = new Map();
    for (const c of placed) {
      const key = keyOf(c);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return groups;
  };
  // Phase 8 Part 8 (decision 4): an outside teacher is never in two classes at once, in any week group.
  const anyOutside = placed.some(c => !c.facultyRef && c.outsideTeacherRef);
  for (const [kind, groups] of [['professor', byKey(c => c.facultyRef && `${c.facultyName}|${c.facultyRef}`)], ['outside teacher', byKey(c => !c.facultyRef && c.outsideTeacherRef && `${c.facultyName}|${c.outsideTeacherRef}`)], ['section', byKey(c => c.sectionId && `${c.sectionLabel || c.sectionCode}|${c.sectionId}`)]]) {
    for (const [key, list] of groups) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (overlap(list[i], list[j])) clashProblems.push(`${key.split('|')[0]} (${kind}): ${classWord(list[i])} against ${list[j].subjectCode} ${time12(list[j].startTime)}–${time12(list[j].endTime)}`);
        }
      }
    }
  }
  lines.push(clashProblems.length === 0
    ? pass(anyOutside ? 'No professor, outside teacher or section is double-booked.' : 'No professor and no section is double-booked.')
    : failLine(`${clashProblems.length} double-booking${clashProblems.length === 1 ? '' : 's'}: ${clashProblems.slice(0, 3).join('; ')}${clashProblems.length > 3 ? `; and ${clashProblems.length - 3} more` : ''}`));

  // 6. A room hour holds at most one class per week group (with the odd/even practice off, at most one
  // class at all; a class without a group meets every week, so it clashes with either group).
  const weekGroupsOn = Boolean(policy.weekGroups?.enabled);
  const roomProblems = [];
  const byRoom = byKey(c => c.roomKey || null);
  for (const [roomKey, list] of byRoom) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!overlap(a, b)) continue;
        const shared = weekGroupsOn && a.weekGroup && b.weekGroup && a.weekGroup !== b.weekGroup;
        if (!shared) roomProblems.push(`${a.roomName || roomKey}: ${classWord(a)} against ${classWord(b)}${weekGroupsOn ? ' (the same weeks)' : ''}`);
      }
    }
  }
  lines.push(roomProblems.length === 0
    ? pass(weekGroupsOn
      ? 'Each room hour holds at most one class per week group (one odd-week and one even-week class may share it).'
      : 'Each room hour holds at most one class.')
    : failLine(`${roomProblems.length} room double-booking${roomProblems.length === 1 ? '' : 's'}: ${roomProblems.slice(0, 3).join('; ')}`));

  // 7. The Minor rooms per the per-class rule: a Minor class gets a room when a CCS professor is
  // assigned to it or its "Needs a CCS room" box is ticked; with the professor TBA and the box
  // unticked, another college teaches it in its own rooms — no CCS room.
  const requiresRoom = new Map(catalog.map(s => [String(s._id ?? s.id), Boolean(s.requiresRoom)]));
  const minorProblems = [];
  for (const c of placed.filter(c => c.isMinor && !c.isNstp)) {
    const needs = Boolean(c.facultyRef) || requiresRoom.get(String(c.subjectId)) === true;
    const hasRoom = Boolean(c.roomKey);
    if (needs && !hasRoom) minorProblems.push(`${classWord(c)} needs a room (a CCS professor or a ticked box) but has none`);
    if (!needs && hasRoom) minorProblems.push(`${classWord(c)} takes ${c.roomName || 'a room'} although another college teaches it in its own rooms`);
  }
  const minors = placed.filter(c => c.isMinor && !c.isNstp).length;
  lines.push(ruleLine(`All ${minors} Minor classes follow the per-class room rule (a room only with a CCS professor or a ticked "Needs a CCS room" box).`, minorProblems));

  // 8. Every full-timer's Extension day is class-free (Phase 8 Part 4, decision 4): the policy's
  // "Full-time faculty's day for Extension" (or the professor's own override; 'None' switches it
  // off) holds none of that professor's classes or On-The-Job Training records. Resolved here,
  // independently of the gateway's own rule.
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const extensionDayOf = (p) => {
    if (p.employmentType !== 'FULL_TIME') return null;
    const chosen = String(p.extensionDay || '').trim() || String(policy.extensionDay || 'none');
    return WEEKDAY_NAMES.find(d => d.toLowerCase() === chosen.toLowerCase()) || null;
  };
  const extensionProblems = [];
  let fullTimersWithDay = 0;
  for (const p of professors) {
    const day = extensionDayOf(p);
    if (!day) continue;
    fullTimersWithDay += 1;
    for (const c of placed.filter(c => c.facultyRef && String(c.facultyRef) === String(p.id) && c.day === day)) {
      extensionProblems.push(`${p.name} has ${c.subjectCode} (${c.sectionLabel || c.sectionCode}) on ${day}, their day for Extension`);
    }
  }
  if (professors.length) {
    lines.push(fullTimersWithDay === 0
      ? pass('No day is reserved for Extension (the policy has none and no professor sets one).')
      : ruleLine(`Every full-timer's Extension day is class-free (${fullTimersWithDay} full-timer${fullTimersWithDay === 1 ? '' : 's'} checked${policy.extensionDay && policy.extensionDay !== 'none' ? `; the policy's day is ${policy.extensionDay}` : ''}).`, extensionProblems));
  }

  // 9. Single-class days (Phase 8 Part 5), counted here independently: weekdays on which a
  // professor (or a section) has exactly one class meeting — the OJT records are not class
  // meetings, and Saturday (NSTP's day) never counts — with last year's manual schedule's counts
  // beside them. Information with its number, never a failure: the GA already pays a penalty per
  // such day, and some lone classes cost nothing to keep.
  const singleDayCount = (keyOf) => {
    const groups = new Map();
    for (const c of placed) {
      if (c.classType === 'OJT' || ['Saturday', 'Sunday'].includes(c.day)) continue;
      const key = keyOf(c);
      if (!key) continue;
      const k = `${key}|${c.day}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    return [...groups.values()].filter(n => n === 1).length;
  };
  const professorSingles = singleDayCount(c => c.facultyRef);
  const sectionSingles = singleDayCount(c => c.sectionId);
  lines.push(pass(`Days with only one class: ${professorSingles} professor day${professorSingles === 1 ? '' : 's'} and ${sectionSingles} section day${sectionSingles === 1 ? '' : 's'}${lastYearSingleDays
    ? ` (last year's manual schedule had ${lastYearSingleDays.professors} and ${lastYearSingleDays.sections}, from the transcribed forms, CCS-taught classes only)`
    : ''}.`));

  // 10. Part-timers' single-class weekdays (Phase 8 Part 6, decision 5), re-counted here
  // independently of the GA and the validator: a part-time professor comes to campus only for
  // their classes, so no weekday of theirs may hold exactly one class meeting. The OJT records
  // are not class meetings, and Saturday and Sunday never count. A part-timer is exempt when a
  // lone day cannot be avoided: fewer than two class meetings in the week; more meetings of one
  // subject for one section than all their others together (those fall on different days); or an
  // odd number of meetings when no three of them (three different subjects-for-a-section) fit in
  // one class day less its lunch hour. ✖ names the professor, the class and the day; this one
  // must be 0.
  const sameSubjectApart = policy.meetings?.sameSubjectDifferentDays !== false;
  const dayMinutes = toMinutes(dayEnd) - toMinutes(dayStart) - (policy.lunch?.enabled === false ? 0 : Number(policy.lunch?.minFreeMinutes ?? 60));
  const loneDayUnavoidable = (meetings) => {
    if (meetings.length < 2) return true;
    const pairOf = (c) => `${c.sectionId}|${c.subjectId}`;
    if (sameSubjectApart) {
      const perPair = new Map();
      for (const c of meetings) perPair.set(pairOf(c), (perPair.get(pairOf(c)) || 0) + 1);
      const largest = Math.max(...perPair.values());
      if (largest > meetings.length - largest) return true;
    }
    if (meetings.length % 2 === 0) return false;
    const minutes = meetings.map(c => toMinutes(c.endTime) - toMinutes(c.startTime));
    for (let i = 0; i < meetings.length; i += 1) {
      for (let j = i + 1; j < meetings.length; j += 1) {
        for (let k = j + 1; k < meetings.length; k += 1) {
          if (sameSubjectApart && new Set([pairOf(meetings[i]), pairOf(meetings[j]), pairOf(meetings[k])]).size < 3) continue;
          if (minutes[i] + minutes[j] + minutes[k] <= dayMinutes) return false;
        }
      }
    }
    return true;
  };
  const partTimers = professors.filter(p => p.employmentType === 'PART_TIME');
  const partTimerProblems = [];
  for (const p of partTimers) {
    const meetings = placed.filter(c => c.classType !== 'OJT' && c.facultyRef && String(c.facultyRef) === String(p.id));
    if (loneDayUnavoidable(meetings)) continue;
    const byDay = new Map();
    for (const c of meetings.filter(c => !['Saturday', 'Sunday'].includes(c.day))) {
      byDay.set(c.day, [...(byDay.get(c.day) || []), c]);
    }
    for (const [day, list] of byDay) {
      if (list.length === 1) partTimerProblems.push(`${p.name} has only ${list[0].subjectCode} (${list[0].sectionLabel || list[0].sectionCode}) on ${day}`);
    }
  }
  if (partTimers.length) {
    lines.push(ruleLine(`No part-time professor has a weekday with only one class (${partTimers.length} part-timer${partTimers.length === 1 ? '' : 's'} checked; one whose classes can't all share days is exempt).`, partTimerProblems));
  }

  return lines;
};

// ---------------------------------------------------------------- faculty
// The Majors' professors, the caps re-computed from the classes themselves (lab hours at the
// employment type's factor, the coordination hours per practicum), the assignments by source, the
// coordinators, and the part-time loads next to the office's own spread.
const facultyChecks = ({ classes = [], faculty = [], policy = {}, coordinators = [], assignmentsBySource = null, partTimeLoads = null, officeLoads = null }) => {
  const lines = [];
  // Major class MEETINGS only (Phase 8 Part 4, Step 0): the On-The-Job Training records are counted
  // on the coordinators' line, so this number matches the term's Major meetings.
  const unassignedMajors = classes.filter(c => !c.isMinor && !c.isNstp && c.classType !== 'OJT' && !c.facultyRef);
  lines.push(unassignedMajors.length === 0
    ? pass(`Every Major class has a professor (${classes.filter(c => !c.isMinor && !c.isNstp && c.classType !== 'OJT').length} Major class meetings).`)
    : failLine(`${unassignedMajors.length} Major class${unassignedMajors.length === 1 ? ' has' : 'es have'} no professor: ${unassignedMajors.slice(0, 3).map(classWord).join('; ')}`));

  // The caps, recomputed here: lecture hours + lab hours × the factor + the coordination hours.
  const ojtHours = Number(policy.load?.ojtCoordinatorHours) || 6;
  const coordCount = new Map();
  coordinators.forEach(c => coordCount.set(c.name, (coordCount.get(c.name) || 0) + 1));
  const overCap = [];
  let capChecked = 0;
  for (const prof of faculty) {
    // The On-The-Job Training records (Phase 8 Part 3) stay out of the per-class sum: the load rule
    // counts a coordination as its ojtCoordinatorHours (the term below), never as drawn grid hours.
    const own = classes.filter(c => c.facultyRef && String(c.facultyRef) === String(prof.id) && c.classType !== 'OJT');
    const factor = prof.employmentType === 'PART_TIME' ? 0.75 : 1;
    const selfPaced = (prof.selfPaced || []).reduce((a, r) => a + (Number(r.hours) || 0), 0);
    const teaching = round2(own.reduce((a, c) => a + hoursOf(c) * (c.classType === 'LAB' ? factor : 1), 0)
      + selfPaced + ojtHours * (coordCount.get(prof.name) || 0));
    const cap = Number(prof.load?.cap);
    if (!Number.isFinite(cap)) continue;
    capChecked += 1;
    if (teaching > cap + 1e-9) overCap.push(`${prof.name} teaches ${numberText(teaching)} h of a ${numberText(cap)} h cap`);
  }
  lines.push(overCap.length === 0
    ? pass(`Nobody is above their teaching cap (${capChecked} professors re-computed from the classes themselves).`)
    : failLine(`${overCap.length} professor${overCap.length === 1 ? ' is' : 's are'} above the cap: ${overCap.join('; ')}`));

  if (assignmentsBySource) {
    // Phase 8 Part 7: the term file copies last year's Teachers' Program and leaves the rest for the
    // Secretary — the Dean's ITEP 205 classes and the others (BSIT 1D, the 4th-year WMAD B
    // coordination), which the check fills on the practice copy only. A Part 1–6 file's new-section
    // rows and balance moves are named when there are any.
    const a = assignmentsBySource;
    const parts = [`${a.kept} kept from last year's Teachers' Program`];
    if (a.newSection) parts.push(`${a.newSection} for the new sections`);
    if (a.balanced) parts.push(`${a.balanced} moved by the Dean's equal part-time loads`);
    const open = Number.isFinite(a.leftForTheSecretary) ? a.leftForTheSecretary : a.leftForTheDean;
    const practice = open - a.leftForTheDean;
    if (open === 0 && !a.kept && !a.newSection && !a.balanced) {
      // Phase 8 Part 8: the default term file is the Dean's own session — every class assigned, none copied here.
      lines.push(pass("Assignments by source: the term file leaves no class open (the Dean's own session); none is copied from last year's Teachers' Program here."));
    } else
    lines.push(pass(`Assignments by source: ${parts.join(', ')}; ${open} left for the Secretary in the term file — ${a.leftForTheDean} the Dean's (ITEP 205)${practice > 0 ? `, ${practice} assigned here on the practice copy only (the Secretary assigns them by hand)` : ''}.`));
  }
  if (coordinators.length) {
    const names = [...coordCount.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    // The On-The-Job Training RECORDS are counted here, next to the coordinations they belong to
    // (Phase 8 Part 4, Step 0): two per coordination, a third when one split over two days.
    const ojtRecords = classes.filter(c => c.classType === 'OJT').length;
    const recordsWord = ojtRecords > 0 ? ` — ${ojtRecords} On-The-Job Training schedule records` : '';
    lines.push({ status: coordinators.length === 5 ? 'pass' : 'fail', text: `${coordinators.length} OJT coordinator${coordinators.length === 1 ? '' : 's'} (${names})${recordsWord}.` });
  }
  // Phase 8 Part 4 (decision 1): the loads against the RANGES (the minimum to the cap), from the
  // Teaching loads route's own rows. Under the minimum is a Readiness warning, never a block, so
  // the line passes and names them with the honest note.
  if (partTimeLoads?.professors?.length) {
    const rows = partTimeLoads.professors;
    const under = rows.filter(p => Number(p.underMin) > 0);
    lines.push(pass(`Teaching loads against the ranges: ${rows.length - under.length} of ${rows.length} professors at or above their minimum${under.length
      ? `; under it: ${under.map(p => `${p.name} ${numberText(p.hours)} of ${numberText(p.min)}–${numberText(p.cap)} h`).join(', ')} (a Readiness warning, never a block; Balance all on the Teaching loads panel is the Secretary's optional tool)`
      : ''}.`));
  }
  if (partTimeLoads) {
    const each = (partTimeLoads.partTimers || []).map(p => `${p.name} ${numberText(p.hours)} h`).join(', ');
    const officeSpread = officeLoads && officeLoads.length
      ? round2(Math.max(...officeLoads.map(l => l.hours)) - Math.min(...officeLoads.map(l => l.hours)))
      : null;
    lines.push(pass(`Part-time loads: ${each}; average ${numberText(partTimeLoads.average)} h, spread ${numberText(partTimeLoads.spread)} h${officeSpread !== null ? ` (the office's own ${partTimeLoads.officeSemesterLabel || 'schedule this semester'} runs a spread of ${numberText(officeSpread)} h)` : ''}.`));
  }
  return lines;
};

// ---------------------------------------------------------------- last year as the reference
// How many classes keep last year's professor for the same subject and section (Phase 8 Part 7: last
// year's Teachers' Program, by the section mapping), from the term file's kept assignments against
// the term's assignments now in force; the others listed with their reasons.
const REASONS = {
  'new-section': 'a new section this year: it took the sibling sections’ professor',
  balanced: 'moved by the Dean’s equal part-time loads rule (recorded in the term file)'
};
const lastYearComparison = ({ termFile, locks = [] }) => {
  const lines = [];
  const lockOf = (sectionCode, subjectCode) => locks.find(l => l.sectionCode === sectionCode && l.subjectCode === subjectCode) || null;
  const fileAssignments = [...(termFile.assignments || []), ...(termFile.minorAssignments || []), ...(termFile.practicumCoordinators || [])];
  // The term file writes the professor under `faculty` (build-term-sem2.js).
  const professorOf = (a) => a.faculty ?? a.facultyName;
  let keptInForce = 0;
  const others = [];
  for (const a of fileAssignments) {
    const lock = lockOf(a.sectionCode, a.subjectCode);
    const source = a.sourceKind || 'kept';
    if (source === 'kept') {
      if (lock && lock.facultyName === professorOf(a)) keptInForce += 1;
      else others.push(`${a.subjectCode} (${a.sectionCode}): ${lock ? `now ${lock.facultyName}, changed after the term was loaded (the Audit Trail says by whom)` : 'released after the term was loaded'}`);
    } else {
      others.push(`${a.subjectCode} (${a.sectionCode}): ${professorOf(a)} — ${REASONS[source] || source}`);
    }
  }
  // The classes the term file leaves open (Phase 8 Part 7: each with its reasonKind; a row without one
  // is the Dean's, as in a Part 1–6 file): the Dean's choice, or the practice copy's fill.
  const open = [...(termFile.unassignedMajors || []), ...(termFile.unassignedMinors || []), ...(termFile.unassignedCoordinations || [])];
  const OPEN_WHY = {
    'new-section': 'a section new this year, with no counterpart in last year’s Teachers’ Program: left for the Secretary (assigned here on the practice copy only)',
    'over-cap': 'last year’s professor would go above the teaching cap: left for the Secretary (assigned here on the practice copy only)',
    'not-in-last-year': 'not in last year’s Teachers’ Program: left for the Secretary (assigned here on the practice copy only)'
  };
  for (const u of open) {
    const lock = lockOf(u.sectionCode, u.subjectCode);
    const why = OPEN_WHY[u.reasonKind] || 'nobody on the faculty had taught it, so the Dean chose (an override the system learns from)';
    others.push(`${u.subjectCode} (${u.sectionCode}): ${lock ? lock.facultyName : 'unassigned'} — ${why}`);
  }
  const total = fileAssignments.length + open.length;
  lines.push(pass(`${keptInForce} of ${total} classes keep last year's professor for the same subject and cohort.`));
  others.forEach(text => lines.push(pass(`Not kept — ${text}.`)));
  return { lines, keptInForce, others: others.length };
};

// ---------------------------------------------------------------- rooms and files
const roomChecks = ({ tbaRequest = null, atOncePerGroup = null, rooms = [], classes = [], weekGroupsOn = false }) => {
  const lines = [];
  if (tbaRequest) {
    lines.push({
      status: 'pass',
      text: tbaRequest.classCount > 0
        ? `${tbaRequest.classCount} classes sit in TBA rooms: ${tbaRequest.labRooms} lab and ${tbaRequest.lecRooms} lecture room${tbaRequest.labRooms + tbaRequest.lecRooms === 1 ? '' : 's'} to request.`
        : 'No TBA room is used: the CCS rooms hold every class that needs a room.'
    });
  }
  if (atOncePerGroup) {
    lines.push(pass(`At most ${atOncePerGroup.odd.classes} classes (${atOncePerGroup.odd.labs} labs) meet at once in the odd weeks, and ${atOncePerGroup.even.classes} (${atOncePerGroup.even.labs} labs) in the even weeks.`));
  }
  for (const room of rooms.filter(r => r.kind !== 'TBA' || r.classCount > 0)) {
    if (weekGroupsOn) {
      // With the odd/even practice a room hour holds one class of each group, so the hours are counted
      // per group (an ungrouped class meets every week and counts in both).
      const own = classes.filter(c => c.roomKey === room.key);
      const groupHours = (group) => round2(own.filter(c => !c.weekGroup || c.weekGroup === group).reduce((a, c) => a + hoursOf(c), 0));
      lines.push(pass(`${room.name}: ${numberText(groupHours('ODD'))} h in the odd weeks and ${numberText(groupHours('EVEN'))} h in the even weeks${Number.isFinite(Number(room.hoursAvailable)) ? `, of ${numberText(room.hoursAvailable)} h a week for each group` : ''} (${room.classCount} class${room.classCount === 1 ? '' : 'es'}).`));
    } else {
      lines.push(pass(`${room.name}: ${numberText(room.hoursUsed)} h used${Number.isFinite(Number(room.hoursAvailable)) ? ` of ${numberText(room.hoursAvailable)} h available` : ''} (${room.classCount} class${room.classCount === 1 ? '' : 'es'}).`));
    }
  }
  return lines;
};

// Phase 8 Part 9: a file also reports its form. A PDF: its page orientation (the Class Schedule and the
// room schedules print A4 landscape, the Teachers' Program portrait) and its fonts (Arial, or its metric
// twin Arimo, only). A DOCX: the Word rules of decision 5 (nothing floats, Arial only, exact rows, fixed
// widths that add up, the whole package), checked by server/src/exports/docxRules.js.
const fileChecks = (files = []) => files.map(f => {
  if (f.error) return failLine(`${f.name}: not written (${f.error}).`);
  const countOk = !Number.isFinite(Number(f.expectedPages)) || Number(f.pages) === Number(f.expectedPages);
  const notes = [];
  let formOk = true;
  if (typeof f.landscape === 'boolean' && typeof f.expectedLandscape === 'boolean') {
    const ok = f.landscape === f.expectedLandscape;
    formOk = formOk && ok;
    notes.push(`A4 ${f.landscape ? 'landscape' : 'portrait'}${ok ? '' : ` (expected ${f.expectedLandscape ? 'landscape' : 'portrait'})`}`);
  }
  if (Array.isArray(f.fonts)) {
    const other = f.fonts.filter(n => !/^(arial(?!narrow)|arimo)/i.test(n));
    formOk = formOk && other.length === 0;
    notes.push(other.length ? `fonts other than Arial: ${other.join(', ')}` : 'Arial only');
  }
  if (Array.isArray(f.wordProblems)) {
    formOk = formOk && f.wordProblems.length === 0;
    notes.push(f.wordProblems.length ? `Word rules broken: ${f.wordProblems.slice(0, 3).join('; ')}` : 'Word rules kept (nothing floats, Arial only, exact rows)');
  }
  return {
    status: countOk && formOk ? 'pass' : 'fail',
    text: `${f.name}: ${f.pages} page${f.pages === 1 ? '' : 's'}${Number.isFinite(Number(f.expectedPages)) ? ` (${f.expectedPages} expected: one per ${f.per})` : ''}${countOk ? '' : ' — the counts differ'}${notes.length ? `; ${notes.join('; ')}` : ''}.`
  };
});

// ---------------------------------------------------------------- the report
// sections: [{ title, lines: [{ status: 'pass' | 'fail', text }] }] -> { verdict, sections, failures }.
const buildReport = (sections) => {
  const failures = sections.flatMap(s => s.lines.filter(l => l.status === 'fail'));
  return { verdict: failures.length === 0 ? 'pass' : 'fail', failures: failures.length, sections };
};

const mark = (line) => (line.status === 'fail' ? '✖' : '✔');

const renderMd = (report, { title, facts = [] }) => {
  const out = [`# ${title}`, ''];
  facts.forEach(f => out.push(`- ${f}`));
  if (facts.length) out.push('');
  out.push(report.verdict === 'pass' ? '**Every check passed.**' : `**${report.failures} check${report.failures === 1 ? '' : 's'} failed (✖ below).**`, '');
  for (const section of report.sections) {
    out.push(`## ${section.title}`, '');
    section.lines.forEach(l => out.push(`- ${mark(l)} ${l.text}`));
    out.push('');
  }
  return `${out.join('\n')}\n`;
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const renderHtml = (report, { title, facts = [] }) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>
body { font-family: Segoe UI, Arial, sans-serif; margin: 2rem auto; max-width: 60rem; color: #1a1a1a; line-height: 1.5; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 1.6rem; border-bottom: 1px solid #ddd; padding-bottom: .2rem; }
ul { padding-left: 1.4rem; } li { margin: .2rem 0; list-style: none; text-indent: -1.4rem; padding-left: 1.4rem; }
.pass::before { content: "✔ "; color: #15803d; font-weight: bold; }
.fail::before { content: "✖ "; color: #b91c1c; font-weight: bold; }
.verdict { font-weight: bold; padding: .6rem .9rem; border-radius: .5rem; display: inline-block; }
.verdict.pass { background: #dcfce7; color: #14532d; } .verdict.fail { background: #fee2e2; color: #7f1d1d; }
.facts { color: #444; font-size: .95rem; }
</style></head><body>
<h1>${esc(title)}</h1>
${facts.length ? `<p class="facts">${facts.map(esc).join('<br/>')}</p>` : ''}
<p class="verdict ${report.verdict}">${report.verdict === 'pass' ? 'Every check passed.' : `${report.failures} check${report.failures === 1 ? '' : 's'} failed (✖ below).`}</p>
${report.sections.map(section => `<h2>${esc(section.title)}</h2>\n<ul>\n${section.lines.map(l => `<li class="${l.status}">${esc(l.text)}</li>`).join('\n')}\n</ul>`).join('\n')}
</body></html>\n`;

module.exports = {
  independentScheduleChecks,
  facultyChecks,
  lastYearComparison,
  roomChecks,
  fileChecks,
  buildReport,
  renderMd,
  renderHtml
};
