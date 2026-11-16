import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  Search, Plus, Layers, Loader2, CheckCircle2, X, AlertCircle, AlertOctagon,
  TriangleAlert, Trash2, Info, Link2
} from 'lucide-react';
import api from '../../../services/api';
import { useTerm } from '../../../context/term';
import { resolveSubjectType } from '../../../utils/subjectType';
import {
  MAPPING_PROGRAMS, SUBJECT_TRACKS, BSIT_TRACKS, YEAR_LEVEL_LABELS, SEMESTER_LABELS,
  mappingPrograms, isTrackAllowed
} from '../../../utils/sectionMatcher';
import usePagination from '../../../hooks/usePagination';
import useEscapeKey from '../../../hooks/useEscapeKey';
import usePolicy from '../../../hooks/usePolicy';
import usePermission, { blockedBy } from '../../../hooks/usePermission';
import TablePagination from '../../../components/ui/TablePagination';
import { disabledCellClass } from '../../../components/ui/tableStyles';
import {
  formatHours, contactHoursOf, readStorage, writeStorage, typeBadgeClass, minorStripClass, routingOf,
  trapTabKey, focusFirstAvailable
} from './subjectFormat';
import Select from '../../../components/ui/Select';

const CONTEXT_STORAGE_KEY = 'intellisched.curriculumBuilder.context';
const FETCH_ERROR_MESSAGE = 'This curriculum block could not be loaded. Check your connection, then try again.';
const CATALOG_ERROR_MESSAGE = 'The Master Catalog could not be loaded. Check your connection, then try again.';
// The picker lives in a dialog, so it pages shorter than the 15-row tables.
const ATTACH_PAGE_SIZE = 8;
// NSTP is a 1st-year subject; the gateway refuses any other placement.
const NSTP_YEAR_LEVEL = '1st Year';

const PROGRAM_LABELS = { BSIT: 'BSIT', BSCS: 'BSCS', Both: 'Both (BSIT + BSCS)' };

// CORE subjects go to every section of the block's programs; a specialization subject only to
// sections on that track. The BSIT tracks exist in 3rd and 4th year only, and IS is the BSCS track.
const TRACK_DESCRIPTIONS = {
  CORE: 'every section of the program',
  WMAD: 'Web and Mobile Application Development',
  SMP: 'Service Management Program',
  AMG: 'Animation and Motion Graphics',
  IS: 'Intelligence Systems'
};
const trackRestriction = (track) => (BSIT_TRACKS.includes(track) ? 'BSIT 3rd–4th Year only' : track === 'IS' ? 'BSCS only' : '');

// Tag colours for catalog subjects that cannot be attached (full strings for Tailwind).
const TAG_TONES = {
  green: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20',
  blue: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20',
  slate: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  yellow: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/20'
};

// The saved context, with every value this build no longer offers replaced by its default. The
// semester falls back to the globally active term.
const loadContext = (fallbackSemester) => {
  const saved = readStorage(CONTEXT_STORAGE_KEY) || {};
  const context = {
    program: MAPPING_PROGRAMS.includes(saved.program) ? saved.program : 'BSIT',
    yearLevel: YEAR_LEVEL_LABELS.includes(saved.yearLevel) ? saved.yearLevel : YEAR_LEVEL_LABELS[0],
    semester: SEMESTER_LABELS.includes(saved.semester)
      ? saved.semester
      : SEMESTER_LABELS.includes(fallbackSemester) ? fallbackSemester : SEMESTER_LABELS[0],
    track: SUBJECT_TRACKS.includes(saved.track) ? saved.track : 'CORE'
  };
  if (!isTrackAllowed(context.program, context.yearLevel, context.track)) context.track = 'CORE';
  return context;
};

// Identifies one load of one block; the retry bumps the token so the same block loads again.
const blockKey = (context, reloadToken) =>
  `${context.program}|${context.yearLevel}|${context.semester}|${context.track}#${reloadToken}`;

const contextLabelOf = (context) => `${context.program} · ${context.yearLevel} · ${context.semester} · ${context.track}`;

const fetchMappings = async (params) => {
  const res = await api.get('/curriculum-mappings', { params });
  return Array.isArray(res.data) ? res.data : [];
};

// Rows of a block that has not loaded, or failed to.
const EMPTY_BLOCK_ROWS = { mappings: [], sharedMappings: [], programMappings: [] };

