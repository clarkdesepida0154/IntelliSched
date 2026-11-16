import { useState, useEffect, useRef } from 'react';
import {
  Search, Plus, Users, ShieldCheck, AlertCircle, AlertOctagon, Ban,
  Loader2, CheckCircle2, X, TrendingUp, TrendingDown, Minus, Star, EyeOff, Archive, ArchiveRestore
} from 'lucide-react';
import api from '../../services/api';
import FilterPopover, { FilterSelect } from '../../components/ui/FilterPopover';
import MultiSelectTags from '../../components/ui/MultiSelectTags';
import RowActions from '../../components/ui/RowActions';
import TablePagination from '../../components/ui/TablePagination';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { disabledCellClass, disabledBadgeClass } from '../../components/ui/tableStyles';
import usePagination from '../../hooks/usePagination';
import useEscapeKey from '../../hooks/useEscapeKey';
import useConfirmDisable from '../../hooks/useConfirmDisable';
import { undoDisable } from '../../utils/recordToggle';
import usePolicy from '../../hooks/usePolicy';
import useReferenceLists from '../../hooks/useReferenceLists';
import useSort from '../../hooks/useSort';
import SortableHeader from '../../components/ui/SortableHeader';
import TimeWindowsEditor from '../../components/ui/TimeWindowsEditor';
import UnavailableGrid from '../../components/ui/UnavailableGrid';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import { useTerm, SEMESTER_OPTIONS } from '../../context/term';
import { DAY_NAMES, gridTimes, gridOrigin, toMinutes, fromMinutes, formatRange12 } from '../../utils/timeGrid';
import { ANCILLARY_TYPE_LABELS, EMPLOYMENT_LABELS } from '../../utils/policyLabels';
import { loadRangeLine, standardLoadLine } from '../../utils/scheduleDisplay';
import useDataChanges from '../../hooks/useDataChanges';
import Select from '../../components/ui/Select';

const FETCH_ERROR_MESSAGE = 'The faculty profiles could not be loaded. Check your connection, then try again.';
const FILTER_STORAGE_KEY = 'intellisched.facultyManager.filters';
// The visible reason (Phase 3 Step 6) the page's write controls point at while the role may not use them.
const EDIT_NOTE_ID = 'faculty-permission-note';


// Single read path for the roster. Every successful mutation revalidates through it, so the
// table always shows what Atlas actually persisted (sort order, defaults, server-side trims).
const fetchFacultyList = async () => {
  const res = await api.get('/faculty');
  return Array.isArray(res.data) ? res.data : [];
};

// Days offered by the "Available on" filter (the scheduler never uses Sunday).
const FILTER_DAYS = DAY_NAMES.filter(day => day !== 'Sunday');

// Specialization domains and position titles come from the reference lists (GET /api/reference-lists).

// The stored values are unchanged ('BS' | 'MS' | 'PhD') and persist on Faculty.degreeLevel.
// Only the labels are user-facing.
const DEGREE_LEVEL_OPTIONS = [
  { value: 'BS', label: "Bachelor's Degree" },
  { value: 'MS', label: "Master's Degree" },
  { value: 'PhD', label: 'Doctorate Degree' }
];
const DEGREE_LEVEL_VALUES = DEGREE_LEVEL_OPTIONS.map(opt => opt.value);

// Ancillary (non-teaching) hours by type, as on SF-029. One row per type.
const ANCILLARY_TYPES = Object.keys(ANCILLARY_TYPE_LABELS);

// Short forms for the roster pills, e.g. "Res 10h".
const ANCILLARY_ABBREVIATIONS = {
  MANAGEMENT_FUNCTION: 'Mgmt',
  RESEARCH: 'Res',
  EXTENSION: 'Ext',
  CEE: 'CEE',
  CONSULTATION: 'Consult'
};

// Roster pill styling: one tint per type, written out in full so Tailwind can see every class.
const ANCILLARY_PILL_BASE = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap tabular-nums';
const ANCILLARY_PILL_TONES = {
  RESEARCH: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/20',
  EXTENSION: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:border-teal-500/20',
  MANAGEMENT_FUNCTION: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  CONSULTATION: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-500/20',
  CEE: 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:border-indigo-500/20'
};
const ANCILLARY_PILL_EMPTY_TONE = 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
const ancillaryPillClass = (type) => `${ANCILLARY_PILL_BASE} ${ANCILLARY_PILL_TONES[type] || ANCILLARY_PILL_EMPTY_TONE}`;

// Limits the gateway enforces too: 0.5-20 h per type, 40 h in total (a real Associate Dean load is 31).
const MAX_ANCILLARY_ROW_HOURS = 20;
const MAX_ANCILLARY_TOTAL = 40;

// A professor's latest student evaluation (the SET rating, 1.00-5.00), or null when there is none:
// a stored 0 (the default of a new profile; Phase 4 Part 2) or an empty value means "no CCS
// evaluation yet" (a new hire, or faculty from another department), shown as "0 – none yet".
const validEvalScore = (evalScore) => {
  const n = Number(evalScore?.average);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
};
const NO_EVALUATION_WORDS = '0 – none yet';
// Phase 7, presentation mode (the Output Setting "Show evaluation ratings on screen" off): the gateway
// sends { hidden: true } in place of every rating, so the page shows these words, sends no rating on a
// save and closes Log Evaluation (the gateway refuses it with the same words).
const HIDDEN_RATING_WORDS = 'Hidden (presentation mode)';
const HIDDEN_RATING_HINT = 'Ratings are hidden on screen (presentation mode). Turn "Show evaluation ratings on screen" on in Output Settings to see or change one.';
const LOG_EVAL_HIDDEN_REASON = 'Evaluation ratings are hidden (presentation mode). Turn "Show evaluation ratings on screen" on in Output Settings to log an evaluation.';
const RATINGS_NOTE_ID = 'faculty-ratings-hidden-note';
// The gateway's rule and words for the evaluation field (server/src/utils/evaluation.js).
const EVAL_FIELD_MESSAGE = 'Enter 0 for no CCS evaluation yet, or the latest SET rating from 1.00 to 5.00.';
const EVAL_FIELD_HINT = '0 = no CCS evaluation yet (new hire, or from another department). For returning faculty, type the latest SET rating.';

const SORT_GETTERS = {
  name: f => f.name,
  facultyId: f => f.facultyId,
  employmentType: f => f.employmentType || null,
  teachingCapHours: f => (Number.isFinite(f.teachingCapHours) ? f.teachingCapHours : null),
  evalScore: f => validEvalScore(f.evalScore)
};

// Phase 8 Part 8 (decision 3d): Archived — transferred or removed from CCS — is a third state; the
// archived profiles show only under this filter, each with Restore.
const STATUS_FILTER_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'archived', label: 'Archived' }
];
// Phase 8 Part 8 (decision 3c): the program printed on the Teachers' Program's Major/Minor line.
const PROGRAM_OPTIONS = ['Information Technology', 'Computer Science'];

const AVAILABILITY_OPTIONS = FILTER_DAYS.map(day => ({ value: day, label: day }));

// '' means "All". Persisted so the Dean's view survives navigating away.
const DEFAULT_FILTERS = { degreeLevel: '', availability: '', status: '' };

// teachingCapHours is pre-filled from the Scheduling Policy when the form opens.
const DEFAULT_FORM = {
  name: '',
  employmentType: 'FULL_TIME',
  position: '',
  email: '',
  degreeLevel: 'BS',
  specializations: [],
  certifications: '',
  teachingCapHours: '',
  // Phase 8 Part 4 (decision 1): the minimum teaching load; empty means the policy default.
  minTeachingHours: '',
  // Phase 8 Part 4 (decision 4): the professor's own day for Extension ('' = the policy's day).
  extensionDay: '',
  ancillary: [],
  unavailableBlocks: [],
  // The Major/Minor text the recommendations read (Phase 4 Part 4; since Phase 8 Part 8 it no longer prints).
  major: '',
  // Phase 8 Part 8 (decision 3c): the Program, printed as "Major/Minor" on the Teachers' Program ('' = none).
  program: '',
  // "Degree after the name" (Phase 8 Part 3, decision 1d): only the SF-029 shows it ("MSIT", "PhD").
  degreeAfterName: '',
  coCurricular: '',
  // 0 = no CCS evaluation yet (a new hire, or faculty from another department; Phase 4 Part 2).
  evalScore: 0,
  pastSubjectsTaught: []
};

// Terms offered by the Log Evaluation modal, oldest first: the academic year before the active one,
// the active one and the next, both semesters. The active term is the default.
const evaluationTermLabel = (semester, academicYear) => `${semester}, AY ${academicYear}`;
const evaluationTermOptions = (academicYear) => {
  const start = Number(String(academicYear).slice(0, 4));
  return [start - 1, start, start + 1].flatMap(y => SEMESTER_OPTIONS.map(sem => evaluationTermLabel(sem, `${y}-${y + 1}`)));
};

// evalScore.history entries are { term, score, dateAdded }. The gateway also converts older
// bare-number entries into that shape as it loads them; a bare number is still accepted here as
// a fallback so the trend never breaks on older data.
const historyScores = (evalScore) =>
  (Array.isArray(evalScore?.history) ? evalScore.history : [])
    .map(entry => (entry && typeof entry === 'object' ? Number(entry.score) : Number(entry)))
    .filter(Number.isFinite);

// The most recent logged entry with a usable score, for the Log Evaluation modal's context line.
const latestEvalEntry = (evalScore) => {
  const history = Array.isArray(evalScore?.history) ? evalScore.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const score = entry && typeof entry === 'object' ? Number(entry.score) : Number(entry);
    if (Number.isFinite(score)) return { score, term: entry?.term || '' };
  }
  return null;
};

// Trend of the student evaluation: compares the latest history score with the one before it.
// Fewer than two entries, or no change, reads as neutral.
const evalTrend = (evalScore) => {
  const history = historyScores(evalScore);
  if (history.length <= 1) return 'flat';
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (latest > previous) return 'up';
  if (latest < previous) return 'down';
  return 'flat';
};

const loadStoredFilters = () => {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_FILTERS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    // A stale or hand-edited value must never hide rows silently.
    if (!DEGREE_LEVEL_VALUES.includes(merged.degreeLevel)) merged.degreeLevel = '';
    if (!FILTER_DAYS.includes(merged.availability)) merged.availability = '';
    if (!STATUS_FILTER_OPTIONS.some(opt => opt.value === merged.status)) merged.status = '';
    return merged;
  } catch {
    return DEFAULT_FILTERS;
  }
};

// degreeLevel is now a Faculty schema field. Records saved before that field existed carried the
// degree code as the first token of engine1Profile, so that is kept as a read-only fallback.
const resolveDegreeLevel = (faculty) => {
  if (DEGREE_LEVEL_VALUES.includes(faculty?.degreeLevel)) return faculty.degreeLevel;
  const lead = String(faculty?.engine1Profile || '').trim().split(/\s+/)[0];
  return DEGREE_LEVEL_VALUES.includes(lead) ? lead : '';
};

const degreeLabel = (value) =>
  DEGREE_LEVEL_OPTIONS.find(opt => opt.value === value)?.label || 'Degree not set';

// Legacy ancillary roles and free-text designations -> types, the same mapping the Phase 1
// migration uses (Administrative -> MANAGEMENT_FUNCTION). Only unmigrated profiles need it.
const LEGACY_ROLE_TYPES = {
  Research: 'RESEARCH',
  Extension: 'EXTENSION',
  Administrative: 'MANAGEMENT_FUNCTION',
  Admin: 'MANAGEMENT_FUNCTION',
  Consultation: 'CONSULTATION'
};
const legacyRoleType = (role) => {
  const stored = String(role || '').trim();
  if (LEGACY_ROLE_TYPES[stored]) return LEGACY_ROLE_TYPES[stored];
  if (/research/i.test(stored)) return 'RESEARCH';
  if (/extension/i.test(stored)) return 'EXTENSION';
  if (/consult|prepar/i.test(stored)) return 'CONSULTATION';
  if (/competitive|\bcee\b/i.test(stored)) return 'CEE';
  return 'MANAGEMENT_FUNCTION';
};

