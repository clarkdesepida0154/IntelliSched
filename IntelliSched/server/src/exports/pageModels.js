// The pages of the office's three exports (Phase 8 Part 2, Step 1), built from GET /schedule/outputs'
// answer (utils/scheduleOutputs.js buildScheduleOutputs) — the same records every view reads; nothing
// here computes an hour or a load. One export model per file (shared header and footer facts, then one
// page per section, professor or room); the DOCX writer and the HTML (PDF) writer both draw from it,
// so the two files of one form cannot drift apart.
//
// The words follow the references in docs/formats/:
//   - the Class Schedule (SF-003): "Program: … Year: I Section: A" the office's way; a class is the
//     code (bold), the title, LAB or LEC when the subject has both, and the professor's initial and
//     surname ("J. Faculty") or TBA. No room.
//   - the room schedule: one page per room and week group; a cell is the code, the title, the
//     professor and the section the office's way ("BSIT II A", "BSIT III WMAD A", "BSIT III AMG").
//   - the Teachers' Program (SF-029): the facts block, the Period grid with the classes (each with its
//     room, Phase 11) and the On-The-Job Training boxes — never the ancillary duty blocks, which only
//     the summary counts (Phase 11, every professor) — the fixed "Total 40 hours" row (the scans print the standard week,
//     whatever the professor's own total), the load summary and the signatories.
const { toMinutes, fromMinutes } = require('../utils/timeGrid');
const { compareFaculty, compareSections } = require('../utils/officeOrder');
const { GRID_START, GRID_END, GRID_SLOT_MINUTES, LAYOUTS } = require('./layouts');
const { sf029Sheet, classScheduleSheet, roomScheduleSheets } = require('./sheets');
const { planRoomSchedulePages, isWithoutRoom, TBA_PAGE_TITLE } = require('../utils/roomSchedulePages');

const textOf = (v) => String(v ?? '').trim();
const numberText = (n) => String(Math.round(Number(n || 0) * 100) / 100);

// ---------------------------------------------------------------- names the office's way

// "FacultyMember, MSIT" -> "M. Faculty": the first name's initial and the surname (anything
// after a comma, a degree, is dropped; a generational suffix such as "Jr." is not the surname, so
// "Alejandro V. Faculty Jr." reads "A. Faculty", as the office writes him). 'TBA' is kept as given;
// '' when there is no name.
const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const initialSurname = (name) => {
  const text = textOf(name).split(',')[0].trim();
  if (!text) return '';
  if (text.toUpperCase() === 'TBA') return 'TBA';
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0];
  let last = words.length - 1;
  while (last > 0 && NAME_SUFFIXES.has(words[last].replace(/\./g, '').toUpperCase())) last -= 1;
  return `${words[0][0].toUpperCase()}. ${words[last]}`;
};

const PROGRAM_NAMES = {
  BSIT: 'Bachelor of Science in Information Technology',
  BSCS: 'Bachelor of Science in Computer Science'
};
const ROMAN_YEARS = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
const romanYear = (yearLevel) => ROMAN_YEARS[Number(yearLevel)] || textOf(yearLevel);

// The section's letter: the one riding the year digit ("BSIT 3A WMAD" -> "A", "BSIT 2A" -> "A"), or
// the trailing letter of a code without one. Phase 8 Part 3 fix: the trailing letter alone read the
// track's own last letter in a code that embeds it ("BSIT 3A WMAD" ended in the D of WMAD), so both
// WMAD pages printed "D - WMAD".
const sectionLetter = (section) => {
  const text = textOf(section?.code ?? section?.sectionCode);
  const byYear = /\d\s*([A-Za-z])(?![A-Za-z0-9])/.exec(text);
  if (byYear) return byYear[1].toUpperCase();
  const m = /([A-Za-z])\s*$/.exec(text);
  return m ? m[1].toUpperCase() : '';
};

// A BSIT specialization track the office writes out (never IS: every BSCS section is on it, so it
// would say nothing).
const BSIT_TRACKS = ['WMAD', 'SMP', 'AMG'];
const trackOf = (section) => {
  const track = textOf(section?.track).toUpperCase();
  return BSIT_TRACKS.includes(track) ? track : '';
};

