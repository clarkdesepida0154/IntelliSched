import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertOctagon, CheckCircle2, Loader2, Plus, RefreshCw, Save, Tags, Trash2, Undo2, X } from 'lucide-react';
import api from '../../services/api';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import { fetchReferenceLists, rememberReferenceList } from '../../hooks/useReferenceLists';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import ConfirmDialog from '../../components/ui/ConfirmDialog';

// Reference Lists (Phase 3 Step 8): the business lists other pages pick from, kept in the database
// (GET /api/reference-lists; PUT /api/reference-lists/:key replaces one list). Today: the specialization
// domains (faculty profiles; the recommendations compare them with the subjects) and the position titles
// (faculty profiles; printed on the Teachers' Program). Until a list is saved the gateway answers its
// defaults (persisted: false), which this page shows as "Default list, not saved yet". Faculty profiles
// store the text itself, so removing or renaming an entry never changes a profile that already uses it:
// the page says so, and every removal asks first. The gateway checks each list (empty entries, entries
// too long, duplicates ignoring case, at least one specialization domain) and names each problem by
// entry (items.N); it is shown next to that entry, and what was typed stays. Changing a list is the
// permission map's settings.edit (the Dean); anyone else sees the lists read-only,
// with the map's reason.

const NOTE_ID = 'rl-permission-note';

// What each list is for, under its name (a list the gateway adds later shows its name alone).
const LIST_HELP = {
  specializationDomains: 'Faculty profiles pick their specializations from this list, and the recommendations compare them with each subject. Keep at least one entry.',
  positionTitles: "Faculty profiles pick their position from this list; it is printed under the professor's name on the Teachers' Program."
};

// One editable entry: its text and the saved text it started from (null for a new entry), and a stable
// key for React.
let lastRowId = 0;
const rowsOf = (items) => (Array.isArray(items) ? items : []).map(text => ({ id: (lastRowId += 1), text: String(text), original: String(text) }));
const itemsOf = (rows) => rows.map(row => row.text);
const entriesText = (n) => (n === 1 ? '1 entry' : `${n} entries`);

const inputClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus:border-purple-500 text-slate-900 dark:text-white disabled:opacity-80 disabled:cursor-not-allowed font-bold aria-[invalid=true]:border-red-500';
const buttonClass = 'px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap flex items-center cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500';

