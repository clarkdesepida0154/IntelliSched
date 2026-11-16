import PageHeader from '../../components/layout/PageHeader';
import ReadinessPanel from '../../components/readiness/ReadinessPanel';
import useReadiness from '../../components/readiness/useReadiness';

// The Readiness Check (Phase 3 Step 4; the Phase 1 "Pre-flight Check"): whether the term chosen in the
// top bar is ready to generate, and what to fix first. The check runs when the page opens; "Check
// again" runs it again. It is the gateway's pre-flight report (POST /schedule/preflight), the same check
// the Generate Schedule page runs and the gateway repeats before every run. The panel shows the Dean's
// seven lines; the numbers behind them are under "Technical details".
export default function FeasibilityValidator({ onNavigate = null }) {
  const { state, recheck } = useReadiness();

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="readiness" />
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b]">
          <ReadinessPanel state={state} onRecheck={recheck} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}
