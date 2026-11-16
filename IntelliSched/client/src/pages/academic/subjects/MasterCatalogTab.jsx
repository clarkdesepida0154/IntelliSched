import { useState, useEffect, useRef } from 'react';
import {
  Search, Plus, BookOpen, Ban, Loader2, CheckCircle2, X, ShieldCheck,
  Tag, AlertCircle, AlertOctagon, Info
} from 'lucide-react';
import api from '../../../services/api';
import { SUBJECT_TYPE_VALUES, resolveSubjectType } from '../../../utils/subjectType';
import usePagination from '../../../hooks/usePagination';
import useEscapeKey from '../../../hooks/useEscapeKey';
import TablePagination from '../../../components/ui/TablePagination';
import RowActions from '../../../components/ui/RowActions';
import ConfirmDialog from '../../../components/ui/ConfirmDialog';
import FilterPopover, { FilterSelect } from '../../../components/ui/FilterPopover';
import { disabledCellClass, disabledBadgeClass } from '../../../components/ui/tableStyles';
import usePolicy from '../../../hooks/usePolicy';
import useConfirmDisable from '../../../hooks/useConfirmDisable';
import usePermission, { blockedBy } from '../../../hooks/usePermission';
import { undoDisable } from '../../../utils/recordToggle';
import {
  LECTURE_ONLY_TYPES, LECTURE_MODE_HINT, LECTURE_MODE_OPTIONS, LECTURE_MODE_VALUES, formatHours, isHalfStep, lectureModeOf, nstpBlockLabel,
  readStorage, writeStorage, typeBadgeClass, minorStripClass, routingOf, trapTabKey, focusFirstAvailable
} from './subjectFormat';
import Select from '../../../components/ui/Select';

const FETCH_ERROR_MESSAGE = 'The Master Catalog could not be loaded. Check your connection, then try again.';

// Single read path for the catalog. Every successful mutation revalidates through it, so the table
// always shows what Atlas actually persisted (server-side casing, derived routing, sort order).
const fetchCatalogList = async () => {
  const res = await api.get('/catalog');
  return Array.isArray(res.data) ? res.data : [];
};

const FILTER_STORAGE_KEY = 'intellisched.subjectManager.filters';

// The subject type drives room routing (hours are entered for every type): Major -> physical room
// (its lectures may be held online: its Lecture mode, Phase 3 Step 7); Minor -> optional room; NSTP ->
// TBA in the Scheduling Policy's NSTP block.
const TYPE_FILTER_OPTIONS = SUBJECT_TYPE_VALUES.map(value => ({ value, label: value }));

// Soft-delete state exposed as a filter. Values map onto SubjectCatalog.isActive, which the
// /catalog/:id/toggle route flips; '' shows active and disabled rows together.
const STATUS_FILTER_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' }
];
const STATUS_FILTER_VALUES = STATUS_FILTER_OPTIONS.map(opt => opt.value);

// '' means "All". Persisted to localStorage so the Dean's view survives navigating away.
const DEFAULT_FILTERS = { type: '', status: '' };

// A new subject defaults to a 3-unit, lecture-only Major. The catalog is timeless: placement in a
// program, year level, semester and track happens in the Curriculum Builder.
const DEFAULT_FORM = {
  subjectCode: '',
  descriptiveTitle: '',
  subjectDescription: '',
  type: 'Major',
  lecHours: 3,
  labHours: 0,
  units: 3,
  requiresRoom: false,
  // Practicum / OJT (Majors only): no contact hours, no room, never scheduled by the GA.
  isPracticum: false,
  // Phase 3 Step 7: how a Major's lectures are held (subjectFormat.js LECTURE_MODE_OPTIONS).
  lectureMode: 'ON_CAMPUS'
};

const loadStoredFilters = () => {
  const parsed = readStorage(FILTER_STORAGE_KEY);
  // Only known keys are restored: a key saved by an older build (e.g. the removed semester or
  // program filter) would otherwise count as an active filter that no control can clear.
  const merged = { ...DEFAULT_FILTERS };
  if (parsed && typeof parsed === 'object') {
    for (const key of Object.keys(DEFAULT_FILTERS)) {
      if (typeof parsed[key] === 'string') merged[key] = parsed[key];
    }
  }
  // A stale or hand-edited value must never hide rows silently.
  if (!SUBJECT_TYPE_VALUES.includes(merged.type)) merged.type = '';
  if (!STATUS_FILTER_VALUES.includes(merged.status)) merged.status = '';
  return merged;
};

// Laboratory hours that actually count: always 0 for a lecture-only type, whatever the hidden
// input still holds from before the type changed.
const effectiveLabHours = (form) => (LECTURE_ONLY_TYPES.includes(form.type) ? 0 : Number(form.labHours) || 0);