// Whether the office writes the section's letter next to its track: only when more than one section
// of the same program, year and track is on the export ("A - WMAD" and "B - WMAD", but plain "AMG"
// for the one AMG section), as on the office's own sheets.
const trackSiblings = (section, sections) => (sections || []).filter(s => trackOf(s)
  && s.program === section.program && Number(s.yearLevel) === Number(section.yearLevel) && trackOf(s) === trackOf(section));

// The SF-003's "Section:" value: years 1–2 the letter ("A"); years 3–4 the track ("AMG"), or the
// letter and track ("A - WMAD") when the track has more than one section.
const sectionLineText = (section, sections) => {
  const track = trackOf(section);
  if (!track) return sectionLetter(section) || textOf(section.label || section.code);
  return trackSiblings(section, sections).length > 1 ? `${sectionLetter(section)} - ${track}` : track;
};

// The section as the room schedule and the SF-029 cells write it: "BSIT II A", "BSCS III A",
// "BSIT III WMAD A", "BSIT III AMG". The fallback is the system's own label when the section record
// is gone.
const officeSectionLabel = (section, sections) => {
  if (!section) return '';
  const program = textOf(section.program);
  const year = romanYear(section.yearLevel);
  if (!program || !year) return textOf(section.label ?? section.sectionLabel ?? section.code ?? section.sectionCode);
  const track = trackOf(section);
  if (!track) return [program, year, sectionLetter(section)].filter(Boolean).join(' ');
  const letter = trackSiblings(section, sections).length > 1 ? sectionLetter(section) : '';
  return [program, year, track, letter].filter(Boolean).join(' ');
};

// The section as the Teachers' Program's cells write it (Phase 8 Part 9, decision 6, as on last year's
// forms): "BSIT IIC", "BSCS IIIA" (the letter rides the year), "BSIT III A WMAD" when the track has two
// sections, "BSIT III WMAD" when it has one. The room schedules and the Class Schedule keep their own
// styles.
const sf029SectionLabel = (section, sections) => {
  if (!section) return '';
  const program = textOf(section.program);
  const year = romanYear(section.yearLevel);
  if (!program || !year) return textOf(section.label ?? section.sectionLabel ?? section.code ?? section.sectionCode);
  const track = trackOf(section);
  if (!track) return `${program} ${year}${sectionLetter(section)}`;
  return trackSiblings(section, sections).length > 1
    ? `${program} ${year} ${sectionLetter(section)} ${track}`
    : `${program} ${year} ${track}`;
};

// The surname for the office's page order ("Alejandro V. Faculty Jr." -> "Faculty").
const surnameOf = (name) => {
  const words = textOf(name).split(',')[0].trim().split(/\s+/).filter(Boolean);
  let last = words.length - 1;
  while (last > 0 && NAME_SUFFIXES.has(words[last].replace(/\./g, '').toUpperCase())) last -= 1;
  return words[last] || '';
};

// ---------------------------------------------------------------- the grid

// "07:00","07:30" -> "7:00 – 7:30" (the TIME and Period columns: 12-hour clock, no AM/PM).
const periodLabel = (start, end) => {
  const short = (time) => {
    const m = toMinutes(time);
    if (m === null) return textOf(time);
    const h24 = Math.floor(m / 60) % 24;
    return `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(m % 60).padStart(2, '0')}`;
  };
  return `${short(start)} – ${short(end)}`;
};

