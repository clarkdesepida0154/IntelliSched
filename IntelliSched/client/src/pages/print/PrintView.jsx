import { useEffect, useMemo, useState } from 'react';
import { versionName } from '../../utils/scheduleDisplay';
import { AlertOctagon, ArrowLeft, Info, Loader2, Printer, RefreshCw, TriangleAlert } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import TeachersProgramTable from '../../components/print/TeachersProgramTable';
import {
  PRINT_OUTPUTS, TP_LAYOUTS, allEntities, classesOf, entityKey, entityName, notApprovedText, parsePrintAddress,
  inOfficeOrder, printableEntities, settingText, tbaRoomsOf, teachersProgramLayout, termFileText, termText
} from '../../components/print/printForms';
import '../../components/print/print.css';

// The print view (Phase 3 Step 3): one output of one schedule version as printable forms, one per A4
// portrait page, for the browser's own print dialog ("Print / Save as PDF"). App.jsx shows it instead
// of the dashboard for the address "#/print?…" (printForms.js printAddress), so nothing of the
// dashboard prints; Print Outputs opens it in a new tab. It reads GET /schedule/outputs: the version
// the address names, else the term's official one (the Approved version, else the newest Draft, which
// the toolbar then says). A version that is not Approved prints "DRAFT – NOT APPROVED" on every page
// (Phase 8 Part 6: Approved is final; there is no Publish). The toolbar never prints.
// The Mother Schedule and the Room Program print as class-schedule sheets (ClassScheduleSheet); the
// Teachers' Program prints in the layout the Output Settings choose, or the one the address asks for
// (layout=sf029|table): the SF-029 form (TeachersProgramForm) or the class schedule table
// (TeachersProgramTable). "All professors" prints every professor with at least one class. The Mother
// Schedule and both Teachers' Program layouts list the self-paced online lectures under the grid
// (SelfPacedList, Phase 3 Step 7); the Room Program has none (an online class takes no room).

const CONNECTION_HELP = 'Check that the gateway is running, then press "Try again".';
const REOPEN_HELP = 'Open the print view again from Print Outputs.';

const fetchOutputs = async ({ academicYear, semester, scheduleId }) => {
  const res = await api.get('/schedule/outputs', {
    params: { academicYear, semester, ...(scheduleId ? { scheduleId } : { prefer: 'official' }) }
  });
  const d = res.data;
  if (!d?.success || !d.schedule?.id || !Array.isArray(d.classes)) throw new Error('the gateway answered without a schedule');
  // The table follows the version's policy; nothing is assumed without it.
  const p = d.policy;
  if (!p?.dayStart || !p.dayEnd || !(Number(p.slotMinutes) > 0)) throw new Error("the gateway answered without the schedule's day window");
  return {
    schedule: d.schedule,
    policy: p,
    classes: d.classes,
    sections: Array.isArray(d.sections) ? d.sections : [],
    faculty: Array.isArray(d.faculty) ? d.faculty : [],
    rooms: Array.isArray(d.rooms) ? d.rooms : [],
    settings: d.settings && typeof d.settings === 'object' ? d.settings : {}
  };
};

// The shared pages (Phase 8 Part 10): the same sheets the Word and PDF exports draw, from the gateway.
const SHEET_VIEWS = { section: 'class-schedule', room: 'room-schedule', professor: 'teachers-program' };
const fetchSheets = async ({ academicYear, semester, scheduleId, view, id }) => {
  const res = await api.get('/schedule/print-sheets', {
    params: { academicYear, semester, view: SHEET_VIEWS[view], ...(id ? { id } : {}), ...(scheduleId ? { scheduleId } : { prefer: 'official' }) }
  });
  const d = res.data;
  if (!d?.success || !Array.isArray(d.pages) || !d.page) throw new Error('the gateway answered without pages');
  return { pages: d.pages, css: d.css || '', page: d.page };
};

// What a failed read shows, and whether "Try again" can help.
const loadErrorOf = (err) => {
  const status = err.response?.status;
  const body = err.response?.data || {};
  if (status === 404 && (body.code === 'NO_SCHEDULE' || body.code === 'NO_OPEN_VERSION')) {
    return { message: body.message || 'No schedule has been generated for this term yet.', retry: false };
  }
  if ((status === 404 && body.code === 'VERSION_NOT_IN_TERM') || (status === 409 && body.code === 'LEGACY_VERSION')) {
    return { message: `${body.message || 'This version cannot be printed.'} ${REOPEN_HELP}`, retry: false };
  }
  return { message: `The schedule could not be loaded (${body.message || err.message}). ${CONNECTION_HELP}`, retry: true };
};

