import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Plus, Loader2, CheckCircle2, X, ShieldCheck, GraduationCap, AlertCircle, AlertOctagon, Lock, Ban } from 'lucide-react';
import api from '../../services/api';
import usePagination from '../../hooks/usePagination';
import useEscapeKey from '../../hooks/useEscapeKey';
import useConfirmDisable from '../../hooks/useConfirmDisable';
import TablePagination from '../../components/ui/TablePagination';
import RowActions from '../../components/ui/RowActions';
import FilterPopover, { FilterSelect } from '../../components/ui/FilterPopover';
import { disabledCellClass, disabledBadgeClass } from '../../components/ui/tableStyles';
import SortableHeader from '../../components/ui/SortableHeader';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import useSort from '../../hooks/useSort';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import { undoDisable } from '../../utils/recordToggle';
import Select from '../../components/ui/Select';

// The visible reason (Phase 3 Step 6) the page's write controls point at while the role may not use them.
const EDIT_NOTE_ID = 'sections-permission-note';

const PROGRAM_OPTIONS = [
  { value: 'BSIT', label: 'BSIT — BS Information Technology' },
  { value: 'BSCS', label: 'BSCS — BS Computer Science' }
];

const YEAR_LEVEL_FILTER_OPTIONS = [
  { value: '1', label: '1st Year' },
  { value: '2', label: '2nd Year' },
  { value: '3', label: '3rd Year' },
  { value: '4', label: '4th Year' }
];

// Labelled the way the table's status badge reads, so the filter and the rows agree.
const STATUS_FILTER_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' }
];

// '' on every key means "All"; program values are GA codes, yearLevel is the stringified level.
const DEFAULT_FILTERS = { program: '', yearLevel: '', status: '' };

const PROGRAM_NAMES = {
  BSIT: 'BS Information Technology',
  BSCS: 'BS Computer Science'
};

const LEGACY_PROGRAM_CODES = {
  'bs information technology': 'BSIT',
  'bs computer science': 'BSCS'
};

// Maps legacy long-form program names (and already-valid codes) to the GA program code.
function normalizeProgram(value) {
  const raw = String(value || '').trim();
  const code = raw.toUpperCase();
  if (PROGRAM_NAMES[code]) return code;
  return LEGACY_PROGRAM_CODES[raw.toLowerCase()] || 'BSIT';
}

// Specialization tracks are stored as codes (Section.track). NONE: BSIT 1st-2nd year;
// IS: every BSCS section; WMAD / SMP / AMG: chosen for BSIT 3rd-4th year.
const TRACK_GENERAL = 'NONE';
const TRACK_BSCS = 'IS';
const BSIT_UPPER_TRACKS = ['WMAD', 'SMP', 'AMG'];
const TRACK_LABELS = {
  NONE: 'NONE (General, no specialization)',
  IS: 'IS (Intelligence Systems)',
  WMAD: 'WMAD (Web and Mobile Application Development)',
  SMP: 'SMP (Service Management Program)',
  AMG: 'AMG (Animation and Motion Graphics)'
};
const trackLabel = (code) => TRACK_LABELS[code] || code;

// Older sections stored long labels; the gateway already maps them to codes, this is a fallback.
const LEGACY_TRACK_CODES = {
  'general track': 'NONE',
  'intelligence systems': 'IS',
  'web and mobile application development (wmad)': 'WMAD',
  'service management program (smp)': 'SMP',
  'animation and motion graphics (amg)': 'AMG'
};
function normalizeTrackCode(value) {
  const raw = String(value || '').trim();
  if (TRACK_LABELS[raw.toUpperCase()]) return raw.toUpperCase();
  return LEGACY_TRACK_CODES[raw.toLowerCase()] || '';
}

// Only BSIT 3rd and 4th year cohorts choose a specialization; every other cohort's track is fixed.
function isTrackSelectable(program, yearLevel) {
  const yr = Number(yearLevel);
  return program === 'BSIT' && (yr === 3 || yr === 4);
}

// Resolves the Major/Track for a program + year level. Returns '' when a BSIT upper-year
// section still needs the Dean to pick one of BSIT_UPPER_TRACKS.
function resolveTrack(program, yearLevel, chosen) {
  const yr = Number(yearLevel);
  if (program === 'BSCS') return TRACK_BSCS;
  if (program === 'BSIT' && (yr === 1 || yr === 2)) return TRACK_GENERAL;
  if (isTrackSelectable(program, yr)) {
    const code = normalizeTrackCode(chosen);
    return BSIT_UPPER_TRACKS.includes(code) ? code : '';
  }
  return '';
}