// `editNoteId`: the page's visible note with the reason why this role may not change subjects
// (Phase 3 Step 6); the Add, Edit and Disable / Enable controls point at it while they are closed.
export default function MasterCatalogTab({ onToast, editNoteId }) {
  const { policy } = usePolicy();
  // Adding, editing, disabling and enabling subjects: the permission map's data.edit.
  const edit = usePermission('data.edit');
  // Weekly cap on lecture hours and on lab hours (Scheduling Policy). The gateway enforces it too.
  const maxHoursPerType = policy?.catalog?.maxWeeklyHoursPerType ?? null;
  const [hoursError, setHoursError] = useState('');
  // The gateway's refusal of a lecture mode, shown next to the select (Phase 3 Step 7).
  const [lectureModeError, setLectureModeError] = useState('');
  const [subjectsList, setSubjectsList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState(loadStoredFilters);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState(null);
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [validationError, setValidationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Monotonic ticket for list refetches: a slower, older response must never overwrite a newer one.
  const syncSeq = useRef(0);
  // Rows with a status toggle in flight. The ref is the synchronous re-entry guard; the state
  // drives the spinner on the row's trigger.
  const pendingToggleRef = useRef(new Set());
  const [pendingToggleIds, setPendingToggleIds] = useState(() => new Set());
  const lastActionRef = useRef(null);
  const tableRegionRef = useRef(null);
  const prevPendingCount = useRef(0);
  // The control that opened the Add/Edit dialog (Add Subject or a row's Edit), refocused on close.
  const modalOpenerRef = useRef(null);
  const addButtonRef = useRef(null);
  const wasModalOpen = useRef(false);

  useEffect(() => {
    let isMounted = true;
    const seq = ++syncSeq.current;

    fetchCatalogList()
      .then(list => {
        if (!isMounted || seq !== syncSeq.current) return;
        setSubjectsList(list);
        setLastSyncedAt(new Date());
      })
      .catch(err => {
        if (!isMounted || seq !== syncSeq.current) return;
        console.warn('[Catalog] Atlas fetch failed:', err.message);
        setSubjectsList([]);
        setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
      })
      .finally(() => {
        // Settled even when superseded (e.g. a save's re-sync overtook it), so the spinner never
        // sticks; the newer fetch still owns the data.
        if (isMounted) setIsLoading(false);
      });

    return () => { isMounted = false; };
  }, []);

  // Persist filter selections whenever they change.
  useEffect(() => {
    writeStorage(FILTER_STORAGE_KEY, filters);
  }, [filters]);

  // When a toggle settles and the Status filter has hidden the row, the button that started it is
  // gone; move focus to the table region instead of letting it fall to <body>.
  useEffect(() => {
    const settled = pendingToggleIds.size < prevPendingCount.current;
    prevPendingCount.current = pendingToggleIds.size;
    if (!settled) return;
    const origin = lastActionRef.current;
    if (origin && !origin.isConnected && document.activeElement === document.body) {
      tableRegionRef.current?.focus();
    }
  }, [pendingToggleIds]);

  // Every way the Add/Edit dialog closes (Cancel, Escape, X, backdrop, a save) returns focus to
  // its opener. This runs after the commit, so a row an edit just filtered out of the table is
  // already gone and the Add Subject button takes focus instead.
  useEffect(() => {
    const closed = wasModalOpen.current && !isModalOpen;
    wasModalOpen.current = isModalOpen;
    if (closed) focusFirstAvailable(modalOpenerRef.current, addButtonRef.current);
  }, [isModalOpen]);

  // Full reload, used only by the error-state retry: it shows the loading state again.
  const handleRetry = async () => {
    const seq = ++syncSeq.current;
    // This is now the latest fetch, so any in-flight revalidate() will bail on its seq check
    // without clearing the indicator. Own it here: the retry shows the loading spinner, not
    // the amber "Syncing" dot, and a stuck true would also mask "Offline" if the retry fails.
    setIsSyncing(false);
    setIsLoading(true);
    setErrorMessage('');
    try {
      const list = await fetchCatalogList();
      if (seq !== syncSeq.current) return;
      setSubjectsList(list);
      setLastSyncedAt(new Date());
    } catch (err) {
      if (seq !== syncSeq.current) return;
      setSubjectsList([]);
      setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  };

  // Silent revalidation after every successful mutation. The optimistic local update has
  // already rendered; this swaps it for Atlas truth without flashing a loading state. A
  // transient failure simply leaves the optimistic row on screen.
  const revalidate = async () => {
    const seq = ++syncSeq.current;
    setIsSyncing(true);
    try {
      const list = await fetchCatalogList();
      // A newer refetch was issued while this one was in flight: its result is the truth, not ours.
      if (seq !== syncSeq.current) return;
      setSubjectsList(list);
      setLastSyncedAt(new Date());
      setErrorMessage('');
    } catch (err) {
      console.warn('[Catalog] Revalidation skipped:', err.message);
    } finally {
      // Only the most recent refetch may clear the syncing indicator.
      if (seq === syncSeq.current) setIsSyncing(false);
    }
  };

  const activeSubjects = subjectsList.filter(s => s.isActive);
  const totalLectureHours = activeSubjects.reduce((sum, s) => sum + (Number(s.lecHours) || 0), 0);
  const totalLabHours = activeSubjects.reduce((sum, s) => sum + (Number(s.labHours) || 0), 0);
  const disabledCount = subjectsList.length - activeSubjects.length;

  // ---------------------------------------------------------------------------
  // Search & filters
  // ---------------------------------------------------------------------------
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredSubjects = subjectsList.filter(s => {
    const matchesSearch = !normalizedSearch
      || (s.subjectCode || '').toLowerCase().includes(normalizedSearch)
      || (s.descriptiveTitle || '').toLowerCase().includes(normalizedSearch);
    const matchesType = !filters.type || resolveSubjectType(s) === filters.type;
    // Mirrors the Status column: a truthy isActive renders as Active, anything else as Disabled.
    const matchesStatus = !filters.status
      || (filters.status === 'active' ? Boolean(s.isActive) : !s.isActive);
    return matchesSearch && matchesType && matchesStatus;
  });

  // Exactly 15 rows per page over the filtered list. Every handler that changes the query set
  // (search or filters) resets to page 1 itself, so the user never lands on a stale empty page.
  const { currentPage, totalPages, totalItems, pageItems, rangeLabel, setPage, resetPage } =
    usePagination(filteredSubjects, 25);

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    resetPage();
  };
  const updateFilter = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    resetPage();
  };
  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    resetPage();
  };

  // ---------------------------------------------------------------------------
  // Modal helpers
  // ---------------------------------------------------------------------------
  const isMinorType = formData.type === 'Minor';
  const isNstpType = formData.type === 'NSTP';
  const isLectureOnlyType = LECTURE_ONLY_TYPES.includes(formData.type);
  const isPracticumForm = formData.type === 'Major' && Boolean(formData.isPracticum);
  // Only a Major that is not a practicum chooses how its lectures are held (Phase 3 Step 7).
  const hasLectureMode = formData.type === 'Major' && !isPracticumForm;
  // A Major saved with 0 laboratory hours ("0" while typing); an empty field does not count.
  const isLectureOnlyMajor = formData.type === 'Major' && !isPracticumForm
    && String(formData.labHours).trim() !== '' && Number(formData.labHours) === 0;

  // Subject codes may repeat (e.g. one ITST 301 per BSIT track). Show the Dean the other entries
  // that share the typed code so a real duplicate is not created by accident.
  const typedCode = formData.subjectCode.trim().toUpperCase();
  const sameCodeSubjects = typedCode
    ? subjectsList.filter(s => s.subjectCode === typedCode && s._id !== editingSubject?._id)
    : [];

  // Single dismissal path (Escape, backdrop, header X, Cancel): ignored while a save is in
  // flight, and never leaves a stale editing target or validation message behind.
  const closeModal = () => {
    if (isSubmitting) return;
    setIsModalOpen(false);
    setEditingSubject(null);
    setValidationError('');
    setHoursError('');
    setLectureModeError('');
  };

  // Escape closes the dialog unless a save is in flight. The shared hook ignores a key event that
  // a child control already consumed, so one key press never closes two layers at once.
  useEscapeKey(isModalOpen, closeModal, isSubmitting);

  const openAddModal = (event) => {
    if (!edit.allowed) return;
    modalOpenerRef.current = event?.currentTarget ?? null;
    setEditingSubject(null);
    setFormData(DEFAULT_FORM);
    setValidationError('');
    setHoursError('');
    setLectureModeError('');
    setIsModalOpen(true);
  };

  const openEditModal = (subject, event) => {
    if (!edit.allowed) return;
    modalOpenerRef.current = event?.currentTarget ?? null;
    setEditingSubject(subject);
    const resolvedType = resolveSubjectType(subject);
    const storedLec = Number(subject.lecHours) || 0;
    const storedLab = Number(subject.labHours) || 0;
    // Minor and NSTP are lecture-only: a record saved earlier with laboratory hours opens with
    // them counted as lecture hours, so its contact hours are kept.
    const isLectureOnly = LECTURE_ONLY_TYPES.includes(resolvedType);
    const lec = isLectureOnly ? storedLec + storedLab : storedLec;
    const lab = isLectureOnly ? 0 : storedLab;

    setHoursError('');
    setLectureModeError('');
    setFormData({
      subjectCode: subject.subjectCode || '',
      descriptiveTitle: subject.descriptiveTitle || '',
      subjectDescription: subject.subjectDescription || '',
      type: resolvedType,
      lecHours: lec,
      labHours: lab,
      units: Number.isInteger(Number(subject.units)) ? Number(subject.units) : Math.max(1, Math.round(lec + lab)),
      requiresRoom: resolvedType === 'Minor' ? Boolean(subject.requiresRoom) : false,
      isPracticum: resolvedType === 'Major' && Boolean(subject.isPracticum),
      // A record saved before Phase 3 Step 7 has no lecture mode: it opens as On campus.
      lectureMode: lectureModeOf(subject)
    });
    setValidationError('');
    setIsModalOpen(true);
  };

  // The type changes routing; the typed hours and units stay in the form (a lecture-only type just
  // stops counting lab hours).
  const handleTypeChange = (nextType) => {
    setFormData(prev => (nextType === prev.type ? prev : { ...prev, type: nextType, requiresRoom: false, isPracticum: false, lectureMode: 'ON_CAMPUS' }));
    setLectureModeError('');
  };

  const handleSaveSubject = async (e) => {
    e.preventDefault();
    setValidationError('');
    setHoursError('');
    setLectureModeError('');

    const subjectType = SUBJECT_TYPE_VALUES.includes(formData.type) ? formData.type : 'Major';
    const cleanCode = formData.subjectCode.trim().toUpperCase();
    const cleanTitle = formData.descriptiveTitle.trim();
    const cleanDescription = formData.subjectDescription.trim();
    const unitsValue = Number(formData.units);

    // Lecture hours and units are entered for every type; laboratory hours for a Major only. A
    // lecture-only type (Minor, NSTP) always saves 0 lab hours, whatever the hidden input holds. A
    // practicum has no contact hours: its hour fields are hidden, not checked, and saved as 0.
    const isPracticum = subjectType === 'Major' && Boolean(formData.isPracticum);
    const lec = isPracticum ? 0 : parseFloat(formData.lecHours);
    const lab = isPracticum || LECTURE_ONLY_TYPES.includes(subjectType) ? 0 : parseFloat(formData.labHours);

    if (!cleanCode || !cleanTitle) {
      setValidationError('Subject code and descriptive title cannot be empty.');
      return;
    }
    if (!isPracticum && (!isHalfStep(lec) || !isHalfStep(lab))) {
      setHoursError('Lecture and laboratory hours must be whole or half hours (for example 2 or 1.5): classes are scheduled in half-hour steps.');
      return;
    }
    if (!isPracticum && lec + lab === 0) {
      setHoursError('A subject must carry at least one contact hour.');
      return;
    }
    if (!isPracticum && maxHoursPerType !== null && (lec > maxHoursPerType || lab > maxHoursPerType)) {
      setHoursError(`Lecture hours and laboratory hours can each be at most ${maxHoursPerType} hours per week (Scheduling Policy). Check the hours entered.`);
      return;
    }
    if (!Number.isInteger(unitsValue) || unitsValue < 1 || unitsValue > 12) {
      setHoursError('Credit units must be a whole number between 1 and 12.');
      return;
    }

    setIsSubmitting(true);

    const payload = {
      subjectCode: cleanCode,
      descriptiveTitle: cleanTitle,
      subjectDescription: cleanDescription,
      type: subjectType,
      lecHours: lec,
      labHours: lab,
      units: unitsValue,
      // Routing follows the type (the gateway derives the same values): Major always gets a room;
      // Minor follows its checkbox; NSTP is TBA with no room in the policy's NSTP block.
      requiresRoom: subjectType === 'Major' ? !isPracticum : subjectType === 'Minor' ? Boolean(formData.requiresRoom) : false,
      isPracticum,
      // Phase 3 Step 7: a Major that is not a practicum sends its lecture mode; every other subject is on
      // campus (the gateway stores the same).
      lectureMode: subjectType === 'Major' && !isPracticum && LECTURE_MODE_VALUES.includes(formData.lectureMode) ? formData.lectureMode : 'ON_CAMPUS',
      // Status is not edited in this form: a new subject starts active and an edit omits the key
      // so Atlas keeps the persisted state. Enabling and disabling happen only through row actions.
      ...(editingSubject ? {} : { isActive: true })
    };

    try {
      if (editingSubject) {
        const res = await api.put(`/catalog/${editingSubject._id}`, payload);
        setSubjectsList(prev => prev.map(s => s._id === editingSubject._id ? res.data : s));
        onToast(`${cleanCode} updated in the Master Catalog.`);
      } else {
        const res = await api.post('/catalog', payload);
        setSubjectsList(prev => [res.data, ...prev]);
        onToast(`${cleanCode} added to the Master Catalog. Attach it in the Curriculum Builder to schedule it.`);
      }
    } catch (err) {
      const message = err.response?.data?.message || 'Failed to save the subject to the database.';
      // The gateway's hour-cap message belongs next to the hour fields, its lecture-mode message next
      // to the Lecture mode (shown while the form has one; otherwise at the top).
      if (/hours per week|contact hour|multiples of 0\.5/.test(message)) setHoursError(message);
      else if (/lecture mode/i.test(message) && hasLectureMode) setLectureModeError(message);
      else setValidationError(message);
      setIsSubmitting(false);
      return;
    }

    // The optimistic row is already on screen. Close the dialog and release the submit lock
    // first, so the Dean can open the form again straight away, then await the Atlas re-sync.
    // revalidate() never throws and leaves the list untouched on a transient failure.
    setIsModalOpen(false);
    setEditingSubject(null);
    setIsSubmitting(false);
    await revalidate();
  };

  // The toggle route flips isActive rather than setting it, so a duplicate request would undo the
  // first one. The row's action button shows a spinner and is disabled while the request is
  // in flight, and a re-entrant call for the same row is ignored. Other rows stay toggleable.
  const setPending = (id, pending) => {
    if (pending) pendingToggleRef.current.add(id); else pendingToggleRef.current.delete(id);
    setPendingToggleIds(new Set(pendingToggleRef.current));
  };
  // PATCH /catalog/:id/toggle; resolves the subject's new state (or throws).
  const toggleSubject = async (subject) => {
    setPending(subject._id, true);
    try {
      const res = await api.patch(`/catalog/${subject._id}/toggle`);
      const isActive = Boolean(res.data.isActive);
      setSubjectsList(prev => prev.map(s => s._id === subject._id ? { ...s, isActive } : s));
      return isActive;
    } finally {
      setPending(subject._id, false);
    }
  };
  const statusText = (subject, isActive) => (isActive
    ? `${subject.subjectCode} enabled: its curriculum placements are scheduled again.`
    : `${subject.subjectCode} disabled: record and placements kept, but it is no longer scheduled.`);

  // Undo of a disable: the subject is enabled again only if it is still disabled (utils/recordToggle.js).
  const undoSubjectDisable = async (subject) => {
    setPending(subject._id, true);
    const result = await undoDisable({ listPath: '/catalog', togglePath: `/catalog/${subject._id}/toggle`, id: subject._id, name: subject.subjectCode });
    setPending(subject._id, false);
    if (typeof result.isActive === 'boolean') setSubjectsList(prev => prev.map(s => s._id === subject._id ? { ...s, isActive: result.isActive } : s));
    onToast(result.message, result.tone);
    revalidate();
  };

  // Disabling asks first (audit X6); the message that follows offers Undo.
  const disableQuestion = useConfirmDisable(async (subject) => {
    try {
      const isActive = await toggleSubject(subject);
      onToast(statusText(subject, isActive), 'success', isActive ? null : () => undoSubjectDisable(subject));
      revalidate();
      return '';
    } catch (err) {
      return `${subject.subjectCode} was not disabled (${err.response?.data?.message || err.message}). The subject was left unchanged: try again, or cancel.`;
    }
  });

  // The row's Disable asks first; Enable acts at once.
  const handleToggleStatus = async (subject, event) => {
    if (!edit.allowed || pendingToggleRef.current.has(subject._id)) return;
    lastActionRef.current = event?.currentTarget ?? null;
    if (subject.isActive) {
      disableQuestion.ask(subject);
      return;
    }
    try {
      onToast(statusText(subject, await toggleSubject(subject)));
      revalidate();
    } catch (err) {
      // Always lead with the subject code: several rows may be toggling at once and the toast
      // channel keeps only the latest message.
      onToast(
        `${subject.subjectCode}: ${err.response?.data?.message || 'the status could not be changed.'} The subject was left unchanged; try again.`,
        'error'
      );
    }
  };

  const inputClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-yellow-500 text-slate-900 dark:text-white disabled:opacity-50';

  return (
    <>
      {/* TOOLBAR: catalog stats on the left; search, filters and Add on the right. */}
      <div className="px-6 md:px-8 py-4 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b border-slate-200 dark:border-slate-800/60">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Master Catalog</p>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">
            <span className="font-black text-slate-900 dark:text-white">{activeSubjects.length}</span> active subject{activeSubjects.length === 1 ? '' : 's'}
            {disabledCount > 0 && <> · <span className="font-bold">{disabledCount}</span> disabled</>}
            <span className="text-slate-500 dark:text-slate-400"> · defined once, placed in the Curriculum Builder</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
          <div className="relative flex-1 min-w-45 lg:w-60 lg:flex-none">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search code or title..."
              data-testid="catalog-search"
              aria-label="Search the Master Catalog by code or title"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-yellow-500 transition-colors text-slate-900 dark:text-white"
            />
          </div>

          <FilterPopover
            title="Filter Catalog"
            ariaLabel="Master Catalog filters"
            accent="yellow"
            activeCount={activeFilterCount}
            summary={`${filteredSubjects.length} of ${subjectsList.length} shown`}
            onClear={clearFilters}
          >
            <FilterSelect
              label="Subject Type"
              value={filters.type}
              onChange={(v) => updateFilter('type', v)}
              options={TYPE_FILTER_OPTIONS}
              allLabel="All Types"
              accent="yellow"
            />
            <FilterSelect
              label="Status"
              value={filters.status}
              onChange={(v) => updateFilter('status', v)}
              options={STATUS_FILTER_OPTIONS}
              allLabel="All Statuses"
              accent="yellow"
            />
          </FilterPopover>

          <button
            ref={addButtonRef}
            type="button"
            data-testid="catalog-add"
            onClick={openAddModal}
            disabled={!edit.allowed}
            {...blockedBy(edit, editNoteId)}
            className="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2 rounded-lg text-sm flex items-center transition-colors shadow-lg shadow-yellow-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
          >
            <Plus size={16} className="mr-2" /> Add Subject
          </button>
        </div>
      </div>

      {/* TABLE AREA. min-h-[400px] keeps a 0- or 1-row table tall enough that the Filters
          popover anchored in the toolbar above always has room to render in full. */}
      <div ref={tableRegionRef} tabIndex={-1} className="relative min-h-[400px] overflow-visible focus:outline-none">
        {isLoading ? (
          <div className="p-16 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
            <Loader2 size={36} className="animate-spin text-yellow-500" />
            <p className="text-xs font-bold uppercase tracking-wider">Loading the Master Catalog…</p>
          </div>
        ) : errorMessage ? (
          <div className="p-12 text-center max-w-md mx-auto my-8">
            <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The Master Catalog could not be loaded</h3>
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
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-6 py-4 font-bold text-xs">Code</th>
                  <th className="px-6 py-4 font-bold text-xs">Descriptive title and description</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Type</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Hours (Lec / Lab)</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Units</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Room</th>
                  <th className="px-6 py-4 font-bold text-xs text-center">Status</th>
                  <th className="px-6 py-4 font-bold text-xs text-right sticky right-0 bg-white dark:bg-[#18181b]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {totalItems === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-12 text-center text-slate-500 dark:text-slate-400">
                      <BookOpen size={32} className="mx-auto mb-2 opacity-30 text-yellow-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        {searchQuery || hasActiveFilters ? 'No Matching Subjects Found' : 'The Master Catalog Is Empty'}
                      </p>
                      <p className="text-xs mt-1">
                        {searchQuery || hasActiveFilters
                          ? 'Try adjusting your search query or clearing the active filters.'
                          : edit.allowed ? 'Click "Add Subject" above to define the first subject.' : edit.reason}
                      </p>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((subject) => {
                    const isTogglePending = pendingToggleIds.has(subject._id);
                    const rowType = resolveSubjectType(subject);
                    const routing = routingOf(subject, policy);
                    const isDisabledRow = !subject.isActive;
                    const rowUnits = Number.isFinite(Number(subject.units)) ? Number(subject.units) : null;

                    // Disabled rows are dimmed per data cell (shared disabledCellClass) rather than
                    // on the <tr>, so the action icons keep full strength and the row never gains a
                    // stacking context.
                    const dataCell = `px-6 py-3.5 transition-opacity ${isDisabledRow ? disabledCellClass : ''}`;

                    return (
                      <tr
                        key={subject._id}
                        data-status={isDisabledRow ? 'disabled' : 'active'}
                        className="transition-colors group text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5"
                      >
                        <td className={`${dataCell} ${minorStripClass(subject)}`}>
                          <p className="font-black text-slate-900 dark:text-white whitespace-nowrap">{subject.subjectCode}</p>
                        </td>
                        <td className={dataCell}>
                          <p className="font-bold text-slate-800 dark:text-slate-200 min-w-48 max-w-80">
                            {subject.descriptiveTitle}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 max-w-80" title={subject.subjectDescription || 'No description yet'}>
                            {subject.subjectDescription?.trim() || 'No description yet'}
                          </p>
                        </td>
                        <td className={`${dataCell} text-center`}>
                          <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded text-[10px] font-black border ${typeBadgeClass(subject)}`}>
                            {rowType}
                          </span>
                        </td>
                        <td className={`${dataCell} text-center font-bold text-slate-700 dark:text-slate-300`}>
                          {subject.isPracticum ? (
                            <span className="text-amber-700 dark:text-amber-400">Practicum</span>
                          ) : (
                            <><span className="whitespace-nowrap"><span className="text-yellow-700 dark:text-yellow-400">{formatHours(subject.lecHours)}h</span> Lec /</span> <span className="whitespace-nowrap"><span className="text-blue-600 dark:text-blue-400">{formatHours(subject.labHours)}h</span> Lab</span></>
                          )}
                        </td>
                        <td className={`${dataCell} text-center font-bold text-slate-700 dark:text-slate-300`}>
                          {rowUnits === null ? <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">Not set</span> : rowUnits}
                        </td>
                        <td className={`${dataCell} text-center`}>
                          <span title={routing.title} className={`inline-flex items-center max-w-40 px-2.5 py-0.5 rounded-md text-[10px] font-black border ${String(routing.label).length <= 14 ? 'whitespace-nowrap' : ''} ${routing.className}`}>
                            {routing.label}
                          </span>
                        </td>
                        <td className={`${dataCell} text-center`}>
                          {subject.isActive ? (
                            <span className="inline-flex items-center whitespace-nowrap px-2.5 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400 border border-green-200 dark:border-green-500/20">
                              <ShieldCheck size={12} className="mr-1" /> Active
                            </span>
                          ) : (
                            <span className={disabledBadgeClass}>
                              <Ban size={12} className="mr-1" /> Disabled
                            </span>
                          )}
                        </td>
                        {/* Inline grouped actions (shared RowActions): muted by default, brand-coloured
                            on hover. Never dimmed, so the Enable icon on a disabled row stays clickable. */}
                        <td className={`px-6 py-3.5 text-right sticky right-0 ${isDisabledRow ? 'bg-slate-50 dark:bg-[#1c1c1f]' : 'bg-white dark:bg-[#18181b]'}`}>
                          <RowActions
                            isActive={Boolean(subject.isActive)}
                            onEdit={(event) => openEditModal(subject, event)}
                            onToggle={(event) => handleToggleStatus(subject, event)}
                            isPending={isTogglePending}
                            name={subject.subjectCode}
                            blockedReason={edit.reason}
                            reasonId={editNoteId}
                          />
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

      {/* METRIC FOOTER */}
      <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-4 rounded-b-3xl">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Active Contact Hours: <span className="font-bold text-slate-800 dark:text-slate-200">{formatHours(totalLectureHours)}h Lecture</span> / <span className="font-bold text-slate-800 dark:text-slate-200">{formatHours(totalLabHours)}h Laboratory</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
          <p>
            Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of {totalItems} subjects
          </p>
          <TablePagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setPage}
            label="Master Catalog pages"
            isSyncing={isSyncing}
            hasError={Boolean(errorMessage)}
            lastSyncedAt={lastSyncedAt}
          />
        </div>
      </div>

      {/* REUSABLE ADD / EDIT MODAL */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onMouseDown={(event) => {
            // Only a press that starts on the backdrop itself dismisses; a drag that begins inside
            // the card and ends outside must not close the form.
            if (event.target === event.currentTarget) closeModal();
          }}
        >
          {/* Focus opens on Subject Code and Tab wraps inside the dialog. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="catalog-modal-title"
            onKeyDown={trapTabKey}
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center shrink-0">
              <div>
                <h3 id="catalog-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">
                  {editingSubject ? 'Edit Catalog Subject' : 'Add Subject to Catalog'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {editingSubject
                    ? `Editing ${editingSubject.subjectCode}. Changes apply to every curriculum placement.`
                    : 'Define the subject once; place it in curricula from the Curriculum Builder.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={isSubmitting}
                aria-label="Close dialog"
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X size={18} />
              </button>
            </div>

            {validationError && (
              <div role="alert" className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400 shrink-0">
                <AlertCircle size={16} className="mr-2 shrink-0" /> {validationError}
              </div>
            )}

            {/* Header and footer are fixed; only the field area scrolls. scrollbar-gutter-stable
                reserves the rail so the form width never shifts when content height changes. */}
            <form onSubmit={handleSaveSubject} className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar scrollbar-gutter-stable px-6 py-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-5">
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="catalog-code" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Subject Code *</label>
                  <input
                    id="catalog-code"
                    data-testid="catalog-code"
                    autoFocus
                    required
                    type="text"
                    value={formData.subjectCode}
                    onChange={e => setFormData({ ...formData, subjectCode: e.target.value })}
                    disabled={isSubmitting}
                    placeholder="e.g. ITEP 415"
                    className={`${inputClass} font-bold`}
                  />
                  {sameCodeSubjects.length > 0 && (
                    <p className="flex items-start gap-1 text-[10px] text-amber-700 dark:text-amber-400 mt-1">
                      <Info size={11} className="shrink-0 mt-px" />
                      <span>
                        Also used by {sameCodeSubjects.map(s => s.descriptiveTitle || 'an untitled subject').join('; ')}. Codes may repeat, so save only if this is a different subject.
                      </span>
                    </p>
                  )}
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="catalog-type" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Subject Type *</label>
                  <Select
                    id="catalog-type"
                    data-testid="catalog-type"
                    value={formData.type}
                    onChange={e => handleTypeChange(e.target.value)}
                    disabled={isSubmitting}
                    className={`${inputClass} font-bold`}
                  >
                    {SUBJECT_TYPE_VALUES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </Select>
                  {isNstpType && (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">NSTP can only be placed in 1st Year curricula.</p>
                  )}
                  {formData.type === 'Major' && (
                    <label htmlFor="catalog-practicum" className="mt-2 flex items-start gap-2 cursor-pointer">
                      <input
                        id="catalog-practicum"
                        data-testid="catalog-practicum"
                        type="checkbox"
                        checked={Boolean(formData.isPracticum)}
                        onChange={e => setFormData({ ...formData, isPracticum: e.target.checked })}
                        disabled={isSubmitting}
                        className="w-4 h-4 mt-px shrink-0 rounded border-slate-300 focus:ring-yellow-500"
                      />
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 leading-snug">
                        Practicum / OJT subject
                        <span className="block text-[10px] font-medium text-slate-500 dark:text-slate-400">No class hours or room; it is never put on the timetable. One coordinator per section.</span>
                      </span>
                    </label>
                  )}
                </div>

                <div className="col-span-2">
                  <label htmlFor="catalog-title" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Descriptive Title *</label>
                  <input
                    id="catalog-title"
                    data-testid="catalog-title"
                    required
                    type="text"
                    value={formData.descriptiveTitle}
                    onChange={e => setFormData({ ...formData, descriptiveTitle: e.target.value })}
                    disabled={isSubmitting}
                    placeholder="e.g. Capstone Project 2"
                    className={inputClass}
                  />
                </div>

                <div className="col-span-2">
                  <label htmlFor="catalog-description" className="text-xs font-bold text-yellow-600 dark:text-yellow-400 mb-1.5 uppercase tracking-wider flex items-center">
                    <Tag size={14} className="mr-1.5" />
                    Course Description
                  </label>
                  <textarea
                    id="catalog-description"
                    data-testid="catalog-description"
                    rows={3}
                    value={formData.subjectDescription}
                    onChange={e => setFormData({ ...formData, subjectDescription: e.target.value })}
                    disabled={isSubmitting}
                    placeholder="Syllabus summary or key competencies."
                    className={`${inputClass} resize-none`}
                  />
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                    Optional. It helps match professors to this subject; the title is used while it is empty.
                  </p>
                </div>

                {/* CONTACT HOURS & CREDIT UNITS: lecture hours and units for every type; lab hours
                    for a Major only (Minor and NSTP are lecture-only and save 0 lab hours). */}
                <div className="col-span-2 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#121212]/60">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 truncate">Contact Hours &amp; Credit Units</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isLectureOnlyMajor && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border whitespace-nowrap bg-green-100 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20">
                          <CheckCircle2 size={11} className="shrink-0" /> Lecture-Only Major
                        </span>
                      )}
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border whitespace-nowrap bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
                        {formData.type}
                      </span>
                    </div>
                  </div>
                  <div className={`grid gap-3 ${isPracticumForm ? 'grid-cols-1' : isLectureOnlyType ? 'grid-cols-2' : 'grid-cols-3'}`}>
                    {[['lecHours', 'Lec Hrs/Wk *', '0.5'], ['labHours', 'Lab Hrs/Wk *', '0.5'], ['units', 'Units *', '1']]
                      .filter(([field]) => !(isPracticumForm && field !== 'units') && !(isLectureOnlyType && field === 'labHours'))
                      .map(([field, label, step]) => (
                      <div key={field}>
                        <label htmlFor={`catalog-${field}`} className="block truncate text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">{label}</label>
                        <input
                          id={`catalog-${field}`}
                          data-testid={`catalog-${field}`}
                          required
                          type="number"
                          inputMode={step === '1' ? 'numeric' : 'decimal'}
                          min={field === 'units' ? '1' : '0'}
                          max={field === 'units' ? '12' : (maxHoursPerType !== null ? String(maxHoursPerType) : undefined)}
                          step={step}
                          value={formData[field]}
                          onChange={e => setFormData({ ...formData, [field]: e.target.value })}
                          disabled={isSubmitting}
                          aria-invalid={Boolean(hoursError)}
                          aria-describedby={hoursError ? 'catalog-hours-error' : undefined}
                          className={`${inputClass} font-bold`}
                        />
                        <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 truncate">{field === 'units' ? 'Whole number' : `Half-hour steps${maxHoursPerType !== null ? `, max ${maxHoursPerType}` : ''}`}</p>
                      </div>
                    ))}
                  </div>
                  {hoursError && (
                    <p id="catalog-hours-error" role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] font-bold text-red-600 dark:text-red-400">
                      <AlertCircle size={13} className="mt-px shrink-0" /> {hoursError}
                    </p>
                  )}
                  {isLectureOnlyType && (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-2">
                      {formData.type} subjects are lecture-only: laboratory hours are saved as 0.
                    </p>
                  )}
                  {isPracticumForm && (
                    <p data-testid="catalog-practicum-note" className="text-[10px] text-slate-500 dark:text-slate-400 mt-2">
                      Practicum subjects have no class hours (saved as 0). Each section's coordinator counts {policy?.load?.ojtCoordinatorHours ?? '…'} h of teaching load (Scheduling Policy).
                    </p>
                  )}
                </div>

                {/* ROOM ROUTING follows the type: a Major chooses its lecture mode (Phase 3 Step 7; its labs
                    always get a room), a Minor chooses a room or TBA, NSTP is TBA. */}
                <div className="col-span-2">
                  <p className="block text-xs font-bold text-purple-600 dark:text-purple-400 mb-1.5 uppercase tracking-wider">Room Routing</p>
                  <div className="min-h-12 flex items-center p-3 rounded-xl border border-purple-200 dark:border-purple-800/40 bg-purple-50/50 dark:bg-purple-950/20">
                    {hasLectureMode ? (
                      <div className="w-full">
                        <label htmlFor="catalog-lectureMode" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Lecture mode</label>
                        <Select
                          id="catalog-lectureMode"
                          data-testid="catalog-lectureMode"
                          value={formData.lectureMode}
                          onChange={e => { setFormData({ ...formData, lectureMode: e.target.value }); setLectureModeError(''); }}
                          disabled={isSubmitting}
                          aria-invalid={Boolean(lectureModeError)}
                          aria-describedby={lectureModeError ? 'catalog-lectureMode-hint catalog-lectureMode-error' : 'catalog-lectureMode-hint'}
                          className={`${inputClass} font-bold`}
                        >
                          {LECTURE_MODE_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </Select>
                        <p id="catalog-lectureMode-hint" data-testid="catalog-lectureMode-hint" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                          {LECTURE_MODE_HINT}
                        </p>
                        {lectureModeError && (
                          <p id="catalog-lectureMode-error" data-testid="catalog-lectureMode-error" role="alert" className="mt-1.5 flex items-start gap-1.5 text-[11px] font-bold text-red-600 dark:text-red-400">
                            <AlertCircle size={13} className="mt-px shrink-0" /> {lectureModeError}
                          </p>
                        )}
                      </div>
                    ) : isMinorType ? (
                      <div className="w-full">
                        <label htmlFor="catalog-requiresRoom" className="flex items-center gap-3 cursor-pointer w-full">
                          <input
                            id="catalog-requiresRoom"
                            data-testid="catalog-requiresRoom"
                            type="checkbox"
                            checked={Boolean(formData.requiresRoom)}
                            onChange={e => setFormData({ ...formData, requiresRoom: e.target.checked })}
                            disabled={isSubmitting}
                            aria-describedby="catalog-requiresRoom-hint"
                            className="w-4 h-4 shrink-0 text-purple-600 rounded border-slate-300 focus:ring-purple-500 focus-visible:ring-2"
                          />
                          <span className="text-xs font-bold text-slate-700 dark:text-slate-300 leading-snug">Needs a CCS room</span>
                        </label>
                        {/* Phase 3 Step 4: the second sentence says what ticking means when the CCS rooms are full. */}
                        <p id="catalog-requiresRoom-hint" data-testid="catalog-requiresRoom-hint" className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 ml-7 leading-snug">
                          Untick if another department hosts this class (room TBA). Ticked classes get a CCS room, or TBA when the CCS rooms are full.
                        </p>
                      </div>
                    ) : (
                      <p className="flex items-center gap-3 text-xs text-purple-900 dark:text-purple-300 leading-snug">
                        <ShieldCheck size={16} className="shrink-0 text-purple-600 dark:text-purple-400" />
                        {isNstpType
                          ? 'NSTP is scheduled as TBA: no physical room is allocated.'
                          : 'Practicum is never put on the timetable, so no room is booked.'}
                      </p>
                    )}
                  </div>
                </div>

                {/* NSTP meets in the Scheduling Policy's block; it is not set per subject. */}
                {isNstpType && (
                  <div data-testid="catalog-nstp-block" className="col-span-2 p-4 rounded-2xl border border-yellow-200 dark:border-yellow-500/20 bg-yellow-50/50 dark:bg-yellow-500/5 flex items-start gap-2">
                    <Info size={14} className="mt-px shrink-0 text-yellow-700 dark:text-yellow-400" />
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                      <span className="font-bold">NSTP schedule:</span>{' '}
                      {policy ? nstpBlockLabel(policy) : 'loading the Scheduling Policy…'}, 1st-year sections only.
                      It needs no room and its professor is TBA. Change the block on the Scheduling Policy page.
                    </p>
                  </div>
                )}
              </div>
              </div>

              <div className="shrink-0 px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between gap-3">
                <p className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:block">
                  {editingSubject ? 'Changes apply as soon as you save.' : 'New subjects start active.'}
                </p>
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={closeModal}
                    disabled={isSubmitting}
                    className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-testid="catalog-submit"
                    disabled={isSubmitting}
                    className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-yellow-500 hover:bg-yellow-600 transition-colors shadow-md shadow-yellow-500/20 flex items-center disabled:opacity-70 cursor-pointer"
                  >
                    {isSubmitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                    {isSubmitting ? 'Saving...' : editingSubject ? 'Save Changes' : 'Create Subject'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DISABLE CONFIRMATION */}
      {disableQuestion.target && (
        <ConfirmDialog
          testId="disable-confirm"
          title={`Disable ${disableQuestion.target.subjectCode}?`}
          keepLabel="Cancel"
          confirmLabel={`Disable ${disableQuestion.target.subjectCode}`}
          busyLabel="Disabling…"
          onKeep={disableQuestion.keep}
          onConfirm={disableQuestion.confirm}
          busy={disableQuestion.busy}
          error={disableQuestion.error}
          tone="red"
          icon={Ban}
          returnFocusRef={tableRegionRef}
        >
          {disableQuestion.target.descriptiveTitle ? `${disableQuestion.target.descriptiveTitle} is` : 'It is'} no longer scheduled; its record and its curriculum placements are kept. You can enable it again.
        </ConfirmDialog>
      )}
    </>
  );
}
