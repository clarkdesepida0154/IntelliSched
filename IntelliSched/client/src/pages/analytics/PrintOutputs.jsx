import { useEffect, useRef, useState } from 'react';
import { versionName } from '../../utils/scheduleDisplay';
import {
  AlertOctagon, CheckCircle2, DoorOpen, FileSpreadsheet, Info, Layers, Loader2, Play, Printer, RefreshCw, Settings2,
  TriangleAlert, User, X
} from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import PageHeader from '../../components/layout/PageHeader';
import {
  PRINT_OUTPUTS, TP_LAYOUTS, byDayAndStart, classesOf, entityKey, entityName, inOfficeOrder, notApprovedText, printAddress, printableEntities,
  tbaRoomsOf, termFileText
} from '../../components/print/printForms';
import { csvFileName, downloadScheduleCsv } from '../../utils/scheduleCsv';
import { tbaRequestHeader } from '../../utils/scheduleDisplay';
import { ExportCard } from '../../components/print/ExportControls';
import useDataChanges from '../../hooks/useDataChanges';
import Select from '../../components/ui/Select';

// Print Outputs (Phase 3 Step 3; it replaces the "Official LSPU Form Exporters" page). The three
// outputs of one schedule version: each section's Mother Schedule, each professor's Teachers'
// Program and each room's Room Program, one or all of them (and the TBA rooms to request). "Print"
// opens the print view in a new tab (one form per A4 page, the browser's own print dialog); "CSV"
// downloads the same classes as a spreadsheet file. The version shown first is the term's official
// one (the Approved version, final; Phase 8 Part 6: there is no Publish); a Draft can be chosen for checking, and every page it prints is
// marked DRAFT – NOT APPROVED. Everything comes from GET /schedule/outputs, like the Schedule Views.
//
// Props: onNavigate (the shell's onNavigate(key, params)) for the links to Generate Schedule and to
// Output Settings.

const CONNECTION_HELP = 'Check that the gateway is running, then press "Try again".';
const LAYOUT_WORDS = TP_LAYOUTS;
const ROOM_GROUPS = [
  { kind: 'CCS', label: 'CCS rooms' },
  { kind: 'BORROWED', label: 'Borrowed rooms' },
  { kind: 'TBA', label: 'TBA rooms to request' }
];
const STATUS_BADGE = {
  Draft: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  'Under Review': 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
  Approved: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-500/10 dark:text-green-300 dark:border-green-500/20'
};
const OTHER_BADGE = 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';

const fetchOutputs = async (academicYear, semester, scheduleId) => {
  const res = await api.get('/schedule/outputs', {
    params: { academicYear, semester, ...(scheduleId ? { scheduleId } : { prefer: 'official' }) }
  });
  const d = res.data;
  if (!d?.success || !d.schedule?.id || !Array.isArray(d.classes)) throw new Error('the gateway answered without a schedule');
  return {
    schedule: d.schedule,
    classes: d.classes,
    sections: Array.isArray(d.sections) ? d.sections : [],
    faculty: Array.isArray(d.faculty) ? d.faculty : [],
    rooms: Array.isArray(d.rooms) ? d.rooms : [],
    tbaRequest: d.tbaRequest || null,
    settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
    // The Export card reads the version's odd/even weeks setting (Phase 8 Part 2).
    policy: d.policy && typeof d.policy === 'object' ? d.policy : {}
  };
};

// What a failed read shows: the no-schedule state (no version, or none that opens here), or an error
// with the way out.
const loadErrorOf = (err) => {
  const status = err.response?.status;
  const body = err.response?.data || {};
  if (status === 404 && body.code === 'NO_SCHEDULE') return { kind: 'empty', message: 'No schedule has been generated for this term yet.' };
  if (status === 404 && body.code === 'NO_OPEN_VERSION') return { kind: 'empty', message: body.message || "None of this term's versions can be printed here." };
  if ((status === 404 && body.code === 'VERSION_NOT_IN_TERM') || (status === 409 && body.code === 'LEGACY_VERSION')) {
    return { kind: 'error', fix: 'official', message: body.message || 'This version cannot be printed for this term.' };
  }
  return { kind: 'error', fix: 'retry', message: `The schedule could not be loaded (${body.message || err.message}). ${CONNECTION_HELP}` };
};

