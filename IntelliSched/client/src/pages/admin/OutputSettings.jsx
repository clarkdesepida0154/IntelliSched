import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, AlertOctagon, Building2, CheckCircle2, DoorOpen, Layers, Loader2, Lock, MonitorSmartphone, Plus, RefreshCw,
  Save, Trash2, Undo2, User, UserPlus, X
} from 'lucide-react';
import api from '../../services/api';
import usePermission from '../../hooks/usePermission';
import PageHeader from '../../components/layout/PageHeader';
import Select from '../../components/ui/Select';

// Output Settings (Phase 3 Step 3): what the printed outputs carry besides the schedule itself: the
// campus code shown after room names, the college's name, and for each output its title, form code,
// revision, date and signatory lines, plus the Teachers' Program's rooms and print layout and the
// Mother Schedule's subject list. One stored document (GET / PUT /api/output-settings); until the
// Dean saves, the outputs use the gateway's defaults, which this page then shows. The gateway checks
// every value and names each problem by field; it is shown next to that field, and what was typed
// stays. Who may change the settings is the permission map's settings.edit (Phase 3 Step 6; the gateway
// checks the same action); anyone else sees them read-only, with the map's reason. The Teachers'
// Program's automatic line (filled in with each professor's name and position) can be removed like any
// line, and put back while there is none ("Add the professor's signature line", as the defaults have
// it: GET /output-settings/defaults). Phase 7: "Show evaluation ratings on screen" (presentation mode,
// on by default; off, the gateway hides every rating before an answer leaves).

const AUTO_PROFESSOR = 'professor';

// The three outputs, in the order of the page.
const OUTPUTS = [
  { key: 'teachersProgram', name: "Teachers' Program", icon: User, purpose: 'One page per professor, as the SF-029 form or a table.' },
  { key: 'motherSchedule', name: 'Mother Schedule', icon: Layers, purpose: "Each section's weekly class schedule, one section per page." },
  { key: 'roomProgram', name: 'Room Program', icon: DoorOpen, purpose: "Each room's weekly schedule, one per page." }
];
const LAYOUTS = [
  { value: 'SF029', label: 'SF-029 form' },
  { value: 'TABLE', label: 'Class schedule table' }
];

const text = (value) => (typeof value === 'string' ? value : '');
const linesOf = (lines) => (Array.isArray(lines) ? lines : [])
  .map(l => ({ label: text(l?.label), name: text(l?.name), title: text(l?.title), auto: text(l?.auto) }));
const outputOf = (value) => (value && typeof value === 'object' ? value : {});
const formPart = (o) => ({ title: text(o.title), formCode: text(o.formCode), revision: text(o.revision), date: text(o.date), signatories: linesOf(o.signatories) });

// The settings the form edits (and saves): only the keys the gateway keeps. GET and PUT answer them
// at the top level, with persisted / updatedBy / updatedAt next to them.
const formOf = (body) => {
  const tp = outputOf(body?.teachersProgram);
  const ms = outputOf(body?.motherSchedule);
  return {
    campusCode: text(body?.campusCode),
    collegeName: text(body?.collegeName),
    teachersProgram: { ...formPart(tp), showRooms: tp.showRooms === true, layout: text(tp.layout) },
    motherSchedule: { ...formPart(ms), showSubjectList: ms.showSubjectList === true },
    roomProgram: formPart(outputOf(body?.roomProgram)),
    // Phase 7: on unless the stored setting says off (an older gateway's answer has none).
    showEvaluationRatings: body?.showEvaluationRatings !== false
  };
};
const metaOf = (body) => ({ persisted: body?.persisted === true, updatedBy: body?.updatedBy || null, updatedAt: body?.updatedAt || null });

