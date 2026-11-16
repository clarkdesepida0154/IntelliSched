import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, AlertOctagon, ArrowRight, CalendarDays, Check, CheckCircle2, FileSignature, Loader2, Play, RefreshCw, ShieldCheck, X
} from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import PageHeader from '../../components/layout/PageHeader';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import usePermission from '../../hooks/usePermission';
import { whoSigns } from '../../utils/permissionText';
import { conflictsText } from '../../utils/gaRun';
import { tbaRoomWording } from '../../utils/scheduleDisplay';
import { checkOf, checkText, hasClasses, isOfficial, namesText, statusBadgeClass, statusOf } from '../../utils/versions';
import Select from '../../components/ui/Select';

// Approval (Phase 3 Step 5): one version of the term, signed off stage by stage.
//   1. Check for conflicts   the version's real check (lastCheck, from GET /schedule/versions): "0
//                            conflicts, checked 30 Sep 2026 10:42 PM", "N conflicts" with the way to fix
//                            them, or "Not checked yet" with "Check now" (POST /schedule/validate, which
//                            the gateway keeps as the version's lastCheck);
//   2. Review                   the Dean (Phase 8 Part 8: one account; she sends the version for review
//                               after checking the conflicts and the corrections): Draft -> Under Review;
//   3. Dean sign-off            the Dean: Under Review -> Approved, final (the version approved before is
//                               archived). Phase 8 Part 6 (decision 2): there is no Publish; an Approved
//                               version is exported and printed as it is.
// Every sign-off asks first, naming the versions it changes, and sends POST /schedule/approve-stage
// { scheduleId, academicYear, semester, stepNumber, notes }. The gateway checks the version again and
// refuses one with conflicts (409 HAS_CONFLICTS, with the conflicts); the sign-off button is disabled,
// with the reason, while the version has conflicts or has never been checked. Only versions with
// classes that are not archived are listed (not a lock-only Draft, not a legacy version).
// Test ids: approval-version, approval-version-status, approval-stage-{1..3} (data-status done | next
// | waiting | attention | todo), approval-stage-{1..3}-who (who signs it), approval-signed-by (the next
// stage's), approval-check-result, approval-check-now, approval-check-error,
// approval-violations, approval-open-editor, approval-open-versions, approval-next, approval-remarks,
// approval-signoff, approval-signoff-reason, approval-signoff-error, approval-confirm(-title | -keep |
// -confirm), approval-approved, approval-toast, approval-loading, approval-error, approval-retry,
// approval-empty.

const CONNECTION_HELP = 'Check that the gateway is running, then try again.';
const SHOWN_VIOLATIONS = 10;

// GET /schedule/versions of the term (newest first).
const fetchVersions = async (academicYear, semester) => {
  const res = await api.get('/schedule/versions', { params: { academicYear, semester } });
  return Array.isArray(res.data?.versions) ? res.data.versions : [];
};
const versionsError = (err) => `The term's versions could not be read (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".`;
const classCount = (n) => `${n} class${Number(n) === 1 ? '' : 'es'}`;

// The stages and who signs them. Each sign-off is one action of the permission map (Phase 3 Step 6; the
// gateway checks the same action for each stepNumber): stage 2 approval.chairReview, stage 3
// approval.deanSignOff. `who` comes from the map too (whoSigns,
// utils/permissionText.js), in the Dean's words: "The Dean" for both stages with today's map
// (Phase 8 Part 8: one account).
const STAGES = [
  {
    n: 1, name: 'Check for conflicts', who: 'Anyone reviewing the schedule',
    desc: 'The whole version is checked for conflicts, as in the Schedule Views & Editor. Every sign-off checks it again and is refused while it has any.'
  },
  {
    n: 2, step: 2, from: 'Draft', name: 'Review', action: 'approval.chairReview',
    desc: 'Send for review: the conflicts and the corrections are checked, the classes and the loads with them. The version becomes Under Review, and its classes can no longer be moved.'
  },
  {
    n: 3, step: 3, from: 'Under Review', name: 'Dean sign-off', action: 'approval.deanSignOff',
    desc: "The Dean approves the version: it becomes the term's final Mother Schedule, exported and printed as it is, and the version approved before is archived."
  }
].map(stage => (stage.action ? { ...stage, who: whoSigns(stage.action) } : stage));
// Approved is final: no stage follows it (Phase 8 Part 6).
const NEXT_STAGE = { Draft: 2, 'Under Review': 3, Approved: 4 };
const NEXT_STATUS = { 2: 'Under Review', 3: 'Approved' };