const countText = (n, noun = 'class', plural = 'classes') => `${n} ${n === 1 ? noun : plural}`;

// The classes a CSV holds, in the order a reader expects: one section's in the gateway's order (day,
// start); one professor's or room's by day and start; all professors' or rooms' grouped by professor
// or room in the gateway's order. scope: 'one' | 'all' | 'tba'.
const csvClasses = (data, view, scope, key) => {
  if (scope === 'one') {
    const own = classesOf(data.classes, view, key);
    return view === 'section' ? own : [...own].sort(byDayAndStart);
  }
  if (view === 'section') return data.classes;
  const groups = view === 'professor' ? inOfficeOrder(data, 'professor', data.faculty).map(f => String(f.id)) : inOfficeOrder(data, 'room', scope === 'tba' ? tbaRoomsOf(data) : data.rooms).map(r => String(r.key));
  const order = new Map(groups.map((k, i) => [k, i]));
  const groupOf = (cls) => (view === 'professor' ? cls.facultyRef : cls.roomKey);
  return data.classes
    .filter(cls => groupOf(cls) != null && order.has(String(groupOf(cls))))
    .sort((a, b) => (order.get(String(groupOf(a))) - order.get(String(groupOf(b)))) || byDayAndStart(a, b));
};

const buttonBase = 'inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-orange-500';
const printButton = `${buttonBase} text-white bg-orange-700 hover:bg-orange-800`;
const csvButton = `${buttonBase} text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800`;
const selectClass = 'w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white disabled:opacity-60 focus:outline-none focus:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500';

// A row of buttons (Print or CSV) with the reason under it when one of them can't be pressed.
function ActionRow({ label, icon: Icon, actions, className }) {
  const reasons = [...new Set(actions.map(a => a.blocked).filter(Boolean))];
  return (
    <div role="group" aria-label={label} className="space-y-1.5">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">{label}</p>
      <div className="flex flex-wrap gap-2">
        {actions.map(a => (
          <button
            key={a.testId}
            type="button"
            data-testid={a.testId}
            onClick={a.onClick}
            disabled={Boolean(a.blocked)}
            title={a.blocked || a.title || undefined}
            className={className}
          >
            <Icon size={14} className="mr-1.5 shrink-0" aria-hidden="true" /> {a.label}
          </button>
        ))}
      </div>
      {reasons.map(reason => (
        <p key={reason} data-testid="po-action-reason" className="text-[11px] text-slate-600 dark:text-slate-400">{reason}</p>
      ))}
    </div>
  );
}

