// What the print view (pages/print/PrintView.jsx) and Print Outputs (pages/analytics/PrintOutputs.jsx)
// share (Phase 3 Step 3): the three outputs, the print view's address, which sections, professors and
// rooms a print covers, and how a sheet names them. Every fact comes from GET /schedule/outputs (the
// same schedule records as every output); nothing here computes an hour or a count.
import { WEEK_DAYS, classLines, classSummary, hoursText, officeRoomName, tbaRoomName, tbaRoomTitle } from '../../utils/scheduleDisplay';
import { fromMinutes, toMinutes } from '../../utils/timeGrid';

// The three outputs, by the name the print view's address uses. view: the Schedule Views' view of the
// same output; settingsKey: its part of the Output Settings.
export const PRINT_OUTPUTS = {
  'mother-schedule': { id: 'mother-schedule', view: 'section', name: 'Mother Schedule', settingsKey: 'motherSchedule', noun: 'section', nounPlural: 'sections' },
  'teachers-program': { id: 'teachers-program', view: 'professor', name: "Teachers' Program", settingsKey: 'teachersProgram', noun: 'professor', nounPlural: 'professors' },
  'room-program': { id: 'room-program', view: 'room', name: 'Room Program', settingsKey: 'roomProgram', noun: 'room', nounPlural: 'rooms' }
};
export const outputOfView = (view) => Object.values(PRINT_OUTPUTS).find(o => o.view === view) || null;

// The print view's address, "#/print?output=mother-schedule&scheduleId=…&id=…" (App.jsx shows the
// print view for it):
//   output        mother-schedule | teachers-program | room-program
//   scheduleId    the version (else the term's official one: the Approved version, else the
//                 newest Draft)
//   id | all | tba
//                 one section, professor or room (its id; a room's key), all of them, or the TBA rooms
//                 to request (Room Program only)
//   layout        sf029 | table: the Teachers' Program's layout for this print (else the setting's)
//   academicYear, semester
//                 the term (else the term chosen in the app)
export const printAddress = ({ output, scheduleId = null, id = null, all = false, tba = false, layout = null, academicYear = null, semester = null }) => {
  const q = new URLSearchParams({ output });
  if (scheduleId) q.set('scheduleId', String(scheduleId));
  if (id) q.set('id', String(id));
  if (all) q.set('all', '1');
  if (tba) q.set('tba', '1');
  if (layout) q.set('layout', String(layout).toLowerCase());
  if (academicYear) q.set('academicYear', academicYear);
  if (semester) q.set('semester', String(semester));
  return `#/print?${q.toString()}`;
};

// The print view's address read back ("output=…&id=…", the part after "#/print?"). Anything it does
// not know is left out; output stays '' when it names no output.
export const parsePrintAddress = (search) => {
  const q = new URLSearchParams(search || '');
  const output = q.get('output') || '';
  const semester = Number(q.get('semester'));
  const layout = String(q.get('layout') || '').toLowerCase();
  const academicYear = q.get('academicYear') || '';
  return {
    output: PRINT_OUTPUTS[output] ? output : '',
    scheduleId: q.get('scheduleId') || null,
    id: q.get('id') || null,
    all: q.get('all') === '1',
    tba: q.get('tba') === '1',
    layout: layout === 'sf029' ? 'SF029' : layout === 'table' ? 'TABLE' : null,
    academicYear: /^\d{4}-\d{4}$/.test(academicYear) ? academicYear : null,
    semester: semester === 1 || semester === 2 ? semester : null
  };
};

// Why a version prints with the "DRAFT – NOT APPROVED" watermark (any status but Approved): "This is a Draft", "This version is Under Review, not approved yet", "This version is
// Archived".
export const notApprovedText = (status) => (status === 'Draft' ? 'This is a Draft'
  : status === 'Under Review' ? 'This version is Under Review, not approved yet'
    : `This version is ${status || 'not approved'}`);

// "1st Semester, AY 2025-2026" (on the sheets); "1st Semester AY 2025-2026" (file and tab names).
export const termText = (schedule) => `${schedule.semesterLabel}, AY ${schedule.academicYear}`;
export const termFileText = (schedule) => `${schedule.semesterLabel} AY ${schedule.academicYear}`;
// "(2nd Semester. SY 2026-2027)": the period after "Semester" that every office form has (Phase 8
// Part 3, decision 1e).
export const sf029TermText = (schedule) => `(${schedule.semesterLabel}. SY ${schedule.academicYear})`;

// A text of the Output Settings as the gateway sent it (GET /schedule/outputs settings: the defaults
// merged with what the Dean saved, so every title is there). '' when it is missing: a form then prints
// nothing in its place, never a text made up here.
export const settingText = (value) => (typeof value === 'string' ? value : '');