// Single read path for a block: its own mappings plus two best-effort lookups that never fail it.
// - sharedMappings (BSIT or BSCS block): the 'Both' mappings with the same year, semester and
//   track, which reach these sections too.
// - programMappings (Both block): the BSIT and BSCS mappings with the same year, semester and
//   track. The gateway refuses (409) to file any of their subjects under Both as well.
const fetchBlock = async (context) => {
  const isBoth = context.program === 'Both';
  const bestEffort = (program) => fetchMappings({ ...context, program }).catch(() => []);
  const [mappings, sharedMappings, programMappings] = await Promise.all([
    fetchMappings(context),
    isBoth ? [] : bestEffort('Both'),
    isBoth ? Promise.all(mappingPrograms('Both').map(bestEffort)).then(lists => lists.flat()) : []
  ]);
  return { mappings, sharedMappings, programMappings };
};

// Which sections a block's subjects reach, in the GA's own terms.
const reachLabelOf = (context) => {
  const programs = mappingPrograms(context.program).join(' and ');
  return context.track === 'CORE'
    ? `Subjects here reach every ${programs} ${context.yearLevel} section in the ${context.semester}.`
    : `Subjects here reach only ${programs} ${context.yearLevel} sections on ${context.track}, which also take every CORE subject of their year.`;
};

function ContextSelect({ id, label, value, onChange, options }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">{label}</label>
      <div className="relative">
        <Select
          id={id}
          data-testid={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full truncate bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 pl-3.5 pr-3 text-sm font-bold text-slate-800 dark:text-white focus:outline-none focus:border-yellow-500 hover:border-yellow-300 dark:hover:border-yellow-500/40 transition-colors cursor-pointer"
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
          ))}
        </Select>
      </div>
    </div>
  );
}

