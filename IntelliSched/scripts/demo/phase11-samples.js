// Phase 11, Step 3: the printed Teachers' Program samples. On a fresh `npm run demo:sem2:reset --
// --faculty-seed`, it follows the Dean's path the rehearsal's way (deans-path.js: the open Major
// classes, the Readiness Check, one generation with the seed), then exports the Teachers' Program as
// Word and PDF for FacultyMember (full-time, with ancillary hours), one part-timer with
// ancillary hours, one professor with a lab in a week-grouped section, and the "all faculty" file, into
// docs/samples/phase11/ with a 150-dpi PNG of each PDF's first page and samples.json (names and counts).
// No part-timer of the seed file has ancillary hours, so the part-timer with the most classes gets
// Research 4 and Consultation 2 on this practice copy only (the Faculty page's own route), and Faculty
// the usual full-time set when the copy holds none for him, to show that the duty blocks are held by
// the system and left off the print.
// Safety: the practice copy only (never the defense database), a demo whose faculty came from the
// tracked seed file (committed evidence); files are staged in .demo-data/phase11-samples/ first and
// copied only when every check passed. The forms carry no rating.
// Phase 11.1: also the Class Schedule (all sections) and the room schedules (all rooms, odd and even
// weeks), the 600-dpi line-width check (scripts/forms/line-widths.js) on page 1 of Faculty's, Faculty's
// and Faculty's Teachers' Program, the Class Schedule and the odd-weeks room schedule, from the PDF and
// from Word's own PDF of the DOCX, and the three orders as printed (samples.json, and
// .demo-data/logs/p111-line-widths.json).
// Phase 11.2: part-timers have no ancillary loads, so no hours are added to a part-timer any more
// (Faculty is shown as he is: no duty blocks, blank duty lines, TOTAL = teaching); the Room Schedule is
// ONE file in the office's format (Room-Schedule_All-rooms), plus one single-room file (LAB 1: its odd
// and even pages); PNGs of the Room Schedule's page 1 and AVR page; the line widths on both pages.
// Phase 11.4: the lecture rooms on one page (AVR alone exported too), Faculty by name, the strict line
// check (the PDF at 600 and 150 dpi with max - min = 0 px, Word's PDF at 600 dpi within 1 px) on the
// Teachers' Program of Faculty, Faculty and Faculty, the Class Schedule's page 1 (BSIT I A), the Room
// Schedule's page 1 and its AVR page, and the lecture rooms whose meetings overlap (roomScheduleClashes).
// Usage: npm run demo:sem2:reset -- --faculty-seed, then in a second terminal (PowerShell, for the
// PNGs): node scripts/demo/phase11-samples.js [--seed 1]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const { apiOf, readiness, assignUnassignedMajors, generateSeed } = require('./deans-path');
const { pdfInfo } = require(path.join(REPO, 'server', 'src', 'exports', 'pdf'));
const { buildExportModel } = require(path.join(REPO, 'server', 'src', 'exports', 'pageModels'));
const { unzipSync } = require(path.join(REPO, 'server', 'src', 'exports', 'zip'));
const { measureFile } = require(path.join(REPO, 'scripts', 'forms', 'line-widths'));
const { roomScheduleClashes } = require(path.join(REPO, 'server', 'src', 'utils', 'roomSchedulePages'));
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const SEED = Number(argOf('--seed', 1));
const OUT = path.join(REPO, 'docs', 'samples', 'phase11');
const STAGE = path.join(REPO, '.demo-data', 'phase11-samples');
const RUN_FILE = path.join(REPO, '.demo-data', 'run.json');
const TERM_FILE = path.join(REPO, 'docs', 'data', 'term_2nd_sem_AY2026_27.json');
const FULL_TIME_ANCILLARY = [{ type: 'RESEARCH', hours: 10 }, { type: 'EXTENSION', hours: 8 }, { type: 'CEE', hours: 2 }, { type: 'CONSULTATION', hours: 2 }];
const log = (m) => console.log(`[phase11-samples ${new Date().toISOString().slice(11, 19)}] ${m}`);
const fail = (m) => { throw new Error(m); };

