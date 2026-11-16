import { useState, useEffect, useCallback, useRef } from 'react';
import { Layers, BookOpen, Users, CheckCircle2, Loader2, RefreshCw, AlertOctagon, AlertTriangle, X, Lock, Unlock, Search, Trophy, ChevronDown } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import { buildTermPairs, findLockFor, toSemesterLabel } from '../../utils/sectionMatcher';
import { isTbaSubject, resolveSubjectType, subjectKindOf } from '../../utils/subjectType';
import usePolicy from '../../hooks/usePolicy';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import usePagination from '../../hooks/usePagination';
import useEscapeKey from '../../hooks/useEscapeKey';
import TablePagination from '../../components/ui/TablePagination';
import { weightedHoursOf } from '../../utils/load';
import { likelihoodOf } from '../../utils/likelihood';
import { numberText } from '../../utils/scheduleDisplay';
import CurrentTermNote from '../../components/layout/CurrentTermNote';
import PermissionNote from '../../components/ui/PermissionNote';
import OutsideTeachersList from '../../components/assign/OutsideTeachersList';
import useDataChanges from '../../hooks/useDataChanges';
import { readStorage, writeStorage } from '../academic/subjects/subjectFormat';
import HelpTip from '../../components/ui/HelpTip';
// Lock writes from this page and Candidate Ranking share one serialized queue (see utils/lockQueue.js).
import {
  enqueueLockWrite, waitForLockWrites, reportLostLockWrite, drainLostLockWrites, describeLostLockWrites
} from '../../utils/lockQueue';
import Select from '../../components/ui/Select';

// Phase 8 Part 4 (decision 5): the "By class" tab without the scrolling — ONE SECTION AT A TIME.
// A section picker (each section with its assigned count), a compact table with one row per class
// (the code and title, the hours, the professor picker with each option's load against their range,
// the ranking's top pick with its Likelihood and a one-click Accept, the lock and the status), and
// a slim professors' side list (name, full-time or part-time, a load bar with the range;
// specializations behind "Details").
// Phase 8 Part 6 (decision 3): a professor picker sits beside the section picker. Choosing a
// professor (there or by clicking a name in the side list) shows EVERY class that professor teaches,
// across all sections, in the same table — with a Section column, the professor's load against
// their range above it, and the same row actions. Clearing the professor (or picking a section)
// returns to one section at a time.
// "Accept the top picks for this section" assigns every open Major's first-ranked professor behind
// a confirmation that lists them. A Minor row keeps its manual professor choice; NSTP stays TBA.
// Every assignment still goes through POST /schedule/lock under the Overload Guardian.

// Scenario A: every Minor and NSTP class is TBA, staffed by the GenEd departments.
const INSTITUTIONAL_POOL_LABEL = 'TBA';
const EMPLOYMENT_LABELS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
// Pages of 25 classes (a section has far fewer; the table standard keeps pagination above 25).
const PAGE_SIZE = 25;
// The chosen section is a UI preference (the only browser storage the standard allows).
const SECTION_STORAGE_KEY = 'intellisched.assignFaculty.section';
const filterLabelClass = 'block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1 uppercase tracking-wider';
const filterSelectClass = 'max-w-60 bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 px-2 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
// The visible reason (Phase 3 Step 6) the tab's write controls point at while the role may not assign.
const ASSIGN_NOTE_ID = 'matrix-permission-note';
// The institutional pool card: the gateway never counts a lock to it toward a load, so it has no cap.
const POOL_CARD_ID = 'FAC-TBA';
// The ranking service can take minutes on the whole college; the table never waits for it.
const RANKING_TIMEOUT_MS = 185000;

// Weekly contact hours of one (section, subject) pair. One lock staffs its lecture and laboratory
// alike, so this is what a lock adds to (or frees from) a professor's load.
const contactHoursOf = (subject) => (Number(subject.lecHours) || 0) + (Number(subject.labHours) || 0);

// 21 -> "21", 22.5 -> "22.5"
const formatHours = (hours) => (!Number.isFinite(hours) ? '—' : Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100));

// "14 of 18–21 h" (the professor's load against their range); "14 h · cap not set" without a cap.
const rangeText = (card) => (card.max === null
  ? `${formatHours(card.load)} h · cap not set`
  : `${formatHours(card.load)} of ${numberText(card.min ?? 0)}–${formatHours(card.max)} h`);

// Real-Time Overload Guardian, the one load rule (utils/load.js; the gateway applies the same): a
// lock is refused when the card's teaching hours plus what this pair adds FOR THAT PROFESSOR (lab
// hours x their lab factor) would pass their teaching cap. Ancillary hours are not part of the cap.
// The pool card has no cap, a pair the card already holds adds nothing, and a professor without a
// cap on record cannot be assigned.
const assessCapacity = (card, course, policy) => {
  if (!card || !course) return { exceeded: false, addHours: 0, projected: 0 };
  if (card.id !== POOL_CARD_ID && card.max === null) return { exceeded: true, noCap: true, addHours: 0, projected: card.load };
  const addHours = card.id === POOL_CARD_ID || course.lockedCardId === card.id || !policy ? 0 : weightedHoursOf(course.subject, card, policy);
  const projected = Math.round((card.load + addHours) * 100) / 100;
  return { exceeded: card.id !== POOL_CARD_ID && projected > card.max, addHours, projected };
};

