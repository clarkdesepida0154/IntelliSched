import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Info, Loader2, Play, X } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import usePolicy from '../../hooks/usePolicy';
import usePermission from '../../hooks/usePermission';
import PageHeader from '../../components/layout/PageHeader';
import ReadinessPanel from '../../components/readiness/ReadinessPanel';
import useReadiness from '../../components/readiness/useReadiness';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import GaAdvanced from '../../components/ga/GaAdvanced';
import GaPenaltyWeights from '../../components/ga/GaPenaltyWeights';
import GaRunProgress from '../../components/ga/GaRunProgress';
import GaRunResult from '../../components/ga/GaRunResult';
import GaSettingsForm from '../../components/ga/GaSettingsForm';
import GaTechnicalResults from '../../components/ga/GaTechnicalResults';
import TbaRoomsPanel from '../../components/preflight/TbaRoomsPanel';
import { toSemesterLabel } from '../../utils/sectionMatcher';
import {
  GA_FIELDS, formFromDefaults, isActiveRun, personText, settingProblems, settingsToSend
} from '../../utils/gaRun';

// Generate Schedule (Phase 2 Step 4's GA page, simple by default since Phase 3 Step 4). Top to bottom:
//   1. the Readiness panel as a gate (the Readiness Check, run when the page opens; since Phase 8 Part 12
//      only its verdict, the ✖ and ⚠ lines and "See all checks →": the full list is the Readiness Check page);
//   2. one "Generate Mother Schedule" button (disabled with the reason when the term is not ready or the
//      user may not run it), the plain progress with Cancel, and the plain result ("No conflicts – saved
//      as Draft N", TBA classes and rooms to request, Saturday classes, the time taken, links to the three
//      views), or "The schedule still has N conflicts" with "Try again" (a new run, a new seed);
//   3. "Advanced (system team)", collapsed, which only advanced.edit opens: the GA settings and the
//      seed, the TBA rooms, the penalty weights and the technical results.
// The run is a background job on the gateway: POST /schedule/generate answers 202 with the run, the page
// follows it about once a second (GET /schedule/runs/:id), and the gateway saves the Draft itself, even
// if the browser was closed. When the page opens it shows the term's newest run, and follows it when it
// is still going. A run that would replace the term's newest Draft asks first.
const POLL_MS = 1000;

const CONNECTION_HELP = 'Check that the gateway is running, then try again.';

// GET /schedule/ga-settings: { defaults, limits, modes } (read for the Advanced area only).
const fetchGaSettings = async () => {
  const res = await api.get('/schedule/ga-settings');
  const data = res.data || {};
  if (!data.defaults || typeof data.defaults !== 'object' || !data.limits || typeof data.limits !== 'object') {
    throw new Error('The gateway answered without the GA settings.');
  }
  return { defaults: data.defaults, limits: data.limits, modes: Array.isArray(data.modes) ? data.modes : [] };
};
const settingsErrorMessage = (err) =>
  `The GA settings could not be loaded (${err.response?.data?.message || err.message}). ${CONNECTION_HELP}`;

const thingsToFix = (n) => `${n} thing${n === 1 ? '' : 's'}`;

