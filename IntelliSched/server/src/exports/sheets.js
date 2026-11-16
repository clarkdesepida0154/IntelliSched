// The forms' sheets (Phase 8 Part 9, decisions 1–4): one export page -> its bands (bands.js), every
// position from layouts.js FORMS. The writers (html.js for the PDF and the print view, docxWriter.js)
// draw only these. Each builder also reports the titles it had to shorten with "…".
const path = require('path');
const { FORMS, LETTERHEADS, FIT } = require('./layouts');
const { fitLines, runsWidthMm, textWidthMm, lineHeightMm, capOffsetMm, band, cell, textBand, settleBands, ALL_BORDERS } = require('./bands');

const LETTERHEAD_DIR = __dirname;
const round = (n) => Math.round(n * 1000) / 1000;
const BLANK_NAME = '_'.repeat(28);

// A one-line cell of runs that must fit maxW: the size steps down to 6 pt, then the LAST run is
// shortened with "…" (an info value, a long name). Returns { runs, pt, shortened }.
const fitRunsLine = (runs, maxW, pt) => {
  const room = maxW * (1 - FIT.spareWidthFrac);
  for (let size = pt; size >= FIT.minPt - 1e-9; size = Math.round((size - FIT.stepPt) * 100) / 100) {
    if (runsWidthMm(runs, size) <= room) return { runs, pt: size, shortened: null };
  }
  const last = runs[runs.length - 1];
  const words = String(last.text).split(/\s+/).filter(Boolean);
  for (let keep = words.length - 1; keep >= 0; keep -= 1) {
    const text = keep > 0 ? `${words.slice(0, keep).join(' ')}…` : '…';
    const tried = [...runs.slice(0, -1), { ...last, text }];
    if (runsWidthMm(tried, FIT.minPt) <= room) return { runs: tried, pt: FIT.minPt, shortened: { from: last.text, to: text } };
  }
  return { runs, pt: FIT.minPt, shortened: null };
};

// A text line at a fixed box: x..x+w, its capitals' top at capTop; align inside the box.
const lineBand = ({ capTop, pt, x, w, align = 'left', runs, report, where }) => {
  const fit = fitRunsLine(runs, w, pt);
  if (fit.shortened && report) report.push({ where, ...fit.shortened });
  return band(capTop - capOffsetMm(fit.pt), lineHeightMm(fit.pt), [cell({ x, w, lines: [{ runs: fit.runs, pt: fit.pt, align }] })]);
};

// The letterhead picture as one cell.
const letterheadBand = (key) => {
  const spec = LETTERHEADS[key];
  return band(spec.box.y, spec.box.h, [cell({ x: spec.box.x, w: spec.box.w, image: { file: path.join(LETTERHEAD_DIR, spec.file), w: spec.box.w, h: spec.box.h } })]);
};