// The forms' grid: half-hour rows always printed from 7:00 to 5:00 (the office's sheets keep the
// empty 7:00 rows), widened to any block outside; per day, each block as a cell that spans its rows.
// Blocks that overlap share one cell, stacked (the same rule as the print view's periodGrid).
//   blocks  [{ day, start, end, kind, lines: [{ text, bold? }] }]
// Returns { rows: [{ start, end, label }], cells: { Monday: [{ row, span, blocks }], … } }.
const buildGrid = (blocks, days) => {
  const slot = GRID_SLOT_MINUTES;
  const timed = (blocks || [])
    .map(b => ({ b, s: toMinutes(b.start), e: toMinutes(b.end) }))
    .filter(t => t.s !== null && t.e !== null && t.e > t.s && days.includes(t.b.day));
  const origin = Math.floor(Math.min(toMinutes(GRID_START), ...timed.map(t => t.s)) / slot) * slot;
  const end = Math.ceil(Math.max(toMinutes(GRID_END), ...timed.map(t => t.e)) / slot) * slot;
  const rows = Array.from({ length: (end - origin) / slot }, (_, i) => ({
    start: fromMinutes(origin + i * slot),
    end: fromMinutes(origin + (i + 1) * slot),
    label: periodLabel(fromMinutes(origin + i * slot), fromMinutes(origin + (i + 1) * slot))
  }));
  const cells = Object.fromEntries(days.map(day => {
    const spans = timed
      .filter(t => t.b.day === day)
      .map(t => ({ b: t.b, first: Math.floor((t.s - origin) / slot), last: Math.ceil((t.e - origin) / slot) }))
      .sort((a, b) => (a.first - b.first) || (b.last - a.last));
    const merged = [];
    spans.forEach(sp => {
      const open = merged[merged.length - 1];
      if (open && sp.first < open.last) {
        open.blocks.push(sp.b);
        open.last = Math.max(open.last, sp.last);
      } else merged.push({ first: sp.first, last: sp.last, blocks: [sp.b] });
    });
    return [day, merged.map(m => ({ row: m.first, span: m.last - m.first, blocks: m.blocks }))];
  }));
  return { rows, cells };
};

// ---------------------------------------------------------------- shared words

// "2nd Semester" -> runs with the ordinal's letters in superscript: [{ text: '2' },
// { text: 'nd', super: true }, { text: ' Semester' }]. A label without an ordinal stays one run.
const ordinalRuns = (label) => {
  const m = /^(\d+)(st|nd|rd|th)\b(.*)$/.exec(textOf(label));
  if (!m) return [{ text: textOf(label) }];
  return [{ text: m[1] }, { text: m[2], super: true }, { text: m[3] }];
};

// "2nd Semester AY. 2026-2027" (the SF-003 and room schedule headers' term line).
const termRuns = (schedule) => [
  ...ordinalRuns(schedule.semesterLabel),
  { text: ` AY. ${schedule.academicYear}` }
];

// "(2nd Semester. SY 2026-2027)" (under the SF-029's title): the period after "Semester" that every
// office form has (Phase 8 Part 3, decision 1e; without the scans' stray space in the year).
const sf029TermRuns = (schedule) => [
  { text: '(' },
  ...ordinalRuns(schedule.semesterLabel),
  { text: `. SY ${schedule.academicYear})` }
];

// Any status but Approved and Published puts one small line above the header on every page.
const draftLineOf = (schedule) => (schedule.status === 'Approved' || schedule.status === 'Published'
  ? null : 'DRAFT – NOT APPROVED');

// A signatory line as the forms print it: the label, the NAME (empty prints as a blank line to sign
// on, never a placeholder name) and the title. The Teachers' Program's auto line carries the
// professor's own name, in capitals as the forms write it; a stored name prints as typed, so a
// degree after it keeps its case ("FacultyMember", "FacultyMember" — the
// scans never write "PHD"; Phase 8 Part 3).
const signatoryOf = (line, professor = null) => {
  const auto = line?.auto === 'professor' && professor;
  return {
    label: textOf(line?.label),
    // The caller hands the professor's display name already in the form's capitals (with the degree
    // after the name since Phase 8 Part 3); a stored name prints as typed.
    name: textOf(auto ? professor.name : line?.name),
    title: textOf(auto ? professor.position : line?.title)
  };
};

// Whether a class's code needs a LAB or LEC line: only when the subject has both kinds for that
// section (decision 1).
const typeLineNeeded = (classes) => {
  const kinds = new Map();
  const keyOf = (cls) => `${cls.subjectId || cls.subjectCode}|${cls.sectionId}`;
  for (const cls of classes) {
    if (!kinds.has(keyOf(cls))) kinds.set(keyOf(cls), new Set());
    kinds.get(keyOf(cls)).add(cls.classType);
  }
  return (cls) => (kinds.get(keyOf(cls))?.size || 0) > 1;
};

