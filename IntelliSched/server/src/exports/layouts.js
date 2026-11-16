// The office's three forms as data. Since Phase 8 Part 9 this is the ONE place where the forms'
// positions are stored: every number is a position on the paper in mm from the top-left corner, or a
// size in points (Arial). pageModels.js turns them into each page's bands; the PDF (HTML) writer and the
// DOCX writer draw only from those bands, and the tests read the targets from here.
//
// Where the numbers come from (docs/formats/README.md has the table):
//   - the Teachers' Program (SF-029): last year's forms, pages 2, 3, 4, 9 and 12, measured at 200 and
//     300 dpi by the planning chat (they agree within 1 mm), re-measured in Part 9 Step 1 on the sample
//     page of Faculty (docs/formats/LSPU-ACAD-SF-029_Teachers-Program_sample-pages.pdf, page 1): the
//     grid 58.17–192.28, SUMMARY 196.26, "Approved:" 258.23, the footer 287.27 — all within 0.3 mm;
//   - the Class Schedule (SF-003): the office's Word file (its XML: the grid's columns and rows) and its
//     PDF (LSPU-ACAD-SF-003_…word.pdf, measured in Step 1: the letterhead 5.2–23.5, the college 27.8,
//     the title 34.0, the term 39.3, the program line 44.9); the signatories and footer from the prompt;
//   - the Room Schedule (Phase 11.2): the office's own Word file and Word's rendering of it (below).
// A text line's position is the top of its capitals (the "ink top" the scans were measured by).

const GRID_START = '07:00';
const GRID_END = '17:00';
const GRID_SLOT_MINUTES = 30;

// One twip is 1/1440 in; the DOCX writer converts once, at the end.
const MM_PER_PT = 25.4 / 72;
// Arial's line box (Word's single spacing and the HTML's line-height): 1.149 em; its capitals' top
// sits 0.205 em under the line box's top (half the line gap + the ascent − the cap height).
const LINE_EM = 1.149;
const CAP_TOP_EM = 0.205;
// The same padding on all four sides of every cell (Google Docs keeps one value per table): none. The
// office's lines sit 3.2–3.3 mm apart at 8 pt (a 3.24-mm line box), so there is no room for padding;
// the model places every line itself, and the fit rule keeps text off the borders.
const CELL_PAD_MM = 0;
// Borders, where the model has them: 0.5 pt.
const BORDER_PT = 0.5;
// The fit rule (decision 1): room to spare, the size steps and the smallest size.
const FIT = { spareHeightMm: 0.5, spareWidthFrac: 0.03, stepPt: 0.5, minPt: 6 };

// The letterhead pictures (decision 5): the seal and the three university lines in ONE picture, made
// by scripts/forms/build-letterheads.js with the headless browser at 300 dpi and committed beside it.
// box = where the picture sits on the page; inside = where its own seal and lines are drawn, in mm from
// the picture's top-left corner (the script draws them there and measures them back).
const LETTERHEADS = {
  sf029: {
    file: 'letterhead-sf029.png',
    box: { x: 46, y: 9.5, w: 116, h: 16 },
    seal: { x: 2, y: 1, w: 15, h: 15 },
    // Cap tops on the page: 10.7, 15.5, 21.2; centred on x 104 (58 in the picture).
    lines: [
      { text: 'Republic of the Philippines', font: 'narrow', pt: 11.1, capTop: 10.7 },
      { text: 'Laguna State Polytechnic University', font: 'blackletter', pt: 14, capTop: 15.5 },
      { text: 'Province of Laguna', font: 'narrow', pt: 11.1, capTop: 21.2 }
    ],
    centreX: 104
  },
  // The Room Schedule (Phase 11.2): the landscape forms' picture, centred on the portrait page as in
  // the office's file (its lines 13.71, 18.54, 24.51 there; the picture's own spacing is within 0.2 mm).
  portrait: {
    file: 'letterhead-landscape.png',
    box: { x: 42.5, y: 10.8, w: 102, h: 20 },
    centreX: 105
  },
  landscape: {
    file: 'letterhead-landscape.png',
    box: { x: 86, y: 4.5, w: 102, h: 20 },
    seal: { x: 1.1, y: 0.66, w: 19, h: 18.3 },
    // The office's Word file: Calibri 11 for the two plain lines, Old English Text MT 14 for the name;
    // cap tops 7.4, 12.4, 18.1 on the page, centred on x 148.5.
    lines: [
      { text: 'Republic of the Philippines', font: 'calibri', pt: 11, capTop: 7.4 },
      { text: 'Laguna State Polytechnic University', font: 'blackletter', pt: 14, capTop: 12.4 },
      { text: 'Province of Laguna', font: 'calibri', pt: 11, capTop: 18.1 }
    ],
    centreX: 148.5
  }
};