// The weekly grid's bands: the header row, the half-hour rows (a class is one cell spanning its rows,
// its lines fitted to the box), and the SF-029's totals row. columns: [{ x, w }] (the first the time
// column). Returns the bands; shortened titles go to report.
const gridBands = ({ grid, cols, days, top, headerH, rowH, labels, headerPt, timePt, timeBold, cellPt, blockItems, fitCell = null, totals = null, totalH = 0, totalPt = 8, report, where }) => {
  const bands = [];
  const centred = (text, pt, bold) => [{ runs: [{ text, bold }], pt, align: 'center' }];
  bands.push(band(top, headerH, labels.map((label, i) => cell({ ...cols[i], lines: centred(label, headerPt, true), borders: ALL_BORDERS, valign: 'center' }))));
  // A grid wider than 7:00–5:00 (a class outside the window) keeps the frame: the rows share it.
  const rows = grid.rows.length;
  const step = rows > 20 ? (rowH * 20) / rows : rowH;
  const covered = Object.fromEntries(days.map(day => [day, new Set((grid.cells[day] || []).flatMap(c => Array.from({ length: c.span - 1 }, (_, k) => c.row + 1 + k)))]));
  const startsAt = Object.fromEntries(days.map(day => [day, new Map((grid.cells[day] || []).map(c => [c.row, c]))]));
  grid.rows.forEach((row, r) => {
    const y = top + headerH + r * step;
    const cells = [cell({ ...cols[0], lines: centred(row.label, timePt, timeBold), borders: ALL_BORDERS, valign: 'center' })];
    days.forEach((day, d) => {
      const col = cols[d + 1];
      const start = startsAt[day].get(r);
      if (start) {
        const h = start.span * step;
        const fit = fitCell ? fitCell(start.blocks, { w: col.w, h }, cellPt) : fitLines(start.blocks.flatMap(blockItems), { w: col.w, h }, cellPt);
        if (fit.shortened && report) report.push({ where: `${where}, ${day} ${row.label}`, ...fit.shortened });
        cells.push(cell({ ...col, h, lines: fit.lines, borders: ALL_BORDERS, valign: 'center' }));
      } else if (!covered[day].has(r)) {
        cells.push(cell({ ...col, borders: ALL_BORDERS }));
      }
    });
    bands.push(band(y, step, cells));
  });
  if (totals) {
    const y = top + headerH + rows * step;
    bands.push(band(y, totalH, [
      cell({ ...cols[0], lines: centred(totals.label, totalPt, true), borders: ALL_BORDERS, valign: 'center' }),
      ...days.map((day, d) => cell({ ...cols[d + 1], lines: totals.days[day] ? centred(totals.days[day], totalPt, true) : [], borders: ALL_BORDERS, valign: 'center' }))
    ]));
  }
  return bands;
};

// ---------------------------------------------------------------- the Teachers' Program (SF-029)

// A class box's lines (decision 2's styles: the code bold, the rest regular; a duty block in bold
// capitals); the title is the one line the fit rule may shorten.
const sf029BlockItems = (block) => block.lines.map((line, i) => ({
  text: line.text,
  bold: Boolean(line.bold),
  shorten: block.kind === 'class' && i === 1
}));

// The smallest size of a Teachers' Program class box (Phase 11): the room line never pushes the text
// below 6.5 pt.
const SF029_MIN_PT = 6.5;
const ROOM_JOIN = ' · ';

// A Teachers' Program cell (Phase 11): every class shows its room (block.room) as its last line, after
// the section. When the box is too short, in this order: the room joins the section line ("BSCS IIIA ·
// TSL", one unbroken line, so only when it fits the column), then the text shrinks in 0.5-pt steps to
// 6.5 pt (never smaller), then the title is shortened with "…" (the fit rule's last resort, reported),
// and in a box too short even for that the title is left out (the code, the section, the room), and
// in a half-hour box the room rides the code line ("ITEC 103 · LAB 1") over the section. The room is never shortened or dropped.
const sf029FitCell = (blocks, box, pt) => {
  const hasRoom = blocks.some(b => b.kind === 'class' && b.room);
  if (!hasRoom) return fitLines(blocks.flatMap(sf029BlockItems), box, pt);
  const itemsOf = (mode) => blocks.flatMap(block => {
    const items = sf029BlockItems(block);
    if (block.kind !== 'class' || !block.room) return items;
    if (mode === 'own-line') return [...items, { text: block.room }];
    const last = items[items.length - 1];
    if (mode === 'joined') return [...items.slice(0, -1), { runs: [{ text: `${last.text}${ROOM_JOIN}${block.room}` }] }];
    // 'no-title': the code, the section and the room, without the title.
    if (mode === 'no-title') return [items[0], ...items.slice(2), { text: block.room }];
    // 'code-line': the code and the room on one line, then the section; no title.
    return [{ runs: [{ text: items[0].text, bold: true }, { text: `${ROOM_JOIN}${block.room}` }] }, last];
  });
  const sizes = [];
  for (let size = pt; size >= SF029_MIN_PT - 1e-9; size = Math.round((size - FIT.stepPt) * 100) / 100) sizes.push(size);
  const tries = [['own-line', pt], ...sizes.flatMap(size => [['joined', size], ...(size < pt ? [['own-line', size]] : [])])];
  for (const [mode, size] of tries) {
    const fit = fitLines(itemsOf(mode), box, size, { minPt: size });
    if (fit.fits && !fit.shortened) return fit;
  }
  for (const mode of ['joined', 'own-line']) {
    const fit = fitLines(itemsOf(mode), box, SF029_MIN_PT, { minPt: SF029_MIN_PT });
    if (fit.fits) return fit;
  }
  const titles = blocks.filter(b => b.kind === 'class' && b.room).map(b => b.lines[1]?.text).filter(Boolean).join('; ');
  let last = null;
  for (const mode of ['no-title', 'code-line']) {
    last = fitLines(itemsOf(mode), box, SF029_MIN_PT, { minPt: SF029_MIN_PT });
    if (last.fits) return { ...last, shortened: titles ? { from: titles, to: '' } : null };
  }
  return last;
};

