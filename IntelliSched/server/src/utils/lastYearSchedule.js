// Last year's manual schedule as the transcribed Teachers' Programs hold it (Phase 8 Part 5):
// docs/data/past_class_blocks.csv, the four past semesters typed from the scanned SF-029s. The one
// reader for the single-class-day comparison the Generate result and the system check show next to
// a generated schedule's own counts ("the number to beat", the Part 5 prompt).
//
// A class row: level UNDERGRAD, a subject code, and kind LEC, LAB or UNSPECIFIED — never OJT and
// never a duty row (CEE, RESEARCH, ...). The program and section columns may be blank on a real
// form (Faculty's ITST 305 lab names no section), so they are not required: the professor still
// comes to school for the class. A single-class day is a WEEKDAY on which a professor (or a
// section) has exactly one such row; Saturday never counts, like the validator's own rule. The
// section side counts only rows with a printed section, and the forms are the CCS professors' own,
// so other colleges' GenEd classes are not in them: the section count is "CCS-taught classes only"
// and every caller says so.
const fs = require('fs');
const path = require('path');

const CSV_FILE = path.resolve(__dirname, '../../../docs/data/past_class_blocks.csv');
const WEEKDAYS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
const CLASS_KINDS = new Set(['LEC', 'LAB', 'UNSPECIFIED']);

// The CSV's label for the same semester one academic year earlier ("2nd Sem AY 2025-26" for the
// 2nd Semester of AY 2026-2027), or null when the term is not named that way.
const lastYearTermLabel = ({ academicYear, semester }) => {
  const m = /^(\d{4})-(\d{4})$/.exec(String(academicYear || '').trim());
  const sem = Number(semester);
  if (!m || ![1, 2].includes(sem)) return null;
  return `${sem === 1 ? '1st' : '2nd'} Sem AY ${Number(m[1]) - 1}-${String(Number(m[2]) - 1).slice(2)}`;
};

// One CSV line's fields. Some transcribed titles are quoted and hold commas ("Digital Arts,
// Photography and Print Media"), so a plain split would shift every later column of such a row.
const splitCsvLine = (line) => {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { fields.push(field); field = ''; } else field += ch;
  }
  fields.push(field);
  return fields;
};

// The transcribed class rows of one semester label.
const classRowsOf = (label, csvFile = CSV_FILE) => {
  const lines = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  const head = splitCsvLine(lines[0]);
  return lines.slice(1)
    .map((line) => {
      const fields = splitCsvLine(line);
      return Object.fromEntries(head.map((key, i) => [key, fields[i] ?? '']));
    })
    .filter(r => r.semester === label && r.level === 'UNDERGRAD' && r.code && CLASS_KINDS.has(r.kind));
};

// { professors, sections } — the single-class days of one transcribed semester — or null when the
// CSV is missing or holds no rows for that label (never an invented number).
const singleClassDaysOf = (termLabel, csvFile = CSV_FILE) => {
  let rows;
  try {
    rows = classRowsOf(termLabel, csvFile);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const perDay = (keyOf) => {
    const groups = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (!key || !WEEKDAYS.has(r.day)) continue;
      const k = `${key}|${r.day}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    return [...groups.values()].filter(n => n === 1).length;
  };
  return { professors: perDay(r => r.faculty), sections: perDay(r => r.section_as_printed) };
};

// { termLabel, professors, sections, note } — the single-class days of last year's manual schedule
// — or null when the CSV is missing or holds no rows for that semester (never an invented number).
const lastYearSingleClassDays = ({ academicYear, semester, csvFile = CSV_FILE } = {}) => {
  const termLabel = lastYearTermLabel({ academicYear, semester });
  if (!termLabel) return null;
  const counts = singleClassDaysOf(termLabel, csvFile);
  if (!counts) return null;
  return {
    termLabel,
    ...counts,
    note: 'From the transcribed Teachers’ Programs (docs/data/past_class_blocks.csv): weekdays with exactly one class row, OJT and duty rows left out. The section count sees CCS-taught classes only (other colleges’ GenEd classes are not on those forms).'
  };
};

module.exports = { lastYearTermLabel, lastYearSingleClassDays, singleClassDaysOf, classRowsOf };