// The Teachers' Program's two print layouts (Output Settings "Print layout"), and the one a print
// uses: the address's (layout=sf029|table) when it names one, else the setting's, else the SF-029
// form.
export const TP_LAYOUTS = { SF029: 'SF-029 form', TABLE: 'Class schedule table' };
export const teachersProgramLayout = (asked, settings) => (TP_LAYOUTS[asked] ? asked
  : settings?.teachersProgram?.layout === 'TABLE' ? 'TABLE' : 'SF029');

// A section, professor or room: its key (the section's or professor's id, a room's roomId or TBA
// key) and its name ("BSIT 3A WMAD", the professor's name, "ROOM 47", "TBA room 1 (lab)").
export const entityKey = (view, entity) => String(view === 'room' ? entity.key : entity.id);
export const entityName = (view, entity) => {
  if (view === 'section') return entity.label || entity.code || '';
  if (view === 'professor') return entity.name || '';
  return entity.kind === 'TBA' ? tbaRoomName(entity.key) : entity.name || '';
};

// Every section, professor or room of the version (the gateway's order).
// Phase 11.1: the office's order for the printed sets, worked out once by the gateway
// (utils/officeOrder.js) and sent as `officeOrder`; without it, the list stays in the answer's order.
const ORDER_KEY = { section: 'sections', professor: 'faculty', room: 'rooms' };
export const inOfficeOrder = (data, view, list) => {
  const order = data?.officeOrder?.[ORDER_KEY[view]];
  if (!Array.isArray(order)) return list;
  const at = new Map(order.map((k, i) => [String(k), i]));
  const keyOf = (e) => String(view === 'room' ? e.key : e.id);
  return [...list].sort((a, b) => (at.get(keyOf(a)) ?? order.length) - (at.get(keyOf(b)) ?? order.length));
};
export const allEntities = (data, view) => (view === 'section' ? data.sections : view === 'professor' ? data.faculty : data.rooms) || [];

// What "all" prints, in the gateway's order: the sections with at least one class; the professors with
// at least one class, a self-paced online lecture or an On-The-Job Training box (Phase 4 Part 4: their
// form has content too); every CCS and borrowed room (an empty one shows the room is free) and the TBA
// rooms that received classes.
const hasProgram = (e) => e.classCount > 0 || (Array.isArray(e.selfPaced) && e.selfPaced.length > 0) || (Array.isArray(e.practicum?.blocks) && e.practicum.blocks.length > 0);
export const printableEntities = (data, view) => inOfficeOrder(data, view, allEntities(data, view)
  .filter(e => (view === 'room' ? e.kind !== 'TBA' || e.classCount > 0 : view === 'professor' ? hasProgram(e) : e.classCount > 0)));

// The TBA rooms to request: those that received classes (LAB first, by number).
export const tbaRoomsOf = (data) => (data.rooms || []).filter(r => r.kind === 'TBA' && r.classCount > 0);

// The classes of one section, professor or room, by id (never by name).
export const classesOf = (classes, view, key) => (classes || []).filter(cls => (view === 'section'
  ? String(cls.sectionId) === key
  : view === 'professor'
    ? cls.facultyRef != null && String(cls.facultyRef) === key
    : cls.roomKey != null && String(cls.roomKey) === key));

const DAY_INDEX = Object.fromEntries(WEEK_DAYS.map((day, i) => [day, i]));
// By day of the week, then start.
export const byDayAndStart = (a, b) => ((DAY_INDEX[a.day] ?? 9) - (DAY_INDEX[b.day] ?? 9)) || String(a.startTime).localeCompare(String(b.startTime));

const YEAR_WORDS = { 1: '1st year', 2: '2nd year', 3: '3rd year', 4: '4th year' };
const ROOM_TYPE_WORDS = { LAB: 'lab', LEC: 'lecture' };

// The line under a sheet's title: the section's label with its program, track and year
// ("BSIT 3A WMAD", "BSIT, WMAD track, 3rd year"), or the room's name and kind; a TBA room reads
// "TBA ROOM 1 (LAB)", "To request from another department".
export const sectionHeading = (s) => ({
  name: s.label || s.code || '',
  detail: [s.program, s.track && s.track !== 'NONE' ? `${s.track} track` : null, YEAR_WORDS[s.yearLevel]].filter(Boolean).join(', ')
});
// Phase 8: on prints, rooms carry the office's names ("Computer Laboratory 1", "Room 47").
export const roomHeading = (r) => (r.kind === 'TBA'
  ? { name: tbaRoomTitle(r.key), detail: 'To request from another department' }
  : { name: officeRoomName(r.name) || '', detail: `${r.kind === 'BORROWED' ? 'Borrowed' : 'CCS'} ${ROOM_TYPE_WORDS[r.type] ? `${ROOM_TYPE_WORDS[r.type]} ` : ''}room` });