// ---------------------------------------------------------------- 1. The Class Schedule (SF-003)
// A4 landscape, one page per section. The grid keeps the office's Word file: the table 14403 twips
// wide from 455 twips left of the 1-in margin (x 17.3–271.3), 8 columns (1799, 1800, 1801, 1800, 1801,
// 1801, 1800, 1801 twips), the header + 20 half-hour rows of 317 twips (5.6 mm).
const classSchedule = {
  id: 'class-schedule',
  page: { w: 297, h: 210, orient: 'landscape' },
  letterhead: 'landscape',
  // The words above the grid: cap tops, centred on the page's content (x 148.5).
  titles: [
    { key: 'college', pt: 16, bold: true, capTop: 27.8 },
    { key: 'formTitle', pt: 14, bold: true, capTop: 34.0 },
    { key: 'term', pt: 10, capTop: 39.3 }
  ],
  // "Program: …    Year: I      Section: A": Arial 10, labels regular and values bold, from x 25.4.
  programLine: { pt: 10, capTop: 44.9, x: 25.4, yearX: 139.8, sectionX: 178.0 },   // measured on the office's PDF
  grid: {
    xTwips: 985,
    y: 50.5,
    // twips, as in the office's file (tests compare them with the reference's XML).
    columnsTwips: [1799, 1800, 1801, 1800, 1801, 1801, 1800, 1801],
    rowTwips: 317,
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    headerPt: 7,      // TIME, MONDAY … SUNDAY, bold
    timePt: 10,       // "7:00 – 7:30", bold
    cellPt: 7         // a class: the code (bold), the title, LAB/LEC, the professor; the fit rule below
  },
  // The signatories under the grid, from the Output Settings' Class Schedule block exactly as stored:
  // two a line; line 1 the labels and the NAMES (bold capitals), line 2 the positions (italics).
  // The labels 11 pt and the names and positions 12 pt, as in the office's file; the label's baseline
  // is the name's.
  signatories: {
    pt: 12,
    labelPt: 11,
    line1CapTop: 177,
    line2CapTop: 181.6,
    labelX: [25.4, 152.4],
    nameX: [50.8, 177.8]
  },
  // The footer (the Word footer part): form code, revision, date from the same block.
  footer: { pt: 11, capTop: 199.5, codeX: 25.4, revisionX: 139.8, dateRight: 252 },
  draftLine: { pt: 7, capTop: 1.6 }      // inside the top margin, above the letterhead
};

// ---------------------------------------------------------------- 2. The Room Schedule (per room)
// Phase 11.2 (decision 2): the office's own file, docs/formats/Room-Schedule_2nd-Sem-AY2025-26.docx.
// From its XML: A4 portrait, 1-in margins, the header 0.5 in from the top; the table 10970 twips wide
// from 971 twips left of the margin (x 8.27 mm), the TIME column 1466 twips and six days of 1584
// (1.02 in, 6 x 1.10 in), the header and 20 rows of 432 twips; the titles Arial 16 bold, 14 bold and 10.
// Measured on Word's own rendering of that file (page 1, 200 dpi; .demo-data/logs/p112-office.json):
// the 22 row lines from 56.70 to 220.44 mm, 7.80 mm apart (Word draws each 432-twip row with its 0.5-pt
// border added: 442 twips); the titles' tops 29.46, 35.68, 41.01; the letterhead's lines 13.71, 18.54,
// 24.51, centred on x 105.1.
const roomSchedule = {
  id: 'room-schedule',
  page: { w: 210, h: 297, orient: 'portrait' },
  letterhead: 'portrait',
  titles: [
    // Placed so the ink tops measure as the office's (29.46, 35.68, 41.01): Arial's ascenders ("ll",
    // "b", "d") rise a little above the capitals' top the model places, 0.12-0.26 mm at these sizes.
    { key: 'college', pt: 16, bold: true, capTop: 29.72 },
    { key: 'heading', pt: 14, bold: true, capTop: 35.81 },
    { key: 'term', pt: 10, capTop: 41.13 }
  ],
  grid: {
    xTwips: 469,
    y: 56.7,
    columnsTwips: [1466, 1584, 1584, 1584, 1584, 1584, 1584],
    // The measured pitch, 7.797 mm (442 twips), to the 0.01 mm the line merger snaps to (bands.js
    // pageEdges): every row line then falls on one exact value; 21 rows drift 0.06 mm.
    rowMm: 7.8,
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    headerPt: 7,       // TIME, MONDAY … SATURDAY, bold
    timePt: 10,        // "7:00 – 7:30", bold
    cellPt: 7,         // the code, the title, LEC/LAB, the teacher, the section, regular
    cellMinPt: 6.5
  },
  // The last page, "Classes without a room (TBA)": a list under the same header.
  tbaList: { pt: 8, headerPt: 8, top: 52.5, rowMm: 4.4, bottom: 280, columnsMm: [34, 62, 13, 36, 48.6] },
  // Output Settings' room-schedule block (the office's file has none): under the grid when set.
  signatories: { pt: 10, labelPt: 10, line1CapTop: 232, line2CapTop: 236.4, labelX: [12, 108], nameX: [36, 132], right: 201.8 },
  footer: { pt: 8, capTop: 287.2, codeX: 12, revisionX: 95, dateRight: 198 },
  draftLine: { pt: 7, capTop: 5.5 }
};

