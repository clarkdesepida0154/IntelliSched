import { useEffect, useRef, useState } from 'react';
import { versionName } from '../../utils/scheduleDisplay';
import {
  AlertOctagon, ArrowRight, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Eye, GitBranch, Loader2, Play, RefreshCw, RotateCcw, Search, X
} from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import PageHeader from '../../components/layout/PageHeader';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import PermissionNote from '../../components/ui/PermissionNote';
import SortableHeader from '../../components/ui/SortableHeader';
import TablePagination from '../../components/ui/TablePagination';
import usePagination from '../../hooks/usePagination';
import usePermission from '../../hooks/usePermission';
import useSort from '../../hooks/useSort';
import useEscapeKey from '../../hooks/useEscapeKey';
import { SOFT_WEIGHTS } from '../../utils/policyLabels';
import { isTbaRoomKey, tbaRoomName, tbaRoomWording } from '../../utils/scheduleDisplay';
import { conflictsText } from '../../utils/gaRun';
import { checkOf, checkText, dateTimeText, restoreBlockedReason, statusBadgeClass, statusOf, VERSION_STATUSES } from '../../utils/versions';

// Versions (Phase 3 Step 5): every saved version of the term's Mother Schedule, newest first, with its
// real status, how it was made, its classes and its last check (GET /schedule/versions). Restoring a
// version asks first and makes a NEW Draft, a copy of it (POST /schedule/restore { mongoId, academicYear,
// semester }): the term's current Draft is archived, the version itself does not change, and an
// approved version stays as it is. The current Draft itself, a version with no classes
// and one in the older format can't be restored (the button says why). "Details" shows the recorded
// facts of a version; the GA's own numbers and settings are under a collapsed "Technical details".
// Test ids: versions-search, versions-table, version-row-{mongoId} (data-status), version-status,
// version-check, version-details-{mongoId}, version-restore-{mongoId}, version-restore-reason-{mongoId},
// restore-confirm(-title | -keep | -confirm | -error), version-details (the dialog), version-facts,
// version-edited-after-run, version-tba-rooms, version-technical-toggle, version-technical,
// version-stats, version-soft-breakdown, version-settings, versions-toast, versions-toast-action,
// versions-loading, versions-error, versions-retry, versions-empty, versions-no-match.

const PAGE_SIZE = 25;
const CONNECTION_HELP = 'Check that the gateway is running, then try again.';

// GET /schedule/versions of the term (newest first).
const fetchVersions = async (academicYear, semester) => {
  const res = await api.get('/schedule/versions', { params: { academicYear, semester } });
  return Array.isArray(res.data?.versions) ? res.data.versions : [];
};
const versionsError = (err) => `The term's versions could not be read (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".`;

// Recorded numbers only: one decimal at most; "Not recorded" when the version has none.
const shown = (n) => (Number.isFinite(n) ? String(Math.round(n * 10) / 10) : 'Not recorded');
const runtimeLabel = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'not recorded');
const classCount = (n) => `${n} class${Number(n) === 1 ? '' : 'es'}`;
// Classes in TBA rooms from the recorded "TBA rooms to request" list, else the recorded count.
const tbaRoomClassCount = (gaStats) => (Array.isArray(gaStats?.extraRoomUse)
  ? gaStats.extraRoomUse.reduce((sum, room) => sum + (room.classes?.length || 0), 0)
  : gaStats?.softCounts?.extraRoomBlocks);
// A TBA room by its TBA name ("TBA room 1 (lab)"), never by its stored name.
const tbaRoomText = (room) => (isTbaRoomKey(room.key) ? tbaRoomName(room.key) : tbaRoomWording(room.name || 'TBA room'));

// Sorting: "Version" by when it was saved (newest first by default), then status, classes, last check.
const SORT_GETTERS = {
  saved: v => v.age,
  status: v => VERSION_STATUSES.indexOf(statusOf(v)),
  classes: v => Number(v.totalScheduled) || 0,
  check: v => checkOf(v)?.hardTotal ?? null
};

