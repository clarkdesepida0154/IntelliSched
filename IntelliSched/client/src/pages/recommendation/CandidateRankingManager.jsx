import HelpTip from "../../components/ui/HelpTip";
import { Fragment, useState, useEffect, useRef } from 'react';
import {
  BrainCircuit, CheckCircle2, Info, Loader2, X, MessageSquareQuote, RefreshCw, AlertOctagon,
  AlertTriangle, ShieldCheck, Search, ListChecks, Trophy, BarChart, PlayCircle, Lock, Undo2
} from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import useEscapeKey from '../../hooks/useEscapeKey';
import usePolicy from '../../hooks/usePolicy';
import usePermission from '../../hooks/usePermission';
import usePagination from '../../hooks/usePagination';
import PermissionNote from '../../components/ui/PermissionNote';
import TablePagination from '../../components/ui/TablePagination';
import { weightedHoursOf } from '../../utils/load';
import { isTbaSubject } from '../../utils/subjectType';
import { buildTermPairs, findLockFor, toSemesterLabel } from '../../utils/sectionMatcher';
import { LIKELIHOOD_HELP, WEAK_RANKING_NOTE, likelihoodOf, likelihoodText } from '../../utils/likelihood';
// Lock writes from this page and Course Matrix share one serialized queue (see utils/lockQueue.js).
import {
  enqueueLockWrite, waitForLockWrites, reportLostLockWrite, drainLostLockWrites, describeLostLockWrites
} from '../../utils/lockQueue';
import Select from '../../components/ui/Select';

// Express gateway route (server/src/routes/schedulerRoutes.js). The gateway ranks the term's mapped
// Majors regardless of `subjectCodes`, which is sent so it can be honored server-side later. The term
// fields decide which curriculum is ranked and whose locks count toward each candidate's currentLoad.
const BATCH_ENDPOINT = '/schedule/recommendations/batch';
const OFFLINE_MESSAGE = 'The recommendations could not be loaded: the ranking service did not answer. Try again in a minute; if it keeps failing, check Service Health.';
const EMPTY_MESSAGE = 'No Major subjects are placed in this semester in the Curriculum Builder. GenEd, Minor and NSTP subjects are TBA and are never ranked.';
// Ranking the whole college can take minutes: this request waits a little longer than the gateway's
// own 180 s limit (config/mlClient.js), so the gateway's message arrives first (the client's default
// is 30 s, services/api.js).
const RANKING_TIMEOUT_MS = 185000;
// Pages of 25 rows (the table standard).
const PAGE_SIZE = 25;
// The actions column stays in view when a narrow window scrolls the table sideways (Phase 3 Step 8).
const STICKY_CELL = 'sticky right-0 border-l border-slate-100 dark:border-slate-800/60';
// The TBA pool's candidate (the gateway's tbaCandidate, and the By class tab's pool card): its score is
// not a ranking, so none is shown.
const TBA_CANDIDATE_IDS = ['TBA', 'FAC-TBA'];

// Seconds since `active` became true, ticking once a second (0 while inactive).
const useElapsedSeconds = (active) => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [active]);
  return active ? seconds : 0;
};
// 12 -> "12 s", 75 -> "1 min 15 s".
const formatElapsed = (seconds) => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);

// Real-Time Overload Guardian: a workload bar turns amber at 80% of the weekly cap and red at 100%.
const LOAD_WARNING_PERCENT = 80;
// The visible reason (Phase 3 Step 6) the tab's write controls point at while the role may not assign.
const ASSIGN_NOTE_ID = 'ranking-permission-note';

const toHours = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? hours : null;
};

// 21 -> "21", 22.5 -> "22.5"
const formatHours = (hours) => (Number.isInteger(hours) ? String(hours) : hours.toFixed(1));

const loadBarColor = (percent) => {
  if (percent >= 100) return 'bg-red-500';
  if (percent >= LOAD_WARNING_PERCENT) return 'bg-amber-500';
  return 'bg-blue-600';
};

// One row per (subject, section), the same pairs the GA's Automated Section Matcher builds from the
// Curriculum Builder, so a professor ranked #1 for five sections appears five times and the Guardian
// can stop the one that would overload them. Rows are keyed by the catalog subjectId, which keeps
// subjects that share a code (e.g. ITST 301 on each BSIT track) apart.
const buildRankingRows = (rawPredictions, mappings, sections, locks) => {
  const predictionsById = new Map(rawPredictions.filter(p => p.subjectId).map(p => [String(p.subjectId), p]));
  // An older gateway sends no subjectId: its predictions are matched by code instead.
  const predictionsByCode = predictionsById.size ? new Map() : new Map(rawPredictions.map(p => [p.subjectCode, p]));
  const predictionFor = (subject) => predictionsById.get(String(subject._id)) || predictionsByCode.get(subject.subjectCode);

  const activeSections = sections
    .filter(section => section.isActive)
    .sort((a, b) => String(a.sectionCode).localeCompare(String(b.sectionCode)));
  // Only Majors are ranked; Minor and NSTP subjects stay TBA, and a practicum's coordinator is chosen
  // on the Course Matrix.
  const majorMappings = mappings.filter(m => m.subject && m.subject.isActive !== false && !isTbaSubject(m.subject) && !m.subject.isPracticum);
  const rankedMappings = majorMappings.filter(m => predictionFor(m.subject));
  // Phase 4 Part 4: "Major classes assigned: X of Y" counts EVERY Major class of the term (one per
  // (subject, section) pair of the active sections), not only the Majors the ranking service returned.
  const termMajorPairs = buildTermPairs(activeSections, majorMappings).map(({ section, subject }) => {
    const lock = findLockFor(locks, section.sectionCode, subject);
    return { key: `${subject._id}::${section.sectionCode}`, lockedFacultyId: lock?.facultyId || null };
  });

  const baseRow = (subject) => ({
    subjectId: String(subject._id),
    subjectCode: subject.subjectCode,
    subjectTitle: subject.descriptiveTitle || 'Core Academic Course',
    contactHours: (Number(subject.lecHours) || 0) + (Number(subject.labHours) || 0),
    // What the one load rule needs to weigh this subject for a professor (utils/load.js).
    subject: { lecHours: subject.lecHours, labHours: subject.labHours, isPracticum: Boolean(subject.isPracticum) },
    candidates: Array.isArray(predictionFor(subject)?.candidates) ? predictionFor(subject).candidates : [],
    // Phase 6: nobody on the current faculty has taught this subject before (the gateway reads the
    // professors' teaching history), so the page calls the ranking weak.
    nobodyTaughtBefore: predictionFor(subject)?.nobodyTaughtBefore === true,
    rerunCount: 0
  });

  const rows = buildTermPairs(activeSections, rankedMappings).map(({ section, subject }) => {
    // The GA staffs a pair with its lock: by catalog id, or by code for locks older than subjectId.
    const lock = findLockFor(locks, section.sectionCode, subject);
    return {
      ...baseRow(subject),
      key: `${subject._id}::${section.sectionCode}`,
      section: section.sectionCode,
      lockedFacultyId: lock?.facultyId || null,
      lockedFaculty: lock?.facultyName || null
    };
  });

  // A mapped Major that no active section takes stays visible, so the gap is noticed, but it
  // cannot be assigned.
  const placed = new Set(rows.map(row => row.subjectId));
  const unplaced = new Map();
  rankedMappings.forEach(m => {
    const id = String(m.subject._id);
    if (!placed.has(id) && !unplaced.has(id)) unplaced.set(id, m.subject);
  });
  unplaced.forEach(subject => rows.push({
    ...baseRow(subject),
    key: `${subject._id}::`,
    section: undefined,
    lockedFacultyId: null,
    lockedFaculty: null
  }));

  const sorted = rows.sort((a, b) =>
    a.subjectCode.localeCompare(b.subjectCode)
    || a.subjectTitle.localeCompare(b.subjectTitle)
    || String(a.section ?? '').localeCompare(String(b.section ?? '')));
  // Carried next to the rows for the count (every Major class of the term, ranked or not).
  sorted.termMajorPairs = termMajorPairs;
  return sorted;
};

// facultyId -> teaching hours already committed this term (the gateway's one load rule). The
// response lists every active professor (facultyLoads); candidates repeat their own value.
const loadsFromResponse = (data) => {
  const loads = {};
  (Array.isArray(data?.facultyLoads) ? data.facultyLoads : []).forEach(f => {
    const load = toHours(f.teaching);
    if (f.id && load !== null) loads[f.id] = load;
  });
  (data?.predictions || []).forEach(p => (Array.isArray(p.candidates) ? p.candidates : []).forEach(c => {
    const load = toHours(c.currentLoad);
    if (c.id && load !== null && loads[c.id] === undefined) loads[c.id] = load;
  }));
  return loads;
};