const clone = (value) => JSON.parse(JSON.stringify(value));
const setPath = (obj, path, value) => {
  const next = clone(obj);
  const keys = path.split('.');
  let cursor = next;
  keys.slice(0, -1).forEach(key => { cursor = cursor[key]; });
  cursor[keys[keys.length - 1]] = value;
  return next;
};
// "teachersProgram.signatories[0].label" and "teachersProgram.signatories.0.label" name the same field.
const fieldPath = (field) => String(field || '').replace(/\[(\d+)\]/g, '.$1');

// Every field path this form shows an error for; any other error is listed at the top.
const shownPaths = (form) => {
  const paths = ['campusCode', 'collegeName', 'showEvaluationRatings'];
  OUTPUTS.forEach(({ key }) => {
    paths.push(`${key}.title`, `${key}.formCode`, `${key}.revision`, `${key}.date`, `${key}.signatories`);
    if (key === 'teachersProgram') paths.push('teachersProgram.showRooms', 'teachersProgram.layout');
    if (key === 'motherSchedule') paths.push('motherSchedule.showSubjectList');
    form[key].signatories.forEach((_, i) => ['', '.label', '.name', '.title', '.auto'].forEach(part => paths.push(`${key}.signatories.${i}${part}`)));
  });
  return new Set(paths);
};

// data-testid of a field: os-all-<field> for the settings of all outputs, os-<output>-<field>, and
// os-<output>-sig-<field>-<i> for a signatory line.
const testIdOf = (path) => {
  const [first, ...rest] = path.split('.');
  if (!rest.length) return `os-all-${first}`;
  if (rest[0] === 'signatories' && rest.length === 3) return `os-${first}-sig-${rest[2]}-${rest[1]}`;
  return `os-${first}-${rest.join('-')}`;
};

const inputClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus:border-purple-500 text-slate-900 dark:text-white disabled:opacity-70 disabled:cursor-not-allowed font-bold aria-[invalid=true]:border-red-500';
const checkClass = 'w-4 h-4 shrink-0 rounded border-slate-300 text-purple-600 focus-visible:ring-2 focus-visible:ring-purple-500';
const addButtonClass = 'inline-flex items-center px-3 py-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500';

function FieldError({ id, error }) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} data-testid={`${id}-error`} role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
      <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {error}
    </p>
  );
}