const sf029Sheet = (model, page) => {
  const form = FORMS['teachers-program'];
  const report = [];
  const where = page.name;
  const bands = [letterheadBand(form.letterhead)];

  // The college, the form's title and the term, centred on x 104.
  const titleRuns = {
    college: [{ text: form.titles[0].text, bold: true }],
    formTitle: [{ text: model.formTitle || "TEACHERS' PROGRAM", bold: true }],
    term: model.termRuns.map(r => ({ text: r.text, super: Boolean(r.super) }))
  };
  const TITLE_W = 150;
  for (const t of form.titles) {
    bands.push(lineBand({ capTop: t.capTop, pt: t.pt, x: form.titlesCentreX - TITLE_W / 2, w: TITLE_W, align: 'center', runs: titleRuns[t.key].map(r => ({ ...r, bold: t.bold || r.bold })), report, where }));
  }

  // The facts: labels regular, values regular except the Name's (bold).
  const info = form.info;
  page.facts.left.forEach((fact, i) => bands.push(lineBand({
    capTop: info.left.capTops[i], pt: info.pt, x: info.left.x, w: info.left.right - info.left.x,
    runs: [{ text: `${fact.label} ` }, { text: fact.value, bold: Boolean(fact.bold) }], report, where: `${where}, ${fact.label}`
  })));
  page.facts.right.forEach((fact, i) => bands.push(lineBand({
    capTop: info.right.capTops[i], pt: info.pt, x: info.right.x, w: info.right.right - info.right.x,
    runs: [{ text: `${fact.label} ` }, { text: fact.value, bold: Boolean(fact.bold) }], report, where: `${where}, ${fact.label}`
  })));

  // The grid: x 10.0–201.4, the Period column 28.7, each day 23.25; y 58.1–192.1.
  const g = form.grid;
  const cols = [{ x: g.x, w: g.periodMm }, ...g.days.map((_, d) => ({ x: round(g.x + g.periodMm + d * g.dayMm), w: g.dayMm }))];
  bands.push(...gridBands({
    grid: page.grid, cols, days: g.days, top: g.y, headerH: g.headerMm, rowH: g.rowMm,
    labels: [g.periodLabel, ...g.days], headerPt: g.headerPt, timePt: g.timePt, timeBold: false, cellPt: g.cellPt,
    blockItems: sf029BlockItems, fitCell: sf029FitCell, totals: page.totals, totalH: g.totalMm, totalPt: g.totalPt, report, where
  }));
  const gridBottom = g.y + g.headerMm + 20 * g.rowMm + g.totalMm;

  // Self-paced online lectures (no place on the grid): one small line between the grid and the summary.
  if (page.selfPaced.length) {
    bands.push(lineBand({ capTop: round(gridBottom + 0.65), pt: 6, x: form.summary.labelX, w: g.x + g.periodMm + 7 * g.dayMm - form.summary.labelX,
      runs: [{ text: `Online (self-paced): ${page.selfPaced.join('; ')}` }], report, where: `${where}, self-paced` }));
  }

  // The summary: labels at x 12.9, the values ending near x 79 ("8 Hours"), as on the forms.
  const s = form.summary;
  const byKey = Object.fromEntries(page.summary.lines.map(l => [l.key, l]));
  const hoursWord = (line) => (line ? `${line.value ? `${line.value} ` : ''}Hours` : 'Hours');
  const LABEL_W = 48;
  const VALUE_W = 18;
  const label = (capTop, text, bold = false) => lineBand({ capTop, pt: s.pt, x: s.labelX, w: LABEL_W, runs: [{ text, bold }], report, where });
  const value = (capTop, text, bold = false) => lineBand({ capTop, pt: s.pt, x: s.valueRight - VALUE_W, w: VALUE_W, align: 'right', runs: [{ text, bold }], report, where });
  bands.push(label(s.title.capTop, 'SUMMARY OF TEACHING LOAD', true));
  bands.push(lineBand({ capTop: s.title.capTop, pt: s.pt, x: s.title.valueX, w: 30, runs: [{ text: `${page.summary.teachingHours} HOURS`, bold: true }], report, where }));
  bands.push(lineBand({ capTop: s.maximum.capTop, pt: s.pt, x: s.labelX, w: 70, runs: [{ text: '(Maximum of hours per week)' }], report, where }));
  bands.push(label(s.area.capTop, 'AREA'));
  bands.push(lineBand({ capTop: s.area.capTop, pt: s.pt, x: s.area.valueX, w: 25, runs: [{ text: 'HRS.&MIN./WK' }], report, where }));
  const areas = [
    ['MANAGEMENT_FUNCTION', '-Management Function'],
    ['EXTENSION', '-Extension: ______________'],
    ['RESEARCH', '-Research: ______________'],
    ['CEE', '-Competitive Edge Enhancement'],
    ['CONSULTATION', '-Consultation/Preparation'],
    ['LECTURE', '-Teaching Duties (Lecture) _____']
  ];
  areas.forEach(([key, text], i) => {
    bands.push(label(s.areaLines[i], text));
    bands.push(value(s.areaLines[i], hoursWord(byKey[key])));
  });
  const lab = byKey.LAB?.value;
  bands.push(lineBand({ capTop: s.lab.capTop, pt: s.pt, x: s.labelX, w: 70, runs: [{ text: `(Lab.) ${lab || '___ x .75='}` }], report, where }));
  bands.push(label(s.total.capTop, 'TOTAL NO. OF HOURS'));
  bands.push(value(s.total.capTop, hoursWord(byKey.TOTAL), true));
  bands.push(label(s.excess.capTop, 'Excess No. of Hours'));
  bands.push(value(s.excess.capTop, hoursWord(byKey.EXCESS)));

  // The four signatory blocks at their measured places: the label at its x, the name (bold) and the
  // position centred under it. A blank name prints as a line to sign on.
  const sig = form.signatories;
  const NAME_W = 64;
  const LABEL_SIG_W = 55;
  const sigBands = (line, pos) => [
    lineBand({ capTop: pos.labelTop, pt: sig.labelPt, x: pos.labelX, w: LABEL_SIG_W, runs: [{ text: line.label }], report, where }),
    lineBand({ capTop: pos.nameTop, pt: sig.namePt, x: pos.centreX - NAME_W / 2, w: NAME_W, align: 'center', runs: [{ text: line.name || BLANK_NAME, bold: true }], report, where: `${where}, ${line.label}` }),
    ...(line.title ? [lineBand({ capTop: pos.positionTop, pt: sig.positionPt, x: pos.centreX - NAME_W / 2, w: NAME_W, align: 'center', runs: [{ text: line.title }], report, where: `${where}, ${line.label}` })] : [])
  ];
  (page.signatories || []).slice(0, sig.blocks.length).forEach((line, i) => bands.push(...sigBands(line, sig.blocks[i])));
  // A fifth or later line (one the Dean added): stacked under "Approved:", centred on x 107.
  (page.signatories || []).slice(sig.blocks.length).forEach((line, i) => {
    const top = sig.extraTop + i * 10;
    bands.push(...sigBands(line, { labelX: sig.extraCentreX - 30, labelTop: top, centreX: sig.extraCentreX, nameTop: top + 3.4, positionTop: top + 6.7 }));
  });

  const f = form.footer;
  return {
    page: form.page,
    bands: settleBands(bands),
    // The DRAFT line (in the Word header part) and the form code line (the Word footer part): both
    // outside the body, so neither moves it.
    draft: model.draftLine ? { text: model.draftLine, pt: form.draftLine.pt, capTop: form.draftLine.capTop, centreX: form.page.w / 2 } : null,
    footer: model.formCode && (model.formCode.code || model.formCode.revision || model.formCode.date)
      ? { pt: f.pt, capTop: f.capTop, items: [
        { text: model.formCode.code, x: f.codeX, align: 'left' },
        { text: model.formCode.revision, x: f.revisionCentreX, align: 'center' },
        { text: model.formCode.date, x: f.dateRight, align: 'right' }
      ] }
      : null,
    shortened: report
  };
};