// What restoring a version does, in the Dean's words: a copy becomes the new Draft; the current Draft
// is archived (never a legacy one); the version itself does not change.
const restoreLines = (target, current) => {
  const status = statusOf(target);
  const stays = status === 'Approved'
    ? " It stays Approved (the term's official version) until the new Draft is approved."
    : status === 'Under Review' ? ' It stays Under Review.' : '';
  return [
    `A copy of ${target.id} becomes the term's new Draft: the one the views open, and the one you can change.`,
    current ? `${current.id} (the current Draft) is archived.` : 'The term has no other Draft to archive.',
    `${target.id} itself does not change.${stays}`,
    'Faculty assignments stay as they are now.'
  ];
};

// The page for the term chosen in the top bar; a term switch starts it afresh (key).
export default function VersionManager(props) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  return <VersionsPage key={`${activeAcademicYear}|${activeSemesterNumber}`} {...props} />;
}

// The visible reason (Phase 3 Step 6) every Restore button points at while the role may not restore.
const RESTORE_NOTE_ID = 'versions-permission-note';

function VersionsPage({ onNavigate = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  // Restoring a version: the permission map's version.restore. Viewing and Details are open to all.
  const restorePermission = usePermission('version.restore');
  const canRestore = restorePermission.allowed;

  // ---------------------------------------------------------------- the term's versions
  const [list, setList] = useState({ status: 'loading', versions: [], message: '', refreshing: false });
  const loadSeq = useRef(0);
  useEffect(() => {
    const seq = ++loadSeq.current;
    fetchVersions(activeAcademicYear, activeSemesterNumber)
      .then(versions => { if (seq === loadSeq.current) setList({ status: 'ready', versions, message: '', refreshing: false }); })
      .catch(err => { if (seq === loadSeq.current) setList({ status: 'error', versions: [], message: versionsError(err), refreshing: false }); });
    return () => { loadSeq.current += 1; };
  }, [activeAcademicYear, activeSemesterNumber]);
  const loadVersions = async ({ refresh = false } = {}) => {
    const seq = ++loadSeq.current;
    setList(prev => (refresh ? { ...prev, refreshing: true } : { status: 'loading', versions: [], message: '', refreshing: false }));
    try {
      const versions = await fetchVersions(activeAcademicYear, activeSemesterNumber);
      if (seq === loadSeq.current) setList({ status: 'ready', versions, message: '', refreshing: false });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      const message = versionsError(err);
      setList(prev => (refresh && prev.status === 'ready' ? { ...prev, refreshing: false, message } : { status: 'error', versions: [], message, refreshing: false }));
    }
  };

  // ---------------------------------------------------------------- toast
  // { message, action: { label, onClick } | null }
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = (message, action = null) => {
    setToast({ message, action });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), action ? 10000 : 6000);
  };
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // ---------------------------------------------------------------- search, sorting, pages
  const versions = list.versions;
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const rows = versions.map((v, i) => ({ ...v, age: versions.length - i }));
  const filtered = query
    ? rows.filter(v => [v.id, statusOf(v), v.source, v.date, v.currentDraft ? 'current draft' : ''].some(text => String(text || '').toLowerCase().includes(query)))
    : rows;
  const { sorted, sort, toggle: toggleSort } = useSort(filtered, SORT_GETTERS, 'saved', 'desc');
  const { currentPage, totalPages, totalItems, pageItems, rangeLabel, setPage, resetPage } = usePagination(sorted, PAGE_SIZE);
  const changeSearch = (value) => {
    setSearch(value);
    resetPage();
  };

  // ---------------------------------------------------------------- details
  const [detailsId, setDetailsId] = useState(null);
  const details = detailsId ? versions.find(v => String(v.mongoId) === detailsId) || null : null;

  // ---------------------------------------------------------------- restore
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const tableRef = useRef(null);
  // The Draft a restore replaces: the term's current Draft (a legacy one is never changed).
  const currentDraft = versions.find(v => v.currentDraft && !v.legacy) || null;

  const askRestore = (v) => {
    if (!canRestore || restoreBlockedReason(v) || isRestoring) return;
    setRestoreError('');
    setRestoreTarget(v);
  };
  const keepVersion = () => {
    if (isRestoring) return;
    setRestoreTarget(null);
    setRestoreError('');
  };
  const confirmRestore = async () => {
    const target = restoreTarget;
    if (!target || isRestoring) return;
    setIsRestoring(true);
    setRestoreError('');
    try {
      const res = await api.post('/schedule/restore', {
        mongoId: String(target.mongoId),
        academicYear: activeAcademicYear,
        semester: activeSemesterNumber
      });
      setRestoreTarget(null);
      const copy = res.data?.schedule || null;
      const copyId = copy?._id ? String(copy._id) : '';
      showToast(
        res.data?.message || `${target.id} was restored as a new Draft.`,
        copyId && onNavigate ? { label: `Open ${versionName(copy.version) || 'the new Draft'}`, onClick: () => onNavigate('schedule-views', { scheduleId: copyId }) } : null
      );
      loadVersions({ refresh: true });
    } catch (err) {
      const code = err.response?.status;
      const body = err.response?.data || {};
      if (code === 400 || code === 403 || code === 404 || code === 409) {
        setRestoreError(`${body.message || 'This version could not be restored.'} Nothing changed.`);
        // The version may have changed meanwhile (restored or signed off elsewhere): read the list again.
        if (code !== 403) loadVersions({ refresh: true });
      } else {
        setRestoreError(`The version could not be restored (${body.message || err.message}). Nothing changed. ${CONNECTION_HELP}`);
      }
    } finally {
      setIsRestoring(false);
    }
  };

  const smallButton = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1';
  const primaryLink = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border cursor-pointer text-white bg-violet-600 hover:bg-violet-700 border-violet-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-violet-500';

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-6">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="versions" />
          {list.status === 'ready' && versions.length > 0 && (
            <div className="relative w-full lg:w-64 shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(e) => changeSearch(e.target.value)}
                placeholder="Search versions…"
                aria-label="Search versions by name, status or how they were made"
                data-testid="versions-search"
                className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500 text-slate-900 dark:text-white"
              />
            </div>
          )}
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {list.message && list.status === 'ready' && (
          <p role="alert" className="mx-6 mt-4 text-xs font-bold text-red-700 dark:text-red-400">{list.message}</p>
        )}

        {!canRestore && list.status === 'ready' && versions.length > 0 && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={RESTORE_NOTE_ID} permission={restorePermission} lead="You can view every version and its details." />
          </div>
        )}

        {/* VERSIONS TABLE */}
        <div ref={tableRef} tabIndex={-1} className="overflow-x-auto relative min-h-[200px] custom-scrollbar focus:outline-none">
          {list.status === 'loading' ? (
            <div data-testid="versions-loading" role="status" className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-300 gap-3">
              <Loader2 size={36} className="animate-spin text-violet-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Reading the term&apos;s versions…</p>
            </div>
          ) : list.status === 'error' ? (
            <div data-testid="versions-error" role="alert" className="p-12 text-center max-w-lg mx-auto my-6">
              <AlertOctagon size={40} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The versions can&apos;t be shown</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-4">{list.message}</p>
              <button type="button" data-testid="versions-retry" onClick={() => loadVersions()} className={`${primaryLink} mx-auto`}>
                <RefreshCw size={13} aria-hidden="true" /> Try again
              </button>
            </div>
          ) : versions.length === 0 ? (
            <div data-testid="versions-empty" className="p-12 text-center max-w-md mx-auto my-6">
              <CalendarDays size={40} className="text-slate-400 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">No versions yet</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-4">No schedule has been generated for this term yet. Each run of Generate Schedule saves a new Draft here.</p>
              {onNavigate && (
                <button type="button" data-testid="versions-open-generate" onClick={() => onNavigate('generate')} className={`${primaryLink} mx-auto`}>
                  <Play size={13} aria-hidden="true" /> Open Generate Schedule
                </button>
              )}
            </div>
          ) : (
            <table data-testid="versions-table" className="w-full text-left text-sm">
              <caption className="sr-only">The term&apos;s saved versions</caption>
              <thead className="bg-slate-50 dark:bg-[#0f0f11] border-b border-slate-200 dark:border-slate-800/60 text-slate-600 dark:text-slate-400">
                <tr>
                  <SortableHeader label="Version" sortKey="saved" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Classes" sortKey="classes" sort={sort} onSort={toggleSort} className="text-center" align="center" />
                  <SortableHeader label="Last check" sortKey="check" sort={sort} onSort={toggleSort} />
                  <th scope="col" className="px-6 py-4 font-bold text-xs text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} data-testid="versions-no-match" className="p-10 text-center text-sm text-slate-700 dark:text-slate-300">
                      No version matches &ldquo;{search.trim()}&rdquo;.{' '}
                      <button type="button" onClick={() => changeSearch('')} className="font-bold text-violet-700 dark:text-violet-300 underline cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded">Clear the search</button>
                    </td>
                  </tr>
                ) : pageItems.map((v) => {
                  const vid = String(v.mongoId);
                  const status = statusOf(v);
                  const check = checkOf(v);
                  const blocked = restoreBlockedReason(v);
                  return (
                    <tr key={vid} data-testid={`version-row-${vid}`} data-status={status} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors align-top">
                      <td className="px-6 py-3.5 min-w-40">
                        <p className="font-black text-violet-700 dark:text-violet-300 font-mono text-sm">{versionName(v.id)}</p>
                        <p className="text-xs text-slate-700 dark:text-slate-300">Saved {v.date}</p>
                        <p className="text-xs text-slate-600 dark:text-slate-400">{v.source}</p>
                      </td>
                      <td className="px-6 py-3.5">
                        <span data-testid="version-status" className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold border whitespace-nowrap ${statusBadgeClass(status)}`}>
                          {status}
                        </span>
                        {v.currentDraft && <p data-testid="version-current" className="mt-1 text-[11px] font-bold text-amber-900 dark:text-amber-300">Current Draft</p>}
                      </td>
                      <td className="px-6 py-3.5 text-center font-bold text-slate-900 dark:text-white text-xs">{v.totalScheduled}</td>
                      <td data-testid="version-check" className="px-6 py-3.5 text-xs">
                        {check ? (
                          <>
                            <p className={`font-bold ${check.hardTotal === 0 ? 'text-green-800 dark:text-green-300' : 'text-red-700 dark:text-red-400'}`}>
                              {conflictsText(check.hardTotal)}
                            </p>
                            <p className="text-slate-600 dark:text-slate-400">checked {dateTimeText(check.checkedAt)}</p>
                          </>
                        ) : (
                          <p className="text-slate-600 dark:text-slate-400">{v.legacy || !(Number(v.totalScheduled) > 0) ? '—' : 'Not checked yet'}</p>
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          <button
                            type="button"
                            data-testid={`version-details-${vid}`}
                            onClick={() => setDetailsId(vid)}
                            aria-label={`Details of ${v.id}`}
                            className={`${smallButton} text-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800`}
                          >
                            <Eye size={13} aria-hidden="true" /> Details
                          </button>
                          {/* A role that may not restore is told once, in the page's note (not on every row). */}
                          <button
                            type="button"
                            data-testid={`version-restore-${vid}`}
                            onClick={() => askRestore(v)}
                            disabled={!canRestore || Boolean(blocked) || isRestoring}
                            aria-label={`Restore ${v.id} as a new Draft`}
                            title={canRestore ? undefined : restorePermission.reason}
                            aria-describedby={!canRestore ? RESTORE_NOTE_ID : blocked ? `version-restore-reason-${vid}` : undefined}
                            className={`${smallButton} text-violet-800 dark:text-violet-200 border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10 enabled:hover:bg-violet-100 dark:enabled:hover:bg-violet-500/20`}
                          >
                            <RotateCcw size={13} aria-hidden="true" /> Restore
                          </button>
                          {blocked && canRestore && (
                            <p id={`version-restore-reason-${vid}`} data-testid={`version-restore-reason-${vid}`} className="max-w-56 text-[11px] text-slate-600 dark:text-slate-400 text-right">{blocked}</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* FOOTER */}
        {list.status === 'ready' && versions.length > 0 && (
          <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p data-testid="versions-count" className="text-xs text-slate-600 dark:text-slate-400">
              Showing <span className="font-bold text-slate-800 dark:text-slate-200">{rangeLabel}</span> of{' '}
              <span className="font-bold text-slate-800 dark:text-slate-200">{totalItems}</span> version{totalItems === 1 ? '' : 's'}
              {list.refreshing && <span role="status" className="ml-2 inline-flex items-center"><Loader2 size={12} className="animate-spin mr-1" aria-hidden="true" /> Reading the versions again…</span>}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Version pages" showSync={false} />
            </div>
          </div>
        )}
      </div>

      {details && (
        <VersionDetails
          v={details}
          onClose={() => setDetailsId(null)}
          onOpen={onNavigate && Number(details.totalScheduled) > 0 && !details.legacy
            ? () => onNavigate('schedule-views', { scheduleId: String(details.mongoId) })
            : null}
        />
      )}

      {restoreTarget && (
        <ConfirmDialog
          testId="restore-confirm"
          title={`Restore ${restoreTarget.id} as a new Draft?`}
          keepLabel="Cancel"
          confirmLabel={`Restore ${restoreTarget.id} as a new Draft`}
          busyLabel="Restoring…"
          onKeep={keepVersion}
          onConfirm={confirmRestore}
          busy={isRestoring}
          error={restoreError}
          tone="violet"
          icon={RotateCcw}
          returnFocusRef={tableRef}
        >
          {restoreLines(restoreTarget, currentDraft && String(currentDraft.mongoId) !== String(restoreTarget.mongoId) ? currentDraft : null)
            .map((line, i) => <p key={i} className={i ? 'mt-2' : ''}>{line}</p>)}
        </ConfirmDialog>
      )}

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 dark:bg-violet-500/15 flex items-center justify-center text-violet-400 dark:text-violet-600 shrink-0">
            <CheckCircle2 size={16} aria-hidden="true" />
          </div>
          <span data-testid="versions-toast" className="text-xs font-bold tracking-wide">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              data-testid="versions-toast-action"
              onClick={() => { const action = toast.action; setToast(null); action.onClick(); }}
              className="ml-1 shrink-0 px-2.5 py-1 rounded-lg text-xs font-black text-violet-300 dark:text-violet-700 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-1 text-slate-400 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

// The recorded facts of one version, in the Dean's words; the GA's own numbers and settings are under
// "Technical details" (collapsed). Escape or Close closes it; Tab stays inside.
function VersionDetails({ v, onClose, onOpen }) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus(); };
  }, []);
  useEscapeKey(true, onClose);
  const keepFocusInside = (e) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const status = statusOf(v);
  const stats = v.gaStats || null;
  const settings = v.hyperparameters || null;
  const moves = Number(stats?.editedAfterRun ?? v.editedAfterRun) || 0;
  const tbaRooms = Array.isArray(stats?.extraRoomUse) ? stats.extraRoomUse : [];
  const facts = [
    ['Saved', v.date],
    ['Status', `${status}${v.currentDraft ? ' (the current Draft)' : ''}`],
    ['How it was made', v.source],
    ['Classes', String(v.totalScheduled)],
    ['Last check', v.legacy ? 'Not checked (older format)' : checkText(checkOf(v))],
    // Phase 8 Part 3: the version's notes (e.g. an On-The-Job Training coordination whose hours did
    // not fit one weekday and were split over two days).
    ...(Array.isArray(v.notes) && v.notes.length ? [['Notes', v.notes.join(' ')]] : [])
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-details-title"
        data-testid="version-details"
        onKeyDown={keepFocusInside}
        className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
      >
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between">
          <h3 id="version-details-title" className="text-lg font-black text-slate-800 dark:text-white flex items-center">
            <GitBranch size={18} className="mr-2 text-violet-600 dark:text-violet-400" aria-hidden="true" /> Details of {v.id}
          </h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close the details"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 p-1.5 rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm overflow-y-auto">
          <dl data-testid="version-facts" className="space-y-1.5">
            {facts.map(([label, value]) => (
              <div key={label} className="flex gap-3">
                <dt className="w-36 shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 pt-0.5">{label}</dt>
                <dd className="min-w-0 text-sm font-semibold text-slate-900 dark:text-white">{value}</dd>
              </div>
            ))}
            {stats && (
              <>
                <div className="flex gap-3">
                  <dt className="w-36 shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 pt-0.5">Class moves</dt>
                  <dd data-testid="version-edited-after-run" className="min-w-0 text-sm font-semibold text-slate-900 dark:text-white">
                    {moves > 0 ? `${moves} class move${moves === 1 ? '' : 's'} made in the Schedule Views & Editor since the run.` : 'No class moved since the run.'}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-36 shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 pt-0.5">Classes in TBA rooms</dt>
                  <dd data-testid="version-tba-rooms" className="min-w-0 text-sm font-semibold text-slate-900 dark:text-white">
                    {shown(tbaRoomClassCount(stats))}
                    {tbaRooms.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 space-y-0.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                        {tbaRooms.map(room => (
                          <li key={room.key}>{tbaRoomText(room)}: {classCount(room.classes?.length || 0)} (to request)</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              </>
            )}
          </dl>

          {stats ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                data-testid="version-technical-toggle"
                aria-expanded={technicalOpen}
                aria-controls="version-technical"
                onClick={() => setTechnicalOpen(open => !open)}
                className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs font-bold text-slate-800 dark:text-slate-100 cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                Technical details
                {technicalOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              </button>
              <div id="version-technical" data-testid="version-technical" hidden={!technicalOpen} className="px-3.5 pb-3.5 space-y-3">
                <p data-testid="version-stats" className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  The GA placed <strong>{v.totalScheduled}</strong> classes: conflicts went from <strong>{shown(stats.initialHard)}</strong> to <strong>{shown(stats.finalHard)}</strong> in <strong>{shown(stats.generations)}</strong> generations ({runtimeLabel(stats.runtimeMs)}); soft penalty {shown(stats.soft)}.
                </p>
                <div data-testid="version-soft-breakdown">
                  <p className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-1">Soft penalty by rule</p>
                  {stats.softBreakdown ? (
                    <table className="w-full text-xs">
                      <thead className="sr-only">
                        <tr><th scope="col">Rule</th><th scope="col">Occurrences</th><th scope="col">Penalty</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                        {SOFT_WEIGHTS.map((w, idx) => {
                          const count = stats.softCounts?.[w.countKey];
                          // Phase 8 Part 6: the two professor single-day weights share one penalty
                          // term, so its total shows once (on the first row), never twice.
                          const firstOfTerm = SOFT_WEIGHTS.findIndex(x => x.term === w.term) === idx;
                          return (
                            <tr key={w.key}>
                              <td className="py-1.5 pr-2 font-medium text-slate-700 dark:text-slate-300">{w.label}</td>
                              <td className="py-1.5 pr-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{Number.isFinite(count) ? `${shown(count)} ${count === 1 ? w.countUnit.replace(/s$/, '') : w.countUnit}` : ''}</td>
                              <td className="py-1.5 text-right font-bold text-slate-800 dark:text-white">{firstOfTerm ? shown(stats.softBreakdown[w.term]) : ''}</td>
                            </tr>
                          );
                        })}
                        <tr>
                          <td className="py-1.5 pr-2 font-black text-slate-800 dark:text-white" colSpan={2}>Total</td>
                          <td className="py-1.5 text-right font-black text-slate-800 dark:text-white">{shown(stats.softTotal)}</td>
                        </tr>
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-xs text-slate-600 dark:text-slate-400">Not recorded: this version was saved before the soft penalty was broken down by rule.</p>
                  )}
                </div>
                {settings ? (
                  <dl data-testid="version-settings" className="grid grid-cols-2 gap-2">
                    {[
                      // Phase 2 settings (mode, time budget, generation cap); older versions stored "generations".
                      ['GA', { memetic: 'Improved GA (memetic)', baseline: 'Phase 1 GA (baseline)' }[stats.mode || settings.mode]],
                      ['Time limit', Number.isFinite(settings.timeBudgetSeconds) ? `${Math.round(settings.timeBudgetSeconds / 6) / 10} min` : null],
                      ['Population size', settings.populationSize],
                      ['Generation limit', settings.maxGenerations ?? settings.generations],
                      ['Mutation rate', settings.mutationRate],
                      ['Seed', stats.seed ?? settings.seed]
                    ].map(([label, value]) => (
                      <div key={label} className="p-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg border border-slate-200 dark:border-slate-700">
                        <dt className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">{label}</dt>
                        <dd className="text-sm font-black text-slate-800 dark:text-white">{value ?? 'Not recorded'}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-xs text-slate-600 dark:text-slate-400">No GA settings are stored for this version.</p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-600 dark:text-slate-400">No run facts are stored for this version.</p>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex flex-wrap justify-end gap-2">
          {onOpen && (
            <button type="button" data-testid="version-open" onClick={onOpen} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-violet-500">
              Open in the Schedule Views &amp; Editor <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