// A professor on the "Class schedule table" layout: the name, and the position and employment type
// ("Associate Professor III, Full-time").
const EMPLOYMENT_WORDS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
export const professorHeading = (f) => ({
  name: f?.header?.name || f?.name || '',
  detail: [f?.header?.position ?? f?.position, f?.header?.employmentLabel || EMPLOYMENT_WORDS[f?.employmentType]].filter(Boolean).join(', ')
});

// Under a Room Program's table: "12 h used of 50 h available on weekdays; 0 h of 10 h on Saturday"
// (Phase 4 Part 4: weekdays and Saturday apart, the Saturday part only while Saturday classes are on;
// a version read without the split still reads "12 h used of 60 h available"); a TBA room: "4 classes
// (12 h a week) need this room."
export const roomHoursText = (r) => {
  if (r.kind === 'TBA') return `${r.classCount} class${r.classCount === 1 ? '' : 'es'} (${hoursText(r.hoursUsed)} a week) need${r.classCount === 1 ? 's' : ''} this room.`;
  if (!Number.isFinite(Number(r.hoursAvailableWeekdays)) || r.hoursAvailableWeekdays === null) return `${hoursText(r.hoursUsed)} used of ${hoursText(r.hoursAvailable)} available`;
  const weekdays = `${hoursText(r.hoursUsedWeekdays ?? r.hoursUsed)} used of ${hoursText(r.hoursAvailableWeekdays)} available on weekdays`;
  return r.saturdayOpen ? `${weekdays}; ${hoursText(r.hoursUsedSaturday ?? 0)} of ${hoursText(r.hoursAvailableSaturday ?? 0)} on Saturday` : weekdays;
};

// The SF-029's grid (TeachersProgramForm.jsx): one row per slot of the version's day window
// ("7:00 – 7:30" … "4:30 – 5:00"), widened to any block that falls outside it, and each day's blocks
// as cells that span their rows (an HTML table's rowSpan). Blocks that overlap (only a Draft with a
// conflict can have them) share one cell, side by side.
//   items   [{ id, day, start, end, … }] ('HH:MM'), kept as given in their cells
// Returns { rows: [{ start, end }], cells: { Monday: [{ row, span, items }], … } } (cells by first
// row), or null without a day window.
export const periodGrid = ({ dayStart, dayEnd, slotMinutes, items = [] }) => {
  const slot = Number(slotMinutes);
  const windowStart = toMinutes(dayStart);
  const windowEnd = toMinutes(dayEnd);
  if (!(slot > 0) || windowStart === null || windowEnd === null || windowEnd <= windowStart) return null;
  const timed = (items || [])
    .map(item => ({ item, s: toMinutes(item.start), e: toMinutes(item.end) }))
    .filter(t => t.s !== null && t.e !== null && t.e > t.s && WEEK_DAYS.includes(t.item.day));
  const origin = Math.floor(Math.min(windowStart, ...timed.map(t => t.s)) / slot) * slot;
  const end = Math.ceil(Math.max(windowEnd, ...timed.map(t => t.e)) / slot) * slot;
  const rows = Array.from({ length: (end - origin) / slot }, (_, i) => ({ start: fromMinutes(origin + i * slot), end: fromMinutes(origin + (i + 1) * slot) }));
  const cells = Object.fromEntries(WEEK_DAYS.map(day => {
    const spans = timed
      .filter(t => t.item.day === day)
      .map(t => ({ item: t.item, first: Math.floor((t.s - origin) / slot), last: Math.ceil((t.e - origin) / slot) }))
      .sort((a, b) => (a.first - b.first) || (b.last - a.last));
    const merged = [];
    spans.forEach((sp) => {
      const open = merged[merged.length - 1];
      if (open && sp.first < open.last) {
        open.items.push(sp.item);
        open.last = Math.max(open.last, sp.last);
      } else merged.push({ first: sp.first, last: sp.last, items: [sp.item] });
    });
    return [day, merged.map(m => ({ row: m.first, span: m.last - m.first, items: m.items }))];
  }));
  return { rows, cells };
};

// The weekly table's blocks for these classes, in one view's words (the four lines of a class box).
// Prints use the office's room names (Phase 8).
export const classBlocks = (classes, view, campusCode = '') => (classes || []).map(cls => ({
  id: String(cls.itemId),
  day: cls.day,
  start: cls.startTime,
  end: cls.endTime,
  kind: 'class',
  lines: classLines(cls, view, { campusCode, officeNames: true }),
  testId: `print-block-${cls.itemId}`,
  ariaLabel: classSummary(cls, view, { campusCode, officeNames: true })
}));
