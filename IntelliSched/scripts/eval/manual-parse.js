// Phase 10, Step 1: reading the office's manual schedule of 2nd Sem AY 2025-26. Pure functions, tested in
// server/tests/unit/evalManualParse.test.js; the driver is scripts/eval/manual-schedule.js.
//
// The two Word files are dumped by dump_docx_tables.py: every row's cells in grid order with the vertical
// merge state. A BLOCK is one cell merged down over several 30-minute rows: its start is the first row's
// start, its end the last row's end; the weekday is the column. The cell's lines are the subject code, the
// title, LEC/LAB, the teacher ("M. Anquillo") and, in the room file, the section ("BSIT II B").
//
// Names are mapped by fixed rules only (never a guess): a name the rules cannot place is "unmapped".
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ROMAN = { I: 1, II: 2, III: 3, IV: 4 };
const TO_ROMAN = ['', 'I', 'II', 'III', 'IV'];

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const minutesOf = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// "8:00 – 8:30", "12:30 – 1:00", "1:00 – 1:30" (the forms run 7:00 AM to 5:00 PM, so 1–6 o'clock is PM).
const rowTimes = (label) => {
  const m = /(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/.exec(String(label));
  if (!m) return null;
  const at = (h, mm) => { let hour = Number(h); if (hour < 7) hour += 12; return hour * 60 + Number(mm); };
  return { start: at(m[1], m[2]), end: at(m[3], m[4]) };
};

// Blocks of one dumped table: { day, start, end, lines, firstRow }. Column 0 is the time; columns 1.. the days
// named in the header row. A merge "restart" opens a block, "continue" extends the open block of that column,
// a plain cell with text is a block of its own row, an empty plain cell closes the column's block.
const tableBlocks = (rows) => {
  const header = rows[0].map(c => (c.lines[0] || '').trim().toUpperCase());
  const dayOfCol = new Map();
  header.forEach((h, i) => { const d = DAYS.find(x => x.toUpperCase() === h); if (d) dayOfCol.set(rows[0][i].col, d); });
  const open = new Map();
  const blocks = [];
  rows.slice(1).forEach((row, r) => {
    const time = rowTimes(row[0] && row[0].lines.join(' '));
    if (!time) return;
    for (const cell of row.slice(1)) {
      const day = dayOfCol.get(cell.col);
      if (!day) continue;
      if (cell.merge === 'continue' && open.has(cell.col)) { open.get(cell.col).end = time.end; continue; }
      open.delete(cell.col);
      if (cell.lines.length) {
        const block = { day, start: time.start, end: time.end, lines: cell.lines, firstRow: r + 1 };
        blocks.push(block);
        if (cell.merge === 'restart') open.set(cell.col, block);
      }
    }
  });
  return blocks.map(b => ({ ...b, start: hhmm(b.start), end: hhmm(b.end), hours: (b.end - b.start) / 60 }));
};

const SECTION_RE = /\b(BS[A-Z]{2}|BIST)\b[\s-]*([IVX]+|\d)?[\s-]*([A-D])?(?![A-Za-z])[\s-]*(WMAD|AMG|SMP|IS)?\b/i;
const SECTION_ANY = /\b(BS[A-Z]{2}|BIST)\b.*$/i;
const TEACHER_LINE = /^([A-Z])\.?\s+([A-Za-z][A-Za-z]+(?:\s[A-Z][a-z]+)?)$/;
const TEACHER_GLUED = /([A-Z])\.\s*([A-Z][A-Za-z]+)\s*$/;

// One cell's text lines -> { code, title, kind (LEC|LAB|null), teacher ("M. Anquillo"|null), sectionText|null }.
const parseCell = (lines) => {
  let rest = lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let sectionText = null; let teacher = null; let kind = null;
  rest = rest.map((line) => {
    const s = SECTION_ANY.exec(line);
    if (s && !sectionText && (s.index > 0 || /^(BS[A-Z]{2}|BIST)\b/i.test(line))) { sectionText = s[0].trim(); return line.slice(0, s.index).trim(); }
    return line;
  }).filter(Boolean);
  rest = rest.filter((line) => {
    if (/^(LEC|LAB)$/i.test(line)) { kind = line.toUpperCase(); return false; }
    const t = TEACHER_LINE.exec(line);
    if (t && !teacher && !/^(LEC|LAB)/i.test(line)) { teacher = `${t[1]}. ${t[2]}`; return false; }
    return true;
  });
  // A teacher glued to the line before ("LABM. Faculty", "Art AppreciatioC.  Dimagiba", "RizalR. HILARIO").
  if (!teacher && rest.length) {
    const last = rest[rest.length - 1];
    const g = TEACHER_GLUED.exec(last);
    if (g) { teacher = `${g[1]}. ${g[2]}`; rest[rest.length - 1] = last.slice(0, g.index).trim(); }
  }
  rest = rest.map((line) => {
    const k = /^(LEC|LAB)\b\s*/i.exec(line) || /\s*\b(LEC|LAB)$/i.exec(line);
    if (k && !kind) { kind = k[1].toUpperCase(); return line.replace(k[0], ' ').trim(); }
    return line;
  }).filter(Boolean);
  const first = rest[0] || '';
  const c = /^([A-Z]{2,7}(?:\.[A-Z]\.)?)\s*(\d{1,3})?/.exec(first.replace(/^P\.I\./, 'PI'));
  const code = c ? `${c[1]}${c[2] ? ` ${c[2]}` : ''}` : '';
  const title = [first.slice(c ? c[0].length : 0), ...rest.slice(1)].join(' ').replace(/\s+/g, ' ').replace(/^[\s/]+/, '').trim();
  return { code, title, kind, teacher, sectionText };
};

// ---- names
const squash = (s) => String(s || '').toUpperCase().replace(/[\s.-]+/g, '');
const romanise = (s) => String(s || '').replace(/\b(BS[A-Z]{2})\s*([1-4])\s*([A-D])?\b/gi, (all, p, y, l) => `${p} ${TO_ROMAN[Number(y)]}${l ? ` ${l}` : ''}`);
// The office's section labels: "BSIT IIB", "BSIT III A WMAD", "BSCS IV IS" (the eval term's sameAsLastYear).
// printed -> the system's code, by the label with spaces, dots and hyphens removed and digits written as
// Roman numerals; a label that is not exactly one of them (e.g. "BSIT III A", "BIST II C") is unmapped.
const sectionMapper = (sections) => {
  const byLabel = new Map(sections.map(s => [squash(s.sameAsLastYear), s.sectionCode]));
  return (printed) => byLabel.get(squash(romanise(printed))) || null;
};
// "Program: Bachelor of Science in Information Technology  Year: III  Section: A WMAD" -> "BSIT III A WMAD".
const headingLabel = (heading) => {
  const text = heading.join(' ');
  const p = /Information Technology/i.test(text) ? 'BSIT' : /Computer Science/i.test(text) ? 'BSCS' : null;
  const y = /Year:\s*([IV]+)/i.exec(text); const s = /Section:\s*([A-Z ]+?)\s*$/i.exec(text.trim());
  return p && y && s ? `${p} ${y[1].toUpperCase()} ${s[1].trim().toUpperCase()}` : null;
};

// Rooms: the office's names -> the system's room names (CCS rooms only).
const ROOM_RULES = [
  [/^(computer\s+)?laboratory\s*([1-4])$/i, (m) => `LAB ${m[2]}`],
  [/^lab\s*4\s*\(lecture room\)$/i, () => 'LAB 4'],
  [/^lecture room 1 \(tsl room\)$/i, () => 'TSL'],
  [/^ccs room 47$/i, () => 'ROOM 47'],
  [/^avr$/i, () => 'AVR']
];
const roomOf = (name) => { for (const [re, to] of ROOM_RULES) { const m = re.exec(String(name).trim()); if (m) return to(m); } return null; };
// A room table's heading -> { printedRoom, room, weekGroup }: "Week 1 and 3" = odd weeks, "Week 2 and 4" = even.
const roomHeading = (heading) => {
  const lines = heading.filter(l => !/College of Computer Studies|Semester/i.test(l));
  const first = lines[0] || '';
  const w = /Week\s*1\s*and\s*3/i.test(first) ? 'ODD' : /Week\s*2\s*and\s*4/i.test(first) ? 'EVEN' : 'ALL';
  const printedRoom = first.replace(/Week\s*\d\s*and\s*\d/i, '').trim();
  return { printedRoom, room: roomOf(printedRoom), weekGroup: w };
};

// Teachers: "M. Anquillo" -> a faculty name. Rules, in order: (1) exactly one professor with this surname
// (letters only, case ignored); (2) exactly one whose surname is one letter away (a spelling slip: Anquillo /
// Faculty) and whose first initial matches; (3) exactly one whose FIRST name is the printed word and whose
// initial matches ("M. Morris" for Morris Virtus Faculty). Otherwise unmapped (other colleges' teachers too).
const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const editDistance1 = (a, b) => {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) === 1;
};
const surnameOf = (full) => {
  const words = String(full).replace(/,.*$/, '').split(/\s+/).filter(w => !/^(jr|sr|ii|iii|phd)\.?$/i.test(w));
  return words[words.length - 1];
};
const teacherMapper = (faculty) => {
  const people = faculty.map(f => ({ name: f.name, surname: letters(surnameOf(f.name)), first: letters(f.name.split(/\s+/)[0]), initial: f.name[0].toUpperCase() }));
  return (printed) => {
    const m = /^([A-Z])\.?\s*(.+)$/i.exec(String(printed || '').trim());
    if (!m) return { name: null, rule: 'not a name' };
    const initial = m[1].toUpperCase(); const word = letters(m[2]);
    const exact = people.filter(p => p.surname === word);
    if (exact.length === 1) return { name: exact[0].name, rule: exact[0].initial === initial ? 'surname' : 'surname (initial differs)' };
    const near = people.filter(p => editDistance1(p.surname, word) && p.initial === initial);
    if (!exact.length && near.length === 1) return { name: near[0].name, rule: 'surname, one letter off' };
    const byFirst = people.filter(p => p.first === word && p.initial === initial);
    if (!exact.length && !near.length && byFirst.length === 1) return { name: byFirst[0].name, rule: 'printed with the first name' };
    return { name: null, rule: 'not on the faculty list' };
  };
};

