import { useEffect, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import api from '../../services/api';
import { EXPORT_VIEWS, FORMAT_WORDS, downloadExport, downloadedText, exportViewOf } from '../../utils/exportDownload';
import Select from '../ui/Select';

// The office's exports on the pages (Phase 8 Part 2, Step 5):
//   - ExportCard: Print Outputs' card — the file (Class Schedule, Room Schedule, Teachers' Program),
//     Word or PDF, all pages or one; the export uses the version chosen on the page. Since Phase 11.2
//     the Room Schedule is ONE file in the office's format (the odd-weeks and even-weeks all-rooms
//     files are gone: the labs' week groups are pages of that file). One line says when the PDF would
//     substitute fonts on this computer.
//   - ExportThisPage: Schedule Views & Editor's "Export this page" — the open section, professor or
//     room as the office's file, Word or PDF.
// Both download through utils/exportDownload.js; the gateway builds and names the file.

const buttonClass = 'inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-orange-500 text-white bg-indigo-700 hover:bg-indigo-800';
const lightButtonClass = 'inline-flex items-center justify-center px-3 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-orange-500 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800';
const selectClass = 'w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white disabled:opacity-60 focus:outline-none focus:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500';

// What the PDF would do on this computer: ready or not, and the one-line font note (decision 3).
// Read once per page; a failed read only hides the note (the download itself still answers plainly).
const useFontNote = () => {
  const [fonts, setFonts] = useState({ loaded: false, pdfReady: true, substituted: [] });
  useEffect(() => {
    let active = true;
    api.get('/schedule/exports/fonts')
      .then(res => { if (active && res.data?.success) setFonts({ loaded: true, pdfReady: res.data.pdfReady !== false, substituted: res.data.substituted || [] }); })
      .catch(() => { /* the note is optional; the download answers for itself */ });
    return () => { active = false; };
  }, []);
  return fonts;
};

const PDF_NOT_READY = 'No browser for the PDF was found on this computer. Export the file as Word (DOCX) instead.';
const fontNoteText = (fonts) => (fonts.substituted.length
  ? `PDFs made on this computer use an open look-alike with the same letter widths: ${fonts.substituted.join('; ')}. Word files use Arial.`
  : '');

// One download run with its status line: idle -> busy -> done | failed.
const useDownloadRun = () => {
  const [run, setRun] = useState({ busy: false, message: '', tone: 'info' });
  const start = async (params, { onDone } = {}) => {
    setRun({ busy: true, message: 'Making the file…', tone: 'info' });
    try {
      const done = await downloadExport(params);
      setRun({ busy: false, message: downloadedText(done), tone: 'success' });
      if (onDone) onDone(done);
    } catch (err) {
      setRun({ busy: false, message: err.message, tone: 'error' });
    }
  };
  return { run, start };
};

const StatusLine = ({ run, testId }) => (run.message ? (
  <p
    data-testid={testId}
    data-tone={run.tone}
    role="status"
    className={`text-[11px] ${run.tone === 'error' ? 'font-bold text-red-700 dark:text-red-400' : 'text-slate-700 dark:text-slate-300'}`}
  >
    {run.busy && <Loader2 size={11} className="inline mr-1 animate-spin" aria-hidden="true" />}
    {run.message}
  </p>
) : null);

// ---------------------------------------------------------------- the Export card (Print Outputs)

export function ExportCard({ data, schedule, versionWord }) {
  const [viewId, setViewId] = useState('class-schedule');
  const [scope, setScope] = useState({ 'class-schedule': 'all', 'room-schedule': 'all', 'teachers-program': 'all' });
  const fonts = useFontNote();
  const { run, start } = useDownloadRun();

  const meta = EXPORT_VIEWS.find(v => v.id === viewId);
  const entities = data.exportEntities[meta.view] || [];
  const chosenKey = scope[viewId] !== 'all' && entities.some(e => e.key === scope[viewId]) ? scope[viewId] : 'all';
  const nothing = entities.length ? '' : `No ${meta.noun} has a page in this version, so there is nothing to export.`;
  const pdfBlocked = fonts.loaded && !fonts.pdfReady ? PDF_NOT_READY : '';
  const note = fontNoteText(fonts);

  const download = (format) => start({
    view: viewId,
    format,
    academicYear: schedule.academicYear,
    semester: schedule.semester,
    scheduleId: schedule.id,
    ...(chosenKey !== 'all' ? { id: chosenKey } : {})
  });

  return (
    <section data-testid="po-card-export" aria-labelledby="po-card-export-title" className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col gap-4 min-w-0 xl:col-span-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-700 dark:text-indigo-400 shrink-0">
          <Download size={20} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 id="po-card-export-title" className="text-lg font-black text-slate-900 dark:text-white leading-snug">Export (Word or PDF)</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
            The office&apos;s own files, made from the version chosen above{versionWord ? ` (${versionWord})` : ''}: the same paper, header, grid and signatories as the sheets the office prints today.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="export-view" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">File</label>
          <Select id="export-view" data-testid="export-view" value={viewId} onChange={e => setViewId(e.target.value)} className={selectClass}>
            {EXPORT_VIEWS.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <p data-testid="export-view-detail" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{meta.detail}</p>
        </div>
        <div>
          <label htmlFor="export-scope" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Which {meta.nounPlural}</label>
          <Select id="export-scope" data-testid="export-scope" value={chosenKey} onChange={e => setScope(prev => ({ ...prev, [viewId]: e.target.value }))} disabled={!entities.length} className={selectClass}>
            <option value="all">{entities.length ? `All ${meta.nounPlural} (${entities.length})` : `None with a page`}</option>
            {entities.map(e => <option key={e.key} value={e.key}>{e.label}</option>)}
          </Select>
        </div>
      </div>

      <div role="group" aria-label="Download" className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="export-docx" onClick={() => download('docx')} disabled={run.busy || Boolean(nothing)} title={nothing || undefined} className={buttonClass}>
            <FileText size={14} className="mr-1.5 shrink-0" aria-hidden="true" /> Download {FORMAT_WORDS.docx}
          </button>
          <button type="button" data-testid="export-pdf" onClick={() => download('pdf')} disabled={run.busy || Boolean(nothing) || Boolean(pdfBlocked)} title={nothing || pdfBlocked || undefined} className={buttonClass}>
            <FileText size={14} className="mr-1.5 shrink-0" aria-hidden="true" /> Download {FORMAT_WORDS.pdf}
          </button>
        </div>
        {[nothing, pdfBlocked].filter(Boolean).map(reason => (
          <p key={reason} data-testid="export-reason" className="text-[11px] text-slate-600 dark:text-slate-400">{reason}</p>
        ))}
        {note && <p data-testid="export-font-note" className="text-[11px] text-slate-600 dark:text-slate-400">{note}</p>}
        <StatusLine run={run} testId="export-status" />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- "Export this page" (Schedule Views)

// weekGroupsOn / weekFilter are still passed by Schedule Views and no longer change the file: a room's
// Room Schedule file carries all of its pages (Phase 11.2).
export function ExportThisPage({ view, entity, schedule, weekGroupsOn = false, weekFilter = 'both', busyReason = '' }) {
  const meta = exportViewOf(view);
  const fonts = useFontNote();
  const { run, start } = useDownloadRun();
  if (!meta || !entity || !schedule) return null;

  const pdfBlocked = fonts.loaded && !fonts.pdfReady ? PDF_NOT_READY : '';
  const blocked = busyReason;

  const download = (format) => start({
    view: meta.id,
    format,
    academicYear: schedule.academicYear,
    semester: schedule.semester,
    scheduleId: schedule.id,
    id: entity.key
  });

  return (
    <div data-testid="export-this-page" className="space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300">Export this page ({meta.name})</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="export-page-docx" onClick={() => download('docx')} disabled={run.busy || Boolean(blocked)} title={blocked || undefined} className={lightButtonClass}>
          <Download size={13} className="mr-1.5 shrink-0" aria-hidden="true" /> Word
        </button>
        <button type="button" data-testid="export-page-pdf" onClick={() => download('pdf')} disabled={run.busy || Boolean(blocked) || Boolean(pdfBlocked)} title={blocked || pdfBlocked || undefined} className={lightButtonClass}>
          <Download size={13} className="mr-1.5 shrink-0" aria-hidden="true" /> PDF
        </button>
      </div>
      {[blocked, pdfBlocked].filter(Boolean).map(reason => (
        <p key={reason} data-testid="export-page-reason" className="text-[11px] text-slate-600 dark:text-slate-400 max-w-56">{reason}</p>
      ))}
      <StatusLine run={run} testId="export-page-status" />
    </div>
  );
}