// The sheets this print makes: { scopeName, entities, skipped, empty }, or { problem } when the
// address can't be printed.
const planOf = (data, params) => {
  const meta = PRINT_OUTPUTS[params.output];
  const { view } = meta;
  if (params.tba) {
    if (view !== 'room') return { problem: `Only the Room Program prints the TBA rooms to request. ${REOPEN_HELP}` };
    return {
      scopeName: 'TBA rooms to request',
      entities: inOfficeOrder(data, 'room', tbaRoomsOf(data)),
      skipped: [],
      empty: 'Every class that needs a room has a CCS room, so there is no TBA room to print.'
    };
  }
  if (params.all) {
    const entities = printableEntities(data, view);
    // A section or professor without a class in this version has nothing to print; they are named.
    const skipped = view === 'room' ? [] : allEntities(data, view).filter(e => !entities.includes(e)).map(e => entityName(view, e));
    return { scopeName: `All ${meta.nounPlural}`, entities, skipped, empty: `This version has no ${meta.noun} with classes to print.` };
  }
  if (params.id) {
    const found = allEntities(data, view).find(e => entityKey(view, e) === params.id);
    if (!found) return { problem: `That ${meta.noun} is not in this version. ${REOPEN_HELP}` };
    return { scopeName: entityName(view, found), entities: [found], skipped: [], empty: '' };
  }
  return { problem: `This print address does not say what to print. ${REOPEN_HELP}` };
};

// Closes a print view that Print Outputs opened in its own tab; otherwise (or when the browser keeps
// the tab open) shows the app in this tab.
const goBack = () => {
  if (window.opener) window.close();
  setTimeout(() => { if (!window.closed) window.location.hash = ''; }, window.opener ? 300 : 0);
};

const toolbarButton = 'shrink-0 inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2';

