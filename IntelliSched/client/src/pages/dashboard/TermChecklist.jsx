import { useCallback, useEffect, useState } from 'react';
import { AlertOctagon, ArrowRight, Check, Loader2, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import PageHeader from '../../components/layout/PageHeader';
import BackupWarnings from '../../components/system/BackupWarnings';
import ReadinessPanel from '../../components/readiness/ReadinessPanel';
import useReadiness from '../../components/readiness/useReadiness';
import useDataChanges from '../../hooks/useDataChanges';
import { pageOf } from '../../navigation/pages';
import { conflictsText, failedRunTitle, isActiveRun, personText, timeOf } from '../../utils/gaRun';

// The Term Checklist (Phase 3 Step 4), the Main page: where the term chosen in the top bar stands, in
// the Dean's six steps, each with its status from real data and a link to its next action. A step is
// "Done" only when its data says so. Nothing is counted here: the numbers are the gateway's.
//   1. Set up data        the Readiness Check's data line (report.dataLine) and its data problems;
//   2. Assign faculty     report.numbers.assignment, per subject-section pair;
//   3. Readiness          the Readiness panel, compact (report.readiness);
//   4. Generate           the newest generated version, its conflicts and when it was made (GET
//                         /schedule/versions), or a run that is going or failed (GET /schedule/runs);
//                         while either is read the step is "Checking…", and when either could not be
//                         read it says so and offers Try again (never a "done" from half the data);
//   5. Review             the newest version's last "Validate schedule" (lastCheck) and its class moves
//                         since the run (editedAfterRun): done only when that check found 0 conflicts;
//   6. Approve & print    the approval stage of the term's versions (a newer one under review is named,
//                         not hidden by an older official one), whether the outputs can be printed, and
//                         which version Print Outputs prints when none is chosen.
// Test ids: checklist-refresh, checklist-summary, checklist-steps, checklist-step-{n} (data-status done |
// todo | attention | running | waiting | loading | error, data-step, aria-current="step" on the next
// one), checklist-step-{n}-status, checklist-step-{n}-text, checklist-link-{page key}, checklist-retry.

// A data problem and the page that fixes it (the report's codes, never its text).
const DATA_FIX_PAGE = { NO_DEMANDS: 'subjects', SECTION_TRACK: 'sections', FACULTY_INCOMPLETE: 'faculty', ROOM_TYPE: 'rooms', CAPACITY: 'rooms' };
const COUNTED = [
  { key: 'sections', one: 'section', page: 'sections', none: 'No active sections yet.' },
  { key: 'subjects', one: 'subject', page: 'subjects', none: 'No subjects are placed in the curriculum for this term yet.' },
  { key: 'professors', one: 'professor', page: 'faculty', none: 'No active professors yet.' },
  { key: 'rooms', one: 'room', page: 'rooms', none: 'No active rooms yet.' }
];
const SHOWN_PROBLEMS = 3;

const STATUS = {
  done: { label: 'Done', badge: 'bg-green-100 dark:bg-green-500/15 text-green-800 dark:text-green-300 border-green-200 dark:border-green-500/30', circle: 'bg-green-600 text-white border-green-600' },
  todo: { label: 'To do', badge: 'bg-blue-50 dark:bg-blue-500/10 text-blue-900 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', circle: 'bg-white dark:bg-[#1a1a1c] text-blue-900 dark:text-blue-200 border-blue-300 dark:border-blue-500/40' },
  attention: { label: 'Needs attention', badge: 'bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30', circle: 'bg-red-600 text-white border-red-600' },
  running: { label: 'In progress', badge: 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-800 dark:text-indigo-200 border-indigo-200 dark:border-indigo-500/30', circle: 'bg-white dark:bg-[#1a1a1c] text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-500/40' },
  waiting: { label: 'Not yet', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700', circle: 'bg-white dark:bg-[#1a1a1c] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700' },
  loading: { label: 'Checking…', badge: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700', circle: 'bg-white dark:bg-[#1a1a1c] text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700' },
  error: { label: 'Could not check', badge: 'bg-amber-50 dark:bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', circle: 'bg-white dark:bg-[#1a1a1c] text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-500/40' }
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const nameOf = (key) => pageOf(key)?.name || key;
const link = (key, params) => ({ key, params: params || null });
const STATUS_WORDS = { Draft: 'Draft', 'Under Review': 'under review', Approved: 'Approved', Archived: 'Archived' };
const isShown = (v) => !v.legacy && Number(v.totalScheduled) > 0;

// ---------------------------------------------------------------- the six steps, from the data
const loadingStep = (text) => ({ status: 'loading', lines: [text] });
const errorStep = (message) => ({ status: 'error', lines: [message], retry: true });

const dataStep = (readiness) => {
  const report = readiness.report;
  if (!report) return readiness.status === 'error' ? errorStep(readiness.message) : loadingStep('Checking the term…');
  const d = report.dataLine || {};
  const counts = COUNTED.map(c => plural(Number(d[c.key]) || 0, c.one)).join(', ');
  const empty = COUNTED.filter(c => !(Number(d[c.key]) > 0));
  // "Nothing to schedule" says again what a missing section or subject already says.
  const noSectionsOrSubjects = empty.some(c => c.key === 'sections' || c.key === 'subjects');
  const problems = (report.errors || []).filter(e => DATA_FIX_PAGE[e.code] && !(e.code === 'NO_DEMANDS' && noSectionsOrSubjects));
  const messages = [...new Set([...empty.map(c => c.none), ...problems.map(e => e.message)])];
  const firstPage = empty[0]?.page || (problems[0] ? DATA_FIX_PAGE[problems[0].code] : null);
  if (!messages.length) return { status: 'done', lines: [`Data complete: ${counts}`], links: [link('subjects')] };
  return {
    status: 'todo',
    lines: [`Data not complete: ${counts}`, ...messages.slice(0, SHOWN_PROBLEMS), ...(messages.length > SHOWN_PROBLEMS ? [`And ${plural(messages.length - SHOWN_PROBLEMS, 'more problem')} (see the Readiness Check).`] : [])],
    links: [link(firstPage)]
  };
};

const assignStep = (readiness) => {
  const report = readiness.report;
  if (!report) return readiness.status === 'error' ? errorStep(readiness.message) : loadingStep('Checking the assignments…');
  const a = report.numbers?.assignment;
  if (!a) return errorStep('The gateway answered without the assignment counts; restart it so it runs the Phase 3 code.');
  const lines = [`Major classes assigned: ${a.majorAssigned} of ${a.majorPairs}`];
  if (a.minorPairs > 0) lines.push(`Minor classes with a CCS professor: ${a.minorAssigned} of ${a.minorPairs} (the rest are TBA)`);
  if (a.practicumPairs > 0) lines.push(`Practicum coordinators: ${a.practicumWithCoordinator} of ${a.practicumPairs}`);
  const links = [link('assign-faculty', { tab: 'by-class' })];
  if (a.majorPairs === 0) return { status: 'waiting', lines: ['No Major classes to assign yet: place the term\'s subjects in the curriculum first.'], links };
  const done = a.majorAssigned === a.majorPairs && a.practicumWithCoordinator === a.practicumPairs;
  return { status: done ? 'done' : 'todo', lines, links };
};

const readinessStep = (readiness) => {
  const report = readiness.report;
  if (!report) return readiness.status === 'error' ? errorStep(readiness.message) : loadingStep('Checking whether the term is ready…');
  return { status: report.readiness?.verdict === 'ready' ? 'done' : 'attention', lines: [], panel: true, links: [link('readiness')] };
};

// "v1 (Draft), made Sep 30, 2026, 10:42 PM: 0 conflicts"
const generatedLine = (v) => {
  const hard = v.gaStats?.finalHard;
  return `${v.id} (${STATUS_WORDS[v.workflowStatus] || v.workflowStatus}), made ${v.date}: ${Number.isFinite(hard) ? conflictsText(hard) : 'conflicts not recorded'}`;
};

const generateStep = (versionsState, runsState, readiness) => {
  if (versionsState.status === 'loading') return loadingStep('Reading the term\'s versions…');
  if (versionsState.status === 'error') return errorStep(versionsState.message);
  // Until the runs are read, a run that is going (or a last run that failed) is not known yet.
  if (runsState.status === 'loading') return loadingStep('Checking whether a run is going…');
  const links = [link('generate')];
  const generated = versionsState.versions.find(v => isShown(v) && v.gaStats);
  if (runsState.status === 'error') {
    // The versions alone could read "To do" or "Done" while a run is going: the step says what could
    // not be read, keeps what the versions say, and offers Try again.
    return { status: 'error', lines: [runsState.message, ...(generated ? [generatedLine(generated)] : [])], links, retry: true };
  }
  const newest = runsState.newest;
  if (newest && isActiveRun(newest)) {
    return { status: 'running', lines: [`A run is going: started by ${personText(newest.startedBy)}${newest.startedAt ? ` at ${timeOf(newest.startedAt)}` : ''}.`], links };
  }
  // The run's title in the Dean's words (a run recorded before Phase 3 Step 4 stored a technical one).
  const failedLast = newest?.status === 'failed' ? `The last run did not save a schedule: ${failedRunTitle(newest).replace(/\.?$/, '.')}` : '';
  if (generated) {
    const hard = generated.gaStats?.finalHard;
    return {
      status: hard === 0 ? 'done' : 'attention',
      lines: [generatedLine(generated), ...(failedLast ? [failedLast] : [])],
      links
    };
  }
  if (failedLast) return { status: 'attention', lines: [failedLast], links };
  const ready = readiness.report?.readiness?.verdict === 'ready';
  return { status: ready ? 'todo' : 'waiting', lines: [ready ? 'Not generated yet: the term is ready.' : 'Not generated yet: finish the steps above first.'], links };
};

// What a version that was sent on can no longer become while its last check found conflicts.
const BLOCKED_STAGE = { 'Under Review': ": it can't be approved as it is" };

// The version the Dean reviews: the term's newest version with classes that is not archived. Its
// review is done only when its last "Check the whole schedule" found 0 conflicts (every approval stage
// stores that check too). A version sent on (under review, approved) can no longer be edited: with
// conflicts, the way out is a restored Draft or a new one.
// Phase 4 Part 1 (Step 3): what the version really did about rooms, from its own recorded facts
// (gaStats.tbaRoomsUsed, the TBA rooms that received classes; gaStats.classesInTbaRooms): "TBA rooms to
// request: 6 (3 lab, 3 lecture), holding 85 classes." with a link to the Room Program's list, or "TBA
// rooms to request: none." Nothing when the version recorded no such facts (an older one).
const tbaRoomsLine = (version) => {
  const used = version.gaStats?.tbaRoomsUsed;
  if (!used || !Number.isFinite(used.lab) || !Number.isFinite(used.lec)) return null;
  const total = used.lab + used.lec;
  if (total === 0) return { text: 'TBA rooms to request: none.', link: null };
  const classes = Number.isFinite(version.gaStats?.classesInTbaRooms) ? `, holding ${plural(version.gaStats.classesInTbaRooms, 'class', 'classes')}` : '';
  return {
    text: `TBA rooms to request: ${total} (${used.lab} lab, ${used.lec} lecture)${classes}.`,
    link: { ...link('schedule-views', { scheduleId: String(version.mongoId), view: 'room' }), id: 'tba-rooms', label: 'TBA rooms to request' }
  };
};
const withTbaRooms = (step, version) => {
  const tba = tbaRoomsLine(version);
  if (!tba) return step;
  return { ...step, lines: [...step.lines, tba.text], links: tba.link ? [...(step.links || []), tba.link] : step.links };
};

const reviewStep = (versionsState) => {
  if (versionsState.status === 'loading') return loadingStep('Reading the term\'s versions…');
  if (versionsState.status === 'error') return errorStep(versionsState.message);
  const draft = versionsState.versions.find(v => isShown(v) && v.workflowStatus !== 'Archived');
  if (!draft) return { status: 'waiting', lines: ['No Draft to review yet: generate one first.'], links: [link('schedule-views')] };
  return withTbaRooms(reviewStepOf(draft), draft);
};
const reviewStepOf = (draft) => {
  const links = [link('schedule-views', { scheduleId: String(draft.mongoId) })];
  const moves = Number(draft.editedAfterRun) || 0;
  const movesLine = moves > 0 ? `${plural(moves, 'class move')} since the run.` : 'No class moved since the run.';
  const check = draft.lastCheck;
  if (draft.workflowStatus !== 'Draft') {
    const sentOn = draft.workflowStatus === 'Under Review' ? `${draft.id} was sent for approval (under review)` : `${draft.id} is ${draft.workflowStatus}`;
    if (!check?.checkedAt) {
      return { status: 'todo', lines: [`${sentOn}, but it has not been checked yet: open it and press "Check the whole schedule".`, movesLine], links };
    }
    const hard = Number(check.hardTotal) || 0;
    if (hard > 0) {
      return {
        status: 'attention',
        lines: [
          `${sentOn}, but its last check at ${timeOf(check.checkedAt)} found ${conflictsText(hard)}${BLOCKED_STAGE[draft.workflowStatus] || ''}.`,
          `Restore it as a Draft in ${nameOf('versions')} and fix them, or generate a new Draft.`,
          movesLine
        ],
        links: [link('versions'), ...links]
      };
    }
    return { status: 'done', lines: [`${sentOn}.`, `Last checked at ${timeOf(check.checkedAt)}: 0 conflicts.`, movesLine], links };
  }
  if (!check?.checkedAt) {
    return { status: 'todo', lines: [`${draft.id} has not been checked yet: open it and press "Check the whole schedule".`, movesLine], links };
  }
  const when = timeOf(check.checkedAt);
  const hard = Number(check.hardTotal) || 0;
  if (hard > 0) {
    return { status: 'attention', lines: [`${draft.id} was checked at ${when}: ${conflictsText(hard)}. Fix them in the ${nameOf('schedule-views')}, then check again.`, movesLine], links };
  }
  // A change after the check (a moved class, a new assignment) needs a new check.
  const changedAfter = draft.updatedAt && new Date(draft.updatedAt).getTime() > new Date(check.checkedAt).getTime();
  if (changedAfter) {
    return { status: 'todo', lines: [`${draft.id} was checked at ${when} (0 conflicts), but it changed after that check: check it again.`, movesLine], links };
  }
  return { status: 'done', lines: [`${draft.id} was checked at ${when}: 0 conflicts.`, movesLine], links };
};

// The stage of a version made after the term's official (Approved) one. Approving archives the earlier
// Approved version, so a newer Approved one exists only in data saved before Phase 3 Step 5.
const newerStageLine = (v) => ({
  Draft: `${v.id} is a newer Draft: not approved yet.`,
  'Under Review': `${v.id} is newer and under review: it waits for the Dean's sign-off on the ${nameOf('approval')} page.`
}[v.workflowStatus] || `${v.id} is newer (${v.workflowStatus}).`);
// The newest version of each stage (a GA run archives nothing, so older Drafts may still be open: they
// are earlier tries, and the newest one is the one in play).
const newestOfEachStage = (list) => list.filter((v, i) => list.findIndex(x => x.workflowStatus === v.workflowStatus) === i);

// Step 6 names the stage of the versions that are not archived (the newest of each stage, newest first),
// whether the outputs can be printed, and which version Print Outputs prints when none is chosen: the gateway's prefer=official
// choice (controllers/outputsController.js): the newest Approved, else the newest Draft, else the newest
// version that is not archived. Done while an Approved version exists and no newer one waits for a
// sign-off (a newer Draft is reviewed in step 5 first). Phase 8 Part 6: Approved is final (there is no
// Publish); a version stored as Published arrives as Approved.
const approveStep = (versionsState) => {
  if (versionsState.status === 'loading') return loadingStep('Reading the term\'s versions…');
  if (versionsState.status === 'error') return errorStep(versionsState.message);
  const open = versionsState.versions.filter(v => isShown(v) && v.workflowStatus !== 'Archived');
  const links = [link('approval'), link('print-outputs')];
  const official = open.find(v => v.workflowStatus === 'Approved');
  const printed = official || open.find(v => v.workflowStatus === 'Draft') || open[0] || null;
  if (!printed) return { status: 'waiting', lines: ['Nothing to approve yet: generate and review a Draft first.'], links };
  const printedLine = `${nameOf('print-outputs')} prints ${printed.id} by default.`;
  if (official) {
    // The versions made after it (the list is newest first) are named with their stage.
    const newer = open.slice(0, open.indexOf(official));
    const waiting = newer.some(v => v.workflowStatus === 'Under Review');
    return {
      status: waiting ? 'todo' : 'done',
      lines: [
        `${official.id} is Approved: final, ready to export and print.`,
        ...newestOfEachStage(newer).map(newerStageLine),
        printedLine
      ],
      links: waiting ? links : [link('print-outputs'), link('approval')]
    };
  }
  // Nothing approved yet: the open versions by their stage, newest first.
  const stageLine = (v) => (v.workflowStatus === 'Under Review' ? `${v.id} is under review: not approved yet.` : `${v.id} is a ${STATUS_WORDS[v.workflowStatus] || v.workflowStatus}: not approved yet.`);
  return { status: 'todo', lines: [...newestOfEachStage(open).map(stageLine), 'A Draft can be printed for checking.', printedLine], links };
};

const STEP_TITLES = ['Set up data', 'Assign faculty', 'Readiness', 'Generate', 'Review', 'Approve & print'];

function ChecklistStep({ n, title, step, isNext, onNavigate, onRetry, readiness }) {
  const s = STATUS[step.status] || STATUS.waiting;
  const titleId = `checklist-step-${n}-title`;
  return (
    <li
      data-testid={`checklist-step-${n}`}
      data-status={step.status}
      data-step={title}
      aria-labelledby={titleId}
      aria-current={isNext ? 'step' : undefined}
      className={`p-5 rounded-2xl border bg-white dark:bg-[#1a1a1c] flex gap-4 ${isNext ? 'border-blue-400 dark:border-blue-500/60 ring-1 ring-blue-400/40' : 'border-slate-200 dark:border-slate-800'}`}
    >
      <div aria-hidden="true" className={`w-9 h-9 shrink-0 rounded-full border-2 flex items-center justify-center text-sm font-black ${s.circle}`}>
        {step.status === 'done' ? <Check size={18} /> : step.status === 'attention' ? <AlertOctagon size={16} /> : step.status === 'loading' || step.status === 'running' ? <Loader2 size={16} className="animate-spin" /> : n}
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 id={titleId} className="text-base font-black text-slate-900 dark:text-white">{n}. {title}</h3>
          <span data-testid={`checklist-step-${n}-status`} className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${s.badge}`}>{s.label}</span>
          {isNext && <span className="text-[11px] font-bold text-blue-800 dark:text-blue-300">Next step</span>}
        </div>
        {step.lines.length > 0 && (
          <div data-testid={`checklist-step-${n}-text`} className="space-y-0.5">
            {step.lines.map((line, i) => (
              <p key={i} className={`text-sm ${i === 0 ? 'font-bold text-slate-800 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}>{line}</p>
            ))}
          </div>
        )}
        {step.panel && <ReadinessPanel state={readiness} onNavigate={onNavigate} compact />}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {(step.links || []).filter(l => l.key && pageOf(l.key)).map((l, i) => (
            <button
              key={l.id || l.key}
              type="button"
              data-testid={`checklist-link-${l.id || l.key}`}
              onClick={() => onNavigate?.(l.key, l.params || undefined)}
              disabled={!onNavigate}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-600 ${i === 0
                ? 'text-white bg-blue-800 hover:bg-blue-700 border-blue-800'
                : 'text-blue-900 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-500/30 hover:bg-blue-100 dark:hover:bg-blue-500/20'}`}
            >
              Open {l.label || nameOf(l.key)} <ArrowRight size={13} aria-hidden="true" />
            </button>
          ))}
          {step.retry && (
            <button
              type="button"
              data-testid="checklist-retry"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              <RefreshCw size={13} aria-hidden="true" /> Try again
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// Phase 11.4: when the term's latest approval was made by an account that is not a Dean (the College
// Secretary may approve), the Dean's checklist names it once: who, the role, when, and a link to the
// Audit Trail entry.
const whenText = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};
const latestApprovalByOther = (versions) => {
  const approvals = (versions || []).filter(v => v.approvedBy?.at).map(v => ({ version: v.id, ...v.approvedBy }));
  approvals.sort((a, b) => new Date(b.at) - new Date(a.at));
  const latest = approvals[0];
  return latest && latest.role && latest.role !== 'Dean' ? latest : null;
};

export default function TermChecklist({ onNavigate = null, currentUser = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const { state: readiness, recheck } = useReadiness();
  // GET /schedule/versions (newest first) and GET /schedule/runs (newest first) of the term.
  const [versionsState, setVersionsState] = useState({ status: 'loading', versions: [], message: '' });
  const [runsState, setRunsState] = useState({ status: 'loading', newest: null, message: '' });

  const fetchVersions = useCallback(async () => {
    const res = await api.get('/schedule/versions', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } });
    return Array.isArray(res.data?.versions) ? res.data.versions : [];
  }, [activeAcademicYear, activeSemesterNumber]);
  const fetchNewestRun = useCallback(async () => {
    const res = await api.get('/schedule/runs', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } });
    return Array.isArray(res.data?.runs) ? res.data.runs[0] || null : null;
  }, [activeAcademicYear, activeSemesterNumber]);
  const versionsError = (err) => `The term's versions could not be read (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".`;
  const runsError = (err) => `Whether a run is going could not be checked (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Try again".`;

  useEffect(() => {
    let active = true;
    fetchVersions()
      .then(versions => { if (active) setVersionsState({ status: 'done', versions, message: '' }); })
      .catch(err => { if (active) setVersionsState({ status: 'error', versions: [], message: versionsError(err) }); });
    fetchNewestRun()
      .then(newest => { if (active) setRunsState({ status: 'done', newest, message: '' }); })
      .catch(err => { if (active) setRunsState({ status: 'error', newest: null, message: runsError(err) }); });
    return () => { active = false; };
  }, [fetchVersions, fetchNewestRun]);

  // Phase 8 Part 8 (decision 6): live updates — a saved version, a run's end or an approval (this tab
  // at once, the others within ~2 s) reads the versions and runs again, quietly; the readiness lines
  // follow on their own (useReadiness).
  useDataChanges(['schedule'], () => {
    fetchVersions().then(versions => setVersionsState({ status: 'done', versions, message: '' })).catch(() => { /* kept as shown */ });
    fetchNewestRun().then(newest => setRunsState({ status: 'done', newest, message: '' })).catch(() => { /* kept as shown */ });
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = async () => {
    setIsRefreshing(true);
    setVersionsState(prev => ({ ...prev, status: 'loading' }));
    setRunsState(prev => ({ ...prev, status: 'loading' }));
    const [, versions, newest] = await Promise.allSettled([recheck(), fetchVersions(), fetchNewestRun()]);
    setVersionsState(versions.status === 'fulfilled'
      ? { status: 'done', versions: versions.value, message: '' }
      : { status: 'error', versions: [], message: versionsError(versions.reason) });
    setRunsState(newest.status === 'fulfilled'
      ? { status: 'done', newest: newest.value, message: '' }
      : { status: 'error', newest: null, message: runsError(newest.reason) });
    setIsRefreshing(false);
  };

  const steps = [
    dataStep(readiness),
    assignStep(readiness),
    readinessStep(readiness),
    generateStep(versionsState, runsState, readiness),
    reviewStep(versionsState),
    approveStep(versionsState)
  ];
  const doneCount = steps.filter(s => s.status === 'done').length;
  const anyLoading = steps.some(s => s.status === 'loading');
  const nextIndex = steps.findIndex(s => s.status !== 'done');
  const summary = anyLoading
    ? 'Reading where the term stands…'
    : doneCount === steps.length
      ? 'All 6 steps are done: the term\'s Mother Schedule is approved and ready to print.'
      : `${doneCount} of 6 steps done. Next: ${STEP_TITLES[nextIndex]}.`;

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="checklist" />
          <button
            type="button"
            data-testid="checklist-refresh"
            onClick={refresh}
            disabled={isRefreshing}
            className="shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-blue-900 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 hover:bg-blue-100 dark:hover:bg-blue-500/20 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {isRefreshing ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : <RefreshCw size={14} className="mr-1.5" aria-hidden="true" />}
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b] space-y-4">
          <BackupWarnings onNavigate={onNavigate} />
          {(() => {
            const other = currentUser?.role === 'Dean' && versionsState.status === 'done' ? latestApprovalByOther(versionsState.versions) : null;
            if (!other) return null;
            return (
              <p data-testid="checklist-approved-by" className="flex flex-wrap items-center gap-2 text-sm text-slate-800 dark:text-slate-100 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-xl px-4 py-2">
                <span>Version {other.version} approved by {other.name || 'an account'} ({other.role}), {whenText(other.at)}</span>
                {onNavigate && (
                  <button type="button" data-testid="checklist-approved-by-view" onClick={() => onNavigate('audit-logs', { entry: other.auditId })} className="ml-auto px-3 py-1 rounded-xl text-xs font-bold text-blue-900 dark:text-blue-200 bg-white dark:bg-[#18181b] border border-blue-200 dark:border-blue-500/30 hover:bg-blue-100 dark:hover:bg-blue-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">View</button>
                )}
              </p>
            );
          })()}
          <p role="status" data-testid="checklist-summary" className="text-sm font-bold text-slate-800 dark:text-slate-100">{summary}</p>
          <ol data-testid="checklist-steps" aria-label="The term's steps" className="space-y-3">
            {steps.map((step, i) => (
              <ChecklistStep
                key={STEP_TITLES[i]}
                n={i + 1}
                title={STEP_TITLES[i]}
                step={step}
                isNext={!anyLoading && i === nextIndex}
                onNavigate={onNavigate}
                onRetry={refresh}
                readiness={readiness}
              />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