// Subjects: a printed (code, title) -> one of the section's subjects in the IntelliSched term, by the
// title's words (Jaccard) plus the code's number; the best must reach 0.5, or 0.3 with the same number.
const STOP = new Set(['and', 'of', 'the', 'in', 'to', 'a', 'sa', 'ng']);
const words = (s) => new Set(String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter(w => w && !STOP.has(w)).map(w => (w.length > 3 ? w.replace(/s$/, '') : w)));
const jaccard = (a, b) => { const A = words(a); const B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };
const numberOf = (code) => (/(\d{3})/.exec(code || '') || [])[1] || null;
const matchSubject = (printed, candidates) => {
  let best = null;
  for (const c of candidates) {
    const titleScore = Math.max(jaccard(printed.title, c.subjectTitle), jaccard(`${printed.code} ${printed.title}`, `${c.subjectCode} ${c.subjectTitle}`));
    const sameNumber = numberOf(printed.code) && numberOf(printed.code) === numberOf(c.subjectCode);
    const sameCode = squash(printed.code) === squash(c.subjectCode);
    const score = titleScore + (sameNumber ? 0.1 : 0) + (sameCode ? 0.1 : 0);
    const ok = titleScore >= 0.5 || (sameNumber && titleScore >= 0.3) || (sameCode && !printed.title);
    if (ok && (!best || score > best.score)) best = { subject: c, score };
  }
  return best;
};

module.exports = { tableBlocks, rowTimes, parseCell, sectionMapper, headingLabel, roomOf, roomHeading, teacherMapper, matchSubject, jaccard, minutesOf, hhmm, ROMAN };