(async () => {
  const run = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (run.mode === 'defense' || /defense/i.test(run.db || '')) fail('The defense database is never used here. Run this on npm run demo:sem2:reset -- --faculty-seed.');
  if (run.state !== 'ready' || run.mode !== 'sem2') fail(`The demo is not a ready 2nd-semester demo (mode ${run.mode}, state ${run.state}).`);
  if (run.facultySource !== 'seed') fail('docs/samples/phase11/ is committed evidence: start the demo with `npm run demo:sem2:reset -- --faculty-seed`.');
  const secrets = JSON.parse(fs.readFileSync(path.resolve(REPO, run.secretsFile || path.join('.demo-data', 'demo-secrets.json')), 'utf8'));
  const TERM = { academicYear: run.term?.academicYear || '2026-2027', semester: Number(run.term?.semester) || 2 };
  const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const { call, login } = apiOf(run);
  const dean = await login('TEST Dean', secrets.deanEmail, secrets.deanPassword);
  const termFile = JSON.parse(fs.readFileSync(TERM_FILE, 'utf8'));

  await assignUnassignedMajors({ call, dean, TERM, term: termFile, log });
  const ready = await readiness(call, dean, TERM);
  if (ready.verdict !== 'ready') fail(`The Readiness Check says "${ready.verdict}".`);
  const row = await generateSeed({ call, dean, TERM, seed: SEED, log });
  if (row.status !== 'done' || !row.scheduleId) fail(`The run ended "${row.status}": ${row.message}`);
  if (row.checkedConflicts !== 0) fail(`The saved Draft has ${row.checkedConflicts} conflicts: not sample material. Try another seed.`);
  const scheduleId = row.scheduleId;
  log(`generated ${row.version} with seed ${SEED}: 0 conflicts`);

  // The duty blocks are filled when the outputs are read, so the hours can be added after generating:
  // the part-timer with the most classes gets Research 4 and Consultation 2, and Faculty the usual
  // full-time set when the practice copy holds none for him (practice copy only, the Faculty route).
  const outputsOf = async () => (await call('GET', `/schedule/outputs?${termQuery}&scheduleId=${scheduleId}`, { token: dean })).data;
  const first = await outputsOf();
  const matuteId = (first.faculty || []).find(f => String(f.name).includes('Faculty'))?.id || fail('Faculty is not in the outputs.');
  // Phase 11.2: Faculty, part-time, as the practice copy holds him (no ancillary hours added).
  const partTimeId = (first.faculty || []).find(f => /Faculty/.test(String(f.name)) && f.employmentType === 'PART_TIME')?.id || fail('Faculty (part-time) is not in the outputs.');
  const added = [];
  const setAncillary = async (id, ancillary) => {
    const res = await call('PUT', `/faculty/${id}`, { token: dean, body: { ancillary } });
    if (res.status !== 200) fail(`Saving ancillary hours: ${res.status} ${res.data?.message || ''}`);
    added.push({ name: (first.faculty || []).find(f => String(f.id) === String(id))?.name, ancillary });
  };
  if (!((first.faculty || []).find(f => String(f.id) === String(matuteId))?.ancillary?.blocks || []).length) await setAncillary(matuteId, FULL_TIME_ANCILLARY);
  log(`ancillary hours added on the practice copy: ${added.map(a => a.name).join(', ')}`);
  const outputs = await outputsOf();
  const Faculty = (outputs.faculty || []).find(f => String(f.id) === String(matuteId));
  const pt = (outputs.faculty || []).find(f => String(f.id) === String(partTimeId));
  const own = (f) => (outputs.classes || []).filter(c => String(c.facultyRef) === String(f.id));
  // Phase 11.4: Faculty by name (the team's three samples: Faculty, Faculty, Faculty).
  const labProf = (outputs.faculty || []).find(f => /Faculty/.test(String(f.name))) || fail('Faculty is not in the outputs.');
  const samples = [
    { role: 'full-time with ancillary hours', prof: Faculty },
    { role: 'part-time (no ancillary loads)', prof: pt },
    { role: 'Faculty', prof: labProf }
  ];

  // The checks, on the same page model the gateway draws (exports/pageModels.js).
  const model = buildExportModel(outputs, 'teachers-program');
  const checks = samples.map(({ role, prof }) => {
    const page = model.pages.find(p => p.key === String(prof.id)) || fail(`${prof.name}: no page.`);
    const cells = Object.values(page.grid.cells).flat();
    const classBlocks = cells.flatMap(c => c.blocks).filter(b => b.kind === 'class');
    const dutyInData = (prof.ancillary?.blocks || []).length;
    const dutyOnPrint = cells.flatMap(c => c.blocks).filter(b => b.kind === 'duty').length;
    const withRoom = classBlocks.filter(b => b.room).length;
    const summary = Object.fromEntries((page.summary.lines || []).map(l => [l.key, l.value]));
    const labs = own(prof).filter(c => c.classType === 'LAB' && c.weekGroup).map(c => `${c.subjectCode} ${c.day} ${c.startTime} ${c.roomName || 'TBA'} (${c.weekGroup === 'ODD' ? 'odd' : 'even'} weeks)`);
    if (dutyOnPrint !== 0) fail(`${prof.name}: ${dutyOnPrint} duty blocks on the print.`);
    if (withRoom !== classBlocks.length) fail(`${prof.name}: ${classBlocks.length - withRoom} classes without a room line.`);
    return { role, name: prof.name, employment: prof.employmentType, classBoxes: classBlocks.length, classBoxesWithRoom: withRoom, dutyBlocksInSystem: dutyInData, dutyBlocksOnPrint: dutyOnPrint, rooms: [...new Set(classBlocks.map(b => b.room))], weekGroupedLabs: labs, summary, totalsRow: page.totals };
  });
  if (!(checks[0].dutyBlocksInSystem > 0)) fail('Faculty has no duty blocks in the system: the sample would not show the change.');
  // Phase 11.2: the part-timer has no duty blocks, blank duty lines, TOTAL = the teaching load, no Excess.
  if (checks[1].dutyBlocksInSystem !== 0) fail(`${pt.name} has ${checks[1].dutyBlocksInSystem} duty blocks in the system.`);
  const ptSummary = checks[1].summary;
  if (['MANAGEMENT_FUNCTION', 'EXTENSION', 'RESEARCH', 'CEE', 'CONSULTATION', 'EXCESS'].some(k => ptSummary[k])) fail(`${pt.name}: a duty line or Excess carries a number: ${JSON.stringify(ptSummary)}`);
  if (ptSummary.TOTAL !== ptSummary.TEACHING) fail(`${pt.name}: TOTAL ${ptSummary.TOTAL} is not the teaching load ${ptSummary.TEACHING}.`);
  log(`checks: ${checks.map(c => `${c.name} ${c.classBoxesWithRoom}/${c.classBoxes} rooms, duties ${c.dutyBlocksInSystem} held / ${c.dutyBlocksOnPrint} printed`).join('; ')}`);

  // Export into the stage.
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const files = [];
  const surnameOf = (name) => String(name).split(',')[0].trim().split(/\s+/).filter(w => !/^(jr|sr)\.?$/i.test(w)).pop();
  const classModel = buildExportModel(outputs, 'class-schedule');
  const roomModel = buildExportModel(outputs, 'room-schedule');
  const lab1 = (outputs.rooms || []).find(r => String(r.name).toUpperCase() === 'LAB 1') || fail('LAB 1 is not in the outputs.');
  const lab1Pages = roomModel.pages.filter(p => p.key === String(lab1.key)).length;
  const avrPage = roomModel.pages.findIndex(p => String(p.roomName).toUpperCase() === 'AVR') + 1;
  if (!avrPage) fail('The Room Schedule has no AVR page.');
  const avr = (outputs.rooms || []).find(r => String(r.name).toUpperCase() === 'AVR');
  const avrPages = roomModel.pages.filter(p => p.key === String(avr.key)).length;
  const clashes = roomScheduleClashes({ rooms: outputs.rooms || [], classes: outputs.classes || [] });
  log(`lecture-room clashes (overlapping meetings in one room): ${clashes.length}`);
  const targets = [
    ...samples.map(s => ({ view: 'teachers-program', id: String(s.prof.id), base: `Teachers-Program_${surnameOf(s.prof.name)}`, pages: 1 })),
    { view: 'teachers-program', id: null, base: 'Teachers-Program_All-faculty', pages: model.pages.length },
    { view: 'class-schedule', id: null, base: 'Class-Schedule_All-sections', pages: classModel.pages.length },
    { view: 'room-schedule', id: null, base: 'Room-Schedule_All-rooms', pages: roomModel.pages.length, pngPages: [1, avrPage] },
    { view: 'room-schedule', id: String(lab1.key), base: 'Room-Schedule_LAB-1', pages: lab1Pages },
    { view: 'room-schedule', id: String(avr.key), base: 'Room-Schedule_AVR', pages: avrPages }
  ];
  for (const t of targets) {
    for (const format of ['docx', 'pdf']) {
      const q = new URLSearchParams({ ...TERM, view: t.view, format, scheduleId, ...(t.id ? { id: t.id } : {}), ...(t.weekGroup ? { weekGroup: t.weekGroup } : {}) });
      const res = await fetch(`http://localhost:${run.ports.gateway}/api/schedule/exports?${q}`, { headers: { authorization: `Bearer ${dean}` } });
      if (res.status !== 200) fail(`${t.base}.${format}: ${(await res.json().catch(() => ({}))).message || res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const pages = format === 'pdf' ? pdfInfo(buffer).pages : Number(res.headers.get('x-export-pages'));
      if (pages !== t.pages) fail(`${t.base}.${format}: ${pages} pages, ${t.pages} expected.`);
      if (format === 'docx' && t.view === 'teachers-program') {
        const doc = unzipSync(buffer).get('word/document.xml').toString('utf8');
        for (const word of ['RESEARCH', 'EXTENSION', 'CONSULTATION', 'COMPETITIVE EDGE', 'ADMINISTRATIVE FUNCTION']) {
          if (doc.includes(`>${word}</w:t>`)) fail(`${t.base}.docx: a ${word} block is on the grid.`);
        }
      }
      const name = `${t.base}.${format}`;
      fs.writeFileSync(path.join(STAGE, name), buffer);
      files.push({ name, pages, kb: Math.round(buffer.length / 1024) });
      log(`staged ${name} (${pages} pages)`);
      if (format === 'pdf') {
        const tmp = path.join(STAGE, `png-${t.base}`);
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'forms', 'pdf-to-png.ps1'), '-Pdf', path.join(STAGE, name), '-OutDir', tmp, '-Dpi', '150'], { stdio: 'pipe' });
        for (const [i, pageNo] of (t.pngPages || [1]).entries()) {
          const png = i === 0 ? `${t.base}.png` : `${t.base}_page-${String(pageNo).padStart(2, '0')}.png`;
          fs.copyFileSync(path.join(tmp, `page-${String(pageNo).padStart(2, '0')}.png`), path.join(STAGE, png));
          files.push({ name: png, pages: 1, kb: Math.round(fs.statSync(path.join(STAGE, png)).size / 1024) });
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  // Phase 11.4: the strict line widths, from the PDF at 600 and 150 dpi and from Word's PDF at 600.
  const work = path.join(STAGE, 'line-widths');
  fs.mkdirSync(work, { recursive: true });
  const measured = [];
  const lineTargets = [...targets.slice(0, 3).map(t => [t.base, 1]), ['Class-Schedule_All-sections', 1], ['Room-Schedule_All-rooms', 1], ['Room-Schedule_All-rooms', avrPage]];
  for (const [base, pageNo] of lineTargets) {
    for (const [format, dpi] of [['pdf', 600], ['pdf', 150], ['docx', 600]]) {
      const dir = path.join(work, `${base}-p${pageNo}-${format}-${dpi}`);
      fs.mkdirSync(dir, { recursive: true });
      const r = measureFile(path.join(STAGE, `${base}.${format}`), { dpi, pageNo, work: dir });
      measured.push({ file: `${base}.${format}`, renderedFrom: r.renderedFrom, page: pageNo, dpi, pxPerInch: r.pxPerInch, horizontal: r.horizontal, vertical: r.vertical, minPx: r.minPx, maxPx: r.maxPx, allowedSpread: r.tolerancePx, ok: r.ok });
      log(`lines ${base}.${format} page ${pageNo} at ${dpi} dpi (${r.renderedFrom}): ${r.horizontal} + ${r.vertical} lines, ${r.minPx}-${r.maxPx} px${r.ok ? '' : ' (uneven)'}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, '.demo-data', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(REPO, '.demo-data', 'logs', 'p114-line-widths.json'), `${JSON.stringify(measured, null, 2)}\n`);
  const badLines = measured.filter(m => !m.ok);
  if (badLines.length) fail(`Lines of uneven width on ${badLines.map(m => m.file).join(', ')}.`);
  // The three orders, as printed (the page names of each all-in-one file).
  const ends = (list) => ({ count: list.length, first: list.slice(0, 5), last: list.slice(-5), all: list });
  const orders = {
    faculty: ends(model.pages.map(p => p.name)),
    sections: ends(classModel.pages.map(p => p.name)),
    rooms: roomModel.pages.map((p, i) => ({ page: i + 1, room: p.roomName || (p.kind === 'tba' ? 'TBA' : ''), heading: p.name }))
  };
  const lab4 = (outputs.rooms || []).find(r => String(r.name).toUpperCase().replace(/\s+/g, ' ') === 'LAB 4');
  const lab4Type = lab4 ? lab4.type : null;
  fs.writeFileSync(path.join(STAGE, 'samples.json'), `${JSON.stringify({ made: new Date().toISOString(), seed: SEED, version: row.version, ancillaryAddedOnPracticeCopy: added, partTimerAncillaryAdded: false, checks, lineWidths: measured, orders, lectureRoomClashes: clashes, lab4Type, files }, null, 2)}\n`);

  fs.mkdirSync(OUT, { recursive: true });
  for (const old of fs.readdirSync(OUT)) if (old !== 'README.md') fs.rmSync(path.join(OUT, old), { force: true });
  for (const f of fs.readdirSync(STAGE)) fs.copyFileSync(path.join(STAGE, f), path.join(OUT, f));
  log(`wrote ${files.length + 1} files to docs/samples/phase11/`);
})().catch(err => { console.error(`[phase11-samples] ${err.message}`); process.exit(1); });