// facultyId -> { name, employmentType, cap }: what the load rule needs to weigh a subject for
// anyone, including a current holder who is not among a row's top candidates; the name lets the
// review dialog list the whole active roster (the response's facultyLoads), not only the ranked.
const facultyInfoFromResponse = (data) => {
  const info = {};
  (Array.isArray(data?.facultyLoads) ? data.facultyLoads : []).forEach(f => {
    // min (Phase 8 Part 4): the lower end of the professor's load range, for "14 of 18–21 h".
    if (f.id) info[f.id] = { name: f.name, employmentType: f.employmentType, cap: toHours(f.cap), min: toHours(f.min) };
  });
  return info;
};

// Teaching hours one row adds for one professor: lecture + lab x their lab factor (practicum:
// the coordinator hours). null until the Scheduling Policy has loaded.
const hoursFor = (row, facultyId, info, policy) => (policy && row?.subject
  ? weightedHoursOf(row.subject, info[facultyId] || {}, policy)
  : null);

// The predictions, the term's curriculum placements, the sections and the term's locks the table is
// built from. Any failure rejects the whole read, so the Guardian never runs on a partial picture.
const fetchRankingData = async (termParams, semesterNumber, body = {}) => {
  const [res, mappingsRes, sectionsRes, locksRes] = await Promise.all([
    api.post(BATCH_ENDPOINT, { ...termParams, ...body }, { timeout: RANKING_TIMEOUT_MS }),
    api.get('/curriculum-mappings', { params: { semester: toSemesterLabel(semesterNumber) } }),
    api.get('/sections'),
    api.get('/schedule/locks', { params: termParams })
  ]);
  const rawPredictions = res.data?.predictions || [];
  return {
    rawPredictions,
    rows: buildRankingRows(rawPredictions, mappingsRes.data || [], sectionsRes.data || [], locksRes.data?.locks || []),
    loads: loadsFromResponse(res.data),
    info: facultyInfoFromResponse(res.data)
  };
};

// A lock belongs to one catalog subject in one section.
const lockKeyOf = (row) => `${row.subjectId}::${row.section ?? ''}`;

const rowLabelOf = (row) => `${row.subjectCode}${row.section ? ` ${row.section}` : ''}`;

// Guardian verdict for giving one row to one candidate, read from the optimistic teaching loads
// against the teaching cap (the one load rule: ancillary hours are not part of the cap).
const assessAssignment = (row, candidate, loads, info, policy) => {
  const hours = candidate ? (hoursFor(row, candidate.id, info, policy) ?? toHours(candidate.addHours)) : null;
  const cap = toHours(candidate?.maxWeeklyHours);
  // The lower end of the professor's range (Phase 8 Part 4): from the candidate row, else the roster.
  const min = candidate ? (toHours(candidate.minTeachingHours) ?? toHours(info[candidate.id]?.min)) : null;
  const load = candidate && typeof loads[candidate.id] === 'number' ? loads[candidate.id] : null;
  const isKnown = cap !== null && cap > 0 && load !== null;
  if (candidate && row.lockedFacultyId === candidate.id) {
    return { status: 'assigned', blocked: false, load, cap, min, addHours: 0 };
  }
  if (!row.section) {
    return { status: 'no-section', blocked: true, load, cap, min, addHours: 0, message: 'No section', reason: 'No active section takes this subject, so there is nothing to lock.' };
  }
  if (!isKnown) {
    return { status: 'unknown', blocked: true, load, cap, min, addHours: 0, message: 'Load unavailable', reason: 'This instructor has no teaching cap on record (or is not an active faculty record), so their workload cannot be checked. Set the cap on the Faculty page.' };
  }
  if (hours === null) {
    return { status: 'unknown', blocked: true, load, cap, min, addHours: 0, message: 'Loading policy', reason: 'The Scheduling Policy is still loading, so the teaching hours cannot be checked yet.' };
  }
  const projected = Math.round((load + hours) * 100) / 100;
  const summary = `Assigning adds ${formatHours(hours)} teaching h: ${formatHours(projected)} / ${formatHours(cap)} h cap`;
  // Phase 6: the professor this class would push over the teaching cap is marked "Over the cap"; the
  // Overload Guardian still decides on Assign.
  if (projected > cap) {
    return { status: 'exceeded', blocked: true, load, cap, min, addHours: hours, projected, message: 'Over the cap', reason: `${summary}, over the weekly cap.` };
  }
  return { status: 'ok', blocked: false, load, cap, min, addHours: hours, projected, reason: `${summary}.` };
};

const getCandidateAtRank = (candidates, rank) =>
  candidates.find(c => Number(c.rank) === rank) || candidates[rank - 1] || null;

const rowKey = (row) => row.key;

// Weekly workload bar: the optimistic load against the cap, plus a faint segment for the hours this
// row would add. The label and the bar keep a fixed height, so rows never jump.
function WorkloadMeter({ load, cap, min = null, addHours = 0, label = 'Weekly workload' }) {
  if (typeof load !== 'number' || !(cap > 0)) {
    return (
      <div className="mt-1.5">
        <p className="text-xs text-gray-500 dark:text-slate-400">Load unavailable</p>
        <div className="h-1.5 rounded-full w-full bg-gray-200 dark:bg-slate-700 mt-1" />
      </div>
    );
  }

  const percent = (load / cap) * 100;
  const projectedPercent = ((load + addHours) / cap) * 100;
  const fill = Math.min(Math.max(percent, 0), 100);
  const ghost = Math.max(Math.min(projectedPercent, 100) - fill, 0);
  // Phase 8 Part 4 (decision 1): the load against the professor's RANGE — "14 of 18–21 h", with
  // "4 h under" in amber while the load sits below the minimum.
  const hasMin = typeof min === 'number' && min >= 0;
  const under = hasMin ? Math.max(0, Math.round((min - load) * 100) / 100) : 0;

  return (
    <div className="mt-1.5">
      <p className="text-xs text-gray-500 dark:text-slate-400 tabular-nums">
        {hasMin ? `${formatHours(load)} of ${formatHours(min)}–${formatHours(cap)} h` : `${formatHours(load)} / ${formatHours(cap)} hrs`}
        {addHours > 0 && <span className="font-semibold"> · +{formatHours(addHours)} h</span>}
        {under > 0 && <span className="font-semibold text-amber-700 dark:text-amber-400"> · {formatHours(under)} h under</span>}
      </p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        // A range widget's value must stay within its bounds; an over-cap load is spelled out in the text.
        aria-valuenow={Math.min(Math.max(load, 0), cap)}
        aria-valuetext={`${formatHours(load)} of ${formatHours(cap)} hours${load > cap ? ', over the weekly cap' : ''}`}
        className="relative h-1.5 rounded-full w-full bg-gray-200 dark:bg-slate-700 mt-1 overflow-hidden"
      >
        <div className={`absolute inset-y-0 left-0 rounded-full ${loadBarColor(percent)} transition-[width] duration-300`} style={{ width: `${fill}%` }} />
        {ghost > 0 && (
          <div className={`absolute inset-y-0 ${loadBarColor(projectedPercent)} opacity-35`} style={{ left: `${fill}%`, width: `${ghost}%` }} />
        )}
      </div>
    </div>
  );
}

