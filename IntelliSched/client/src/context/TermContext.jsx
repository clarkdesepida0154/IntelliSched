import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../services/api';
import useDataChanges from '../hooks/useDataChanges';
import { TermContext, SEMESTER_OPTIONS, semesterToNumber } from './term';
import { academicYearOf, academicYearOptions, chooseDefaultTerm, isAcademicYear, normalizeAcademicCalendar, semesterLabelOf, termOfDate } from '../utils/academicCalendar';

// Phase 13 (decision 2): the term the app opens on and the years the picker offers.
// The default term: 1. the term this user chose last (kept per account in this browser);
// 2. the term the build names (the demos only; the office kit names none); 3. the newest term that has
// a schedule version; 4. the academic year in progress with today's semester, by the Academic calendar.
// The years: every year with data, the current one and the next four (GET /academic-calendar).
const LEGACY_KEY = 'intellisched.activeTerm';
const keyFor = (userId) => `${LEGACY_KEY}:${userId}`;

const readStored = (key) => {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (!v || typeof v !== 'object' || !isAcademicYear(v.activeAcademicYear) || !SEMESTER_OPTIONS.includes(v.activeSemester)) return null;
    return { academicYear: v.activeAcademicYear, semester: semesterToNumber(v.activeSemester) };
  } catch {
    return null;
  }
};

// This account's last choice; a choice saved by an older version (or a test script) without an account
// is read when the account has none.
const savedFor = (userId) => (userId && readStored(keyFor(userId))) || readStored(LEGACY_KEY);

const buildTerm = (env = import.meta.env) => {
  const year = env?.VITE_DEFAULT_ACADEMIC_YEAR;
  const label = env?.VITE_DEFAULT_SEMESTER;
  return isAcademicYear(year) && SEMESTER_OPTIONS.includes(label) ? { academicYear: year, semester: semesterToNumber(label) } : null;
};

// A usable answer from the gateway, or null (a mocked or older gateway answers something else).
const usableInfo = (data) => (data && data.success === true && Array.isArray(data.options) && data.options.every(isAcademicYear) && data.current ? data : null);

const resolveTerm = (userId, info) => chooseDefaultTerm({
  saved: savedFor(userId),
  buildTerm: buildTerm(),
  newestVersionTerm: info?.newestVersionTerm || null,
  current: info?.current || termOfDate(new Date(), info?.calendar),
  options: info?.options
});

export function TermProvider({ user = null, children }) {
  const userId = user ? String(user.id || user._id || user.email || '') : '';
  const [owner, setOwner] = useState(userId);
  // info: the gateway's answer; 'failed' when it could not be read (the defaults are used then).
  const [info, setInfo] = useState(null);
  const [term, setTerm] = useState(() => resolveTerm(userId, null));

  // Another account signed in (or out): its own term, read before anything is drawn for it.
  if (owner !== userId) {
    setOwner(userId);
    setInfo(null);
    setTerm(resolveTerm(userId, null));
  }

  const loadCalendar = useCallback(async () => {
    try {
      const res = await api.get('/academic-calendar');
      return usableInfo(res.data) || 'failed';
    } catch {
      return 'failed';
    }
  }, []);

  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    loadCalendar().then((answer) => {
      if (!live) return;
      setInfo(answer);
      if (answer === 'failed') return;
      // A default (not the user's choice) follows the gateway: the newest term with a version, or today's
      // term by the university's calendar; a choice that is no longer offered gives way too.
      setTerm(t => (t.source !== 'user' && (t.source !== 'saved' || !answer.options.includes(t.academicYear)) ? resolveTerm(userId, answer) : t));
    });
    return () => { live = false; };
  }, [userId, loadCalendar]);

  // A changed Academic calendar (Administration -> System) reaches every open tab.
  const refreshCalendar = useCallback(async () => {
    const answer = await loadCalendar();
    if (answer !== 'failed') setInfo(answer);
    return answer;
  }, [loadCalendar]);
  useDataChanges(['system'], refreshCalendar, { enabled: Boolean(userId) });

  const gateway = info && info !== 'failed' ? info : null;
  const calendar = useMemo(() => normalizeAcademicCalendar(gateway?.calendar), [gateway]);
  const currentAcademicYear = gateway?.current?.academicYear || academicYearOf(new Date(), calendar);
  const yearOptions = useMemo(() => {
    const list = gateway?.options || academicYearOptions({ calendar, yearsWithData: [] });
    return list.includes(term.academicYear) ? list : [...list, term.academicYear].sort((a, b) => b.localeCompare(a));
  }, [gateway, calendar, term.academicYear]);

  // While a signed-in user's default may still move to the newest term with a version, nothing is drawn
  // (no page loads one term and then another); the gateway's answer, or its failure, ends the wait.
  const waiting = Boolean(userId) && info === null && term.source !== 'saved' && term.source !== 'build';

  const remember = useCallback((next) => {
    try {
      window.localStorage.setItem(userId ? keyFor(userId) : LEGACY_KEY, JSON.stringify({ activeAcademicYear: next.academicYear, activeSemester: semesterLabelOf(next.semester) }));
    } catch { /* storage unavailable */ }
  }, [userId]);

  const value = useMemo(() => {
    const activeSemester = semesterLabelOf(term.semester);
    const activeSemesterNumber = semesterToNumber(activeSemester);
    const choose = (next) => { const chosen = { ...next, source: 'user' }; remember(chosen); setTerm(chosen); };
    return {
      activeAcademicYear: term.academicYear,
      activeSemester,
      activeSemesterNumber,
      academicYearOptions: yearOptions,
      currentAcademicYear,
      calendar,
      termSource: term.source,
      semesterOptions: SEMESTER_OPTIONS,
      refreshCalendar,
      // Ready-made query/body fields for the schedule endpoints.
      termParams: { academicYear: term.academicYear, semester: activeSemesterNumber, program: 'BSIT' },
      termLabel: `${activeSemester}, A.Y. ${term.academicYear}`,
      setActiveAcademicYear: (year) => { if (yearOptions.includes(year)) choose({ academicYear: year, semester: term.semester }); },
      setActiveSemester: (label) => { if (SEMESTER_OPTIONS.includes(label)) choose({ academicYear: term.academicYear, semester: semesterToNumber(label) }); }
    };
  }, [term, yearOptions, currentAcademicYear, calendar, refreshCalendar, remember]);

  return (
    <TermContext.Provider value={value}>
      {waiting ? (
        <div data-testid="term-loading" className="min-h-screen bg-slate-100 dark:bg-[#0a0a0a] flex flex-col items-center justify-center text-slate-600 dark:text-white text-sm font-bold gap-2" role="status">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
          <span>Opening the term…</span>
        </div>
      ) : children}
    </TermContext.Provider>
  );
}