const FETCH_ERROR_MESSAGE = 'The sections could not be loaded. Check your connection, then select Retry Request.';

// Sensible defaults: the most common new cohort is a BSIT 1st year block, whose track is NONE.
const DEFAULT_FORM = {
  sectionCode: '',
  program: 'BSIT',
  yearLevel: 1,
  track: TRACK_GENERAL,
  // Optional and informational: blank means not recorded.
  studentCount: ''
};

const SORT_GETTERS = {
  sectionCode: s => s.sectionCode,
  program: s => normalizeProgram(s.program),
  track: s => resolveTrack(normalizeProgram(s.program), s.yearLevel, s.track) || null,
  yearLevel: s => Number(s.yearLevel) || null,
  studentCount: s => (Number.isFinite(s.studentCount) ? s.studentCount : null)
};

export default function SectionManager() {
  // Adding, editing, disabling and enabling sections: the permission map's data.edit.
  const edit = usePermission('data.edit');
  const [sectionsList, setSectionsList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSection, setEditingSection] = useState(null);
  const [pendingToggleIds, setPendingToggleIds] = useState(() => new Set());
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [validationError, setValidationError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  // Monotonic ticket for list refetches: a slower, older response must never overwrite a newer one.
  const syncSeq = useRef(0);

  // Auto-dismiss is scoped to the toast it was scheduled for: a timer left over from an earlier,
  // slower flow (e.g. a save whose re-sync is still in flight) must never clear a newer message.
  // Memoized so the loader below can list it as a dependency without re-creating itself.
  // tone 'error' shows a failure; `undo` adds an Undo button (and a longer time to press it).
  const showToast = useCallback((message, tone = 'success', undo = null) => {
    const entry = { message, tone, undo };
    setToast(entry);
    setTimeout(() => setToast(current => (current === entry ? null : current)), undo ? 10000 : 4000);
  }, []);

  // The single read path for the sections collection. The mount effect and the Atlas-error
  // "Retry Request" button run it with the spinner; every successful mutation runs it silently
  // after its optimistic update, so the table always shows what Atlas actually persisted.
  // A silent re-sync failure keeps the optimistic rows and only reports a toast. Only the
  // latest refetch may touch state, so a superseded response (StrictMode double-mount, a
  // re-sync overtaking a retry, or two rapid toggles) can never revert a newer list.
  const loadSections = useCallback(async ({ silent = false } = {}) => {
    const seq = ++syncSeq.current;
    if (silent) {
      // Post-mutation re-sync: the footer badge pulses amber; the mount load keeps the spinner.
      setIsSyncing(true);
    } else {
      setIsLoading(true);
      setErrorMessage('');
    }
    try {
      const res = await api.get('/sections');
      if (seq !== syncSeq.current) return;
      setSectionsList(Array.isArray(res.data) ? res.data : []);
      // Atlas answered, so a stale gateway error must not keep hiding the fresh table.
      setErrorMessage('');
      setLastSyncedAt(new Date());
    } catch (err) {
      if (seq !== syncSeq.current) return;
      if (silent) {
        console.warn('[Sections] Post-mutation re-sync failed:', err.message);
        showToast('Saved, but the table could not be read again. It shows your change and refreshes on the next one.');
      } else {
        console.warn('[Sections] Atlas fetch failed:', err.message);
        setSectionsList([]);
        setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
      }
    } finally {
      // If this request overtook an in-flight full load, it now owns the loading flag. The same
      // ticket stops a superseded re-sync from clearing the badge of a newer one still in flight.
      if (seq === syncSeq.current) {
        setIsLoading(false);
        setIsSyncing(false);
      }
    }
  }, [showToast]);

  useEffect(() => {
    // Fetch-on-mount through the same loader as "Retry Request". The loader flips the loading /
    // error flags before it awaits, which the compiler lint reads as derived state; here it is the
    // intended initial fetch, so the rule is scoped off for this one call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSections();
    // Bumping the ticket on cleanup discards any response that lands after unmount.
    return () => { syncSeq.current += 1; };
  }, [loadSections]);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setEditingSection(null);
    setValidationError('');
    setFieldErrors({});
  }, []);

  useEscapeKey(isModalOpen, closeModal, isSubmitting);

  const openAddModal = () => {
    if (!edit.allowed) return;
    setEditingSection(null);
    setFormData(DEFAULT_FORM);
    setValidationError('');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const openEditModal = (section) => {
    if (!edit.allowed) return;
    const program = normalizeProgram(section.program);
    const yearLevel = section.yearLevel || 1;
    setEditingSection(section);
    setFormData({
      sectionCode: section.sectionCode,
      program,
      yearLevel,
      track: resolveTrack(program, yearLevel, section.track || ''),
      studentCount: Number.isFinite(section.studentCount) ? String(section.studentCount) : ''
    });
    setValidationError('');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  // Program and year level drive the track, so it is recomputed on every change of either field.
  const handleProgramChange = (e) => {
    const program = e.target.value;
    setFormData(prev => ({ ...prev, program, track: resolveTrack(program, prev.yearLevel, prev.track) }));
  };

  const handleYearLevelChange = (e) => {
    const yearLevel = Number(e.target.value);
    setFormData(prev => ({ ...prev, yearLevel, track: resolveTrack(prev.program, yearLevel, prev.track) }));
  };

  const handleSaveSection = async (e) => {
    e.preventDefault();
    setValidationError('');
    setFieldErrors({});

    const cleanCode = formData.sectionCode.trim().toUpperCase();
    const program = normalizeProgram(formData.program);
    const yr = Number(formData.yearLevel);
    const track = resolveTrack(program, yr, formData.track);

    if (!cleanCode) {
      setFieldErrors({ sectionCode: 'Enter the section code, for example BSIT 1A.' });
      return;
    }
    if (!Number.isInteger(yr) || yr < 1 || yr > 4) {
      setFieldErrors({ yearLevel: 'Year level must be between 1 and 4.' });
      return;
    }
    if (isTrackSelectable(program, yr) && !track) {
      setFieldErrors({ track: 'Select a specialization track (WMAD, SMP or AMG) for 3rd and 4th year BSIT sections.' });
      return;
    }
    const countText = String(formData.studentCount).trim();
    const studentCount = countText === '' ? null : Number(countText);
    if (studentCount !== null && !(Number.isInteger(studentCount) && studentCount >= 1 && studentCount <= 100)) {
      setFieldErrors({ studentCount: 'Number of students must be a whole number from 1 to 100, or left blank.' });
      return;
    }

    setIsSubmitting(true);

    const payload = {
      sectionCode: cleanCode,
      program,
      yearLevel: yr,
      track,
      studentCount,
      // Creation is always active; an edit omits the key so Atlas keeps the persisted state.
      ...(editingSection ? {} : { isActive: true })
    };

    try {
      if (editingSection) {
        const res = await api.put(`/sections/${editingSection._id}`, payload);
        setSectionsList(prev => prev.map(s => s._id === editingSection._id ? res.data : s));
        showToast(`Section ${cleanCode} updated.`);
      } else {
        const res = await api.post('/sections', payload);
        setSectionsList(prev => [res.data, ...prev]);
        showToast(`Section ${cleanCode} added.`);
      }
    } catch (err) {
      // Field errors go next to their fields; the form keeps everything that was typed.
      const errors = err.response?.data?.errors;
      if (Array.isArray(errors) && errors.length) {
        setFieldErrors(Object.fromEntries(errors.map(er => [er.field, er.message])));
        setValidationError('The section was not saved. Fix the fields marked below.');
      } else {
        setValidationError(err.response?.data?.message || `The section could not be saved (${err.message}). Your entries are still here; try again.`);
      }
      setIsSubmitting(false);
      return;
    }

    // Saved. Close the dialog and release the submit lock BEFORE the Atlas re-sync so the Dean
    // can reopen the modal immediately; the optimistic row is already on screen and the silent
    // loader replaces it with the persisted document when the round-trip lands.
    closeModal();
    setIsSubmitting(false);
    await loadSections({ silent: true });
  };

  // PATCH /sections/:id/toggle flips the section's status; resolves its new state (or throws). The
  // row's button shows a spinner meanwhile.
  const markPending = (id, pending) => setPendingToggleIds(prev => {
    const next = new Set(prev);
    if (pending) next.add(id); else next.delete(id);
    return next;
  });
  const toggleSection = async (section) => {
    markPending(section._id, true);
    try {
      const res = await api.patch(`/sections/${section._id}/toggle`);
      const newIsActive = Boolean(res.data.isActive);
      setSectionsList(prev => prev.map(s => s._id === section._id ? { ...s, isActive: newIsActive } : s));
      return newIsActive;
    } finally {
      markPending(section._id, false);
    }
  };
  const statusText = (section, isActive) => (isActive
    ? `${section.sectionCode} enabled: the scheduler builds its Mother Schedule again.`
    : `${section.sectionCode} disabled: the scheduler no longer builds its Mother Schedule.`);

  // Undo of a disable: the section is enabled again only if it is still disabled (utils/recordToggle.js).
  const undoSectionDisable = async (section) => {
    markPending(section._id, true);
    const result = await undoDisable({ listPath: '/sections', togglePath: `/sections/${section._id}/toggle`, id: section._id, name: section.sectionCode });
    markPending(section._id, false);
    if (typeof result.isActive === 'boolean') setSectionsList(prev => prev.map(s => s._id === section._id ? { ...s, isActive: result.isActive } : s));
    showToast(result.message, result.tone);
    await loadSections({ silent: true });
  };

  // Disabling asks first (audit X6); the message that follows offers Undo.
  const disableQuestion = useConfirmDisable(async (section) => {
    try {
      const isActive = await toggleSection(section);
      showToast(statusText(section, isActive), 'success', isActive ? null : () => undoSectionDisable(section));
      loadSections({ silent: true });
      return '';
    } catch (err) {
      return `${section.sectionCode} was not disabled (${err.response?.data?.message || err.message}). Nothing changed: try again, or cancel.`;
    }
  });

  // The row's Disable asks first; Enable acts at once.
  const handleToggleStatus = async (section, e) => {
    e?.stopPropagation?.();
    if (!edit.allowed || pendingToggleIds.has(section._id)) return;
    if (section.isActive) {
      disableQuestion.ask(section);
      return;
    }
    try {
      showToast(statusText(section, await toggleSection(section)));
      await loadSections({ silent: true });
    } catch (err) {
      showToast(`${section.sectionCode}: the status could not be changed (${err.response?.data?.message || err.message}). Nothing changed; try again.`, 'error');
    }
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;

  // A row must satisfy the search AND every set filter. Program matching goes through
  // normalizeProgram so legacy long-form names in Atlas still land under their GA code.
  const filteredSections = sectionsList.filter(s => {
    const code = normalizeProgram(s.program);
    const isActive = Boolean(s.isActive);

    if (filters.program && code !== filters.program) return false;
    if (filters.yearLevel && String(s.yearLevel) !== filters.yearLevel) return false;
    if (filters.status === 'active' && !isActive) return false;
    if (filters.status === 'disabled' && isActive) return false;

    if (!normalizedQuery) return true;
    return (
      s.sectionCode?.toLowerCase().includes(normalizedQuery) ||
      code.toLowerCase().includes(normalizedQuery) ||
      PROGRAM_NAMES[code].toLowerCase().includes(normalizedQuery) ||
      trackLabel(resolveTrack(code, s.yearLevel, s.track)).toLowerCase().includes(normalizedQuery)
    );
  });

  const { sorted: sortedSections, sort, toggle: toggleSort } = useSort(filteredSections, SORT_GETTERS, 'sectionCode');
  const { currentPage, totalPages, totalItems, pageItems, rangeLabel, setPage, resetPage } = usePagination(sortedSections, 25);

  // Any change to the query set returns to page 1 so the Dean never lands on a stale empty page.
  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
    resetPage();
  };

  const handleFilterChange = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    resetPage();
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    resetPage();
  };

  const formProgram = normalizeProgram(formData.program);
  const trackSelectable = isTrackSelectable(formProgram, formData.yearLevel);
  const resolvedTrack = resolveTrack(formProgram, formData.yearLevel, formData.track);

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg flex flex-col">
        
        {/* HEADER AREA */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
          <PageHeader pageKey="sections" />

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="Search sections, programs or tracks..." 
                aria-label="Search sections"
                data-testid="section-search"
                value={searchQuery} 
                onChange={handleSearchChange}
                className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-blue-500 transition-colors text-slate-900 dark:text-white"
              />
            </div>
            <FilterPopover
              title="Filter Sections"
              ariaLabel="Section filters"
              accent="blue"
              activeCount={activeFilterCount}
              summary={`${filteredSections.length} of ${sectionsList.length} shown`}
              onClear={clearFilters}
            >
              <FilterSelect
                label="Program"
                accent="blue"
                value={filters.program}
                onChange={(value) => handleFilterChange('program', value)}
                options={PROGRAM_OPTIONS}
                allLabel="All programs"
              />
              <FilterSelect
                label="Year Level"
                accent="blue"
                value={filters.yearLevel}
                onChange={(value) => handleFilterChange('yearLevel', value)}
                options={YEAR_LEVEL_FILTER_OPTIONS}
                allLabel="All year levels"
              />
              <FilterSelect
                label="Status"
                accent="blue"
                value={filters.status}
                onChange={(value) => handleFilterChange('status', value)}
                options={STATUS_FILTER_OPTIONS}
                allLabel="All statuses"
              />
            </FilterPopover>
            <button
              type="button"
              data-testid="section-add"
              onClick={openAddModal}
              disabled={!edit.allowed}
              {...blockedBy(edit, EDIT_NOTE_ID)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center transition-colors shadow-lg shadow-blue-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            >
              <Plus size={16} className="mr-2" /> Add Section
            </button>
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {!edit.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={EDIT_NOTE_ID} permission={edit} lead="You can view the sections." />
          </div>
        )}

        {/* TABLE AREA */}
        <div className="relative min-h-[400px] overflow-visible">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-blue-500" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading sections…</p>
            </div>
          ) : errorMessage ? (
            <div className="p-12 text-center max-w-md mx-auto my-8">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Sections could not be loaded</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={() => loadSections()}
                className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold hover:bg-blue-700 transition-colors cursor-pointer"
              >
                Retry Request
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-sm">
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  <SortableHeader label="Section" sortKey="sectionCode" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Program" sortKey="program" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Track" sortKey="track" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="Year Level" sortKey="yearLevel" sort={sort} onSort={toggleSort} className="text-center" align="center" />
                  <SortableHeader label="Students" sortKey="studentCount" sort={sort} onSort={toggleSort} className="text-center" align="center" />
                  <th scope="col" className="px-6 py-4 font-bold text-xs text-center">Status</th>
                  <th scope="col" className="px-6 py-4 font-bold text-xs text-right sticky right-0 bg-white dark:bg-[#18181b]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {filteredSections.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-slate-500 dark:text-slate-400">
                      <GraduationCap size={32} className="mx-auto mb-2 opacity-30 text-blue-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        {searchQuery || hasActiveFilters ? 'No Matching Sections Found' : 'No Section Cohorts Registered'}
                      </p>
                      <p className="text-xs mt-1">
                        {searchQuery || hasActiveFilters
                          ? 'Try adjusting your search or clearing the active filters.'
                          : edit.allowed ? 'Select "Add Section" above to add the first section.' : edit.reason}
                      </p>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((section) => {
                    const dimClass = section.isActive === false ? ` ${disabledCellClass}` : '';
                    const programCode = normalizeProgram(section.program);
                    const track = resolveTrack(programCode, section.yearLevel, section.track);

                    return (
                      <tr key={section._id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group text-slate-700 dark:text-slate-300">
                        <td className={`px-6 py-3.5 font-black text-slate-900 dark:text-white${dimClass}`}>
                          <div className="flex items-center whitespace-nowrap">
                            <GraduationCap size={16} className="mr-2 text-blue-500" />
                            {section.sectionCode}
                          </div>
                        </td>
                        <td className={`px-6 py-3.5 font-medium text-slate-700 dark:text-slate-300 text-xs${dimClass}`}>
                          <span title={PROGRAM_NAMES[programCode]} className="font-bold">{programCode}</span>
                        </td>
                        <td className={`px-6 py-3.5 text-xs font-medium text-slate-700 dark:text-slate-300${dimClass}`}>
                          {track
                            ? <span title={trackLabel(track)} className="font-bold">{track}</span>
                            : <span className="text-slate-500 dark:text-slate-400" title="Track not chosen yet">&mdash;</span>}
                        </td>
                        <td className={`px-6 py-3.5 text-center${dimClass}`}>
                          <span className="whitespace-nowrap px-2.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                            Year {section.yearLevel}
                          </span>
                        </td>
                        <td className={`px-6 py-3.5 text-center text-xs font-bold${dimClass}`}>
                          {Number.isFinite(section.studentCount) ? section.studentCount : <span className="text-slate-500 dark:text-slate-400" title="Not recorded">&mdash;</span>}
                        </td>
                        <td className={`px-6 py-3.5 text-center${dimClass}`}>
                          {section.isActive ? (
                            <span className="inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400 border border-green-200 dark:border-green-500/20">
                              <ShieldCheck size={12} className="mr-1" /> Active
                            </span>
                          ) : (
                            <span className={disabledBadgeClass}>
                              Disabled
                            </span>
                          )}
                        </td>
                        <td className={`px-6 py-3.5 text-right sticky right-0 ${section.isActive === false ? 'bg-slate-50 dark:bg-[#1c1c1f]' : 'bg-white dark:bg-[#18181b]'}`}>
                          <RowActions
                            isActive={section.isActive}
                            onEdit={() => openEditModal(section)}
                            onToggle={(e) => handleToggleStatus(section, e)}
                            isPending={pendingToggleIds.has(section._id)}
                            name={section.sectionCode}
                            blockedReason={edit.reason}
                            reasonId={EDIT_NOTE_ID}
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto text-xs text-slate-500 dark:text-slate-400">
            <p>
              Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of <span className="font-bold text-slate-700 dark:text-slate-300">{totalItems}</span> sections
            </p>
            <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Section pages" isSyncing={isSyncing} hasError={Boolean(errorMessage)} lastSyncedAt={lastSyncedAt} />
          </div>
        </div>
      </div>

      {/* REUSABLE CONTROLLED MODAL */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={(event) => {
            if (event.target === event.currentTarget && !isSubmitting) closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="section-modal-title"
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center">
              <div>
                <h3 id="section-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">
                  {editingSection ? 'Edit Section Details' : 'Add New Section'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {editingSection ? `Change the details of ${editingSection.sectionCode}.` : 'A class section the scheduler builds a Mother Schedule for.'}
                </p>
              </div>
              <button type="button" onClick={closeModal} disabled={isSubmitting} aria-label="Close dialog" className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded-lg disabled:opacity-50 cursor-pointer">
                <X size={18} />
              </button>
            </div>

            {validationError && (
              <div className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400">
                <AlertCircle size={16} className="mr-2 shrink-0" /> {validationError}
              </div>
            )}
            
            <form onSubmit={handleSaveSection} noValidate className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="section-code" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Section code <span aria-hidden="true">*</span><span className="sr-only">(required)</span></label>
                  <input 
                    id="section-code"
                    data-testid="section-code"
                    required 
                    aria-invalid={Boolean(fieldErrors.sectionCode)}
                    type="text" 
                    value={formData.sectionCode} 
                    onChange={e => setFormData({ ...formData, sectionCode: e.target.value })} 
                    disabled={isSubmitting} 
                    placeholder="e.g. BSIT 3A" 
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold" 
                  />
                  {fieldErrors.sectionCode && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.sectionCode}</p>}
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="section-program" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Program <span aria-hidden="true">*</span><span className="sr-only">(required)</span></label>
                  <Select
                    id="section-program"
                    data-testid="section-program"
                    value={formData.program}
                    onChange={handleProgramChange}
                    disabled={isSubmitting}
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50"
                  >
                    {PROGRAM_OPTIONS.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </Select>
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="section-year" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Year level <span aria-hidden="true">*</span><span className="sr-only">(required)</span></label>
                  <Select 
                    id="section-year"
                    data-testid="section-year"
                    value={formData.yearLevel} 
                    onChange={handleYearLevelChange} 
                    disabled={isSubmitting} 
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  >
                    <option value={1}>1st Year (Level 1)</option>
                    <option value={2}>2nd Year (Level 2)</option>
                    <option value={3}>3rd Year (Level 3)</option>
                    <option value={4}>4th Year (Level 4)</option>
                  </Select>
                  {fieldErrors.yearLevel && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.yearLevel}</p>}
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="section-student-count" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Number of students (optional)</label>
                  <input
                    id="section-student-count"
                    data-testid="section-student-count"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="100"
                    step="1"
                    value={formData.studentCount}
                    onChange={e => setFormData({ ...formData, studentCount: e.target.value })}
                    disabled={isSubmitting}
                    placeholder="Not recorded"
                    aria-invalid={Boolean(fieldErrors.studentCount)}
                    aria-describedby="section-student-count-help"
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                  />
                  <p id="section-student-count-help" className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">For information. The scheduler ignores it unless the Scheduling Policy turns capacity checking on.</p>
                  {fieldErrors.studentCount && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.studentCount}</p>}
                </div>

                <div className="col-span-2">
                  <label htmlFor="section-track" className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Specialization Track *</label>
                  {trackSelectable ? (
                    <Select
                      id="section-track"
                      data-testid="section-track"
                      required
                      aria-invalid={Boolean(fieldErrors.track)}
                      value={formData.track}
                      onChange={e => setFormData(prev => ({ ...prev, track: e.target.value }))}
                      disabled={isSubmitting}
                      className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50 font-bold"
                    >
                      <option value="" disabled>Select a track</option>
                      {BSIT_UPPER_TRACKS.map(option => (
                        <option key={option} value={option}>{trackLabel(option)}</option>
                      ))}
                    </Select>
                  ) : (
                    <div className="relative">
                      <input
                        id="section-track"
                        data-testid="section-track"
                        type="text"
                        value={trackLabel(resolvedTrack)}
                        disabled
                        className="w-full bg-slate-100 dark:bg-white/5 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl py-2.5 pl-3.5 pr-10 text-sm font-bold text-slate-700 dark:text-slate-300 disabled:opacity-100 cursor-not-allowed"
                      />
                      <Lock size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                    </div>
                  )}
                  <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {trackSelectable
                      ? 'Required: BSIT 3rd and 4th year cohorts specialize in WMAD, SMP or AMG.'
                      : formProgram === 'BSCS'
                        ? 'Locked: every BSCS section is on the IS track.'
                        : 'Locked: BSIT 1st and 2nd year sections have no specialization yet.'}
                  </p>
                  {fieldErrors.track && <p role="alert" className="mt-1 text-[11px] font-bold text-red-600 dark:text-red-400">{fieldErrors.track}</p>}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800/60 flex justify-end gap-3 bg-slate-50 dark:bg-[#1a1a1c]">
                <button 
                  type="button" 
                  onClick={closeModal}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  data-testid="section-submit"
                  disabled={isSubmitting} 
                  className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-md shadow-blue-900/20 flex items-center disabled:opacity-70 cursor-pointer"
                >
                  {isSubmitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                  {isSubmitting ? 'Saving...' : editingSection ? 'Save Changes' : 'Create Section'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DISABLE CONFIRMATION */}
      {disableQuestion.target && (
        <ConfirmDialog
          testId="disable-confirm"
          title={`Disable ${disableQuestion.target.sectionCode}?`}
          keepLabel="Cancel"
          confirmLabel={`Disable ${disableQuestion.target.sectionCode}`}
          busyLabel="Disabling…"
          onKeep={disableQuestion.keep}
          onConfirm={disableQuestion.confirm}
          busy={disableQuestion.busy}
          error={disableQuestion.error}
          tone="red"
          icon={Ban}
        >
          The scheduler no longer builds its Mother Schedule: the next generated schedule leaves it out. You can enable it again.
        </ConfirmDialog>
      )}

      {/* Toast Notification. The live region stays mounted so every message is announced. */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50">
        {toast && (
          <div data-testid="section-toast" data-tone={toast.tone} className="flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${toast.tone === 'error' ? 'bg-red-500/20 dark:bg-red-500/15 text-red-400 dark:text-red-600' : 'bg-blue-500/20 dark:bg-blue-500/15 text-blue-500'}`}>
              {toast.tone === 'error' ? <AlertCircle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            </div>
            <span data-testid="section-toast-message" className="text-xs font-bold tracking-wide">{toast.message}</span>
            {toast.undo && (
              <button type="button" data-testid="section-undo" onClick={() => { const undo = toast.undo; setToast(null); undo(); }} className="ml-1 shrink-0 px-2.5 py-1 rounded-lg text-xs font-black text-blue-300 dark:text-blue-700 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                Undo
              </button>
            )}
            <button type="button" aria-label="Dismiss message" onClick={() => setToast(null)} className="ml-1 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}