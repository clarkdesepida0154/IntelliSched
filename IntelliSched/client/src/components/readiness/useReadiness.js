import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import useDataChanges from '../../hooks/useDataChanges';

// The Readiness Check of the term chosen in the top bar (Phase 3 Step 4): POST /schedule/preflight
// { academicYear, semester } -> { report }. The gateway builds everything the panel shows (report.readiness:
// the verdict and its seven lines, in the Dean's words); the pages compute nothing a second time.
// Used by the Generate Schedule page, the Readiness Check page and the Term Checklist.
//
// Returns { state: { status: 'checking' | 'done' | 'error', report, message }, recheck, replaceReport }.
// The check runs when the page opens and again on a term switch; an answer for another term is never
// shown. While a re-check runs, the last report stays on screen (status 'checking').
const CONNECTION_HELP = 'Check that the gateway is running, then try again.';

// The gateway's own words when it answered; otherwise what went wrong and what to do.
export const readinessErrorMessage = (err) => {
  const said = err?.response?.data?.message;
  return said || `The Readiness Check could not run (${err?.message || 'no answer'}). ${CONNECTION_HELP}`;
};

export default function useReadiness() {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const termKey = `${activeAcademicYear}|${activeSemesterNumber}`;
  // The last answer, with the term it belongs to: { termKey, status: 'done' | 'error', report, message }.
  const [answer, setAnswer] = useState(null);
  // The term a "Check again" is running for (null when none).
  const [recheckingFor, setRecheckingFor] = useState(null);
  // Only the newest request may change what is shown.
  const latest = useRef(0);

  const request = useCallback(async () => {
    const res = await api.post('/schedule/preflight', { academicYear: activeAcademicYear, semester: activeSemesterNumber });
    const report = res.data?.report;
    if (!report?.readiness || !Array.isArray(report.readiness.lines)) {
      throw new Error('the gateway answered without the Readiness Check; restart it so it runs the Phase 3 code');
    }
    return report;
  }, [activeAcademicYear, activeSemesterNumber]);

  // When the page opens, and on a term switch.
  useEffect(() => {
    let active = true;
    latest.current += 1;
    const id = latest.current;
    request()
      .then(report => { if (active && id === latest.current) setAnswer({ termKey, status: 'done', report, message: '' }); })
      .catch(err => { if (active && id === latest.current) setAnswer({ termKey, status: 'error', report: null, message: readinessErrorMessage(err) }); });
    return () => { active = false; };
  }, [request, termKey]);

  // When this page last asked for a check (the live updates below skip a second one right after it).
  const lastRecheckAt = useRef(0);

  // "Check again" (and after a save that changes the answer). Resolves with the new report, or null.
  const recheck = useCallback(async () => {
    lastRecheckAt.current = Date.now();
    latest.current += 1;
    const id = latest.current;
    const forTerm = termKey;
    setRecheckingFor(forTerm);
    try {
      const report = await request();
      if (id === latest.current) setAnswer({ termKey: forTerm, status: 'done', report, message: '' });
      return report;
    } catch (err) {
      if (id === latest.current) setAnswer({ termKey: forTerm, status: 'error', report: null, message: readinessErrorMessage(err) });
      return null;
    } finally {
      if (id === latest.current) setRecheckingFor(null);
    }
  }, [request, termKey]);

  // Phase 8 Part 8 (decision 6): live updates — a save of anything the check reads checks again (the
  // last report stays on screen meanwhile), from this tab at once and from the others within ~2 s.
  // A save on this page that already checked again itself (the Generate page after its TBA rooms or
  // policy save) needs no second check; another tab's or user's change always checks again.
  useDataChanges(['assignments', 'faculty', 'sections', 'rooms', 'curriculum', 'policy', 'schedule', 'outsideTeachers'], (change) => {
    if (!change?.remote && Date.now() - lastRecheckAt.current < 1000) return;
    recheck();
  });

  // The gateway ran the same check again (a refused start answers 400 with its report): show that one.
  const replaceReport = useCallback((report) => {
    if (!report?.readiness) return;
    latest.current += 1;
    setRecheckingFor(null);
    setAnswer({ termKey, status: 'done', report, message: '' });
  }, [termKey]);

  const current = answer?.termKey === termKey ? answer : null;
  const state = {
    status: !current || recheckingFor === termKey ? 'checking' : current.status,
    report: current?.report || null,
    message: current?.status === 'error' ? current.message : ''
  };
  return { state, recheck, replaceReport };
}