// `embedded` (Phase 3 Step 4): the "By class" tab of Assign Faculty, which shows the page heading, its
// purpose and the current term itself; this page then drops its own heading and card, and shows `intro`
// (the tab's one-line explanation) beside its Reload action.
export default function CourseMatrixManager({ embedded = false, intro = null }) {
  // Locking a Major, assigning a Minor or a practicum coordinator, setting TBA and releasing a lock: the
  // permission map's faculty.assign. Everyone else sees the classes and the loads read-only.
  const assign = usePermission('faculty.assign');
  const [unassignedCourses, setUnassignedCourses] = useState([]);
  const [facultyLoads, setFacultyLoads] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [toast, setToast] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  // No active subject is placed in this semester: an empty state, not an error.
  const [emptyMessage, setEmptyMessage] = useState('');
  // One section at a time (decision 5); '' until the sections are known, then the remembered or first.
  const [sectionChoice, setSectionChoice] = useState(() => readStorage(SECTION_STORAGE_KEY) || '');
  // Phase 8 Part 6 (decision 3): a chosen professor switches the table to every class they teach,
  // across all sections ('' = one section at a time).
  const [professorChoice, setProfessorChoice] = useState('');
  const [query, setQuery] = useState('');
  // The ranking's top pick per catalog subject (the batch answer), read WITHOUT blocking the table.
  const [rankings, setRankings] = useState({ status: 'loading', bySubject: new Map() });
  // "Accept the top picks for this section": the confirmation that lists them.
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [accepting, setAccepting] = useState(false);
  // Pairs with a lock or unlock write in flight: state drives the row spinners, the ref is the
  // synchronous re-entry guard.
  const [pendingPairs, setPendingPairs] = useState(() => new Set());
  const pendingPairsRef = useRef(new Set());
  // A row's picker only stages a choice (pairKey → card id, '' = TBA / no professor); the Assign
  // button writes it, so browsing the list with the keyboard never saves anything.
  const [dropdownChoices, setDropdownChoices] = useState({});
  // Phase 8 Part 8 (decision 4): the outside teachers (GenEd teachers from outside CCS) for every GenEd
  // picker, and the name typed in each GenEd row's text box (pairKey -> text).
  const [outsideTeachers, setOutsideTeachers] = useState([]);
  const [outsideNames, setOutsideNames] = useState({});
  // True while a reload is reading: a write made meanwhile would be erased by that older snapshot.
  const syncingRef = useRef(false);
  // Queued writes can settle after the page closed; they then report instead of touching state.
  const mountedRef = useRef(true);
  const toastTimerRef = useRef(null);
  // True while an error toast is on screen: a later success must not replace it unread.
  const errorShowingRef = useRef(false);

  // Global Term Context: only the active term's subjects, demands and locks are shown and edited.
  const { activeSemester, activeSemesterNumber, termParams } = useTerm();
  const { policy } = usePolicy();

  // Stable per term, so the load effect can list it as its only dependency.
  const loadMatrixData = useCallback(async () => {
    // Lock writes still queued (from this page or Candidate Ranking, even from an earlier visit)
    // land first, so the picture read below already includes every lock the Dean has made.
    await waitForLockWrites();
    // Curriculum Builder placements are timeless: filed by semester, never by academic year.
    const [mappingsRes, facultyRes, sectionsRes, locksRes, loadsRes] = await Promise.all([
      api.get('/curriculum-mappings', { params: { semester: toSemesterLabel(activeSemesterNumber) } }),
      api.get('/faculty'),
      api.get('/sections'),
      api.get('/schedule/locks', { params: termParams }),
      // Every professor's teaching load by the one load rule, computed by the gateway (min included).
      api.get('/schedule/loads', { params: termParams })
    ]);
    const loadByRef = new Map((loadsRes.data?.loads || []).map(l => [l.facultyRef, l]));

    const mappings = mappingsRes.data || [];
    const activeFaculty = (facultyRes.data || []).filter(f => f.isActive);
    const activeSections = (sectionsRes.data || []).filter(sec => sec.isActive);
    const locks = locksRes.data?.locks || [];

    if (!mappings.some(m => m.subject && m.subject.isActive !== false)) {
      setUnassignedCourses([]);
      setErrorMessage('');
      setEmptyMessage(`No active subjects are placed in the ${activeSemester} yet. Place them in the Curriculum Builder (Curriculum & Subjects), then come back here.`);
      return;
    }
    setErrorMessage('');
    setEmptyMessage('');

    // A lock's holder, resolved the way the gateway resolves it: by faculty id (or Mongo id), then by
    // display name for a lock whose id matches no active record. Returns the holder's card id.
    const cardIdOf = (f) => f.facultyId || f._id;
    const resolveHolderCard = (lock) => {
      if (lock.facultyId === POOL_CARD_ID) return POOL_CARD_ID;
      const lockName = String(lock.facultyName ?? '').trim();
      const holder = activeFaculty.find(f => Boolean(lock.facultyId) && (lock.facultyId === f.facultyId || lock.facultyId === String(f._id)))
        || (lockName ? activeFaculty.find(f => f.name === lockName) : null);
      return holder ? cardIdOf(holder) : null;
    };

    // One row per (section, subject) pair, paired exactly the way the GA's Automated Section Matcher
    // pairs them, so every lock names a section the GA will actually schedule.
    const generatedDemands = [];
    buildTermPairs(activeSections, mappings).forEach(({ section, subject }) => {
      // NSTP stays with the institutional pool (never locked). A Minor is TBA unless the Dean picks a
      // CCS professor in its picker (a manual lock); a practicum gets one coordinator; a Major gets
      // its professor from the same picker or the top pick's Accept.
      const kind = subjectKindOf(subject);
      const isInstitutional = kind === 'NSTP';
      // A lock staffs the whole (section, subject) pair, so its class type is not read here.
      const storedLock = findLockFor(locks, section.sectionCode, subject);
      // The gateway ignores a lock on NSTP, and a lock on a Minor unless it is a manual assignment. A
      // Minor or practicum lock to the pool card (saved before Step 5) staffs nobody: it can be released.
      const isCountedLock = Boolean(storedLock) && kind !== 'NSTP' && (kind !== 'MINOR' || storedLock.source === 'manual')
        && (kind === 'MAJOR' || storedLock.facultyId !== POOL_CARD_ID);
      const matchingLock = isCountedLock ? storedLock : null;
      // Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher (no CCS professor).
      const outsideLock = Boolean(storedLock) && kind === 'MINOR' && storedLock.source === 'outside' && storedLock.outsideTeacherRef ? storedLock : null;
      const lockedCardId = matchingLock ? resolveHolderCard(matchingLock) : null;
      const contactHours = contactHoursOf(subject);

      // One row per (section, subject) pair: one lock staffs its lecture and laboratory alike, so
      // the row lists both hours. A practicum has no contact hours and is never scheduled.
      const hoursLabel = kind === 'PRACTICUM'
        ? 'Practicum · not scheduled'
        : [['Lec', subject.lecHours], ['Lab', subject.labHours]]
          .filter(([, hours]) => Number(hours) > 0)
          .map(([label, hours]) => `${label} ${formatHours(Number(hours))} h`)
          .join(' · ');
      generatedDemands.push({
        id: `${subject._id}::${section.sectionCode}`,
        pairKey: `${subject._id}::${section.sectionCode}`,
        // Subjects can share a code, so the catalog id is what pairs a row with its lock.
        subjectId: String(subject._id),
        code: subject.subjectCode,
        section: section.sectionCode,
        sectionId: section._id,
        title: subject.descriptiveTitle,
        hoursLabel,
        contactHours,
        // What the one load rule needs to weigh this pair for a professor.
        subject: { lecHours: subject.lecHours, labHours: subject.labHours, isPracticum: Boolean(subject.isPracticum) },
        subjectType: resolveSubjectType(subject),
        kind,
        is_minor: isTbaSubject(subject),
        isInstitutional,
        // A lock the schedule generator ignores (saved while the subject was still a Major, or on NSTP):
        // it can be released.
        staleLockFaculty: storedLock && !isCountedLock && !outsideLock ? storedLock.facultyName : null,
        lockedFaculty: matchingLock ? matchingLock.facultyName : outsideLock ? outsideLock.facultyName : null,
        lockedFacultyId: matchingLock ? matchingLock.facultyId : null,
        outsideTeacherRef: outsideLock ? String(outsideLock.outsideTeacherRef) : null,
        // The card whose load holds this pair's hours (null when the holder is not an active record).
        lockedCardId
      });
    });

    setUnassignedCourses(generatedDemands);

    // Teaching load against the professor's RANGE (minimum to cap), as the gateway computes it
    // (GET /schedule/loads carries min and underMin since Part 4). max is null while a professor
    // has no cap on record; such a card cannot take a lock.
    const formattedFaculty = activeFaculty.map(f => {
      const load = loadByRef.get(String(f._id));
      return {
        id: cardIdOf(f),
        name: f.name,
        employmentType: f.employmentType || null,
        specializations: f.specializations || [],
        certifications: f.certifications || [],
        load: Number(load?.teaching) || 0,
        max: Number.isFinite(load?.cap) ? load.cap : null,
        min: Number.isFinite(load?.min) ? load.min : 0,
        underMin: Number(load?.underMin) || 0
      };
    });

    formattedFaculty.push({
      id: POOL_CARD_ID,
      name: INSTITUTIONAL_POOL_LABEL,
      employmentType: null,
      specializations: [],
      certifications: [],
      load: 0,
      max: 99,
      min: 0,
      underMin: 0
    });

    setFacultyLoads(formattedFaculty);
  }, [activeSemester, activeSemesterNumber, termParams]);

  // Phase 8 Part 8 (decision 4): the outside teachers, read beside the table (never blocking it: a
  // failed read leaves the pickers with the CCS professors and TBA).
  const loadOutsideTeachers = useCallback(async () => {
    try {
      const res = await api.get('/outside-teachers', { params: termParams });
      if (mountedRef.current) setOutsideTeachers(res.data?.teachers || []);
    } catch {
      if (mountedRef.current) setOutsideTeachers([]);
    }
  }, [termParams]);

  // The ranking's top picks, in parallel with the table (never blocking it): the same batch answer
  // the Recommendations tab reads, keyed by catalog subject. The caller flips the status to
  // 'loading' itself where needed (the initial state already is; a reload does it in its handler).
  const loadRankings = useCallback(async () => {
    try {
      const res = await api.post('/schedule/recommendations/batch', { ...termParams }, { timeout: RANKING_TIMEOUT_MS });
      const bySubject = new Map((res.data?.predictions || [])
        .filter(p => p.subjectId)
        .map(p => [String(p.subjectId), { candidates: Array.isArray(p.candidates) ? p.candidates : [], nobodyTaughtBefore: p.nobodyTaughtBefore === true }]));
      if (mountedRef.current) setRankings({ status: 'ready', bySubject });
    } catch (err) {
      console.warn('[ML Engine] Top picks failed:', err.message);
      if (mountedRef.current) setRankings({ status: 'error', bySubject: new Map() });
    }
  }, [termParams]);

  // Single toast channel: a new message restarts the timer, so an older timer never hides it early.
  const showToast = useCallback((message, { tone = 'success', duration = 4000 } = {}) => {
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
  }, []);

  const dismissToast = () => {
    errorShowingRef.current = false;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setToast(null);
  };

  // Mount-only: queued writes read this to know whether the page is still there, and no toast timer
  // outlives the page.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function init() {
      loadOutsideTeachers();
      try {
        await loadMatrixData();
        if (!isMounted) return;
        // A queued write that failed after its page closed is reported here instead of vanishing.
        const lost = drainLostLockWrites();
        if (lost.length) showToast(describeLostLockWrites(lost), { tone: 'error', duration: 8000 });
      } catch (err) {
        if (!isMounted) return;
        setErrorMessage('The classes could not be loaded: the server did not answer. Check your connection and press Try again.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
      // The top picks follow the table read, and the table never waits for them (the column shows
      // "Ranking…" until the batch answer lands).
      if (isMounted) loadRankings();
    }

    init();
    return () => { isMounted = false; };
  }, [loadMatrixData, loadRankings, loadOutsideTeachers, showToast]);

  // Phase 8 Part 8 (decision 6): live updates — another part's or tab's save (the Teaching loads
  // panel's moves, a faculty edit, another user's assignment) reads the table again, as Reload does;
  // this table's own writes (origin 'by-class') already show at once. Skipped while one of its writes
  // is in flight (that write's own answer is what the table shows).
  const liveReload = useCallback(async () => {
    if (syncingRef.current || pendingPairsRef.current.size) return;
    syncingRef.current = true;
    setIsRefreshing(true);
    try {
      await Promise.all([loadMatrixData(), loadOutsideTeachers()]);
    } catch { /* the table keeps what it shows */ } finally {
      syncingRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, [loadMatrixData, loadOutsideTeachers]);
  useDataChanges(['assignments', 'faculty', 'sections', 'curriculum', 'policy', 'outsideTeachers'], liveReload, { ignoreOrigin: 'by-class' });

  const handleManualReload = async () => {
    syncingRef.current = true;
    setIsRefreshing(true);
    setErrorMessage('');
    loadOutsideTeachers();
    try {
      await loadMatrixData();
      showToast('The classes and assignments are up to date.', { duration: 3000 });
    } catch (err) {
      setErrorMessage('The classes could not be reloaded: the server did not answer. Press Try again.');
    } finally {
      syncingRef.current = false;
      setIsRefreshing(false);
    }
    setRankings(prev => ({ ...prev, status: 'loading' }));
    loadRankings();
  };

  // ---------------------------------------------------------------------------
  // Real-Time Overload Guardian: optimistic lock and unlock through the shared queue
  // ---------------------------------------------------------------------------
  // Adds signed hours per card id. Deltas stay exact (loads are half-hour multiples), so a rollback
  // applies the negated delta and lands on the original value. The pool card never carries a load.
  const applyLoadDelta = (delta) => {
    setFacultyLoads(prev => prev.map(f => (
      f.id !== POOL_CARD_ID && delta[f.id] ? { ...f, load: f.load + delta[f.id] } : f
    )));
  };
  const negate = (delta) => Object.fromEntries(Object.entries(delta).map(([id, hours]) => [id, -hours]));
  // Teaching hours a pair counts for one card's professor (0 for the pool card or before the policy loads).
  const hoursForCard = (course, cardId) => {
    const card = facultyLoads.find(f => f.id === cardId);
    return card && cardId !== POOL_CARD_ID && policy ? weightedHoursOf(course.subject, card, policy) : 0;
  };

  // Update in place, by pair key: another subject sharing this code keeps its own lock state.
  const patchPair = (pairKey, patch) => {
    setUnassignedCourses(prev => prev.map(c => (c.pairKey === pairKey ? { ...c, ...patch } : c)));
  };

  const setPairPending = (pairKey, isPending) => {
    if (isPending) pendingPairsRef.current.add(pairKey);
    else pendingPairsRef.current.delete(pairKey);
    if (mountedRef.current) setPendingPairs(new Set(pendingPairsRef.current));
  };

  // The Guardian's refusal, in the Dean's words.
  const refusalOf = (verdict, card, course) => (verdict.noCap
    ? `${card.name} has no teaching cap on record. Set employment type and cap on the Faculty page first.`
    : `Capacity Exceeded: assigning ${course.code} (${course.section}) would put ${card.name} at ${formatHours(verdict.projected)} / ${formatHours(card.max)} teaching hrs.`);

  // Locks a pair to a card: the badge and the loads move at once and the write joins the shared
  // queue. Reassigning also frees the previous holder's hours (weighed for them). A failed write
  // rolls the optimistic change back. Returns a promise that settles with the queued write.
  const commitLock = (course, card) => {
    const verdict = assessCapacity(card, course, policy);
    if (verdict.exceeded) {
      showToast(refusalOf(verdict, card, course), { tone: 'error', duration: 6000 });
      return Promise.resolve(false);
    }
    const hours = course.contactHours;
    const previous = { lockedFaculty: course.lockedFaculty, lockedFacultyId: course.lockedFacultyId, lockedCardId: course.lockedCardId, staleLockFaculty: course.staleLockFaculty, outsideTeacherRef: course.outsideTeacherRef || null };
    const delta = { [card.id]: verdict.addHours };
    if (previous.lockedCardId) delta[previous.lockedCardId] = (delta[previous.lockedCardId] || 0) - hoursForCard(course, previous.lockedCardId);

    applyLoadDelta(delta);
    patchPair(course.pairKey, { lockedFaculty: card.name, lockedFacultyId: card.id, lockedCardId: card.id, staleLockFaculty: null, outsideTeacherRef: null });
    setPairPending(course.pairKey, true);

    const label = `${course.code} (${course.section})`;
    return new Promise((resolve) => {
      enqueueLockWrite(async () => {
        try {
          await api.post('/schedule/lock', {
            ...termParams,
            subjectId: course.subjectId,
            subjectCode: course.code,
            sectionCode: course.section,
            sectionId: course.sectionId,
            facultyId: card.id,
            facultyName: card.name,
            // One lock covers lecture and laboratory, which is how the GA applies it.
            classType: 'ALL',
            units: hours
          }, { origin: 'by-class' });
          showToast(course.kind === 'MINOR'
            ? `${label} assigned manually to ${card.name}.`
            : course.kind === 'PRACTICUM'
              ? `${card.name} is now the practicum coordinator for ${label}.`
              : `${label} is assigned to ${card.name}.`);
          resolve(true);
        } catch (err) {
          const message = err.response?.data?.message || 'the lock could not be saved, so nothing was assigned.';
          if (!mountedRef.current) {
            reportLostLockWrite(label, message);
            resolve(false);
            return;
          }
          applyLoadDelta(negate(delta));
          patchPair(course.pairKey, previous);
          showToast(`${label}: ${message}`, { tone: 'error', duration: 6000 });
          resolve(false);
        } finally {
          setPairPending(course.pairKey, false);
        }
      });
    });
  };

  // A row's picker: a professor locks the pair to them (the Guardian applies); the empty choice
  // (TBA / no professor / no coordinator) releases the lock.
  const handleDropdownAssign = (course, cardId) => {
    if (!assign.allowed || syncingRef.current || pendingPairsRef.current.has(course.pairKey)) return;
    setDropdownChoices(prev => {
      const next = { ...prev };
      delete next[course.pairKey];
      return next;
    });
    if (cardId === '__stored') return;
    if (!cardId) {
      if (course.lockedFaculty) handleUnlockCourse(course);
      return;
    }
    // Phase 8 Part 8 (decision 4): an outside teacher from the list.
    if (String(cardId).startsWith('outside:')) {
      const id = String(cardId).slice('outside:'.length);
      if (id !== course.outsideTeacherRef) handleOutsideAssign(course, { id });
      return;
    }
    const card = facultyLoads.find(f => f.id === cardId);
    if (!card || card.id === course.lockedCardId) return;
    commitLock(course, card);
  };

  // Releases a pair's lock and gives its hours back to the holder, with the same optimistic flow. A
  // stale lock on a Minor or NSTP pair never counted toward a load, so it frees nothing.
  const handleUnlockCourse = (course, e) => {
    e?.stopPropagation();
    if (!assign.allowed || syncingRef.current || pendingPairsRef.current.has(course.pairKey)) return;

    const previous = {
      lockedFaculty: course.lockedFaculty,
      lockedFacultyId: course.lockedFacultyId,
      lockedCardId: course.lockedCardId,
      staleLockFaculty: course.staleLockFaculty,
      outsideTeacherRef: course.outsideTeacherRef || null
    };
    const delta = previous.lockedCardId ? { [previous.lockedCardId]: -hoursForCard(course, previous.lockedCardId) } : {};

    applyLoadDelta(delta);
    patchPair(course.pairKey, { lockedFaculty: null, lockedFacultyId: null, lockedCardId: null, staleLockFaculty: null, outsideTeacherRef: null });
    setPairPending(course.pairKey, true);

    const label = `${course.code} (${course.section})`;
    enqueueLockWrite(async () => {
      try {
        await api.delete('/schedule/lock', {
          origin: 'by-class',
          data: {
            ...termParams,
            subjectId: course.subjectId,
            subjectCode: course.code,
            sectionCode: course.section
          }
        });
        // Phase 8 Part 8 (decision 4): an outside teacher's class count on the list follows at once.
        if (previous.outsideTeacherRef) loadOutsideTeachers();
        showToast(course.kind === 'MINOR'
          ? `${label} is TBA again.`
          : course.kind === 'PRACTICUM'
            ? `${label} has no practicum coordinator now.`
            : `${label} has no professor now.`, { duration: 3000 });
      } catch (err) {
        const message = err.response?.data?.message || 'the lock could not be released.';
        if (!mountedRef.current) {
          reportLostLockWrite(label, message);
          return;
        }
        applyLoadDelta(negate(delta));
        patchPair(course.pairKey, previous);
        showToast(`${label}: ${message}`, { tone: 'error', duration: 6000 });
      } finally {
        setPairPending(course.pairKey, false);
      }
    });
  };

  // Phase 8 Part 8 (decision 4): a GenEd class to an outside teacher, from the list (`id`) or a typed
  // name (`name`, which joins the list). A CCS professor who held the class gets the hours back; the
  // outside teacher never carries a load. The write is POST /schedule/lock-outside; TBA releases it
  // like any lock.
  const handleOutsideAssign = async (course, { id = null, name = '' }) => {
    if (!assign.allowed || syncingRef.current || pendingPairsRef.current.has(course.pairKey)) return;
    const label = `${course.code} (${course.section})`;
    setPairPending(course.pairKey, true);
    await waitForLockWrites();
    try {
      const res = await api.post('/schedule/lock-outside', {
        ...termParams,
        subjectId: course.subjectId,
        subjectCode: course.code,
        sectionCode: course.section,
        sectionId: course.sectionId,
        units: course.contactHours,
        ...(id ? { outsideTeacherId: id } : { name })
      }, { origin: 'by-class' });
      if (!mountedRef.current) return;
      const teacher = res.data?.teacher;
      if (course.lockedCardId) applyLoadDelta({ [course.lockedCardId]: -hoursForCard(course, course.lockedCardId) });
      patchPair(course.pairKey, { lockedFaculty: teacher?.name || name, lockedFacultyId: null, lockedCardId: null, staleLockFaculty: null, outsideTeacherRef: teacher?._id || null });
      setOutsideNames(prev => { const next = { ...prev }; delete next[course.pairKey]; return next; });
      setDropdownChoices(prev => { const next = { ...prev }; delete next[course.pairKey]; return next; });
      showToast(res.data?.message || `${label} is assigned to ${teacher?.name} (outside teacher).`);
      loadOutsideTeachers();
    } catch (err) {
      // A failed save keeps the typed name in its box.
      if (mountedRef.current) showToast(`${label}: ${err.response?.data?.message || 'the outside teacher could not be assigned.'}`, { tone: 'error', duration: 6000 });
    } finally {
      if (mountedRef.current) setPairPending(course.pairKey, false);
    }
  };

  // ---------------------------------------------------------------------------
  // The top picks (the ranking's rank 1 per subject) and "Accept the top picks for this section"
  // ---------------------------------------------------------------------------
  const topPickOf = (course) => {
    if (course.kind !== 'MAJOR') return null;
    const prediction = rankings.bySubject.get(course.subjectId);
    const candidates = prediction?.candidates || [];
    const top = candidates.find(c => Number(c.rank) === 1) || candidates[0] || null;
    if (!top) return null;
    const card = facultyLoads.find(f => f.id === top.id) || null;
    return { candidate: top, card, nobodyTaughtBefore: prediction?.nobodyTaughtBefore === true };
  };

  // The open Major rows of the section whose top pick the Guardian would allow, and the ones it
  // would not (listed in the confirmation so nothing is silently skipped).
  const acceptPlan = (rows) => {
    const accept = [];
    const skipped = [];
    for (const course of rows) {
      if (course.kind !== 'MAJOR' || course.lockedCardId) continue;
      const top = topPickOf(course);
      if (!top || !top.card) {
        skipped.push({ course, reason: 'no ranking yet' });
        continue;
      }
      const verdict = assessCapacity(top.card, course, policy);
      if (verdict.exceeded) skipped.push({ course, top, reason: 'over the cap' });
      else accept.push({ course, top, verdict });
    }
    return { accept, skipped };
  };

  const handleAcceptSection = async (plan) => {
    if (!assign.allowed || accepting) return;
    setAccepting(true);
    try {
      for (const { course, top } of plan.accept) {
        const liveCourse = unassignedCourses.find(c => c.pairKey === course.pairKey) || course;
        const liveCard = facultyLoads.find(f => f.id === top.card.id) || top.card;
        // Each lock is the same write as a single Assign; the Guardian re-checks each one.
        await commitLock(liveCourse, liveCard);
      }
    } finally {
      setAccepting(false);
      setAcceptOpen(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived state: the sections, the chosen one, the table rows
  // ---------------------------------------------------------------------------
  // Per-section assigned counts (NSTP is always TBA and stays out of both numbers).
  const sectionsSummary = [...new Set(unassignedCourses.map(c => c.section))].sort((a, b) => a.localeCompare(b))
    .map(code => {
      const rows = unassignedCourses.filter(c => c.section === code && c.kind !== 'NSTP');
      return { code, total: rows.length, assigned: rows.filter(c => c.lockedCardId && c.lockedCardId !== POOL_CARD_ID).length };
    });
  const chosenSection = sectionsSummary.some(s => s.code === sectionChoice) ? sectionChoice : (sectionsSummary[0]?.code || '');
  useEffect(() => {
    if (chosenSection) writeStorage(SECTION_STORAGE_KEY, chosenSection);
  }, [chosenSection]);

  // The counts per (subject, section) pair, the way the Term Checklist and the readiness check count
  // them: a pair has a professor when its lock names an active professor; a lock to the TBA card, or
  // to someone no longer active, does not count.
  const countOf = (kind) => {
    const rows = unassignedCourses.filter(c => c.kind === kind);
    return { total: rows.length, assigned: rows.filter(c => c.lockedCardId && c.lockedCardId !== POOL_CARD_ID).length };
  };
  const majorCount = countOf('MAJOR');
  const minorCount = countOf('MINOR');
  const practicumCount = countOf('PRACTICUM');
  const nstpCount = unassignedCourses.filter(c => c.kind === 'NSTP').length;

  // Professors a row's picker can name (the institutional pool card is not one).
  const professorCards = facultyLoads.filter(f => f.id !== POOL_CARD_ID);
  // Phase 8 Part 6 (decision 3): the professor view — every class of one professor, all sections.
  const professorView = professorCards.find(f => f.id === professorChoice) || null;

  // The table: the chosen section's classes — or, in the professor view, every class that professor
  // teaches across all sections — then the search.
  const q = query.trim().toLowerCase();
  const sectionRows = unassignedCourses.filter(c => c.section === chosenSection);
  const baseRows = professorView ? unassignedCourses.filter(c => c.lockedCardId === professorView.id) : sectionRows;
  const filteredCourses = baseRows.filter(c =>
    (!q || [c.code, c.title, c.section].some(v => String(v || '').toLowerCase().includes(q))));
  const { pageItems, currentPage, totalPages, setPage, resetPage, rangeLabel } = usePagination(filteredCourses, PAGE_SIZE);
  const anyFilter = Boolean(q);
  const clearFilters = () => { setQuery(''); resetPage(); };
  // Choosing a professor opens their view; choosing them again (or "Back to one section") clears it.
  const chooseProfessor = (cardId) => {
    setProfessorChoice(prev => (prev === cardId ? '' : cardId));
    setQuery('');
    resetPage();
  };
  const plan = acceptPlan(sectionRows);
  useEscapeKey(acceptOpen, () => setAcceptOpen(false));

  const reloadButton = (
    <button
      type="button"
      data-testid="matrix-reload"
      onClick={handleManualReload}
      disabled={isRefreshing || isLoading}
      className="flex items-center text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 px-3.5 py-2 rounded-xl transition-all cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      <RefreshCw size={14} className={`mr-1.5 ${isRefreshing ? 'animate-spin text-cyan-500' : ''}`} aria-hidden="true" />
      {isRefreshing ? 'Reloading…' : 'Reload'}
    </button>
  );

  // One row of the table.
  const renderRow = (course) => {
    const isPending = pendingPairs.has(course.pairKey);
    const selectId = `matrix-assign-${course.code}-${course.section}`.replace(/\s+/g, '-');
    const storedChoice = course.lockedCardId || (course.outsideTeacherRef ? `outside:${course.outsideTeacherRef}` : course.lockedFaculty ? '__stored' : '');
    const typedOutside = outsideNames[course.pairKey] || '';
    const chosen = dropdownChoices[course.pairKey] ?? storedChoice;
    const emptyLabel = course.kind === 'PRACTICUM' ? 'No coordinator yet' : course.kind === 'MINOR' ? 'TBA' : 'No professor yet';
    const assignBlockedReason = !assign.allowed
      ? assign.reason
      : isPending
        ? 'Saving the previous choice…'
        : isRefreshing
          ? 'Reloading the classes…'
          : chosen === storedChoice
            ? 'Pick a different option in the list first.'
            : '';
    const top = topPickOf(course);
    const topVerdict = top?.card ? assessCapacity(top.card, course, policy) : null;
    const topAssigned = top && course.lockedCardId === top.card?.id;
    const likelihood = top ? likelihoodOf(top.candidate.score, top.candidate.id) : null;

    return (
      <tr
        key={course.id}
        data-testid={`matrix-class-${course.code}-${course.section}`.replace(/\s+/g, '-')}
        className="align-top text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
      >
        {/* The professor view lists classes across all sections, so each row names its section. */}
        {professorView && (
          <td data-testid={`matrix-section-${course.code}-${course.section}`.replace(/\s+/g, '-')} className="pl-6 pr-3 py-3">
            <p className="font-bold text-xs text-slate-800 dark:text-white whitespace-nowrap">{course.section}</p>
          </td>
        )}
        {/* The class: code, title and hours. */}
        <td className={`${professorView ? 'px-3' : 'pl-6 pr-3'} py-3`}>
          <p className="font-black text-sm text-slate-800 dark:text-white">{course.code}</p>
          <p className="text-xs text-slate-600 dark:text-slate-400 font-medium max-w-56">{course.title}</p>
          <p className="text-[10px] font-bold mt-0.5 text-blue-800 dark:text-blue-300">{course.hoursLabel}</p>
        </td>
        {/* The professor picker (every option with the load against the range) and the save. */}
        <td className="px-3 py-3">
          {course.kind === 'NSTP' ? (
            <p className="text-xs font-bold text-purple-700 dark:text-purple-300">TBA: staffed by the GenEd departments</p>
          ) : (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <label htmlFor={selectId} className="sr-only">{`Professor for ${course.code} ${course.section}`}</label>
                <Select
                  id={selectId}
                  data-testid={selectId}
                  value={chosen}
                  onChange={(e) => { const value = e.target.value; setDropdownChoices(prev => ({ ...prev, [course.pairKey]: value })); }}
                  disabled={isPending || isRefreshing || !assign.allowed}
                  {...blockedBy(assign, ASSIGN_NOTE_ID)}
                  className="min-w-0 w-full max-w-64 bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 px-2 text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
                >
                  <option value="">{emptyLabel}</option>
                  {course.lockedFaculty && !course.lockedCardId && !course.outsideTeacherRef && (
                    <option value="__stored" disabled>{course.lockedFaculty} (not an active profile)</option>
                  )}
                  {professorCards.map(card => {
                    // The Guardian's verdict per professor: a choice it would refuse says why.
                    const verdict = assessCapacity(card, course, policy);
                    const why = verdict.noCap ? ' — no teaching cap set' : verdict.exceeded ? ' — over teaching cap' : '';
                    return (
                      <option key={card.id} value={card.id} disabled={verdict.exceeded}>
                        {card.name} · {rangeText(card)}{why}
                      </option>
                    );
                  })}
                  {course.kind === 'MINOR' && outsideTeachers.length > 0 && (
                    <optgroup label="Outside teachers (no load, no CCS room)">
                      {outsideTeachers.map(t => <option key={t._id} value={`outside:${t._id}`}>{t.name} · outside teacher</option>)}
                    </optgroup>
                  )}
                </Select>
                <button
                  type="button"
                  data-testid={`${selectId}-assign`}
                  onClick={() => handleDropdownAssign(course, chosen)}
                  disabled={Boolean(assignBlockedReason)}
                  title={assignBlockedReason || undefined}
                  aria-describedby={assign.allowed ? `${selectId}-hint` : `${ASSIGN_NOTE_ID} ${selectId}-hint`}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-600 text-white hover:bg-cyan-700 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  {chosen === '' && storedChoice !== '' ? (course.kind === 'PRACTICUM' ? 'Remove' : course.kind === 'MINOR' ? 'Set TBA' : 'Release') : 'Assign'}
                </button>
              </div>
              <p id={`${selectId}-hint`} className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1">
                {isPending && <Loader2 size={10} className="animate-spin" />}
                {isPending
                  ? 'Saving…'
                  : chosen !== storedChoice
                    ? 'Not saved yet: press the button to save this choice.'
                    : course.kind === 'PRACTICUM'
                      ? `Counts ${formatHours(policy?.load?.ojtCoordinatorHours)} h of teaching load for the coordinator.`
                      : course.outsideTeacherRef
                        ? `${course.lockedFaculty} (outside teacher): no Teachers' Program, load or cap, and no CCS room unless "Needs a CCS room" is ticked.`
                      : course.lockedFaculty
                        ? `Counts ${formatHours(course.contactHours)} h toward ${course.lockedFaculty}'s teaching load.`
                        : course.kind === 'MINOR'
                          ? 'TBA: staffed by the GenEd departments unless you pick a CCS professor or an outside teacher.'
                          : `Counts ${formatHours(course.contactHours)} h for whoever takes it.`}
              </p>
              {/* Phase 8 Part 8 (decision 4): a typed outside teacher's name joins the list and every GenEd picker. */}
              {course.kind === 'MINOR' && (
                <div className="mt-1.5">
                  <label htmlFor={`${selectId}-outside`} className="block text-[10px] font-bold text-slate-600 dark:text-slate-300">Or an outside teacher</label>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <input
                      id={`${selectId}-outside`}
                      data-testid={`${selectId}-outside-name`}
                      value={typedOutside}
                      placeholder="Type an outside teacher's name…"
                      maxLength={80}
                      onChange={(e) => { const value = e.target.value; setOutsideNames(prev => ({ ...prev, [course.pairKey]: value })); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && typedOutside.trim()) handleOutsideAssign(course, { name: typedOutside.trim() }); }}
                      disabled={isPending || isRefreshing || !assign.allowed}
                      {...blockedBy(assign, ASSIGN_NOTE_ID)}
                      className="min-w-0 w-full max-w-64 bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 px-2 text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      data-testid={`${selectId}-outside-assign`}
                      onClick={() => handleOutsideAssign(course, { name: typedOutside.trim() })}
                      disabled={!typedOutside.trim() || isPending || isRefreshing || !assign.allowed}
                      title={!assign.allowed ? assign.reason : !typedOutside.trim() ? "Type the outside teacher's name first." : undefined}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-white hover:bg-slate-800 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 disabled:cursor-not-allowed"
                    >
                      Assign
                    </button>
                  </div>
                </div>
              )}
              {course.staleLockFaculty && !isPending && (
                <button
                  type="button"
                  onClick={(e) => handleUnlockCourse(course, e)}
                  disabled={isRefreshing || !assign.allowed}
                  title={`The schedule generator ignores this assignment to ${course.staleLockFaculty}: it was saved while the subject was a Major.`}
                  {...blockedBy(assign, ASSIGN_NOTE_ID)}
                  className="mt-1 text-[10px] font-bold text-red-600 hover:text-red-700 dark:text-red-400 flex items-center hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Unlock size={10} className="mr-1" aria-hidden="true" /> Release ignored lock to {course.staleLockFaculty}
                </button>
              )}
            </div>
          )}
          {course.kind === 'NSTP' && course.staleLockFaculty && !isPending && (
            <button
              type="button"
              onClick={(e) => handleUnlockCourse(course, e)}
              disabled={isRefreshing || !assign.allowed}
              title={`The schedule generator ignores this assignment to ${course.staleLockFaculty}: it was saved while the subject was a Major.`}
              {...blockedBy(assign, ASSIGN_NOTE_ID)}
              className="mt-1 text-[10px] font-bold text-red-600 hover:text-red-700 dark:text-red-400 flex items-center hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Unlock size={10} className="mr-1" aria-hidden="true" /> Release ignored lock
            </button>
          )}
        </td>
        {/* The ranking's top pick with its Likelihood and the one-click Accept (Majors only). */}
        <td className="px-3 py-3">
          {course.kind !== 'MAJOR' ? (
            <span className="text-[10px] text-slate-500 dark:text-slate-400">{course.kind === 'NSTP' ? 'Never ranked' : 'Not ranked (the Dean assigns by hand)'}</span>
          ) : rankings.status === 'loading' ? (
            <span data-testid={`matrix-top-loading-${course.code}-${course.section}`.replace(/\s+/g, '-')} className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" aria-hidden="true" /> Ranking…</span>
          ) : !top ? (
            <span className="text-[10px] text-slate-500 dark:text-slate-400">{rankings.status === 'error' ? 'Ranking not available (see the Recommendations tab)' : 'No candidate'}</span>
          ) : (
            <div data-testid={`matrix-top-${course.code}-${course.section}`.replace(/\s+/g, '-')} className="min-w-0">
              <p className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1">
                <Trophy size={11} className="text-cyan-500 shrink-0" aria-hidden="true" /> {top.candidate.name}
              </p>
              <p className="text-[10px] mt-0.5">
                <span className="font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">Likelihood </span>
                <span className="font-black text-cyan-700 dark:text-cyan-300 tabular-nums">{likelihood ? likelihood.text : 'not given'}</span>
              </p>
              {top.nobodyTaughtBefore && (
                <p className="text-[10px] text-amber-700 dark:text-amber-400 font-bold mt-0.5">Weak ranking: nobody on the current faculty has taught this subject.</p>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                {topAssigned ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30">
                    <CheckCircle2 size={10} aria-hidden="true" /> Assigned
                  </span>
                ) : (
                  <span className="inline-flex" title={!assign.allowed ? assign.reason : topVerdict?.exceeded ? refusalOf(topVerdict, top.card, course) : ''}>
                    <button
                      type="button"
                      data-testid={`matrix-accept-${course.code}-${course.section}`.replace(/\s+/g, '-')}
                      onClick={() => top.card && commitLock(course, top.card)}
                      disabled={!assign.allowed || !top.card || topVerdict?.exceeded || isPending || isRefreshing}
                      aria-label={`Accept ${top.candidate.name} for ${course.code} ${course.section}`}
                      aria-describedby={!assign.allowed ? ASSIGN_NOTE_ID : undefined}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-cyan-600 text-white hover:bg-cyan-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                    >
                      <Lock size={10} aria-hidden="true" /> Accept
                    </button>
                  </span>
                )}
                {topVerdict?.exceeded && !topAssigned && (
                  <span className="text-[10px] font-bold text-red-600 dark:text-red-400 flex items-center gap-0.5"><AlertTriangle size={10} aria-hidden="true" /> Over the cap</span>
                )}
              </div>
            </div>
          )}
        </td>
        {/* The status: assigned (with Release) or open. */}
        <td className="px-3 py-3 pr-6">
          {isPending ? (
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 flex items-center">
              <Loader2 size={10} className="mr-1 animate-spin" aria-hidden="true" /> Saving…
            </span>
          ) : course.lockedFaculty ? (
            <div>
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 flex items-center">
                <Lock size={12} className="mr-1 shrink-0" aria-hidden="true" />
                <span className="wrap-break-word min-w-0">Assigned: {course.lockedFaculty}</span>
              </span>
              <button
                type="button"
                data-testid={`matrix-release-${course.code}-${course.section}`.replace(/\s+/g, '-')}
                onClick={(e) => handleUnlockCourse(course, e)}
                disabled={isRefreshing || !assign.allowed}
                {...blockedBy(assign, ASSIGN_NOTE_ID)}
                className="mt-1 text-[10px] font-bold text-red-600 hover:text-red-700 dark:text-red-400 flex items-center hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Unlock size={10} className="mr-1" aria-hidden="true" /> Release assignment
              </button>
            </div>
          ) : course.kind === 'NSTP' ? (
            <span className="text-[10px] font-bold text-purple-800 dark:text-purple-300">Always TBA</span>
          ) : course.kind === 'MINOR' && !course.lockedFaculty ? (
            <span className="text-[10px] font-bold text-purple-800 dark:text-purple-300">TBA (GenEd departments)</span>
          ) : (
            <span className="text-[10px] font-bold text-cyan-800 dark:text-cyan-300">{course.kind === 'PRACTICUM' ? 'No coordinator yet' : 'No professor yet'}</span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className={embedded ? 'flex flex-col' : 'bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-6'}>

        {embedded ? (
          // Inside Assign Faculty: its header names the page; the tab's explanation and the reload action stay here.
          <div data-testid="matrix-toolbar" className="px-6 md:px-8 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800/60">
            {intro ? <HelpTip label="this tab" testid="matrix-intro">{intro}</HelpTip> : <span />}
            <div className="shrink-0">{reloadButton}</div>
          </div>
        ) : (
          <>
            {/* HEADER */}
            <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-cyan-500/10 rounded-xl">
                  <Layers className="text-cyan-600 dark:text-cyan-400" size={28} />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-wide">By class</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Pick the professor for each class, one section at a time; the schedule generator keeps every choice.
                  </p>
                  <CurrentTermNote />
                </div>
              </div>
              {reloadButton}
            </div>

            <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>
          </>
        )}

        {!assign.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={ASSIGN_NOTE_ID} permission={assign} lead="You can view the classes, the assignments and the teaching loads." />
          </div>
        )}

        {/* WORKSPACE AREA */}
        {isLoading ? (
          <div className="p-20 flex flex-col items-center justify-center text-slate-600 dark:text-slate-400 gap-3">
            <Loader2 size={36} className="animate-spin text-cyan-500" aria-hidden="true" />
            <p data-testid="matrix-loading" className="text-xs font-bold uppercase tracking-wider">Loading the classes and assignments…</p>
          </div>
        ) : errorMessage ? (
          <div role="alert" className="p-12 text-center max-w-md mx-auto my-8">
            <AlertOctagon size={40} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Classes not loaded</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
            <button
              type="button"
              onClick={handleManualReload}
              className="px-4 py-2 bg-cyan-600 text-white rounded-xl text-xs font-bold hover:bg-cyan-700 transition-colors cursor-pointer"
            >
              Try again
            </button>
          </div>
        ) : emptyMessage ? (
          <div data-testid="matrix-empty" className="p-12 text-center max-w-md mx-auto my-8">
            <BookOpen size={36} className="text-cyan-500 opacity-60 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">No classes yet</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{emptyMessage}</p>
          </div>
        ) : (
          <>
            {/* THE SECTION PICKER AND THE TERM'S COUNTS */}
            <div className="px-6 md:px-8 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-slate-200 dark:border-slate-800/60">
              <div>
                <label htmlFor="matrix-filter-section" className={filterLabelClass}>Section</label>
                <Select
                  id="matrix-filter-section"
                  data-testid="matrix-filter-section"
                  value={chosenSection}
                  onChange={(e) => { setSectionChoice(e.target.value); setProfessorChoice(''); clearFilters(); }}
                  className={filterSelectClass}
                >
                  {sectionsSummary.map(s => (
                    <option key={s.code} value={s.code}>{`${s.code} · ${s.assigned} of ${s.total} assigned`}</option>
                  ))}
                </Select>
              </div>
              {/* Phase 8 Part 6 (decision 3): one professor's classes across all sections. */}
              <div>
                <label htmlFor="matrix-filter-professor" className={filterLabelClass}>Professor</label>
                <Select
                  id="matrix-filter-professor"
                  data-testid="matrix-filter-professor"
                  value={professorChoice}
                  onChange={(e) => { setProfessorChoice(e.target.value); setQuery(''); resetPage(); }}
                  className={filterSelectClass}
                >
                  <option value="">One section at a time</option>
                  {professorCards.map(card => (
                    <option key={card.id} value={card.id}>{`${card.name} · ${rangeText(card)}`}</option>
                  ))}
                </Select>
              </div>
              <div className="flex-1 min-w-36 max-w-64">
                <label htmlFor="matrix-search" className={filterLabelClass}>{professorView ? 'Search these classes' : 'Search this section'}</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={14} aria-hidden="true" />
                  <input id="matrix-search" data-testid="matrix-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); resetPage(); }} placeholder={professorView ? 'Code, title or section…' : 'Code or title…'} className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-1.5 pl-8 pr-2 text-xs text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500" />
                </div>
              </div>
              {anyFilter && (
                <button type="button" data-testid="matrix-clear-filters" onClick={clearFilters} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                  Clear the filters
                </button>
              )}
              {/* Per (subject, section) pair, as on the Term Checklist and the readiness check. */}
              <div className="flex flex-wrap gap-2 text-xs font-bold ml-auto">
                <span data-testid="matrix-count-major" className="text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800/40 flex items-center">
                  <Lock size={10} className="mr-1" aria-hidden="true" /> Major classes assigned: {majorCount.assigned} of {majorCount.total}
                </span>
                {minorCount.total > 0 && (
                  <span data-testid="matrix-count-minor" title="The rest are TBA, staffed by the GenEd departments" className="text-purple-800 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/40 px-2 py-0.5 rounded border border-purple-200 dark:border-purple-800/40">
                    Minor classes with a CCS professor: {minorCount.assigned} of {minorCount.total}
                  </span>
                )}
                {practicumCount.total > 0 && (
                  <span data-testid="matrix-count-practicum" className="text-amber-900 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800/40">
                    Practicum coordinators: {practicumCount.assigned} of {practicumCount.total}
                  </span>
                )}
                {nstpCount > 0 && (
                  <span data-testid="matrix-count-nstp" className="text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700">
                    NSTP: {nstpCount} TBA
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-col lg:flex-row min-h-125">
              {/* LEFT: ONE COMPACT TABLE — THE CHOSEN SECTION'S CLASSES, OR ONE PROFESSOR'S ACROSS ALL SECTIONS */}
              <div className="flex-1 min-w-0 border-r border-slate-200 dark:border-slate-800">
                {professorView && (
                  <p data-testid="matrix-professor-note" className="px-6 pt-3 text-xs font-bold text-cyan-800 dark:text-cyan-300">
                    Every class {professorView.name} teaches, across all sections · {rangeText(professorView)}
                    {/* Under the minimum, from the load as the page now shows it (the fetched underMin would lag an assignment just made). */}
                    {Math.max(0, (professorView.min ?? 0) - professorView.load) > 0 ? ` · ${numberText(Math.max(0, professorView.min - professorView.load))} h under the minimum` : ''}.{' '}
                    <button type="button" data-testid="matrix-professor-clear" onClick={() => chooseProfessor(professorView.id)} className="underline cursor-pointer">Back to one section</button>
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table data-testid="matrix-table" className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-slate-200 dark:border-slate-800/60 text-slate-600 dark:text-slate-400">
                      <tr>
                        {professorView && <th scope="col" data-testid="matrix-col-section" className="pl-6 pr-3 py-3 font-bold tracking-wider uppercase text-xs">Section</th>}
                        <th scope="col" className={`${professorView ? 'px-3' : 'pl-6 pr-3'} py-3 font-bold tracking-wider uppercase text-xs`}>Class</th>
                        <th scope="col" className="px-3 py-3 font-bold tracking-wider uppercase text-xs">Professor</th>
                        <th scope="col" className="px-3 py-3 font-bold tracking-wider uppercase text-xs">Top pick (ranking)</th>
                        <th scope="col" className="px-3 py-3 pr-6 font-bold tracking-wider uppercase text-xs">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {filteredCourses.length === 0 ? (
                        <tr>
                          <td colSpan={professorView ? 5 : 4} className="p-10 text-center text-xs text-slate-600 dark:text-slate-400" data-testid="matrix-no-match">
                            {anyFilter
                              ? 'No classes match the filters. Change or clear the filters.'
                              : professorView
                                ? `${professorView.name} has no classes this term. Assign one from a section, or pick another professor.`
                                : 'This section has no classes this term.'}
                          </td>
                        </tr>
                      ) : pageItems.map(renderRow)}
                    </tbody>
                  </table>
                </div>
                <div className="px-6 py-3 flex flex-wrap gap-3 justify-between items-center text-xs text-slate-600 dark:text-slate-300 border-t border-slate-200 dark:border-slate-800/60">
                  <span data-testid="matrix-showing">
                    {professorView
                      ? `Showing ${rangeLabel} of ${filteredCourses.length} class${filteredCourses.length === 1 ? '' : 'es'} of ${professorView.name} (all sections).`
                      : `Showing ${rangeLabel} of ${filteredCourses.length} class${filteredCourses.length === 1 ? '' : 'es'} in ${chosenSection}.`}
                  </span>
                  <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Class pages" showSync={false} />
                </div>
                {/* THE SECTION ACTION: accept every open Major's top pick, behind a confirmation
                    (one section at a time; the professor view has no section to accept for). */}
                {!professorView && (
                  <div className="px-6 pb-5 pt-1">
                    <span className="inline-flex" title={!assign.allowed ? assign.reason : rankings.status !== 'ready' ? 'The ranking has not answered yet.' : plan.accept.length === 0 ? 'No open Major class has a top pick the cap allows.' : ''}>
                      <button
                        type="button"
                        data-testid="matrix-accept-section"
                        onClick={() => setAcceptOpen(true)}
                        disabled={!assign.allowed || rankings.status !== 'ready' || plan.accept.length === 0 || accepting || isRefreshing}
                        aria-describedby={!assign.allowed ? ASSIGN_NOTE_ID : undefined}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-cyan-700 text-white hover:bg-cyan-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                      >
                        <Trophy size={13} aria-hidden="true" /> Accept the top picks for this section{plan.accept.length > 0 ? ` (${plan.accept.length})` : ''}
                      </button>
                    </span>
                  </div>
                )}
              </div>

              {/* RIGHT: THE SLIM PROFESSORS' LIST (one line each; Details folds the specializations). */}
              <div className="w-full lg:w-80 shrink-0 p-4 lg:p-5">
                <h3 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-3 flex items-center">
                  <Users size={14} className="mr-2" aria-hidden="true" /> Professors ({professorCards.length})
                </h3>
                <ul data-testid="matrix-professors" className="space-y-1.5 max-h-150 overflow-y-auto pr-1 custom-scrollbar">
                  {professorCards.map(card => {
                    const pct = card.max ? Math.min((card.load / card.max) * 100, 100) : 0;
                    const over = card.max !== null && card.load > card.max;
                    const isFiltered = professorChoice === card.id;
                    return (
                      <li key={card.id} className={`rounded-xl border ${isFiltered ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-500/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c]'}`}>
                        <button
                          type="button"
                          data-testid={`matrix-prof-${card.id}`}
                          onClick={() => chooseProfessor(card.id)}
                          aria-pressed={isFiltered}
                          aria-label={`${card.name}: show every class they teach, across all sections`}
                          className="w-full text-left px-3 py-2 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded-xl"
                        >
                          <span className="flex items-baseline justify-between gap-2 min-w-0">
                            <span className="text-xs font-bold text-slate-800 dark:text-white truncate">{card.name}</span>
                            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 shrink-0">{EMPLOYMENT_LABELS[card.employmentType] || ''}</span>
                          </span>
                          <span className={`block text-[10px] tabular-nums mt-0.5 ${over ? 'text-red-700 dark:text-red-400 font-bold' : 'text-slate-600 dark:text-slate-300'}`}>
                            {rangeText(card)}
                            {card.underMin > 0 && <b className="text-amber-700 dark:text-amber-400">{` · ${numberText(card.underMin)} h under`}</b>}
                          </span>
                          {/* The load bar with the range: the minimum as a tick on the cap scale. */}
                          <span className="relative block w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 mt-1 overflow-hidden" aria-hidden="true">
                            <span className={`absolute inset-y-0 left-0 rounded-full ${over ? 'bg-red-500' : card.underMin > 0 ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${pct}%` }} />
                            {card.max > 0 && card.min > 0 && (
                              <span className="absolute inset-y-0 w-0.5 bg-slate-400 dark:bg-slate-500" style={{ left: `${Math.min((card.min / card.max) * 100, 100)}%` }} />
                            )}
                          </span>
                        </button>
                        {(card.specializations.length > 0 || card.certifications.length > 0) && (
                          <details className="px-3 pb-2">
                            <summary data-testid={`matrix-prof-details-${card.id}`} className="text-[10px] font-bold text-slate-500 dark:text-slate-400 cursor-pointer list-none flex items-center gap-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded">
                              <ChevronDown size={10} aria-hidden="true" /> Details
                            </summary>
                            <p className="text-[10px] text-slate-600 dark:text-slate-300 mt-1">
                              {card.specializations.join(', ') || 'No specialization recorded'}
                              {card.certifications.length > 0 && <span className="text-slate-500 dark:text-slate-400">{` · ${card.certifications.join(', ')}`}</span>}
                            </p>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* Phase 8 Part 8 (decision 4): the outside teachers, apart from the CCS professors. */}
                <OutsideTeachersList
                  teachers={outsideTeachers}
                  assign={assign}
                  notify={(message) => showToast(message, { duration: 3000 })}
                  onChanged={async () => { await loadOutsideTeachers(); await loadMatrixData(); }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* "ACCEPT THE TOP PICKS" CONFIRMATION: lists every assignment it will make, and the skipped. */}
      {acceptOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="matrix-accept-title" data-testid="matrix-accept-confirm" className="bg-white dark:bg-[#18181b] rounded-3xl w-full max-w-lg shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in zoom-in-95">
            <div className="p-7">
              <h3 id="matrix-accept-title" className="text-xl font-black text-slate-800 dark:text-white mb-2">Accept the top picks for {chosenSection}?</h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
                Each class below is assigned to the ranking&apos;s first pick, lecture and laboratory alike, as your decision; the Overload Guardian checks each one again. You can release or change any of them afterwards.
              </p>
              <ul className="space-y-1 mb-3 max-h-56 overflow-y-auto">
                {plan.accept.map(({ course, top }) => {
                  const like = likelihoodOf(top.candidate.score, top.candidate.id);
                  return (
                    <li key={course.pairKey} data-testid={`matrix-accept-item-${course.code}-${course.section}`.replace(/\s+/g, '-')} className="text-xs text-slate-800 dark:text-slate-100">
                      <b>{course.code}</b> → <b>{top.candidate.name}</b>{like ? <span className="text-slate-600 dark:text-slate-400">{` · Likelihood ${like.text}`}</span> : ''}
                    </li>
                  );
                })}
              </ul>
              {plan.skipped.length > 0 && (
                <p data-testid="matrix-accept-skipped" className="text-[11px] text-amber-800 dark:text-amber-300 mb-3">
                  Not included: {plan.skipped.map(({ course, reason }) => `${course.code} (${reason})`).join(', ')}. Assign {plan.skipped.length === 1 ? 'it' : 'them'} from the row or the Recommendations tab.
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  data-testid="matrix-accept-cancel"
                  onClick={() => setAcceptOpen(false)}
                  disabled={accepting}
                  className="px-5 py-2.5 rounded-xl text-sm font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="matrix-accept-save"
                  onClick={() => handleAcceptSection(plan)}
                  disabled={accepting || plan.accept.length === 0}
                  className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-cyan-600 hover:bg-cyan-700 transition-colors cursor-pointer flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {accepting ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : <CheckCircle2 size={14} className="mr-1.5" aria-hidden="true" />}
                  {accepting ? 'Assigning…' : `Assign ${plan.accept.length} class${plan.accept.length === 1 ? '' : 'es'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          role={toast.tone === 'error' ? 'alert' : 'status'}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300"
        >
          {toast.tone === 'error' ? (
            <div className="w-8 h-8 rounded-xl bg-red-500/20 dark:bg-red-500/15 flex items-center justify-center text-red-500 shrink-0">
              <AlertOctagon size={18} />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-xl bg-cyan-500/20 dark:bg-cyan-500/15 flex items-center justify-center text-cyan-500 shrink-0">
              <CheckCircle2 size={18} />
            </div>
          )}
          <span className="text-sm font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            onClick={dismissToast}
            aria-label="Dismiss message"
            className="ml-3 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