// ---------------------------------------------------------------- the landscape forms (SF-003, rooms)

const TWIP_MM = 25.4 / 1440;
const footerOf = (model, f) => (model.formCode && (model.formCode.code || model.formCode.revision || model.formCode.date)
  ? { pt: f.pt, capTop: f.capTop, items: [
    { text: model.formCode.code, x: f.codeX, align: 'left' },
    { text: model.formCode.revision, x: f.revisionX, align: 'left' },
    { text: model.formCode.date, x: f.dateRight, align: 'right' }
  ].filter(i => i.text) }
  : null);
const draftOf = (model, form) => (model.draftLine ? { text: model.draftLine, pt: form.draftLine.pt, capTop: form.draftLine.capTop, centreX: form.page.w / 2 } : null);

// The signatory block under a landscape grid (decision 3): two a line; line 1 the label (11 pt) and
// the NAME (bold capitals, 12 pt), line 2 the position (italics, 12 pt) under the name. The words are
// the Output Settings' block exactly as stored; only the name is set in capitals, as the form prints it.
const landscapeSignatoryBands = (signatories, sig, report, where) => {
  const bands = [];
  const capHeight = (pt) => 0.716 * pt * (25.4 / 72);
  const baseline = sig.line1CapTop + capHeight(sig.pt);
  const pageRight = sig.right ?? 271.6;
  for (let i = 0; i < signatories.length; i += 2) {
    const row = Math.floor(i / 2);
    const drop = row * 12;   // a third or fourth signatory: another pair under the first
    signatories.slice(i, i + 2).forEach((line, k) => {
      const labelX = sig.labelX[k];
      const nameX = sig.nameX[k];
      const nameRight = k === 0 ? sig.labelX[1] - 1 : pageRight;
      bands.push(lineBand({ capTop: baseline - capHeight(sig.labelPt) + drop, pt: sig.labelPt, x: labelX, w: nameX - labelX, runs: [{ text: line.label }], report, where }));
      bands.push(lineBand({ capTop: sig.line1CapTop + drop, pt: sig.pt, x: nameX, w: nameRight - nameX, runs: [{ text: (line.name || BLANK_NAME).toUpperCase(), bold: true }], report, where }));
      if (line.title) bands.push(lineBand({ capTop: sig.line2CapTop + drop, pt: sig.pt, x: nameX, w: nameRight - nameX, runs: [{ text: line.title, italic: true }], report, where }));
    });
  }
  return bands;
};

