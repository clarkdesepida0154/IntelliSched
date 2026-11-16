// The export engine's front door (Phase 8 Part 2): one schedule version's outputs in, one office file
// out — the Class Schedule (SF-003), the room schedule per week group, or the Teachers' Program
// (SF-029), each as DOCX or PDF, whole ("Export all") or one page. File names are plain (decision 2):
//   Class-Schedule_2nd-Sem-AY2026-27.docx          Class-Schedule_BSIT-1A_2nd-Sem-AY2026-27.docx
//   Room-Schedule_2nd-Sem-AY2026-27.pdf             Room-Schedule_LAB-1_2nd-Sem-AY2026-27.pdf
//   (Phase 11.2: ONE Room Schedule file, every room's pages in the office's order; a single room's
//   file carries that room's page or pages)
//   Teachers-Program_All_2nd-Sem-AY2026-27.pdf     Teachers-Program_Faculty_2nd-Sem-AY2026-27.pdf
const { buildExportModel } = require('./pageModels');
const { writeDocx } = require('./docxWriter');
const { writeHtml, sheetInnerHtml, SHEET_CSS } = require('./html');
const { htmlToPdf } = require('./pdf');
const { checkFonts, fontFaceCss } = require('./fonts');

const EXPORT_VIEWS = ['class-schedule', 'room-schedule', 'teachers-program'];
const EXPORT_FORMATS = ['docx', 'pdf'];
const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf'
};

const slug = (text) => String(text ?? '').trim()
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// "2nd Semester" + "2026-2027" -> "2nd-Sem-AY2026-27".
const termSlug = (schedule) => {
  const sem = String(schedule.semesterLabel || '').replace(/\s*Semester\s*/i, '-Sem');
  const ay = /^(\d{4})-(\d{4})$/.exec(String(schedule.academicYear || ''));
  return `${slug(sem)}-AY${ay ? `${ay[1]}-${ay[2].slice(2)}` : slug(schedule.academicYear)}`;
};

// The professor's surname for the file name ("FacultyMember, MSIT" -> "Faculty").
const surnameOf = (name) => {
  const words = String(name ?? '').split(',')[0].trim().split(/\s+/).filter(Boolean);
  return words[words.length - 1] || '';
};

const exportFileName = (model, { format, singlePage = null }) => {
  const term = termSlug(model.schedule);
  const parts = [];
  if (model.view === 'class-schedule') {
    parts.push('Class-Schedule');
    if (singlePage) parts.push(slug(singlePage.name));
  } else if (model.view === 'room-schedule') {
    parts.push('Room-Schedule');
    if (singlePage) parts.push(slug(singlePage.roomName || singlePage.name));
  } else {
    parts.push('Teachers-Program');
    parts.push(singlePage ? slug(surnameOf(singlePage.name)) : 'All');
  }
  parts.push(term);
  return `${parts.filter(Boolean).join('_')}.${format}`;
};

// Builds one export from the outputs answer.
//   view      class-schedule | room-schedule | teachers-program
//   format    docx | pdf
//   weekGroup room schedules only: ODD | EVEN | ALL
//   pageKey   one section id, professor id or room key; null exports every page
// Returns { buffer, fileName, contentType, pages, fontsSubstituted } or throws an Error whose
// `status` and plain message the route can send as they are.
// Phase 11.2: a TBA room has no page of its own on the Room Schedule; its classes are on the last
// page, "Classes without a room (TBA)" (key 'TBA'), so a TBA room's key asks for that page.
const roomPageKey = (view, pageKey) => (view === 'room-schedule' && pageKey && String(pageKey).startsWith('EXTRA-') ? 'TBA' : pageKey);

const buildExport = async ({ outputs, view, format, weekGroup = 'ALL', pageKey: askedKey = null }) => {
  const pageKey = roomPageKey(view, askedKey);
  const refuse = (status, message) => { const err = new Error(message); err.status = status; err.plain = true; return err; };
  if (!EXPORT_VIEWS.includes(view)) throw refuse(400, 'Choose what to export: the Class Schedule, the room schedule or the Teachers’ Program.');
  if (!EXPORT_FORMATS.includes(format)) throw refuse(400, 'Choose the file type: Word (DOCX) or PDF.');

  const model = buildExportModel(outputs, view, { weekGroup });
  let singlePage = null;
  if (pageKey) {
    // A room's file carries all of its pages (a lab's odd and even weeks; Phase 11.2).
    const chosen = model.pages.filter(p => String(p.key) === String(pageKey));
    singlePage = chosen[0] || null;
    if (!singlePage) {
      const noun = view === 'class-schedule' ? 'section' : view === 'room-schedule' ? 'room' : 'professor';
      throw refuse(404, `That ${noun} has no page in this version. Open Schedule Views & Editor and pick one from its list.`);
    }
    model.pages = view === 'room-schedule' ? chosen : [singlePage];
  }
  if (!model.pages.length) {
    throw refuse(404, 'This version has nothing to export for that view.');
  }

  const fonts = checkFonts();
  if (format === 'docx') {
    const { buffer, pages } = writeDocx(model);
    return { buffer, pages, fileName: exportFileName(model, { format, singlePage }), contentType: CONTENT_TYPES.docx, fontsSubstituted: [] };
  }
  const html = writeHtml(model, { fonts });
  const buffer = await htmlToPdf(html);
  return {
    buffer,
    pages: model.pages.length,
    fileName: exportFileName(model, { format, singlePage }),
    contentType: CONTENT_TYPES.pdf,
    fontsSubstituted: fonts.substituted
  };
};


// The print view's pages (Phase 8 Part 10): the SAME sheets the exports draw, as HTML the browser can
// show and print. `weekGroup` ODD | EVEN | ALL; room schedules of a version that alternates weeks pass
// ODD and EVEN together (one list, each page named with its group). Returns { page, css, pages }.
const buildPrintSheets = ({ outputs, view, weekGroups = ['ALL'], pageKey: askedKey = null }) => {
  const pageKey = roomPageKey(view, askedKey);
  const pages = [];
  let page = null;
  // Phase 11.2: the Room Schedule is one list of pages whatever the week groups asked for.
  const groups = view === 'room-schedule' ? ['ALL'] : weekGroups;
  for (const weekGroup of groups) {
    const model = buildExportModel(outputs, view, { weekGroup });
    for (const p of model.pages) {
      if (pageKey && String(p.key) !== String(pageKey)) continue;
      page = p.sheet.page;
      pages.push({ key: String(p.key), name: p.name, weekGroup: p.weekGroup || model.weekGroup || 'ALL', html: sheetInnerHtml(p.sheet) });
    }
  }
  return { page, css: `${fontFaceCss(checkFonts())}
${SHEET_CSS}`, pages };
};

module.exports = { buildPrintSheets, buildExport, exportFileName, termSlug, EXPORT_VIEWS, EXPORT_FORMATS };