// One ranked candidate: name, AI score, live workload and the Guardian-controlled assign action.
// Rank 1 approves in place; ranks 2-3 open the review dialog, which asks for the override reason.
// blockedReason (Phase 3 Step 6): the permission map's reason when the role may not assign faculty;
// the action is then disabled, says why, and points at the tab's note (blockedNoteId).
function CandidateCell({ candidate, isTopPick, verdict, isPending, isDisabled, onAssign, statusId, rowLabel, blockedReason = '', blockedNoteId }) {
  if (!candidate) {
    return <span className="text-xs text-slate-600 dark:text-slate-400 italic">No candidate</span>;
  }

  const isIncomplete = candidate.dataQualityFlag === false;
  const isAssigned = verdict?.status === 'assigned';
  const isBlocked = Boolean(verdict?.blocked);
  const roleBlocked = Boolean(blockedReason) && !isAssigned;
  const describedBy = [roleBlocked ? blockedNoteId : '', isBlocked ? statusId : ''].filter(Boolean).join(' ') || undefined;
  const statusTone = verdict?.status === 'exceeded' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400';
  const actionLabel = isAssigned
    ? `${candidate.name} is assigned to ${rowLabel}`
    : `${isTopPick ? 'Approve' : 'Assign'} ${candidate.name} for ${rowLabel}`;

  // Phase 6: the score reads "Likelihood", the percentage with its plain level (utils/likelihood.js).
  const likelihood = likelihoodOf(candidate.score, candidate.id);

  return (
    // The cell takes its column's width (Phase 6, the audit's N5: the three ranks fit at 1280 px).
    <div className="w-full min-w-0" title={candidate.reason || ''}>
      <div className="flex items-center gap-1.5">
        {isTopPick && <Trophy size={12} className="text-cyan-500 shrink-0" />}
        <span className={`text-xs font-bold wrap-break-word min-w-0 ${isTopPick ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>
          {candidate.name}
        </span>
        {isIncomplete && (
          <span title="This professor's profile has no specialization recorded, so the match is less certain." className="inline-flex shrink-0">
            <AlertTriangle size={12} className="text-amber-500" />
          </span>
        )}
      </div>
      <div data-testid="ranking-likelihood" className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">Likelihood</span>
        <span
          data-level={likelihood?.level || ''}
          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black border tabular-nums ${
            isTopPick
              ? 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/30'
              : 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
          }`}
        >
          {likelihood ? likelihood.text : 'not given'}
        </span>
      </div>

      <WorkloadMeter load={verdict?.load} cap={verdict?.cap} min={verdict?.min} addHours={verdict?.addHours} label={`${candidate.name} weekly workload`} />

      {/* Fixed-height action line: the button and the status slot are always rendered (the slot is
          only made visible), so a disabled or assigned state never changes the row height. The
          button also stays mounted and focusable once assigned (aria-disabled, not disabled), so
          keyboard focus is never dropped to the page when an approval lands. */}
      <div className="mt-2 flex items-center gap-2 h-6">
        {/* Disabled buttons fire no mouse events, so the explanation lives on a wrapper. */}
        <span className="inline-flex" title={isAssigned ? '' : roleBlocked ? blockedReason : verdict?.reason || ''}>
          <button
            type="button"
            onClick={isAssigned ? undefined : onAssign}
            disabled={!isAssigned && (isDisabled || isBlocked || roleBlocked)}
            aria-disabled={isAssigned || undefined}
            aria-label={actionLabel}
            aria-describedby={describedBy}
            className={`inline-flex items-center gap-1 h-6 px-2.5 rounded-md text-[11px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isAssigned
                ? 'px-2 bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30 cursor-default'
                : isTopPick
                  ? 'cursor-pointer bg-cyan-600 text-white hover:bg-cyan-700 disabled:hover:bg-cyan-600'
                  : 'cursor-pointer border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:hover:bg-transparent'
            }`}
          >
            {isAssigned
              ? (isPending ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />)
              : <Lock size={11} />}
            {isAssigned ? (isPending ? 'Saving…' : 'Assigned') : (isTopPick ? 'Approve' : 'Assign…')}
          </button>
        </span>
        <span
          id={statusId}
          className={`inline-flex items-center gap-1 text-[10px] font-bold ${statusTone} ${isBlocked ? '' : 'invisible'}`}
        >
          <AlertTriangle size={11} className="shrink-0" />
          {verdict?.message || 'Over the cap'}
        </span>
      </div>
    </div>
  );
}

