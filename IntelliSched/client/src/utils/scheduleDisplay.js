// How the three outputs read (Phase 3 Step 1): the Mother Schedule (per section), the Teachers'
// Program (per professor) and the Room Program (per room). They all show the same schedule records,
// served joined by GET /api/schedule/outputs; these helpers only put them into words. Nothing here
// computes a number (hours, loads and counts come from the gateway).
import { DAY_NAMES, formatRange12, toMinutes } from './timeGrid.js';

// The seven day columns, always shown, in the order of the class-schedule table.
export const WEEK_DAYS = DAY_NAMES;
export const WEEK_COLUMN_LABELS = DAY_NAMES.map(d => d.toUpperCase());

const pad2 = (n) => String(n).padStart(2, '0');

// "07:00" -> "07:00 AM", "13:30" -> "01:30 PM" (12-hour, leading zero), as in the TIME column.
export const timeLabel = (time) => {
  const m = toMinutes(time);
  if (m === null) return String(time ?? '');
  const h24 = Math.floor(m / 60) % 24;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad2(h12)}:${pad2(m % 60)} ${h24 < 12 ? 'AM' : 'PM'}`;
};

// "08:00", "11:00" -> "08:00 AM – 11:00 AM" (the List view and the editor's time choices).
export const timeRangeLabel = (start, end) => `${timeLabel(start)} – ${timeLabel(end)}`;

// "07:00", "07:30" -> "7:00 – 7:30" (the SF-029's Period column: 12-hour clock, no leading zero,
// no AM/PM).
export const periodLabel = (start, end) => {
  const short = (time) => {
    const m = toMinutes(time);
    if (m === null) return String(time ?? '');
    const h24 = Math.floor(m / 60) % 24;
    return `${h24 % 12 === 0 ? 12 : h24 % 12}:${pad2(m % 60)}`;
  };
  return `${short(start)} – ${short(end)}`;
};

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

// The position in the professor line's brackets: "PTF" for part-time faculty (from the employment
// type, never from the position text), otherwise the position shortened:
//   Associate Professor III -> "Assoc Prof 3", Assistant Professor IV -> "Asst Prof 4",
//   Instructor I -> "Instructor 1", Professor II -> "Prof 2". '' when there is none.
export const shortPosition = ({ employmentType, position } = {}) => {
  if (employmentType === 'PART_TIME') return 'PTF';
  const words = String(position || '')
    .replace(/\bassociate\s+professor\b/gi, 'Assoc Prof')
    .replace(/\bassistant\s+professor\b/gi, 'Asst Prof')
    .replace(/\bprofessor\b/gi, 'Prof')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  const last = words[words.length - 1].toUpperCase();
  if (words.length > 1 && ROMAN[last]) words[words.length - 1] = String(ROMAN[last]);
  return words.join(' ');
};

// Line 4 of a class box: "Name (Assoc Prof 3)", "Name (PTF)", or "TBA" when there is no professor.
// cls carries the professor's employmentType and facultyPosition (GET /schedule/outputs classes).
export const professorLine = (cls) => {
  const name = String(cls?.facultyName || '').trim();
  // Phase 8 Part 8 (decision 4): a GenEd class's outside teacher shows by name, like a professor.
  if (cls?.outsideTeacher && name && name !== 'TBA') return name;
  if (!cls?.facultyRef || !name || name === 'TBA') return 'TBA';
  const position = shortPosition({ employmentType: cls.employmentType, position: cls.facultyPosition ?? cls.position });
  return position ? `${name} (${position})` : name;
};

const TBA_ROOM_KEY = /^EXTRA-(LAB|LEC)-([1-9]\d*)$/;

// A TBA room to request (internally EXTRA-LAB-n / EXTRA-LEC-n): "TBA room 2 (lecture)". Only the
// Room Program and the editor name it; everywhere else a class in one reads "TBA (LBC)".
export const tbaRoomName = (key) => {
  const m = TBA_ROOM_KEY.exec(String(key || ''));
  return m ? `TBA room ${m[2]} (${m[1] === 'LAB' ? 'lab' : 'lecture'})` : 'TBA';
};

// The print title of a TBA room: "TBA ROOM 2 (LECTURE)".
export const tbaRoomTitle = (key) => {
  const m = TBA_ROOM_KEY.exec(String(key || ''));
  return m ? `TBA ROOM ${m[2]} (${m[1] === 'LAB' ? 'LAB' : 'LECTURE'})` : 'TBA';
};

export const isTbaRoomKey = (key) => TBA_ROOM_KEY.test(String(key || ''));

// A message of the validator or the GA may name a TBA room by its stored name ("Extra LAB room 1
// (TBA – to request)"); on screen it reads as its TBA name ("TBA room 1 (lab)"). The GA result and
// the Schedule Views & Editor both show messages through this.
export const tbaRoomWording = (text) => String(text ?? '')
  .replace(/Extra (LAB|LEC) room ([1-9]\d*)(?: \(TBA – to request\))?/g, (_, type, n) => tbaRoomName(`EXTRA-${type}-${n}`));

// Phase 8 (the office's room names): on prints, rooms carry the names the office writes
// ("Computer Laboratory 1", "Room 47"); screens keep the system's short names ("LAB 1", "ROOM 47").
// AVR, TSL and borrowed rooms read the same everywhere.
export const officeRoomName = (name) => {
  const text = String(name || '').trim();
  const lab = /^LAB\s*(\d+)$/i.exec(text);
  if (lab) return `Computer Laboratory ${lab[1]}`;
  const room = /^ROOM\s*(\d+)$/i.exec(text);
  if (room) return `Room ${room[1]}`;
  return text;
};

// Line 3 of a class box: the room and the campus code, "ROOM 47 (LBC)". Both kinds of TBA read
// "TBA (LBC)" (no CCS room needed, and a TBA room to request); an online meeting reads "Online".
// officeNames: the office's room names, for prints (Phase 8).
export const roomLine = (cls, campusCode = '', { officeNames = false } = {}) => {
  if (cls?.roomKind === 'ONLINE') return 'Online';
  const stored = (cls?.roomKind === 'CCS' || cls?.roomKind === 'BORROWED') && cls?.roomName ? cls.roomName : 'TBA';
  const real = officeNames && stored !== 'TBA' ? officeRoomName(stored) : stored;
  return campusCode ? `${real} (${campusCode})` : real;
};

// Line 1: the subject code, "ITEC 102 (LAB)" for a lab meeting; NSTP with its component when it is
// known ("NSTP 1 (CWTS)").
export const codeLine = (cls) => {
  const code = String(cls?.subjectCode || '').trim();
  if (cls?.isNstp) return cls?.nstpComponent ? `${code} (${cls.nstpComponent})` : code;
  return cls?.classType === 'LAB' ? `${code} (LAB)` : code;
};

// Phase 8 (odd and even weeks): the group's name in the Dean's words, and the Mother Schedule's note
// on a section's weeks. null when the class or section has no group (it meets every week).
export const weekGroupWords = (weekGroup) => (weekGroup === 'ODD' ? 'Odd weeks' : weekGroup === 'EVEN' ? 'Even weeks' : null);
export const sectionWeeksNote = (weekGroup) => (weekGroup === 'ODD'
  ? 'Face-to-face in the odd weeks, online in the even weeks, at the same times.'
  : weekGroup === 'EVEN' ? 'Face-to-face in the even weeks, online in the odd weeks, at the same times.' : null);

// The four lines of a class box, one item per line. In the Room Program line 3 shows the section
// instead of the room, with the class's week group when the odd/even practice is on ("BSIT 1A · Odd
// weeks"); in the Teachers' Program line 4 shows the section instead of the professor.
// view: 'section' | 'professor' | 'room'.
// fit (WeeklyTable): the code stays on one line ('nowrap'), the title is one line cut with "..."
// ('ellipsis'); lines 3 and 4 may wrap (two lines; line 4 three in a tall box), so the professor's
// position still shows.
export const classLines = (cls, view, { campusCode = '', officeNames = false } = {}) => {
  // Phase 8 Part 3 (decision 2): an On-The-Job Training record draws as the forms write it — on the
  // professor's views the practicum code, "On-The-Job Training" and the section (the scans' box); on
  // the section's the code, the title and the coordinator, with no room line (it takes no room).
  if (cls?.classType === 'OJT') {
    return view === 'professor'
      ? [
        { text: codeLine(cls), bold: true, fit: 'nowrap' },
        { text: 'On-The-Job Training', fit: 'ellipsis' },
        { text: String(cls?.sectionLabel || '') },
        { text: '' }
      ]
      : [
        { text: codeLine(cls), bold: true, fit: 'nowrap' },
        { text: String(cls?.subjectTitle || ''), bold: true, fit: 'ellipsis' },
        { text: '' },
        { text: professorLine(cls) }
      ];
  }
  return [
    { text: codeLine(cls), bold: true, fit: 'nowrap' },
    { text: String(cls?.subjectTitle || ''), bold: true, fit: 'ellipsis' },
    { text: view === 'room' ? [String(cls?.sectionLabel || ''), weekGroupWords(cls?.weekGroup)].filter(Boolean).join(' · ') : roomLine(cls, campusCode, { officeNames }) },
    { text: view === 'professor' ? String(cls?.sectionLabel || '') : professorLine(cls) }
  ];
};

// One sentence a screen reader reads for a class box.
export const classSummary = (cls, view, options) => {
  const lines = classLines(cls, view, options).map(l => l.text).filter(Boolean);
  return `${cls?.day} ${timeLabel(cls?.startTime)} to ${timeLabel(cls?.endTime)}: ${lines.join(', ')}`;
};

// A number of hours as the forms write it: at most two decimals, no trailing zeros ("11.25", "43",
// "7.5"). hoursText adds the unit.
export const numberText = (n) => String(Math.round(Number(n || 0) * 100) / 100);

// Phase 8 Part 2 (decision F2): the standard FULL-TIME teaching load as information — "Standard load:
// 18 h", and full-time teaching above it as "Overload: N h". Information only: the caps still gate
// assignments, and nothing changes on the printed SF-029. null when the policy carries no standard.
export const standardLoadLine = ({ teaching, employmentType, standardTeachingHours } = {}) => {
  const standard = Number(standardTeachingHours);
  if (!Number.isFinite(standard) || standard <= 0) return null;
  const over = employmentType === 'FULL_TIME' && Number.isFinite(Number(teaching)) && Number(teaching) > standard
    ? Math.round((Number(teaching) - standard) * 100) / 100
    : 0;
  return { text: `Standard load: ${numberText(standard)} h`, overload: over > 0 ? `Overload: ${numberText(over)} h` : null };
};

// "2 h", "1.5 h"
export const hoursText = (hours) => `${numberText(hours)} h`;

// Phase 8 Part 4 (decision 1): a professor's teaching load against their RANGE — the minimum and the
// cap — "14 of 18–21 h", with "4 h under" (shown in amber) while the load sits below the minimum.
// Over the cap keeps its existing displays. null while the profile has no teaching cap on record.
export const loadRangeLine = ({ teaching, min, cap } = {}) => {
  const hi = Number(cap);
  if (!Number.isFinite(hi)) return null;
  const t = Number.isFinite(Number(teaching)) ? Number(teaching) : 0;
  const low = Number.isFinite(Number(min)) ? Math.max(0, Number(min)) : 0;
  const under = Math.max(0, Math.round((low - t) * 100) / 100);
  return {
    text: `${numberText(t)} of ${numberText(low)}–${numberText(hi)} h`,
    under: under > 0 ? `${numberText(under)} h under` : null
  };
};

// ---------------------------------------------------------------- the Teachers' Program (Step 2)
// Its content comes computed from GET /schedule/outputs (faculty[]: header, summary, ancillary,
// dayTotals, all from the gateway's one load rule, utils/load.js); these helpers only word it.

// The left side of the SF-029's lab line: the lab hours × the lab factor of the employment type, the
// factor written without its leading zero as on the form: "15 × .75", "15 × 1". '' without a factor.
// The printed form puts it after "(Lab.)" and the weighted hours in the hours column.
export const labFactorExpression = (hours, factor) => {
  if (factor === null || factor === undefined || factor === '' || !Number.isFinite(Number(factor))) return '';
  return `${numberText(hours)} × ${numberText(factor).replace(/^0\./, '.')}`;
};

// The SF-029's lab line: the lab hours × the lab factor of the employment type = the weighted hours:
// "15 × .75 = 11.25"; "15 × 1 = 15" for a factor of 1. Without a factor only the weighted hours are
// shown.
export const labFactorLine = (hours, factor, weighted) => {
  const expression = labFactorExpression(hours, factor);
  return expression ? `${expression} = ${numberText(weighted)}` : numberText(weighted);
};

// The value of one line of the load summary (faculty[].summary): the lab line as "15 × .75 = 11.25",
// any other line its hours; blank when the line has none (an ancillary type the professor doesn't
// have, or no Excess), as on the form.
export const summaryValue = (line) => {
  if (!line || line.hours === null || line.hours === undefined) return '';
  return line.key === 'LAB' ? labFactorLine(line.hours, line.factor, line.weighted) : numberText(line.hours);
};

// The lines of an ancillary duty block: its label as on the real forms ("RESEARCH", "EXTENSION
// SERVICES", …) in bold, wrapping as far as the box allows, then its time range when the box has
// room for a second line (withTime).
export const dutyLines = (duty, { withTime = true } = {}) => [
  { text: String(duty?.label || ''), bold: true, fit: 'wrap' },
  ...(withTime ? [{ text: timeRangeLabel(duty?.start, duty?.end) }] : [])
];

// The day totals under the grid (faculty[].dayTotals: the teaching hours of each day — classes and
// On-The-Job Training, labs at the professor's lab factor, never the duty blocks; Phase 8 Part 3,
// decision 1c) as WeeklyTable's totalsRow: "Total 21 hours" in the TIME column, then each day's hours
// in its column, Saturday and Sunday blank when 0 as on every office form. null without totals.
export const dayTotalsRow = (dayTotals) => {
  if (!dayTotals || typeof dayTotals !== 'object') return null;
  const total = Number(dayTotals.total) || 0;
  return {
    label: `Total ${numberText(total)} hour${total === 1 ? '' : 's'}`,
    days: Object.fromEntries(WEEK_DAYS.map(day => {
      const hours = Number(dayTotals.days?.[day]) || 0;
      const blankWhenZero = day === 'Saturday' || day === 'Sunday';
      return [day, blankWhenZero && !(hours > 0) ? '' : numberText(hours)];
    }))
  };
};

// The lines of an On-The-Job Training box (Phase 4 Part 4; faculty[].practicum.blocks): the practicum
// code in bold, "On-The-Job Training", then the section, as the real forms print them.
export const practicumLines = (block) => [
  { text: String(block?.subjectCode || ''), bold: true, fit: 'nowrap' },
  { text: String(block?.label || 'On-The-Job Training') },
  { text: String(block?.sectionLabel || '') }
];

// Hours of an ancillary duty the grid had no free time for (the summary still counts them):
// "2 h of RESEARCH not placed on the grid"; an On-The-Job Training box that did not fit names its
// section: "2 h of On-The-Job Training (BSIT 4A WMAD) not placed on the grid".
export const unplacedText = (item) => `${hoursText(item?.hours)} of ${String(item?.label || item?.type || '')}${item?.sectionLabel ? ` (${item.sectionLabel})` : ''} not placed on the grid`;

// A signatory line as printed (the printed forms' shared rule). The Teachers' Program's automatic
// line carries the professor's name and position; any other line its own name and title. An empty
// name stays a blank line to sign on, never a placeholder.
export const signedBy = (line, professor) => (line?.auto === 'professor'
  ? { name: professor?.name || '', title: professor?.position || '' }
  : { name: line?.name || '', title: line?.title || '' });

// A version's name as the Dean sees it (Phase 4 Part 4): the lock-only Draft that Assign Faculty makes
// before any run ("v0.1-pregen") reads "Assignments (before generating)"; any other name is itself.
export const PREGEN_VERSION = 'v0.1-pregen';
export const versionName = (version) => (String(version ?? '').trim() === PREGEN_VERSION ? 'Assignments (before generating)' : String(version ?? ''));

// "The CCS rooms can't hold 97 classes. Request 2 lab rooms and 5 lecture rooms from other
// departments." (null when no class needed a TBA room.)
// Phase 4 Part 4 (Part 1's open question 4): the same words as the Generate result ("85 classes are in
// TBA rooms: 3 lab and 3 lecture rooms to request."), exact after a Fill TBA rooms too.
export const tbaRequestHeader = (tba) => {
  if (!tba || !(tba.classCount > 0)) return null;
  const lab = Number(tba.labRooms) || 0;
  const lec = Number(tba.lecRooms) || 0;
  const parts = [lab > 0 ? `${lab} lab` : null, lec > 0 ? `${lec} lecture` : null].filter(Boolean);
  const rooms = parts.length ? `: ${parts.join(' and ')} ${lab + lec === 1 ? 'room' : 'rooms'} to request` : '';
  const n = tba.classCount;
  return `${n} class${n === 1 ? '' : 'es'} ${n === 1 ? 'is' : 'are'} in ${n === 1 ? 'a TBA room' : 'TBA rooms'}${rooms}.`;
};

// The free times of a borrowed room (its availability windows, [{ day, start, end }]) in words, as the
// Rooms page and "Fill TBA rooms" show them: "Mon 1:00 PM–5:00 PM · Thu 1:00 PM–5:00 PM"; days in a
// row with the same times read as one ("Mon–Fri 8:00 AM–12:00 PM"). `none` is the wording for a room
// without windows (a CCS room is free whenever classes run).
export const availabilityWords = (windows, none = 'Whenever classes run') => {
  const list = (Array.isArray(windows) ? windows : []).filter(w => w && w.day && w.start && w.end);
  if (!list.length) return none;
  const dayIndex = (day) => DAY_NAMES.indexOf(day);
  const sorted = [...list].sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0));
  // Runs of days in a row with the same time range, each listed from its first day; any other window
  // is its own entry.
  const runs = [];
  for (const w of sorted) {
    const time = formatRange12(w.start, w.end);
    const run = runs.find(r => r.time === time && dayIndex(w.day) >= 0 && dayIndex(w.day) === dayIndex(r.to) + 1);
    if (run) run.to = w.day;
    else runs.push({ from: w.day, to: w.day, time });
  }
  const short = (day) => String(day).slice(0, 3);
  return runs.map(r => `${r.from === r.to ? short(r.from) : `${short(r.from)}–${short(r.to)}`} ${r.time}`).join(' · ');
};