// A profile's ancillary rows: the `ancillary` list once migrated; otherwise the legacy breakdown
// (or the single legacy total) read with the migration's mapping, so the Dean sees the hours and
// saving the form records them by type.
const ancillaryRowsOf = (faculty) => {
  if (Array.isArray(faculty?.ancillary)) {
    return faculty.ancillary.map(row => ({ type: row.type, hours: Number(row.hours) || 0 }));
  }
  const byType = new Map();
  (Array.isArray(faculty?.ancillaryBreakdown) ? faculty.ancillaryBreakdown : [])
    .filter(row => row?.role)
    .forEach(row => {
      const type = legacyRoleType(row.role);
      byType.set(type, (byType.get(type) || 0) + (Number(row.hours) || 0));
    });
  if (byType.size) return [...byType].map(([type, hours]) => ({ type, hours }));
  const legacyHours = Number(faculty?.ancillaryLoad?.hours) || 0;
  return legacyHours > 0 ? [{ type: legacyRoleType(faculty.ancillaryLoad.designation), hours: legacyHours }] : [];
};

const sumAncillaryHours = (rows) => rows.reduce((total, row) => total + (Number(row.hours) || 0), 0);

// A profile's unavailable time as blocks. Unmigrated profiles still carry whole unavailable days;
// they are shown (and, on save, recorded) as whole-day blocks over the policy's scheduling day.
const policyWholeDay = (policy) => (policy
  ? { start: gridOrigin(policy), end: fromMinutes(Math.max(toMinutes(policy.dayEnd), toMinutes(policy.saturdayOverflow.end), toMinutes(policy.nstp.end))) }
  : null);
const unavailableBlocksOf = (faculty, policy) => {
  if (Array.isArray(faculty?.unavailableBlocks)) return faculty.unavailableBlocks.map(b => ({ day: b.day, start: b.start, end: b.end, note: b.note || '' }));
  const whole = policyWholeDay(policy);
  return whole ? (faculty?.unavailableDays || []).map(day => ({ day, ...whole, note: '' })) : [];
};
// Days with any unavailable time (for the "Available on" filter and the roster).
const unavailableDaysOf = (faculty) => (Array.isArray(faculty?.unavailableBlocks)
  ? [...new Set(faculty.unavailableBlocks.map(b => b.day))]
  : (faculty?.unavailableDays || []));
const unavailableSummary = (faculty) => (Array.isArray(faculty?.unavailableBlocks)
  ? faculty.unavailableBlocks.map(b => `${b.day.slice(0, 3)} ${formatRange12(b.start, b.end)}`)
  : (faculty?.unavailableDays || []).map(day => `${day.slice(0, 3)} (whole day)`));