const STAGE_LOOK = {
  done: { label: 'Done', badge: 'bg-green-100 dark:bg-green-500/15 text-green-800 dark:text-green-300 border-green-200 dark:border-green-500/30', circle: 'bg-green-600 text-white border-green-600' },
  next: { label: 'Next', badge: 'bg-violet-100 dark:bg-violet-500/20 text-violet-800 dark:text-violet-200 border-violet-200 dark:border-violet-500/30', circle: 'bg-violet-600 text-white border-violet-600' },
  todo: { label: 'To do', badge: 'bg-blue-50 dark:bg-blue-500/10 text-blue-900 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', circle: 'bg-white dark:bg-[#1a1a1c] text-blue-900 dark:text-blue-200 border-blue-300 dark:border-blue-500/40' },
  attention: { label: 'Needs attention', badge: 'bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30', circle: 'bg-red-600 text-white border-red-600' },
  waiting: { label: 'Not yet', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700', circle: 'bg-white dark:bg-[#1a1a1c] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700' }
};

// The later of two checks of the same version (the stored one, and one this page just ran or was
// refused with).
const newerCheck = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(b.checkedAt).getTime() > new Date(a.checkedAt).getTime() ? b : a;
};

// The sign-off of a stage: its button, its question and exactly what it changes. `earlier` are the
// term's other Approved versions, which an approval archives.
const signOffOf = (stage, v, earlier) => {
  const name = v.id;
  const archivedLine = earlier.length
    ? `${namesText(earlier)} (${earlier.length === 1 ? 'the version approved before' : 'the versions approved before'}) ${earlier.length === 1 ? 'is' : 'are'} archived.`
    : '';
  if (stage.step === 2) {
    return {
      button: `Send ${name} for review`,
      title: `Send ${name} for review?`,
      body: [`This signs the review: ${name} becomes Under Review and goes to the Dean for sign-off.`, `Its classes can no longer be moved; to change it later, restore it as a new Draft.`]
    };
  }
  return {
    button: `Approve ${name}`,
    title: `Approve ${name}?`,
    body: [
      archivedLine ? `${name} becomes the approved Mother Schedule; ${archivedLine}` : `${name} becomes the approved Mother Schedule of this term.`,
      "Approved is final: its exports and prints carry no DRAFT line, and its classes can't be moved any more. To change it later, restore it as a new Draft."
    ]
  };
};

// The way out of conflicts: a Draft is fixed in the editor; a version sent on can no longer be
// changed, so it is restored as a new Draft first.
const conflictsWayOut = (v, hard) => (statusOf(v) === 'Draft'
  ? `${v.id} has ${conflictsText(hard)}: fix ${hard === 1 ? 'it' : 'them'} in the Schedule Views & Editor, then check again.`
  : `${v.id} has ${conflictsText(hard)}, and its classes can't be moved any more (it is ${statusOf(v)}): restore it as a new Draft on the Versions page and fix ${hard === 1 ? 'it' : 'them'} there.`);

function Stage({ stage, status, children }) {
  const look = STAGE_LOOK[status] || STAGE_LOOK.waiting;
  const titleId = `approval-stage-${stage.n}-title`;
  return (
    <li
      data-testid={`approval-stage-${stage.n}`}
      data-status={status}
      aria-labelledby={titleId}
      aria-current={status === 'next' ? 'step' : undefined}
      className={`p-4 rounded-2xl border bg-white dark:bg-[#1a1a1c] flex gap-4 ${status === 'next' ? 'border-violet-400 dark:border-violet-500/60 ring-1 ring-violet-400/40' : 'border-slate-200 dark:border-slate-800'}`}
    >
      <div aria-hidden="true" className={`w-9 h-9 shrink-0 rounded-full border-2 flex items-center justify-center text-sm font-black ${look.circle}`}>
        {status === 'done' ? <Check size={18} /> : status === 'attention' ? <AlertOctagon size={16} /> : stage.n}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 id={titleId} className="text-sm font-black text-slate-900 dark:text-white">{stage.n}. {stage.name}</h3>
          <span data-testid={`approval-stage-${stage.n}-status`} className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${look.badge}`}>{look.label}</span>
        </div>
        <p data-testid={`approval-stage-${stage.n}-who`} className="text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">{stage.who}</p>
        <p className="text-xs text-slate-600 dark:text-slate-400">{stage.desc}</p>
        {children}
      </div>
    </li>
  );
}

// The page for the term chosen in the top bar; a term switch starts it afresh (key), so nothing of
// the previous term's versions stays on screen.
export default function ApprovalWorkflow(props) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  return <ApprovalPage key={`${activeAcademicYear}|${activeSemesterNumber}`} {...props} />;
}

function ApprovalPage({ onNavigate = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const term = { academicYear: activeAcademicYear, semester: activeSemesterNumber };
  // Who may sign each stage: the permission map, by the stage's action (step 1, the check, is open to all).
  const chairReview = usePermission('approval.chairReview');
  const deanSignOff = usePermission('approval.deanSignOff');
  const stagePermissions = { 'approval.chairReview': chairReview, 'approval.deanSignOff': deanSignOff };

  // ---------------------------------------------------------------- the term's versions
  // { status: 'loading' | 'ready' | 'error', versions, message, refreshing }. Only the newest read may
  // settle it (loadSeq), so a slow older answer never replaces a newer one.
  const [list, setList] = useState({ status: 'loading', versions: [], message: '', refreshing: false });
  const loadSeq = useRef(0);
  useEffect(() => {
    const seq = ++loadSeq.current;
    fetchVersions(activeAcademicYear, activeSemesterNumber)
      .then(versions => { if (seq === loadSeq.current) setList({ status: 'ready', versions, message: '', refreshing: false }); })
      .catch(err => { if (seq === loadSeq.current) setList({ status: 'error', versions: [], message: versionsError(err), refreshing: false }); });
    return () => { loadSeq.current += 1; };
  }, [activeAcademicYear, activeSemesterNumber]);
  // "Try again", and the read after a sign-off (refresh: the page stays as it is meanwhile).
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

  const [selectedId, setSelectedId] = useState('');
  // Checks this page ran ("Check now") or was refused with (409 HAS_CONFLICTS), by version id:
  // { checkedAt, hardTotal, violations }. The gateway stores each one on the version as well.
  const [checks, setChecks] = useState({});
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [remarks, setRemarks] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [signError, setSignError] = useState('');
  const nextHeadingRef = useRef(null);

  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = (message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 8000);
  };
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const versions = list.versions;
  const listed = versions.filter(v => hasClasses(v) && statusOf(v) !== 'Archived');
  // The version shown: the one chosen, else the newest one listed (the list is newest first).
  const selected = listed.find(v => String(v.mongoId) === selectedId) || listed[0] || null;
  const id = selected ? String(selected.mongoId) : '';
  const status = statusOf(selected);
  const localCheck = checks[id] || null;
  const check = selected ? newerCheck(checkOf(selected), localCheck) : null;
  const violations = check && localCheck && check === localCheck ? localCheck.violations || [] : null;
  const nextStep = NEXT_STAGE[status] || 2;
  const stage = STAGES.find(s => s.step === nextStep) || null;
  // The term's other official versions: approving archives them.
  const earlier = selected ? versions.filter(v => isOfficial(v) && String(v.mongoId) !== id) : [];
  const signOff = stage && selected ? signOffOf(stage, selected, earlier) : null;
  // A Draft changed after its check (a class moved, an assignment changed): the sign-off checks it again.
  const changedAfterCheck = Boolean(check && status === 'Draft' && selected.updatedAt
    && new Date(selected.updatedAt).getTime() > new Date(check.checkedAt).getTime());

  const chooseVersion = (value) => {
    setSelectedId(value);
    setCheckError('');
    setSignError('');
  };

  // ---------------------------------------------------------------- "Check now"
  const runCheck = async () => {
    if (!selected || isChecking) return;
    const target = selected;
    const targetId = String(target.mongoId);
    setIsChecking(true);
    setCheckError('');
    setSignError('');
    try {
      const res = await api.post('/schedule/validate', { scheduleId: targetId });
      setChecks(prev => ({
        ...prev,
        [targetId]: {
          checkedAt: res.data?.checkedAt || new Date().toISOString(),
          hardTotal: Number(res.data?.hardTotal) || 0,
          violations: Array.isArray(res.data?.violations) ? res.data.violations : []
        }
      }));
    } catch (err) {
      setCheckError(`${target.id} could not be checked (${err.response?.data?.message || err.message}). ${CONNECTION_HELP}`);
    } finally {
      setIsChecking(false);
    }
  };

  // ---------------------------------------------------------------- the sign-off
  // A role the map does not allow for this stage is told so first (the map's reason).
  const stagePermission = stage ? stagePermissions[stage.action] || null : null;
  const roleMaySign = Boolean(stagePermission?.allowed);
  const signBlockedReason = !selected || !stage ? ''
    : !roleMaySign ? (stagePermission?.reason || 'Your role cannot sign this stage.')
      : isSubmitting ? 'Sending the sign-off…'
        : list.refreshing ? "Reading the term's versions again…"
          : isChecking ? `Checking ${selected.id} for conflicts…`
            : !check ? `${selected.id} has not been checked yet: press "Check now" in step 1 first.`
              : check.hardTotal > 0 ? conflictsWayOut(selected, check.hardTotal)
                : '';

  const requestSignOff = () => {
    if (!signOff || signBlockedReason) return;
    setSignError('');
    setConfirming(true);
  };

  const sendSignOff = async () => {
    if (!selected || !stage || !roleMaySign || isSubmitting) return;
    const target = selected;
    const targetId = String(target.mongoId);
    setIsSubmitting(true);
    try {
      const res = await api.post('/schedule/approve-stage', {
        scheduleId: targetId,
        academicYear: term.academicYear,
        semester: term.semester,
        stepNumber: stage.step,
        notes: remarks.trim()
      });
      setConfirming(false);
      setRemarks('');
      setSignError('');
      // The answer's status, the check the stage kept on the version and the versions it archived are
      // shown at once; the list is then read again for the rest.
      const newStatus = res.data?.status || NEXT_STATUS[stage.step];
      const stageCheck = res.data?.lastCheck?.checkedAt && Number.isFinite(res.data.lastCheck.hardTotal) ? res.data.lastCheck : null;
      const archivedIds = new Set((Array.isArray(res.data?.archived) ? res.data.archived : []).map(a => String(a.id)));
      setList(prev => ({
        ...prev,
        versions: prev.versions.map(v => {
          const vid = String(v.mongoId);
          if (vid === targetId) return { ...v, status: newStatus, workflowStatus: newStatus, currentDraft: false, ...(stageCheck ? { lastCheck: stageCheck } : {}) };
          return archivedIds.has(vid) ? { ...v, status: 'Archived', workflowStatus: 'Archived' } : v;
        })
      }));
      setChecks(prev => {
        const next = { ...prev };
        delete next[targetId];
        return next;
      });
      setSelectedId(targetId);
      showToast(res.data?.message || `${target.id} is now ${newStatus}.`);
      loadVersions({ refresh: true });
    } catch (err) {
      const code = err.response?.status;
      const body = err.response?.data || {};
      setConfirming(false);
      if (code === 409 && body.code === 'HAS_CONFLICTS') {
        // Refused: the gateway checked the version again and kept that check on it; nothing else changed.
        const hard = Number(body.hardTotal) || 0;
        setChecks(prev => ({
          ...prev,
          [targetId]: { checkedAt: body.checkedAt || new Date().toISOString(), hardTotal: hard, violations: Array.isArray(body.violations) ? body.violations : [] }
        }));
        setSignError(`Not signed: ${statusOf(target) === 'Draft' ? body.message || conflictsWayOut(target, hard) : conflictsWayOut(target, hard)} Nothing else changed.`);
      } else if (code === 403) {
        setSignError(`Not signed: ${body.message || 'your role cannot sign this stage.'} Nothing changed.`);
      } else if (code === 409 || code === 404 || code === 400) {
        // The version changed meanwhile (signed elsewhere, archived, or not of this term): read it again.
        setSignError(`Not signed: ${body.message || 'the version could not take this stage.'} Nothing changed.`);
        loadVersions({ refresh: true });
      } else {
        setSignError(`The sign-off could not be sent (${body.message || err.message}). Nothing changed, and your remarks are still here. ${CONNECTION_HELP}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---------------------------------------------------------------- what each stage shows
  const stageStatus = (s) => {
    if (s.n === 1) return !check ? 'todo' : check.hardTotal > 0 ? 'attention' : 'done';
    if (s.step < nextStep) return 'done';
    if (s.step === nextStep) return 'next';
    return 'waiting';
  };
  const openEditor = () => onNavigate?.('schedule-views', { scheduleId: id });
  const linkButton = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-violet-500';
  const primaryLink = `${linkButton} text-white bg-violet-600 hover:bg-violet-700 border-violet-600`;
  const secondaryLink = `${linkButton} text-violet-900 dark:text-violet-200 bg-violet-50 dark:bg-violet-500/10 border-violet-200 dark:border-violet-500/30 hover:bg-violet-100 dark:hover:bg-violet-500/20`;

  const checkStage = selected && (
    <div className="space-y-2 pt-1">
      <p data-testid="approval-check-result" data-conflicts={check ? String(check.hardTotal) : ''} className={`text-sm font-bold ${!check ? 'text-slate-800 dark:text-slate-100' : check.hardTotal > 0 ? 'text-red-700 dark:text-red-400' : 'text-green-800 dark:text-green-300'}`}>
        {checkText(check)}
      </p>
      {changedAfterCheck && (
        <p data-testid="approval-check-stale" className="text-xs text-slate-700 dark:text-slate-300">
          {selected.id} changed after this check (a class moved or an assignment changed). Check it again; every sign-off checks it again too.
        </p>
      )}
      {violations && violations.length > 0 && (
        <ul data-testid="approval-violations" className="list-disc pl-5 space-y-0.5 text-xs text-red-800 dark:text-red-300">
          {violations.slice(0, SHOWN_VIOLATIONS).map((v, i) => <li key={i}>{tbaRoomWording(v.message)}</li>)}
          {violations.length > SHOWN_VIOLATIONS && <li>And {violations.length - SHOWN_VIOLATIONS} more: see them all in the Schedule Views &amp; Editor.</li>}
        </ul>
      )}
      {checkError && (
        <p role="alert" data-testid="approval-check-error" className="flex items-start gap-1.5 text-xs font-bold text-red-700 dark:text-red-400">
          <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {checkError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="approval-check-now"
          onClick={runCheck}
          disabled={isChecking || isSubmitting}
          className={check ? secondaryLink : primaryLink}
        >
          {isChecking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {isChecking ? 'Checking…' : check ? 'Check again' : 'Check now'}
        </button>
        {check && check.hardTotal > 0 && onNavigate && (
          <button type="button" data-testid="approval-open-editor" onClick={openEditor} className={secondaryLink}>
            {status === 'Draft' ? 'Fix them in the Schedule Views & Editor' : 'See them in the Schedule Views & Editor'} <ArrowRight size={13} aria-hidden="true" />
          </button>
        )}
        {check && check.hardTotal > 0 && status !== 'Draft' && onNavigate && (
          <button type="button" data-testid="approval-open-versions" onClick={() => onNavigate('versions')} className={secondaryLink}>
            Restore it on the Versions page <ArrowRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-6">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex items-center justify-between gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="approval" />
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {list.status === 'loading' ? (
          <div data-testid="approval-loading" role="status" className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-300 gap-3">
            <Loader2 size={36} className="animate-spin text-violet-500" aria-hidden="true" />
            <p className="text-xs font-bold uppercase tracking-wider">Reading the term&apos;s versions…</p>
          </div>
        ) : list.status === 'error' ? (
          <div data-testid="approval-error" role="alert" className="p-12 text-center max-w-lg mx-auto my-6">
            <AlertOctagon size={40} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The versions can&apos;t be shown</h3>
            <p className="text-sm text-slate-700 dark:text-slate-300 mb-4">{list.message}</p>
            <button type="button" data-testid="approval-retry" onClick={() => loadVersions()} className={`${primaryLink} mx-auto`}>
              <RefreshCw size={13} aria-hidden="true" /> Try again
            </button>
          </div>
        ) : !selected ? (
          <div data-testid="approval-empty" className="p-12 text-center max-w-lg mx-auto my-6">
            <CalendarDays size={40} className="text-slate-400 mx-auto mb-3" aria-hidden="true" />
            <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">No version to sign off yet</h3>
            <p className="text-sm text-slate-700 dark:text-slate-300 mb-4">
              {versions.length === 0
                ? 'No schedule has been generated for this term yet. Generate a Draft, check it, then sign it off here.'
                : "This term's versions are archived, saved in the older format, or hold assignments only (no classes). Generate a new Draft, or restore an archived version as a new Draft on the Versions page."}
            </p>
            {onNavigate && (
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" data-testid="approval-open-generate" onClick={() => onNavigate('generate')} className={primaryLink}>
                  <Play size={13} aria-hidden="true" /> Open Generate Schedule
                </button>
                {versions.length > 0 && (
                  <button type="button" data-testid="approval-empty-open-versions" onClick={() => onNavigate('versions')} className={secondaryLink}>
                    Open Versions <ArrowRight size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* VERSION */}
            <div className="px-6 md:px-8 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="flex flex-wrap items-center gap-3 min-w-0">
                <label htmlFor="approval-version" className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">Version</label>
                <Select
                  id="approval-version"
                  data-testid="approval-version"
                  value={id}
                  onChange={(e) => chooseVersion(e.target.value)}
                  disabled={isSubmitting}
                  aria-describedby="approval-version-help"
                  className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white max-w-full disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
                >
                  {listed.map(v => (
                    <option key={String(v.mongoId)} value={String(v.mongoId)}>
                      {`${v.id} · ${statusOf(v)} · ${v.date}${v.currentDraft ? ' · current Draft' : ''}`}
                    </option>
                  ))}
                </Select>
                <span data-testid="approval-version-status" className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold border ${statusBadgeClass(status)}`}>{status}</span>
                <span data-testid="approval-version-facts" className="text-xs text-slate-700 dark:text-slate-300">
                  {[classCount(selected.totalScheduled), selected.source].filter(Boolean).join(' · ')}
                </span>
                {list.refreshing && (
                  <span role="status" className="inline-flex items-center text-xs font-bold text-slate-700 dark:text-slate-200">
                    <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> Reading the versions again…
                  </span>
                )}
              </div>
              <p id="approval-version-help" className="text-xs text-slate-600 dark:text-slate-400 lg:ml-auto">
                Only versions with classes that are not archived are listed.
              </p>
            </div>
            {list.message && (
              <p role="alert" className="mx-6 md:mx-8 mt-4 text-xs font-bold text-red-700 dark:text-red-400">{list.message}</p>
            )}

            <div className="p-6 md:p-8 bg-slate-50/50 dark:bg-[#09090b] grid grid-cols-1 xl:grid-cols-2 gap-6 xl:gap-8">

              {/* THE STAGES */}
              <ol aria-label={`Approval stages of ${selected.id}`} className="space-y-3">
                {STAGES.map(s => (
                  <Stage key={s.n} stage={s} status={stageStatus(s)}>
                    {s.n === 1 && checkStage}
                  </Stage>
                ))}
              </ol>

              {/* THE NEXT SIGN-OFF */}
              <section aria-labelledby="approval-next" className="bg-white dark:bg-[#1a1a1c] p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm self-start space-y-4">
                {!stage ? (
                  <div data-testid="approval-approved" className="space-y-3">
                    <h3 id="approval-next" ref={nextHeadingRef} tabIndex={-1} className="text-lg font-black text-slate-900 dark:text-white flex items-center focus:outline-none">
                      <ShieldCheck className="mr-2 text-green-600 dark:text-green-400" size={20} aria-hidden="true" /> {selected.id} is Approved
                    </h3>
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                      It is the term&apos;s final Mother Schedule: export and print it as it is, with no DRAFT line. Its classes can&apos;t be moved; to change it, restore it as a new Draft on the Versions page.
                    </p>
                    {onNavigate && (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" data-testid="approval-open-print" onClick={() => onNavigate('print-outputs')} className={primaryLink}>
                          Open Print Outputs <ArrowRight size={13} aria-hidden="true" />
                        </button>
                        <button type="button" data-testid="approval-open-versions-approved" onClick={() => onNavigate('versions')} className={secondaryLink}>
                          Open Versions <ArrowRight size={13} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div>
                      <h3 id="approval-next" data-testid="approval-next" ref={nextHeadingRef} tabIndex={-1} className="text-lg font-black text-slate-900 dark:text-white flex items-center focus:outline-none">
                        <FileSignature className="mr-2 text-violet-600 dark:text-violet-400" size={20} aria-hidden="true" /> Next: {stage.name}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                        Signed by: <strong data-testid="approval-signed-by" className="text-slate-800 dark:text-slate-200">{stage.who}</strong>
                      </p>
                    </div>

                    <div>
                      <label htmlFor="approval-remarks" className="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                        Remarks (optional)
                      </label>
                      <textarea
                        id="approval-remarks"
                        data-testid="approval-remarks"
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        disabled={isSubmitting || !roleMaySign}
                        maxLength={500}
                        aria-describedby={roleMaySign ? 'approval-remarks-help' : 'approval-remarks-help approval-signoff-reason'}
                        placeholder="For example: loads checked with the College Secretary."
                        className="w-full bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-xl py-2.5 px-3 text-xs focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500 text-slate-900 dark:text-white min-h-24 resize-y disabled:opacity-50"
                      />
                      <p id="approval-remarks-help" className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">Saved with the sign-off; the Audit Trail shows them.</p>
                    </div>

                    <div className="space-y-2">
                      <button
                        type="button"
                        data-testid="approval-signoff"
                        onClick={requestSignOff}
                        disabled={Boolean(signBlockedReason)}
                        aria-describedby={signBlockedReason ? 'approval-signoff-reason' : undefined}
                        className="w-full bg-violet-600 hover:bg-violet-700 disabled:bg-slate-500 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white py-3 rounded-xl font-bold tracking-wide transition-colors shadow-md shadow-violet-900/20 flex justify-center items-center cursor-pointer text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-violet-500"
                      >
                        {isSubmitting ? <Loader2 className="animate-spin mr-2" size={16} aria-hidden="true" /> : <FileSignature className="mr-2" size={16} aria-hidden="true" />}
                        {isSubmitting ? 'Signing…' : signOff.button}
                      </button>
                      {signBlockedReason && (
                        <p id="approval-signoff-reason" data-testid="approval-signoff-reason" className="text-xs text-slate-700 dark:text-slate-300">{signBlockedReason}</p>
                      )}
                      {signError && (
                        <p role="alert" data-testid="approval-signoff-error" className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
                          <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {signError}
                        </p>
                      )}
                    </div>
                    {check && check.hardTotal === 0 && (
                      <p className="text-[11px] text-slate-600 dark:text-slate-400">
                        Last check: {checkText(check)}. The sign-off checks {selected.id} again first.
                      </p>
                    )}
                  </>
                )}
              </section>
            </div>
          </>
        )}
      </div>

      {confirming && signOff && (
        <ConfirmDialog
          testId="approval-confirm"
          title={signOff.title}
          keepLabel="Cancel"
          confirmLabel={signOff.button}
          busyLabel="Signing…"
          onKeep={() => { if (!isSubmitting) setConfirming(false); }}
          onConfirm={sendSignOff}
          busy={isSubmitting}
          tone="violet"
          icon={FileSignature}
          returnFocusRef={nextHeadingRef}
        >
          {signOff.body.map((line, i) => <p key={i} className={i ? 'mt-2' : ''}>{line}</p>)}
          {remarks.trim() && <p className="mt-2">Your remarks are saved with the sign-off.</p>}
        </ConfirmDialog>
      )}

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 dark:bg-violet-500/15 flex items-center justify-center text-violet-400 dark:text-violet-600 shrink-0">
            <CheckCircle2 size={16} aria-hidden="true" />
          </div>
          <span data-testid="approval-toast" className="text-xs font-bold tracking-wide">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-2 text-slate-400 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
