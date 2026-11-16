// The office's exports (Phase 8 Part 2): GET /api/schedule/exports streams one file — the Class
// Schedule (LSPU-ACAD-SF-003), the room schedule per week group, or the Teachers' Program
// (LSPU-ACAD-SF-029) — as DOCX or PDF, whole or one page. Reads only: like printing, open to every
// signed-in role (the permission map covers writes). The version is the outputs' choice (the one
// Print Outputs shows), so the export and the print views always carry the same classes.
//   ?academicYear&semester            the term
//   &view=class-schedule|room-schedule|teachers-program
//   &format=docx|pdf
//   [&scheduleId]                     one version (else prefer decides)
//   [&prefer=draft|official]          which version opens when none is named (official = printing's)
//   [&id]                             one section id, professor id or room key; absent exports all
//   [&weekGroup=odd|even|all]         accepted and ignored since Phase 11.2 (one Room Schedule file)
// GET /api/schedule/exports/fonts answers which fonts the PDF would substitute on this computer, for
// the Export card's one-line note (decision 3).
const { loadScheduleOutputs } = require('./outputsController');
const { buildExport, buildPrintSheets, EXPORT_VIEWS, EXPORT_FORMATS } = require('../exports');
const { checkFonts } = require('../exports/fonts');
const { findBrowser } = require('../exports/pdf');
const { plainMessage } = require('../utils/messages');

const sanitizedMessage = (err, fallback) => plainMessage(err, fallback, { label: '[Exports]' });

const WEEK_GROUPS = { odd: 'ODD', even: 'EVEN', all: 'ALL' };

exports.exportSchedule = async (req, res) => {
  try {
    const view = String(req.query.view ?? '').trim();
    if (!EXPORT_VIEWS.includes(view)) {
      return res.status(400).json({ success: false, message: 'Choose what to export: view=class-schedule, room-schedule or teachers-program.' });
    }
    const format = String(req.query.format ?? '').trim().toLowerCase();
    if (!EXPORT_FORMATS.includes(format)) {
      return res.status(400).json({ success: false, message: 'Choose the file type: format=docx (Word) or format=pdf.' });
    }
    const weekGroupAsked = String(req.query.weekGroup ?? '').trim().toLowerCase();
    if (weekGroupAsked && !(weekGroupAsked in WEEK_GROUPS)) {
      return res.status(400).json({ success: false, message: 'Choose the week group: odd, even or all.' });
    }

    const { outputs, error } = await loadScheduleOutputs(req.query);
    if (error) return res.status(error.status).json(error.payload);

    // Phase 11.2: the Room Schedule is ONE file with every room's pages in the office's order (the
    // labs' odd and even weeks on their own pages), so a week group asked by an older caller is
    // accepted and makes no difference.
    const weekGroup = 'ALL';

    const pageKey = String(req.query.id ?? '').trim() || null;
    const file = await buildExport({ outputs, view, format, weekGroup, pageKey });

    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.buffer.length);
    // Plain facts a script can read without opening the file (the system check does).
    res.setHeader('X-Export-Pages', String(file.pages));
    if (file.fontsSubstituted.length) res.setHeader('X-Export-Fonts-Substituted', file.fontsSubstituted.join('; '));
    res.send(file.buffer);
  } catch (err) {
    // buildExport's own refusals carry plain words and a status; anything else is sanitized.
    if (err?.plain && err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    console.error('[Exports Error]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The file could not be made. Try again; if it keeps happening, tell the College Secretary.') });
  }
};

// The print view's pages (Phase 8 Part 10): GET /api/schedule/print-sheets?view&id&weekGroup + the
// outputs' version choice. The same sheets the exports draw, as HTML; read only, every signed-in role.
exports.printSheets = async (req, res) => {
  try {
    const view = String(req.query.view ?? '').trim();
    if (!EXPORT_VIEWS.includes(view)) {
      return res.status(400).json({ success: false, message: 'Choose what to show: view=class-schedule, room-schedule or teachers-program.' });
    }
    const weekGroupAsked = String(req.query.weekGroup ?? '').trim().toLowerCase();
    if (weekGroupAsked && !(weekGroupAsked in WEEK_GROUPS)) {
      return res.status(400).json({ success: false, message: 'Choose the week group: odd, even or all.' });
    }
    const { outputs, error } = await loadScheduleOutputs(req.query);
    if (error) return res.status(error.status).json(error.payload);
    // Phase 11.2: the Room Schedule's pages are one list (exports/index.js buildPrintSheets).
    const weekGroups = ['ALL'];
    const pageKey = String(req.query.id ?? '').trim() || null;
    const sheets = buildPrintSheets({ outputs, view, weekGroups, pageKey });
    if (pageKey && !sheets.pages.length) {
      return res.status(404).json({ success: false, message: 'That page is not in this version. Open Print Outputs and pick one from its list.' });
    }
    res.status(200).json({ success: true, schedule: outputs.schedule, ...sheets });
  } catch (err) {
    console.error('[Exports Error - print sheets]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The pages could not be made. Try again.') });
  }
};

// What the Export card says about fonts on this computer: nothing when the real fonts are installed,
// else "Arial Narrow shown as Archivo Narrow; …" (PDF only; DOCX always names the real fonts).
exports.exportFonts = async (req, res) => {
  try {
    const fonts = checkFonts();
    res.status(200).json({
      success: true,
      substituted: fonts.substituted,
      pdfReady: Boolean(findBrowser())
    });
  } catch (err) {
    console.error('[Exports Error - fonts]', err);
    res.status(500).json({ success: false, message: sanitizedMessage(err, 'The font check could not run. Try again.') });
  }
};