const landscapeGridCols = (g) => {
  const x0 = g.xTwips * TWIP_MM;
  const widths = g.columnsTwips ? g.columnsTwips.map(t => t * TWIP_MM) : g.columnsMm;
  let x = x0;
  return widths.map(w => { const col = { x: round(x), w: round(w) }; x += w; return col; });
};

// A class cell's lines on the landscape forms: the code (bold), the title (the one the fit rule may
// shorten), then the rest.
const landscapeBlockItems = (block) => block.lines.map((line, i) => ({ text: line.text, bold: Boolean(line.bold), shorten: i === 1 }));

const classScheduleSheet = (model, page) => {
  const form = FORMS['class-schedule'];
  const report = [];
  const where = page.name;
  const centre = form.page.w / 2;
  const W = 200;
  const bands = [letterheadBand(form.letterhead)];
  const titleRuns = {
    college: [{ text: model.collegeName || 'College of Computer Studies', bold: true }],
    formTitle: [{ text: model.formTitle || 'CLASS SCHEDULE', bold: true }],
    term: model.termRuns.map(r => ({ text: r.text, super: Boolean(r.super) }))
  };
  for (const t of form.titles) {
    bands.push(lineBand({ capTop: t.capTop, pt: t.pt, x: centre - W / 2, w: W, align: 'center', runs: titleRuns[t.key].map(r => ({ ...r, bold: t.bold || r.bold })), report, where }));
  }
  const p = form.programLine;
  const pair = (label, value) => [{ text: `${label} ` }, { text: value, bold: true }];
  bands.push(band(p.capTop - capOffsetMm(p.pt), lineHeightMm(p.pt), [
    (() => { const fit = fitRunsLine(pair('Program:', page.program.name), p.yearX - p.x - 1, p.pt); return cell({ x: p.x, w: p.yearX - p.x - 1, lines: [{ runs: fit.runs, pt: fit.pt, align: 'left' }] }); })(),
    cell({ x: p.yearX, w: p.sectionX - p.yearX - 1, lines: [{ runs: pair('Year:', page.program.year), pt: p.pt, align: 'left' }] }),
    cell({ x: p.sectionX, w: 271.6 - p.sectionX, lines: [{ runs: pair('Section:', page.program.section), pt: p.pt, align: 'left' }] })
  ]));
  const g = form.grid;
  const rowH = g.rowTwips * TWIP_MM;
  bands.push(...gridBands({
    grid: page.grid, cols: landscapeGridCols(g), days: g.days, top: g.y, headerH: rowH, rowH,
    labels: ['TIME', ...g.days.map(d => d.toUpperCase())], headerPt: g.headerPt, timePt: g.timePt, timeBold: true, cellPt: g.cellPt,
    blockItems: landscapeBlockItems, report, where
  }));
  bands.push(...landscapeSignatoryBands(page.signatories || [], form.signatories, report, where));
  return { page: form.page, bands: settleBands(bands), draft: draftOf(model, form), footer: footerOf(model, form.footer), shortened: report };
};

