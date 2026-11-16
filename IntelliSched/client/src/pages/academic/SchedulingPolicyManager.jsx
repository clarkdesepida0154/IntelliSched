import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Save, RotateCcw, Loader2, CheckCircle2, X, AlertTriangle, AlertCircle, AlertOctagon,
  Lock, Plus, CalendarClock, CalendarRange, Utensils, Layers, DoorOpen, Scale, Zap
} from 'lucide-react';
import api from '../../services/api';
import usePolicy, { setPolicyCache } from '../../hooks/usePolicy';
import useEscapeKey from '../../hooks/useEscapeKey';
import usePermission from '../../hooks/usePermission';
import { whoMay } from '../../utils/permissionText';
import PageHeader from '../../components/layout/PageHeader';
import { WEEKDAY_NAMES, gridTimes, formatTime12, formatRange12 } from '../../utils/timeGrid';
import {
  SOFT_WEIGHTS, SOFT_WEIGHT_STATUS_LABELS, MAJOR_LECTURE_IN_LAB_OPTIONS, THREE_HOUR_PATTERNS,
  ANCILLARY_TYPE_LABELS, EMPLOYMENT_LABELS, idleTimeExplanation
} from '../../utils/policyLabels';
import TbaRoomsFields from '../../components/policy/TbaRoomsFields';
import ZeroWeightsNote from '../../components/policy/ZeroWeightsNote';
import PolicyRules from '../../components/policy/PolicyRules';
import AdvancedSection from '../../components/policy/AdvancedSection';
import { yearsWords } from '../../components/policy/policyWords';
import Select from '../../components/ui/Select';

// The Scheduling Policy page (Phase 3 Step 4: simple by default). The Dean sees the plain settings (the
// days, the hours, the lunch rule and Saturday on or off) and the read-only Rules (Constraint
// Configuration's hard-rule list, merged here). Everything else is "Advanced (system team)", collapsed at
// the bottom, which only advanced.edit opens (the Dean, the office's one account, since Phase 8
// Part 8); the gateway refuses any other role's change to it
// (PUT /api/policy answers 403 ADVANCED_ONLY). Who may save the plain settings and who may open
// Advanced is the permission map's (Phase 3 Step 6): settings.edit and advanced.edit, which the gateway
// checks on PUT /api/policy too.
// The plain settings: mirrors server/src/utils/policy.js PLAIN_POLICY_FIELDS, plus (Phase 4 Part 4,
// rooms the Dean's way) the TBA-room choice between "automatic" and "off" (overflowRooms.mode; the
// manual counts stay Advanced).
// Phase 8: the odd/even week groups are plain too (the office's practice when rooms are short).
// Phase 8 Part 4: so is the full-time faculty's day for Extension.
const PLAIN_FIELDS = ['weekdays', 'dayStart', 'dayEnd', 'lunch', 'saturdayOverflow.enabled', 'weekGroups', 'extensionDay', 'overflowRooms.mode', 'overflowRooms.enabled'];
const PLAIN_TBA_MODES = ['auto', 'off'];
const isPlainField = (path) => PLAIN_FIELDS.some(f => path === f || path.startsWith(`${f}.`));
// What a plain-settings save sends: only the plain settings (the gateway merges them into the stored
// policy), so it can never undo an Advanced change saved meanwhile under "Advanced (system team)".
// The TBA-room choice goes along only while it is automatic or off (a manual setting is Advanced's).
const plainPart = (settings) => ({
  weekdays: settings.weekdays,
  dayStart: settings.dayStart,
  dayEnd: settings.dayEnd,
  lunch: settings.lunch,
  saturdayOverflow: { enabled: settings.saturdayOverflow?.enabled },
  // Phase 8: the odd/even week groups (the switch and the editable table).
  ...(settings.weekGroups ? { weekGroups: settings.weekGroups } : {}),
  // Phase 8 Part 4: the full-time faculty's day for Extension ('none' or a weekday).
  ...(settings.extensionDay !== undefined ? { extensionDay: settings.extensionDay } : {}),
  // The counts go along unchanged (the gateway compares values, so they are never an Advanced change).
  ...(PLAIN_TBA_MODES.includes(settings.overflowRooms?.mode)
    ? { overflowRooms: { mode: settings.overflowRooms.mode, enabled: settings.overflowRooms.mode !== 'off', lab: settings.overflowRooms.lab ?? 0, lec: settings.overflowRooms.lec ?? 0 } }
    : {})
});
// The Advanced groups in plain words, for a refusal about a setting the page does not show.
const ADVANCED_GROUP_LABELS = {
  slotMinutes: 'Slot length',
  nstp: 'NSTP block',
  saturdayOverflow: 'Saturday window and years',
  meetings: 'Meetings',
  preferredEarliestStart: 'Preferred earliest start',
  rooms: 'Rooms',
  load: 'Load',
  catalog: 'Weekly hour limit per subject',
  softWeights: 'Penalty weights',
  overflowRooms: 'TBA rooms'
};
const groupLabelOf = (path) => ADVANCED_GROUP_LABELS[String(path).split('.')[0]] || String(path);
const ADVANCED_SUMMARY = 'NSTP and the Saturday window, meetings, rooms and TBA rooms, load, and the penalty weights.';
const YEAR_LEVELS = [1, 2, 3, 4];
const YEAR_LABELS = { 1: '1st year', 2: '2nd year', 3: '3rd year', 4: '4th year' };
// Phase 8: the odd/even week-group table's fixed rows (every program and year).
const WEEK_GROUP_ROWS = ['BSIT', 'BSCS'].flatMap(program => YEAR_LEVELS.map(yearLevel => ({ program, yearLevel })));
// Earliest and latest times offered in the time pickers (the policy itself decides the class day).
const PICKER_FROM = '05:00';
const PICKER_TO = '22:00';