// `editNoteId`: the page's visible note with the reason why this role may not change the curriculum
// (Phase 3 Step 6); the Attach and Detach controls point at it while they are closed.
export default function CurriculumBuilderTab({ onToast, editNoteId }) {
  const { policy } = usePolicy();
  // Attaching and detaching subjects: the permission map's data.edit.
  const edit = usePermission('data.edit');
  const { activeSemester } = useTerm();
  const [context, setContext] = useState(() => loadContext(activeSemester));
  const [reloadToken, setReloadToken] = useState(0);
  // The last settled load: which block it was for, its rows, and its error. While `key` differs
  // from the current block's key, the block is loading.
  const [block, setBlock] = useState({ key: null, ...EMPTY_BLOCK_ROWS, error: '' });
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  // Attach dialog
  const [isAttachOpen, setIsAttachOpen] = useState(false);
  const [catalog, setCatalog] = useState({ status: 'idle', items: [], error: '', syncedAt: null });
  const [attachSearch, setAttachSearch] = useState('');
  const [selectedSubjectId, setSelectedSubjectId] = useState(null);
  const [attachError, setAttachError] = useState('');
  const [isAttaching, setIsAttaching] = useState(false);

  // Detach confirmation
  const [detachTarget, setDetachTarget] = useState(null);
  const [detachError, setDetachError] = useState('');
  const [isDetaching, setIsDetaching] = useState(false);

  // Monotonic tickets: a slower, older response must never overwrite a newer one.
  const syncSeq = useRef(0);
  const catalogSeq = useRef(0);
  const tableRegionRef = useRef(null);
  const attachButtonRef = useRef(null);
  const attachOpenerRef = useRef(null);
  const detachOpenerRef = useRef(null);

  // Loads the block whenever the context changes (or a retry asks again). Every state update runs
  // after the request settles, so the loading state is derived from block.key instead of set here.
  useEffect(() => {
    let cancelled = false;
    const key = blockKey(context, reloadToken);
    const seq = ++syncSeq.current;

    fetchBlock(context)
      .then(data => {
        if (cancelled || seq !== syncSeq.current) return;
        setBlock({ key, ...data, error: '' });
        setLastSyncedAt(new Date());
      })
      .catch(err => {
        if (cancelled || seq !== syncSeq.current) return;
        console.warn('[CurriculumMapping] Atlas fetch failed:', err.message);
        setBlock({ key, ...EMPTY_BLOCK_ROWS, error: err.response?.data?.message || FETCH_ERROR_MESSAGE });
      })
      .finally(() => {
        // This load is the latest request, so it owns the indicator: a re-sync it superseded
        // is barred from clearing it.
        if (!cancelled && seq === syncSeq.current) setIsSyncing(false);
      });

    return () => { cancelled = true; };
  }, [context, reloadToken]);

  // Persist the context so the Dean returns to the block being worked on.
  useEffect(() => {
    writeStorage(CONTEXT_STORAGE_KEY, context);
  }, [context]);

  const currentKey = blockKey(context, reloadToken);
  const isLoading = block.key !== currentKey;
  const errorMessage = isLoading ? '' : block.error;
  const mappings = isLoading ? [] : block.mappings;
  const sharedMappings = isLoading || context.program === 'Both' ? [] : block.sharedMappings;
  const programMappings = isLoading || context.program !== 'Both' ? [] : block.programMappings;
  const contextLabel = contextLabelOf(context);

  // The committed block key. A mutation that settles after the Dean picked another block reads
  // it to leave that block's own load in charge.
  const currentKeyRef = useRef(currentKey);
  useLayoutEffect(() => {
    currentKeyRef.current = currentKey;
  }, [currentKey]);

  // Only an existing, active catalog subject is scheduled; the rest are listed with a warning.
  const scheduledMappings = mappings.filter(m => m.subject && m.subject.isActive !== false);
  const unscheduledCount = mappings.length - scheduledMappings.length;
  const totalUnits = scheduledMappings.reduce((sum, m) => sum + (Number(m.subject.units) || 0), 0);
  const totalContactHours = scheduledMappings.reduce((sum, m) => sum + contactHoursOf(m.subject), 0);

  const { currentPage, totalPages, totalItems, pageItems, rangeLabel, setPage, resetPage } = usePagination(mappings, 25);

  // Program or year changes can strand the chosen track (e.g. WMAD after switching to BSCS); it
  // falls back to CORE, which fits every block.
  const updateContext = (key, value) => {
    setContext(prev => {
      const next = { ...prev, [key]: value };
      if (!isTrackAllowed(next.program, next.yearLevel, next.track)) next.track = 'CORE';
      return next;
    });
    resetPage();
  };

  // Error-state retry: a new key shows the loading state and the effect loads the block again.
  const handleRetry = () => setReloadToken(token => token + 1);

  // Silent revalidation after every successful mutation. The optimistic local update has already
  // rendered; this swaps it for Atlas truth without flashing a loading state. It re-syncs the
  // block of the render the mutation started in (currentKey and context of this closure): once
  // the Dean has moved to another block, that block's own load owns the table, so a late re-sync
  // must neither take the newest ticket nor settle anything.
  const revalidate = async () => {
    const key = currentKey;
    if (currentKeyRef.current !== key) return;
    const seq = ++syncSeq.current;
    setIsSyncing(true);
    try {
      const data = await fetchBlock(context);
      if (seq !== syncSeq.current || currentKeyRef.current !== key) return;
      setBlock({ key, ...data, error: '' });
      setLastSyncedAt(new Date());
    } catch (err) {
      console.warn('[CurriculumMapping] Revalidation skipped:', err.message);
      // A transient failure keeps the optimistic rows, unless this re-sync overtook the block's
      // first load: then it settles the block as offline so the spinner never sticks.
      if (seq === syncSeq.current && currentKeyRef.current === key) {
        setBlock(prev => (prev.key === key ? prev : { key, ...EMPTY_BLOCK_ROWS, error: FETCH_ERROR_MESSAGE }));
      }
    } finally {
      if (seq === syncSeq.current) setIsSyncing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Attach dialog
  // ---------------------------------------------------------------------------
  const attachedIds = new Set(mappings.map(m => m.subject?._id).filter(Boolean));
  const sharedIds = new Set(sharedMappings.map(m => m.subject?._id).filter(Boolean));
  // Both block only: subject id -> the programs (BSIT, BSCS) that already file it here.
  const filedProgramsById = new Map();
  for (const m of programMappings) {
    const id = m.subject?._id;
    if (!id) continue;
    const programs = filedProgramsById.get(id) || [];
    if (!programs.includes(m.program)) filedProgramsById.set(id, [...programs, m.program]);
  }

  // Why a catalog subject cannot be attached to this block, or null when it can.
  const blockerOf = (subject) => {
    if (attachedIds.has(subject._id)) return { tag: 'Attached', tone: 'green' };
    if (sharedIds.has(subject._id)) return { tag: 'Filed under Both', tone: 'blue' };
    const filedUnder = filedProgramsById.get(subject._id);
    if (filedUnder) return { tag: `Filed under ${filedUnder.join(' + ')}`, tone: 'blue' };
    if (!subject.isActive) return { tag: 'Disabled', tone: 'slate' };
    if (resolveSubjectType(subject) === 'NSTP' && context.yearLevel !== NSTP_YEAR_LEVEL) {
      return { tag: '1st Year only', tone: 'yellow', note: 'NSTP can only be placed in a 1st Year curriculum.' };
    }
    return null;
  };

  const attachQuery = attachSearch.trim().toLowerCase();
  const catalogMatches = catalog.items.filter(s => !attachQuery
    || (s.subjectCode || '').toLowerCase().includes(attachQuery)
    || (s.descriptiveTitle || '').toLowerCase().includes(attachQuery));
  const {
    currentPage: attachPage,
    totalPages: attachTotalPages,
    totalItems: attachTotalItems,
    pageItems: attachPageItems,
    rangeLabel: attachRangeLabel,
    setPage: setAttachPage,
    resetPage: resetAttachPage
  } = usePagination(catalogMatches, ATTACH_PAGE_SIZE);

  const selectedSubject = catalog.items.find(s => s._id === selectedSubjectId) || null;
  const canAttach = Boolean(selectedSubject) && !blockerOf(selectedSubject) && !isAttaching;

  const loadCatalog = async () => {
    const seq = ++catalogSeq.current;
    setCatalog(prev => ({ ...prev, status: 'loading', error: '' }));
    try {
      const res = await api.get('/catalog');
      if (seq !== catalogSeq.current) return;
      setCatalog({ status: 'ready', items: Array.isArray(res.data) ? res.data : [], error: '', syncedAt: new Date() });
    } catch (err) {
      if (seq !== catalogSeq.current) return;
      setCatalog({ status: 'error', items: [], error: err.response?.data?.message || CATALOG_ERROR_MESSAGE, syncedAt: null });
    }
  };

  // The catalog is fetched fresh on every open, so subjects added or disabled in the Master
  // Catalog tab show up here without a page reload.
  const openAttachModal = (event) => {
    if (!edit.allowed) return;
    attachOpenerRef.current = event?.currentTarget ?? null;
    setAttachSearch('');
    setSelectedSubjectId(null);
    setAttachError('');
    resetAttachPage();
    setIsAttachOpen(true);
    loadCatalog();
  };

  // Single dismissal path (Escape, backdrop, header X, Cancel); ignored while a request is in flight.
  const closeAttachModal = () => {
    if (isAttaching) return;
    setIsAttachOpen(false);
    setAttachError('');
    focusFirstAvailable(attachOpenerRef.current, attachButtonRef.current, tableRegionRef.current);
  };

  useEscapeKey(isAttachOpen, closeAttachModal, isAttaching);

  const handleAttachSearch = (value) => {
    setAttachSearch(value);
    resetAttachPage();
  };

  const handleAttach = async (e) => {
    e.preventDefault();
    if (!canAttach) return;
    const subject = selectedSubject;
    const key = currentKey;
    setIsAttaching(true);
    setAttachError('');

    try {
      const res = await api.post('/curriculum-mappings', { ...context, subject: subject._id });
      setBlock(prev => (prev.key === key ? { ...prev, mappings: [...prev.mappings, res.data] } : prev));
    } catch (err) {
      // 400 (scope rule or disabled subject), 404 (subject gone) and 409 (already placed) all
      // carry the gateway's own explanation.
      setAttachError(err.response?.data?.message || 'Failed to attach the subject. Please try again.');
      setIsAttaching(false);
      return;
    }

    setIsAttaching(false);
    setIsAttachOpen(false);
    onToast(`${subject.subjectCode} attached to ${contextLabel}.`);
    // The toolbar Attach button stays in place, ready for the next subject (an empty-state opener
    // is replaced by the new row). It is disabled while another block loads.
    focusFirstAvailable(attachButtonRef.current, tableRegionRef.current);
    await revalidate();
  };

  // ---------------------------------------------------------------------------
  // Detach confirmation
  // ---------------------------------------------------------------------------
  const openDetach = (mapping, event) => {
    if (!edit.allowed) return;
    detachOpenerRef.current = event?.currentTarget ?? null;
    setDetachError('');
    setDetachTarget(mapping);
  };

  const closeDetach = () => {
    if (isDetaching) return;
    setDetachTarget(null);
    setDetachError('');
    focusFirstAvailable(detachOpenerRef.current, tableRegionRef.current);
  };

  useEscapeKey(Boolean(detachTarget), closeDetach, isDetaching);

  const handleDetach = async () => {
    const mapping = detachTarget;
    if (!mapping || isDetaching) return;
    const code = mapping.subject?.subjectCode || 'The removed subject';
    const key = currentKey;
    setIsDetaching(true);
    setDetachError('');

    let alreadyGone = false;
    try {
      await api.delete(`/curriculum-mappings/${mapping._id}`);
    } catch (err) {
      // 404: someone else detached it first; the block just needs to catch up.
      alreadyGone = err.response?.status === 404;
      if (!alreadyGone) {
        setDetachError(err.response?.data?.message || 'Failed to detach the subject. Please try again.');
        setIsDetaching(false);
        return;
      }
    }

    setBlock(prev => (prev.key === key
      ? { ...prev, mappings: prev.mappings.filter(m => m._id !== mapping._id) }
      : prev));
    setIsDetaching(false);
    setDetachTarget(null);
    onToast(alreadyGone
      ? `${code} was already detached from ${contextLabel}.`
      : `${code} detached from ${contextLabel}. It stays in the Master Catalog.`);
    // The row is gone, so its Detach button cannot take focus back.
    tableRegionRef.current?.focus();
    await revalidate();
  };

  // ---------------------------------------------------------------------------
  // Context bar options
  // ---------------------------------------------------------------------------
  const programOptions = MAPPING_PROGRAMS.map(value => ({ value, label: PROGRAM_LABELS[value] }));
  const yearOptions = YEAR_LEVEL_LABELS.map(value => ({ value, label: value }));
  const semesterOptions = SEMESTER_LABELS.map(value => ({ value, label: value }));
  const trackOptions = SUBJECT_TRACKS.map(track => {
    const allowed = isTrackAllowed(context.program, context.yearLevel, track);
    return {
      value: track,
      disabled: !allowed,
      label: `${track} — ${TRACK_DESCRIPTIONS[track]}${allowed ? '' : ` (${trackRestriction(track)})`}`
    };
  });

  const blockUnavailable = isLoading || Boolean(errorMessage);

  return (
    <>
      {/* CONTEXT BAR: the four selects name one curriculum block; everything below reads it. */}
      <div className="px-6 md:px-8 py-5 border-b border-slate-200 dark:border-slate-800/60 space-y-3">
        <div className="flex flex-col xl:flex-row xl:items-end gap-4">
          <div role="group" aria-label="Curriculum block" data-testid="builder-context" className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.6fr] gap-3 flex-1 min-w-0">
            <ContextSelect id="builder-program" label="Program" value={context.program} onChange={(v) => updateContext('program', v)} options={programOptions} />
            <ContextSelect id="builder-year" label="Year Level" value={context.yearLevel} onChange={(v) => updateContext('yearLevel', v)} options={yearOptions} />
            <ContextSelect id="builder-semester" label="Semester" value={context.semester} onChange={(v) => updateContext('semester', v)} options={semesterOptions} />
            <ContextSelect id="builder-track" label="Specialization Track" value={context.track} onChange={(v) => updateContext('track', v)} options={trackOptions} />
          </div>
          <button
            ref={attachButtonRef}
            type="button"
            data-testid="builder-attach-open"
            onClick={openAttachModal}
            disabled={blockUnavailable || !edit.allowed}
            {...blockedBy(edit, editNoteId)}
            className="shrink-0 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2.5 rounded-xl text-sm flex items-center justify-center transition-colors shadow-lg shadow-yellow-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
          >
            <Plus size={16} className="mr-2" /> Attach Subject
          </button>
        </div>

        <p className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <Info size={12} className="shrink-0 mt-0.5" /> {reachLabelOf(context)}
        </p>

        {sharedMappings.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border border-blue-200 dark:border-blue-500/20 bg-blue-50/60 dark:bg-blue-500/5">
            <p className="flex items-center gap-2 text-xs text-blue-800 dark:text-blue-300">
              <Link2 size={14} className="shrink-0" />
              <span>
                <span className="font-black">{sharedMappings.length}</span> shared subject{sharedMappings.length === 1 ? '' : 's'} filed under Both also appl{sharedMappings.length === 1 ? 'ies' : 'y'} to this block.
              </span>
            </p>
            <button
              type="button"
              onClick={() => updateContext('program', 'Both')}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30 bg-white dark:bg-[#18181b] hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors cursor-pointer"
            >
              View the Both block
            </button>
          </div>
        )}
      </div>

      {/* MAPPED SUBJECTS */}
      <div ref={tableRegionRef} tabIndex={-1} aria-busy={isLoading} className="relative min-h-[400px] overflow-visible focus:outline-none">
        {isLoading ? (
          <div className="p-16 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
            <Loader2 size={36} className="animate-spin text-yellow-500" />
            <p className="text-xs font-bold uppercase tracking-wider">Loading {contextLabel}...</p>
          </div>
        ) : errorMessage ? (
          <div className="p-12 text-center max-w-md mx-auto my-8">
            <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">This block could not be loaded</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer"
            >
              Retry Request
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Subjects attached to {contextLabel}</caption>
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-bold text-xs">Code</th>
                  <th className="px-6 py-4 font-bold text-xs">Descriptive Title</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Type</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Hours (Lec / Lab)</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Units</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Room</th>
                  <th className="px-6 py-4 font-bold text-xs text-right sticky right-0 bg-white dark:bg-[#18181b]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {totalItems === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-slate-500 dark:text-slate-400">
                      <Layers size={32} className="mx-auto mb-2 opacity-30 text-yellow-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">No Subjects in This Block Yet</p>
                      <p className="text-xs mt-1">
                        Nothing is attached to <span className="font-bold text-slate-600 dark:text-slate-300">{contextLabel}</span>.
                      </p>
                      <button
                        type="button"
                        onClick={openAttachModal}
                        disabled={!edit.allowed}
                        {...blockedBy(edit, editNoteId)}
                        className="mt-4 inline-flex items-center px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold rounded-xl text-xs transition-colors shadow-md shadow-yellow-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
                      >
                        <Plus size={14} className="mr-1.5" /> Attach Subject
                      </button>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((mapping) => {
                    const subject = mapping.subject;
                    const isMissing = !subject;
                    const isDisabledSubject = !isMissing && subject.isActive === false;
                    const routing = isMissing ? null : routingOf(subject, policy);
                    const subjectName = isMissing ? 'removed subject' : `${subject.subjectCode} ${subject.descriptiveTitle || ''}`.trim();

                    // An unscheduled row is dimmed per data cell (shared disabledCellClass), as in the
                    // Master Catalog; the Detach cell keeps full strength.
                    const dataCell = `px-6 py-3.5 transition-opacity ${isMissing || isDisabledSubject ? disabledCellClass : ''}`;

                    return (
                      <tr
                        key={mapping._id}
                        data-status={isMissing ? 'missing' : isDisabledSubject ? 'disabled' : 'active'}
                        className="transition-colors group text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5"
                      >
                        <td className={`${dataCell} ${isMissing ? '' : minorStripClass(subject)}`}>
                          <p className="font-black text-slate-900 dark:text-white whitespace-nowrap">{isMissing ? '—' : subject.subjectCode}</p>
                        </td>
                        <td className={dataCell}>
                          {isMissing ? (
                            <>
                              <p className="font-bold text-slate-500 dark:text-slate-400 italic">No longer in the Master Catalog</p>
                              <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-md text-[10px] font-black border bg-red-100 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20">
                                <TriangleAlert size={11} /> Missing from catalog — not scheduled
                              </span>
                            </>
                          ) : (
                            <>
                              <p className="font-bold text-slate-800 dark:text-slate-200 min-w-48 max-w-80">
                                {subject.descriptiveTitle}
                              </p>
                              {isDisabledSubject ? (
                                <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-md text-[10px] font-black border bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20">
                                  <TriangleAlert size={11} /> Disabled in catalog — not scheduled
                                </span>
                              ) : (
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 max-w-80" title={subject.subjectDescription || 'No description yet'}>
                                  {subject.subjectDescription?.trim() || 'No description yet'}
                                </p>
                              )}
                            </>
                          )}
                        </td>
                        <td className={`${dataCell} text-center`}>
                          {isMissing ? '—' : (
                            <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-black border ${typeBadgeClass(subject)}`}>
                              {resolveSubjectType(subject)}
                            </span>
                          )}
                        </td>
                        <td className={`${dataCell} text-center font-bold text-slate-700 dark:text-slate-300`}>
                          {isMissing ? '—' : (
                            <>
                              <span className="whitespace-nowrap"><span className="text-yellow-700 dark:text-yellow-400">{formatHours(subject.lecHours)}h</span> Lec /</span> <span className="whitespace-nowrap"><span className="text-blue-600 dark:text-blue-400">{formatHours(subject.labHours)}h</span> Lab</span>
                            </>
                          )}
                        </td>
                        <td className={`${dataCell} text-center font-bold text-slate-700 dark:text-slate-300`}>
                          {isMissing || !Number.isFinite(Number(subject.units)) ? '—' : Number(subject.units)}
                        </td>
                        <td className={`${dataCell} text-center`}>
                          {routing ? (
                            <span title={routing.title} className={`inline-flex items-center max-w-40 px-2.5 py-0.5 rounded-md text-[10px] font-black border ${String(routing.label).length <= 14 ? 'whitespace-nowrap' : ''} ${routing.className}`}>
                              {routing.label}
                            </span>
                          ) : '—'}
                        </td>
                        {/* Never dimmed: a stale placement must stay easy to remove. */}
                        <td className={`px-6 py-3.5 text-right sticky right-0 ${isMissing || isDisabledSubject ? 'bg-slate-50 dark:bg-[#1c1c1f]' : 'bg-white dark:bg-[#18181b]'}`}>
                          <button
                            type="button"
                            onClick={(event) => openDetach(mapping, event)}
                            data-testid={`builder-detach-${mapping._id}`}
                            title="Detach"
                            aria-label={`Detach ${subjectName} from ${contextLabel}`}
                            disabled={!edit.allowed}
                            {...blockedBy(edit, editNoteId)}
                            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 transition-colors cursor-pointer enabled:hover:text-red-600 enabled:hover:bg-red-50 dark:enabled:hover:bg-red-500/10 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-500"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* BLOCK SUMMARY FOOTER */}
      <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-b-3xl">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          <span className="font-bold text-slate-800 dark:text-slate-200">{scheduledMappings.length} subject{scheduledMappings.length === 1 ? '' : 's'}</span>
          {' · '}<span className="font-bold text-slate-800 dark:text-slate-200">{totalUnits} unit{totalUnits === 1 ? '' : 's'}</span>
          {' · '}<span className="font-bold text-slate-800 dark:text-slate-200">{formatHours(totalContactHours)} contact hrs/wk</span>
          {unscheduledCount > 0 && (
            <span className="text-amber-700 dark:text-amber-400"> · {unscheduledCount} not scheduled</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
          <p>
            Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of {totalItems} placements
          </p>
          <TablePagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setPage}
            label="Curriculum block pages"
            isSyncing={isSyncing}
            hasError={Boolean(errorMessage)}
            lastSyncedAt={lastSyncedAt}
          />
        </div>
      </div>

      {/* ATTACH SUBJECT DIALOG */}
      {isAttachOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onMouseDown={(event) => {
            // Only a press that starts on the backdrop itself dismisses.
            if (event.target === event.currentTarget) closeAttachModal();
          }}
        >
          {/* Focus opens on the search box and Tab wraps inside the dialog. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="attach-modal-title"
            aria-describedby="attach-modal-context"
            onKeyDown={trapTabKey}
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center shrink-0">
              <div className="min-w-0">
                <h3 id="attach-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">Attach Subject</h3>
                <p id="attach-modal-context" className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  Choose one Master Catalog subject for <span className="font-bold text-slate-700 dark:text-slate-300">{contextLabel}</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={closeAttachModal}
                disabled={isAttaching}
                aria-label="Close dialog"
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-6 pt-4 shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                  type="text"
                  autoFocus
                  placeholder="Search code or title..."
                  data-testid="attach-search"
                  aria-label="Search the Master Catalog by code or title"
                  value={attachSearch}
                  onChange={(e) => handleAttachSearch(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 pl-9 pr-4 text-sm focus:outline-none focus:border-yellow-500 transition-colors text-slate-900 dark:text-white"
                />
              </div>
            </div>

            {attachError && (
              <div role="alert" className="mx-6 mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400 shrink-0">
                <AlertCircle size={16} className="mr-2 shrink-0" /> {attachError}
              </div>
            )}

            <form onSubmit={handleAttach} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar scrollbar-gutter-stable px-6 py-4">
                {catalog.status === 'error' ? (
                  <div className="py-8 text-center">
                    <AlertOctagon size={32} className="text-red-500 mx-auto mb-2" />
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-3">{catalog.error}</p>
                    <button
                      type="button"
                      onClick={loadCatalog}
                      className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold rounded-xl text-xs transition-colors cursor-pointer"
                    >
                      Retry Request
                    </button>
                  </div>
                ) : catalog.status !== 'ready' ? (
                  <div className="py-10 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
                    <Loader2 size={28} className="animate-spin text-yellow-500" />
                    <p className="text-xs font-bold uppercase tracking-wider">Fetching the Master Catalog...</p>
                  </div>
                ) : attachTotalItems === 0 ? (
                  <div className="py-10 text-center text-slate-500 dark:text-slate-400">
                    <Layers size={28} className="mx-auto mb-2 opacity-30 text-yellow-500" />
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      {attachQuery ? 'No Matching Subjects' : 'The Master Catalog Is Empty'}
                    </p>
                    <p className="text-xs mt-1">
                      {attachQuery ? 'Try another code or title.' : 'Add subjects in the Master Catalog tab first.'}
                    </p>
                  </div>
                ) : (
                  <fieldset disabled={isAttaching}>
                    <legend className="sr-only">Master Catalog subjects</legend>
                    <ul className="space-y-2">
                      {attachPageItems.map(subject => {
                        const blocker = blockerOf(subject);
                        const isSelected = subject._id === selectedSubjectId;
                        return (
                          <li key={subject._id}>
                            <label
                              className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                                isSelected
                                  ? 'border-yellow-400 bg-yellow-50/70 dark:border-yellow-500/50 dark:bg-yellow-500/10 cursor-pointer'
                                  : blocker
                                    ? 'border-slate-200 dark:border-slate-800 opacity-60 cursor-not-allowed'
                                    : 'border-slate-200 dark:border-slate-800 hover:border-yellow-300 dark:hover:border-yellow-500/40 cursor-pointer'
                              }`}
                            >
                              <input
                                type="radio"
                                data-testid={`attach-subject-${subject._id}`}
                                name="attach-subject"
                                value={subject._id}
                                checked={isSelected}
                                disabled={Boolean(blocker)}
                                onChange={() => {
                                  setSelectedSubjectId(subject._id);
                                  // A refusal belongs to the previous choice; never leave it on a new one.
                                  setAttachError('');
                                }}
                                className="w-4 h-4 shrink-0 accent-yellow-500"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-black text-sm text-slate-900 dark:text-white">{subject.subjectCode}</span>
                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-black border ${typeBadgeClass(subject)}`}>
                                    {resolveSubjectType(subject)}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-600 dark:text-slate-300 truncate" title={subject.descriptiveTitle}>
                                  {subject.descriptiveTitle}
                                </p>
                                {blocker?.note && (
                                  <p className="text-[10px] text-yellow-700 dark:text-yellow-400 mt-0.5">{blocker.note}</p>
                                )}
                              </div>
                              <div className="shrink-0 flex flex-col items-end gap-1">
                                <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                                  {formatHours(subject.lecHours)}h / {formatHours(subject.labHours)}h · {Number(subject.units) || 0}u
                                </p>
                                {blocker && (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black border ${TAG_TONES[blocker.tone]}`}>
                                    {blocker.tag}
                                  </span>
                                )}
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                )}
              </div>

              <div className="shrink-0 px-6 py-2.5 border-t border-slate-200 dark:border-slate-800/60 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
                <p>
                  Showing <span className="font-bold text-slate-700 dark:text-slate-300">{attachRangeLabel}</span> of {attachTotalItems} subjects
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <TablePagination
                    currentPage={attachPage}
                    totalPages={attachTotalPages}
                    onPageChange={setAttachPage}
                    label="Master Catalog pages"
                    isSyncing={catalog.status === 'loading'}
                    hasError={catalog.status === 'error'}
                    lastSyncedAt={catalog.syncedAt}
                  />
                </div>
              </div>

              <div className="shrink-0 px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between gap-3">
                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate min-w-0" aria-live="polite">
                  {selectedSubject
                    ? <>Selected: <span className="font-bold text-slate-700 dark:text-slate-200">{selectedSubject.subjectCode}</span> {selectedSubject.descriptiveTitle}</>
                    : 'Select one subject to attach.'}
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={closeAttachModal}
                    disabled={isAttaching}
                    className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-testid="attach-submit"
                    disabled={!canAttach}
                    className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-yellow-500 hover:bg-yellow-600 transition-colors shadow-md shadow-yellow-500/20 flex items-center disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500 cursor-pointer"
                  >
                    {isAttaching ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                    {isAttaching ? 'Attaching...' : 'Attach'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DETACH CONFIRMATION */}
      {detachTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDetach();
          }}
        >
          {/* Focus opens on Cancel (the safe choice) and Tab wraps inside the dialog. */}
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="detach-dialog-title"
            aria-describedby="detach-dialog-description"
            onKeyDown={trapTabKey}
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-md shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
          >
            <div className="p-6">
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 shrink-0">
                  <Trash2 size={20} />
                </div>
                <div className="min-w-0">
                  <h3 id="detach-dialog-title" className="text-base font-black text-slate-800 dark:text-white">
                    Detach {detachTarget.subject?.subjectCode || 'this placement'}?
                  </h3>
                  <p id="detach-dialog-description" className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    {detachTarget.subject
                      ? <>{detachTarget.subject.descriptiveTitle} will no longer be scheduled for <span className="font-bold text-slate-700 dark:text-slate-300">{contextLabel}</span>. The subject stays in the Master Catalog and can be attached again.</>
                      : <>This placement points to a subject that no longer exists. Removing it cleans up <span className="font-bold text-slate-700 dark:text-slate-300">{contextLabel}</span>.</>}
                  </p>
                </div>
              </div>
              {detachError && (
                <div role="alert" className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400">
                  <AlertCircle size={16} className="mr-2 shrink-0" /> {detachError}
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={closeDetach}
                disabled={isDetaching}
                className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="detach-submit"
                onClick={handleDetach}
                disabled={isDetaching}
                className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors shadow-md shadow-red-600/20 flex items-center disabled:opacity-70 cursor-pointer"
              >
                {isDetaching ? <Loader2 size={14} className="animate-spin mr-2" /> : <Trash2 size={14} className="mr-2" />}
                {isDetaching ? 'Detaching...' : 'Detach'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