// ---------------------------------------------------------------- the Room Schedule (Phase 11.2)

// A Room Schedule class box (decision 2): the code, the title, LEC or LAB, the teacher, the section,
// Arial 7 pt, centred, one item a line. Too short: the size steps down to 6.5 pt (never below), then the
// title is shortened with "…", then left out, then the code and LEC/LAB share a line, then the teacher
// and the section share one. The teacher and the section are never cut.
const ROOM_MIN_PT = 6.5;
const roomItemsOf = (block, mode) => {
  const line = (role) => block.lines.find(l => l.role === role)?.text || '';
  const code = line('code'); const title = line('title'); const kind = line('kind');
  const teacher = line('teacher'); const section = line('section');
  const fixed = (text) => ({ runs: [{ text }] });
  // Phase 11.4: a subject without a lab part has no LEC/LAB line (kind is empty).
  const codeKind = kind ? `${code}${ROOM_JOIN}${kind}` : code;
  if (mode === 'full') return [{ text: code }, ...(title ? [{ text: title, shorten: true }] : []), ...(kind ? [{ text: kind }] : []), fixed(teacher), fixed(section)].filter(i => i.text || i.runs);
  if (mode === 'no-title') return [{ text: code }, ...(kind ? [{ text: kind }] : []), fixed(teacher), fixed(section)];
  if (mode === 'code-kind') return [fixed(codeKind), fixed(teacher), fixed(section)];
  return [fixed(codeKind), fixed(`${teacher}${ROOM_JOIN}${section}`)];
};
const roomFitCell = (blocks, box, pt) => {
  const items = (mode) => blocks.flatMap(b => roomItemsOf(b, mode));
  const full = fitLines(items('full'), box, pt, { minPt: ROOM_MIN_PT });
  if (full.fits) return full;
  const titles = blocks.map(b => b.lines.find(l => l.role === 'title')?.text).filter(Boolean).join('; ');
  let last = full;
  for (const mode of ['no-title', 'code-kind', 'two-lines']) {
    last = fitLines(items(mode), box, ROOM_MIN_PT, { minPt: ROOM_MIN_PT });
    if (last.fits) return { ...last, shortened: titles ? { from: titles, to: '' } : null };
  }
  return { ...last, shortened: titles ? { from: titles, to: '' } : null };
};