// ---------------------------------------------------------------- 3. The Teachers' Program (SF-029)
// A4 portrait. Every target of decision 2, hit within ±1 mm (the model within 0.1 mm).
const teachersProgram = {
  id: 'teachers-program',
  page: { w: 210, h: 297, orient: 'portrait' },
  letterhead: 'sf029',
  draftLine: { pt: 7, capTop: 3.6 },    // centred in the top margin (between 3 and 6); moves nothing
  titles: [
    { key: 'college', text: 'COLLEGE OF COMPUTER STUDIES', pt: 12, bold: true, capTop: 29.5 },
    { key: 'formTitle', pt: 10, bold: true, capTop: 34.3 },
    { key: 'term', pt: 8, capTop: 38.2 }
  ],
  titlesCentreX: 104,
  info: {
    pt: 8,
    left: { x: 10.8, right: 112.5, capTops: [45.5, 48.8, 52.1, 55.4] },
    right: { x: 113.9, right: 201.4, capTops: [45.5, 48.8, 52.1] }
  },
  grid: {
    x: 10.0,
    y: 58.1,
    periodMm: 28.7,
    dayMm: 23.25,
    headerMm: 6.0,
    rowMm: 6.1,
    totalMm: 6.0,
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    periodLabel: 'Period',
    headerPt: 8,       // bold
    timePt: 8,         // regular
    cellPt: 7,         // the fit rule
    totalPt: 8         // "Total 40 hours" and the day totals, bold
  },
  summary: {
    pt: 8,
    labelX: 12.9,
    title: { capTop: 196.0, valueX: 61 },          // SUMMARY OF TEACHING LOAD, bold; its value bold
    maximum: { capTop: 199.3 },                     // (Maximum of hours per week)
    area: { capTop: 205.8, valueX: 66 },            // AREA … HRS.&MIN./WK
    areaLines: [212.4, 215.7, 218.9, 222.1, 225.3, 228.6],
    lab: { capTop: 235.1 },                         // (Lab.) ___ x .75=
    total: { capTop: 244.4 },
    excess: { capTop: 247.7 },
    valueRight: 79                                  // "8 Hours" ends near x 79
  },
  // The four blocks: the label's left x and cap top; the name and the position centred on centreX.
  signatories: {
    labelPt: 8,
    namePt: 9,
    positionPt: 8,
    blocks: [
      { key: 'prepared', labelX: 138.8, labelTop: 196.0, centreX: 158, nameTop: 203.0, positionTop: 206.3 },
      { key: 'conformed', labelX: 103.8, labelTop: 216.6, centreX: 134, nameTop: 223.3, positionTop: 226.4 },
      { key: 'recommending', labelX: 138.9, labelTop: 235.1, centreX: 168.5, nameTop: 245.0, positionTop: 248.3 },
      { key: 'approved', labelX: 66.0, labelTop: 258.0, centreX: 107, nameTop: 264.3, positionTop: 267.6 }
    ],
    // A fifth or later line the Dean added: stacked under the Approved block, centred.
    extraTop: 273.5,
    extraCentreX: 107
  },
  footer: { pt: 8, capTop: 287.2, codeX: 12.9, revisionCentreX: 105.5, dateRight: 198 }
};

const LAYOUTS = {
  'class-schedule': classSchedule,
  'room-schedule': roomSchedule,
  'teachers-program': teachersProgram
};

module.exports = {
  GRID_START,
  GRID_END,
  GRID_SLOT_MINUTES,
  MM_PER_PT,
  LINE_EM,
  CAP_TOP_EM,
  CELL_PAD_MM,
  BORDER_PT,
  FIT,
  LETTERHEADS,
  LAYOUTS,
  // The same forms under the name the Part 9 code reads.
  FORMS: LAYOUTS
};