const formCodeOf = (form) => ({
  code: textOf(form?.formCode),
  revision: textOf(form?.revision),
  date: textOf(form?.date)
});

// ---------------------------------------------------------------- 1. Class Schedule (SF-003)

// One page per section with classes, in the gateway's order. The form code line and the signatories
// are the Mother Schedule's (the term loader fills them with the office's SF-003 facts where empty).
const classScheduleModel = (outputs) => {
  const layout = LAYOUTS['class-schedule'];
  // Siblings for the office's section labels count over the term's whole section list, not only the
  // sections with classes ("A - WMAD" stays right while 3B's classes are still unassigned).
  const allSections = outputs.sections || [];
  // The pages in the office's own order (Phase 11.1: utils/officeOrder.js, shared with every export).
  const sections = allSections.filter(s => s.classCount > 0).sort(compareSections);
  const needsTypeLine = typeLineNeeded(outputs.classes || []);
  const pages = sections.map(section => {
    const classes = (outputs.classes || []).filter(cls => String(cls.sectionId) === String(section.id));
    const blocks = classes.map(cls => ({
      day: cls.day,
      start: cls.startTime,
      end: cls.endTime,
      kind: 'class',
      lines: [
        { text: textOf(cls.subjectCode), bold: true },
        { text: textOf(cls.subjectTitle) },
        ...(needsTypeLine(cls) ? [{ text: textOf(cls.classType) }] : []),
        { text: cls.facultyRef || cls.outsideTeacher ? initialSurname(cls.facultyName) : 'TBA' }
      ].filter(l => l.text)
    }));
    return {
      key: String(section.id),
      name: section.label || section.code,
      program: {
        name: PROGRAM_NAMES[section.program] || textOf(section.program),
        year: romanYear(section.yearLevel),
        section: sectionLineText(section, allSections)
      },
      grid: buildGrid(blocks, layout.grid.days),
      signatories: (outputs.settings?.motherSchedule?.signatories || []).map(l => signatoryOf(l))
    };
  });
  const model = {
    view: 'class-schedule',
    layout,
    schedule: outputs.schedule,
    draftLine: draftLineOf(outputs.schedule),
    collegeName: textOf(outputs.settings?.collegeName),
    formTitle: 'CLASS SCHEDULE',
    termRuns: termRuns(outputs.schedule),
    formCode: formCodeOf(outputs.settings?.motherSchedule),
    pages
  };
  // Phase 8 Part 9: each page's bands (sheets.js), the signatories and footer included (decision 3).
  pages.forEach(page => { page.sheet = classScheduleSheet(model, page); });
  model.shortened = pages.flatMap(page => page.sheet.shortened);
  return model;
};

// ---------------------------------------------------------------- 2. The room schedule

// "BSIT 1st Year and 3rd Year Level" lines from the policy's week-group table, one line per program.
// A policy row names its weeks under `weeks` (utils/policy.js); `weekGroup` is read too, defensively.
const yearWord = (y) => ({ 1: '1st', 2: '2nd', 3: '3rd' }[Number(y)] || `${Number(y)}th`);
const yearLevelLines = (policy, weekGroup) => {
  const rows = (policy?.weekGroups?.groups || []).filter(g => textOf(g.weeks ?? g.weekGroup).toUpperCase() === weekGroup);
  const byProgram = new Map();
  for (const g of rows) {
    const program = textOf(g.program).toUpperCase();
    if (!byProgram.has(program)) byProgram.set(program, new Set());
    byProgram.get(program).add(Number(g.yearLevel));
  }
  const programOrder = { BSIT: 0, BSCS: 1 };
  return [...byProgram.entries()]
    .sort(([a], [b]) => (programOrder[a] ?? 9) - (programOrder[b] ?? 9) || a.localeCompare(b))
    .map(([program, years]) => {
      const list = [...years].filter(Number.isFinite).sort((a, b) => a - b).map(yearWord);
      const words = list.length > 1
        ? `${list.slice(0, -1).map(y => `${y} Year`).join(', ')} and ${list[list.length - 1]} Year`
        : `${list[0] || ''} Year`;
      return `${program} ${words} Level`;
    });
};

