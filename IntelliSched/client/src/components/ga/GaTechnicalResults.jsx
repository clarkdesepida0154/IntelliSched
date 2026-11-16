import { useState } from 'react';
import { Activity } from 'lucide-react';
import useSort from '../../hooks/useSort';
import usePagination from '../../hooks/usePagination';
import SortableHeader from '../ui/SortableHeader';
import TablePagination from '../ui/TablePagination';
import { tbaRoomWording } from '../../utils/scheduleDisplay';
import {
  SOFT_RULE_ROWS, budgetMsOf, countText, failedRunDetail, fitnessOf, formatClock, formatDuration, hardTotalOf, isActiveRun, modeLabel,
  resolutionRateText, shownNumber, stopReasonText, tbaRoomModeLabel
} from '../../utils/gaRun';

// The technical results of the shown run, in the Generate Schedule page's "Advanced (system team)"
// (Phase 3 Step 4): the settings and seed it ran with, the TBA rooms it had, the live generation and
// counts while it goes, and when it has ended the Chapter 4 numbers (time taken, first conflict-free
// time, conflicts before and after, the resolution rate), the fitness, why it stopped, the soft penalty
// by rule, the broken rules of a failed run, the technical cause, and the run log.

// How many broken rules a failed run lists before "Show all".
const COLLAPSED_VIOLATIONS = 10;

const Fact = ({ label, testId, children }) => (
  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-800">
    <dt className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">{label}</dt>
    <dd data-testid={testId} className="text-sm font-black text-slate-900 dark:text-white mt-0.5">{children}</dd>
  </div>
);

// The soft penalty by rule: how often each rule was hit and its penalty.
function SoftBreakdown({ stats }) {
  if (!stats?.softBreakdown) {
    return <p data-testid="ga-soft-breakdown" className="text-xs text-slate-600 dark:text-slate-400">The soft penalty by rule was not recorded for this run.</p>;
  }
  return (
    <table data-testid="ga-soft-breakdown" className="w-full text-xs">
      <caption className="text-left text-xs font-black text-slate-800 dark:text-white mb-2">Soft penalty by rule</caption>
      <thead>
        <tr className="text-[10px] uppercase tracking-widest text-slate-600 dark:text-slate-400">
          <th scope="col" className="text-left font-bold py-1.5 pr-2">Rule</th>
          <th scope="col" className="text-left font-bold py-1.5 pr-2">How often</th>
          <th scope="col" className="text-right font-bold py-1.5">Penalty</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
        {SOFT_RULE_ROWS.map(row => (
          <tr key={row.term} data-testid={`ga-soft-${row.term}`}>
            <td className="py-1.5 pr-2 font-medium text-slate-700 dark:text-slate-300">{row.label}</td>
            <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-400 whitespace-nowrap">{countText(stats.softCounts?.[row.countKey], row.unit) || '—'}</td>
            <td className="py-1.5 text-right font-bold text-slate-900 dark:text-white">{shownNumber(stats.softBreakdown[row.term])}</td>
          </tr>
        ))}
        <tr data-testid="ga-soft-total">
          <td className="py-1.5 pr-2 font-black text-slate-900 dark:text-white" colSpan={2}>Total soft penalty</td>
          <td className="py-1.5 text-right font-black text-slate-900 dark:text-white">{shownNumber(stats.softTotal ?? stats.soft)}</td>
        </tr>
      </tbody>
    </table>
  );
}

// The run log: Engine 3's history (generation, conflicts, soft penalty), thinned by Engine 3 to at most
// 200 points. A table like every other (UI standard): sortable by each column (in the recorded order,
// by generation, at first) and in pages of 25. There is nothing to search in three numbers a row.
const RUN_LOG_PAGE = 25;
const numberAt = (i) => (point) => (Number.isFinite(point?.[i]) ? point[i] : null);
const RUN_LOG_SORT = { 'log-generation': numberAt(0), 'log-conflicts': numberAt(1), 'log-soft': numberAt(2) };