// initialProfessor (Phase 4 Part 2 Step 3): a faculty code from the address (the Readiness Check's "Fix
// this" on a professor's free-time line) that pre-fills the search, so the table opens on that professor.
export default function FacultyManager({ initialProfessor = null }) {
  // Default caps, the standard ancillary set and the time grid come from the Scheduling Policy.
  const { policy } = usePolicy();
  // Adding, editing, disabling and enabling profiles and logging evaluations: the permission map's
  // data.edit (the roster refresh after a save, roster.sync, is for the same roles).
  const edit = usePermission('data.edit');
  const { termParams, termLabel, activeAcademicYear, activeSemester } = useTerm();
  const referenceLists = useReferenceLists();
  const specializationOptions = referenceLists.items('specializationDomains');
  const positionOptions = referenceLists.items('positionTitles');
  const defaultEvaluationTerm = evaluationTermLabel(activeSemester, activeAcademicYear);
  const evaluationTerms = evaluationTermOptions(activeAcademicYear);
  // Engine 1's answer to the last roster sync when it skipped a profile or kept its old roster.
  const [rosterNotice, setRosterNotice] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  // facultyRef -> this term's load by the one load rule (GET /schedule/loads), null until read.
  const [termLoads, setTermLoads] = useState(null);
  const [loadsError, setLoadsError] = useState('');
  const [facultyList, setFacultyList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState(initialProfessor ? String(initialProfessor) : '');
  const [filters, setFilters] = useState(loadStoredFilters);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingFaculty, setEditingFaculty] = useState(null);
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [validationError, setValidationError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  // Log Evaluation modal: the faculty being rated (null when closed), its two fields, and state.
  const [evalTarget, setEvalTarget] = useState(null);
  const [evalForm, setEvalForm] = useState({ term: '', score: '' });
  const [evalError, setEvalError] = useState('');
  const [isLoggingEval, setIsLoggingEval] = useState(false);
  const evalTriggerRef = useRef(null);
  const evalScoreInputRef = useRef(null);
  // Rows with a status toggle in flight. The ref is the synchronous re-entry guard; the state
  // drives the spinner on the row's action button.
  const [pendingToggleIds, setPendingToggleIds] = useState(() => new Set());
  // Options for "Past Subjects Taught": titles of the active Master Catalog, loaded once.
  const [subjectOptions, setSubjectOptions] = useState([]);

  // Monotonic ticket for list refetches: a slower, older response must never overwrite a newer one.
  const syncSeq = useRef(0);
  const pendingToggleRef = useRef(new Set());
  const toastTimerRef = useRef(null);
  const lastActionRef = useRef(null);
  const tableRegionRef = useRef(null);
  const prevPendingCount = useRef(0);

  useEffect(() => {
    let isMounted = true;

    fetchFacultyList()
      .then(list => {
        if (!isMounted) return;
        setFacultyList(list);
        setLastSyncedAt(new Date());
      })
      .catch(err => {
        if (!isMounted) return;
        console.warn('[Faculty] Atlas fetch failed:', err.message);
        setFacultyList([]);
        setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => { isMounted = false; };
  }, []);

  // Phase 7, presentation mode: the Output Setting, read once (every role may read it); the records'
  // own { hidden: true } say so too, so a failed read still hides what the gateway hid.
  const [ratingsSettingHidden, setRatingsSettingHidden] = useState(false);
  useEffect(() => {
    let isMounted = true;
    api.get('/output-settings')
      .then(res => { if (isMounted) setRatingsSettingHidden(res.data?.showEvaluationRatings === false); })
      .catch(() => { /* the records' marks still say whether the ratings are hidden */ });
    return () => { isMounted = false; };
  }, []);
  const ratingsHidden = ratingsSettingHidden || facultyList.some(f => f.evalScore?.hidden === true);

  // The term's loads (teaching from the locks on the newest Draft, ancillary, total, Excess).
  const fetchLoads = async () => {
    try {
      const res = await api.get('/schedule/loads', { params: termParams });
      setTermLoads(Object.fromEntries((res.data?.loads || []).map(l => [l.facultyRef, l])));
      setLoadsError('');
    } catch (err) {
      setLoadsError(err.response?.data?.message || `The term's loads could not be loaded (${err.message}).`);
    }
  };
  useEffect(() => {
    // Fetch-on-mount (and on a term switch); the loader sets state only after its request settles.
    fetchLoads();
  }, [termParams.academicYear, termParams.semester]); // eslint-disable-line react-hooks/exhaustive-deps
  // Phase 8 Part 8 (decision 6): live updates — every professor's load follows each assignment and
  // faculty save (this tab at once, the others within ~2 s); the list follows the other tabs' saves
  // (this page's own saves already read it again), never while one of its own writes is in flight.
  useDataChanges(['assignments', 'faculty', 'policy', 'outsideTeachers'], () => { fetchLoads(); });
  useDataChanges(['faculty'], () => {
    if (pendingToggleRef.current.size) return;
    fetchFacultyList().then(list => { setFacultyList(list); setLastSyncedAt(new Date()); }).catch(() => { /* the table keeps what it shows */ });
  }, { remoteOnly: true });

  // Active Master Catalog titles feed the Past Subjects picker. Titles (not codes) are stored because
  // they are what Engine 1's text matching can use. A failure only leaves the picker empty; stored
  // values still render as removable chips.
  useEffect(() => {
    let isMounted = true;
    api.get('/catalog')
      .then(res => {
        if (!isMounted) return;
        const titles = (Array.isArray(res.data) ? res.data : [])
          .filter(s => s.isActive)
          .map(s => String(s.descriptiveTitle || '').trim())
          .filter(Boolean);
        setSubjectOptions([...new Set(titles)].sort((a, b) => a.localeCompare(b)));
      })
      .catch(err => {
        if (isMounted) console.warn('[Faculty] Catalog fetch for past subjects failed:', err.message);
      });
    return () => { isMounted = false; };
  }, []);

  // Persist filter selections whenever they change.
  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Storage may be unavailable (private mode / quota); filters still work in-memory.
    }
  }, [filters]);

  // Never leave a toast timer running after unmount.
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

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

  // Full reload, used only by the error-state retry: it shows the loading state again.
  const handleRetry = async () => {
    const seq = ++syncSeq.current;
    // Taking the ticket supersedes any in-flight revalidate(), whose finally will now skip its own
    // reset; clear the sync flag here so the footer never shows "Syncing" for a request that was
    // discarded.
    setIsSyncing(false);
    setIsLoading(true);
    setErrorMessage('');
    try {
      const list = await fetchFacultyList();
      if (seq !== syncSeq.current) return;
      setFacultyList(list);
      setLastSyncedAt(new Date());
    } catch (err) {
      if (seq !== syncSeq.current) return;
      setFacultyList([]);
      setErrorMessage(err.response?.data?.message || FETCH_ERROR_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  };

  // Silent revalidation after every successful mutation. The optimistic local update has already
  // rendered; this swaps it for Atlas truth without flashing a loading state.
  const revalidate = async () => {
    const seq = ++syncSeq.current;
    setIsSyncing(true);
    try {
      const list = await fetchFacultyList();
      if (seq !== syncSeq.current) return;
      setFacultyList(list);
      setLastSyncedAt(new Date());
      setErrorMessage('');
      fetchLoads();
    } catch (err) {
      console.warn('[Faculty] Revalidation skipped:', err.message);
    } finally {
      if (seq === syncSeq.current) setIsSyncing(false);
    }
  };

  // Single toast channel: a new message replaces the previous one and restarts the 4s timer. `undo`
  // adds an Undo button (and a longer time to press it).
  const showToast = (message, tone = 'success', undo = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone, undo });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, undo ? 10000 : 4000);
  };

  // Engines 1 and 2 cache the roster; after every faculty change the gateway asks Engine 1 to reload
  // it. Engine 1 reads each profile on its own and names any it had to skip.
  const syncEngineRoster = () => {
    api.post('/schedule/sync-roster')
      .then(res => {
        const skipped = Array.isArray(res.data?.skipped) ? res.data.skipped : [];
        if (res.data?.status === 'error' || skipped.length) setRosterNotice({ status: res.data.status, message: res.data.message || '', skipped });
        else setRosterNotice(null);
      })
      .catch(() => {
        // The Python service is optional while editing profiles; the ranking page reports it. An old
        // notice no longer describes the roster, so it goes.
        setRosterNotice(null);
      });
  };

  const dismissToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setToast(null);
  };

  // ---------------------------------------------------------------------------
  // Search, filters, pagination
  // ---------------------------------------------------------------------------
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredFaculty = facultyList.filter(f => {
    const matchesSearch = !normalizedSearch
      || (f.name || '').toLowerCase().includes(normalizedSearch)
      || (f.position || '').toLowerCase().includes(normalizedSearch)
      || String(f.facultyId || f._id || '').toLowerCase().includes(normalizedSearch)
      || (f.specializations || []).some(s => String(s).toLowerCase().includes(normalizedSearch));
    const matchesDegree = !filters.degreeLevel || resolveDegreeLevel(f) === filters.degreeLevel;
    // "Available on Monday" means the instructor has no unavailable time on Monday.
    const matchesAvailability = !filters.availability || !unavailableDaysOf(f).includes(filters.availability);
    // Phase 8 Part 8 (decision 3d): archived profiles show only under "Archived".
    const matchesStatus = filters.status === 'archived' ? Boolean(f.archived)
      : !f.archived && (!filters.status || (filters.status === 'active' ? Boolean(f.isActive) : !f.isActive));
    return matchesSearch && matchesDegree && matchesAvailability && matchesStatus;
  });

  const { sorted: sortedFaculty, sort, toggle: toggleSort } = useSort(filteredFaculty, SORT_GETTERS, 'name');

  // Client-side pagination over the filtered roster, 15 rows per page. The hook clamps the page on
  // render rather than in an effect, so a list that shrinks (a toggle hides a row) never leaves
  // the Dean on an empty page.
  const {
    currentPage,
    totalPages,
    totalItems,
    pageItems: pagedFaculty,
    rangeLabel,
    setPage,
    resetPage
  } = usePagination(sortedFaculty, 25);

  // Any change to the query set returns the Dean to the first page.
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
  // Ancillary rows carry a client-only key so React can track them through removals; the key is
  // stripped when the payload is built.
  const ancillaryRowKeyRef = useRef(0);
  const withRowKey = (row) => ({ ...row, key: ++ancillaryRowKeyRef.current });
  const ancillaryRows = formData.ancillary;
  // Phase 11.2 (decision 1): part-timers have no ancillary loads, so the fields are disabled for them
  // (any stored hours stay untouched and are ignored by every load).
  const ancillaryOff = formData.employmentType === 'PART_TIME';
  const ancillaryTotalHours = sumAncillaryHours(ancillaryRows);
  // Each type may be listed once, so the add button stops once every type is in use.
  const unusedAncillaryTypes = ANCILLARY_TYPES.filter(type => !ancillaryRows.some(row => row.type === type));

  // Keyboard focus for the ancillary list. Adding a row focuses its hours box (the Add button may
  // disable itself once every role is used); removing one focuses the neighbouring row's remove
  // button, or the Add button when the list is empty, so focus never falls back to <body>.
  const ancillaryControlsRef = useRef(new Map());
  const addAncillaryButtonRef = useRef(null);
  const pendingAncillaryFocusRef = useRef(null);
  const bindAncillaryControl = (key, type) => (el) => {
    const id = `${key}:${type}`;
    if (el) ancillaryControlsRef.current.set(id, el);
    else ancillaryControlsRef.current.delete(id);
  };
  useEffect(() => {
    const target = pendingAncillaryFocusRef.current;
    if (!target) return;
    pendingAncillaryFocusRef.current = null;
    const el = target.type === 'add'
      ? addAncillaryButtonRef.current
      : ancillaryControlsRef.current.get(`${target.key}:${target.type}`);
    el?.focus();
  }, [formData.ancillary]);

  const defaultCapFor = (employmentType) => {
    const cap = policy?.load?.defaultTeachingCap?.[employmentType];
    return Number.isFinite(cap) ? String(cap) : '';
  };

  const openAddModal = () => {
    if (!edit.allowed || evalTarget) return; // one dialog at a time
    setEditingFaculty(null);
    setFormData({ ...DEFAULT_FORM, teachingCapHours: defaultCapFor(DEFAULT_FORM.employmentType) });
    setValidationError('');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  const openEditModal = (faculty) => {
    // One dialog at a time: an Edit form opened under Log Eval would resend the old score on save.
    if (!edit.allowed || evalTarget) return;
    setEditingFaculty(faculty);
    setFormData({
      name: faculty.name || '',
      // An unmigrated profile has no employment type or cap yet: the Dean must choose them.
      employmentType: faculty.employmentType || '',
      position: faculty.position || '',
      email: faculty.email || '',
      degreeLevel: resolveDegreeLevel(faculty) || 'MS',
      specializations: faculty.specializations || [],
      certifications: faculty.certifications ? faculty.certifications.join(', ') : '',
      teachingCapHours: Number.isFinite(faculty.teachingCapHours) ? String(faculty.teachingCapHours) : '',
      minTeachingHours: Number.isFinite(faculty.minTeachingHours) ? String(faculty.minTeachingHours) : '',
      extensionDay: faculty.extensionDay || '',
      ancillary: ancillaryRowsOf(faculty).map(withRowKey),
      unavailableBlocks: unavailableBlocksOf(faculty, policy),
      major: faculty.major || '',
      program: faculty.program || '',
      degreeAfterName: faculty.degreeAfterName || '',
      coCurricular: faculty.coCurricular || '',
      // 0 when the professor has no CCS evaluation yet (never an invented number).
      evalScore: validEvalScore(faculty.evalScore) ?? 0,
      pastSubjectsTaught: Array.isArray(faculty.pastSubjectsTaught) ? [...faculty.pastSubjectsTaught] : []
    });
    setValidationError(faculty.employmentType
      ? ''
      : 'This profile was saved before employment type and teaching cap existed. Choose them below before saving.');
    setFieldErrors({});
    setIsModalOpen(true);
  };

  // Cancel, the X button, the backdrop and Escape all land here. Editing state and any stale
  // validation error are cleared so the next open never flashes the previous profile.
  const closeModal = () => {
    if (isSubmitting) return;
    setIsModalOpen(false);
    setEditingFaculty(null);
    setValidationError('');
    setFieldErrors({});
  };

  // Escape closes the dialog unless a save is in flight. A key event that a child control already
  // consumed (the specialization multi-select closes its own list on Escape) is left alone so one
  // key press never closes two layers at once.
  useEscapeKey(isModalOpen, closeModal, isSubmitting);

  // Switching the employment type moves the cap to the new type's policy default, unless the Dean
  // already typed a different cap.
  const handleEmploymentTypeChange = (employmentType) => {
    setFormData(prev => {
      const untouched = String(prev.teachingCapHours).trim() === '' || String(prev.teachingCapHours) === defaultCapFor(prev.employmentType);
      return { ...prev, employmentType, teachingCapHours: untouched ? defaultCapFor(employmentType) : prev.teachingCapHours };
    });
  };

  // ---------------------------------------------------------------------------
  // Log Evaluation
  // ---------------------------------------------------------------------------
  const openEvalModal = (faculty, event) => {
    if (!edit.allowed || ratingsHidden || isModalOpen || evalTarget) return; // one dialog at a time
    // Focus returns to the row's Log Eval button when the modal closes.
    evalTriggerRef.current = event?.currentTarget || null;
    setEvalTarget(faculty);
    setEvalForm({ term: defaultEvaluationTerm, score: '' });
    setEvalError('');
  };

  const closeEvalModal = () => {
    if (isLoggingEval) return;
    setEvalTarget(null);
    setEvalError('');
    const trigger = evalTriggerRef.current;
    evalTriggerRef.current = null;
    if (trigger && document.contains(trigger)) requestAnimationFrame(() => trigger.focus());
  };

  useEscapeKey(Boolean(evalTarget), closeEvalModal, isLoggingEval);

  // Any error (client check or server reply) puts focus back on the score box once it is enabled
  // again, so keyboard and screen-reader users land next to the announced message.
  useEffect(() => {
    if (evalTarget && evalError && !isLoggingEval) evalScoreInputRef.current?.focus();
  }, [evalTarget, evalError, isLoggingEval]);

  const handleLogEvaluation = async (e) => {
    e.preventDefault();
    setEvalError('');
    const term = evalForm.term;
    const score = Number(evalForm.score);
    if (!evaluationTerms.includes(term)) {
      setEvalError('Choose the semester this evaluation belongs to.');
      return;
    }
    if (String(evalForm.score).trim() === '' || !Number.isFinite(score) || score < 1 || score > 5) {
      setEvalError('Enter a score between 1.00 and 5.00.');
      return;
    }

    const target = evalTarget;
    const roundedScore = Math.round(score * 100) / 100;
    setIsLoggingEval(true);
    try {
      const res = await api.patch(`/faculty/${target._id}/evaluation`, { term, score: roundedScore });
      setFacultyList(prev => prev.map(f => (f._id === target._id ? res.data : f)));
      showToast(`Logged ${roundedScore.toFixed(2)} for ${target.name} (${term}).`);
      // Python caches the roster, so Engine 2 only ranks on the new score after a sync.
      syncEngineRoster();
      setEvalTarget(null);
      const trigger = evalTriggerRef.current;
      evalTriggerRef.current = null;
      if (trigger && document.contains(trigger)) requestAnimationFrame(() => trigger.focus());
      revalidate();
    } catch (err) {
      setEvalError(err.response?.data?.message || 'Failed to log the evaluation. Please try again.');
    } finally {
      setIsLoggingEval(false);
    }
  };

  const handleSpecializationsChange = (nextSpecializations) => {
    setFormData(prev => ({ ...prev, specializations: nextSpecializations }));
  };

  // Ancillary rows: add one (defaulting to the first type not yet listed), edit a field, or remove.
  // The new row and its key are built outside the state updater so StrictMode's double call can
  // never hand the focus effect a key that was not committed.
  const handleAddAncillaryRow = () => {
    const type = unusedAncillaryTypes[0];
    if (!type) return;
    const row = withRowKey({ type, hours: '' });
    pendingAncillaryFocusRef.current = { key: row.key, type: 'hours' };
    setFormData(prev => ({ ...prev, ancillary: [...prev.ancillary, row] }));
  };

  const handleAncillaryRowChange = (key, field, value) => {
    setFormData(prev => ({
      ...prev,
      ancillary: prev.ancillary.map(row => (row.key === key ? { ...row, [field]: value } : row))
    }));
  };

  // Fills the usual full-time set from the Scheduling Policy (Research, Extension, CEE,
  // Consultation). A Management Function row is kept; the Dean can edit every value afterwards.
  const handleUseStandardSet = () => {
    const standard = policy?.load?.standardAncillary;
    if (!standard) return;
    setFormData(prev => {
      const kept = prev.ancillary.filter(row => !(row.type in standard));
      const filled = Object.entries(standard)
        .filter(([, hours]) => Number(hours) > 0)
        .map(([type, hours]) => withRowKey({ type, hours: String(hours) }));
      return { ...prev, ancillary: [...kept, ...filled] };
    });
  };

  const handleRemoveAncillaryRow = (key) => {
    const index = ancillaryRows.findIndex(row => row.key === key);
    const remaining = ancillaryRows.filter(row => row.key !== key);
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    pendingAncillaryFocusRef.current = neighbour ? { key: neighbour.key, type: 'remove' } : { type: 'add' };
    setFormData(prev => ({
      ...prev,
      ancillary: prev.ancillary.filter(row => row.key !== key)
    }));
  };

  // Client checks mirror the gateway's; every message is shown next to its field. A failed save
  // keeps everything that was typed.
  const handleSaveFaculty = async (e) => {
    e.preventDefault();
    setValidationError('');
    setFieldErrors({});

    const cleanName = formData.name.trim();
    const capText = String(formData.teachingCapHours).trim();
    const cap = capText === '' ? NaN : Number(capText);
    // Hours stay a string while typing; an empty box must fail validation rather than read as 0.
    const ancillary = formData.ancillary.map(row => ({
      type: row.type,
      hours: String(row.hours).trim() === '' ? NaN : Number(row.hours)
    }));
    const ancillaryTotal = sumAncillaryHours(ancillary);
    // While the ratings are hidden (presentation mode) the field shows no rating and none is sent.
    const evalValue = ratingsHidden || String(formData.evalScore).trim() === '' ? 0 : Number(formData.evalScore);
    const isHalfStep = (n) => Number.isFinite(n) && Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;

    const errors = {};
    if (!cleanName) errors.name = 'Enter the full name.';
    if (!['FULL_TIME', 'PART_TIME'].includes(formData.employmentType)) errors.employmentType = 'Choose full-time or part-time.';
    if (!(isHalfStep(cap) && cap >= 0 && cap <= 40)) errors.teachingCapHours = 'Enter the maximum teaching hours per week, from 0 to 40 in steps of 0.5.';
    // The minimum is optional: empty means the policy default; a typed one sits inside the cap.
    const minText = String(formData.minTeachingHours).trim();
    const minValue = minText === '' ? null : Number(minText);
    if (minValue !== null) {
      if (!(isHalfStep(minValue) && minValue >= 0 && minValue <= 40)) errors.minTeachingHours = 'Enter the minimum teaching hours per week, from 0 to 40 in steps of 0.5, or leave it empty for the default.';
      else if (Number.isFinite(cap) && minValue > cap) errors.minTeachingHours = 'The minimum cannot be above the teaching cap.';
    }
    if (formData.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) errors.email = 'Enter a valid email address, or leave it blank.';
    if (formData.specializations.length === 0) errors.specializations = 'Choose at least one specialization.';
    if (!ancillaryOff) ancillary.forEach((row, i) => {
      if (!(isHalfStep(row.hours) && row.hours >= 0.5 && row.hours <= MAX_ANCILLARY_ROW_HOURS)) {
        errors[`ancillary.${i}.hours`] = `Enter 0.5 to ${MAX_ANCILLARY_ROW_HOURS} hours per week, in steps of 0.5.`;
      }
    });
    if (ancillaryOff) { /* part-timers: no ancillary hours to check (none are sent) */ }
    else if (new Set(ancillary.map(row => row.type)).size !== ancillary.length) errors.ancillary = 'List each ancillary type once.';
    else if (ancillaryTotal > MAX_ANCILLARY_TOTAL) errors.ancillary = `Ancillary hours add up to ${ancillaryTotal}; the most allowed is ${MAX_ANCILLARY_TOTAL} per week.`;
    // 0 (or an empty box) means "no CCS evaluation yet"; otherwise the latest SET rating, 1.00-5.00.
    if (!(evalValue === 0 || (Number.isFinite(evalValue) && evalValue >= 1 && evalValue <= 5))) errors.evalScore = EVAL_FIELD_MESSAGE;
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      setValidationError('The profile was not saved. Fix the fields marked below.');
      return;
    }

    setIsSubmitting(true);

    const parsedCertifications = formData.certifications
      .split(',')
      .map(c => c.trim())
      .filter(Boolean);

    // engine1Profile is composed by the gateway from major, specializations, certifications and
    // trainings, and the faculty code is assigned by the gateway: the client sends neither.
    // New profiles are always active. An edit never sends isActive at all, so the value stored
    // is preserved and only the roster's Enable / Disable action can change it.
    const payload = {
      name: cleanName,
      employmentType: formData.employmentType,
      position: formData.position.trim(),
      email: formData.email.trim(),
      // "Major/Minor (Teachers' Program)" as typed; the gateway falls back to the first specialization
      // when it is empty (Phase 4 Part 4).
      major: formData.major.trim(),
      // "Degree after the name" (Phase 8 Part 3): the SF-029's name lines carry it; empty means none.
      degreeAfterName: formData.degreeAfterName.trim(),
      degreeLevel: formData.degreeLevel,
      specializations: formData.specializations,
      certifications: parsedCertifications,
      trainings: editingFaculty?.trainings || [],
      teachingCapHours: cap,
      // null clears the stored minimum, so the profile follows the policy default again.
      minTeachingHours: minValue,
      // '' (the policy's day) clears the stored override the same way.
      extensionDay: formData.extensionDay || '',
      // A part-timer sends none: the gateway would ignore them (Phase 11.2).
      ...(ancillaryOff ? {} : { ancillary }),
      unavailableBlocks: formData.unavailableBlocks.map(b => ({ day: b.day, start: b.start, end: b.end, ...(b.note?.trim() ? { note: b.note.trim() } : {}) })),
      coCurricular: formData.coCurricular.trim(),
      // '' (none) clears the stored program.
      program: formData.program || '',
      // A plain number: 0 for "no CCS evaluation yet", else the latest SET rating (1.00-5.00). The
      // gateway maintains evalScore.average and evalScore.history (0 is never an entry). Nothing while
      // the ratings are hidden, so the stored rating stays.
      ...(ratingsHidden ? {} : { evalScore: Math.round(evalValue * 100) / 100 }),
      pastSubjectsTaught: (Array.isArray(formData.pastSubjectsTaught) ? formData.pastSubjectsTaught : [])
        .map(s => String(s).trim())
        .filter(Boolean),
      ...(editingFaculty ? {} : { isActive: true })
    };

    try {
      let saved;
      if (editingFaculty) {
        const res = await api.put(`/faculty/${editingFaculty._id}`, payload);
        saved = res.data;
        setFacultyList(prev => prev.map(f => f._id === editingFaculty._id ? saved : f));
        // Phase 8 Part 8 (decision 3a): the gateway stores the name in one style ("First M. Last").
        showToast(saved?.name && saved.name !== cleanName ? `Profile for ${saved.name} saved (the name is stored as "${saved.name}").` : `Profile for ${cleanName} saved.`);
      } else {
        const res = await api.post('/faculty', payload);
        saved = res.data;
        setFacultyList(prev => [saved, ...prev]);
        showToast(`Profile for ${cleanName} saved as ${saved.facultyId}.`);
      }

      syncEngineRoster();
      setIsModalOpen(false);
      revalidate();
    } catch (err) {
      const serverErrors = err.response?.data?.errors;
      if (Array.isArray(serverErrors) && serverErrors.length) {
        setFieldErrors(Object.fromEntries(serverErrors.map(se => [se.field, se.message])));
        setValidationError('The profile was not saved. Fix the fields marked below.');
      } else {
        setValidationError(err.response?.data?.message || `The profile could not be saved (${err.message}). Your entries are still here; try again.`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // The toggle route flips isActive rather than setting it, so a duplicate request would undo the
  // first one. The row's action button shows a spinner and is disabled while the request is in
  // flight, and a re-entrant call for the same row is ignored. Other rows stay toggleable.
  const setPending = (id, pending) => {
    if (pending) pendingToggleRef.current.add(id); else pendingToggleRef.current.delete(id);
    setPendingToggleIds(new Set(pendingToggleRef.current));
  };
  // PATCH /faculty/:id/toggle; resolves the profile's new state (or throws).
  const toggleFaculty = async (faculty) => {
    setPending(faculty._id, true);
    try {
      const res = await api.patch(`/faculty/${faculty._id}/toggle`);
      const nextIsActive = Boolean(res.data.isActive);
      setFacultyList(prev => prev.map(f => (
        f._id === faculty._id ? { ...f, isActive: nextIsActive } : f
      )));
      return nextIsActive;
    } finally {
      setPending(faculty._id, false);
    }
  };
  const statusText = (faculty, isActive) => (isActive
    ? `${faculty.name} enabled and returned to the active roster.`
    : `${faculty.name} disabled: no longer offered for assignments; the profile is kept.`);

  // Undo of a disable: the profile is enabled again only if it is still disabled (utils/recordToggle.js).
  const undoFacultyDisable = async (faculty) => {
    setPending(faculty._id, true);
    const result = await undoDisable({ listPath: '/faculty', togglePath: `/faculty/${faculty._id}/toggle`, id: faculty._id, name: faculty.name });
    setPending(faculty._id, false);
    if (typeof result.isActive === 'boolean') setFacultyList(prev => prev.map(f => (f._id === faculty._id ? { ...f, isActive: result.isActive } : f)));
    showToast(result.message, result.tone);
    syncEngineRoster();
    revalidate();
  };

  // Disabling asks first (audit X6); the message that follows offers Undo.
  const disableQuestion = useConfirmDisable(async (faculty) => {
    try {
      const isActive = await toggleFaculty(faculty);
      showToast(statusText(faculty, isActive), 'success', isActive ? null : () => undoFacultyDisable(faculty));
      syncEngineRoster();
      revalidate();
      return '';
    } catch (err) {
      return `${faculty.name} was not disabled (${err.response?.data?.message || err.message}). The profile was left unchanged: try again, or cancel.`;
    }
  });

  // Phase 8 Part 8 (decision 3d): Archive asks first. The gateway refuses a professor with classes this
  // term (409 HAS_CLASSES) and lists them, to be reassigned on Assign Faculty first; Restore acts at once.
  const [archiveQuestion, setArchiveQuestion] = useState(null); // { faculty, busy, error, classes }
  const askArchive = (faculty, event) => {
    if (!edit.allowed) return;
    lastActionRef.current = event?.currentTarget ?? null;
    setArchiveQuestion({ faculty, busy: false, error: '', classes: null });
  };
  const confirmArchive = async () => {
    const faculty = archiveQuestion?.faculty;
    if (!faculty) return;
    setArchiveQuestion(q => ({ ...q, busy: true, error: '' }));
    try {
      const res = await api.patch(`/faculty/${faculty._id}/archive`, termParams);
      setFacultyList(prev => prev.map(f => (f._id === faculty._id ? { ...f, archived: true, isActive: false } : f)));
      setArchiveQuestion(null);
      showToast(res.data?.message || `${faculty.name} was archived.`);
      syncEngineRoster();
      revalidate();
    } catch (err) {
      const data = err.response?.data || {};
      setArchiveQuestion(q => ({ ...q, busy: false, classes: data.code === 'HAS_CLASSES' ? data.classes || [] : null, error: data.message || `${faculty.name} was not archived (${err.message}). Try again.` }));
    }
  };
  const restoreFaculty = async (faculty) => {
    if (!edit.allowed) return;
    try {
      const res = await api.patch(`/faculty/${faculty._id}/restore`);
      setFacultyList(prev => prev.map(f => (f._id === faculty._id ? { ...f, archived: false, isActive: Boolean(res.data?.isActive) } : f)));
      showToast(res.data?.message || `${faculty.name} was restored.`);
      syncEngineRoster();
      revalidate();
    } catch (err) {
      showToast(`${faculty.name}: ${err.response?.data?.message || 'the profile could not be restored.'} Try again.`, 'error');
    }
  };

  // The row's Disable asks first; Enable acts at once.
  const handleToggleStatus = async (faculty, event) => {
    if (!edit.allowed || pendingToggleRef.current.has(faculty._id)) return;
    lastActionRef.current = event?.currentTarget ?? null;
    if (faculty.isActive) {
      disableQuestion.ask(faculty);
      return;
    }
    try {
      showToast(statusText(faculty, await toggleFaculty(faculty)));
      syncEngineRoster();
      revalidate();
    } catch (err) {
      showToast(
        `${faculty.name}: ${err.response?.data?.message || 'the status could not be changed.'} The profile was left unchanged; try again.`,
        'error'
      );
    }
  };

  const inputClass = 'w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm focus:outline-none focus:border-blue-500 text-slate-900 dark:text-white disabled:opacity-50';
  const labelClass = 'block text-[11px] font-bold text-slate-500 mb-1.5 uppercase tracking-wider';
  // The ancillary role select needs tighter padding and type. Appending px-2.5 / text-xs to
  // inputClass does not work: Tailwind emits px-3 and text-sm later, so they would still win.
  const compactSelectClass = `${inputClass.replace('px-3', 'px-2.5').replace('text-sm', 'text-xs')} font-bold`;
  const requiredMark = <><span aria-hidden="true">*</span><span className="sr-only">(required)</span></>;
  const fieldError = (key) => (fieldErrors[key]
    ? <p role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400"><AlertCircle size={12} className="mt-px shrink-0" /> {fieldErrors[key]}</p>
    : null);
  // Times offered for unavailable blocks: the policy's whole scheduling day.
  const wholeDayWindow = policyWholeDay(policy);
  const blockTimes = wholeDayWindow && policy ? gridTimes(wholeDayWindow.start, wholeDayWindow.end, policy.slotMinutes) : [];
  // The grid's columns: the policy's weekdays, Saturday (the NSTP and overflow day) and the NSTP day
  // when it is another weekend day, in calendar order. Sunday rows live in the list only.
  const gridDays = policy ? DAY_NAMES.filter(day => policy.weekdays.includes(day) || day === 'Saturday' || day === policy.nstp?.day) : [];

  return (
    <div className="animate-in fade-in duration-300 relative">
      {/* The card does not clip its children: the Filters popover is anchored inside the header
          and would otherwise be cut off. Corners are rounded per-section instead. */}
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg flex flex-col">

        {/* HEADER AREA */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
          <PageHeader pageKey="faculty">
            {loadsError && <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-400 mt-1">{loadsError}</p>}
            {referenceLists.error && <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-400 mt-1">{referenceLists.error}</p>}
            {rosterNotice && (
              <div role="status" data-testid="faculty-roster-notice" className="mt-2 p-2.5 rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 text-[11px] text-amber-800 dark:text-amber-300 max-w-xl">
                <p className="font-bold">
                  {rosterNotice.status === 'error'
                    ? `The professor rankings kept their previous faculty list: ${rosterNotice.message || 'no active profile could be read.'}`
                    : `Subject matching skipped ${rosterNotice.skipped.length} profile(s); they are not ranked until fixed:`}
                </p>
                {rosterNotice.skipped.length > 0 && (
                  <ul className="list-disc pl-4 mt-1">
                    {rosterNotice.skipped.map(item => <li key={item.facultyId}>{item.facultyId}: {item.reason}</li>)}
                  </ul>
                )}
                <button type="button" onClick={() => setRosterNotice(null)} className="mt-1 font-bold underline cursor-pointer">Dismiss</button>
              </div>
            )}
            <p className="sr-only">Teaching loads are for {termLabel}.</p>
          </PageHeader>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 min-w-45 sm:w-56 sm:flex-none">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                type="text"
                placeholder="Search faculty..."
                aria-label="Search faculty"
                data-testid="faculty-search"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-blue-500 transition-colors text-slate-900 dark:text-white"
              />
            </div>

            <FilterPopover
              title="Filter Faculty"
              ariaLabel="Faculty filters"
              activeCount={activeFilterCount}
              summary={`${filteredFaculty.length} of ${facultyList.length} shown`}
              onClear={clearFilters}
              accent="blue"
            >
              <FilterSelect
                label="Degree Level"
                value={filters.degreeLevel}
                onChange={(v) => updateFilter('degreeLevel', v)}
                options={DEGREE_LEVEL_OPTIONS}
                allLabel="All Degree Levels"
                accent="blue"
              />
              <FilterSelect
                label="Available on"
                value={filters.availability}
                onChange={(v) => updateFilter('availability', v)}
                options={AVAILABILITY_OPTIONS}
                allLabel="Any Day"
                accent="blue"
              />
              <FilterSelect
                label="Status"
                value={filters.status}
                onChange={(v) => updateFilter('status', v)}
                options={STATUS_FILTER_OPTIONS}
                allLabel="All Statuses"
                accent="blue"
              />
            </FilterPopover>

            <button
              type="button"
              data-testid="faculty-add"
              onClick={openAddModal}
              disabled={!edit.allowed}
              {...blockedBy(edit, EDIT_NOTE_ID)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center transition-colors shadow-lg shadow-blue-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            >
              <Plus size={16} className="mr-2" /> Add Faculty
            </button>
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {!edit.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={EDIT_NOTE_ID} permission={edit} lead="You can view the faculty profiles and their loads." />
          </div>
        )}
        {ratingsHidden && (
          <div className="px-6 md:px-8 pt-4">
            <p id={RATINGS_NOTE_ID} data-testid={RATINGS_NOTE_ID} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-xs text-slate-700 dark:text-slate-300 flex items-start gap-2">
              <EyeOff size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>Ratings are hidden (&ldquo;{HIDDEN_RATING_WORDS}&rdquo;). Turn on &ldquo;Show evaluation ratings on screen&rdquo; in Output Settings to see or change them.</span>
            </p>
          </div>
        )}

        {/* TABLE AREA. min-h keeps a 0- or 1-row table tall enough for the Filters popover. */}
        <div ref={tableRegionRef} tabIndex={-1} className="relative min-h-[400px] overflow-visible focus:outline-none">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-blue-500" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading faculty…</p>
            </div>
          ) : errorMessage ? (
            <div className="p-12 text-center max-w-md mx-auto my-8">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Faculty could not be loaded</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold transition-colors cursor-pointer"
              >
                Retry Request
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-sm">
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-500 dark:text-slate-400">
                <tr>
                  {/* Six columns that fit at 1280 and 1440 px (Phase 4 Part 2, audit N2): the
                      specializations sit under the name, nothing is pinned over the Status column,
                      and Evaluation and Status never wrap or shrink. */}
                  <SortableHeader label="Faculty" sortKey="name" sort={sort} onSort={toggleSort} padding="px-4 py-4" />
                  <th scope="col" className="px-4 py-4 font-bold text-xs">Unavailable</th>
                  <SortableHeader label="Teaching cap & ancillary" sortKey="teachingCapHours" sort={sort} onSort={toggleSort} padding="px-4 py-4" />
                  <SortableHeader label="Evaluation" sortKey="evalScore" sort={sort} onSort={toggleSort} className="whitespace-nowrap" padding="px-4 py-4" />
                  <th scope="col" className="px-4 py-4 font-bold text-xs whitespace-nowrap">Status</th>
                  <th scope="col" className="px-4 py-4 font-bold text-xs text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {pagedFaculty.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-12 text-center text-slate-500 dark:text-slate-400">
                      <Users size={32} className="mx-auto mb-2 opacity-30 text-blue-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        {searchQuery || hasActiveFilters ? 'No Matching Faculty Found' : 'No Faculty Profiles Registered'}
                      </p>
                      <p className="text-xs mt-1">
                        {searchQuery || hasActiveFilters
                          ? 'Try adjusting your search or clearing the active filters.'
                          : edit.allowed ? 'Click "Add Faculty" above to register instructor profiles.' : edit.reason}
                      </p>
                    </td>
                  </tr>
                ) : (
                  pagedFaculty.map((faculty) => {
                    const rowId = faculty._id || faculty.facultyId;
                    const isTogglePending = pendingToggleIds.has(faculty._id);
                    const isDisabledRow = !faculty.isActive;
                    const degree = resolveDegreeLevel(faculty);
                    // Only stored facts: the teaching cap and the ancillary hours by type. An
                    // unmigrated profile shows its legacy hours read the way the migration will.
                    const cap = Number.isFinite(faculty.teachingCapHours) ? faculty.teachingCapHours : null;
                    const termLoad = termLoads?.[faculty._id] || null;
                    const overCap = termLoad && cap !== null && termLoad.teaching > cap;
                    // Phase 8 Part 2 (F2): the standard full-time teaching load, information only.
                    const stdLine = termLoad ? standardLoadLine({ teaching: termLoad.teaching, employmentType: faculty.employmentType, standardTeachingHours: policy?.load?.standardTeachingHours }) : null;
                    // Part-timers have no ancillary loads (Phase 11.2): stored hours are not shown.
                    const ancillaryPills = faculty.employmentType === 'PART_TIME' ? [] : ancillaryRowsOf(faculty);
                    const ancillaryHours = sumAncillaryHours(ancillaryPills);
                    const unavailable = unavailableSummary(faculty);
                    const evalAverage = validEvalScore(faculty.evalScore);
                    const trend = evalTrend(faculty.evalScore);

                    // Disabled rows are dimmed per data cell (shared standard) rather than on the
                    // <tr>, so the action icons keep full strength and the row never gains a
                    // stacking context.
                    const dataCell = `px-4 py-3.5 ${isDisabledRow ? disabledCellClass : ''}`;

                    return (
                      <tr
                        key={rowId}
                        data-status={faculty.archived ? 'archived' : isDisabledRow ? 'disabled' : 'active'}
                        className="transition-colors text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5"
                      >
                        <td className={dataCell}>
                          <div className="flex items-center">
                            <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-xs mr-3 shrink-0">
                              {faculty.name?.charAt(0) || 'F'}
                            </div>
                            <div>
                              <p className="font-bold text-slate-900 dark:text-white flex items-center flex-wrap text-sm max-w-56">
                                {faculty.name}
                                {degree && (
                                  <span
                                    title={degreeLabel(degree)}
                                    className="ml-2 px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-500 dark:text-slate-400 rounded font-bold"
                                  >
                                    {degree}
                                  </span>
                                )}
                              </p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 min-w-40 max-w-56">
                                <span className="font-mono">{faculty.facultyId || 'No faculty code'}</span>
                                {faculty.position ? ` · ${faculty.position}` : ''}
                                {faculty.employmentType
                                  ? ` · ${EMPLOYMENT_LABELS[faculty.employmentType]}`
                                  : <span className="ml-1 text-amber-600 dark:text-amber-400 font-bold" title="Open the profile and choose full-time or part-time.">· Employment type not set</span>}
                              </p>
                              {/* The specializations (and certifications) under the name, on one
                                  line each; the full lists are in the title and in the profile. */}
                              <p
                                data-testid={`faculty-specializations-${faculty.facultyId || faculty._id}`}
                                className="text-[11px] text-slate-600 dark:text-slate-300 font-medium max-w-64 truncate"
                                title={[faculty.specializations?.join(', ') || 'No specialization', faculty.certifications?.length ? `Certifications: ${faculty.certifications.join(', ')}` : 'No certifications'].join(' · ')}
                              >
                                {faculty.specializations?.join(', ') || 'None assigned'}
                                {faculty.certifications?.length ? <span className="text-slate-500 dark:text-slate-400 font-normal">{` · ${faculty.certifications.join(', ')}`}</span> : null}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className={dataCell}>
                          <div className="flex gap-1 flex-wrap max-w-40">
                            {unavailable.length > 0 ? (
                              unavailable.map(label => (
                                <span key={label} className="whitespace-nowrap px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                                  {label}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">No unavailable times</span>
                            )}
                          </div>
                        </td>
                        <td className={dataCell}>
                          {/* Phase 8 Part 4 (decision 1): the load against the professor's RANGE
                              ("Teaching 14 of 18–21 h · 4 h under", under in amber). Over the cap
                              keeps its red tone; the Guardian still gates on the cap alone. */}
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-200" data-testid={`faculty-load-${faculty.facultyId}`}>
                            {cap !== null
                              ? (() => {
                                const range = termLoad ? loadRangeLine({ teaching: termLoad.teaching, min: termLoad.min, cap }) : null;
                                return (
                                  <span className={overCap ? 'text-red-600 dark:text-red-400' : ''} title="The range is the minimum teaching load to the teaching cap.">
                                    {range ? `Teaching ${range.text}` : `Teaching … of ${cap} h cap`}
                                    {range?.under && <span className="text-amber-700 dark:text-amber-400">{` · ${range.under}`}</span>}
                                  </span>
                                );
                              })()
                              : <span className="text-amber-600 dark:text-amber-400" title="Open the profile and set the maximum teaching hours.">{`Teaching ${termLoad ? termLoad.teaching : '…'} h · cap not set`}</span>}
                            <span className="block font-normal text-slate-500 dark:text-slate-400">ancillary {ancillaryHours} h</span>
                          </p>
                          {termLoad && (
                            <p className="text-[11px] text-slate-500 dark:text-slate-400" title={`Teaching counts lab hours × the lab factor. Standard week: ${policy?.load?.standardWeeklyHours ?? 40} h; above it is reported as Excess (not blocked).`}>
                              Total {termLoad.total} h{termLoad.excess > 0 ? <span className="font-bold text-amber-700 dark:text-amber-400">{` · Excess ${termLoad.excess} h`}</span> : ''}
                            </p>
                          )}
                          {/* Phase 8 Part 2 (F2): information only — the cap above still gates assignments. */}
                          {stdLine && (
                            <p data-testid={`faculty-standard-load-${faculty.facultyId}`} className="text-[11px] text-slate-500 dark:text-slate-400" title="The standard full-time teaching load (information only; the teaching cap still gates assignments).">
                              {stdLine.text}{stdLine.overload ? <span className="font-bold text-amber-700 dark:text-amber-400">{` · ${stdLine.overload}`}</span> : ''}
                            </p>
                          )}
                          {/* One tinted pill per ancillary type ("Res 10h"); a neutral pill when none. */}
                          <div className="flex gap-1 flex-wrap mt-1.5 max-w-48">
                            {ancillaryPills.length > 0 ? (
                              ancillaryPills.map(row => (
                                <span
                                  key={row.type}
                                  title={`${ANCILLARY_TYPE_LABELS[row.type] || row.type}, ${row.hours} hours per week`}
                                  className={ancillaryPillClass(row.type)}
                                >
                                  {`${ANCILLARY_ABBREVIATIONS[row.type] || row.type} ${row.hours}h`}
                                </span>
                              ))
                            ) : (
                              <span title="No ancillary hours recorded" className={`${ANCILLARY_PILL_BASE} ${ANCILLARY_PILL_EMPTY_TONE}`}>
                                No ancillary
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={dataCell}>
                          {ratingsHidden || faculty.evalScore?.hidden ? (
                            <span data-testid="faculty-eval-hidden" title={HIDDEN_RATING_HINT} className="text-xs text-slate-500 dark:text-slate-400 leading-tight">
                              Hidden <span className="block text-[10px]">(presentation mode)</span>
                            </span>
                          ) : evalAverage !== null ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-bold text-slate-800 dark:text-slate-200 tabular-nums">
                                {evalAverage.toFixed(2)}
                              </span>
                              <span className="text-[11px] text-slate-500 dark:text-slate-400">/ 5.0</span>
                              {trend === 'up' && (
                                <span title="Improved since the previous evaluation" className="inline-flex">
                                  <TrendingUp size={16} strokeWidth={2.5} className="text-emerald-600 dark:text-emerald-400" aria-label="Improved since the previous evaluation" />
                                </span>
                              )}
                              {trend === 'down' && (
                                <span title="Declined since the previous evaluation" className="inline-flex">
                                  <TrendingDown size={16} strokeWidth={2.5} className="text-red-500 dark:text-red-400" aria-label="Declined since the previous evaluation" />
                                </span>
                              )}
                              {trend === 'flat' && (
                                <span title="No change, or not enough evaluations to compare" className="inline-flex">
                                  <Minus size={16} strokeWidth={2.5} className="text-slate-400 dark:text-slate-500" aria-label="No change, or not enough evaluations to compare" />
                                </span>
                              )}
                            </div>
                          ) : (
                            <span data-testid="faculty-no-score" title="No CCS evaluation yet (a new hire, or faculty from another department)" className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{NO_EVALUATION_WORDS}</span>
                          )}
                        </td>
                        <td className={dataCell}>
                          {faculty.archived ? (
                            <span data-testid={`faculty-archived-${faculty.facultyId || faculty._id}`} className={disabledBadgeClass}>
                              <Archive size={12} className="mr-1" /> Archived
                            </span>
                          ) : faculty.isActive ? (
                            <span className="inline-flex items-center whitespace-nowrap px-2.5 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400 border border-green-200 dark:border-green-500/20">
                              <ShieldCheck size={12} className="mr-1" /> Active
                            </span>
                          ) : (
                            <span className={disabledBadgeClass}>
                              <Ban size={12} className="mr-1" /> Disabled
                            </span>
                          )}
                        </td>
                        <td className={`px-4 py-3.5 text-right whitespace-nowrap ${isDisabledRow ? 'bg-slate-50 dark:bg-[#1c1c1f]' : 'bg-white dark:bg-[#18181b]'}`}>
                          <div className="inline-flex items-center justify-end gap-2">
                            <button
                              type="button"
                              data-testid={`faculty-log-eval-${faculty.facultyId || faculty._id}`}
                              onClick={(event) => openEvalModal(faculty, event)}
                              disabled={isTogglePending || !edit.allowed || ratingsHidden}
                              title="Log Evaluation"
                              aria-label={`Log evaluation for ${faculty.name}`}
                              {...blockedBy(edit, EDIT_NOTE_ID)}
                              {...(ratingsHidden && edit.allowed ? { title: LOG_EVAL_HIDDEN_REASON, 'aria-describedby': RATINGS_NOTE_ID } : {})}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25 dark:hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-amber-500"
                            >
                              <Star size={13} className="shrink-0" /><span className="hidden min-[1400px]:inline">Log Eval</span>
                            </button>
                            {faculty.archived ? (
                              <button
                                type="button"
                                data-testid={`faculty-restore-${faculty.facultyId || faculty._id}`}
                                onClick={() => restoreFaculty(faculty)}
                                disabled={isTogglePending || !edit.allowed}
                                title={edit.allowed ? 'Restore from the archive' : edit.reason}
                                aria-label={`Restore ${faculty.name} from the archive`}
                                {...blockedBy(edit, EDIT_NOTE_ID)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap text-green-700 bg-green-50 border border-green-200 hover:bg-green-100 dark:text-green-300 dark:bg-green-500/10 dark:border-green-500/25 dark:hover:bg-green-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-green-500"
                              >
                                <ArchiveRestore size={13} className="shrink-0" /> Restore
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  data-testid={`faculty-archive-${faculty.facultyId || faculty._id}`}
                                  onClick={(event) => askArchive(faculty, event)}
                                  disabled={isTogglePending || !edit.allowed}
                                  title={edit.allowed ? 'Archive (transferred or removed from CCS)' : edit.reason}
                                  aria-label={`Archive ${faculty.name}`}
                                  aria-haspopup="dialog"
                                  {...blockedBy(edit, EDIT_NOTE_ID)}
                                  className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 enabled:hover:text-slate-800 enabled:hover:bg-slate-100 dark:enabled:hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-500"
                                >
                                  <Archive size={15} />
                                </button>
                                <RowActions
                                  isActive={!isDisabledRow}
                                  onEdit={() => openEditModal(faculty)}
                                  onToggle={(event) => handleToggleStatus(faculty, event)}
                                  isPending={isTogglePending}
                                  name={faculty.name}
                                  blockedReason={edit.reason}
                                  reasonId={EDIT_NOTE_ID}
                                />
                              </>
                            )}
                          </div>
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

        {/* FOOTER: range, pagination (only when it is needed), live indicator */}
        <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 rounded-b-3xl">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of {totalItems} faculty
            {(searchQuery || hasActiveFilters) && totalItems !== facultyList.length ? ` (${facultyList.length} total)` : ''}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
            <TablePagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setPage}
              label="Faculty pages"
              isSyncing={isSyncing}
              hasError={Boolean(errorMessage)}
              lastSyncedAt={lastSyncedAt}
            />
          </div>
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
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="faculty-modal-title"
            className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center shrink-0">
              <div>
                <h3 id="faculty-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">
                  {editingFaculty ? 'Edit Faculty Profile' : 'Add New Faculty'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {editingFaculty ? `Editing ${editingFaculty.name}` : 'Fill in the instructor profile below.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={isSubmitting}
                aria-label="Close dialog"
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <X size={18} />
              </button>
            </div>

            {validationError && (
              <div className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400 shrink-0">
                <AlertCircle size={16} className="mr-2 shrink-0" /> {validationError}
              </div>
            )}

            {/* Header and footer are fixed; only the field area scrolls. */}
            <form onSubmit={handleSaveFaculty} noValidate className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 min-h-0 max-h-[70vh] overflow-y-auto custom-scrollbar scrollbar-gutter-stable px-6 py-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-name" className={labelClass}>Full name {requiredMark}</label>
                    <input
                      id="faculty-name"
                      data-testid="faculty-name"
                      required
                      type="text"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.name)}
                      placeholder="e.g. Juan D. Cruz"
                      className={inputClass}
                    />
                    {fieldError('name')}
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-employmentType" className={labelClass}>Employment type {requiredMark}</label>
                    <Select
                      id="faculty-employmentType"
                      data-testid="faculty-employmentType"
                      value={formData.employmentType}
                      onChange={e => handleEmploymentTypeChange(e.target.value)}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.employmentType)}
                      aria-describedby="faculty-employmentType-help"
                      className={`${inputClass} font-bold`}
                    >
                      {!formData.employmentType && <option value="" disabled>Choose full-time or part-time</option>}
                      <option value="FULL_TIME">{EMPLOYMENT_LABELS.FULL_TIME}</option>
                      <option value="PART_TIME">{EMPLOYMENT_LABELS.PART_TIME}</option>
                    </Select>
                    <p id="faculty-employmentType-help" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                      {policy
                        ? `Lab hours count × ${policy.load.labFactor.FULL_TIME} for full-time and × ${policy.load.labFactor.PART_TIME} for part-time (Scheduling Policy).`
                        : 'Decides how lab hours count toward the teaching cap.'}
                    </p>
                    {fieldError('employmentType')}
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-position" className={labelClass}>Position (optional)</label>
                    <input
                      id="faculty-position"
                      data-testid="faculty-position"
                      type="text"
                      maxLength={80}
                      value={formData.position}
                      onChange={e => setFormData({ ...formData, position: e.target.value })}
                      disabled={isSubmitting}
                      aria-describedby="faculty-position-help"
                      placeholder="e.g. Instructor I"
                      list="faculty-position-options"
                      className={inputClass}
                    />
                    <datalist id="faculty-position-options">
                      {positionOptions.map(title => <option key={title} value={title} />)}
                    </datalist>
                    <p id="faculty-position-help" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Printed on the Teachers' Program (SF-029).</p>
                    {fieldError('position')}
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-email" className={labelClass}>Email (optional)</label>
                    <input
                      id="faculty-email"
                      data-testid="faculty-email"
                      type="email"
                      value={formData.email}
                      onChange={e => setFormData({ ...formData, email: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.email)}
                      placeholder="Not recorded"
                      className={inputClass}
                    />
                    {fieldError('email')}
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-degreeLevel" className={labelClass}>Highest degree {requiredMark}</label>
                    <Select
                      id="faculty-degreeLevel"
                      data-testid="faculty-degreeLevel"
                      value={formData.degreeLevel}
                      onChange={e => setFormData({ ...formData, degreeLevel: e.target.value })}
                      disabled={isSubmitting}
                      className={`${inputClass} font-bold`}
                    >
                      {DEGREE_LEVEL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </Select>
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-evalScore" className={labelClass}>Latest student evaluation (SET rating, 1.00–5.00) {ratingsHidden ? null : requiredMark}</label>
                    {ratingsHidden ? (
                      <>
                        <input
                          id="faculty-evalScore"
                          data-testid="faculty-evalScore"
                          type="text"
                          readOnly
                          value={HIDDEN_RATING_WORDS}
                          aria-describedby="faculty-evalScore-hint"
                          className={`${inputClass} text-slate-500 dark:text-slate-400`}
                        />
                        <p id="faculty-evalScore-hint" data-testid="faculty-evalScore-hint" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">{HIDDEN_RATING_HINT}</p>
                      </>
                    ) : (
                    <>
                    <input
                      id="faculty-evalScore"
                      data-testid="faculty-evalScore"
                      required
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="5.00"
                      step="0.01"
                      value={formData.evalScore}
                      onChange={e => setFormData({ ...formData, evalScore: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.evalScore)}
                      aria-describedby="faculty-evalScore-hint"
                      className={`${inputClass} font-bold`}
                    />
                    <p id="faculty-evalScore-hint" data-testid="faculty-evalScore-hint" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">{EVAL_FIELD_HINT}</p>
                    {fieldError('evalScore')}
                    </>
                    )}
                  </div>

                  <div className="col-span-2">
                    <label htmlFor="faculty-teachingCapHours" className={labelClass}>Maximum teaching hours per week (lab hours count × lab factor) {requiredMark}</label>
                    <input
                      id="faculty-teachingCapHours"
                      data-testid="faculty-teachingCapHours"
                      required
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="40"
                      step="0.5"
                      value={formData.teachingCapHours}
                      onChange={e => setFormData({ ...formData, teachingCapHours: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.teachingCapHours)}
                      aria-describedby="faculty-teachingCapHours-help"
                      className={`${inputClass} font-bold sm:max-w-48`}
                    />
                    <p id="faculty-teachingCapHours-help" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                      {policy && formData.employmentType
                        ? `The policy default for ${EMPLOYMENT_LABELS[formData.employmentType].toLowerCase()} faculty is ${policy.load.defaultTeachingCap[formData.employmentType]} h. The Overload Guardian blocks an assignment above this cap; ancillary hours are not part of it.`
                        : 'The Overload Guardian blocks an assignment above this cap; ancillary hours are not part of it.'}
                    </p>
                    {fieldError('teachingCapHours')}
                  </div>

                  {/* Phase 8 Part 4 (decision 1): the lower end of the professor's load range. */}
                  <div className="col-span-2">
                    <label htmlFor="faculty-minTeachingHours" className={labelClass}>Minimum teaching hours per week (optional)</label>
                    <input
                      id="faculty-minTeachingHours"
                      data-testid="faculty-minTeachingHours"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="40"
                      step="0.5"
                      value={formData.minTeachingHours}
                      onChange={e => setFormData({ ...formData, minTeachingHours: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.minTeachingHours)}
                      aria-describedby="faculty-minTeachingHours-help"
                      className={`${inputClass} font-bold sm:max-w-48`}
                    />
                    <p id="faculty-minTeachingHours-help" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                      {policy && formData.employmentType
                        ? `Empty = the policy default (${policy.load.defaultMinTeachingHours?.[formData.employmentType] ?? 18} h${formData.employmentType === 'FULL_TIME' ? ', lowered by Management Function hours' : ''}). A load below the minimum shows a warning and feeds the Teaching loads balance; nothing is blocked.`
                        : 'Empty = the policy default. A load below the minimum shows a warning and feeds the Teaching loads balance; nothing is blocked.'}
                    </p>
                    {fieldError('minTeachingHours')}
                  </div>

                  {/* Phase 8 Part 4 (decision 4): the professor's own day for Extension. */}
                  <div className="col-span-2">
                    <label htmlFor="faculty-extensionDay" className={labelClass}>Day for Extension (full-time)</label>
                    <Select
                      id="faculty-extensionDay"
                      data-testid="faculty-extensionDay"
                      value={formData.extensionDay}
                      onChange={e => setFormData({ ...formData, extensionDay: e.target.value })}
                      disabled={isSubmitting}
                      aria-invalid={Boolean(fieldErrors.extensionDay)}
                      aria-describedby="faculty-extensionDay-help"
                      className={`${inputClass} font-bold sm:max-w-72`}
                    >
                      <option value="">{`The policy's day${policy?.extensionDay && policy.extensionDay !== 'none' ? ` (${policy.extensionDay})` : ' (none)'}`}</option>
                      {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => <option key={day} value={day}>{day}</option>)}
                      <option value="None">None (classes may use every weekday)</option>
                    </Select>
                    <p id="faculty-extensionDay-help" className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">
                      The schedule keeps this weekday class-free for a full-time professor; the Extension duties fill it on the Teachers&apos; Program. Part-time professors are not affected.
                    </p>
                    {fieldError('extensionDay')}
                  </div>

                  <div className="col-span-2" data-testid="faculty-specializations">
                    <p id="faculty-specializations-label" className={labelClass}>Specialization domains {requiredMark}</p>
                    <MultiSelectTags
                      options={specializationOptions}
                      value={formData.specializations}
                      onChange={handleSpecializationsChange}
                      disabled={isSubmitting}
                      placeholder="Search skills or majors (e.g. Cybersecurity)..."
                      emptyMessage={referenceLists.error ? 'The specialization list could not be loaded.' : 'No standardized specialization matches that search.'}
                      ariaLabel="Specialization domains"
                    />
                    {referenceLists.error && (
                      <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-400 mt-1">
                        The specialization list could not be loaded, so none can be added now. Reload the page once the gateway is running.
                      </p>
                    )}
                    {fieldError('specializations')}
                  </div>

                  <div className="col-span-2">
                    <label htmlFor="faculty-certifications" className={labelClass}>Certifications &amp; skills (optional)</label>
                    <input
                      id="faculty-certifications"
                      data-testid="faculty-certifications"
                      type="text"
                      value={formData.certifications}
                      onChange={e => setFormData({ ...formData, certifications: e.target.value })}
                      disabled={isSubmitting}
                      placeholder="e.g. AWS Certified, CCNA, React Developer (comma separated)"
                      className={inputClass}
                    />
                  </div>

                  <div className="col-span-2" data-testid="faculty-pastSubjects">
                    <p className={labelClass}>Past subjects taught (optional)</p>
                    <MultiSelectTags
                      options={subjectOptions}
                      value={formData.pastSubjectsTaught}
                      onChange={(next) => setFormData(prev => ({ ...prev, pastSubjectsTaught: next }))}
                      disabled={isSubmitting}
                      placeholder="Search subjects from the catalog (e.g. Networking 1)..."
                      emptyMessage={subjectOptions.length ? 'No active subject matches that search.' : 'No active subjects in the catalog yet.'}
                      ariaLabel="Past subjects taught"
                    />
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Choose from the active Master Catalog.</p>
                  </div>

                  {/* Ancillary hours by type, one row per type (SF-029: Management Function, Research,
                      Extension, Competitive Edge Enhancement, Consultation/Preparation). */}
                  <div className="col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Ancillary hours (optional)</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          data-testid="faculty-ancillary-standard"
                          onClick={handleUseStandardSet}
                          disabled={isSubmitting || !policy || ancillaryOff}
                          title={ancillaryOff ? 'Part-time faculty have no ancillary loads' : policy ? undefined : 'Waiting for the Scheduling Policy to load.'}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          Use standard full-time set
                        </button>
                        <button
                          type="button"
                          data-testid="faculty-ancillary-add"
                          ref={addAncillaryButtonRef}
                          onClick={handleAddAncillaryRow}
                          disabled={isSubmitting || ancillaryOff || unusedAncillaryTypes.length === 0}
                          title={ancillaryOff ? 'Part-time faculty have no ancillary loads' : unusedAncillaryTypes.length === 0 ? 'Every ancillary type is already listed.' : undefined}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          <Plus size={12} aria-hidden="true" /> Add a type
                        </button>
                      </div>
                    </div>
                    {ancillaryOff && (
                      <p data-testid="faculty-ancillary-part-time" className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-2">
                        Part-time faculty have no ancillary loads
                      </p>
                    )}
                    {policy && !ancillaryOff && (
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-2">
                        Standard full-time set: {Object.entries(policy.load.standardAncillary).map(([type, hours]) => `${ANCILLARY_TYPE_LABELS[type] || type} ${hours}`).join(', ')} h. Part-time faculty usually have none.
                      </p>
                    )}
                    {ancillaryOff && ancillaryRows.length === 0 ? null : ancillaryRows.length === 0 ? (
                      <p className="text-xs text-slate-500 dark:text-slate-400 py-2.5 px-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-700">
                        No ancillary hours. Add a type, or use the standard full-time set.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {ancillaryRows.map((row, index) => (
                          <div key={row.key}>
                            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] gap-2 items-center">
                              <Select
                                data-testid={`faculty-ancillary-type-${index}`}
                                value={row.type}
                                onChange={e => handleAncillaryRowChange(row.key, 'type', e.target.value)}
                                disabled={isSubmitting || ancillaryOff}
                                aria-label={`Ancillary type ${index + 1}`}
                                className={compactSelectClass}
                              >
                                {ANCILLARY_TYPES.map(type => (
                                  <option
                                    key={type}
                                    value={type}
                                    disabled={type !== row.type && ancillaryRows.some(other => other.type === type)}
                                  >
                                    {ANCILLARY_TYPE_LABELS[type]}
                                  </option>
                                ))}
                              </Select>
                              <input
                                data-testid={`faculty-ancillary-hours-${index}`}
                                type="number"
                                inputMode="decimal"
                                min="0.5"
                                max={MAX_ANCILLARY_ROW_HOURS}
                                step="0.5"
                                value={row.hours}
                                onChange={e => handleAncillaryRowChange(row.key, 'hours', e.target.value)}
                                disabled={isSubmitting || ancillaryOff}
                                placeholder="Hours"
                                aria-label={`Weekly hours for ancillary type ${index + 1}`}
                                aria-invalid={Boolean(fieldErrors[`ancillary.${index}.hours`])}
                                className={inputClass}
                                ref={bindAncillaryControl(row.key, 'hours')}
                              />
                              <button
                                type="button"
                                data-testid={`faculty-ancillary-remove-${index}`}
                                ref={bindAncillaryControl(row.key, 'remove')}
                                onClick={() => handleRemoveAncillaryRow(row.key)}
                                disabled={isSubmitting || ancillaryOff}
                                aria-label={`Remove ancillary type ${index + 1} (${ANCILLARY_TYPE_LABELS[row.type]})`}
                                title="Remove"
                                className="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-red-500"
                              >
                                <X size={14} />
                              </button>
                            </div>
                            {fieldError(`ancillary.${index}.type`)}
                            {fieldError(`ancillary.${index}.hours`)}
                          </div>
                        ))}
                      </div>
                    )}
                    {!ancillaryOff && <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1.5">
                      Total {ancillaryTotalHours} h per week (at most {MAX_ANCILLARY_TOTAL}; each type {`0.5–${MAX_ANCILLARY_ROW_HOURS}`} h). Teaching plus ancillary above {policy?.load?.standardWeeklyHours ?? 40} h is reported as Excess, not blocked.
                    </p>}
                    {fieldError('ancillary')}
                  </div>

                  {/* Unavailable times (Phase 4 Part 2): the weekly grid marks them quickly; the list
                      below holds the same rows (for notes, and for days or hours the grid cannot show). */}
                  <div className="col-span-2">
                    <p className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Unavailable times</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2 leading-snug">
                      Mark the times this professor can't teach: classes in other colleges or schools, graduate classes on weekends, other duties.
                      The schedule never places a class in a marked time.
                    </p>
                    {policy && wholeDayWindow ? (
                      <UnavailableGrid
                        blocks={formData.unavailableBlocks}
                        onChange={unavailableBlocks => setFormData(prev => ({ ...prev, unavailableBlocks }))}
                        days={gridDays}
                        hours={wholeDayWindow}
                        slotMinutes={policy.slotMinutes}
                        disabled={isSubmitting}
                        testIdPrefix="faculty-grid"
                      />
                    ) : (
                      <p className="text-xs text-slate-500 dark:text-slate-400 italic">The grid needs the Scheduling Policy, which is still loading.</p>
                    )}
                  </div>
                  <TimeWindowsEditor
                    label="Unavailable times, as a list"
                    help="The same times as rows, for a note (where the professor is) or a time the grid does not show. Sunday rows are stored for completeness; classes are never placed on Sunday."
                    testIdPrefix="faculty-unavailable"
                    fieldPrefix="unavailableBlocks"
                    windows={formData.unavailableBlocks}
                    onChange={unavailableBlocks => setFormData(prev => ({ ...prev, unavailableBlocks }))}
                    days={DAY_NAMES}
                    times={blockTimes}
                    errors={fieldErrors}
                    withNote
                    wholeDay={() => policyWholeDay(policy)}
                    disabled={isSubmitting || !policy}
                    addLabel="Add an unavailable time"
                    emptyText="No unavailable times: the professor can teach whenever classes run."
                  />

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-program" className={labelClass}>Program (optional)</label>
                    <Select
                      id="faculty-program"
                      data-testid="faculty-program"
                      value={formData.program}
                      onChange={e => setFormData({ ...formData, program: e.target.value })}
                      disabled={isSubmitting}
                      aria-describedby="faculty-program-help"
                      className={inputClass}
                    >
                      <option value="">None</option>
                      {PROGRAM_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </Select>
                    <p id="faculty-program-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">Printed as &ldquo;Major/Minor&rdquo; on the Teachers&apos; Program, as last year&apos;s forms did.</p>
                    {fieldError('program')}
                  </div>

                  <div className="col-span-2">
                    <label htmlFor="faculty-major" className={labelClass}>Major/Minor, for the recommendations (optional)</label>
                    <input
                      id="faculty-major"
                      data-testid="faculty-major"
                      type="text"
                      maxLength={120}
                      value={formData.major}
                      onChange={e => setFormData({ ...formData, major: e.target.value })}
                      disabled={isSubmitting}
                      placeholder="e.g. Information Technology, Computer Science, Mathematics"
                      aria-describedby="faculty-major-help"
                      className={inputClass}
                    />
                    <p id="faculty-major-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">The recommendations read it with the specializations. It is no longer printed: the Teachers&apos; Program prints the Program.</p>
                    {fieldError('major')}
                  </div>

                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="faculty-degreeAfterName" className={labelClass}>Degree after the name (optional)</label>
                    <input
                      id="faculty-degreeAfterName"
                      data-testid="faculty-degreeAfterName"
                      type="text"
                      maxLength={40}
                      value={formData.degreeAfterName}
                      onChange={e => setFormData({ ...formData, degreeAfterName: e.target.value })}
                      disabled={isSubmitting}
                      placeholder="e.g. MSIT, DIT, PhD"
                      aria-describedby="faculty-degreeAfterName-help"
                      className={inputClass}
                    />
                    <p id="faculty-degreeAfterName-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">Printed after the name on the Teachers&apos; Program only (&ldquo;FacultyMember, MSIT&rdquo;).</p>
                    {fieldError('degreeAfterName')}
                  </div>

                  <div className="col-span-2">
                    <label htmlFor="faculty-coCurricular" className={labelClass}>Co-Curricular Activities (optional)</label>
                    <textarea
                      id="faculty-coCurricular"
                      data-testid="faculty-coCurricular"
                      rows={2}
                      maxLength={500}
                      value={formData.coCurricular}
                      onChange={e => setFormData({ ...formData, coCurricular: e.target.value })}
                      disabled={isSubmitting}
                      placeholder="e.g. Organization adviser"
                      className={inputClass}
                    />
                    {fieldError('coCurricular')}
                  </div>
                </div>
              </div>

<div className="shrink-0 px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between gap-3">
                <p className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:block">
                  {editingFaculty ? 'Changes apply as soon as you save.' : 'New profiles start as Active.'}
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
                    data-testid="faculty-submit"
                    disabled={isSubmitting}
                    className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-md shadow-blue-900/20 flex items-center disabled:opacity-70 cursor-pointer"
                  >
                    {isSubmitting ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                    {isSubmitting ? 'Saving...' : editingFaculty ? 'Save Changes' : 'Create Profile'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LOG EVALUATION MODAL: term + score only, no remarks field by design. */}
      {evalTarget && (() => {
        // The context line quotes evalScore.average, the value the table shows and Engine 2 ranks
        // on. The latest entry's term is added only when that entry is what set the average.
        const currentAverage = Number(evalTarget.evalScore?.average);
        const hasAverage = Number.isFinite(currentAverage) && currentAverage > 0;
        const latest = latestEvalEntry(evalTarget.evalScore);
        const termNote = hasAverage && latest?.term && Math.abs(latest.score - currentAverage) < 0.005
          ? `, logged for ${latest.term}`
          : '';
        // Tab and Shift+Tab stay inside the dialog so the roster behind it cannot be reached.
        const trapEvalFocus = (event) => {
          if (event.key !== 'Tab') return;
          const focusables = [...event.currentTarget.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled])')];
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeEvalModal();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="eval-modal-title"
              onKeyDown={trapEvalFocus}
              className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-md shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200"
            >
              <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                    <Star size={18} />
                  </div>
                  <div className="min-w-0">
                    <h3 id="eval-modal-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">Log Evaluation</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{evalTarget.name}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeEvalModal}
                  disabled={isLoggingEval}
                  aria-label="Close dialog"
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleLogEvaluation}>
                <div className="px-6 py-5 space-y-4">
                  {evalError && (
                    <div id="eval-error" role="alert" className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center text-xs font-bold text-red-600 dark:text-red-400">
                      <AlertCircle size={16} className="mr-2 shrink-0" /> {evalError}
                    </div>
                  )}

                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {hasAverage
                      ? `Latest SET rating ${currentAverage.toFixed(2)} / 5.0${termNote}. The new rating replaces it in the professor rankings.`
                      : 'No CCS evaluation yet (0 – none yet). This rating becomes the one the professor rankings use.'}
                  </p>

                  <div>
                    <label htmlFor="eval-term" className={labelClass}>Target Semester *</label>
                    <Select
                      id="eval-term"
                      required
                      value={evalForm.term}
                      onChange={e => setEvalForm(prev => ({ ...prev, term: e.target.value }))}
                      disabled={isLoggingEval}
                      className={`${inputClass} font-bold`}
                    >
                      {evaluationTerms.map(term => (
                        <option key={term} value={term}>{term}</option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label htmlFor="eval-score" className={labelClass}>Score *</label>
                    <input
                      id="eval-score"
                      ref={evalScoreInputRef}
                      required
                      autoFocus
                      aria-invalid={Boolean(evalError)}
                      aria-describedby={evalError ? 'eval-error' : undefined}
                      type="number"
                      inputMode="decimal"
                      min="1.00"
                      max="5.00"
                      step="0.01"
                      value={evalForm.score}
                      onChange={e => setEvalForm(prev => ({ ...prev, score: e.target.value }))}
                      disabled={isLoggingEval}
                      placeholder="e.g. 4.50"
                      className={`${inputClass} font-bold tabular-nums`}
                    />
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Student evaluation on a 1.00–5.00 scale, up to two decimals.</p>
                  </div>
                </div>

                <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeEvalModal}
                    disabled={isLoggingEval}
                    className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isLoggingEval}
                    className="px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 transition-colors shadow-md shadow-amber-900/20 flex items-center disabled:opacity-70 cursor-pointer"
                  >
                    {isLoggingEval ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                    {isLoggingEval ? 'Logging...' : 'Log Evaluation'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* Toast Notification. The live region stays mounted so assistive tech announces every
          message; only the toast body is conditional. Failures get a distinct icon and tint. */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50">
        {toast && (
          <div className="flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
              toast.tone === 'error'
                ? 'bg-red-500/20 dark:bg-red-500/15 text-red-400 dark:text-red-600'
                : 'bg-blue-500/20 dark:bg-blue-500/15 text-blue-400 dark:text-blue-600'
            }`}>
              {toast.tone === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
            </div>
            <span data-testid="faculty-toast-message" className="text-xs font-bold tracking-wide">{toast.message}</span>
            {toast.undo && (
              <button type="button" data-testid="faculty-undo" onClick={() => { const undo = toast.undo; dismissToast(); undo(); }} className="ml-1 shrink-0 px-2.5 py-1 rounded-lg text-xs font-black text-blue-300 dark:text-blue-700 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={dismissToast}
              aria-label="Dismiss notification"
              className="ml-2 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* DISABLE CONFIRMATION */}
      {disableQuestion.target && (
        <ConfirmDialog
          testId="disable-confirm"
          title={`Disable ${disableQuestion.target.name}?`}
          keepLabel="Cancel"
          confirmLabel={`Disable ${disableQuestion.target.name}`}
          busyLabel="Disabling…"
          onKeep={disableQuestion.keep}
          onConfirm={disableQuestion.confirm}
          busy={disableQuestion.busy}
          error={disableQuestion.error}
          tone="red"
          icon={Ban}
          returnFocusRef={tableRegionRef}
        >
          {disableQuestion.target.name} is no longer offered for assignments or ranked in the recommendations. The profile is kept, and you can enable it again.
        </ConfirmDialog>
      )}

      {/* ARCHIVE CONFIRMATION (Phase 8 Part 8, decision 3d) */}
      {archiveQuestion && (
        <ConfirmDialog
          testId="archive-confirm"
          title={`Archive ${archiveQuestion.faculty.name}?`}
          keepLabel="Cancel"
          confirmLabel={archiveQuestion.classes?.length ? 'Try again' : `Archive ${archiveQuestion.faculty.name}`}
          busyLabel="Archiving…"
          onKeep={() => setArchiveQuestion(null)}
          onConfirm={confirmArchive}
          busy={archiveQuestion.busy}
          error={archiveQuestion.classes?.length ? '' : archiveQuestion.error}
          tone="red"
          icon={Archive}
          returnFocusRef={tableRegionRef}
        >
          <p>Archived means transferred or removed from CCS. The profile leaves Assign Faculty, the teaching loads, the Readiness Check and the schedule; saved versions and their printed forms keep it. You can restore it from the &ldquo;Archived&rdquo; filter.</p>
          {archiveQuestion.classes?.length ? (
            <div data-testid="archive-classes" role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
              <p className="font-bold">{archiveQuestion.faculty.name} has {archiveQuestion.classes.length} {archiveQuestion.classes.length === 1 ? 'class' : 'classes'} in {termLabel}. Reassign {archiveQuestion.classes.length === 1 ? 'it' : 'them'} on Assign Faculty first:</p>
              <ul className="mt-1 list-disc pl-5">
                {archiveQuestion.classes.map(c => <li key={`${c.sectionCode}-${c.subjectCode}`}>{c.subjectCode}{c.descriptiveTitle ? ` (${c.descriptiveTitle})` : ''} for {c.sectionCode}</li>)}
              </ul>
              <a data-testid="archive-open-assign" href={`#/assign-faculty?professor=${encodeURIComponent(archiveQuestion.faculty.facultyId || '')}`} className="mt-2 inline-block font-bold underline">Open Assign Faculty</a>
            </div>
          ) : null}
        </ConfirmDialog>
      )}
    </div>
  );
}