// Phase 8: on prints, rooms carry the office's names ("Computer Laboratory 1", "Room 47"); a TBA room
// to request prints its TBA name.
const officeRoomName = (name) => {
  const text = textOf(name);
  const lab = /^LAB\s*(\d+)$/i.exec(text);
  if (lab) return `Computer Laboratory ${lab[1]}`;
  const room = /^ROOM\s*(\d+)$/i.exec(text);
  if (room) return `Room ${room[1]}`;
  return text;
};
// The section as the office's Room Schedule writes it (Phase 11.2; docs/formats/Room-Schedule_2nd-Sem-
// AY2025-26.docx): "BSIT II B", "BSCS III A", "BSIT III SMP", and "BSIT III A WMAD" when the track has
// more than one section (the office's most frequent spelling).
const roomSectionLabel = (section, sections) => {
  if (!section) return '';
  const program = textOf(section.program);
  const year = romanYear(section.yearLevel);
  if (!program || !year) return textOf(section.label ?? section.sectionLabel ?? section.code ?? section.sectionCode);
  const track = trackOf(section);
  if (!track) return [program, year, sectionLetter(section)].filter(Boolean).join(' ');
  const letter = trackSiblings(section, sections).length > 1 ? sectionLetter(section) : '';
  return [program, year, letter, track].filter(Boolean).join(' ');
};

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const time12 = (time) => {
  const m = toMinutes(time);
  if (m === null) return textOf(time);
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// Phase 11.2 (decision 2): ONE Room Schedule file in the office's format — A4 portrait, the pages in
// the office's order (utils/roomSchedulePages.js: LAB 1–3 odd weeks, LAB 1–3 even weeks, AVR, TSL,
// ROOM 47, LAB 4, any other room), a room with no classes printed as an empty grid, and, when any class
// has no room, one last page "Classes without a room (TBA)" listing them. Each class box: the code,
// the title, LEC or LAB, the teacher ("M. Faculty" or TBA), the section ("BSIT II B"). A page's key is
// its room's key (a lab's two pages share it, so the single-room export carries both); the TBA page's
// key is 'TBA'. The weekGroup argument is kept for old callers and ignored: there is one file.
const roomScheduleModel = (outputs) => {
  const layout = LAYOUTS['room-schedule'];
  const sections = outputs.sections || [];
  const sectionRank = new Map([...sections].sort(compareSections).map((sec, i) => [String(sec.id), i]));
  const compareSectionsKey = (sec) => (sec ? sectionRank.get(String(sec.id)) ?? 9999 : 9999);
  const sectionById = new Map(sections.map(s => [String(s.id), s]));
  const classes = outputs.classes || [];
  const sectionText = (cls) => roomSectionLabel(sectionById.get(String(cls.sectionId)) || cls, sections);
  const teacherText = (cls) => (cls.facultyRef || cls.outsideTeacher ? initialSurname(cls.facultyName) : 'TBA');
  // Phase 11.4 (decision 2): LEC or LAB only for a subject with a lab part — the Class Schedule's own
  // rule (typeLineNeeded); a pure-lecture subject (GenEd, NSTP, PE, …) has no third line.
  const needsTypeLine = typeLineNeeded(classes);
  const kindText = (cls) => (needsTypeLine(cls) ? (cls.classType === 'LAB' ? 'LAB' : 'LEC') : '');
  const plan = planRoomSchedulePages({ rooms: outputs.rooms || [], classes });
  const pages = plan.map(p => {
    const blocks = classes
      .filter(cls => cls.roomKey && String(cls.roomKey) === p.roomKey && (p.weekGroup === 'ALL' || !cls.weekGroup || cls.weekGroup === p.weekGroup))
      .map(cls => ({
        day: cls.day,
        start: cls.startTime,
        end: cls.endTime,
        kind: 'class',
        lines: [
          { text: textOf(cls.subjectCode), role: 'code' },
          { text: textOf(cls.subjectTitle), role: 'title' },
          { text: kindText(cls), role: 'kind' },
          { text: teacherText(cls), role: 'teacher' },
          { text: sectionText(cls), role: 'section' }
        ].filter(l => l.text)
      }));
    return {
      kind: 'room',
      key: p.roomKey,
      roomName: p.roomName,
      weekGroup: p.weekGroup,
      name: p.heading,
      heading: p.heading,
      grid: buildGrid(blocks, layout.grid.days),
      signatories: (outputs.settings?.roomProgram?.signatories || []).map(l => signatoryOf(l))
    };
  });
  const withoutRoom = classes.filter(isWithoutRoom).map(cls => ({
    section: sectionText(cls),
    subject: [textOf(cls.subjectCode), textOf(cls.subjectTitle)].filter(Boolean).join(' '),
    kind: kindText(cls),
    teacher: teacherText(cls),
    when: `${textOf(cls.day)} ${time12(cls.startTime)}–${time12(cls.endTime)}`,
    order: [compareSectionsKey(sectionById.get(String(cls.sectionId))), DAY_ORDER.indexOf(cls.day), toMinutes(cls.startTime) ?? 0]
  }));
  if (withoutRoom.length) {
    const sorted = [...withoutRoom].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2] || a.subject.localeCompare(b.subject));
    pages.push({ kind: 'tba', key: 'TBA', name: TBA_PAGE_TITLE, heading: TBA_PAGE_TITLE, weekGroup: 'ALL', rows: sorted.map(({ order, ...row }) => row), signatories: [] });
  }
  const model = {
    view: 'room-schedule',
    layout,
    schedule: outputs.schedule,
    weekGroup: 'ALL',
    draftLine: draftLineOf(outputs.schedule),
    collegeName: textOf(outputs.settings?.collegeName),
    termRuns: termRuns(outputs.schedule),
    formCode: formCodeOf(outputs.settings?.roomProgram),
    pages
  };
  // The TBA list may need more than one sheet: roomScheduleSheet returns one per page, and a long
  // list's page is split here into as many pages as its sheets.
  model.pages = pages.flatMap(page => {
    const sheets = roomScheduleSheets(model, page);
    return sheets.map((sheet, i) => ({ ...page, ...(sheets.length > 1 ? { part: i + 1 } : {}), sheet }));
  });
  model.shortened = model.pages.flatMap(page => page.sheet.shortened);
  return model;
};