const clone = (value) => JSON.parse(JSON.stringify(value));
const stripMeta = (policy) => {
  if (!policy) return null;
  const { persisted, updatedBy, updatedAt, ...settings } = policy;
  return clone(settings);
};
const getPath = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
const setPath = (obj, path, value) => {
  const next = clone(obj);
  const keys = path.split('.');
  let cursor = next;
  keys.slice(0, -1).forEach(key => { cursor = cursor[key]; });
  cursor[keys[keys.length - 1]] = value;
  return next;
};
const testId = (path) => `policy-${path.replace(/\./g, '-')}`;
const samePattern = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const inputClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus:border-purple-500 text-slate-900 dark:text-white disabled:opacity-60 font-bold';
const checkClass = 'w-4 h-4 shrink-0 rounded border-slate-300 text-purple-600 focus-visible:ring-2 focus-visible:ring-purple-500';

// One labelled setting: label, control, one-line explanation, and its error in plain words.
function Setting({ id, label, help, error, children, wide = false }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <label htmlFor={id} className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">{label}</label>
      {children}
      {help && <p id={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">{help}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
          <AlertCircle size={12} className="mt-px shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

// A group of checkboxes (days or year levels) behaving as one setting.
function CheckGroup({ path, label, help, error, options, value, onChange }) {
  const id = testId(path);
  return (
    <fieldset className="sm:col-span-2" aria-describedby={`${id}-help`}>
      <legend className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(opt => {
          const checked = (value || []).includes(opt.value);
          return (
            <label key={opt.value} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold cursor-pointer ${checked ? 'border-purple-300 bg-purple-50 text-purple-800 dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-200' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>
              <input
                type="checkbox"
                data-testid={`${id}-${opt.value}`}
                className={checkClass}
                checked={checked}
                onChange={e => onChange(e.target.checked ? [...(value || []), opt.value] : (value || []).filter(v => v !== opt.value))}
              />
              {opt.label}
            </label>
          );
        })}
      </div>
      {help && <p id={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">{help}</p>}
      {error && (
        <p role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
          <AlertCircle size={12} className="mt-px shrink-0" /> {error}
        </p>
      )}
    </fieldset>
  );
}

// A group of settings. `inset` is the lighter style used inside "Advanced (system team)".
function Section({ icon: Icon, title, purpose, children, inset = false, testid }) {
  return (
    <section data-testid={testid} className={inset
      ? 'bg-slate-50/70 dark:bg-white/[0.03] rounded-2xl border border-slate-200 dark:border-slate-800 p-5 min-w-0'
      : 'bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm p-6 min-w-0'}
    >
      <div className="flex items-start gap-3 mb-5">
        <div className="p-2 bg-purple-500/10 rounded-xl"><Icon size={18} className="text-purple-600 dark:text-purple-400" aria-hidden="true" /></div>
        <div>
          <h3 className="text-base font-black text-slate-900 dark:text-white">{title}</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{purpose}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">{children}</div>
    </section>
  );
}

// `initialSection` (the shell passes the address's ?section=) = 'rules' opens the page at its Rules: the
// old Constraint Configuration address redirects here with it.
export default function SchedulingPolicyManager({ initialSection = null }) {
  const { policy, isLoading, error: loadError, reload } = usePolicy();
  // The plain settings (settings.edit) and "Advanced (system team)" (advanced.edit), from the map.
  const plainPermission = usePermission('settings.edit');
  const advancedPermission = usePermission('advanced.edit');
  const canEdit = plainPermission.allowed;
  const canEditAdvanced = advancedPermission.allowed;

  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [banner, setBanner] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const resetButtonRef = useRef(null);
  const rulesHeadingRef = useRef(null);

  // The form starts from the loaded policy and follows it until someone edits something.
  const savedSettings = useMemo(() => stripMeta(policy), [policy]);
  const isDirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
  useEffect(() => {
    if (!savedSettings || isDirty) return;
    // Adopting a newer server copy while the form is untouched (another tab or user saved).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(savedSettings);
    setSaved(savedSettings);
  }, [savedSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened at the Rules (from the old Constraint Configuration address): scroll there once the policy
  // is on screen, and put the keyboard focus on the Rules heading. Two frames later, so it comes after
  // the shell's own handling of a new page (it scrolls to the top, and may focus the page title).
  const wantsRules = initialSection === 'rules';
  const isReady = Boolean(draft);
  useEffect(() => {
    if (!wantsRules || !isReady) return undefined;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        const heading = rulesHeadingRef.current;
        if (!heading) return;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [wantsRules, isReady]);

  const showToast = useCallback((message, extra = {}) => {
    const entry = { message, ...extra };
    setToast(entry);
    setTimeout(() => setToast(current => (current === entry ? null : current)), extra.undo ? 10000 : 5000);
  }, []);

  const clearError = (path) => setFieldErrors(prev => {
    if (!prev[path]) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
  const update = (path, value) => {
    setDraft(prev => setPath(prev, path, value));
    clearError(path);
  };
  const errorFor = (path) => fieldErrors[path] ||
    Object.entries(fieldErrors).find(([field]) => field.startsWith(`${path}.`))?.[1] || '';

  // PUT /api/policy. A failed save keeps what was typed and marks each rejected setting; a rejected
  // setting the page does not show (an Advanced one, for a role without advanced.edit) is named in the
  // message instead. A problem the Dean's own change causes in an Advanced setting (a class day too
  // short for the lab start times) comes from the gateway at the plain setting that caused it, with the
  // way to fix it, so it is marked next to that field like any other.
  const persist = async (body, successMessage, extra = {}) => {
    setIsSaving(true);
    setBanner('');
    try {
      const res = await api.put('/policy', body);
      const next = stripMeta(res.data);
      setSaved(next);
      setDraft(next);
      setFieldErrors({});
      setPolicyCache(res.data);
      showToast(successMessage, extra);
      return true;
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 400 && Array.isArray(data?.errors)) {
        setFieldErrors(Object.fromEntries(data.errors.map(e => [e.field, e.message])));
        const advanced = data.errors.filter(e => !isPlainField(String(e.field)));
        if (canEditAdvanced && advanced.length) setIsAdvancedOpen(true);
        const hidden = canEditAdvanced ? [] : advanced;
        const shown = data.errors.length - hidden.length;
        setBanner([
          data.message,
          shown ? 'Each one is marked below.' : '',
          hidden.length ? `Only ${whoMay('advanced.edit')} can fix ${hidden.length === 1 ? 'this Advanced (system team) setting' : 'these Advanced (system team) settings'}: ${hidden.map(e => `${groupLabelOf(e.field)}: ${e.message}`).join(' ')}` : '',
          'Your changes are still on the page.'
        ].filter(Boolean).join(' '));
      } else if (err.response?.status === 403) {
        // The gateway's own words: ADVANCED_ONLY names the Advanced settings, NOT_ALLOWED the role.
        setBanner(data?.code === 'ADVANCED_ONLY'
          ? `${data.message} Nothing was saved; your changes are still on the page.`
          : `${data?.message || plainPermission.reason || 'Your role cannot change the Scheduling Policy.'} Nothing was saved.`);
      } else {
        setBanner(`The policy could not be saved (${data?.message || err.message}). Your changes are still on the page; try again.`);
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Save: a role with advanced.edit saves every setting; anyone else only the plain ones.
  const isPersisted = Boolean(policy?.persisted);
  const handleSave = (e) => {
    e.preventDefault();
    if (!canEdit || isSaving || !draft || (!isDirty && isPersisted)) return;
    persist(canEditAdvanced ? draft : plainPart(draft), 'Scheduling Policy saved.');
  };

  const closeReset = useCallback(() => {
    setIsResetOpen(false);
    resetButtonRef.current?.focus();
  }, []);
  useEscapeKey(isResetOpen, closeReset, isSaving);

  // Reset: a role with advanced.edit resets every setting; anyone else only the plain ones (the Advanced settings
  // are not theirs to change). Both save at once and offer Undo.
  const handleConfirmReset = async () => {
    const previous = saved;
    try {
      const res = await api.get('/policy/defaults');
      setIsResetOpen(false);
      if (canEditAdvanced) {
        await persist(res.data, 'Every setting was reset to the defaults and saved.', {
          undo: () => persist(previous, 'Reset undone: the previous settings are back.')
        });
      } else {
        await persist(plainPart(res.data), 'The days, hours, lunch rule, Saturday setting and odd/even weeks were reset to the defaults and saved.', {
          undo: () => persist(plainPart(previous), 'Reset undone: the previous settings are back.')
        });
      }
    } catch (err) {
      setIsResetOpen(false);
      setBanner(`The defaults could not be loaded (${err.response?.data?.message || err.message}). Nothing was changed.`);
    }
  };

  const timeOptions = useMemo(() => gridTimes(PICKER_FROM, PICKER_TO, draft?.slotMinutes || 30), [draft?.slotMinutes]);

  const saveBlockedReason = !draft
    ? (isLoading ? 'Loading the Scheduling Policy…' : 'The Scheduling Policy could not be loaded.')
    : !canEdit
      ? plainPermission.reason
      : isSaving ? 'Saving…' : !isDirty && isPersisted ? 'No changes to save.' : '';
  // A policy never saved: Save confirms the defaults (the Readiness Check asks for this).
  const saveHint = !saveBlockedReason && !isDirty && !isPersisted ? 'Not saved yet: press "Save policy" to confirm these settings.' : '';
  const status = !policy
    ? ''
    : policy.persisted
      ? `Last saved by ${policy.updatedBy || 'unknown'}${policy.updatedAt ? ` on ${new Date(policy.updatedAt).toLocaleString()}` : ''}.`
      : 'Not saved yet: the scheduler is using these default settings.';
  const resetTitle = !canEdit
    ? plainPermission.reason
    : canEditAdvanced ? 'Reset every setting to the defaults.' : 'Reset the days, hours, lunch rule, Saturday setting and odd/even weeks to the defaults.';

  const header = (
    <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg">
      <div className="p-6 md:p-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
        <PageHeader
          pageKey="policy"
          titleAddon={isDirty && (
            <span data-testid="policy-dirty" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">Unsaved changes</span>
          )}
        >
          {status && <p data-testid="policy-status" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{status}</p>}
        </PageHeader>
        <div className="flex flex-col items-start lg:items-end gap-1.5 w-full lg:w-auto">
          <div className="flex items-center gap-3">
            <button
              ref={resetButtonRef}
              type="button"
              data-testid="policy-reset"
              onClick={() => setIsResetOpen(true)}
              disabled={!canEdit || isSaving || !draft}
              title={resetTitle}
              aria-describedby={!canEdit ? 'policy-save-reason' : undefined}
              className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white flex items-center disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-purple-500"
            >
              <RotateCcw size={16} className="mr-2" aria-hidden="true" /> Reset to defaults
            </button>
            <button
              type="submit"
              data-testid="policy-submit"
              disabled={Boolean(saveBlockedReason)}
              aria-describedby="policy-save-reason"
              className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded-lg text-sm font-bold whitespace-nowrap flex items-center shadow-lg shadow-purple-900/20 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500"
            >
              {isSaving ? <Loader2 size={16} className="mr-2 animate-spin" aria-hidden="true" /> : <Save size={16} className="mr-2" aria-hidden="true" />}
              {isSaving ? 'Saving…' : 'Save policy'}
            </button>
          </div>
          <p id="policy-save-reason" data-testid="policy-save-reason" className="text-[11px] text-slate-600 dark:text-slate-400 min-h-4">{saveBlockedReason || saveHint}</p>
        </div>
      </div>
      <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400 rounded-b-3xl"></div>
    </div>
  );

  if (!draft) {
    return (
      <form data-testid="policy-page" onSubmit={handleSave} noValidate className="animate-in fade-in duration-300 relative space-y-6">
        {header}
        {isLoading ? (
          <div data-testid="policy-loading" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-16 flex flex-col items-center gap-3 text-slate-500 dark:text-slate-400">
            <Loader2 size={36} className="animate-spin text-purple-500" aria-hidden="true" />
            <p className="text-xs font-bold uppercase tracking-wider">Loading the Scheduling Policy…</p>
          </div>
        ) : (
          <div role="alert" data-testid="policy-load-error" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-12 text-center max-w-lg mx-auto">
            <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The Scheduling Policy could not be loaded</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mb-4">{loadError || 'No answer from the gateway.'}</p>
            <button type="button" onClick={reload} className="px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500">Retry</button>
          </div>
        )}
      </form>
    );
  }

  const timeSelect = (path, label, help) => {
    const value = getPath(draft, path);
    const options = timeOptions.includes(value) ? timeOptions : [value, ...timeOptions];
    return (
      <Setting id={testId(path)} label={label} help={help} error={errorFor(path)}>
        <Select
          id={testId(path)}
          data-testid={testId(path)}
          value={value}
          onChange={e => update(path, e.target.value)}
          aria-invalid={Boolean(errorFor(path))}
          aria-describedby={[`${testId(path)}-help`, errorFor(path) ? `${testId(path)}-error` : ''].filter(Boolean).join(' ')}
          className={inputClass}
        >
          {options.map(t => <option key={t} value={t}>{formatTime12(t)}</option>)}
        </Select>
      </Setting>
    );
  };

  const numberInput = (path, label, help, { step = 0.5, min = 0, max, suffix } = {}) => (
    <Setting id={testId(path)} label={`${label}${suffix ? ` (${suffix})` : ''}`} help={help} error={errorFor(path)}>
      <input
        id={testId(path)}
        data-testid={testId(path)}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={getPath(draft, path) ?? ''}
        onChange={e => update(path, e.target.value === '' ? null : Number(e.target.value))}
        aria-invalid={Boolean(errorFor(path))}
        aria-describedby={`${testId(path)}-help`}
        className={inputClass}
      />
    </Setting>
  );

  const toggle = (path, label, help) => (
    <div className="sm:col-span-2">
      <label className="inline-flex items-center gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          id={testId(path)}
          data-testid={testId(path)}
          className={checkClass}
          checked={Boolean(getPath(draft, path))}
          onChange={e => update(path, e.target.checked)}
          aria-describedby={`${testId(path)}-help`}
        />
        <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{label}</span>
      </label>
      <p id={`${testId(path)}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 ml-6.5 leading-snug">{help}</p>
      {errorFor(path) && <p role="alert" className="mt-1 ml-6.5 text-[11px] font-bold text-red-600 dark:text-red-400">{errorFor(path)}</p>}
    </div>
  );

  const patternSelect = (path, label, help) => {
    const value = getPath(draft, path) || [];
    const known = THREE_HOUR_PATTERNS.findIndex(p => samePattern(p.value, value));
    const options = known >= 0 ? THREE_HOUR_PATTERNS : [{ value, label: value.map(h => `${h} h`).join(' + ') }, ...THREE_HOUR_PATTERNS];
    const current = options.findIndex(p => samePattern(p.value, value));
    return (
      <Setting id={testId(path)} label={label} help={help} error={errorFor(path)}>
        <Select
          id={testId(path)}
          data-testid={testId(path)}
          value={current}
          onChange={e => update(path, clone(options[Number(e.target.value)].value))}
          aria-describedby={`${testId(path)}-help`}
          className={inputClass}
        >
          {options.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </Select>
      </Setting>
    );
  };

  const labStarts = draft.meetings.labStartTimes || [];
  const addableLabStarts = gridTimes(draft.dayStart, draft.dayEnd, draft.slotMinutes).filter(t => !labStarts.includes(t));
  const saturdayYears = draft.saturdayOverflow.yearLevels || [];

  return (
    <div data-testid="policy-page" className="animate-in fade-in duration-300 relative space-y-6">
      <form onSubmit={handleSave} noValidate className="space-y-6">
        {header}

        {!canEdit && !plainPermission.loading && (
          <div data-testid="policy-readonly-note" className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <Lock size={14} className="shrink-0" aria-hidden="true" /> You can view these settings. {plainPermission.reason}
          </div>
        )}
        {banner && (
          <div role="alert" data-testid="policy-error" className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" /> {banner}
          </div>
        )}

        {/* THE PLAIN SETTINGS (the Dean's) */}
        <fieldset data-testid="policy-plain" disabled={!canEdit || isSaving} className="grid grid-cols-1 xl:grid-cols-2 gap-6 min-w-0">
          <legend className="sr-only">Days, hours, lunch and Saturday</legend>
          <Section icon={CalendarClock} title="Days & hours" purpose="When classes may meet.">
            {timeSelect('dayStart', 'Class day starts', 'Earliest time a weekday class may start.')}
            {timeSelect('dayEnd', 'Class day ends', 'Latest time a weekday class may end.')}
            <CheckGroup
              path="weekdays"
              label="Weekdays with classes"
              help="Regular classes are placed on these days only."
              error={errorFor('weekdays')}
              options={WEEKDAY_NAMES.map(d => ({ value: d, label: d }))}
              value={draft.weekdays}
              onChange={v => update('weekdays', v)}
            />
            {toggle('saturdayOverflow.enabled', 'Allow Saturday classes when the week is full',
              saturdayYears.length
                ? `Only for ${yearsWords(saturdayYears)}, and only when their weekdays are full: each Saturday class adds a penalty, so weekdays are used first. NSTP always meets on ${draft.nstp.day}.`
                : `No year level may have Saturday classes yet (the years are an Advanced setting). NSTP always meets on ${draft.nstp.day}.`)}
            {/* Phase 8 Part 4 (decision 4): the office keeps Friday class-free for the full-timers'
                Extension duties; each professor can override it on the Faculty page. */}
            <Setting id={testId('extensionDay')} label="Full-time faculty's day for Extension" help="Class-free for every full-time professor. Each can have another day on the Faculty page." error={errorFor('extensionDay')}>
              <Select
                id={testId('extensionDay')}
                data-testid={testId('extensionDay')}
                value={draft.extensionDay || 'none'}
                onChange={e => update('extensionDay', e.target.value)}
                className={inputClass}
              >
                <option value="none">None (classes may use every weekday)</option>
                {(draft.weekdays || []).map(day => <option key={day} value={day}>{day}</option>)}
              </Select>
            </Setting>
          </Section>

          <Section icon={Utensils} title="Lunch" purpose="Nobody goes a class day without a lunch break.">
            {toggle('lunch.enabled', 'Enforce the lunch rule', 'Every section and professor needs a free period in the window each class day.')}
            {timeSelect('lunch.windowStart', 'Lunch window starts', 'The free period falls after this time.')}
            {timeSelect('lunch.windowEnd', 'Lunch window ends', 'The free period must end by this time.')}
            {numberInput('lunch.minFreeMinutes', 'Minimum free time', 'In minutes, a multiple of 30.', { step: 30, min: 30, suffix: 'minutes' })}
            <p className="sm:col-span-2 text-[11px] text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/40 rounded-xl p-3">
              Now: at least {draft.lunch.minFreeMinutes} free minutes between {formatRange12(draft.lunch.windowStart, draft.lunch.windowEnd)}.
            </p>
          </Section>

          {/* Phase 4 Part 4 (rooms the Dean's way): the TBA-room choice, plain. The manual counts stay in
              "Advanced (system team)". Phase 8: the odd/even week groups come first (the office's
              practice when rooms are short); TBA rooms stay the last resort. */}
          <Section icon={DoorOpen} title="Rooms" purpose="When the CCS rooms are full.">
            <fieldset className="sm:col-span-2 min-w-0" aria-describedby="policy-weekGroups-help">
              <legend className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">When the rooms are short</legend>
              <div className="grid grid-cols-1 gap-2">
                {[
                  { value: true, label: 'Alternate odd and even weeks', note: 'Recommended. Each year level meets on campus in its own weeks and online in the others, at the same times.' },
                  { value: false, label: 'Use TBA rooms only', note: 'Every class meets every week.' }
                ].map(opt => {
                  const checked = Boolean(draft.weekGroups?.enabled) === opt.value;
                  return (
                    <label key={String(opt.value)} className={`flex items-start gap-2.5 p-3 rounded-xl border text-left cursor-pointer ${checked ? 'border-purple-300 bg-purple-50 dark:border-purple-500/40 dark:bg-purple-500/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c]'}`}>
                      <input
                        type="radio"
                        name="policy-weekGroups"
                        data-testid={`policy-weekGroups-${opt.value ? 'on' : 'off'}`}
                        checked={checked}
                        onChange={() => update('weekGroups', { ...draft.weekGroups, enabled: opt.value })}
                        className="mt-0.5 w-4 h-4 shrink-0 text-purple-600 focus-visible:ring-2 focus-visible:ring-purple-500"
                      />
                      <span className="min-w-0">
                        <span className={`block text-xs font-bold ${checked ? 'text-purple-900 dark:text-purple-100' : 'text-slate-700 dark:text-slate-200'}`}>{opt.label}</span>
                        <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug">{opt.note}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {Boolean(draft.weekGroups?.enabled) && (
                <div className="mt-3 overflow-x-auto">
                  <table data-testid="policy-weekGroups-table" className="w-full text-xs border-separate border-spacing-0">
                    <caption className="sr-only">Which program and year meet in which weeks</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="text-left font-bold text-slate-600 dark:text-slate-300 pb-1.5 pr-3">Program and year</th>
                        <th scope="col" className="text-left font-bold text-slate-600 dark:text-slate-300 pb-1.5">Meets face-to-face in</th>
                      </tr>
                    </thead>
                    <tbody>
                      {WEEK_GROUP_ROWS.map(({ program, yearLevel }) => {
                        const row = (draft.weekGroups?.groups || []).find(g => g.program === program && g.yearLevel === yearLevel);
                        const value = row ? row.weeks : 'EVERY';
                        const id = `policy-weekGroups-${program}-${yearLevel}`;
                        const setRow = (weeks) => {
                          const others = (draft.weekGroups?.groups || []).filter(g => !(g.program === program && g.yearLevel === yearLevel));
                          update('weekGroups', { ...draft.weekGroups, groups: weeks === 'EVERY' ? others : [...others, { program, yearLevel, weeks }] });
                        };
                        return (
                          <tr key={id}>
                            <th scope="row" className="text-left font-bold text-slate-700 dark:text-slate-200 py-1 pr-3 whitespace-nowrap">{program} {YEAR_LABELS[yearLevel]}</th>
                            <td className="py-1">
                              <label htmlFor={id} className="sr-only">{`Weeks for ${program} ${YEAR_LABELS[yearLevel]}`}</label>
                              <Select id={id} data-testid={id} value={value} onChange={e => setRow(e.target.value)} className={`${inputClass} py-1.5`}>
                                <option value="ODD">Odd weeks</option>
                                <option value="EVEN">Even weeks</option>
                                <option value="EVERY">Every week (never shares a room)</option>
                              </Select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p id="policy-weekGroups-help" data-testid="policy-weekGroups-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                A professor and a section are never double-booked.
              </p>
              {errorFor('weekGroups') && (
                <p role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
                  <AlertCircle size={12} className="mt-px shrink-0" /> {errorFor('weekGroups')}
                </p>
              )}
            </fieldset>
            <fieldset className="sm:col-span-2 min-w-0" disabled={draft.overflowRooms?.mode === 'manual'} aria-describedby="policy-tbaChoice-help">
              <legend className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">When the CCS rooms are full</legend>
              <div className="grid grid-cols-1 gap-2">
                {[
                  { value: 'auto', label: 'Put the extra classes in TBA rooms (placeholders, shown as TBA)', note: 'Recommended. Classes the CCS rooms can\'t hold go into TBA rooms to request.' },
                  { value: 'off', label: 'Use only the CCS rooms', note: 'Generating is blocked while the CCS rooms can\'t hold every class.' }
                ].map(opt => {
                  const checked = (draft.overflowRooms?.mode || 'auto') === opt.value;
                  return (
                    <label key={opt.value} className={`flex items-start gap-2.5 p-3 rounded-xl border text-left cursor-pointer ${checked ? 'border-purple-300 bg-purple-50 dark:border-purple-500/40 dark:bg-purple-500/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c]'}`}>
                      <input
                        type="radio"
                        name="policy-tbaChoice"
                        value={opt.value}
                        data-testid={`policy-tbaChoice-${opt.value}`}
                        checked={checked}
                        onChange={() => update('overflowRooms', { ...draft.overflowRooms, mode: opt.value, enabled: opt.value !== 'off' })}
                        className="mt-0.5 w-4 h-4 shrink-0 text-purple-600 focus-visible:ring-2 focus-visible:ring-purple-500"
                      />
                      <span className="min-w-0">
                        <span className={`block text-xs font-bold ${checked ? 'text-purple-900 dark:text-purple-100' : 'text-slate-700 dark:text-slate-200'}`}>{opt.label}</span>
                        <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug">{opt.note}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p id="policy-tbaChoice-help" data-testid="policy-tbaChoice-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                {draft.overflowRooms?.mode === 'manual'
                  ? `The TBA rooms were set to manual counts (${draft.overflowRooms?.lab ?? 0} lab, ${draft.overflowRooms?.lec ?? 0} lecture) under "Advanced (system team)"; change them there.`
                  : 'The CCS rooms are always used first. Students and faculty see a TBA room as plain "TBA".'}
              </p>
            </fieldset>
          </Section>
        </fieldset>

        {/* THE RULES (read-only; Constraint Configuration's hard-rule list) */}
        <PolicyRules policy={saved} headingRef={rulesHeadingRef} />

        {/* ADVANCED (SYSTEM TEAM): only advanced.edit (the Dean) opens it */}
        <AdvancedSection
          idPrefix="policy"
          canOpen={canEditAdvanced}
          isOpen={isAdvancedOpen}
          onToggle={() => setIsAdvancedOpen(open => !open)}
          summary={ADVANCED_SUMMARY}
          reason={advancedPermission.reason}
        >
          <fieldset disabled={!canEditAdvanced || isSaving} className="grid grid-cols-1 xl:grid-cols-2 gap-5 min-w-0">
            <legend className="sr-only">Advanced settings</legend>
            <Section inset testid="policy-group-weekend" icon={CalendarRange} title="NSTP and Saturday" purpose="NSTP, and Saturday classes.">
              <Setting id="policy-slotMinutes" label="Slot length" help="Every class starts and ends on this grid. It cannot be changed.">
                <input id="policy-slotMinutes" data-testid="policy-slotMinutes" readOnly value={`${draft.slotMinutes} minutes`} className={`${inputClass} opacity-70`} />
              </Setting>
              <Setting id={testId('nstp.day')} label="NSTP day" help="NSTP meets in one fixed block on this day. It needs no room; its professor is TBA." error={errorFor('nstp.day')}>
                <Select id={testId('nstp.day')} data-testid={testId('nstp.day')} value={draft.nstp.day} onChange={e => update('nstp.day', e.target.value)} className={inputClass}>
                  {['Saturday', 'Sunday'].map(d => <option key={d} value={d}>{d}</option>)}
                </Select>
              </Setting>
              {timeSelect('nstp.start', 'NSTP starts', 'Start of the NSTP block.')}
              {timeSelect('nstp.end', 'NSTP ends', 'End of the NSTP block.')}
              <CheckGroup
                path="nstp.yearLevels"
                label="NSTP year levels"
                help="Sections of these year levels get the NSTP block."
                error={errorFor('nstp.yearLevels')}
                options={YEAR_LEVELS.map(y => ({ value: y, label: YEAR_LABELS[y] }))}
                value={draft.nstp.yearLevels}
                onChange={v => update('nstp.yearLevels', v)}
              />
              <CheckGroup
                path="saturdayOverflow.yearLevels"
                label="Saturday class year levels"
                help='Only these year levels may have (non-NSTP) Saturday classes, while "Allow Saturday classes" is ticked.'
                error={errorFor('saturdayOverflow.yearLevels')}
                options={YEAR_LEVELS.map(y => ({ value: y, label: YEAR_LABELS[y] }))}
                value={draft.saturdayOverflow.yearLevels}
                onChange={v => update('saturdayOverflow.yearLevels', v)}
              />
              {timeSelect('saturdayOverflow.start', 'Saturday window starts', 'Earliest Saturday class start (the NSTP block must fit inside this window).')}
              {timeSelect('saturdayOverflow.end', 'Saturday window ends', 'Latest Saturday class end.')}
            </Section>

            <Section inset testid="policy-group-meetings" icon={Layers} title="Meetings" purpose="How one subject's weekly hours become class meetings.">
              {numberInput('meetings.lectureMaxMeetingHours', 'Longest lecture meeting', 'Lectures longer than this are split into meetings (3-hour lectures follow the patterns below).', { min: 0.5, max: 5, suffix: 'hours' })}
              {numberInput('meetings.labMaxMeetingHours', 'Longest lab meeting', 'Labs longer than this are split into meetings.', { min: 0.5, max: 5, suffix: 'hours' })}
              {patternSelect('meetings.threeHourLecture.MAJOR', '3-hour Major lecture', 'How a 3-hour Major lecture meets each week.')}
              {patternSelect('meetings.threeHourLecture.MINOR', '3-hour GenEd / Minor lecture', 'How a 3-hour GenEd or Minor lecture meets each week.')}
              <div className="sm:col-span-2">
                <p className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">Lab start times</p>
                <div className="flex flex-wrap items-center gap-2">
                  {labStarts.map(t => (
                    <span key={t} className="inline-flex items-center gap-1.5 pl-3 pr-1 py-1 rounded-xl border border-purple-200 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 text-xs font-bold text-purple-800 dark:text-purple-200">
                      {formatTime12(t)}
                      <button
                        type="button"
                        data-testid={`policy-meetings-labStartTimes-remove-${t}`}
                        aria-label={`Remove lab start time ${formatTime12(t)}`}
                        onClick={() => update('meetings.labStartTimes', labStarts.filter(x => x !== t))}
                        className="p-1 rounded-lg hover:bg-purple-200/60 dark:hover:bg-purple-500/20 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                  <label htmlFor="policy-meetings-labStartTimes-add" className="sr-only">Add a lab start time</label>
                  <div className="relative">
                    <Plus size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" aria-hidden="true" />
                    <Select
                      id="policy-meetings-labStartTimes-add"
                      data-testid="policy-meetings-labStartTimes-add"
                      value=""
                      onChange={e => e.target.value && update('meetings.labStartTimes', [...labStarts, e.target.value].sort())}
                      className="bg-white dark:bg-[#1a1a1c] border border-dashed border-slate-300 dark:border-slate-600 rounded-xl py-1 pl-7 pr-2 text-xs font-bold text-slate-600 dark:text-slate-300 focus-visible:ring-2 focus-visible:ring-purple-500"
                    >
                      <option value="">Add a time…</option>
                      {addableLabStarts.map(t => <option key={t} value={t}>{formatTime12(t)}</option>)}
                    </Select>
                  </div>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">A lab meeting of the longest length may start only at these times.</p>
                {errorFor('meetings.labStartTimes') && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{errorFor('meetings.labStartTimes')}</p>}
              </div>
              {toggle('meetings.sameSubjectDifferentDays', 'Meetings of one subject on different days', 'All meetings of the same subject for the same section (lecture and lab too) fall on different days.')}
              {toggle('meetings.partTimerNoSingleDay', 'Part-time professors never have a day with only one class', "Part-timers come to campus only for their classes, so each of their teaching days holds at least two. A part-timer whose classes can't all share days (a single class, or one subject's lecture and lab, which fall on different days) is exempt. Turn it off only when a term cannot be generated with it.")}
              {timeSelect('preferredEarliestStart', 'Preferred earliest start', 'Classes may start when the class day starts, but a class (other than NSTP) that starts before this time costs the "Class before the preferred earliest start" penalty.')}
              {numberInput('catalog.maxWeeklyHoursPerType', 'Catalog cap per subject', 'Largest weekly lecture hours, and largest weekly lab hours, a catalog subject may have (practicum is exempt).', { min: 0.5, max: 20, suffix: 'hours' })}
            </Section>

            <Section inset testid="policy-group-rooms" icon={DoorOpen} title="Rooms and TBA rooms" purpose="Which rooms each kind of class may use, and the TBA rooms a run may use when the CCS rooms are full.">
              <Setting id={testId('rooms.majorLectureInLab')} label="Major lecture in a LAB room" help="LAB classes always use LAB rooms. This decides whether a Major lecture may use a LAB room too." error={errorFor('rooms.majorLectureInLab')}>
                <Select id={testId('rooms.majorLectureInLab')} data-testid={testId('rooms.majorLectureInLab')} value={draft.rooms.majorLectureInLab} onChange={e => update('rooms.majorLectureInLab', e.target.value)} className={inputClass}>
                  {MAJOR_LECTURE_IN_LAB_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Setting>
              {toggle('rooms.enforceCapacity', 'Check room capacity against section size', 'Off by default: room capacity and section size are for information only and the scheduler ignores them.')}
              <div className="sm:col-span-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <TbaRoomsFields
                  idPrefix={testId('overflowRooms')}
                  value={draft.overflowRooms}
                  savedValue={saved?.overflowRooms}
                  onChange={(next, field) => {
                    update('overflowRooms', next);
                    // A new mode may change the counts too.
                    (field === 'mode' ? ['mode', 'lab', 'lec'] : [field]).forEach(f => clearError(`overflowRooms.${f}`));
                  }}
                  errors={{ mode: errorFor('overflowRooms.mode'), lab: errorFor('overflowRooms.lab'), lec: errorFor('overflowRooms.lec') }}
                  disabled={!canEditAdvanced || isSaving}
                  majorLectureInLab={draft.rooms?.majorLectureInLab}
                />
              </div>
            </Section>

            <Section inset testid="policy-group-load" icon={Scale} title="Load" purpose="How teaching load is counted, as on the Teachers' Program (SF-029).">
              {['FULL_TIME', 'PART_TIME'].map(type => numberInput(`load.labFactor.${type}`, `Lab factor, ${EMPLOYMENT_LABELS[type].toLowerCase()}`, `Each lab hour of a ${EMPLOYMENT_LABELS[type].toLowerCase()} professor counts this much toward teaching hours.`, { step: 0.05, min: 0.05, max: 1 }))}
              {['FULL_TIME', 'PART_TIME'].map(type => numberInput(`load.defaultTeachingCap.${type}`, `Default teaching cap, ${EMPLOYMENT_LABELS[type].toLowerCase()}`, 'Pre-filled as the maximum teaching hours per week when a professor is added.', { min: 0, max: 40, suffix: 'hours' }))}
              {/* Phase 8 Part 4 (decision 1): the lower end of every professor's load range. */}
              {['FULL_TIME', 'PART_TIME'].map(type => numberInput(`load.defaultMinTeachingHours.${type}`, `Default minimum teaching load, ${EMPLOYMENT_LABELS[type].toLowerCase()}`, 'The lower end of a professor\'s load range when their profile has no minimum of its own. A full-timer\'s default is lowered by their Management Function hours. A load below the minimum warns; nothing is blocked.', { min: 0, max: 40, suffix: 'hours' }))}
              {numberInput('load.standardWeeklyHours', 'Standard week', 'Total hours (teaching + ancillary) of a standard week. Anything above is reported as Excess, not blocked.', { min: 0.5, max: 80, suffix: 'hours' })}
              {numberInput('load.ojtCoordinatorHours', 'Practicum coordinator hours', 'Teaching hours a practicum (OJT) coordinator is credited per section.', { min: 0, max: 40, suffix: 'hours' })}
              <p className="sm:col-span-2 text-[11px] font-bold text-slate-600 dark:text-slate-300 -mb-2">Standard full-time ancillary set (filled in by the Faculty form's "Use standard full-time set" button)</p>
              {Object.keys(draft.load.standardAncillary).map(type => numberInput(`load.standardAncillary.${type}`, ANCILLARY_TYPE_LABELS[type] || type, 'Hours per week in the standard set.', { min: 0, max: 20, suffix: 'hours' }))}
            </Section>

            <Section inset testid="policy-group-weights" icon={Zap} title="Penalty weights" purpose="Penalties the scheduler tries to keep low, each counted per occurrence. The Rules always come first.">
              <ZeroWeightsNote softWeights={policy?.softWeights} testId="policy-softWeights-zero-note" />
              {SOFT_WEIGHTS.map(w => {
                const id = testId(`softWeights.${w.key}`);
                return (
                  <Setting key={w.key} id={id} label={w.label} help={`${w.help} ${SOFT_WEIGHT_STATUS_LABELS[w.status]}.`} error={errorFor(`softWeights.${w.key}`)}>
                    <div className="flex items-center gap-2">
                      <input
                        id={id}
                        data-testid={id}
                        type="number"
                        min={0}
                        step={1}
                        value={draft.softWeights[w.key] ?? ''}
                        onChange={e => update(`softWeights.${w.key}`, e.target.value === '' ? null : Number(e.target.value))}
                        aria-invalid={Boolean(errorFor(`softWeights.${w.key}`))}
                        aria-describedby={`${id}-unit ${id}-help`}
                        className={inputClass}
                      />
                      <span id={`${id}-unit`} data-testid={`${id}-unit`} className="shrink-0 text-xs font-bold text-slate-600 dark:text-slate-400">{w.unit}</span>
                    </div>
                  </Setting>
                );
              })}
              <p data-testid="policy-idle-explanation" className="sm:col-span-2 text-[11px] text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-800/40 rounded-xl p-3">
                {idleTimeExplanation(draft)}
              </p>
            </Section>
          </fieldset>
        </AdvancedSection>
      </form>

      {/* RESET CONFIRMATION */}
      {isResetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget && !isSaving) closeReset(); }}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="policy-reset-title" aria-describedby="policy-reset-desc" className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-md shadow-2xl border border-slate-200 dark:border-slate-800 p-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-4"><AlertTriangle size={24} aria-hidden="true" /></div>
            <h3 id="policy-reset-title" className="text-lg font-black text-slate-900 dark:text-white mb-1">
              {canEditAdvanced ? 'Reset every setting to the defaults?' : 'Reset the days, hours, lunch rule, Saturday setting and odd/even weeks?'}
            </h3>
            <p id="policy-reset-desc" className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-6">
              {canEditAdvanced
                ? 'This replaces every setting on this page (the days and hours, the lunch rule, Saturday classes, and every Advanced setting: NSTP and the Saturday window, meetings, rooms and TBA rooms, load and the penalty weights) with the defaults and saves them at once. You can undo it from the message that follows.'
                : 'This replaces the class days, the class hours, the lunch rule, the Saturday setting and the odd/even weeks with the defaults and saves them at once. The Advanced (system team) settings are not changed. You can undo it from the message that follows.'}
            </p>
            <div className="flex gap-3 justify-end">
              <button type="button" autoFocus onClick={closeReset} className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500">Cancel</button>
              <button type="button" data-testid="policy-reset-confirm" onClick={handleConfirmReset} disabled={isSaving} className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 cursor-pointer disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500">Reset and save</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" data-testid="policy-toast" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md">
          <div className="w-7 h-7 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-400 shrink-0"><CheckCircle2 size={16} aria-hidden="true" /></div>
          <span className="text-xs font-bold tracking-wide">{toast.message}</span>
          {toast.undo && (
            <button type="button" data-testid="policy-undo" onClick={() => { const undo = toast.undo; setToast(null); undo(); }} className="ml-1 px-2.5 py-1 rounded-lg text-xs font-black text-purple-300 dark:text-purple-700 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500">
              Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss message" onClick={() => setToast(null)} className="ml-1 text-slate-400 hover:text-white dark:hover:text-slate-900 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 rounded">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