// `embedded` (Phase 3 Step 4): the "Recommendations" tab of Assign Faculty, which shows the page heading,
// its purpose and the current term itself; this page then drops its own heading and card, and its
// Refresh action moves into the table's toolbar.
export default function CandidateRankingManager({ embedded = false }) {
  // Decisions are logged against the schedule of the term chosen in the top bar.
  const { termParams, activeSemesterNumber } = useTerm();
  const { policy } = usePolicy();
  // Approving, choosing another professor and releasing an assignment: the permission map's
  // faculty.assign. The ranking itself (Refresh, Re-run, Review) is open to every role.
  const assign = usePermission('faculty.assign');
  // facultyId -> { employmentType, cap } from the last read (see facultyInfoFromResponse).
  const facultyInfoRef = useRef({});
  const [facultyInfo, setFacultyInfo] = useState({});
  const seedFacultyInfo = (info) => {
    facultyInfoRef.current = info;
    setFacultyInfo(info);
  };
  const [predictions, setPredictions] = useState([]);
  // Every Major class of the term, for "Major classes assigned: X of Y" (Phase 4 Part 4).
  const [termMajors, setTermMajors] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRerunning, setIsRerunning] = useState(false);
  const [rerunningKeys, setRerunningKeys] = useState(() => new Set());
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  // Filters (Phase 3 Step 8): a section, and a professor among a row's top three or assigned to it.
  const [sectionFilter, setSectionFilter] = useState('');
  const [professorFilter, setProfessorFilter] = useState('');
  // Subjects no active section takes are hidden until "Show all" is ticked: they cannot be assigned.
  const [showAll, setShowAll] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [activePrediction, setActivePrediction] = useState(null);
  const [toast, setToast] = useState(null);

  const [overrideSelection, setOverrideSelection] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  // Real-Time Overload Guardian. facultyId -> weekly load (ancillary + locked contact hours), seeded
  // from the gateway's currentLoad and moved optimistically by every assignment and undo.
  const [optimisticLoads, setOptimisticLoads] = useState({});
  // Synchronous mirror of optimisticLoads, so two clicks inside one frame can never both pass the
  // capacity check before React re-renders.
  const loadsRef = useRef({});
  // Lock keys with a lock or unlock request in flight: state drives the spinners, the ref is the
  // synchronous re-entry guard.
  const [pendingLockKeys, setPendingLockKeys] = useState(() => new Set());
  const pendingLockRef = useRef(new Set());
  // True while a Refresh All or a re-run is reading: a write made meanwhile would be erased by that
  // older snapshot when it lands, so assignments wait until the read settles.
  const syncingRef = useRef(false);
  const mountedRef = useRef(true);

  const headerCheckboxRef = useRef(null);
  const toastTimerRef = useRef(null);
  // True while an error toast is on screen: a later success must not replace it unread.
  const errorShowingRef = useRef(false);
  // Keyboard focus targets: each row's Review button (where focus goes after an Undo hides itself)
  // and the control that opened the review dialog (where focus returns when it closes).
  const reviewButtonRefs = useRef(new Map());
  const modalTriggerRef = useRef(null);

  const seedLoads = (loads) => {
    loadsRef.current = loads;
    setOptimisticLoads(loads);
  };

  // Single toast channel: a new message restarts the timer, so an older timer never hides it early.
  // tone 'error' marks refusals and failed writes so they never look like a success, and a success
  // never replaces an error that is still on screen.
  const showToast = (message, { tone = 'success', duration = 4000 } = {}) => {
    if (!mountedRef.current) return;
    if (tone !== 'error' && errorShowingRef.current) return;
    errorShowingRef.current = tone === 'error';
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      errorShowingRef.current = false;
      setToast(null);
    }, duration);
  };

  const dismissToast = () => {
    errorShowingRef.current = false;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setToast(null);
  };

  useEffect(() => {
    let isMounted = true;
    mountedRef.current = true;

    async function loadInitialRecommendations() {
      try {
        // Lock writes still queued by an earlier visit to this page finish first, so the first
        // picture (loads and lock badges) already includes them.
        await waitForLockWrites();
        // Only the active term's subjects are ranked here, so every lock is written on the schedule
        // of the term that actually contains the subject.
        const { rows, loads, info } = await fetchRankingData(termParams, activeSemesterNumber);
        if (!isMounted) return;
        seedFacultyInfo(info);
        loadsRef.current = loads;
        setOptimisticLoads(loads);
        // A queued write that failed after its page closed is reported here instead of vanishing.
        const lost = drainLostLockWrites();
        if (lost.length) showToast(describeLostLockWrites(lost), { tone: 'error', duration: 8000 });

        if (rows.length) {
          setErrorMessage('');
          setPredictions(rows);
          setTermMajors(Array.isArray(rows.termMajorPairs) ? rows.termMajorPairs : []);
        } else {
          setPredictions([]);
          setErrorMessage(EMPTY_MESSAGE);
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('[ML Engine] Batch recommendation failed:', err.message);
        setPredictions([]);
        setErrorMessage(err.response?.data?.message || OFFLINE_MESSAGE);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadInitialRecommendations();
    return () => {
      isMounted = false;
      mountedRef.current = false;
    };
  }, [termParams, activeSemesterNumber]);

  // Never leave a toast timer running after unmount.
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived table state
  // ---------------------------------------------------------------------------
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const unplacedCount = predictions.filter(p => !p.section).length;
  const namesProfessor = (p, id) => p.lockedFacultyId === id || p.candidates.some(c => c.id === id);
  const visiblePredictions = predictions.filter(p =>
    (showAll || Boolean(p.section))
    && (!sectionFilter || p.section === sectionFilter)
    && (!professorFilter || namesProfessor(p, professorFilter))
    && (!normalizedSearch
      || p.subjectCode.toLowerCase().includes(normalizedSearch)
      || p.subjectTitle.toLowerCase().includes(normalizedSearch)
      || (p.section || '').toLowerCase().includes(normalizedSearch)));
  const { pageItems, currentPage, totalPages, setPage, resetPage, rangeLabel } = usePagination(visiblePredictions, PAGE_SIZE);
  const sectionOptions = [...new Set(predictions.map(p => p.section).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const professorOptions = [...new Map(predictions.flatMap(p => [
    ...p.candidates.filter(c => c.id && !TBA_CANDIDATE_IDS.includes(c.id)).map(c => [c.id, c.name]),
    ...(p.lockedFacultyId && !TBA_CANDIDATE_IDS.includes(p.lockedFacultyId) ? [[p.lockedFacultyId, p.lockedFaculty]] : [])
  ])).entries()].map(([id, name]) => ({ id, name: name || id })).sort((a, b) => a.name.localeCompare(b.name));
  const anyFilter = Boolean(sectionFilter || professorFilter || normalizedSearch);
  const clearFilters = () => { setSectionFilter(''); setProfessorFilter(''); setSearchQuery(''); resetPage(); };

  // "Major classes assigned", per (subject, section) pair as on the Term Checklist and the readiness
  // check (numbers.assignment): a pair counts when its professor is an active professor (a lock to the
  // TBA pool, or to someone no longer active, does not). facultyInfo lists every active professor.
  const placedRows = predictions.filter(p => p.section);
  const knowsFaculty = Object.keys(facultyInfo).length > 0;
  // Phase 4 Part 4: over EVERY Major class of the term (the ranked rows alone when the term pairs are not known yet).
  const majorPairs = termMajors.length ? termMajors : placedRows;
  const assignedCount = majorPairs.filter(p => p.lockedFacultyId && !TBA_CANDIDATE_IDS.includes(p.lockedFacultyId)
    && (!knowsFaculty || Boolean(facultyInfo[p.lockedFacultyId]))).length;

  // The header checkbox selects the rows on this page.
  const visibleKeys = pageItems.map(rowKey);
  const selectedVisibleCount = visibleKeys.filter(k => selectedKeys.has(k)).length;
  const allVisibleSelected = visibleKeys.length > 0 && selectedVisibleCount === visibleKeys.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectedRows = predictions.filter(p => selectedKeys.has(rowKey(p)));
  // Refreshing reseeds the loads from the server, which must never happen while a lock write is
  // still queued (the server total would not include it yet).
  const hasPendingLocks = pendingLockKeys.size > 0;
  const isBusy = isLoading || isRefreshing || isRerunning || hasPendingLocks;
  // Assignments pause while a refresh or re-run is reading (see syncingRef).
  const isSyncing = isRefreshing || isRerunning;
  // The ranking can take minutes: the loading line and the busy buttons show the seconds so far.
  const elapsed = useElapsedSeconds(isLoading || isRefreshing || isRerunning);

  // Native tri-state checkbox needs the DOM property set imperatively.
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  // ---------------------------------------------------------------------------
  // Selection handlers
  // ---------------------------------------------------------------------------
  const toggleRow = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleKeys.forEach(k => next.delete(k));
      } else {
        visibleKeys.forEach(k => next.add(k));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedKeys(new Set());

  // ---------------------------------------------------------------------------
  // Batch endpoint handlers
  // ---------------------------------------------------------------------------
  const handleRefreshAll = async () => {
    syncingRef.current = true;
    setIsRefreshing(true);
    setErrorMessage('');

    try {
      await waitForLockWrites();
      const { rows: fresh, loads, info } = await fetchRankingData(termParams, activeSemesterNumber);
      seedFacultyInfo(info);
      seedLoads(loads);
      if (fresh.length) {
        setPredictions(fresh);
        // Drop selections for rows that no longer exist after a full refresh.
        const freshKeys = new Set(fresh.map(rowKey));
        setSelectedKeys(prev => new Set([...prev].filter(k => freshKeys.has(k))));
        showToast('The recommendations are up to date.', { duration: 3000 });
      } else {
        setPredictions([]);
        setErrorMessage(EMPTY_MESSAGE);
      }
    } catch (err) {
      console.warn('[ML Engine] Batch recommendation refresh failed:', err.message);
      setPredictions([]);
      setErrorMessage(err.response?.data?.message || OFFLINE_MESSAGE);
    } finally {
      syncingRef.current = false;
      setIsRefreshing(false);
    }
  };

  /**
   * Re-runs the batch recommendation endpoint for a specific set of rows and merges the returned
   * predictions back into only those rows. Rows outside the target set are never touched.
   */
  const rerunRows = async (targetRows) => {
    if (!targetRows.length || isRerunning) return;

    const targetKeys = new Set(targetRows.map(rowKey));
    const subjectCodes = [...new Set(targetRows.map(r => r.subjectCode))];

    syncingRef.current = true;
    setIsRerunning(true);
    setRerunningKeys(targetKeys);

    try {
      await waitForLockWrites();
      const res = await api.post(BATCH_ENDPOINT, { ...termParams, subjectCodes }, { timeout: RANKING_TIMEOUT_MS });
      const rawPredictions = res.data?.predictions || [];
      // Matched on the catalog subject, not the code, so subjects sharing a code stay apart. An
      // older gateway without subjectId falls back to the code.
      const freshById = new Map(rawPredictions.filter(p => p.subjectId).map(p => [String(p.subjectId), p]));
      const freshByCode = new Map(rawPredictions.map(p => [p.subjectCode, p]));
      const freshFor = (row) => freshById.get(row.subjectId) || (freshById.size ? null : freshByCode.get(row.subjectCode));
      const updatedCount = targetRows.filter(r => freshFor(r)).length;

      // The fresh response carries the server-side load of every professor in a fresh top 3; the
      // others keep their current value, since the rows outside the re-run still show them.
      seedFacultyInfo({ ...facultyInfoRef.current, ...facultyInfoFromResponse(res.data) });
      seedLoads({ ...loadsRef.current, ...loadsFromResponse(res.data) });
      setPredictions(prev => prev.map(p => {
        if (!targetKeys.has(rowKey(p))) return p;
        const match = freshFor(p);
        if (!match) return p;
        return {
          ...p,
          candidates: Array.isArray(match.candidates) ? match.candidates : [],
          rerunCount: (p.rerunCount || 0) + 1
        };
      }));

      if (updatedCount === 0) {
        showToast('Ranked again, but nothing new came back for the selected subjects.');
      } else if (updatedCount < targetRows.length) {
        showToast(`Ranked again: ${updatedCount} of ${targetRows.length} selected classes. The rest got no new ranking.`);
      } else {
        showToast(`Ranked again: ${updatedCount} class${updatedCount === 1 ? '' : 'es'}.`);
      }
    } catch (err) {
      console.warn('[ML Engine] Selected re-run failed:', err.message);
      showToast(err.response?.data?.message || 'Ranking again failed: the ranking service did not answer. Try again in a minute.', { tone: 'error' });
    } finally {
      syncingRef.current = false;
      setIsRerunning(false);
      setRerunningKeys(new Set());
    }
  };

  const handleRerunSelected = () => rerunRows(selectedRows);
  const handleRerunRow = (prediction) => rerunRows([prediction]);

  // ---------------------------------------------------------------------------
  // Review / override modal
  // ---------------------------------------------------------------------------
  const openReviewModal = (prediction, candidateId) => {
    modalTriggerRef.current = document.activeElement;
    setActivePrediction(prediction);
    setOverrideSelection(candidateId || prediction.candidates[0]?.id || '');
    setOverrideReason('');
    setIsReviewModalOpen(true);
  };

  // Every way out of the dialog lands here and hands focus back to the control that opened it.
  const closeReviewModal = () => {
    setIsReviewModalOpen(false);
    const trigger = modalTriggerRef.current;
    modalTriggerRef.current = null;
    if (trigger && document.contains(trigger)) requestAnimationFrame(() => trigger.focus());
  };

  useEscapeKey(isReviewModalOpen, closeReviewModal);

  // The dialog reads the live row, so a lock that settles while it is open shows at once.
  const activeRow = activePrediction
    ? predictions.find(p => p.key === activePrediction.key) || activePrediction
    : null;
  const isOverrideActive = Boolean(activeRow) && overrideSelection !== activeRow.candidates[0]?.id;
  // Phase 8 (the defense path): the Dean may assign ANY active professor, not only the ranked ones —
  // where the ranking is weak (nobody taught the subject) her own choice can be outside the top
  // three, saved as an override with her reason. The rest of the roster comes from the batch
  // answer's facultyLoads (every active professor), each under the same Overload Guardian check.
  const rankedIds = new Set((activeRow?.candidates || []).map(c => c.id));
  const otherProfessors = activeRow
    ? Object.entries(facultyInfo)
      .filter(([id, f]) => f?.name && !rankedIds.has(id) && !TBA_CANDIDATE_IDS.includes(id))
      .map(([id, f]) => ({ id, name: f.name, score: null, maxWeeklyHours: f.cap, minTeachingHours: f.min, rank: null }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const currentSelectedCandidate = activeRow?.candidates?.find(c => c.id === overrideSelection)
    || otherProfessors.find(c => c.id === overrideSelection);
  // The Guardian verdict with the current policy and faculty info bound in.
  const assess = (row, candidate, loads) => assessAssignment(row, candidate, loads, facultyInfo, policy);
  const activeVerdict = activeRow && currentSelectedCandidate
    ? assess(activeRow, currentSelectedCandidate, optimisticLoads)
    : null;
  const isActiveRowPending = Boolean(activeRow) && pendingLockKeys.has(lockKeyOf(activeRow));

  // ---------------------------------------------------------------------------
  // Real-Time Overload Guardian: optimistic assignment and undo
  // ---------------------------------------------------------------------------
  // Adds signed hours per facultyId. Deltas stay exact (loads are half-hour multiples), so a
  // rollback applies the negated delta and lands on the original value.
  const applyLoadDelta = (delta) => {
    const next = { ...loadsRef.current };
    Object.entries(delta).forEach(([facultyId, hours]) => {
      if (typeof next[facultyId] === 'number') next[facultyId] += hours;
    });
    loadsRef.current = next;
    setOptimisticLoads(next);
  };
  const negate = (delta) => Object.fromEntries(Object.entries(delta).map(([id, hours]) => [id, -hours]));

  const setRowLock = (lockKey, facultyId, facultyName) => {
    setPredictions(prev => prev.map(row => (
      lockKeyOf(row) === lockKey ? { ...row, lockedFacultyId: facultyId || null, lockedFaculty: facultyName || null } : row
    )));
  };

  const setLockPending = (lockKey, isPending) => {
    if (isPending) pendingLockRef.current.add(lockKey);
    else pendingLockRef.current.delete(lockKey);
    setPendingLockKeys(new Set(pendingLockRef.current));
  };

  // Approve / assign one row. The Guardian re-checks capacity here (a disabled button is not the
  // only gate), then the load bar and the lock badge move at once. The lock is written through the
  // queue together with the Engine 4 decision (the gateway logs it as the decision's single row,
  // from telemetry read before the lock applies); a failed lock rolls the optimistic change back.
  // Returns true when the assignment was accepted for saving.
  const assignCandidate = (row, candidate, { decision = 'accept', reason } = {}) => {
    const lockKey = lockKeyOf(row);
    if (!assign.allowed || !candidate || syncingRef.current || pendingLockRef.current.has(lockKey)) return false;

    const verdict = assess(row, candidate, loadsRef.current);
    if (verdict.status === 'assigned') return false;
    if (verdict.blocked) {
      showToast(`${candidate.name}: ${verdict.reason}`, { tone: 'error' });
      return false;
    }

    // Reassigning a locked row also frees the previous holder's hours (weighed for them: a
    // part-timer's lab hours count less than a full-timer's).
    const previous = { id: row.lockedFacultyId, name: row.lockedFaculty };
    const delta = { [candidate.id]: verdict.addHours };
    if (previous.id) delta[previous.id] = (delta[previous.id] || 0) - (hoursFor(row, previous.id, facultyInfoRef.current, policy) ?? 0);

    applyLoadDelta(delta);
    setRowLock(lockKey, candidate.id, candidate.name);
    setLockPending(lockKey, true);

    const isOverride = decision === 'override';
    const top1Candidate = row.candidates[0];
    const label = `${row.subjectCode} (${row.section})`;
    // Only the semantic scores are client-known; eval score, prep count and ancillary hours are
    // read server-side from the faculty records and the draft.
    const selectedSemanticScore = Number.isFinite(Number(candidate.score)) ? Number((candidate.score / 100).toFixed(4)) : null;
    const rejectedSemanticScore = isOverride && Number.isFinite(Number(top1Candidate?.score)) ? Number((top1Candidate.score / 100).toFixed(4)) : null;

    enqueueLockWrite(async () => {
      try {
        await api.post('/schedule/lock', {
          ...termParams,
          subjectId: row.subjectId,
          subjectCode: row.subjectCode,
          sectionCode: row.section,
          facultyId: candidate.id,
          facultyName: candidate.name,
          // One lock covers lecture and laboratory, which is how the GA applies it.
          classType: 'ALL',
          // Contact hours of the pair, for the record; the gateway weighs the load itself.
          units: row.contactHours,
          decision: isOverride ? 'override' : 'accept',
          originalFacultyId: top1Candidate?.id,
          mlTop1Faculty: top1Candidate?.name,
          mlTop1Score: top1Candidate?.score ?? null,
          // An accept sends no reason: the gateway records "Accepted the top recommendation".
          reason: isOverride ? String(reason || '').trim() : undefined,
          telemetry: { selectedSemanticScore, rejectedSemanticScore }
        });
        showToast(isOverride
          ? `${candidate.name} is assigned to ${label}; your reason is saved with the decision.`
          : `${candidate.name} is assigned to ${label}.`);
      } catch (err) {
        applyLoadDelta(negate(delta));
        setRowLock(lockKey, previous.id, previous.name);
        const message = err.response?.data?.message || 'the lock could not be saved, so nothing was assigned.';
        if (mountedRef.current) showToast(`${label}: ${message}`, { tone: 'error', duration: 6000 });
        else reportLostLockWrite(label, message);
      } finally {
        setLockPending(lockKey, false);
      }
    });
    return true;
  };

  // Releases a row's lock and gives the hours back to its holder, with the same optimistic flow. The
  // gateway also takes back the decision it logged for that lock.
  const undoAssignment = (row) => {
    const lockKey = lockKeyOf(row);
    if (!assign.allowed || !row.section || !row.lockedFacultyId || syncingRef.current || pendingLockRef.current.has(lockKey)) return;

    const previous = { id: row.lockedFacultyId, name: row.lockedFaculty };
    const delta = { [previous.id]: -(hoursFor(row, previous.id, facultyInfoRef.current, policy) ?? 0) };

    applyLoadDelta(delta);
    setRowLock(lockKey, null, null);
    setLockPending(lockKey, true);
    // The Undo button hides itself once the row is open again; keep keyboard focus in the row.
    reviewButtonRefs.current.get(row.key)?.focus();

    const label = `${row.subjectCode} (${row.section})`;
    enqueueLockWrite(async () => {
      try {
        await api.delete('/schedule/lock', {
          data: { ...termParams, subjectId: row.subjectId, subjectCode: row.subjectCode, sectionCode: row.section }
        });
        showToast(`Assignment released: ${label} is open again (${formatHours(-delta[previous.id])} teaching h returned to ${previous.name}).`);
      } catch (err) {
        applyLoadDelta(negate(delta));
        setRowLock(lockKey, previous.id, previous.name);
        const message = err.response?.data?.message || 'the lock could not be released.';
        if (mountedRef.current) showToast(`${label}: ${message}`, { tone: 'error', duration: 6000 });
        else reportLostLockWrite(label, message);
      } finally {
        setLockPending(lockKey, false);
      }
    });
  };

  const handleConfirmAssignment = () => {
    if (!activeRow || !currentSelectedCandidate) return;
    const accepted = assignCandidate(activeRow, currentSelectedCandidate, {
      decision: isOverrideActive ? 'override' : 'accept',
      reason: overrideReason
    });
    if (accepted) closeReviewModal();
  };

  // ---------------------------------------------------------------------------
  // Shared UI fragments
  // ---------------------------------------------------------------------------
  const rerunSelectedButton = (extraClass = '') => (
    <button
      type="button"
      onClick={handleRerunSelected}
      disabled={isBusy || selectedRows.length === 0}
      className={`inline-flex items-center px-4 py-2 rounded-xl text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-700 transition-colors shadow-md shadow-cyan-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${extraClass}`}
    >
      {isRerunning ? <Loader2 size={14} className="animate-spin mr-2" /> : <PlayCircle size={14} className="mr-2" />}
      {isRerunning ? `Ranking again… ${formatElapsed(elapsed)}` : `Re-run Selected${selectedRows.length ? ` (${selectedRows.length})` : ''}`}
    </button>
  );

  const refreshAllButton = (
    <button
      type="button"
      data-testid="ranking-refresh"
      onClick={handleRefreshAll}
      disabled={isBusy}
      className="inline-flex items-center justify-center text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-white bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-3.5 py-2 rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      <RefreshCw size={14} className={`mr-1.5 ${isRefreshing ? 'animate-spin text-cyan-500' : ''}`} aria-hidden="true" />
      {isRefreshing ? `Refreshing… ${formatElapsed(elapsed)}` : 'Refresh All Recommendations'}
    </button>
  );

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className={embedded ? 'flex flex-col' : 'bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col'}>

        {!embedded && (
          <>
            {/* HEADER */}
            <div className="p-6 md:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/50 dark:bg-white/5">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-cyan-500/10 rounded-xl border border-cyan-500/20">
                  <BrainCircuit className="text-cyan-600 dark:text-cyan-400" size={28} />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-wide">Recommendations</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    The three best-matched professors for each Major class, with each one's teaching load.
                  </p>
                </div>
              </div>
              {refreshAllButton}
            </div>

            <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>
          </>
        )}

        {!assign.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={ASSIGN_NOTE_ID} permission={assign} lead="You can view the recommendations, the assignments and the teaching loads." />
          </div>
        )}

        {/* BATCH TOOLBAR */}
        {!isLoading && !errorMessage && (
          <div data-testid="ranking-toolbar" className="px-6 md:px-8 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-white dark:bg-[#18181b] flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="ranking-filter-section" className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1 uppercase tracking-wider">Section</label>
                <Select id="ranking-filter-section" data-testid="ranking-filter-section" value={sectionFilter} onChange={(e) => { setSectionFilter(e.target.value); resetPage(); }} className="bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                  <option value="">All sections</option>
                  {sectionOptions.map(code => <option key={code} value={code}>{code}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor="ranking-filter-professor" className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1 uppercase tracking-wider">Professor</label>
                <Select id="ranking-filter-professor" data-testid="ranking-filter-professor" value={professorFilter} onChange={(e) => { setProfessorFilter(e.target.value); resetPage(); }} className="max-w-56 bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                  <option value="">All professors</option>
                  {professorOptions.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </div>
              <div className="sm:w-64">
                <label htmlFor="ranking-search" className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1 uppercase tracking-wider">Search</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} aria-hidden="true" />
                  <input
                    id="ranking-search"
                    data-testid="ranking-search"
                    type="search"
                    placeholder="Code, title or section…"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); resetPage(); }}
                    className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500 transition-colors text-slate-900 dark:text-white"
                  />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 pb-2 text-xs font-bold text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="ranking-show-all"
                  checked={showAll}
                  onChange={(e) => { setShowAll(e.target.checked); resetPage(); }}
                  className="w-4 h-4 accent-cyan-600 cursor-pointer"
                />
                Show all{unplacedCount ? ` (${unplacedCount} subject${unplacedCount === 1 ? '' : 's'} with no active section)` : ''}
              </label>
              {anyFilter && (
                <button type="button" data-testid="ranking-clear-filters" onClick={clearFilters} className="mb-0.5 px-3 py-2 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                  Clear the filters
                </button>
              )}
            </div>
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <p data-testid="ranking-assigned-count" className="text-xs font-bold text-slate-700 dark:text-slate-300">
                Major classes assigned: <span className="text-slate-900 dark:text-white">{assignedCount}</span> of {majorPairs.length}
              </p>
              <div className="inline-flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400">
                <ListChecks size={14} className="text-cyan-600" aria-hidden="true" />
                <span>
                  <span className="text-slate-900 dark:text-white">{selectedRows.length}</span> of {predictions.length} selected
                </span>
                {selectedRows.length > 0 && (
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={isRerunning}
                    className="text-[11px] font-bold text-slate-600 dark:text-slate-400 hover:text-red-600 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    Clear
                  </button>
                )}
              </div>
              {/* Legend for the Overload Guardian's workload bars. */}
              <div className="inline-flex items-center gap-3 text-[11px] text-slate-600 dark:text-slate-400">
                <span className="font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">Load vs cap</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-600" />&lt; 80%</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />80–99%</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />≥ 100%</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {embedded && refreshAllButton}
              {rerunSelectedButton()}
            </div>
            </div>
            {/* Phase 6 (the audit's N4): what the percentage under each professor measures. */}
            <HelpTip label="Likelihood" testid="ranking-likelihood-tip"><span data-testid="ranking-likelihood-help">{LIKELIHOOD_HELP}</span></HelpTip>
          </div>
        )}

        {/* DATA GRID */}
        <div className="overflow-x-auto relative">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-cyan-500" aria-hidden="true" />
              <p data-testid="ranking-loading" role="status" className="text-xs font-bold uppercase tracking-wider tabular-nums">Ranking professors… {formatElapsed(elapsed)}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">Ranking every Major class of the term can take up to 3 minutes.</p>
            </div>
          ) : errorMessage ? (
            <div role="alert" className="p-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-center max-w-xl mx-auto my-8">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-red-700 dark:text-red-400 mb-1">Recommendations not available</h3>
              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={handleRefreshAll}
                disabled={isRefreshing}
                className="px-4 py-2 bg-cyan-600 text-white rounded-xl text-xs font-bold hover:bg-cyan-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                {isRefreshing ? `Trying again… ${formatElapsed(elapsed)}` : 'Try again'}
              </button>
            </div>
          ) : (
            // Phase 6 (the audit's N5): fixed column widths, so the three ranks and the actions fit the card at
            // 1280 px (Rank 3 was behind the pinned actions); a narrower window still scrolls the table sideways.
            <table className="w-full min-w-[840px] table-fixed text-left text-sm">
              <colgroup>
                <col className="w-12" />
                <col className="w-46" />
                <col />
                <col />
                <col />
                <col className="w-28" />
              </colgroup>
              <thead className="bg-white dark:bg-[#18181b] border-b border-slate-200 dark:border-slate-800/60 text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="pl-6 pr-2 py-4 text-center">
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      aria-label="Select all rows on this page"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      disabled={isBusy || visibleKeys.length === 0}
                      className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer disabled:cursor-not-allowed accent-cyan-600"
                    />
                  </th>
                  {/* The class: code, section and assignment, with the title and hours under it (fixed width:
                      the Assigned badge appearing on Approve or Undo must not push the candidates sideways). */}
                  <th className="px-4 py-4 font-bold tracking-wider uppercase text-xs">Class</th>
                  <th className="px-3 py-4 font-bold tracking-wider uppercase text-xs text-cyan-700 dark:text-cyan-400">Rank 1 (best match)</th>
                  <th className="px-3 py-4 font-bold tracking-wider uppercase text-xs">Rank 2</th>
                  <th className="px-3 py-4 font-bold tracking-wider uppercase text-xs">Rank 3</th>
                  <th className={`px-3 py-4 font-bold tracking-wider uppercase text-xs text-right bg-white dark:bg-[#18181b] ${STICKY_CELL}`}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {visiblePredictions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-12 text-center text-slate-600 dark:text-slate-400">
                      <BrainCircuit size={32} className="mx-auto mb-2 opacity-30 text-cyan-500" />
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                        {anyFilter ? 'No classes match the filters' : 'No recommendations yet'}
                      </p>
                      <p className="text-xs mt-1">
                        {anyFilter ? 'Change or clear the filters.' : (unplacedCount && !showAll ? 'Tick "Show all" to see the subjects with no active section, or press Refresh All Recommendations.' : 'Press Refresh All Recommendations to rank the professors again.')}
                      </p>
                    </td>
                  </tr>
                ) : (
                  pageItems.map((prediction) => {
                    const key = rowKey(prediction);
                    const isSelected = selectedKeys.has(key);
                    const isRowRerunning = rerunningKeys.has(key);
                    const rank1 = getCandidateAtRank(prediction.candidates, 1);
                    const rank2 = getCandidateAtRank(prediction.candidates, 2);
                    const rank3 = getCandidateAtRank(prediction.candidates, 3);
                    const isRowPending = pendingLockKeys.has(lockKeyOf(prediction));
                    const canUndo = Boolean(prediction.section && prediction.lockedFacultyId);
                    // Section codes contain spaces, which an id (and aria-describedby) cannot.
                    const domId = key.replace(/[^A-Za-z0-9_-]/g, '-');
                    const renderCandidate = (candidate, rank) => (
                      <CandidateCell
                        candidate={candidate}
                        isTopPick={rank === 1}
                        verdict={candidate ? assess(prediction, candidate, optimisticLoads) : null}
                        isPending={isRowPending}
                        isDisabled={isRowPending || isSyncing}
                        rowLabel={rowLabelOf(prediction)}
                        statusId={`guardian-${domId}-${rank}`}
                        blockedReason={assign.reason}
                        blockedNoteId={ASSIGN_NOTE_ID}
                        onAssign={() => (rank === 1
                          ? assignCandidate(prediction, candidate)
                          : openReviewModal(prediction, candidate.id))}
                      />
                    );

                    // Phase 6 (decision 6): a class nobody on the current faculty has taught before gets one line
                    // above its ranking; the checkbox, the class and the actions then span both rows.
                    const weak = prediction.nobodyTaughtBefore === true;
                    const span = weak ? 2 : undefined;
                    const rowClass = `transition-colors text-slate-700 dark:text-slate-300 ${
                      isSelected ? 'bg-cyan-50/60 dark:bg-cyan-500/5' : 'hover:bg-slate-50 dark:hover:bg-white/5'
                    } ${isRowRerunning ? 'opacity-60' : ''}`;
                    const selectCell = (
                      <td rowSpan={span} className="pl-6 pr-2 py-3.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={`Select ${prediction.subjectCode}${prediction.section ? ` ${prediction.section}` : ''}`}
                          checked={isSelected}
                          onChange={() => toggleRow(key)}
                          disabled={isRerunning}
                          className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-cyan-600 focus:ring-cyan-500 cursor-pointer disabled:cursor-not-allowed accent-cyan-600 mt-0.5"
                        />
                      </td>
                    );
                    const classCell = (
                      <td rowSpan={span} className="px-4 py-3.5 align-top">
                        <p className="font-black text-slate-900 dark:text-white text-sm">{prediction.subjectCode}</p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {prediction.section ? (
                            <span className="text-[10px] font-bold bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300 px-2 py-0.5 rounded-md border border-cyan-200 dark:border-cyan-500/30">
                              {prediction.section}
                            </span>
                          ) : (
                            <span
                              className="text-[10px] font-bold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700"
                              title="No active section matches this subject's year level, program and track."
                            >
                              No active section
                            </span>
                          )}
                          {/* Phase 6 (the audit's N3): the whole name, wrapping inside the column, never cut. */}
                          {prediction.lockedFaculty && (
                            <span data-testid={`ranking-holder-${domId}`} className="inline-flex items-start max-w-full text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-500/30">
                              <ShieldCheck size={11} className="mr-1 mt-px shrink-0" aria-hidden="true" />
                              <span className="min-w-0 wrap-break-word">Assigned: {prediction.lockedFaculty}</span>
                            </span>
                          )}
                          {prediction.rerunCount > 0 && (
                            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400" title="Times this subject was ranked again in this visit">
                              Ranked again ×{prediction.rerunCount}
                            </span>
                          )}
                        </div>
                        {/* Secondary details under the code (Phase 3 Step 8): the title wraps. */}
                        <p className="font-medium text-slate-700 dark:text-slate-300 leading-snug mt-1.5 text-xs">
                          {prediction.subjectTitle}
                        </p>
                        <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 tabular-nums">
                          {formatHours(prediction.contactHours)} contact hrs / week
                        </p>
                      </td>
                    );
                    const rankCells = [rank1, rank2, rank3].map((candidate, i) => (
                      <td key={`rank-${i + 1}`} className={`px-3 ${weak ? 'pt-2' : 'pt-3.5'} pb-3.5 align-top`}>
                        {renderCandidate(candidate, i + 1)}
                      </td>
                    ));
                    // The actions stay in view when a narrow window scrolls the table sideways; stacked
                    // (Phase 6, N5) so the column stays narrow.
                    const actionsCell = (
                      <td rowSpan={span} className={`px-3 py-3.5 text-right align-top bg-white dark:bg-[#18181b] ${STICKY_CELL}`}>
                        <div className="inline-flex flex-col items-end gap-1.5">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRerunRow(prediction)}
                              disabled={isBusy}
                              title="Rank this subject again"
                              aria-label={`Rank ${prediction.subjectCode} again`}
                              className="p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <RefreshCw size={15} className={isRowRerunning ? 'animate-spin text-cyan-500' : ''} />
                            </button>
                            {/* Always rendered (hidden when there is nothing to release) so the action
                                buttons keep their positions from row to row. */}
                            <button
                              type="button"
                              data-testid={`ranking-undo-${domId}`}
                              onClick={() => undoAssignment(prediction)}
                              disabled={!canUndo || isRowPending || isSyncing || !assign.allowed}
                              title={canUndo ? (assign.allowed ? `Release ${prediction.lockedFaculty} from this section` : assign.reason) : undefined}
                              aria-describedby={canUndo && !assign.allowed ? ASSIGN_NOTE_ID : undefined}
                              aria-label={`Undo assignment for ${prediction.subjectCode} ${prediction.section || ''}`.trim()}
                              className={`p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${canUndo ? '' : 'invisible'}`}
                            >
                              <Undo2 size={15} />
                            </button>
                          </div>
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) reviewButtonRefs.current.set(prediction.key, el);
                              else reviewButtonRefs.current.delete(prediction.key);
                            }}
                            onClick={() => openReviewModal(prediction)}
                            disabled={isSyncing || prediction.candidates.length === 0}
                            className="inline-flex items-center bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <BarChart size={13} className="mr-1.5" /> Review
                          </button>
                        </div>
                      </td>
                    );

                    if (!weak) {
                      return (
                        <tr key={key} className={rowClass}>
                          {selectCell}{classCell}{rankCells}{actionsCell}
                        </tr>
                      );
                    }
                    return (
                      <Fragment key={key}>
                        <tr className={`${rowClass} border-b-0`}>
                          {selectCell}{classCell}
                          <td colSpan={3} className="px-3 pt-3.5 pb-0 align-top">
                            <p data-testid={`ranking-weak-${domId}`} role="note" className="flex items-start gap-1.5 text-[11px] font-bold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg px-2.5 py-1.5">
                              <Info size={13} className="shrink-0 mt-px" aria-hidden="true" />
                              <span>{WEAK_RANKING_NOTE}</span>
                            </p>
                          </td>
                          {actionsCell}
                        </tr>
                        <tr className={rowClass}>
                          {rankCells}
                        </tr>
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* FOOTER */}
        {!isLoading && !errorMessage && (
          <div className="bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800/60 px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p data-testid="ranking-showing" className="text-xs text-slate-600 dark:text-slate-400">
              Showing <span className="font-bold text-slate-700 dark:text-slate-300">{rangeLabel}</span> of {visiblePredictions.length} class{visiblePredictions.length === 1 ? '' : 'es'}
              <span className="mx-1.5">·</span>
              <span className="font-bold text-slate-700 dark:text-slate-300">{selectedRows.length}</span> selected to rank again
            </p>
            <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Recommendation pages" showSync={false} />
            {rerunSelectedButton()}
          </div>
        )}
      </div>

      {/* CONFIRMATION / OVERRIDE MODAL */}
      {isReviewModalOpen && activeRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="candidate-review-title" className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-center">
              <div>
                <h3 id="candidate-review-title" className="text-lg font-black text-slate-800 dark:text-white tracking-wide">Assign a professor</h3>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Class: {activeRow.subjectCode}{activeRow.section ? ` (${activeRow.section})` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={closeReviewModal}
                aria-label="Close"
                className="text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 p-1 rounded-lg cursor-pointer"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-cyan-50 dark:bg-cyan-500/5 border border-cyan-200 dark:border-cyan-500/20 p-3.5 rounded-xl flex items-start">
                <Info size={16} className="text-cyan-600 dark:text-cyan-400 mt-0.5 mr-2.5 shrink-0" />
                <p className="text-xs text-cyan-900 dark:text-cyan-300 leading-relaxed">
                  <strong>{activeRow.candidates[0]?.name}</strong> is the best match. Confirming assigns the chosen professor to this class, lecture and laboratory alike, and the schedule generator keeps that choice. If you choose someone else, write why: your reason is saved with the decision, and the ranking learns from it when it is retrained.
                </p>
              </div>

              {/* Phase 6 (decision 6): the line above the ranking of a class nobody on the current faculty has taught. */}
              {activeRow.nobodyTaughtBefore && (
                <p data-testid="review-weak-ranking" role="note" className="flex items-start gap-1.5 text-xs font-bold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-3 py-2">
                  <Info size={14} className="shrink-0 mt-px" aria-hidden="true" />
                  <span>{WEAK_RANKING_NOTE}</span>
                </p>
              )}

              {/* Ranked reasoning summary so the Dean can compare without leaving the modal */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {[1, 2, 3].map(rank => {
                  const cand = getCandidateAtRank(activeRow.candidates, rank);
                  return (
                    <div key={rank} className={`p-3 rounded-xl border text-left ${rank === 1 ? 'border-cyan-300 dark:border-cyan-500/40 bg-cyan-50/40 dark:bg-cyan-500/5' : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#1a1a1c]'}`}>
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1">Rank {rank}</p>
                      {cand ? (
                        <>
                          <p className="text-xs font-bold text-slate-800 dark:text-white truncate" title={cand.name}>{cand.name}</p>
                          <p data-testid={`review-likelihood-${rank}`} className={`text-xs font-black ${rank === 1 ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-500'}`}>{likelihoodText(cand.score, cand.id)}</p>
                          <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug mt-1 line-clamp-3 whitespace-normal" title={cand.reason}>
                            {cand.reason || 'No reasoning returned.'}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-slate-600 dark:text-slate-400 italic">No candidate</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {currentSelectedCandidate?.dataQualityFlag === false && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2">
                  <AlertTriangle size={15} className="shrink-0 text-amber-500" />
                  <span><strong>Note:</strong> this professor's profile has no specialization recorded, so this match is less certain.</span>
                </div>
              )}

              <div className="space-y-3">
                <label htmlFor="ranking-professor" className="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">
                  Professor to assign
                </label>

                <Select
                  id="ranking-professor"
                  data-testid="ranking-professor"
                  autoFocus
                  value={overrideSelection}
                  onChange={(e) => setOverrideSelection(e.target.value)}
                  disabled={isActiveRowPending}
                  className="w-full bg-slate-50 dark:bg-[#1a1a1c] border border-slate-300 dark:border-slate-700 rounded-xl py-2.5 px-3.5 text-sm focus:outline-none focus:border-cyan-500 text-slate-900 dark:text-white font-bold"
                >
                  <optgroup label="Recommended by the ranking">
                    {activeRow.candidates.map(cand => {
                      // The Guardian applies here too: an instructor this section would overload cannot be picked.
                      const verdict = assess(activeRow, cand, optimisticLoads);
                      const guardianNote = verdict.status === 'exceeded'
                        ? ` — Over the cap (${formatHours(verdict.projected)} / ${formatHours(verdict.cap)} h)`
                        : verdict.status === 'assigned' ? ' — Currently assigned' : verdict.blocked ? ` — ${verdict.message}` : '';
                      return (
                        <option key={cand.id} value={cand.id} disabled={verdict.blocked}>
                          {cand.rank === 1 ? 'Rank 1 (best match)' : `Rank ${cand.rank} (another choice)`}: {cand.name} ({likelihoodText(cand.score, cand.id)}){cand.dataQualityFlag === false ? ' [Incomplete Profile]' : ''}{guardianNote}
                        </option>
                      );
                    })}
                  </optgroup>
                  {/* Phase 8: the Dean's own choice may be outside the ranking (the defense path's
                      ITEP 205 → Mr. Faculty). Same Guardian check; choosing one asks for the reason. */}
                  {otherProfessors.length > 0 && (
                    <optgroup label="Every other active professor">
                      {otherProfessors.map(cand => {
                        const verdict = assess(activeRow, cand, optimisticLoads);
                        const guardianNote = verdict.status === 'exceeded'
                          ? ` — Over the cap (${formatHours(verdict.projected)} / ${formatHours(verdict.cap)} h)`
                          : verdict.status === 'assigned' ? ' — Currently assigned' : verdict.blocked ? ` — ${verdict.message}` : '';
                        return (
                          <option key={cand.id} value={cand.id} disabled={verdict.blocked}>
                            {cand.name}{guardianNote}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                </Select>

                {currentSelectedCandidate && activeVerdict && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#1a1a1c] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 truncate">
                        Weekly workload · {currentSelectedCandidate.name}
                      </span>
                      <span className="text-[11px] text-slate-600 dark:text-slate-400 shrink-0 tabular-nums">
                        This section: {formatHours(activeRow.contactHours)} h
                      </span>
                    </div>
                    <WorkloadMeter load={activeVerdict.load} cap={activeVerdict.cap} min={activeVerdict.min} addHours={activeVerdict.addHours} label={`${currentSelectedCandidate.name} weekly workload`} />
                    {activeVerdict.blocked && (
                      <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-bold text-red-600 dark:text-red-400 whitespace-normal">
                        <AlertTriangle size={14} className="shrink-0 mt-px" />
                        <span>{activeVerdict.message}: {activeVerdict.reason}</span>
                      </p>
                    )}
                    {activeVerdict.status === 'assigned' && (
                      <p className="mt-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">Already assigned to this section.</p>
                    )}
                  </div>
                )}

                {isOverrideActive && (
                  <div className="space-y-1.5 pt-2 animate-in fade-in duration-200">
                    <label htmlFor="ranking-reason" className="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider flex items-center">
                      <MessageSquareQuote size={14} className="mr-1.5" />
                      Why another professor? (required) *
                    </label>
                    <textarea
                      id="ranking-reason"
                      data-testid="ranking-reason"
                      required
                      aria-describedby="ranking-reason-hint"
                      rows={3}
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      disabled={isActiveRowPending || !assign.allowed}
                      placeholder="For example: balancing the teaching loads, or lab experience in this subject"
                      className="w-full bg-slate-50 dark:bg-[#121212] border border-orange-300 dark:border-orange-500/30 rounded-xl p-3 text-sm focus:outline-none focus:border-orange-500 text-slate-900 dark:text-white resize-none disabled:opacity-50"
                    />
                    {/* Next to the field: why Confirm stays closed until there is a reason. */}
                    <p id="ranking-reason-hint" data-testid="ranking-reason-hint" className="text-[11px] text-slate-600 dark:text-slate-400">
                      {overrideReason.trim() ? 'Your reason is saved with the decision.' : 'Write a reason to confirm another professor.'}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800/60 flex flex-wrap items-center justify-end gap-3 bg-slate-50 dark:bg-[#1a1a1c]">
              {!assign.allowed && (
                <p id="ranking-confirm-reason" data-testid="ranking-confirm-reason" className="text-xs text-slate-700 dark:text-slate-300 mr-auto">{assign.reason}</p>
              )}
              <button
                type="button"
                onClick={closeReviewModal}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="ranking-confirm"
                onClick={handleConfirmAssignment}
                aria-describedby={!assign.allowed ? 'ranking-confirm-reason' : undefined}
                title={assign.allowed ? undefined : assign.reason}
                disabled={
                  !assign.allowed || isActiveRowPending || isSyncing || !activeVerdict || activeVerdict.blocked
                  || activeVerdict.status === 'assigned' || (isOverrideActive && !overrideReason.trim())
                }
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-700 transition-colors shadow-md shadow-cyan-900/20 flex items-center disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isActiveRowPending ? <Loader2 size={14} className="animate-spin mr-2" /> : <CheckCircle2 size={14} className="mr-2" />}
                {isActiveRowPending ? 'Saving…' : 'Confirm Assignment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300"
        >
          {toast.tone === 'error' ? (
            <div className="w-7 h-7 rounded-lg bg-red-500/20 dark:bg-red-500/15 flex items-center justify-center text-red-500 shrink-0">
              <AlertTriangle size={16} />
            </div>
          ) : (
            <div className="w-7 h-7 rounded-lg bg-cyan-500/20 dark:bg-cyan-500/15 flex items-center justify-center text-cyan-500 shrink-0">
              <CheckCircle2 size={16} />
            </div>
          )}
          <span className="text-xs font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Dismiss message"
            className="ml-2 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