// ---------------------------------------------------------------- 3. Teachers' Program (SF-029)

// The value of one summary line: the lab line "15 x .75 = 11.25" with the letter x, as on the form
// (Phase 8 Part 9, decision 6),
// any other line its hours; blank when it has none (an ancillary the professor doesn't have, no
// Excess), as on the real forms.
const summaryValueText = (line) => {
  if (!line || line.hours === null || line.hours === undefined) return '';
  if (line.key !== 'LAB') return numberText(line.hours);
  const factor = Number(line.factor);
  if (!Number.isFinite(factor)) return numberText(line.weighted ?? line.hours);
  return `${numberText(line.hours)} x ${numberText(factor).replace(/^0\./, '.')} = ${numberText(line.weighted)}`;
};

// The room line of a class on the Teachers' Program (Phase 11): the room's name as the system holds it
// ("LAB 1", "ROOM 47", "AVR", "TSL"), "Online" for a lecture held online, "TBA" when no CCS room holds
// it (a TBA room to request, or no room needed).
const roomTextOf = (cls) => {
  if (cls.roomKind === 'ONLINE') return 'Online';
  if (cls.roomKind === 'CCS' || cls.roomKind === 'BORROWED') return textOf(cls.roomName) || 'TBA';
  return 'TBA';
};
const WEEKS_WORDS = { ODD: 'Odd wks', EVEN: 'Even wks' };

