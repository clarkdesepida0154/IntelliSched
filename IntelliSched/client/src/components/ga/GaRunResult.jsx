import { AlertOctagon, ArrowRight, Ban, CheckCircle2, DoorOpen, Loader2, RefreshCw } from 'lucide-react';
import {
  failedRunTitle, formatDuration, hardTotalOf, noRoomSentence, onlineSentence, personText, runFacts, saturdaySentence, singleClassDaysSentence, tbaClassesSentence, timeOf
} from '../../utils/gaRun';

// A run that has ended, in plain words (Phase 3 Step 4):
//   done       "No conflicts – saved as Draft N", how many classes are TBA and how many TBA rooms to request,
//              how many classes are on Saturday, the time taken, and links to the three views and to "TBA
//              rooms to request";
//   failed     the gateway's words ("The schedule still has N conflicts"; for a run recorded before Step 4,
//              the same words built from what it recorded: failedRunTitle) and "Try again" (a new run);
//   cancelled  nothing was saved.
// The technical results (the soft penalty, generations, the broken rules, the run log) are under
// "Advanced". onOpenView(view) opens the Schedule Views & Editor on the saved Draft ('section',
// 'professor' or 'room'); onFillTba() opens its Room Program with "Fill TBA rooms" open (Phase 4 Part
// 1, Step 1; shown only when the run put classes in TBA rooms); onTryAgain() starts a new run.
const linkClass = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500';

