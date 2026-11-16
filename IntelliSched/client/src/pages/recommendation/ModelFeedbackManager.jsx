import { useState, useEffect, useCallback } from 'react';
import { versionName } from '../../utils/scheduleDisplay';
import { RefreshCw, UserCheck, AlertOctagon, GitCommit, DatabaseBackup, Loader2, CheckCircle2, X, Tag, Info, Sparkles } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import PageHeader from '../../components/layout/PageHeader';
import TablePagination from '../../components/ui/TablePagination';
import usePagination from '../../hooks/usePagination';
import usePermission, { blockedBy } from '../../hooks/usePermission';
import HelpTip from '../../components/ui/HelpTip';

// Model Feedback (a technical page: advanced.edit; Phase 3 Step 8, item 7): the Dean's decisions on the recommendations,
// which the ranking learns from when it is retrained. GET /schedule/decisions lists the term's
// decisions from every version of the term and counts what retraining reads in every term, with the
// same rule as the learning service (server utils/decisions.js, engine4_retrainer.py): accept and
// override decisions and (Phase 8 Part 11) every assignment a person made by hand count; locks the term
// loader or a practice-copy script wrote, class moves and approval signatures do not; older rows saved
// before the kind was recorded are used as before.
const PAGE_SIZE = 25;
const KIND_LABELS = {
  accept: 'Accepted the recommendation',
  override: 'Chose another professor',
  assigned: 'Assigned by hand',
  unrecorded: 'Older record (kind not recorded)'
};
const NOT_RECORDED = 'Not recorded';
const REASON_ID = 'feedback-retrain-reason';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Why Retrain is closed for the data (the role's reason comes first, from the permission map).
// `minimum` is the learning service's own number, known after it answered once; without it the
// page does not guess one.
const retrainBlockedReason = ({ isLoading, errorMessage, allTerms, minimum, needsMore }) => {
  if (isLoading) return 'The decisions are still loading.';
  if (errorMessage) return 'The decisions could not be read, so there is nothing to retrain on yet.';
  if (!allTerms) return 'Nothing to learn from yet: no decisions are recorded.';
  if (Number.isFinite(minimum) && allTerms < minimum) {
    return `Nothing to learn from yet: ${plural(allTerms, 'decision')}, at least ${minimum} needed.`;
  }
  if (needsMore && !Number.isFinite(minimum)) return 'Nothing to learn from yet: the learning service needs more decisions.';
  return '';
};

const RESULT_TONES = {
  success: { box: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-900 dark:text-emerald-300', icon: CheckCircle2, iconTone: 'text-emerald-600 dark:text-emerald-400', title: 'Retrained' },
  skipped: { box: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-900 dark:text-amber-300', icon: Info, iconTone: 'text-amber-700 dark:text-amber-400', title: 'Not retrained' },
  aborted: { box: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-900 dark:text-amber-300', icon: Info, iconTone: 'text-amber-700 dark:text-amber-400', title: 'Not retrained' },
  rejected: { box: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-900 dark:text-amber-300', icon: Info, iconTone: 'text-amber-700 dark:text-amber-400', title: 'Not kept' },
  error: { box: 'bg-red-500/10 border-red-500/20', text: 'text-red-900 dark:text-red-300', icon: AlertOctagon, iconTone: 'text-red-600 dark:text-red-400', title: 'Retraining failed' }
};

export default function ModelFeedbackManager() {
  // Global Term Context: this page lists the decisions of the term chosen in the top bar.
  const { termParams } = useTerm();
  // Retraining: the permission map's model.retrain (the gateway checks the same action).
  const retrain = usePermission('model.retrain');
  const [data, setData] = useState({ decisions: [], counts: {}, allTerms: 0 });
  const [loadedKey, setLoadedKey] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isPushing, setIsPushing] = useState(false);
  // The learning service's last answer in this visit: { status, message, minimum, details }.
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    const res = await api.get('/schedule/decisions', { params: { academicYear: termParams.academicYear, semester: termParams.semester } });
    return {
      decisions: Array.isArray(res.data?.decisions) ? res.data.decisions : [],
      counts: res.data?.counts || {},
      allTerms: Number(res.data?.allTerms) || 0
    };
  }, [termParams.academicYear, termParams.semester]);

  // Loading until the chosen term's answer arrives (a term switch shows the loading state again).
  const termKey = `${termParams.academicYear}|${termParams.semester}`;
  const isLoading = loadedKey !== termKey;
  useEffect(() => {
    let isMounted = true;
    load()
      .then(next => { if (isMounted) { setData(next); setErrorMessage(''); } })
      .catch(err => {
        if (!isMounted) return;
        setData({ decisions: [], counts: {}, allTerms: 0 });
        setErrorMessage(err.response?.data?.message || 'The decisions could not be loaded: the server did not answer. Check your connection and press Try again.');
      })
      .finally(() => { if (isMounted) setLoadedKey(termKey); });
    return () => { isMounted = false; };
  }, [load, termKey]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setErrorMessage('');
    try {
      setData(await load());
      setToast({ message: 'The decisions are up to date.' });
    } catch (err) {
      setErrorMessage(err.response?.data?.message || 'The decisions could not be loaded: the server did not answer. Check your connection and press Try again.');
    } finally {
      setIsRefreshing(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const minimum = Number.isFinite(Number(result?.minimum)) && result?.minimum !== null ? Number(result.minimum) : NaN;
  const dataReason = retrainBlockedReason({
    isLoading,
    errorMessage,
    allTerms: data.allTerms,
    minimum,
    needsMore: result?.status === 'skipped'
  });
  const blockedReason = retrain.allowed ? dataReason : retrain.reason;

  const handleRetrain = async () => {
    if (!retrain.allowed || dataReason) return;
    setIsPushing(true);
    setResult(null);
    try {
      const res = await api.post('/schedule/retrain');
      const body = res.data || {};
      setResult({
        status: RESULT_TONES[body.status] ? body.status : 'error',
        // The learning service's own words (they are plain since Step 8).
        message: body.message || 'The learning service gave no answer.',
        minimum: body.minimum_decisions ?? null,
        details: body
      });
    } catch (err) {
      setResult({
        status: 'error',
        message: err.response?.data?.message || 'The learning service did not answer. Try again later, or check Service Health.',
        minimum: null,
        details: null
      });
    } finally {
      setIsPushing(false);
    }
  };

  const formatDisplayTime = (value) => {
    if (!value) return NOT_RECORDED;
    const date = new Date(value.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const { decisions, counts, allTerms } = data;
  const { pageItems, currentPage, totalPages, setPage, rangeLabel } = usePagination(decisions, PAGE_SIZE);
  const notUsed = [
    counts.lock ? plural(counts.lock, 'assignment by the system', 'assignments by the system') : '',
    counts['schedule-edit'] ? plural(counts['schedule-edit'], 'class move') : '',
    counts.approval ? plural(counts.approval, 'approval signature') : ''
  ].filter(Boolean);
  const tone = result ? RESULT_TONES[result.status] : null;
  const ResultIcon = tone?.icon;

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-8">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="model-feedback" />
          <div className="flex flex-col items-start sm:items-end gap-1.5 max-w-md">
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="feedback-refresh"
                onClick={handleRefresh}
                disabled={isRefreshing || isLoading}
                aria-label="Reload the decisions"
                className="p-2.5 bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                title="Reload the decisions"
              >
                <RefreshCw size={16} className={isRefreshing ? 'animate-spin text-cyan-500' : ''} aria-hidden="true" />
              </button>
              <button
                type="button"
                data-testid="feedback-retrain"
                onClick={handleRetrain}
                disabled={Boolean(blockedReason) || isPushing}
                {...(retrain.allowed ? (dataReason ? { title: dataReason, 'aria-describedby': REASON_ID } : {}) : blockedBy(retrain, REASON_ID))}
                className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-500 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center transition-all shadow-lg shadow-cyan-900/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2"
              >
                {isPushing ? <Loader2 size={16} className="animate-spin mr-2" aria-hidden="true" /> : <DatabaseBackup size={16} className="mr-2" aria-hidden="true" />}
                {isPushing ? 'Retraining…' : 'Retrain the ranking'}
              </button>
            </div>
            {blockedReason && (
              <p id={REASON_ID} data-testid={REASON_ID} className="text-[11px] text-slate-600 dark:text-slate-400 sm:text-right">{blockedReason}</p>
            )}
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {/* WHICH DECISIONS COUNT */}
        <div data-testid="feedback-explainer" className="mx-6 md:mx-8 mt-6 p-4 rounded-2xl bg-cyan-50 dark:bg-cyan-500/5 border border-cyan-200 dark:border-cyan-500/20 flex items-start gap-3">
          <Info size={18} className="text-cyan-700 dark:text-cyan-400 mt-0.5 shrink-0" aria-hidden="true" />
          <p className="text-xs text-cyan-900 dark:text-cyan-200 leading-relaxed flex items-center gap-1.5 flex-wrap">
            <strong>Used:</strong> every professor the Dean chose for a class, from a recommendation or by hand.
            <HelpTip label="which decisions count" testid="feedback-explainer-tip">
              <span data-testid="feedback-explainer-help">
                Accepted and changed recommendations, and every class a person assigned on Assign Faculty&apos;s &quot;By
                class&quot; tab, are used; a class assigned twice counts once (the latest). Assignments the system or a
                practice script made, class moves and approval signatures are not used. Retraining learns from the
                decisions of every term and is kept only when it ranks last year&apos;s choices and the Dean&apos;s
                choices set aside at least as well.
              </span>
            </HelpTip>
          </p>
        </div>

        {/* RETRAINING RESULT: the learning service's own words */}
        {result && tone && (
          <div data-testid="feedback-result" role={result.status === 'error' ? 'alert' : 'status'} className={`mx-6 md:mx-8 mt-4 p-4 rounded-2xl border flex items-start gap-3 ${tone.box}`}>
            <ResultIcon size={18} className={`mt-0.5 shrink-0 ${tone.iconTone}`} aria-hidden="true" />
            <div className={`text-xs leading-relaxed ${tone.text}`}>
              <strong>{tone.title}:</strong> <span data-testid="feedback-result-message">{result.message}</span>
              {/* Phase 8 Part 11: the decisions used and the ranking before and after (never a rating). */}
              {result.details?.before && result.details?.after && (
                <table data-testid="feedback-result-numbers" className="mt-2 text-[11px] border-collapse">
                  <caption className="text-left font-bold mb-1">
                    Decisions used: <span data-testid="feedback-decisions-used">{result.details.questions_used}</span>
                    {' '}({result.details.by_hand ?? 0} by hand, {result.details.from_rankings ?? 0} from recommendations; {result.details.held_out ?? 0} set aside to test)
                  </caption>
                  <thead>
                    <tr><th scope="col" className="text-left pr-3"></th><th scope="col" className="pr-3">Top-1 before</th><th scope="col" className="pr-3">Top-1 after</th><th scope="col" className="pr-3">MRR before</th><th scope="col">MRR after</th></tr>
                  </thead>
                  <tbody>
                    {[['test', `Last year (${result.details.test_term || 'test semester'})`], ['decisions', 'Decisions set aside']].map(([key, label]) => (
                      <tr key={key} data-testid={`feedback-numbers-${key}`}>
                        <th scope="row" className="text-left pr-3 font-semibold">{label}</th>
                        <td className="pr-3 text-center">{Math.round((result.details.before[key]?.top1 ?? 0) * 100)}%</td>
                        <td className="pr-3 text-center">{Math.round((result.details.after[key]?.top1 ?? 0) * 100)}%</td>
                        <td className="pr-3 text-center">{Number(result.details.before[key]?.mrr ?? 0).toFixed(3)}</td>
                        <td className="text-center">{Number(result.details.after[key]?.mrr ?? 0).toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.details && (result.details.val_accuracy !== undefined || result.details.new_val_score !== undefined) && (
                <details className="mt-2">
                  <summary className="cursor-pointer font-bold">Technical details</summary>
                  <p className="mt-1 font-mono">
                    status {result.details.status}; decisions {result.details.total_overrides ?? '?'}
                    {result.details.val_accuracy !== undefined && `; validation accuracy ${result.details.val_accuracy}`}
                    {result.details.old_val_score !== undefined && `; old ${result.details.old_val_score}, new ${result.details.new_val_score}`}
                  </p>
                </details>
              )}
            </div>
          </div>
        )}

        {/* COUNTS */}
        <div className="p-6 md:px-8 bg-slate-50/80 dark:bg-[#121212]/50 border-b border-slate-200 dark:border-slate-800/60 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800">
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest block mb-1">Decisions this term</span>
            <span data-testid="feedback-count-term" className="text-2xl font-black text-slate-800 dark:text-white">{isLoading ? '…' : decisions.length}</span>
            {!isLoading && (
              <span className="block text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                {counts.accept || 0} accepted, {counts.override || 0} changed, {counts.assigned || 0} by hand{counts.unrecorded ? `, ${counts.unrecorded} older` : ''}
              </span>
            )}
          </div>
          <div className="p-4 rounded-2xl bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800">
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest block mb-1">Used for retraining (every term)</span>
            <span data-testid="feedback-count-all" className="text-2xl font-black text-orange-700 dark:text-orange-400">{isLoading ? '…' : allTerms}</span>
          </div>
          <div className="p-4 rounded-2xl bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800">
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest block mb-1">Not used (this term)</span>
            <span data-testid="feedback-count-not-used" className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-start gap-1.5">
              <Sparkles size={14} className="mt-0.5 shrink-0 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
              {isLoading ? '…' : notUsed.length ? notUsed.join(', ') : 'None'}
            </span>
          </div>
        </div>

        {/* THE TERM'S DECISIONS */}
        <div className="p-6 md:p-10 bg-slate-50/50 dark:bg-[#09090b]">
          {isLoading ? (
            <div data-testid="feedback-loading" className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-400 gap-3">
              <Loader2 size={36} className="animate-spin text-cyan-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the decisions…</p>
            </div>
          ) : errorMessage ? (
            <div role="alert" className="p-12 text-center max-w-md mx-auto my-6">
              <AlertOctagon size={40} className="text-red-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">Decisions not loaded</h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-4">{errorMessage}</p>
              <button
                type="button"
                onClick={handleRefresh}
                className="px-4 py-2 bg-cyan-600 text-white rounded-xl text-xs font-bold hover:bg-cyan-700 transition-colors cursor-pointer"
              >
                Try again
              </button>
            </div>
          ) : decisions.length === 0 ? (
            <div data-testid="feedback-empty" className="p-16 text-center text-slate-600 dark:text-slate-400">
              <GitCommit size={36} className="mx-auto mb-3 opacity-30 text-cyan-500" aria-hidden="true" />
              <p className="font-bold text-sm text-slate-700 dark:text-slate-300">No decisions recorded for this term</p>
              <p className="text-xs mt-1">Approve a recommendation, or choose another professor with a reason, on Assign Faculty (the Recommendations tab).</p>
            </div>
          ) : (
            <>
              <div data-testid="feedback-list" className="max-w-4xl mx-auto relative border-l-2 border-slate-200 dark:border-slate-800 pl-8 pb-8 space-y-10">
                {pageItems.map((log) => (
                  <div key={log.id} data-testid="feedback-row" className="relative">
                    <div className="absolute -left-10.25 top-0 bg-white dark:bg-[#18181b] border-2 border-cyan-500 p-1 rounded-full">
                      <GitCommit size={14} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                    </div>

                    <div className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4 border-b border-slate-100 dark:border-slate-800/60 pb-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="font-black text-slate-800 dark:text-white text-lg">{log.subjectCode || NOT_RECORDED}</h4>
                            <span className="text-xs font-bold px-2.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                              {log.section || 'Section not recorded'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                            {formatDisplayTime(log.at)} • {log.by}{log.version ? ` • ${versionName(log.version)}` : ''}
                          </p>
                        </div>
                        <span className={`text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-wider border ${
                          log.kind === 'override'
                            ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/10 dark:text-orange-300 border-orange-200 dark:border-orange-500/20'
                            : log.kind === 'accept'
                              ? 'bg-green-100 text-green-800 dark:bg-green-500/10 dark:text-green-300 border-green-200 dark:border-green-500/20'
                              : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                        }`}>
                          {KIND_LABELS[log.kind] || KIND_LABELS.unrecorded}
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div className="bg-slate-50 dark:bg-slate-800/30 p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 flex flex-col">
                          <span className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-1 flex items-center">
                            <AlertOctagon size={12} className="mr-1" aria-hidden="true" /> Recommended first
                            {log.recommendedScore !== null && log.recommendedScore !== undefined && ` (match ${Number(log.recommendedScore).toFixed(1)}%)`}
                          </span>
                          <span className="font-bold text-slate-700 dark:text-slate-300">
                            {log.recommended || NOT_RECORDED}
                          </span>
                        </div>

                        <div className="bg-cyan-50 dark:bg-cyan-500/10 p-4 rounded-xl border border-cyan-200 dark:border-cyan-500/20 flex flex-col">
                          <span className="text-xs font-bold text-cyan-800 dark:text-cyan-400 uppercase tracking-widest mb-1 flex items-center">
                            <UserCheck size={12} className="mr-1" aria-hidden="true" /> Professor chosen
                          </span>
                          <span className="font-bold text-cyan-900 dark:text-cyan-100">
                            {log.chosen || NOT_RECORDED}
                          </span>
                        </div>
                      </div>

                      <div className="bg-slate-50 dark:bg-[#121212] p-4 rounded-xl border border-slate-200/60 dark:border-slate-800/40">
                        <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-1 flex items-center">
                          <Tag size={10} className="mr-1" aria-hidden="true" /> Reason
                        </span>
                        <p className="text-sm text-slate-700 dark:text-slate-300 font-medium">
                          {log.reason || NOT_RECORDED}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="max-w-4xl mx-auto flex flex-wrap gap-3 justify-between items-center text-xs text-slate-600 dark:text-slate-300">
                <span data-testid="feedback-showing">Showing {rangeLabel} of {decisions.length} decision{decisions.length === 1 ? '' : 's'}.</span>
                <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Decision pages" showSync={false} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/20 dark:bg-cyan-500/15 flex items-center justify-center text-cyan-500 shrink-0">
            <CheckCircle2 size={16} aria-hidden="true" />
          </div>
          <span className="text-sm font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-3 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