// A professor's classes as meetings: the items of one meeting (the same section, subject, type, day and
// times) held in different rooms by different week groups become one class whose room line names both,
// "LAB 1 (Odd wks) / LAB 2 (Even wks)"; every other class keeps its own room. Each class gets roomText.
const meetingsOf = (classes) => {
  const groups = new Map();
  for (const cls of classes) {
    const key = cls.classType === 'OJT' ? `ojt:${cls.itemId}` : [cls.sectionId, cls.subjectId, cls.classType, cls.day, cls.startTime, cls.endTime].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cls);
  }
  return [...groups.values()].flatMap(items => {
    const rooms = [...new Set(items.map(roomTextOf))];
    const weeks = new Set(items.map(c => c.weekGroup).filter(Boolean));
    if (items.length > 1 && rooms.length > 1 && weeks.size > 1 && items.every(c => WEEKS_WORDS[c.weekGroup])) {
      const ordered = items.slice().sort((a, b) => (a.weekGroup === 'ODD' ? 0 : 1) - (b.weekGroup === 'ODD' ? 0 : 1));
      const roomText = [...new Map(ordered.map(c => [c.weekGroup, `${roomTextOf(c)} (${WEEKS_WORDS[c.weekGroup]})`])).values()].join(' / ');
      return [{ ...ordered[0], roomText }];
    }
    return items.map(c => ({ ...c, roomText: roomTextOf(c) }));
  });
};