function OutputCard({ testId, icon: Icon, title, purpose, children }) {
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-title`} className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col gap-4 min-w-0">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center text-orange-700 dark:text-orange-400 shrink-0">
          <Icon size={20} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 id={`${testId}-title`} className="text-lg font-black text-slate-900 dark:text-white leading-snug">{title}</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{purpose}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function PrintOutputs({ onNavigate = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();

  // ---------------------------------------------------------------- the version shown
  const [request, setRequest] = useState({ scheduleId: null, n: 0 });
  const [result, setResult] = useState({ status: 'loading', data: null, error: null });
  useEffect(() => {
    let active = true;
    fetchOutputs(activeAcademicYear, activeSemesterNumber, request.scheduleId)
      .then(data => { if (active) setResult({ status: 'ready', data, error: null }); })
      .catch(err => {
        if (!active) return;
        const error = loadErrorOf(err);
        setResult({ status: error.kind, data: null, error });
      });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber, request]);

  // The term's versions for the selector: those with classes, saved in the current format.
  const [versions, setVersions] = useState({ list: [], failed: false });
  useEffect(() => {
    let active = true;
    api.get('/schedule/versions', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } })
      .then(res => {
        if (!active) return;
        const list = Array.isArray(res.data?.versions) ? res.data.versions : [];
        setVersions({ list: list.filter(v => !v.legacy && v.totalScheduled > 0 && v.mongoId), failed: false });
      })
      .catch(() => { if (active) setVersions({ list: [], failed: true }); });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber, request.n]);

  const [choice, setChoice] = useState({ section: '', professor: '', room: '' });
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = (message, tone = 'success') => {
    setToast({ message, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), tone === 'error' ? 8000 : 5000);
  };
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const chooseVersion = (id) => {
    setResult({ status: 'loading', data: null, error: null });
    setRequest(prev => ({ scheduleId: id || null, n: prev.n + 1 }));
  };
  const retry = () => {
    setResult({ status: 'loading', data: null, error: null });
    setRequest(prev => ({ ...prev, n: prev.n + 1 }));
  };
  // Phase 8 Part 8 (decision 6): live updates — a save that changes what prints (a class, a professor,
  // a version's status, the Output Settings), here or in another tab, reads the outputs again; what is
  // shown stays until the answer lands.
  useDataChanges(['schedule', 'assignments', 'faculty', 'sections', 'rooms', 'curriculum', 'outputSettings', 'outsideTeachers'], () => {
    setRequest(prev => ({ ...prev, n: prev.n + 1 }));
  });

  // ---------------------------------------------------------------- what can be printed
  const data = result.data;
  const schedule = data?.schedule || null;
  const settings = data?.settings || {};
  const listOf = (view) => (data ? printableEntities(data, view) : []);
  const sections = listOf('section');
  // Professors are told apart by id; two who share a name also show their codes.
  const nameCount = new Map();
  (data?.faculty || []).forEach(f => nameCount.set(f.name, (nameCount.get(f.name) || 0) + 1));
  const professors = listOf('professor');
  const professorLabel = (f) => (nameCount.get(f.name) > 1 && f.facultyId ? `${f.name} (${f.facultyId})` : f.name);
  const rooms = listOf('room');
  const tbaRooms = data ? tbaRoomsOf(data) : [];
  const chosen = (view, list) => list.find(e => entityKey(view, e) === choice[view]) || list[0] || null;
  const current = { section: chosen('section', sections), professor: chosen('professor', professors), room: chosen('room', rooms) };

  // Opens the print view of this version in a new tab.
  const openPrint = (output, target) => {
    const address = printAddress({ output, scheduleId: schedule.id, academicYear: schedule.academicYear, semester: schedule.semester, ...target });
    const tab = window.open(address, '_blank');
    if (!tab) showToast('The browser blocked the new tab. Allow pop-ups for this site, then press Print again.', 'error');
  };

  // Downloads the classes of one section, professor or room (or all, or the TBA rooms) as CSV.
  const downloadCsv = (view, scope) => {
    const meta = Object.values(PRINT_OUTPUTS).find(o => o.view === view);
    const entity = current[view];
    const key = scope === 'one' && entity ? entityKey(view, entity) : null;
    const rows = csvClasses(data, view, scope, key);
    const scopeName = scope === 'one' ? entityName(view, entity) : scope === 'tba' ? 'TBA rooms to request' : `All ${meta.nounPlural}`;
    const fileName = csvFileName([meta.name, scopeName, termFileText(schedule), `${schedule.version} ${schedule.status}`]);
    downloadScheduleCsv(fileName, rows);
    showToast(`Downloaded "${fileName}" (${countText(rows.length)}).`);
  };

  // ---------------------------------------------------------------- the cards' actions
  const noneReason = (noun) => `No ${noun} has a class in this version, so there is nothing to print.`;
  const oneBlocked = (view, noun) => (!current[view] ? noneReason(noun) : '');
  const csvOneBlocked = (view, noun) => (!current[view] ? noneReason(noun)
    : !(current[view].classCount > 0) ? `No class in this ${noun}: there is nothing to download.` : '');
  const tbaBlocked = tbaRooms.length ? '' : 'Every class that needs a room has a CCS room: there is no TBA room to request.';
  const tbaHeader = data ? tbaRequestHeader(data.tbaRequest) : null;
  const layout = settings.teachersProgram?.layout;

  const entitySelect = (view, label, list, optionLabel, groups = null) => {
    const id = `print-${view}-select`;
    const value = current[view] ? entityKey(view, current[view]) : '';
    const option = (e) => <option key={entityKey(view, e)} value={entityKey(view, e)}>{optionLabel(e)}</option>;
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">{label}</label>
        <Select
          id={id}
          data-testid={id}
          value={value}
          onChange={e => setChoice(prev => ({ ...prev, [view]: e.target.value }))}
          disabled={!list.length}
          className={selectClass}
        >
          {!list.length && <option value="">None with classes</option>}
          {groups
            ? groups.map(g => {
              const members = list.filter(e => e.kind === g.kind);
              return members.length ? <optgroup key={g.kind} label={g.label}>{members.map(option)}</optgroup> : null;
            })
            : list.map(option)}
        </Select>
      </div>
    );
  };

  // ---------------------------------------------------------------- version selector
  const versionOptions = versions.list.map(v => ({ value: String(v.mongoId), label: `${versionName(v.id)} · ${v.workflowStatus || v.status} · ${v.date}` }));
  const selectedVersion = schedule ? String(schedule.id) : (request.scheduleId ? String(request.scheduleId) : '');
  if (schedule && !versionOptions.some(o => o.value === selectedVersion)) {
    versionOptions.unshift({ value: selectedVersion, label: `${versionName(schedule.version)} · ${schedule.status}` });
  } else if (!schedule && !versionOptions.some(o => o.value === selectedVersion)) {
    versionOptions.unshift({ value: selectedVersion, label: selectedVersion ? 'The version asked for' : 'The official version' });
  }

  const smallButton = 'shrink-0 inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2';

  return (
    <div className="animate-in fade-in duration-300 relative space-y-6">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="print-outputs" />
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {/* VERSION */}
        <div className="px-6 md:px-8 py-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="po-version" className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">Version</label>
            <Select
              id="po-version"
              data-testid="po-version"
              value={selectedVersion}
              onChange={(e) => chooseVersion(e.target.value)}
              disabled={result.status === 'loading'}
              title={result.status === 'loading' ? 'Wait until the version is loaded.' : undefined}
              className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white max-w-full disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:border-orange-500 focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {versionOptions.map(o => <option key={o.value || 'official'} value={o.value}>{o.label}</option>)}
            </Select>
            {schedule && (
              <span data-testid="po-version-status" className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold border ${STATUS_BADGE[schedule.status] || OTHER_BADGE}`}>
                {schedule.status}: {schedule.isOfficial ? 'prints as the official schedule' : 'prints for checking only'}
              </span>
            )}
            {versions.failed && (
              <span data-testid="po-versions-error" className="text-xs text-amber-800 dark:text-amber-300">
                The other versions of this term could not be listed; open this page again to try again.
              </span>
            )}
          </div>
          {schedule?.fallback && (
            <p data-testid="po-fallback-note" className="flex items-start gap-1.5 text-xs text-slate-800 dark:text-slate-200">
              <Info size={14} className="mt-px shrink-0" aria-hidden="true" />
              No version of this term is Approved yet, so the newest Draft is shown.
            </p>
          )}
          {schedule && !schedule.isOfficial && (
            <p data-testid="po-draft-note" className="flex items-start gap-1.5 p-3 rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-xs font-bold text-amber-900 dark:text-amber-200">
              <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              {notApprovedText(schedule.status)}: it prints for checking only, and every page is marked DRAFT – NOT APPROVED. The official copy prints from an approved version (see the Approval page).
            </p>
          )}
          {schedule && (
            <p className="text-[11px] text-slate-600 dark:text-slate-400">
              &ldquo;Print&rdquo; opens the forms in a new tab, one per A4 page; press &ldquo;Print / Save as PDF&rdquo; there. &ldquo;CSV&rdquo; downloads the same classes as a spreadsheet file.
            </p>
          )}
        </div>

        {/* THE OUTPUTS */}
        <div className="p-6 md:p-8 bg-slate-50/50 dark:bg-[#09090b]">
          {result.status === 'loading' ? (
            <div data-testid="po-loading" role="status" className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-300 gap-3">
              <Loader2 size={36} className="animate-spin text-orange-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the schedule…</p>
            </div>
          ) : result.status === 'empty' ? (
            <div data-testid="po-empty" className="p-12 text-center max-w-md mx-auto">
              <Printer size={40} className="text-slate-400 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Nothing to print yet</h3>
              <p data-testid="po-empty-message" className="text-sm text-slate-700 dark:text-slate-300 mb-4">{result.error.message}</p>
              {onNavigate && (
                <button type="button" data-testid="po-open-ga" onClick={() => onNavigate('generate')} className={`${smallButton} text-white bg-orange-700 hover:bg-orange-800 mx-auto`}>
                  <Play size={14} className="mr-1.5" aria-hidden="true" /> Open Generate Schedule
                </button>
              )}
            </div>
          ) : result.status === 'error' ? (
            <div data-testid="po-error" role="alert" className="p-12 text-center max-w-lg mx-auto">
              <AlertOctagon size={40} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The schedule can&apos;t be shown</h3>
              <p data-testid="po-error-message" className="text-sm text-slate-700 dark:text-slate-300 mb-4">{result.error.message}</p>
              {result.error.fix === 'official' ? (
                <button type="button" data-testid="po-show-official" onClick={() => chooseVersion(null)} className={`${smallButton} text-white bg-orange-700 hover:bg-orange-800 mx-auto`}>
                  Show this term&apos;s official version
                </button>
              ) : (
                <button type="button" data-testid="po-retry" onClick={retry} className={`${smallButton} text-white bg-orange-700 hover:bg-orange-800 mx-auto`}>
                  <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* MOTHER SCHEDULE */}
              <OutputCard testId="po-card-section" icon={Layers} title="Mother Schedule" purpose="Each section's weekly class schedule, one section per page.">
                {entitySelect('section', 'Section', sections, s => `${entityName('section', s)} (${countText(s.classCount)})`)}
                {settings.motherSchedule && (
                  <p data-testid="po-subject-list-setting" className="text-[11px] text-slate-600 dark:text-slate-400">
                    The subject list under the table is {settings.motherSchedule.showSubjectList ? 'on' : 'off'} (Output Settings).
                  </p>
                )}
                <ActionRow label="Print" icon={Printer} className={printButton} actions={[
                  { testId: 'print-section-one', label: 'Print this section', onClick: () => openPrint('mother-schedule', { id: entityKey('section', current.section) }), blocked: oneBlocked('section', 'section') },
                  { testId: 'print-section-all', label: `Print all sections (${sections.length})`, onClick: () => openPrint('mother-schedule', { all: true }), blocked: sections.length ? '' : noneReason('section') }
                ]} />
                <ActionRow label="CSV" icon={FileSpreadsheet} className={csvButton} actions={[
                  { testId: 'csv-section', label: 'CSV of this section', onClick: () => downloadCsv('section', 'one'), blocked: csvOneBlocked('section', 'section') },
                  { testId: 'csv-section-all', label: 'CSV of all sections', onClick: () => downloadCsv('section', 'all'), blocked: sections.length ? '' : noneReason('section') }
                ]} />
              </OutputCard>

              {/* TEACHERS' PROGRAM */}
              <OutputCard testId="po-card-professor" icon={User} title="Teachers' Program" purpose="Each professor's weekly program and load, one professor per page.">
                {entitySelect('professor', 'Professor', professors, f => `${professorLabel(f)} (${countText(f.classCount)})`)}
                {LAYOUT_WORDS[layout] && (
                  <div data-testid="po-tp-layout" className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>Prints as: <b className="text-slate-800 dark:text-slate-200">{LAYOUT_WORDS[layout]}</b> (Output Settings).</span>
                    {onNavigate && (
                      <button type="button" data-testid="po-open-settings" onClick={() => onNavigate('output-settings')} className="inline-flex items-center font-bold underline underline-offset-2 text-indigo-800 dark:text-indigo-300 hover:text-indigo-600 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                        <Settings2 size={12} className="mr-1" aria-hidden="true" /> Change it in Output Settings
                      </button>
                    )}
                  </div>
                )}
                <ActionRow label="Print" icon={Printer} className={printButton} actions={[
                  { testId: 'print-professor-one', label: 'Print this professor', onClick: () => openPrint('teachers-program', { id: entityKey('professor', current.professor) }), blocked: oneBlocked('professor', 'professor') },
                  { testId: 'print-professor-all', label: `Print all professors (${professors.length})`, onClick: () => openPrint('teachers-program', { all: true }), blocked: professors.length ? '' : noneReason('professor') }
                ]} />
                <ActionRow label="CSV" icon={FileSpreadsheet} className={csvButton} actions={[
                  { testId: 'csv-professor', label: 'CSV of this professor', onClick: () => downloadCsv('professor', 'one'), blocked: csvOneBlocked('professor', 'professor') },
                  { testId: 'csv-professor-all', label: 'CSV of all professors', onClick: () => downloadCsv('professor', 'all'), blocked: professors.length ? '' : noneReason('professor') }
                ]} />
              </OutputCard>

              {/* ROOM PROGRAM */}
              <OutputCard testId="po-card-room" icon={DoorOpen} title="Room Program" purpose="Each room's weekly schedule, one room per page, and the TBA rooms to request.">
                {entitySelect('room', 'Room', rooms, r => `${entityName('room', r)} (${countText(r.classCount)})`, ROOM_GROUPS)}
                <p data-testid="po-tba-summary" className="text-[11px] text-slate-700 dark:text-slate-300">
                  {tbaHeader || 'Every class that needs a room has a CCS room.'}
                </p>
                <ActionRow label="Print" icon={Printer} className={printButton} actions={[
                  { testId: 'print-room-one', label: 'Print this room', onClick: () => openPrint('room-program', { id: entityKey('room', current.room) }), blocked: oneBlocked('room', 'room') },
                  { testId: 'print-room-all', label: `Print all rooms (${rooms.length})`, onClick: () => openPrint('room-program', { all: true }), blocked: rooms.length ? '' : noneReason('room') },
                  { testId: 'print-room-tba', label: `Print all TBA rooms (${tbaRooms.length})`, onClick: () => openPrint('room-program', { tba: true }), blocked: tbaBlocked, title: 'The request list: one page per TBA room, to bring to another department.' }
                ]} />
                <ActionRow label="CSV" icon={FileSpreadsheet} className={csvButton} actions={[
                  { testId: 'csv-room', label: 'CSV of this room', onClick: () => downloadCsv('room', 'one'), blocked: csvOneBlocked('room', 'room') },
                  { testId: 'csv-room-all', label: 'CSV of all rooms', onClick: () => downloadCsv('room', 'all'), blocked: rooms.length ? '' : noneReason('room') },
                  { testId: 'csv-room-tba', label: 'CSV of the TBA rooms', onClick: () => downloadCsv('room', 'tba'), blocked: tbaBlocked }
                ]} />
              </OutputCard>

              {/* THE OFFICE'S EXPORTS (Phase 8 Part 2): Word or PDF files, the office's own layouts. */}
              <ExportCard
                data={{
                  policy: data.policy,
                  exportEntities: {
                    section: sections.map(s => ({ key: entityKey('section', s), label: entityName('section', s) })),
                    professor: professors.map(f => ({ key: entityKey('professor', f), label: professorLabel(f) })),
                    room: rooms.map(r => ({ key: entityKey('room', r), label: entityName('room', r) }))
                  }
                }}
                schedule={schedule}
                versionWord={`${versionName(schedule.version)} · ${schedule.status}`}
              />
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${toast.tone === 'error' ? 'bg-red-500/20 text-red-300 dark:text-red-700' : 'bg-orange-500/20 text-orange-300 dark:text-orange-700'}`}>
            {toast.tone === 'error' ? <AlertOctagon size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
          </div>
          <span data-testid="po-toast" data-tone={toast.tone} className="text-xs font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-2 text-slate-300 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