export default function GaRunResult({ run, origin, otherTerm = '', onOpenView = null, onFillTba = null, onTryAgain = null, tryAgainBlockedReason = '', isStarting = false }) {
  const facts = runFacts(run);
  const conflicts = run.status === 'failed' ? hardTotalOf(run) : null;
  const done = run.status === 'done';
  const rooms = facts.tbaRoomsUsed;
  const hasTbaRooms = Boolean(rooms && rooms.lab + rooms.lec > 0) || (facts.classesInTbaRooms ?? 0) > 0;

  const head = {
    done: {
      icon: CheckCircle2, tone: 'bg-green-500/10 border-green-500/20 text-green-800 dark:text-green-300',
      title: run.version ? `No conflicts – saved as Draft ${run.version}` : 'No conflicts – saved as a Draft'
    },
    failed: { icon: AlertOctagon, tone: 'bg-red-500/10 border-red-500/20 text-red-800 dark:text-red-300', title: failedRunTitle(run) },
    cancelled: { icon: Ban, tone: 'bg-slate-500/10 border-slate-400/30 text-slate-800 dark:text-slate-200', title: 'Cancelled; nothing was saved.' }
  }[run.status] || { icon: AlertOctagon, tone: 'bg-slate-500/10 border-slate-400/30 text-slate-800 dark:text-slate-200', title: run.message || 'The run ended.' };
  const Icon = head.icon;

  return (
    <section data-testid="generate-result" data-status={run.status} data-run-id={run._id} aria-labelledby="generate-result-title" className="border-t border-slate-200 dark:border-slate-800 pt-5 space-y-4">
      <div>
        <p className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">
          {origin === 'last' ? 'Last run of this term' : 'Result'}{otherTerm ? ` (for ${otherTerm})` : ''}
        </p>
        <div role="status" className={`mt-2 p-4 rounded-2xl border flex items-start ${head.tone}`}>
          <Icon size={22} className="mr-3 shrink-0 mt-px" aria-hidden="true" />
          <div className="min-w-0">
            <h3 id="generate-result-title" data-testid="generate-result-title" className="text-lg font-black">{head.title}</h3>
            {run.status === 'failed' && run.cause && (
              <p data-testid="generate-result-cause" className="text-sm font-bold mt-1">{run.cause}</p>
            )}
            {run.status === 'failed' && (
              <p data-testid="generate-result-message" className="text-sm font-bold mt-1">
                {conflicts && !run.cause ? 'Nothing was saved. Try again: a new run starts from new schedules and often ends with no conflicts.' : 'Nothing was saved.'}
              </p>
            )}
            {run.status === 'cancelled' && run.cancelledBy?.name && (
              <p data-testid="generate-result-message" className="text-sm font-bold mt-1">Cancelled by {personText(run.cancelledBy)}.</p>
            )}
          </div>
        </div>
        <p data-testid="ga-result-by" className="text-xs text-slate-600 dark:text-slate-300 mt-2">
          Started by {personText(run.startedBy)}{run.startedAt ? ` at ${timeOf(run.startedAt)}` : ''}
          {run.finishedAt ? `; ended at ${timeOf(run.finishedAt)}` : ''}
        </p>
      </div>

      {done && (
        <ul data-testid="generate-result-facts" className="space-y-1.5 text-sm text-slate-800 dark:text-slate-200">
          <li data-testid="generate-result-tba" className="flex items-start gap-2">
            <DoorOpen size={16} className="shrink-0 mt-0.5 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> {tbaClassesSentence(facts)}
          </li>
          {noRoomSentence(facts) && <li data-testid="generate-result-noroom" className="pl-6">{noRoomSentence(facts)}</li>}
          {onlineSentence(facts) && <li data-testid="generate-result-online" className="pl-6">{onlineSentence(facts)}</li>}
          <li data-testid="generate-result-saturday" className="pl-6">{saturdaySentence(facts)}</li>
          {singleClassDaysSentence(facts) && (
            <li
              data-testid="generate-result-single-days"
              className={`pl-6${facts.singleClassDays?.partTimers > 0 ? ' text-red-800 dark:text-red-300 font-semibold' : ''}`}
            >
              {singleClassDaysSentence(facts)}
            </li>
          )}
          <li data-testid="generate-result-time" className="pl-6">
            {facts.runtimeMs !== null ? `Time taken: ${formatDuration(facts.runtimeMs)}.` : 'The time taken was not recorded for this run.'}
          </li>
        </ul>
      )}

      {done && onOpenView && run.scheduleId && (
        <div role="group" aria-label="Open the saved Draft" className="flex flex-wrap gap-2">
          <button type="button" data-testid="generate-open-section" onClick={() => onOpenView('section')} className={`${linkClass} text-white bg-indigo-600 hover:bg-indigo-700 border-indigo-600`}>
            Open the Mother Schedule <ArrowRight size={13} aria-hidden="true" />
          </button>
          <button type="button" data-testid="generate-open-professor" onClick={() => onOpenView('professor')} className={`${linkClass} text-indigo-800 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20`}>
            Open the Teachers&apos; Program <ArrowRight size={13} aria-hidden="true" />
          </button>
          <button type="button" data-testid="generate-open-room" onClick={() => onOpenView('room')} className={`${linkClass} text-indigo-800 dark:text-indigo-200 bg-indigo-50 dark:bg-indigo-500/10 border-indigo-200 dark:border-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20`}>
            Open the Room Program <ArrowRight size={13} aria-hidden="true" />
          </button>
          {hasTbaRooms && (
            <button type="button" data-testid="generate-open-tba" onClick={() => onOpenView('room')} className={`${linkClass} text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/20`}>
              <DoorOpen size={13} aria-hidden="true" /> See the TBA rooms to request
            </button>
          )}
          {hasTbaRooms && onFillTba && (
            <button type="button" data-testid="generate-fill-tba" onClick={onFillTba} title="Put the classes in TBA rooms into real rooms with free time, as a new Draft." className={`${linkClass} text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/20`}>
              <DoorOpen size={13} aria-hidden="true" /> Fill TBA rooms
            </button>
          )}
        </div>
      )}

      {run.status === 'failed' && onTryAgain && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
          <button
            type="button"
            data-testid="generate-try-again"
            onClick={onTryAgain}
            disabled={Boolean(tryAgainBlockedReason)}
            aria-describedby="generate-try-again-reason"
            className="self-start px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-500 dark:disabled:bg-slate-700 disabled:cursor-not-allowed shadow-md flex items-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500"
          >
            {isStarting ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : <RefreshCw size={14} className="mr-1.5" aria-hidden="true" />}
            {isStarting ? 'Starting…' : 'Try again'}
          </button>
          <p id="generate-try-again-reason" data-testid="generate-try-again-reason" className="text-xs text-slate-600 dark:text-slate-300">{tryAgainBlockedReason}</p>
        </div>
      )}
    </section>
  );
}