// One page per professor with a class, a self-paced online lecture or an On-The-Job Training box, in
// the gateway's order (the same set "Print all professors" prints).
const teachersProgramModel = (outputs) => {
  const layout = LAYOUTS['teachers-program'];
  const sections = outputs.sections || [];
  const sectionById = new Map(sections.map(s => [String(s.id), s]));
  const sectionByLabel = new Map(sections.map(s => [textOf(s.label), s]));
  const needsTypeLine = typeLineNeeded(outputs.classes || []);
  const hasProgram = (f) => f.classCount > 0
    || (Array.isArray(f.selfPaced) && f.selfPaced.length > 0)
    || (Array.isArray(f.practicum?.blocks) && f.practicum.blocks.length > 0);
  const standardWeek = Number(outputs.policy?.load?.standardWeeklyHours);
  // The office's page order (Phase 11.1: utils/officeOrder.js): by the name as printed, first name
  // first, titles ignored, ties by surname.
  const ordered = (outputs.faculty || []).filter(hasProgram).slice().sort(compareFaculty);
  const pages = ordered.map(prof => {
    const classes = meetingsOf((outputs.classes || []).filter(cls => cls.facultyRef && String(cls.facultyRef) === String(prof.id)));
    // An On-The-Job Training record (Phase 8 Part 3, decision 2: a schedule record of the section)
    // prints as the scans' box: the code, "On-The-Job Training", the section.
    const classBlocks = classes.map(cls => (cls.classType === 'OJT'
      ? {
        day: cls.day,
        start: cls.startTime,
        end: cls.endTime,
        kind: 'practicum',
        lines: [
          { text: textOf(cls.subjectCode), bold: true },
          { text: 'On-The-Job Training' },
          { text: sf029SectionLabel(sectionById.get(String(cls.sectionId)) || cls, sections) }
        ].filter(l => l.text)
      }
      : {
        day: cls.day,
        start: cls.startTime,
        end: cls.endTime,
        kind: 'class',
        // The section is the last of these lines; the room (Phase 11) is drawn after it, or joined to
        // it when the box is short (sheets.js sf029FitCell).
        lines: [
          { text: textOf(cls.subjectCode), bold: true },
          { text: textOf(cls.subjectTitle) },
          ...(needsTypeLine(cls) ? [{ text: textOf(cls.classType) }] : []),
          { text: sf029SectionLabel(sectionById.get(String(cls.sectionId)) || cls, sections) }
        ].filter(l => l.text),
        room: cls.roomText
      }));
    // An On-The-Job Training box carries its section's label (no id), so the office label is looked up
    // by it; the stored label stays the fallback.
    const ojtBlocks = (prof.practicum?.blocks || []).map(block => ({
      day: block.day,
      start: block.start,
      end: block.end,
      kind: 'practicum',
      lines: [
        { text: textOf(block.subjectCode), bold: true },
        { text: textOf(block.label) || 'On-The-Job Training' },
        { text: sf029SectionLabel(sectionByLabel.get(textOf(block.sectionLabel)) || null, sections) || textOf(block.sectionLabel) }
      ].filter(l => l.text)
    }));
    // Phase 11: the ancillary duty blocks (prof.ancillary.blocks) are not drawn on the printed form, for
    // any professor. The system keeps them (the outputs answer, the Schedule Views) and the summary
    // below still counts their hours; their free rows print as ordinary empty half-hour cells.
    const header = prof.header || {};
    return {
      key: String(prof.id),
      name: header.name || prof.name,
      facts: {
        left: [
          // Phase 8 Part 3 (decision 1d): the Name line carries the degree after the name, the
          // degree's own case kept ("FacultyMember, MSIT"; "FacultyMember, PhD").
          { label: 'Name:', value: textOf(header.nameWithDegree) || textOf(header.name || prof.name).toUpperCase(), bold: true },
          { label: 'Position:', value: textOf(header.position) },
          { label: 'Major/Minor:', value: textOf(header.majorMinor) },
          { label: 'Co-Curricular Activities:', value: textOf(header.coCurricular) }
        ],
        right: [
          { label: 'College:', value: textOf(header.college) },
          { label: 'Subject Taught:', value: (header.subjectsTaught || []).join(', ') },
          { label: 'Preparation:', value: String(prof.load?.preparations ?? '') }
        ]
      },
      grid: buildGrid([...classBlocks, ...ojtBlocks], layout.grid.days),
      // The bottom row as the scans print it: the standard week in the Period column, whatever the
      // professor's own total, and the teaching hours of each day under its column — Saturday and
      // Sunday blank when 0, as on every scan (Phase 8 Part 3, decision 1c).
      totals: {
        label: Number.isFinite(standardWeek) ? `Total ${numberText(standardWeek)} hours` : 'Total hours',
        days: Object.fromEntries(layout.grid.days.map(day => {
          const hours = prof.dayTotals?.days?.[day] ?? 0;
          const blankWhenZero = day === 'Saturday' || day === 'Sunday';
          return [day, blankWhenZero && !(hours > 0) ? '' : numberText(hours)];
        }))
      },
      selfPaced: (prof.selfPaced || []).map(row => `${row.subjectCode} ${row.subjectTitle} — ${row.sectionLabel} (${numberText(row.hours)} h a week)`),
      summary: {
        teachingHours: numberText(prof.load?.teaching ?? 0),
        lines: (prof.summary || []).map(line => ({ key: line.key, label: textOf(line.label), value: summaryValueText(line) }))
      },
      signatories: (outputs.settings?.teachersProgram?.signatories || []).map(l => signatoryOf(l, {
        name: textOf(header.nameWithDegree) || textOf(header.name || prof.name).toUpperCase(),
        position: header.position
      }))
    };
  });
  const model = {
    view: 'teachers-program',
    layout,
    schedule: outputs.schedule,
    draftLine: draftLineOf(outputs.schedule),
    collegeName: textOf(outputs.settings?.collegeName),
    formTitle: textOf(outputs.settings?.teachersProgram?.title),
    termRuns: sf029TermRuns(outputs.schedule),
    formCode: formCodeOf(outputs.settings?.teachersProgram),
    pages
  };
  // Phase 8 Part 9: each page's bands, positioned on the office's form (sheets.js); the writers draw
  // only these. The titles the fit rule shortened are listed for the report.
  pages.forEach(page => { page.sheet = sf029Sheet(model, page); });
  model.shortened = pages.flatMap(page => page.sheet.shortened);
  return model;
};

// The export model of one view; the writers (docxWriter.js, html.js) read nothing else.
const buildExportModel = (outputs, view, { weekGroup = 'ALL' } = {}) => {
  if (view === 'class-schedule') return classScheduleModel(outputs);
  if (view === 'room-schedule') return roomScheduleModel(outputs);
  if (view === 'teachers-program') return teachersProgramModel(outputs);
  throw new Error(`Unknown export view: ${view}`);
};

module.exports = {
  buildExportModel,
  initialSurname,
  officeSectionLabel,
  roomSectionLabel,
  sf029SectionLabel,
  surnameOf,
  sectionLineText,
  officeRoomName,
  yearLevelLines,
  periodLabel,
  buildGrid,
  ordinalRuns,
  termRuns,
  sf029TermRuns,
  draftLineOf,
  summaryValueText,
  GRID_START,
  GRID_END
};