export default function PrintView({ search = '' }) {
  const params = useMemo(() => parsePrintAddress(search), [search]);
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const academicYear = params.academicYear || activeAcademicYear;
  const semester = params.semester || activeSemesterNumber;
  const meta = PRINT_OUTPUTS[params.output] || null;
  const scheduleId = params.scheduleId;

  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ status: 'loading', data: null, error: null });
  useEffect(() => {
    if (!meta) return undefined;
    let active = true;
    fetchOutputs({ academicYear, semester, scheduleId })
      .then(data => { if (active) setResult({ status: 'ready', data, error: null }); })
      .catch(err => { if (active) setResult({ status: 'error', data: null, error: loadErrorOf(err) }); });
    return () => { active = false; };
  }, [meta, academicYear, semester, scheduleId, attempt]);

  const retry = () => {
    setResult({ status: 'loading', data: null, error: null });
    setAttempt(n => n + 1);
  };

  const data = result.status === 'ready' ? result.data : null;
  const schedule = data?.schedule || null;
  const plan = data && meta ? planOf(data, params) : null;
  // The pages themselves, drawn by the gateway: one request for the output (a single page when the
  // address names one). The Teachers' Program's class-schedule-table layout is still drawn here.
  const [sheetState, setSheetState] = useState({ status: 'idle', pages: [], css: '', page: null });
  const sheetView = meta?.view || null;
  const sheetsWanted = Boolean(plan) && !plan.problem;
  const tableLayout = sheetView === 'professor' && data ? teachersProgramLayout(params.layout, data.settings) === 'TABLE' : false;
  useEffect(() => {
    if (!sheetsWanted || tableLayout) return undefined;
    let active = true;
    fetchSheets({ academicYear, semester, scheduleId, view: sheetView, id: params.all || params.tba ? null : params.id })
      .then(r => { if (active) setSheetState({ status: 'ready', ...r }); })
      .catch(err => { if (active) setSheetState({ status: 'error', pages: [], css: '', page: null, error: err.response?.data?.message || err.message }); });
    return () => { active = false; };
  }, [sheetsWanted, tableLayout, academicYear, semester, scheduleId, sheetView, params.id, params.all, params.tba, attempt]);

  const planned = plan && !plan.problem ? plan.entities : [];
  // The TBA rooms to request print only their own pages; every other output prints what the gateway drew.
  const drawn = sheetState.status === 'ready'
    // Phase 11.2: the Room Schedule's TBA classes are on its last page ("Classes without a room (TBA)").
    ? (params.tba ? sheetState.pages.filter(p => p.key === 'TBA' || String(p.key).startsWith('EXTRA-')) : sheetState.pages)
    : [];
  const sheets = tableLayout ? planned : drawn;
  const pageSize = sheetState.page;
  const pageWords = pageSize && pageSize.w > pageSize.h ? 'landscape' : 'portrait';
  const watermark = Boolean(schedule) && !schedule.isOfficial;
  // The Teachers' Program's layout for this print: the address's, else the Output Settings'.
  const tpLayout = meta?.view === 'professor' && data ? teachersProgramLayout(params.layout, data.settings) : null;

  // The tab's title; a PDF saved from the print dialog takes it as its file name.
  const titleText = meta && schedule && plan && !plan.problem
    ? `${meta.name} - ${plan.scopeName} - ${termFileText(schedule)}`
    : `Print${meta ? ` - ${meta.name}` : ''} - IntelliSched`;
  useEffect(() => {
    const previous = document.title;
    document.title = titleText;
    return () => { document.title = previous; };
  }, [titleText]);

  // Why "Print / Save as PDF" can't be pressed (empty when it can).
  const problem = !meta ? `This print address names no output to print. ${REOPEN_HELP}` : plan?.problem || '';
  const printBlocked = problem ? 'Nothing to print: see the message below.'
    : result.status === 'loading' ? 'Wait until the schedule is loaded.'
      : result.status === 'error' ? 'Nothing to print: the schedule could not be loaded.'
        : !tableLayout && sheetState.status === 'error' ? 'Nothing to print: the pages could not be made.'
          : !tableLayout && sheetState.status !== 'ready' ? 'Wait until the pages are ready.'
            : !sheets.length ? plan.empty
              : '';

  const settings = data?.settings || {};
  const outputSettings = (meta && settings[meta.settingsKey]) || {};
  const campusCode = settings.campusCode || '';
  const common = data && meta ? {
    collegeName: settingText(settings.collegeName),
    // The gateway always sends a title (the default until the Dean saves one); if one were ever
    // missing, the sheet prints no title rather than one made up here.
    title: settingText(outputSettings.title),
    termLabel: termText(schedule),
    policy: data.policy,
    signatories: Array.isArray(outputSettings.signatories) ? outputSettings.signatories : [],
    form: outputSettings,
    watermark
  } : null;

  const statusNote = schedule && watermark ? `${notApprovedText(schedule.status)}: every page is marked DRAFT – NOT APPROVED.` : '';

  return (
    <div className="print-root">
      {/* TOOLBAR (never printed) */}
      <div data-testid="print-toolbar" className="print-toolbar sticky top-0 z-20 bg-white border-b border-slate-300 shadow-sm font-sans text-slate-800">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              data-testid="print-back"
              onClick={goBack}
              title="Close the print view and go back to IntelliSched"
              className={`${toolbarButton} text-slate-800 border border-slate-300 bg-white hover:bg-slate-100`}
            >
              <ArrowLeft size={14} className="mr-1.5" aria-hidden="true" /> Back
            </button>
            <div className="min-w-0">
              <h1 data-testid="print-heading" className="text-base font-black text-slate-900 leading-tight">
                {meta ? meta.name : 'Print'}{plan?.scopeName ? ` · ${plan.scopeName}` : ''}
              </h1>
              {schedule && (
                <p data-testid="print-summary" className="text-xs text-slate-700 mt-0.5">
                  Version {versionName(schedule.version)} · {schedule.status} · {termText(schedule)}
                  {sheets.length > 0 && ` · ${sheets.length} page${sheets.length === 1 ? '' : 's'}, one ${meta.noun} per A4 page (${tableLayout ? 'portrait' : pageWords})`}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 max-w-sm">
            <button
              type="button"
              data-testid="print-button"
              onClick={() => window.print()}
              disabled={Boolean(printBlocked)}
              aria-describedby={printBlocked ? 'print-button-reason' : undefined}
              className={`${toolbarButton} text-white bg-blue-800 hover:bg-blue-700`}
            >
              <Printer size={14} className="mr-1.5" aria-hidden="true" /> Print / Save as PDF
            </button>
            {printBlocked && (
              <p id="print-button-reason" data-testid="print-button-reason" className="text-[11px] text-slate-700 text-right">{printBlocked}</p>
            )}
          </div>
        </div>
        {(statusNote || schedule?.fallback || plan?.skipped?.length > 0 || sheets.length > 0) && (
          <div className="max-w-5xl mx-auto px-4 pb-3 space-y-1.5 text-xs">
            {statusNote && (
              <p data-testid="print-draft-note" className="flex items-start gap-1.5 p-2 rounded-lg border border-amber-300 bg-amber-50 font-bold text-amber-900">
                <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" /> {statusNote}
              </p>
            )}
            {schedule?.fallback && (
              <p data-testid="print-fallback-note" className="flex items-start gap-1.5 text-slate-800">
                <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
                No version of this term is Approved yet, so the newest Draft is printed.
              </p>
            )}
            {plan?.skipped?.length > 0 && (
              <p data-testid="print-skipped" className="flex items-start gap-1.5 text-slate-800">
                <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
                Not printed (no class in this version): {plan.skipped.join(', ')}.
              </p>
            )}
            {tpLayout && sheets.length > 0 && (
              <p data-testid="print-tp-layout" className="flex items-start gap-1.5 text-slate-800">
                <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
                Layout: {TP_LAYOUTS[tpLayout]} ({params.layout ? 'chosen for this print' : 'from the Output Settings'}).
              </p>
            )}
            {sheets.length > 0 && (
              <p data-testid="print-tip" className="text-slate-700">
                In the print dialog, choose A4 paper, portrait. To keep a file, choose &ldquo;Save as PDF&rdquo; as the printer.
              </p>
            )}
          </div>
        )}
      </div>

      {/* STATES (never printed) */}
      {meta && !problem && result.status === 'loading' && (
        <div data-testid="print-loading" role="status" className="print-screen-only p-16 flex flex-col items-center gap-3 font-sans text-slate-800">
          <Loader2 size={32} className="animate-spin text-blue-800" aria-hidden="true" />
          <p className="text-xs font-bold uppercase tracking-wider">Loading the schedule…</p>
        </div>
      )}
      {(problem || result.status === 'error') && (
        <div data-testid="print-error" role="alert" className="print-screen-only max-w-lg mx-auto my-10 p-8 rounded-2xl bg-white border border-slate-300 text-center font-sans">
          <AlertOctagon size={36} className="text-amber-600 mx-auto mb-3" aria-hidden="true" />
          <h2 className="text-base font-bold text-slate-900 mb-1">This can&apos;t be printed</h2>
          <p data-testid="print-error-message" className="text-sm text-slate-800 mb-4">{problem || result.error?.message}</p>
          {!problem && result.error?.retry && (
            <button type="button" data-testid="print-retry" onClick={retry} className={`${toolbarButton} text-white bg-blue-800 hover:bg-blue-700 mx-auto`}>
              <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
            </button>
          )}
        </div>
      )}
      {data && !problem && !sheets.length && (
        <p data-testid="print-empty" className="print-screen-only max-w-lg mx-auto my-10 p-6 rounded-2xl bg-white border border-slate-300 text-sm text-slate-800 font-sans text-center">
          {plan.empty}
        </p>
      )}

      {/* THE PAGES: the sheets the exports draw (the gateway makes them), one per A4 page */}
      {!tableLayout && sheetState.status === 'error' && !problem && (
        <div data-testid="print-sheets-error" role="alert" className="print-screen-only max-w-lg mx-auto my-10 p-6 rounded-2xl bg-white border border-slate-300 text-center font-sans text-sm text-slate-800">
          <p className="mb-3">The pages could not be made ({sheetState.error}). {CONNECTION_HELP}</p>
          <button type="button" data-testid="print-sheets-retry" onClick={() => { setSheetState({ status: 'idle', pages: [], css: '', page: null }); setAttempt(n => n + 1); }} className={`${toolbarButton} text-white bg-blue-800 hover:bg-blue-700 mx-auto`}>
            <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
          </button>
        </div>
      )}
      {!tableLayout && sheetsWanted && sheetState.status !== 'ready' && sheetState.status !== 'error' && !problem && (
        <div data-testid="print-sheets-loading" role="status" className="print-screen-only p-16 flex flex-col items-center gap-3 font-sans text-slate-800">
          <Loader2 size={32} className="animate-spin text-blue-800" aria-hidden="true" />
          <p className="text-xs font-bold uppercase tracking-wider">Making the pages…</p>
        </div>
      )}
      {sheets.length > 0 && !tableLayout && pageSize && (
        <main className="print-pages print-shared" aria-label="Pages to print">
          <style>{`${sheetState.css}
@page { size: ${pageSize.w}mm ${pageSize.h}mm; margin: 0; }
.print-shared .sheet { margin: 0 auto 16px; box-shadow: 0 1px 6px rgba(0,0,0,.25); }
@media print { .print-shared .sheet { margin: 0; box-shadow: none; } }`}</style>
          {sheets.map((p, i) => (
            <section
              key={`${p.weekGroup}-${p.key}-${i}`}
              className="sheet"
              data-page-key={p.key}
              data-page-name={p.name}
              data-week-group={p.weekGroup}
              style={{ width: `${pageSize.w}mm`, height: `${pageSize.h}mm` }}
              dangerouslySetInnerHTML={{ __html: p.html }}
            />
          ))}
        </main>
      )}
      {sheets.length > 0 && tableLayout && (
        <main className="print-pages" aria-label="Pages to print">
          {sheets.map(professor => (
            <TeachersProgramTable
              key={`professor-${professor.id}`}
              professor={professor}
              classes={classesOf(data.classes, 'professor', String(professor.id))}
              policy={data.policy}
              settings={outputSettings}
              collegeName={common.collegeName}
              termLabel={common.termLabel}
              campusCode={campusCode}
              watermark={watermark}
            />
          ))}
        </main>
      )}
    </div>
  );
}