export default function ReferenceLists() {
  const permission = usePermission('settings.edit');
  const canEdit = permission.allowed;

  const [load, setLoad] = useState({ status: 'loading', error: '' });
  const [loadNonce, setLoadNonce] = useState(0);
  const [lists, setLists] = useState(null);       // the saved lists, as the gateway answered them
  const [drafts, setDrafts] = useState({});       // key -> the entries being edited
  const [errors, setErrors] = useState({});       // key -> { 'items.N' | 'items': message }
  const [banners, setBanners] = useState({});     // key -> why the last save failed
  const [savingKey, setSavingKey] = useState('');
  const [removal, setRemoval] = useState(null);   // { key, id, name }: the removal being confirmed
  const [toast, setToast] = useState(null);
  const [focusId, setFocusId] = useState(null);   // { testId }: the field to focus after the next render
  const toastTimerRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    let active = true;
    fetchReferenceLists()
      .then(next => {
        if (!active) return;
        setLists(next);
        setDrafts(Object.fromEntries(Object.entries(next).map(([key, list]) => [key, rowsOf(list.items)])));
        setErrors({});
        setBanners({});
        setLoad({ status: 'ready', error: '' });
      })
      .catch(err => {
        if (!active) return;
        setLoad({ status: 'error', error: `The reference lists could not be loaded (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".` });
      });
    return () => { active = false; };
  }, [loadNonce]);

  useEffect(() => {
    if (focusId) document.querySelector(`[data-testid="${focusId.testId}"]`)?.focus();
  }, [focusId]);

  const showToast = useCallback((message, extra = {}) => {
    const entry = { message, ...extra };
    setToast(entry);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(current => (current === entry ? null : current)), entry.undo ? 10000 : 5000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const retryLoad = () => {
    setLoad({ status: 'loading', error: '' });
    setLoadNonce(n => n + 1);
  };

  const isDirty = (key) => Boolean(lists?.[key] && drafts[key]) && JSON.stringify(itemsOf(drafts[key])) !== JSON.stringify(lists[key].items || []);
  const setRows = (key, rows, { keepErrors = false } = {}) => {
    setDrafts(prev => ({ ...prev, [key]: rows }));
    // Adding or removing an entry renumbers the entries after it, so their problems no longer apply.
    if (!keepErrors) setErrors(prev => ({ ...prev, [key]: {} }));
  };

  const editRow = (key, index, text) => {
    setDrafts(prev => ({ ...prev, [key]: prev[key].map((row, i) => (i === index ? { ...row, text } : row)) }));
    setErrors(prev => {
      if (!prev[key]?.[`items.${index}`] && !prev[key]?.items) return prev;
      const next = { ...prev[key] };
      delete next[`items.${index}`];
      delete next.items;
      return { ...prev, [key]: next };
    });
  };

  const addRow = (key) => {
    const rows = drafts[key];
    setRows(key, [...rows, { id: (lastRowId += 1), text: '', original: null }]);
    setFocusId({ testId: `rl-${key}-item-${rows.length}` });
  };

  // An entry still empty and never saved goes at once; any other asks first.
  const askRemove = (key, row, addButton) => {
    if (row.original === null && !row.text.trim()) {
      setRows(key, drafts[key].filter(r => r.id !== row.id));
      setFocusId({ testId: `rl-${key}-add` });
      return;
    }
    returnFocusRef.current = addButton;
    setRemoval({ key, id: row.id, name: row.text.trim() || row.original });
  };
  const confirmRemove = () => {
    const { key, id, name } = removal;
    const before = drafts[key];
    setRows(key, before.filter(r => r.id !== id));
    setRemoval(null);
    showToast(`"${name}" removed from the ${lists[key].label.toLowerCase()}. Nothing is saved until you press "Save list".`, {
      undo: () => setRows(key, before)
    });
  };

  const discard = (key) => {
    const before = drafts[key];
    setRows(key, rowsOf(lists[key].items));
    setBanners(prev => ({ ...prev, [key]: '' }));
    showToast(`Your changes to the ${lists[key].label.toLowerCase()} were discarded.`, { undo: () => setRows(key, before) });
  };

  // PUT /api/reference-lists/:key. A refused save keeps what was typed and marks each entry with a problem.
  const save = async (key) => {
    if (!canEdit || !isDirty(key) || savingKey) return;
    setSavingKey(key);
    setBanners(prev => ({ ...prev, [key]: '' }));
    try {
      const res = await api.put(`/reference-lists/${encodeURIComponent(key)}`, { items: itemsOf(drafts[key]) });
      const list = res.data?.list;
      if (!list || !Array.isArray(list.items)) throw new Error('the gateway answered without the saved list');
      setLists(prev => ({ ...prev, [key]: list }));
      setRows(key, rowsOf(list.items));
      rememberReferenceList(key, list);
      showToast(`${list.label} saved (${entriesText(list.items.length)}). Faculty profiles pick from the saved list from now on.`);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 400 && Array.isArray(data?.errors) && data.errors.length) {
        const byField = Object.fromEntries(data.errors.map(e => [String(e.field || 'items'), e.message]));
        setErrors(prev => ({ ...prev, [key]: byField }));
        setBanners(prev => ({ ...prev, [key]: `${data.message || 'The list was not saved.'} Each problem is shown next to its entry.` }));
        const first = data.errors.map(e => /^items\.(\d+)$/.exec(String(e.field))).find(Boolean);
        setFocusId({ testId: first ? `rl-${key}-item-${first[1]}` : `rl-${key}-add` });
      } else if (err.response?.status === 403) {
        setBanners(prev => ({ ...prev, [key]: `${data?.message || permission.reason} Nothing was saved.` }));
      } else {
        setBanners(prev => ({ ...prev, [key]: `The list could not be saved (${data?.message || err.message}). Your changes are still on the page; check that the gateway is running, then press "Save list" again.` }));
      }
    } finally {
      setSavingKey('');
    }
  };

  const header = (
    <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg">
      <div className="p-6 md:p-8 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
        <PageHeader pageKey="reference-lists" />
      </div>
      <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400 rounded-b-3xl"></div>
    </div>
  );

  if (!lists) {
    return (
      <div className="animate-in fade-in duration-300 relative space-y-6">
        {header}
        {load.status === 'loading' ? (
          <div data-testid="rl-loading" role="status" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-16 flex flex-col items-center gap-3 text-slate-600 dark:text-slate-300">
            <Loader2 size={36} className="animate-spin text-purple-500" aria-hidden="true" />
            <p className="text-xs font-bold uppercase tracking-wider">Loading the reference lists…</p>
          </div>
        ) : (
          <div data-testid="rl-load-error" role="alert" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-12 text-center max-w-lg mx-auto">
            <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The reference lists could not be loaded</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 mb-4">{load.error}</p>
            <button type="button" data-testid="rl-retry" onClick={retryLoad} className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-xl text-xs font-bold hover:bg-purple-700 cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-purple-500">
              <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const listCard = (key) => {
    const list = lists[key];
    const rows = drafts[key] || [];
    const listErrors = errors[key] || {};
    const dirty = isDirty(key);
    const saving = savingKey === key;
    const locked = !canEdit || Boolean(savingKey);
    const saveReason = !canEdit ? permission.reason : saving ? 'Saving…' : savingKey ? 'Wait until the other list is saved.' : !dirty ? 'No changes to save.' : '';
    const status = list.persisted
      ? `Last saved by ${list.updatedBy || 'an unknown user'}${list.updatedAt ? ` on ${new Date(list.updatedAt).toLocaleString()}` : ''}.`
      : 'Faculty profiles use these defaults until the list is saved.';
    return (
      <section key={key} data-testid={`rl-list-${key}`} aria-labelledby={`rl-${key}-title`} className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2 bg-purple-500/10 rounded-xl"><Tags size={18} className="text-purple-600 dark:text-purple-400" aria-hidden="true" /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 id={`rl-${key}-title`} className="text-base font-black text-slate-900 dark:text-white">{list.label}</h3>
                <span data-testid={`rl-${key}-count`} className="text-[11px] font-bold text-slate-600 dark:text-slate-400">{entriesText(rows.length)}</span>
                {!list.persisted && (
                  <span data-testid={`rl-${key}-default`} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">Default list, not saved yet</span>
                )}
                {dirty && (
                  <span data-testid={`rl-${key}-dirty`} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-500/10 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">Unsaved changes</span>
                )}
              </div>
              {LIST_HELP[key] && <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{LIST_HELP[key]}</p>}
              <p data-testid={`rl-${key}-status`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">{status}</p>
            </div>
          </div>
          <div className="flex flex-col items-start lg:items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid={`rl-${key}-discard`}
                onClick={() => discard(key)}
                disabled={!dirty || locked}
                title={!canEdit ? permission.reason : !dirty ? 'No changes to discard.' : undefined}
                aria-describedby={!canEdit ? NOTE_ID : undefined}
                className={`${buttonClass} bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-50`}
              >
                <Undo2 size={16} className="mr-2" aria-hidden="true" /> Discard changes
              </button>
              <button
                type="button"
                data-testid={`rl-${key}-save`}
                onClick={() => save(key)}
                disabled={Boolean(saveReason)}
                aria-describedby={`rl-${key}-save-reason`}
                className={`${buttonClass} bg-purple-600 hover:bg-purple-700 text-white px-5 shadow-lg shadow-purple-900/20 disabled:opacity-60 focus-visible:ring-offset-2`}
              >
                {saving ? <Loader2 size={16} className="mr-2 animate-spin" aria-hidden="true" /> : <Save size={16} className="mr-2" aria-hidden="true" />}
                {saving ? 'Saving…' : 'Save list'}
              </button>
            </div>
            <p id={`rl-${key}-save-reason`} data-testid={`rl-${key}-save-reason`} className="text-[11px] text-slate-600 dark:text-slate-400 min-h-4">{saveReason}</p>
          </div>
        </div>

        {banners[key] && (
          <p role="alert" data-testid={`rl-${key}-error`} className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-800 dark:text-red-400">
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" /> {banners[key]}
          </p>
        )}
        <p id={`rl-${key}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mb-3 leading-snug">
          Each faculty profile keeps the text it was saved with: removing or renaming an entry here does not change the profiles that already use it.
        </p>

        <fieldset disabled={locked} className="min-w-0">
          <legend className="sr-only">Entries of the {list.label.toLowerCase()}</legend>
          {rows.length === 0 && (
            <p data-testid={`rl-${key}-empty`} className="text-xs text-slate-600 dark:text-slate-400 mb-3">No entries yet. Press &ldquo;Add an entry&rdquo; to start the list.</p>
          )}
          <ol className="grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-2">
            {rows.map((row, i) => {
              const id = `rl-${key}-item-${i}`;
              const error = listErrors[`items.${i}`] || '';
              const renamed = row.original !== null && row.text.trim() !== row.original;
              const describedBy = [renamed ? `${id}-renamed` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
              return (
                <li key={row.id} data-testid={`rl-${key}-row-${i}`} className="min-w-0">
                  <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-2">
                    <label htmlFor={id} className="pt-2.5 text-[11px] font-bold text-slate-700 dark:text-slate-300">
                      Entry {i + 1}<span className="text-red-700 dark:text-red-400" aria-hidden="true"> *</span>
                    </label>
                    <input
                      id={id}
                      data-testid={id}
                      type="text"
                      value={row.text}
                      onChange={e => editRow(key, i, e.target.value)}
                      disabled={locked}
                      required
                      aria-required="true"
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      {...blockedBy(permission, NOTE_ID)}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      data-testid={`rl-${key}-remove-${i}`}
                      onClick={() => askRemove(key, row, document.querySelector(`[data-testid="rl-${key}-add"]`))}
                      disabled={locked}
                      aria-label={`Remove entry ${i + 1}${row.text.trim() ? ` (${row.text.trim()})` : ''}`}
                      {...(canEdit ? { title: `Remove entry ${i + 1}` } : blockedBy(permission, NOTE_ID))}
                      className="p-2.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                  {renamed && (
                    <p id={`${id}-renamed`} data-testid={`${id}-renamed`} className="ml-[5rem] mt-1 text-[11px] text-amber-800 dark:text-amber-300 leading-snug">
                      Renamed from &ldquo;{row.original}&rdquo;. Profiles that already use &ldquo;{row.original}&rdquo; keep it: renaming does not change them.
                    </p>
                  )}
                  {error && (
                    <p id={`${id}-error`} data-testid={`${id}-error`} role="alert" className="ml-[5rem] mt-1 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
                      <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            data-testid={`rl-${key}-add`}
            onClick={() => addRow(key)}
            disabled={locked}
            {...blockedBy(permission, NOTE_ID)}
            className="mt-3 inline-flex items-center px-3 py-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
          >
            <Plus size={14} className="mr-1.5" aria-hidden="true" /> Add an entry
          </button>
          {listErrors.items && (
            <p data-testid={`rl-${key}-list-error`} role="alert" className="mt-2 flex items-start gap-1 text-[11px] font-bold text-red-700 dark:text-red-400">
              <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {listErrors.items}
            </p>
          )}
        </fieldset>
      </section>
    );
  };

  return (
    <div className="animate-in fade-in duration-300 relative space-y-6">
      {header}
      <PermissionNote id={NOTE_ID} permission={permission} lead="You can view the reference lists." />
      <p className="text-[11px] text-slate-600 dark:text-slate-400">Entries marked <span className="text-red-700 dark:text-red-400" aria-hidden="true">*</span><span className="sr-only">with a star</span> cannot be empty. Each list is saved on its own with its &ldquo;Save list&rdquo; button.</p>
      {Object.keys(lists).map(listCard)}

      {removal && (
        <ConfirmDialog
          testId="rl-remove-confirm"
          title={`Remove "${removal.name}"?`}
          keepLabel="Keep it"
          confirmLabel={`Remove "${removal.name}"`}
          onKeep={() => setRemoval(null)}
          onConfirm={confirmRemove}
          tone="red"
          icon={Trash2}
          returnFocusRef={returnFocusRef}
        >
          Profiles that already use it keep it. The {lists[removal.key].label.toLowerCase()} lose the entry when you press &ldquo;Save list&rdquo;; until then &ldquo;Discard changes&rdquo; brings it back.
        </ConfirmDialog>
      )}

      {/* The live region stays mounted so every message is announced. */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50">
        {toast && (
          <div className="flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md max-w-md">
            <div className="w-7 h-7 rounded-lg bg-purple-500/20 flex items-center justify-center text-purple-300 dark:text-purple-700 shrink-0"><CheckCircle2 size={16} aria-hidden="true" /></div>
            <span data-testid="rl-toast" className="text-xs font-bold tracking-wide">{toast.message}</span>
            {toast.undo && (
              <button type="button" data-testid="rl-undo" onClick={() => { const undo = toast.undo; setToast(null); undo(); }} className="ml-1 px-2.5 py-1 rounded-lg text-xs font-black text-purple-200 dark:text-purple-800 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500">
                Undo
              </button>
            )}
            <button type="button" aria-label="Dismiss message" onClick={() => setToast(null)} className="ml-1 text-slate-300 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 rounded">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