function RunLog({ history }) {
  const points = Array.isArray(history) ? history : [];
  const { sorted, sort, toggle } = useSort(points, RUN_LOG_SORT, 'log-generation');
  const { pageItems, currentPage, totalPages, setPage, rangeLabel } = usePagination(sorted, RUN_LOG_PAGE);
  if (!points.length) {
    return (
      <p data-testid="ga-run-log" className="text-xs text-slate-600 dark:text-slate-400">
        No run log was recorded for this run. The next run records one: press &ldquo;Generate Mother Schedule&rdquo; above.
      </p>
    );
  }
  const header = 'px-2! py-1.5! text-[10px]! uppercase tracking-widest';
  return (
    <div data-testid="ga-run-log" className="space-y-2">
      <p className="text-xs font-black text-slate-800 dark:text-white">Run log ({points.length} point{points.length === 1 ? '' : 's'})</p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-xs">
          <caption className="sr-only">Run log: the best schedule after each recorded generation</caption>
          <thead className="bg-slate-100 dark:bg-[#121212] text-slate-600 dark:text-slate-400">
            <tr>
              <SortableHeader label="Generation" sortKey="log-generation" sort={sort} onSort={toggle} className={header} />
              <SortableHeader label="Conflicts" sortKey="log-conflicts" sort={sort} onSort={toggle} className={header} />
              <SortableHeader label="Soft penalty" sortKey="log-soft" sort={sort} onSort={toggle} className={header} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {pageItems.map((point, i) => (
              <tr key={`${point?.[0]}-${i}`} data-testid="ga-run-log-row">
                <td className="py-1 px-2 text-slate-700 dark:text-slate-300">{shownNumber(point?.[0])}</td>
                <td className="py-1 px-2 text-slate-900 dark:text-white font-bold">{shownNumber(point?.[1])}</td>
                <td className="py-1 px-2 text-slate-900 dark:text-white">{shownNumber(point?.[2])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span data-testid="ga-run-log-count" className="text-[11px] text-slate-600 dark:text-slate-400">Showing {rangeLabel} of {points.length} point{points.length === 1 ? '' : 's'}.</span>
        <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Run log pages" showSync={false} />
      </div>
    </div>
  );
}

export default function GaTechnicalResults({ run, startDetail = '' }) {
  const [showAllViolations, setShowAllViolations] = useState(false);
  const stats = run?.gaStats || null;
  const active = isActiveRun(run);
  const p = run?.progress || null;
  const violations = Array.isArray(run?.violations) ? run.violations : [];
  const shownViolations = showAllViolations ? violations : violations.slice(0, COLLAPSED_VIOLATIONS);
  const hardTotal = run ? hardTotalOf(run) : null;
  const seed = run ? (run.seed ?? stats?.seed) : null;
  const mode = stats?.mode || run?.settings?.mode;
  const budgetMs = run ? budgetMsOf(run) : null;
  const tba = run?.tbaRooms || stats?.tbaRooms || null;
  const fitness = fitnessOf(stats);

  return (
    <section aria-labelledby="ga-tech-title" data-testid="ga-tech" className="space-y-4">
      <div>
        <h4 id="ga-tech-title" className="font-bold text-sm text-slate-800 dark:text-white flex items-center">
          <Activity size={15} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> Technical results
        </h4>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">The numbers behind the shown run (the Chapter 4 measures are saved with every run).</p>
      </div>

      {startDetail && <p data-testid="ga-start-detail" className="text-xs text-slate-700 dark:text-slate-300">Why the last start failed (technical): {startDetail}</p>}

      {!run ? (
        <p data-testid="ga-tech-none" className="text-xs text-slate-600 dark:text-slate-400">No run yet for this term.</p>
      ) : (
        <>
          <p data-testid="ga-tech-run" className="text-xs text-slate-700 dark:text-slate-300">
            {mode ? modeLabel(mode) : 'GA mode not recorded'}
            {Number.isFinite(seed) ? ` · seed ${seed}` : ''}
            {budgetMs ? ` · time budget ${formatClock(budgetMs)}` : ''}
            {Number.isFinite(run.settings?.populationSize) ? ` · population ${run.settings.populationSize}` : ''}
            {Number.isFinite(run.demands) ? ` · ${run.demands} class meetings` : ''}
          </p>
          {tba && (
            <p data-testid="ga-tech-tba" className="text-xs text-slate-700 dark:text-slate-300">
              TBA rooms this run had: {tbaRoomModeLabel(tba.mode)}, {tba.lab} lab + {tba.lec} lecture.
            </p>
          )}

          {active && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Fact label="Generation" testId="ga-generation">{Number.isFinite(p?.generation) ? p.generation : '—'}</Fact>
              <Fact label="Conflicts in the best schedule" testId="ga-best-hard">{shownNumber(p?.bestHard)}</Fact>
              <Fact label="Soft penalty of the best schedule" testId="ga-best-soft">{shownNumber(p?.bestSoft)}</Fact>
            </div>
          )}

          {!active && stats && (
            <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <Fact label="First schedule with no conflict" testId="ga-first-feasible">
                {Number.isFinite(stats.timeToFirstFeasibleMs) ? `after ${formatDuration(stats.timeToFirstFeasibleMs)}` : 'not reached or not recorded'}
              </Fact>
              <Fact label="Generations" testId="ga-generations-run">{Number.isFinite(stats.generations) ? stats.generations : 'not recorded'}</Fact>
              <Fact label="Run time" testId="ga-runtime">{Number.isFinite(stats.runtimeMs) ? formatDuration(stats.runtimeMs) : 'not recorded'}</Fact>
              <Fact label="Why it stopped" testId="ga-stop-reason">{stopReasonText(stats)}</Fact>
              <Fact label="Conflicts before → after" testId="ga-hard-change">
                {Number.isFinite(stats.initialHard) ? `${stats.initialHard} → ${stats.finalHard ?? hardTotal ?? '—'}` : 'not recorded'}
              </Fact>
              <Fact label="Resolution rate" testId="ga-resolution-rate">{resolutionRateText(stats)}</Fact>
              <Fact label="Fitness" testId="ga-fitness">{fitness === null ? 'not recorded' : shownNumber(fitness)}</Fact>
              <Fact label="Soft penalty" testId="ga-soft-value">{shownNumber(stats.softTotal ?? stats.soft)}</Fact>
            </dl>
          )}
          {!active && stats && Number.isFinite(stats.initialHard) && (
            <p className="text-[11px] text-slate-600 dark:text-slate-400">
              Conflicts are broken hard rules: {stats.initialHard} in the best starting schedule. Fitness = −(100000 × conflicts + soft penalty). The gateway checks the result against every hard rule again before saving it.
            </p>
          )}

          {!active && stats && <SoftBreakdown stats={stats} />}

          {Array.isArray(stats?.warnings) && stats.warnings.length > 0 && (
            <ul data-testid="ga-engine-warnings" className="space-y-1">
              {stats.warnings.map((w, i) => <li key={i} className="text-xs font-bold text-amber-800 dark:text-amber-300">⚠&#xFE0E; {w}</li>)}
            </ul>
          )}

          {failedRunDetail(run) && <p data-testid="ga-result-detail" className="text-xs text-slate-700 dark:text-slate-300">Technical cause: {failedRunDetail(run)}</p>}

          {run.status === 'failed' && (hardTotal > 0 || violations.length > 0) && (
            <div data-testid="ga-violations" className="space-y-2">
              <p className="text-xs font-black text-slate-800 dark:text-white">
                Hard rules broken: {hardTotal ?? violations.length}{violations.length && hardTotal > violations.length ? ` (the first ${violations.length} are listed)` : ''}
              </p>
              {/* A message names a TBA room by its TBA name ("TBA room 1 (lab)"), not its stored one. */}
              <ul className="space-y-1.5">
                {shownViolations.map((v, i) => (
                  <li key={`${v.code}-${i}`} data-testid="ga-violation" data-code={v.code} className="text-xs text-red-800 dark:text-red-300 leading-relaxed">
                    <span aria-hidden="true">✖&#xFE0E; </span>{tbaRoomWording(v.message)}
                  </li>
                ))}
              </ul>
              {violations.length > COLLAPSED_VIOLATIONS && (
                <button
                  type="button"
                  data-testid="ga-violations-toggle"
                  aria-expanded={showAllViolations}
                  onClick={() => setShowAllViolations(v => !v)}
                  className="text-xs font-bold underline text-slate-700 dark:text-slate-200 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                >
                  {showAllViolations ? 'Show fewer' : `Show all ${violations.length}`}
                </button>
              )}
            </div>
          )}

          {!active && <RunLog history={stats?.history} />}
        </>
      )}
    </section>
  );
}