// One labelled text field: label (required ones marked), input, one-line help, its error.
function TextField({ path, label, help, required = false, value, error, onChange }) {
  const id = testIdOf(path);
  const describedBy = [help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
        {label}{required && <span className="text-red-700 dark:text-red-400" aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        data-testid={id}
        type="text"
        value={value}
        onChange={e => onChange(path, e.target.value)}
        required={required}
        aria-required={required || undefined}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={inputClass}
      />
      {help && <p id={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">{help}</p>}
      <FieldError id={id} error={error} />
    </div>
  );
}

function Card({ icon: Icon, title, purpose, testId, children }) {
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-title`} className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm p-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="p-2 bg-purple-500/10 rounded-xl"><Icon size={18} className="text-purple-600 dark:text-purple-400" aria-hidden="true" /></div>
        <div>
          <h3 id={`${testId}-title`} className="text-base font-black text-slate-900 dark:text-white">{title}</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{purpose}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function OutputSettings() {
  const permission = usePermission('settings.edit');
  const canEdit = permission.allowed;

  const [load, setLoad] = useState({ status: 'loading', error: '' });
  const [loadNonce, setLoadNonce] = useState(0);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [meta, setMeta] = useState({ persisted: false, updatedBy: null, updatedAt: null });
  const [fieldErrors, setFieldErrors] = useState({});
  const [banner, setBanner] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [focusErrors, setFocusErrors] = useState(0);
  // "Add the professor's signature line": the defaults being read, or why they could not be.
  const [professorLine, setProfessorLine] = useState({ loading: false, error: '' });
  const [focusProfessor, setFocusProfessor] = useState(0);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    let active = true;
    api.get('/output-settings')
      .then(res => {
        if (!active) return;
        const form = formOf(res.data);
        setSaved(form);
        setDraft(form);
        setMeta(metaOf(res.data));
        setFieldErrors({});
        setLoad({ status: 'ready', error: '' });
      })
      .catch(err => {
        if (!active) return;
        setLoad({ status: 'error', error: `The Output Settings could not be loaded (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".` });
      });
    return () => { active = false; };
  }, [loadNonce]);

  const showToast = useCallback((message, extra = {}) => {
    const entry = { message, tone: 'success', ...extra };
    setToast(entry);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(current => (current === entry ? null : current)), entry.undo ? 10000 : 5000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // After a refused save, the first field with a problem gets the focus.
  useEffect(() => {
    if (!focusErrors) return;
    document.querySelector('[data-testid^="os-"][aria-invalid="true"]')?.focus();
  }, [focusErrors]);

  // Once the professor's line is back, its label field gets the focus (the button that added it is gone).
  useEffect(() => {
    if (!focusProfessor) return;
    document.querySelector('[data-testid^="os-teachersProgram-sig-auto-"]')?.closest('fieldset')?.querySelector('input')?.focus();
  }, [focusProfessor]);

  const retryLoad = () => {
    setLoad({ status: 'loading', error: '' });
    setLoadNonce(n => n + 1);
  };

  const isDirty = Boolean(draft && saved) && JSON.stringify(draft) !== JSON.stringify(saved);
  const errorFor = (path) => fieldErrors[path] || '';
  const clearErrors = (match) => setFieldErrors(prev => {
    const keys = Object.keys(prev).filter(match);
    if (!keys.length) return prev;
    const next = { ...prev };
    keys.forEach(k => delete next[k]);
    return next;
  });

  const update = (path, value) => {
    setDraft(prev => setPath(prev, path, value));
    clearErrors(k => k === path);
  };
  // Adding or removing a line renumbers the lines after it, so their errors no longer apply.
  const setLines = (key, lines) => {
    setDraft(prev => setPath(prev, `${key}.signatories`, lines));
    clearErrors(k => k.startsWith(`${key}.signatories`));
  };
  const addLine = (key) => setLines(key, [...draft[key].signatories, { label: '', name: '', title: '', auto: '' }]);
  // Nothing is saved until "Save settings"; the message offers to put the line back where it was.
  const removeLine = (key, index) => {
    const line = draft[key].signatories[index];
    setLines(key, draft[key].signatories.filter((_, i) => i !== index));
    // An earlier failure to put the professor's line back no longer applies.
    if (line.auto === AUTO_PROFESSOR) setProfessorLine(prev => (prev.error ? { ...prev, error: '' } : prev));
    const output = OUTPUTS.find(o => o.key === key).name;
    showToast(`Line ${index + 1}${line.label ? ` ("${line.label}")` : ''} removed from the ${output}. Nothing is saved until you press "Save settings".`, {
      undo: () => {
        setDraft(prev => {
          const lines = prev[key].signatories;
          return setPath(prev, `${key}.signatories`, [...lines.slice(0, index), line, ...lines.slice(index)]);
        });
        clearErrors(k => k.startsWith(`${key}.signatories`));
      }
    });
  };

  // "Add the professor's signature line" (only while the Teachers' Program has none: one line at most
  // is filled in with the professor's name): the automatic line as the defaults have it, back at its
  // place among the lines. Nothing is saved until "Save settings".
  const addProfessorLine = async () => {
    if (professorLine.loading) return;
    setProfessorLine({ loading: true, error: '' });
    try {
      const res = await api.get('/output-settings/defaults');
      const defaults = linesOf(res.data?.teachersProgram?.signatories);
      const index = defaults.findIndex(l => l.auto === AUTO_PROFESSOR);
      if (index < 0) throw new Error("the defaults have no professor's line");
      const line = { ...defaults[index], name: '', title: '' };
      setDraft(prev => {
        const lines = prev.teachersProgram.signatories;
        if (lines.some(l => l.auto === AUTO_PROFESSOR)) return prev;
        const at = Math.min(index, lines.length);
        return setPath(prev, 'teachersProgram.signatories', [...lines.slice(0, at), line, ...lines.slice(at)]);
      });
      clearErrors(k => k.startsWith('teachersProgram.signatories'));
      setProfessorLine({ loading: false, error: '' });
      setFocusProfessor(n => n + 1);
      showToast(`"${line.label}" is back in the Teachers' Program, filled in with the professor's name and position. Nothing is saved until you press "Save settings".`);
    } catch (err) {
      setProfessorLine({
        loading: false,
        error: `The professor's line could not be loaded (${err.response?.data?.message || err.message}). Nothing was changed. Check that the gateway is running, then press "Add the professor's signature line" again.`
      });
    }
  };

  const discard = () => {
    const before = draft;
    setDraft(saved);
    setFieldErrors({});
    setBanner('');
    setProfessorLine(prev => (prev.error ? { ...prev, error: '' } : prev));
    showToast('Your changes were discarded.', { undo: () => setDraft(before) });
  };

  // PUT /api/output-settings. A refused save keeps what was typed and marks each field with a problem.
  const handleSave = async (e) => {
    e.preventDefault();
    if (!canEdit || !isDirty || isSaving || professorLine.loading) return;
    setIsSaving(true);
    setBanner('');
    try {
      const res = await api.put('/output-settings', draft);
      const next = formOf(res.data);
      setSaved(next);
      setDraft(next);
      setMeta(metaOf(res.data));
      setFieldErrors({});
      showToast('Output Settings saved. Every print from now on uses them.');
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 400 && Array.isArray(data?.errors) && data.errors.length) {
        setFieldErrors(Object.fromEntries(data.errors.map(e2 => [fieldPath(e2.field), e2.message])));
        setBanner(`${data.message || 'The Output Settings were not saved.'} Each problem is shown next to its field.`);
        setFocusErrors(n => n + 1);
      } else if (err.response?.status === 403) {
        setBanner(`${data?.message || permission.reason || 'Your role cannot change the Output Settings.'} Nothing was saved.`);
      } else {
        setBanner(`The Output Settings could not be saved (${data?.message || err.message}). Your changes are still on the page; check that the gateway is running, then press "Save settings" again.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const locked = !canEdit || isSaving;
  const saveBlockedReason = !canEdit ? permission.reason
    : isSaving ? 'Saving…'
      : professorLine.loading ? "Wait until the professor's line is added."
        : !isDirty ? 'No changes to save.' : '';
  const status = meta.persisted
    ? `Last saved by ${meta.updatedBy || 'an unknown user'}${meta.updatedAt ? ` on ${new Date(meta.updatedAt).toLocaleString()}` : ''}.`
    : 'Not saved yet: the outputs print with these default settings.';

  // The page's heading (its name, purpose and the current term) shows in every state: while the
  // settings load, when they could not be loaded, and once they are here. It stays the first element of
  // the same form in all three, so the keyboard focus the dashboard puts on it after a link survives the
  // load. The status line and the Save controls come with the settings.
  const header = (
    <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg">
      <div className="p-6 md:p-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
        <PageHeader
          pageKey="output-settings"
          titleAddon={isDirty && (
            <span data-testid="os-dirty" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-500/10 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">Unsaved changes</span>
          )}
        >
          {draft && <p data-testid="os-status" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{status}</p>}
        </PageHeader>
        {draft && (
          <div className="flex flex-col items-start lg:items-end gap-1.5 w-full lg:w-auto">
            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="os-discard"
                onClick={discard}
                disabled={!isDirty || locked || professorLine.loading}
                title={!canEdit ? saveBlockedReason : isSaving ? 'Saving…' : professorLine.loading ? "Wait until the professor's line is added." : !isDirty ? 'No changes to discard.' : undefined}
                aria-describedby={!canEdit ? 'os-save-reason' : undefined}
                className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-purple-500"
              >
                <Undo2 size={16} className="mr-2" aria-hidden="true" /> Discard changes
              </button>
              <button
                type="submit"
                data-testid="os-submit"
                disabled={Boolean(saveBlockedReason)}
                aria-describedby="os-save-reason"
                className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-bold whitespace-nowrap flex items-center shadow-lg shadow-purple-900/20 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500"
              >
                {isSaving ? <Loader2 size={16} className="mr-2 animate-spin" aria-hidden="true" /> : <Save size={16} className="mr-2" aria-hidden="true" />}
                {isSaving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
            <p id="os-save-reason" data-testid="os-save-reason" className="text-[11px] text-slate-600 dark:text-slate-400 min-h-4">{saveBlockedReason}</p>
          </div>
        )}
      </div>
      <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400 rounded-b-3xl"></div>
    </div>
  );

  if (!draft) {
    return (
      <div className="animate-in fade-in duration-300 relative space-y-6">
        <form onSubmit={handleSave} noValidate className="space-y-6">
          {header}
          {load.status === 'loading' ? (
            <div data-testid="os-loading" role="status" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-16 flex flex-col items-center gap-3 text-slate-600 dark:text-slate-300">
              <Loader2 size={36} className="animate-spin text-purple-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the Output Settings…</p>
            </div>
          ) : (
            <div data-testid="os-load-error" role="alert" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-12 text-center max-w-lg mx-auto">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The Output Settings could not be loaded</h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mb-4">{load.error}</p>
              <button type="button" data-testid="os-retry" onClick={retryLoad} className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500">
                <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
              </button>
            </div>
          )}
        </form>
      </div>
    );
  }

  const known = shownPaths(draft);
  const otherErrors = Object.entries(fieldErrors).filter(([path]) => !known.has(path));

  const field = (path, label, help, required = false) => (
    <TextField path={path} label={label} help={help} required={required} value={path.split('.').reduce((o, k) => o?.[k], draft) ?? ''} error={errorFor(path)} onChange={update} />
  );

  const checkbox = (path, label, help) => {
    const id = testIdOf(path);
    const error = errorFor(path);
    return (
      <div className="sm:col-span-2 xl:col-span-4">
        <label className="inline-flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            id={id}
            data-testid={id}
            className={checkClass}
            checked={Boolean(path.split('.').reduce((o, k) => o?.[k], draft))}
            onChange={e => update(path, e.target.checked)}
            aria-invalid={Boolean(error)}
            aria-describedby={[`${id}-help`, error ? `${id}-error` : ''].filter(Boolean).join(' ')}
          />
          <span className="text-xs font-bold text-slate-800 dark:text-slate-200">{label}</span>
        </label>
        <p id={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 ml-6.5 leading-snug">{help}</p>
        <FieldError id={id} error={error} />
      </div>
    );
  };

  const signatoryLines = (key) => {
    const lines = draft[key].signatories;
    const listPath = `${key}.signatories`;
    const listError = errorFor(listPath);
    // Only the Teachers' Program has the professor's line; it is offered back while there is none.
    const offerProfessorLine = key === 'teachersProgram' && !lines.some(l => l.auto === AUTO_PROFESSOR);
    return (
      <fieldset className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 min-w-0" aria-describedby={`os-${key}-sig-help`}>
        <legend className="text-xs font-black text-slate-800 dark:text-slate-100 uppercase tracking-wider">Signatory lines</legend>
        <p id={`os-${key}-sig-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 mb-3 leading-snug">
          An empty name prints as a blank line to sign on.
          {lines.length === 0 && ' None yet: this output prints no signatory lines.'}
        </p>
        <div className="space-y-3">
          {lines.map((line, i) => {
            const at = `${listPath}.${i}`;
            const rowErrors = [errorFor(at), errorFor(`${at}.auto`)].filter(Boolean);
            const isAuto = line.auto === AUTO_PROFESSOR;
            return (
              <fieldset key={i} data-testid={`os-${key}-sig-row-${i}`} className="p-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-white/[0.02] min-w-0">
                <legend className="px-1 text-[11px] font-bold text-slate-700 dark:text-slate-300">Line {i + 1}</legend>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_auto] gap-3 items-start">
                  <TextField path={`${at}.label`} label="Label" required value={line.label} error={errorFor(`${at}.label`)} onChange={update} />
                  {isAuto ? (
                    <p data-testid={`os-${key}-sig-auto-${i}`} className="md:col-span-2 md:mt-6 p-2.5 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-700 dark:text-slate-300">
                      Filled in with the professor&apos;s name and position
                    </p>
                  ) : (
                    <>
                      <TextField path={`${at}.name`} label="Name" value={line.name} error={errorFor(`${at}.name`)} onChange={update} />
                      <TextField path={`${at}.title`} label="Title" value={line.title} error={errorFor(`${at}.title`)} onChange={update} />
                    </>
                  )}
                  <button
                    type="button"
                    data-testid={`os-${key}-sig-remove-${i}`}
                    onClick={() => removeLine(key, i)}
                    aria-label={`Remove line ${i + 1}${line.label ? ` (${line.label})` : ''}`}
                    title={locked ? undefined : `Remove line ${i + 1}`}
                    className="md:mt-6 p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
                {rowErrors.map(message => (
                  <p key={message} data-testid={`os-${key}-sig-row-${i}-error`} role="alert" className="mt-2 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
                    <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {message}
                  </p>
                ))}
              </fieldset>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={`os-${key}-sig-add`}
            onClick={() => addLine(key)}
            className={addButtonClass}
          >
            <Plus size={14} className="mr-1.5" aria-hidden="true" /> Add a signatory line
          </button>
          {offerProfessorLine && (
            <button
              type="button"
              data-testid="os-teachersProgram-sig-add-professor"
              onClick={addProfessorLine}
              aria-disabled={professorLine.loading || undefined}
              aria-describedby="os-teachersProgram-sig-professor-help"
              className={`${addButtonClass} aria-disabled:opacity-60 aria-disabled:cursor-wait`}
            >
              {professorLine.loading
                ? <><Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> Adding the professor&apos;s line…</>
                : <><UserPlus size={14} className="mr-1.5" aria-hidden="true" /> Add the professor&apos;s signature line</>}
            </button>
          )}
        </div>
        {offerProfessorLine && (
          <p id="os-teachersProgram-sig-professor-help" data-testid="os-teachersProgram-sig-professor-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1.5 leading-snug">
            No line is filled in with each professor&apos;s name and position now, so the Teachers&apos; Program prints without it. &ldquo;Add the professor&apos;s signature line&rdquo; puts it back.
          </p>
        )}
        {offerProfessorLine && professorLine.error && (
          <p data-testid="os-teachersProgram-sig-professor-error" role="alert" className="mt-2 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
            <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {professorLine.error}
          </p>
        )}
        {listError && (
          <p data-testid={`os-${key}-sig-error`} role="alert" className="mt-2 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
            <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {listError}
          </p>
        )}
      </fieldset>
    );
  };

  const layoutId = testIdOf('teachersProgram.layout');
  const layoutError = errorFor('teachersProgram.layout');
  const layoutKnown = LAYOUTS.some(l => l.value === draft.teachersProgram.layout);

  return (
    <div className="animate-in fade-in duration-300 relative space-y-6">
      <form onSubmit={handleSave} noValidate className="space-y-6">
        {header}

        {!canEdit && !permission.loading && (
          <div data-testid="os-readonly-note" className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
            <Lock size={14} className="shrink-0" aria-hidden="true" /> You can view these settings. {permission.reason}
          </div>
        )}
        {banner && (
          <div role="alert" data-testid="os-error" className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-xs font-bold text-red-800 dark:text-red-400">
            <p className="flex items-start gap-2"><AlertCircle size={16} className="shrink-0" aria-hidden="true" /> {banner}</p>
            {otherErrors.length > 0 && (
              <ul data-testid="os-other-errors" className="mt-2 ml-6 list-disc space-y-0.5">
                {otherErrors.map(([path, message]) => <li key={path}>{message}</li>)}
              </ul>
            )}
          </div>
        )}
        <p className="text-[11px] text-slate-600 dark:text-slate-400">Fields marked <span className="text-red-700 dark:text-red-400" aria-hidden="true">*</span><span className="sr-only">with a star</span> are required.</p>

        <fieldset disabled={locked} className="space-y-6 min-w-0">
          <Card icon={Building2} title="All outputs" purpose="Shown on every printed output." testId="os-card-all">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
              {field('campusCode', 'Campus code', 'Shown after every room name, e.g. "ROOM 47 (LBC)".')}
              {field('collegeName', 'College name', 'Printed at the top of every output.', true)}
            </div>
          </Card>

          <Card icon={MonitorSmartphone} title="On screen" purpose="What the pages show, for example on a projector." testId="os-card-screen">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
              {checkbox('showEvaluationRatings', 'Show evaluation ratings on screen', 'Turn it off for a presentation. Rankings do not change.')}
            </div>
          </Card>

          {OUTPUTS.map(({ key, name, icon, purpose }) => (
            <Card key={key} icon={icon} title={name} purpose={purpose} testId={`os-card-${key}`}>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-5 gap-y-4">
                {field(`${key}.title`, 'Title', 'Printed as the title of the form.', true)}
                {field(`${key}.formCode`, 'Form code', key === 'teachersProgram' ? 'Printed bottom left.' : 'Printed bottom left, only when set.')}
                {field(`${key}.revision`, 'Revision', key === 'teachersProgram' ? 'Printed at the bottom, in the middle.' : 'Printed at the bottom, only when set.')}
                {field(`${key}.date`, 'Date', key === 'teachersProgram' ? 'The form’s date, printed bottom right.' : 'Printed bottom right, only when set.')}
                {key === 'teachersProgram' && (
                  <>
                    {checkbox('teachersProgram.showRooms', "Show rooms on the Teachers' Program", 'For the class schedule table layout. The SF-029 form always shows the room.')}
                    <div className="sm:col-span-2 min-w-0">
                      <label htmlFor={layoutId} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Print layout</label>
                      <Select
                        id={layoutId}
                        data-testid={layoutId}
                        value={draft.teachersProgram.layout}
                        onChange={e => update('teachersProgram.layout', e.target.value)}
                        aria-invalid={Boolean(layoutError)}
                        aria-describedby={[`${layoutId}-help`, layoutError ? `${layoutId}-error` : ''].filter(Boolean).join(' ')}
                        className={inputClass}
                      >
                        {!layoutKnown && <option value={draft.teachersProgram.layout}>Choose a layout</option>}
                        {LAYOUTS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </Select>
                      <p id={`${layoutId}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                        SF-029 form is the official form.
                      </p>
                      <FieldError id={layoutId} error={layoutError} />
                    </div>
                  </>
                )}
                {key === 'motherSchedule' && checkbox('motherSchedule.showSubjectList', 'Show the subject list under the table', "Units, hours and professors.")}
              </div>
              {signatoryLines(key)}
            </Card>
          ))}
        </fieldset>
      </form>

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md max-w-md">
          <div className="w-7 h-7 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-300 dark:text-purple-700 shrink-0"><CheckCircle2 size={16} aria-hidden="true" /></div>
          <span data-testid="os-toast" className="text-xs font-bold tracking-wide">{toast.message}</span>
          {toast.undo && (
            <button type="button" data-testid="os-undo" onClick={() => { const undo = toast.undo; setToast(null); undo(); }} className="ml-1 px-2.5 py-1 rounded-lg text-xs font-black text-purple-200 dark:text-purple-800 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500">
              Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss message" onClick={() => setToast(null)} className="ml-1 text-slate-300 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 rounded">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