// The three title lines (the college, the heading, the term), centred on the page.
const roomTitleBands = (model, heading, form, report, where) => {
  const centre = form.page.w / 2;
  const W = 190;
  const runs = {
    college: [{ text: model.collegeName || 'College of Computer Studies' }],
    heading: [{ text: heading }],
    term: model.termRuns.map(r => ({ text: r.text, super: Boolean(r.super) }))
  };
  return form.titles.map(t => lineBand({ capTop: t.capTop, pt: t.pt, x: centre - W / 2, w: W, align: 'center', runs: runs[t.key].map(r => ({ ...r, bold: Boolean(t.bold) })), report, where }));
};

// A room page's sheet, or the TBA list's sheets (as many as its rows need). Returns a list of sheets.
const roomScheduleSheets = (model, page) => {
  const form = FORMS['room-schedule'];
  const where = page.name;
  const finish = (bands, report) => ({ page: form.page, bands: settleBands(bands), draft: draftOf(model, form), footer: footerOf(model, form.footer), shortened: report });
  if (page.kind === 'tba') {
    const t = form.tbaList;
    const widths = t.columnsMm;
    const x0 = round(form.page.w / 2 - widths.reduce((a, b) => a + b, 0) / 2);
    const cols = widths.reduce((list, w) => { const x = list.length ? list[list.length - 1].x + list[list.length - 1].w : x0; list.push({ x: round(x), w }); return list; }, []);
    const perPage = Math.max(1, Math.floor((t.bottom - t.top - t.rowMm) / t.rowMm));
    const rows = page.rows || [];
    const sheets = [];
    for (let start = 0; start === 0 || start < rows.length; start += perPage) {
      const report = [];
      const bands = [letterheadBand(form.letterhead), ...roomTitleBands(model, page.heading, form, report, where)];
      const rowCells = (texts, bold) => texts.map((text, i) => {
        const fit = fitRunsLine([{ text, bold }], cols[i].w - 1.5, bold ? t.headerPt : t.pt);
        if (fit.shortened) report.push({ where: `${where}, ${texts[0]}`, ...fit.shortened });
        return cell({ ...cols[i], lines: [{ runs: fit.runs, pt: fit.pt, align: i === 2 ? 'center' : 'left' }], borders: ALL_BORDERS, valign: 'center' });
      });
      bands.push(band(t.top, t.rowMm, rowCells(['Section', 'Subject', 'LEC/LAB', 'Teacher', 'Day and time'], true)));
      rows.slice(start, start + perPage).forEach((row, i) => {
        bands.push(band(round(t.top + (i + 1) * t.rowMm), t.rowMm, rowCells([` ${row.section}`, ` ${row.subject}`, row.kind, ` ${row.teacher}`, ` ${row.when}`], false)));
      });
      sheets.push(finish(bands, report));
    }
    return sheets;
  }
  const report = [];
  const bands = [letterheadBand(form.letterhead), ...roomTitleBands(model, page.heading, form, report, where)];
  const g = form.grid;
  const rowH = g.rowMm;
  bands.push(...gridBands({
    grid: page.grid, cols: landscapeGridCols(g), days: g.days, top: g.y, headerH: rowH, rowH,
    labels: ['TIME', ...g.days.map(d => d.toUpperCase())], headerPt: g.headerPt, timePt: g.timePt, timeBold: true, cellPt: g.cellPt,
    blockItems: landscapeBlockItems, fitCell: roomFitCell, report, where
  }));
  bands.push(...landscapeSignatoryBands(page.signatories || [], form.signatories, report, where));
  return [finish(bands, report)];
};

module.exports = { sf029Sheet, sf029FitCell, SF029_MIN_PT, classScheduleSheet, roomScheduleSheets, roomFitCell, ROOM_MIN_PT, gridBands, letterheadBand, lineBand, fitRunsLine, BLANK_NAME, textWidthMm, textBand };