export default function GAGenerationManager({ onNavigate = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const { policy, error: policyError, reload: reloadPolicy } = usePolicy();
  // "Advanced (system team)" (the GA settings, the TBA rooms, the technical results): the permission
  // map's advanced.edit. Starting or cancelling a run, and "Try again": ga.run. The gateway checks both.
  const advanced = usePermission('advanced.edit');
  const isAdmin = advanced.allowed;
  const runPermission = usePermission('ga.run');
  const canRun = runPermission.allowed;
  const runRoleReason = runPermission.reason;
  const { state: readiness, recheck, replaceReport } = useReadiness();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // ---------------------------------------------------------------- Toast
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // ------------------------------------------------------------------ GA settings (advanced.edit)
  const [gaSettings, setGaSettings] = useState({ status: 'loading' });
  const [form, setForm] = useState(null);
  const applySettings = useCallback((data) => {
    setGaSettings({ status: 'ready', ...data });
    setForm(prev => prev ?? formFromDefaults(data.defaults));
  }, []);
  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    fetchGaSettings()
      .then(data => { if (active) applySettings(data); })
      .catch(err => { if (active) setGaSettings({ status: 'error', message: settingsErrorMessage(err) }); });
    return () => { active = false; };
  }, [isAdmin, applySettings]);
  const retrySettings = async () => {
    setGaSettings({ status: 'loading' });
    try {
      applySettings(await fetchGaSettings());
    } catch (err) {
      setGaSettings({ status: 'error', message: settingsErrorMessage(err) });
    }
  };
  const changeSetting = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const resetToDefaults = () => {
    if (gaSettings.status === 'ready') setForm(formFromDefaults(gaSettings.defaults));
  };

  // ---------------------------------------------------------------- The term's newest Draft (the confirmation)
  // { status: 'loading' | 'done' | 'error', draft: { id, mongoId, moves } | null }: the Draft with classes
  // the views open now, which a new run would replace as "the newest Draft", and its class moves since
  // its run (editedAfterRun): a new run places every class again, so they are not carried over.
  const [draftLookup, setDraftLookup] = useState({ status: 'loading', draft: null });
  const fetchNewestDraft = useCallback(async () => {
    const res = await api.get('/schedule/versions', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } });
    const list = Array.isArray(res.data?.versions) ? res.data.versions : [];
    const draft = list.find(v => !v.legacy && v.workflowStatus === 'Draft' && Number(v.totalScheduled) > 0);
    return draft ? { id: draft.id, mongoId: String(draft.mongoId), moves: Number(draft.editedAfterRun) || 0 } : null;
  }, [activeAcademicYear, activeSemesterNumber]);
  useEffect(() => {
    let active = true;
    fetchNewestDraft()
      .then(draft => { if (active) setDraftLookup({ status: 'done', draft }); })
      .catch(() => { if (active) setDraftLookup({ status: 'error', draft: null }); });
    return () => { active = false; };
  }, [fetchNewestDraft]);
  const refreshNewestDraft = useCallback(() => fetchNewestDraft()
    .then(draft => setDraftLookup({ status: 'done', draft }))
    .catch(() => setDraftLookup({ status: 'error', draft: null })), [fetchNewestDraft]);

  // ---------------------------------------------------------------- Runs
  const [run, setRun] = useState(null);
  // How the shown run got here: 'started' (this page), 'busy' (409: another run was going), 'resumed'
  // (still going when the page opened) or 'last' (the term's newest run, already ended).
  const [runOrigin, setRunOrigin] = useState(null);
  const [runsLookup, setRunsLookup] = useState('loading');
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  // { tone: 'error' | 'info', message, detail }
  const [startError, setStartError] = useState(null);
  const [pollError, setPollError] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  // The start waiting for "Generate a new Draft?": { withSeed } (Try again sends no seed).
  const [confirmStart, setConfirmStart] = useState(null);

  // The term's newest run: followed when it is still going (the Dean may have left and come back).
  useEffect(() => {
    let active = true;
    api.get('/schedule/runs', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } })
      .then(res => {
        if (!active) return;
        const newest = Array.isArray(res.data?.runs) ? res.data.runs[0] : null;
        if (newest?._id) {
          setRun(prev => prev ?? newest);
          setRunOrigin(prev => prev ?? (isActiveRun(newest) ? 'resumed' : 'last'));
        }
        setRunsLookup('done');
      })
      .catch(() => { if (active) setRunsLookup('error'); });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber]);

  // Follows the shown run about once a second while the gateway is still working on it.
  const runId = run?._id || null;
  const runIsActive = isActiveRun(run);
  useEffect(() => {
    if (!runId || !runIsActive) return undefined;
    let active = true;
    let timer = null;
    const tick = async () => {
      try {
        const res = await api.get(`/schedule/runs/${runId}`);
        if (!active) return;
        const next = res.data?.run;
        if (next?._id) {
          setRun(next);
          setPollError('');
          if (!isActiveRun(next)) {
            if (next.status === 'done') {
              showToast(next.version ? `Done: saved as Draft ${next.version}.` : 'Done: the schedule was saved as a Draft.');
              refreshNewestDraft();
            } else if (next.status === 'cancelled') showToast('The run was cancelled; nothing was saved.');
            else showToast('The run ended without saving a schedule. See the result below.');
            return;
          }
        }
      } catch (err) {
        if (!active) return;
        if (err.response?.status === 404) {
          setPollError('The gateway no longer has this run. Reload the page to see the newest run.');
          return;
        }
        setPollError(`Lost contact with the gateway (${err.response?.data?.message || err.message}); trying again every few seconds. The run itself goes on.`);
        timer = setTimeout(tick, POLL_MS * 3);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId, runIsActive, showToast, refreshNewestDraft]);

  const activeRun = runIsActive ? run : null;
  const report = readiness.report;
  const ready = report?.readiness?.verdict === 'ready';
  // The Advanced settings: checked only when they would be sent (they differ from the defaults).
  const settingsReady = isAdmin && form && gaSettings.status === 'ready';
  const problems = settingsReady && settingsToSend(form, gaSettings.defaults) ? settingProblems(form, gaSettings.limits, gaSettings.modes) : {};
  const problemNames = Object.keys(problems).map(key => GA_FIELDS.find(f => f.key === key)?.label || (key === 'mode' ? 'GA to run' : key === 'seed' ? 'Seed' : key));

  // A role that may not run the GA is told so first (the map's reason), even while someone else's run
  // is going: it could not cancel that run either.
  const generateBlockedReason = isStarting
    ? 'Starting…'
    : !canRun
      ? runRoleReason
      : activeRun
        ? `A run is going (started by ${personText(activeRun.startedBy)}). Wait for it to finish, or cancel it.`
        : runsLookup === 'loading'
          ? 'Checking whether a run is already going…'
          : readiness.status === 'checking'
            ? (report ? 'Checking again whether the term is ready…' : 'Checking whether the term is ready…')
            : !report
              ? 'The Readiness Check could not run. Press "Check again" above.'
              : !ready
                ? `Not ready yet: fix the ${thingsToFix(Number(report.readiness.toFix) || 0)} marked ✖\uFE0E above first.`
                : draftLookup.status === 'loading'
                  ? "Checking the term's versions…"
                  : problemNames.length
                    ? `Fix ${problemNames.join(', ')} first${advancedOpen ? '' : ' (in "Advanced (system team)")'}.`
                    : '';

  // Starts a run; hyperparameters only from a role with advanced.edit, and only when they differ from the
  // defaults (withSeed false: "Try again", the same settings with a new seed).
  const startRun = async ({ withSeed }) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setConfirmStart(null);
    setIsStarting(true);
    setStartError(null);
    setPollError('');
    setCancelError('');
    const hyperparameters = settingsReady ? settingsToSend(form, gaSettings.defaults, { withSeed }) : null;
    try {
      const res = await api.post('/schedule/generate', {
        targetAcademicYear: activeAcademicYear,
        targetSemester: activeSemesterNumber,
        ...(hyperparameters ? { hyperparameters } : {})
      });
      const started = res.data?.run?._id ? res.data.run : { _id: res.data?.runId, status: 'running', academicYear: activeAcademicYear, semester: activeSemesterNumber };
      setRun(started);
      setRunOrigin('started');
      showToast('Generating. You can leave this page: the run goes on, and this page shows it when you come back.');
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      if (status === 400 && data.preflight) {
        // The gateway ran the Readiness Check again and refused: its report replaces the one shown.
        replaceReport(data.preflight);
        setStartError({ tone: 'error', message: data.message || 'Not started: the term is not ready yet. See the checks above.', detail: data.detail || '' });
      } else if (status === 409 && data.run?._id) {
        // Another run is going (perhaps started by someone else): show it and follow it.
        setRun(data.run);
        setRunOrigin('busy');
        setStartError({ tone: 'info', message: data.message || 'A run is already going. It is shown below.', detail: '' });
      } else {
        setStartError({ tone: 'error', message: data.message || `The schedule could not be started (${err.message}). ${CONNECTION_HELP}`, detail: data.detail || '' });
      }
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  };

  // "Generate Mother Schedule" and "Try again": a run that would replace the newest Draft asks first.
  const requestStart = ({ withSeed }) => {
    if (startingRef.current || generateBlockedReason) return;
    if (draftLookup.draft || draftLookup.status === 'error') {
      setConfirmStart({ withSeed });
      return;
    }
    startRun({ withSeed });
  };

  const handleCancel = async () => {
    if (!activeRun || !canRun) return false;
    setIsCancelling(true);
    setCancelError('');
    try {
      const res = await api.post(`/schedule/runs/${activeRun._id}/cancel`);
      if (res.data?.run?._id) setRun(prev => (prev?._id === res.data.run._id ? { ...prev, ...res.data.run } : prev));
      return true;
    } catch (err) {
      const data = err.response?.data || {};
      if (data.run?._id) setRun(data.run);
      setCancelError(data.message || `The run could not be cancelled (${err.message}). ${CONNECTION_HELP}`);
      return false;
    } finally {
      setIsCancelling(false);
    }
  };

  // A run of another term (one run at a time for the whole college) says so.
  const otherTerm = run && run.academicYear && (run.academicYear !== activeAcademicYear || Number(run.semester) !== Number(activeSemesterNumber))
    ? `${toSemesterLabel(run.semester)}, A.Y. ${run.academicYear}`
    : '';
  const settingsLockedReason = activeRun ? 'The settings are locked while a run is going.' : isStarting ? 'Starting the run…' : '';
  const openView = (view) => {
    if (!onNavigate) return;
    onNavigate('schedule-views', { ...(run?.scheduleId ? { scheduleId: String(run.scheduleId) } : {}), view });
  };
  // "Fill TBA rooms" (Phase 4 Part 1, Step 1): the saved Draft's Room Program with the panel open.
  const openFillTba = () => {
    if (!onNavigate || !run?.scheduleId) return;
    onNavigate('schedule-views', { scheduleId: String(run.scheduleId), view: 'room', fill: '1' });
  };
  const replacedDraft = draftLookup.draft?.id || '';
  // What a new run does to the Draft it replaces (say exactly what changes): the Draft keeps its class
  // moves in Versions, and the new Draft, which the views, the checklist and the approval then use,
  // does not have them.
  const replacedMoves = draftLookup.draft?.moves || 0;
  const movesSentence = replacedDraft
    ? `${replacedMoves === 1 ? `The class move made in ${replacedDraft} stays in it and is` : replacedMoves > 1 ? `The ${replacedMoves} class moves made in ${replacedDraft} stay in it and are` : `Class moves made in ${replacedDraft} stay in it and are`} not carried into the new Draft: the new run places every class again.`
    : 'Class moves made in that Draft stay in it and are not carried into the new Draft: the new run places every class again.';

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="generate" />
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 space-y-6 bg-slate-50 dark:bg-[#09090b]">
          <ReadinessPanel state={readiness} onRecheck={recheck} onNavigate={onNavigate} summary />

          {/* GENERATE */}
          <section aria-labelledby="generate-title" className="bg-white dark:bg-[#1a1a1c] p-6 rounded-3xl border border-slate-200 dark:border-slate-800 space-y-5">
            <div>
              <h3 id="generate-title" className="font-bold text-base text-slate-800 dark:text-white flex items-center">
                <Play size={16} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> Generate the Mother Schedules
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">One run for the whole college. It continues if you leave this page.</p>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <button
                type="button"
                data-testid="generate-button"
                onClick={() => requestStart({ withSeed: true })}
                disabled={Boolean(generateBlockedReason)}
                aria-describedby="generate-button-reason"
                className="self-start bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-500 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white px-7 py-3 rounded-xl font-black tracking-wide text-sm shadow-lg shadow-indigo-900/20 flex items-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500"
              >
                {isStarting ? <Loader2 className="animate-spin mr-2" size={16} aria-hidden="true" /> : <Play className="mr-2 fill-current" size={16} aria-hidden="true" />}
                {isStarting ? 'Starting…' : 'Generate Mother Schedule'}
              </button>
              <p id="generate-button-reason" data-testid="generate-button-reason" className="text-xs text-slate-700 dark:text-slate-300">{generateBlockedReason}</p>
            </div>

            {startError && (
              <p
                role={startError.tone === 'error' ? 'alert' : 'status'}
                data-testid="generate-start-error"
                data-tone={startError.tone}
                className={`p-3 rounded-xl border flex items-start gap-2 text-xs font-bold ${startError.tone === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-300'}`}
              >
                {startError.tone === 'error' ? <AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> : <Info size={14} className="shrink-0 mt-px" aria-hidden="true" />}
                {startError.message}
              </p>
            )}

            {runsLookup === 'error' && !run && (
              <p data-testid="generate-runs-error" className="text-[11px] text-slate-600 dark:text-slate-400">
                The page could not check for a run that is already going. If one is, pressing Generate Mother Schedule shows it.
              </p>
            )}

            {activeRun && !isStarting ? (
              <GaRunProgress
                run={activeRun}
                origin={runOrigin}
                otherTerm={otherTerm}
                onCancel={handleCancel}
                cancelNotAllowedReason={canRun ? '' : runRoleReason}
                isCancelling={isCancelling}
                cancelError={cancelError}
                pollError={pollError}
              />
            ) : run && !isStarting ? (
              <GaRunResult
                key={run._id}
                run={run}
                origin={runOrigin}
                otherTerm={otherTerm}
                onOpenView={onNavigate ? openView : null}
                onFillTba={onNavigate ? openFillTba : null}
                onTryAgain={otherTerm ? null : () => requestStart({ withSeed: false })}
                tryAgainBlockedReason={generateBlockedReason}
                isStarting={isStarting}
              />
            ) : !run && !isStarting && runsLookup !== 'loading' && (
              <p data-testid="generate-idle" className="text-xs text-slate-600 dark:text-slate-400">
                No schedule yet. Press Generate Mother Schedule when the term is ready.
              </p>
            )}
          </section>

          <GaAdvanced
            canOpen={isAdmin}
            closedReason={advanced.reason}
            open={advancedOpen}
            onToggle={() => setAdvancedOpen(v => !v)}
          >
            <GaSettingsForm
              settings={gaSettings}
              form={form}
              problems={problems}
              onChange={changeSetting}
              onRetry={retrySettings}
              onUseDefaults={resetToDefaults}
              disabled={Boolean(settingsLockedReason)}
              lockedReason={settingsLockedReason}
            />
            <TbaRoomsPanel
              report={report}
              policy={policy}
              policyError={policyError}
              onReloadPolicy={reloadPolicy}
              canEdit={isAdmin}
              lockedReason={activeRun ? 'The TBA rooms are locked while a run is going.' : ''}
              onSaved={async () => {
                const next = await recheck();
                showToast(next ? 'TBA rooms saved. The Readiness Check ran again with them.' : 'TBA rooms saved, but the Readiness Check could not run again. Press "Check again".');
              }}
            />
            <GaPenaltyWeights policy={policy} policyError={policyError} onOpenPolicy={onNavigate ? () => onNavigate('policy') : null} />
            <GaTechnicalResults key={run?._id || 'none'} run={run} startDetail={startError?.detail || ''} />
          </GaAdvanced>
        </div>
      </div>

      {confirmStart && (
        <ConfirmDialog
          testId="generate-confirm"
          title="Generate a new Draft?"
          keepLabel="Don't generate"
          confirmLabel="Generate a new Draft"
          onKeep={() => setConfirmStart(null)}
          onConfirm={() => startRun(confirmStart)}
          busy={isStarting}
          tone="indigo"
        >
          {replacedDraft
            ? `${replacedDraft} stays in Versions, but the new Draft becomes the one the views open.`
            : "The term's newest Draft stays in Versions, but the new Draft becomes the one the views open."}
          {' '}{movesSentence}
        </ConfirmDialog>
      )}

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
          <span data-testid="generate-toast" className="text-xs font-bold tracking-wide">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-2 text-slate-300 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
