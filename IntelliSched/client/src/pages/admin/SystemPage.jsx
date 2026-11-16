import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive, Download, Loader2, RotateCcw, KeyRound, Info, FolderCog, CheckCircle2, AlertTriangle, CalendarDays } from 'lucide-react';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';
import HelpTip from '../../components/ui/HelpTip';
import usePermission from '../../hooks/usePermission';
import Select from '../../components/ui/Select';
import { useTerm } from '../../context/term';
import { DAYS_IN_MONTH, HAS_SUMMER_TERM, MONTH_NAMES, formatMonthDay, parseMonthDay, validateAcademicCalendar } from '../../utils/academicCalendar';

// Phase 11.3: Administration -> System, the Dean's alone (system.manage; the gateway refuses every
// route to another role). Five parts: About, Backup & Restore, Backup settings, Backup password and
// (Phase 13, decision 2) the Academic calendar.
// One primary button: "Back up now". Explanations sit behind "?" (the UI standard, Phase 8 Part 10).
// Test ids: system-*.

const card = 'bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm p-6 space-y-4';
const h2 = 'text-base font-black text-slate-900 dark:text-white flex items-center gap-2';
const label = 'block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1';
const input = 'w-full bg-white dark:bg-[#1a1a1c] border border-slate-300 dark:border-slate-700 rounded-xl py-2 px-3 text-sm text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';
const secondary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600';
const primary = 'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-blue-800 hover:bg-blue-900 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer shadow-lg shadow-blue-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2';
const danger = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white bg-red-700 hover:bg-red-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600';

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
};
const day = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
};
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((bytes || 0) / 1024))} KB`);
const errorText = (err, fallback) => err?.response?.data?.message || fallback;
const KIND_WORDS = { full: 'Full backup', 'before-restore': 'Safety backup', readable: 'Readable copy' };
const COLLECTION_WORDS = { faculty: 'Faculty', sections: 'Sections', facilities: 'Rooms', subject_catalog: 'Subjects', curriculum_mappings: 'Curriculum', mother_schedules: 'Schedule versions', users: 'Accounts', audit_events: 'Audit Trail rows' };

const saveDownload = async (name) => {
  const res = await api.get(`/system/backups/${encodeURIComponent(name)}/download`, { responseType: 'blob', timeout: 300000 });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const Note = ({ tone = 'info', testid, children }) => (children ? (
  <p data-testid={testid} role={tone === 'error' ? 'alert' : 'status'} className={`text-xs font-bold ${tone === 'error' ? 'text-red-700 dark:text-red-400' : tone === 'success' ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}`}>{children}</p>
) : null);

// ---------------------------------------------------------------- About
function About({ about }) {
  if (!about) return <p className="text-sm text-slate-600 dark:text-slate-400">Reading…</p>;
  const rows = [
    ['App version', [about.app?.version, about.app?.commit && `commit ${about.app.commit}`, day(about.app?.date)].filter(Boolean).join(' · ')],
    ['Recommendation model', about.model ? [about.model.version, day(about.model.date)].filter(Boolean).join(' · ') : 'Not found'],
    ['Database', [about.database?.name, about.database?.sizeBytes ? size(about.database.sizeBytes) : null].filter(Boolean).join(' · ')],
    ['Scheduling and ranking service', about.python?.status || 'Unknown']
  ];
  const counts = Object.entries(about.database?.counts || {});
  return (
    <div className="space-y-3">
      <dl data-testid="system-about" className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="text-xs font-bold text-slate-500 dark:text-slate-400">{k}</dt><dd className="font-bold text-slate-900 dark:text-white">{v || '—'}</dd></div>
        ))}
      </dl>
      <ul data-testid="system-counts" aria-label="Records" className="flex flex-wrap gap-2">
        {counts.map(([name, n]) => <li key={name} className="px-2.5 py-1 rounded-lg text-xs bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">{COLLECTION_WORDS[name] || name}: <span className="font-bold">{n}</span></li>)}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- Restore
function RestorePanel({ choice, onCancel, onDone }) {
  const [password, setPassword] = useState('');
  const [summary, setSummary] = useState(null);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState({ busy: false, message: '', tone: 'info' });
  const body = choice.upload ? { upload: choice.upload } : { name: choice.name };
  const check = async (e) => {
    e.preventDefault();
    setState({ busy: true, message: 'Checking the backup…', tone: 'info' });
    setSummary(null);
    try {
      const res = await api.post('/system/restore/preview', { ...body, password }, { timeout: 300000 });
      setSummary(res.data.summary);
      setState({ busy: false, message: '', tone: 'info' });
    } catch (err) { setState({ busy: false, message: errorText(err, 'The backup could not be read.'), tone: 'error' }); }
  };
  const restore = async () => {
    setState({ busy: true, message: 'Restoring… a safety backup is made first.', tone: 'info' });
    try {
      const res = await api.post('/system/restore', { ...body, password, confirm: typed }, { timeout: 600000 });
      onDone(res.data);
    } catch (err) { setState({ busy: false, message: errorText(err, 'The restore could not run.'), tone: 'error' }); }
  };
  return (
    <section data-testid="system-restore-panel" aria-labelledby="system-restore-title" className="rounded-2xl border border-red-200 dark:border-red-500/30 bg-red-50/40 dark:bg-red-500/5 p-4 space-y-3">
      <h3 id="system-restore-title" className="text-sm font-black text-slate-900 dark:text-white">Restore {choice.label}</h3>
      {choice.passwordSetOn !== undefined && (
        <p data-testid="system-restore-password-date" className="text-xs text-slate-700 dark:text-slate-300">
          {choice.passwordSetOn ? `Its password was set on ${day(choice.passwordSetOn)}.` : 'Its password is the default one.'}
        </p>
      )}
      <form onSubmit={check} className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="system-restore-password" className={label}>This backup's password</label>
          <input id="system-restore-password" data-testid="system-restore-password" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} className={input} />
        </div>
        <button type="submit" data-testid="system-restore-check" disabled={state.busy || !password} title={!password ? 'Type the password first.' : undefined} className={secondary}>Check</button>
        <button type="button" data-testid="system-restore-cancel" onClick={onCancel} disabled={state.busy} className={secondary}>Cancel</button>
      </form>
      {summary && (
        <div data-testid="system-restore-summary" className="space-y-3">
          <p className="text-sm font-bold text-slate-900 dark:text-white">
            Made {when(summary.createdAt)}{summary.terms?.length ? ` · ${summary.terms.map(t => `${t.semester === 1 ? '1st' : '2nd'} Sem ${t.academicYear}`).join(', ')}` : ''}
          </p>
          <table className="text-xs w-full max-w-lg">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400"><th className="py-1 pr-4">Records</th><th className="py-1 pr-4">In the backup</th><th className="py-1">Now</th></tr></thead>
            <tbody>
              {summary.counts.map(c => (
                <tr key={c.collection} data-testid={`system-restore-count-${c.collection}`} className="border-t border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200">
                  <td className="py-1 pr-4">{COLLECTION_WORDS[c.collection] || c.collection}</td><td className="py-1 pr-4 font-bold">{c.backup}</td><td className="py-1">{c.current}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-red-800 dark:text-red-300 font-bold">Everything now is replaced by this backup. A safety backup is made first. Everyone signs in again.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="system-restore-confirm" className={label}>Type RESTORE to confirm</label>
              <input id="system-restore-confirm" data-testid="system-restore-confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" className={`${input} w-44`} />
            </div>
            <button type="button" data-testid="system-restore-go" onClick={restore} disabled={state.busy || typed !== 'RESTORE'} title={typed !== 'RESTORE' ? 'Type RESTORE first.' : undefined} className={danger}>
              {state.busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />} Restore
            </button>
          </div>
        </div>
      )}
      <Note tone={state.tone} testid="system-restore-status">{state.message}</Note>
    </section>
  );
}

// ---------------------------------------------------------------- the page
export default function SystemPage() {
  const permission = usePermission('system.manage');
  const [about, setAbout] = useState(null);
  const [page, setPage] = useState({ status: 'loading', data: null, message: '' });
  const [run, setRun] = useState({ busy: false, message: '', tone: 'info', made: null });
  const [choice, setChoice] = useState(null);
  const [restored, setRestored] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/system/backups');
      if (res.data?.settings && res.data?.password && res.data?.folder) setPage({ status: 'done', data: res.data, message: '' });
      else setPage({ status: 'error', data: null, message: 'The backups could not be read. Reload the page.' });
    } catch (err) { setPage({ status: 'error', data: null, message: errorText(err, 'The backups could not be read.') }); }
  }, []);
  useEffect(() => {
    if (!permission.allowed) return undefined;
    let active = true;
    api.get('/system/backups')
      .then(res => {
        if (!active) return;
        if (res.data?.settings && res.data?.password && res.data?.folder) setPage({ status: 'done', data: res.data, message: '' });
        else setPage({ status: 'error', data: null, message: 'The backups could not be read. Reload the page.' });
      })
      .catch(err => { if (active) setPage({ status: 'error', data: null, message: errorText(err, 'The backups could not be read.') }); });
    api.get('/system/about').then(res => { if (active) setAbout(res.data?.app ? res.data : {}); }).catch(() => { if (active) setAbout({}); });
    return () => { active = false; };
  }, [permission.allowed]);

  if (permission.loading) return <p className="p-6 text-sm">Checking…</p>;
  if (!permission.allowed) {
    return (
      <div className={card} data-testid="system-not-allowed">
        <PageHeader pageKey="system" />
        <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{permission.reason}</p>
      </div>
    );
  }

  const data = page.data;
  const backUpNow = async () => {
    setRun({ busy: true, message: 'Making the backup…', tone: 'info', made: null });
    try {
      const res = await api.post('/system/backups', {}, { timeout: 600000 });
      setRun({ busy: false, message: 'Backup made.', tone: 'success', made: res.data });
      load();
    } catch (err) {
      setRun({ busy: false, message: errorText(err, 'The backup could not be made.'), tone: 'error', made: null });
      load();
    }
  };
  const uploadFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await api.post('/system/restore/upload', await file.arrayBuffer(), { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 600000 });
      setChoice({ upload: res.data.upload, label: file.name, passwordSetOn: res.data.passwordSetOn });
    } catch (err) { setRun({ busy: false, message: errorText(err, 'The file could not be read.'), tone: 'error', made: null }); }
  };
  const signInAgain = () => {
    try { localStorage.removeItem('intellisched_token'); } catch { /* nothing kept */ }
    window.location.reload();
  };

  if (restored) {
    return (
      <div className={card} data-testid="system-restored">
        <PageHeader pageKey="system" />
        <p className="text-sm font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-2"><CheckCircle2 size={18} aria-hidden="true" /> Restored the backup made {when(restored.createdAt)}.</p>
        <p className="text-xs text-slate-700 dark:text-slate-300">Safety backup: {restored.safety}.{restored.modelRestored ? ' Restart IntelliSched so the ranking uses the restored model.' : ''}</p>
        <button type="button" data-testid="system-sign-in-again" onClick={signInAgain} className={primary}>Sign in again</button>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden">
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="system" />
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <button type="button" data-testid="system-backup-now" onClick={backUpNow} disabled={run.busy || page.status !== 'done'} className={primary}>
              {run.busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <HardDrive size={16} aria-hidden="true" />} {run.busy ? 'Backing up…' : 'Back up now'}
            </button>
            <Note tone={run.tone} testid="system-backup-status">{run.message}</Note>
            {run.made && (
              <div className="flex flex-wrap gap-2">
                <button type="button" data-testid="system-download-full" onClick={() => saveDownload(run.made.full.name)} className={secondary}><Download size={13} aria-hidden="true" /> Full backup</button>
                <button type="button" data-testid="system-download-readable" onClick={() => saveDownload(run.made.readable.name)} className={secondary}><Download size={13} aria-hidden="true" /> Readable copy</button>
              </div>
            )}
          </div>
        </div>
        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400" />
      </div>

      {page.status === 'error' && <Note tone="error" testid="system-error">{page.message}</Note>}
      {data?.warnings?.length > 0 && (
        <ul data-testid="system-warnings" className="space-y-2">
          {data.warnings.map(w => <li key={w.code} data-testid={`system-warning-${w.code}`} className="flex items-center gap-2 px-4 py-2.5 rounded-2xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 text-sm font-bold text-amber-900 dark:text-amber-200"><AlertTriangle size={16} aria-hidden="true" /> {w.text}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className={card} aria-labelledby="system-about-title">
          <h2 id="system-about-title" className={h2}><Info size={18} aria-hidden="true" /> About</h2>
          <About about={about} />
        </section>

        <section className={card} aria-labelledby="system-password-title">
          <h2 id="system-password-title" className={h2}>
            <KeyRound size={18} aria-hidden="true" /> Backup password
            <HelpTip label="the backup password" testid="system-password-help">Every full backup is locked with this password. Restoring a backup needs the password it was made with. The default is "intellisched": change it.</HelpTip>
          </h2>
          {data && <PasswordForm state={data.password} onChanged={load} />}
        </section>
      </div>

      <section className={card} aria-labelledby="system-backups-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="system-backups-title" className={h2}>
            <HardDrive size={18} aria-hidden="true" /> Backup &amp; Restore
            <HelpTip label="the two kinds of file" testid="system-backups-help">A full backup (.isbak) restores the whole system and is locked with the backup password. A readable copy (.zip) opens in Excel without IntelliSched; it holds no rating and no password.</HelpTip>
          </h2>
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".isbak" className="sr-only" data-testid="system-restore-file" aria-label="Choose a backup file to restore" onChange={uploadFile} />
            <button type="button" data-testid="system-restore-upload" onClick={() => fileRef.current?.click()} className={secondary}><RotateCcw size={13} aria-hidden="true" /> Restore from a file…</button>
          </div>
        </div>
        <p data-testid="system-last-backup" className="text-xs text-slate-700 dark:text-slate-300">
          {data?.lastSuccess ? `Last backup: ${when(data.lastSuccess)}` : 'No backup yet.'}
          {data?.lastFailure ? ` · Last failure: ${when(data.lastFailure.at)}` : ''}
        </p>
        {choice && <RestorePanel key={choice.upload || choice.name} choice={choice} onCancel={() => setChoice(null)} onDone={setRestored} />}
        <BackupList files={data?.files || []} onRestore={(f) => setChoice({ name: f.name, label: f.name, passwordSetOn: f.passwordSetOn })} />
      </section>

      <section className={card} aria-labelledby="system-settings-title">
        <h2 id="system-settings-title" className={h2}>
          <FolderCog size={18} aria-hidden="true" /> Backup settings
          <HelpTip label="automatic backups" testid="system-settings-help">IntelliSched runs only while it is used. When it closes (after the minutes without use, or "Stop IntelliSched") it backs up first if anything changed. A daily backup is also made at the first check after 12:00 noon while it runs, and after every approval. Older backups beyond the number kept are deleted.</HelpTip>
        </h2>
        {data && <SettingsForm data={data} onSaved={load} />}
      </section>

      <section className={card} aria-labelledby="system-calendar-title" data-testid="system-calendar">
        <h2 id="system-calendar-title" className={h2}>
          <CalendarDays size={18} aria-hidden="true" /> Academic calendar
          <HelpTip label="the academic calendar" testid="system-calendar-help">Use the dates in the university calendar. If they are not updated, nothing breaks: the list still shows every year with data and the next four.</HelpTip>
        </h2>
        <AcademicCalendarCard />
      </section>
    </div>
  );
}

function BackupList({ files, onRestore }) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  if (!files.length) return <p data-testid="system-files-empty" className="text-sm text-slate-600 dark:text-slate-400">No backup in the folder yet. Press "Back up now".</p>;
  const download = async (name) => {
    setBusy(name);
    setMessage('');
    try { await saveDownload(name); } catch (err) { setMessage(errorText(err, 'The file could not be downloaded.')); }
    setBusy('');
  };
  return (
    <div className="overflow-x-auto">
      <table data-testid="system-files" className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-500 dark:text-slate-400"><th className="py-2 pr-4">Made</th><th className="py-2 pr-4">Kind</th><th className="py-2 pr-4">Password set on</th><th className="py-2 pr-4">Size</th><th className="py-2"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {files.map(f => (
            <tr key={f.name} data-testid={`system-file-${f.name}`} className="border-t border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200">
              <td className="py-2 pr-4 whitespace-nowrap" title={f.name}>{when(f.createdAt)}</td>
              <td className="py-2 pr-4">{KIND_WORDS[f.kind] || f.kind}{f.damaged ? ' (damaged)' : ''}</td>
              <td className="py-2 pr-4">{f.kind === 'readable' ? '—' : f.passwordSetOn ? day(f.passwordSetOn) : 'Default'}</td>
              <td className="py-2 pr-4">{size(f.size)}</td>
              <td className="py-2 flex flex-wrap gap-2 justify-end">
                <button type="button" data-testid={`system-file-download-${f.name}`} onClick={() => download(f.name)} disabled={busy === f.name} aria-label={`Download ${f.name}`} className={secondary}><Download size={13} aria-hidden="true" /> Download</button>
                {f.kind !== 'readable' && !f.damaged && <button type="button" data-testid={`system-file-restore-${f.name}`} onClick={() => onRestore(f)} aria-label={`Restore ${f.name}`} className={secondary}><RotateCcw size={13} aria-hidden="true" /> Restore</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note tone="error" testid="system-files-status">{message}</Note>
    </div>
  );
}

// ---------------------------------------------------------------- Academic calendar (Phase 13, decision 2)
// The university's dates, so the academic year in progress and the term picker's years follow them.
const CALENDAR_FIELDS = [
  { key: 'yearStart', label: 'Academic year starts on' },
  { key: 'secondSemesterStart', label: '2nd semester starts on' },
  { key: 'summerStart', label: 'Summer starts on', summer: true }
];
const daysIn = (month) => DAYS_IN_MONTH[Math.max(0, Number(month) - 1)] || 31;

function MonthDayField({ field, value, onChange, error, disabled }) {
  const md = parseMonthDay(value) || { month: 1, day: 1 };
  const id = `system-cal-${field.key}`;
  const set = (month, dayOfMonth) => onChange(formatMonthDay({ month, day: Math.min(dayOfMonth, daysIn(month)) }));
  return (
    <fieldset className="min-w-0" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className={label}>{field.label}</legend>
      <div className="flex items-center gap-2">
        <Select id={`${id}-month`} data-testid={`${id}-month`} aria-label={`${field.label}: month`} value={String(md.month)} disabled={disabled} aria-invalid={Boolean(error)} onChange={e => set(Number(e.target.value), md.day)} className={`${input} w-36`}>
          {MONTH_NAMES.map((name, i) => <option key={name} value={String(i + 1)}>{name}</option>)}
        </Select>
        <Select id={`${id}-day`} data-testid={`${id}-day`} aria-label={`${field.label}: day`} value={String(md.day)} disabled={disabled} aria-invalid={Boolean(error)} onChange={e => set(md.month, Number(e.target.value))} className={`${input} w-20`}>
          {Array.from({ length: daysIn(md.month) }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
        </Select>
      </div>
      {error && <p id={`${id}-error`} role="alert" data-testid={`${id}-error`} className="mt-1 text-xs font-bold text-red-700 dark:text-red-400">{error}</p>}
    </fieldset>
  );
}

function AcademicCalendarCard() {
  const { calendar, currentAcademicYear, refreshCalendar } = useTerm();
  const [draft, setDraft] = useState(calendar);
  const [errors, setErrors] = useState({});
  const [state, setState] = useState({ busy: false, message: '', tone: 'info' });
  // A save in another tab reaches this card (the term context reads the calendar again).
  const [seen, setSeen] = useState(calendar);
  if (seen !== calendar) { setSeen(calendar); setDraft(calendar); }
  const fields = CALENDAR_FIELDS.filter(f => !f.summer || HAS_SUMMER_TERM);
  const save = async (e) => {
    e.preventDefault();
    const checked = validateAcademicCalendar(draft);
    setErrors(checked.errors);
    if (!checked.ok) { setState({ busy: false, message: '', tone: 'info' }); return; }
    setState({ busy: true, message: 'Saving…', tone: 'info' });
    try {
      const res = await api.put('/system/academic-calendar', checked.calendar);
      setState({ busy: false, message: res.data?.message || 'Saved.', tone: 'success' });
      await refreshCalendar();
    } catch (err) {
      const data = err?.response?.data;
      if (data?.errors) setErrors(data.errors);
      setState({ busy: false, message: errorText(err, 'The academic calendar could not be saved.'), tone: 'error' });
    }
  };
  return (
    <form onSubmit={save} noValidate className="space-y-3" data-testid="system-calendar-form">
      <div className="flex flex-wrap items-start gap-6">
        {fields.map(f => (
          <MonthDayField key={f.key} field={f} value={draft[f.key]} disabled={state.busy} error={errors[f.key]}
            onChange={v => { setDraft(d => ({ ...d, [f.key]: v })); setErrors(x => ({ ...x, [f.key]: undefined })); }} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" data-testid="system-calendar-save" disabled={state.busy} className={secondary}>Save calendar</button>
        <p data-testid="system-calendar-current" className="text-xs text-slate-700 dark:text-slate-300">Current: A.Y. {currentAcademicYear}</p>
      </div>
      <Note tone={state.tone} testid="system-calendar-status">{state.message}</Note>
    </form>
  );
}

function SettingsForm({ data, onSaved }) {
  const [folder, setFolder] = useState(data.settings.folder);
  const [daily, setDaily] = useState(data.settings.daily);
  const [keep, setKeep] = useState(String(data.settings.keep));
  const [idle, setIdle] = useState(String(data.settings.idleMinutes ?? 60));
  const [second, setSecond] = useState(data.secondFolder?.path || '');
  const [state, setState] = useState({ busy: false, message: '', tone: 'info', field: null });
  const save = async (e) => {
    e.preventDefault();
    const n = Number(keep);
    if (!Number.isInteger(n) || n < data.settings.keepRange.min || n > data.settings.keepRange.max) {
      setState({ busy: false, message: `Keep ${data.settings.keepRange.min} to ${data.settings.keepRange.max} backups.`, tone: 'error', field: 'keep' });
      return;
    }
    setState({ busy: true, message: 'Saving…', tone: 'info', field: null });
    try {
      await api.put('/system/backup-settings', { folder, daily, keep: n, idleMinutes: idle === 'never' ? 'never' : Number(idle), secondFolder: second.trim() });
      setState({ busy: false, message: 'Saved.', tone: 'success', field: null });
      onSaved();
    } catch (err) {
      setState({ busy: false, message: errorText(err, 'The settings could not be saved.'), tone: 'error', field: err?.response?.data?.field || null });
    }
  };
  return (
    <form onSubmit={save} noValidate className="space-y-3">
      <div>
        <label htmlFor="system-folder" className={label}>Folder <span aria-hidden="true">*</span></label>
        <input id="system-folder" data-testid="system-folder" value={folder} onChange={e => setFolder(e.target.value)} required aria-invalid={state.field === 'folder'} className={input} />
        <p data-testid="system-folder-state" className={`text-xs mt-1 font-bold ${data.folder.writable ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
          {data.folder.writable ? 'Exists and can be written.' : data.folder.problem || 'Cannot be written.'}
        </p>
      </div>
      <div>
        {/* Phase 12.1 (decision 5): a second copy, e.g. a Google Drive for desktop folder or a USB stick. */}
        <label htmlFor="system-second-folder" className={label}>
          Also copy backups to (optional)
          <HelpTip label="the second backup folder" testid="system-second-folder-help">Google Drive for desktop shows the office's Drive as a folder (for example G:\My Drive\IntelliSched Backups) and uploads it privately by itself. IntelliSched only copies files there; it never uploads or shares anything.</HelpTip>
        </label>
        <input id="system-second-folder" data-testid="system-second-folder" value={second} onChange={e => setSecond(e.target.value)} placeholder="e.g. G:\My Drive\IntelliSched Backups" aria-invalid={state.field === 'secondFolder'} className={input} />
        {data.secondFolder && (
          <p data-testid="system-second-folder-state" className={`text-xs mt-1 font-bold ${data.secondFolder.problem ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            {data.secondFolder.problem || 'Each backup is copied here too.'}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <label className="inline-flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-200">
          <input type="checkbox" data-testid="system-daily" checked={daily} onChange={e => setDaily(e.target.checked)} className="w-4 h-4" /> Daily backup
        </label>
        <div>
          <label htmlFor="system-keep" className={label}>Backups kept</label>
          <input id="system-keep" data-testid="system-keep" type="number" min={data.settings.keepRange.min} max={data.settings.keepRange.max} value={keep} onChange={e => setKeep(e.target.value)} aria-invalid={state.field === 'keep'} className={`${input} w-28`} />
        </div>
        <div>
          {/* Phase 12.1 (decision 4): IntelliSched closes itself, after a closing backup, when unused. */}
          <label htmlFor="system-idle" className={label}>Close when unused</label>
          <Select id="system-idle" data-testid="system-idle" value={idle} onChange={e => setIdle(e.target.value)} aria-invalid={state.field === 'idleMinutes'} className={`${input} w-40`}>
            {(data.settings.idleChoices || [30, 60, 120, 'never']).map(c => <option key={c} value={String(c)}>{c === 'never' ? 'Never' : `After ${c} minutes`}</option>)}
          </Select>
        </div>
        <button type="submit" data-testid="system-settings-save" disabled={state.busy} className={secondary}>Save settings</button>
      </div>
      <Note tone={state.tone} testid="system-settings-status">{state.message}</Note>
    </form>
  );
}

function PasswordForm({ state: pwState, onChanged }) {
  const [form, setForm] = useState({ loginPassword: '', next: '', confirm: '' });
  const [state, setState] = useState({ busy: false, message: '', tone: 'info', field: null });
  const set = (k) => (e) => setForm(prev => ({ ...prev, [k]: e.target.value }));
  const clientProblem = () => {
    if (!form.loginPassword) return ['loginPassword', 'Type your sign-in password.'];
    if (form.next.length < 8) return ['next', 'Use at least 8 characters.'];
    if (form.next === 'intellisched') return ['next', 'Choose a password other than the default.'];
    if (form.next !== form.confirm) return ['confirm', 'The two new passwords are not the same.'];
    return null;
  };
  const submit = async (e) => {
    e.preventDefault();
    const problem = clientProblem();
    if (problem) { setState({ busy: false, message: problem[1], tone: 'error', field: problem[0] }); return; }
    setState({ busy: true, message: 'Saving…', tone: 'info', field: null });
    try {
      const res = await api.put('/system/backup-password', form);
      setForm({ loginPassword: '', next: '', confirm: '' });
      setState({ busy: false, message: res.data.message, tone: 'success', field: null });
      onChanged();
    } catch (err) {
      setState({ busy: false, message: errorText(err, 'The password could not be changed.'), tone: 'error', field: err?.response?.data?.field || null });
    }
  };
  const fieldNote = (k) => (state.field === k ? <p data-testid={`system-pw-error-${k}`} className="text-xs font-bold text-red-700 dark:text-red-400 mt-1">{state.message}</p> : null);
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="system-password-form">
      <p data-testid="system-password-state" className={`text-xs font-bold ${pwState.isDefault ? 'text-amber-800 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-400'}`}>
        {pwState.isDefault ? (pwState.fallback ? 'The saved password could not be read on this computer: the default is in use. Change it.' : 'The default password is in use. Change it.') : `Set on ${day(pwState.setOn)}.`}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[['loginPassword', 'Your sign-in password', 'current-password'], ['next', 'New backup password', 'new-password'], ['confirm', 'New password again', 'new-password']].map(([k, text, auto]) => (
          <div key={k}>
            <label htmlFor={`system-pw-${k}`} className={label}>{text} <span aria-hidden="true">*</span></label>
            <input id={`system-pw-${k}`} data-testid={`system-pw-${k}`} type="password" autoComplete={auto} value={form[k]} onChange={set(k)} aria-invalid={state.field === k} className={input} />
            {fieldNote(k)}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" data-testid="system-pw-save" disabled={state.busy} className={secondary}><KeyRound size={13} aria-hidden="true" /> Change password</button>
        <span className="text-xs text-slate-600 dark:text-slate-400">Backups made before today still need the old password.</span>
      </div>
      {!state.field && <Note tone={state.tone} testid="system-pw-status">{state.message}</Note>}
    </form>
  );
}
