// "Download CSV" (Phase 3 Step 3): the classes of a schedule version as a spreadsheet file. Print
// Outputs downloads the chosen output (one section, professor or room, or all of them); the Schedule
// Views & Editor downloads the classes it shows. The rows come from GET /schedule/outputs (the same
// schedule records as every output); nothing here computes a number.
//
// The file: UTF-8 with a byte-order mark (so Excel reads accented names correctly), CRLF line ends,
// RFC 4180 quoting (a field with a comma, a quote or a line break is quoted, quotes doubled), and the
// column names on the first line. No form code and no header lines above them.
import { timeLabel } from './scheduleDisplay';

export const SCHEDULE_CSV_COLUMNS = ['Section', 'Subject code', 'Subject title', 'LEC or LAB', 'Day', 'Start', 'End', 'Room', 'Professor'];

const BOM = String.fromCharCode(0xFEFF);

// The Room column: the real room's name; "TBA" for every TBA class (one that needs no CCS room, and
// one in a TBA room to request); "Online" for an online meeting.
export const csvRoom = (cls) => {
  if (cls?.roomKind === 'ONLINE') return 'Online';
  return (cls?.roomKind === 'CCS' || cls?.roomKind === 'BORROWED') && cls?.roomName ? cls.roomName : 'TBA';
};

// The Professor column: the name, or "TBA" when the class has no professor.
export const csvProfessor = (cls) => {
  const name = String(cls?.facultyName || '').trim();
  return cls?.facultyRef && name && name !== 'TBA' ? name : 'TBA';
};

// One class: its section (with its track, as on the outputs), the catalog's code and title, LEC or
// LAB, the day, "08:00 AM" start and end, the room and the professor.
export const scheduleCsvRow = (cls) => [
  cls?.sectionLabel || cls?.sectionCode || '',
  cls?.subjectCode || '',
  cls?.subjectTitle || '',
  cls?.classType || '',
  cls?.day || '',
  cls?.startTime ? timeLabel(cls.startTime) : '',
  cls?.endTime ? timeLabel(cls.endTime) : '',
  csvRoom(cls),
  csvProfessor(cls)
];

const csvField = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Rows (arrays of fields) as CSV text: one CRLF-ended line per row.
export const toCsvText = (rows) => rows.map(row => `${row.map(csvField).join(',')}\r\n`).join('');

// The whole file for these classes, in the order given, with the byte-order mark.
export const scheduleCsv = (classes) => `${BOM}${toCsvText([SCHEDULE_CSV_COLUMNS, ...(classes || []).map(scheduleCsvRow)])}`;

// A file name without the characters Windows refuses: "Mother Schedule - BSIT 1A - 1st Semester AY
// 2025-2026.csv".
export const csvFileName = (parts) => `${parts.filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()}.csv`;

// Saves the text as a file through a Blob (never a data: address, which cuts the file at a "#").
export const downloadCsv = (fileName, text) => {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has started from the link; the address is no longer needed.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// The classes of a version as a CSV download (see scheduleCsv).
export const downloadScheduleCsv = (fileName, classes) => downloadCsv(fileName, scheduleCsv(classes));
