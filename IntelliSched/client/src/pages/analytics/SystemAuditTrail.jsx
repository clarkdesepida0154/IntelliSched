import { useState, useEffect, useMemo } from 'react';
import { Search, ShieldCheck, Filter, Dna, UserCheck, Loader2, Settings, Users } from 'lucide-react';
import api from '../../services/api';
import useSort from '../../hooks/useSort';
import usePagination from '../../hooks/usePagination';
import SortableHeader from '../../components/ui/SortableHeader';
import TablePagination from '../../components/ui/TablePagination';
import PageHeader from '../../components/layout/PageHeader';

// Categories the gateway writes (auditController.js); a category with no rows still gets a tab.
const CATEGORIES = ['All', 'Assignments', 'Timetable', 'Approval', 'Settings'];
const CATEGORY_ICONS = { Assignments: Users, Timetable: Dna, Approval: UserCheck, Settings: Settings };
const PAGE_SIZE = 25;

const SORT_GETTERS = {
  at: log => (log.at ? new Date(log.at).getTime() : null),
  action: log => log.action,
  target: log => log.target,
  by: log => (log.byRecorded ? log.by : null),
  level: log => log.level
};

// Phase 11.4: #/audit-logs?entry=<row id> (the Term Checklist's "View") opens with that entry searched.
export default function SystemAuditTrail({ entry = '' }) {
  const [logsList, setLogsList] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(entry || '');
  const [activeCategory, setActiveCategory] = useState('All');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let isMounted = true;

    async function loadAuditLogs() {
      try {
        const res = await api.get('/audit/logs');
        if (!isMounted) return;
        // No invented rows: an empty or unreachable audit log shows the empty state.
        setLogsList(res.data?.success && Array.isArray(res.data.logs) ? res.data.logs : []);
      } catch (err) {
        console.warn('[AuditTrail] Fetch failed:', err.message);
        if (isMounted) {
          setLogsList([]);
          setLoadError(err.response?.data?.message || 'The audit trail could not be loaded. Check that the gateway is running, then open this page again.');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadAuditLogs();

    return () => {
      isMounted = false;
    };
  }, []);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logsList.filter(log => {
      const matchesCategory = activeCategory === 'All' || log.category === activeCategory;
      const matchesSearch = !q || [log.action, log.by, log.target, log.professor, log.detail, log.id]
        .some(text => String(text || '').toLowerCase().includes(q));
      return matchesCategory && matchesSearch;
    });
  }, [logsList, activeCategory, searchQuery]);

  // Newest first until the Dean picks another column.
  const { sorted, sort, toggle } = useSort(filteredLogs, SORT_GETTERS, 'at', 'desc');
  const { pageItems, currentPage, totalPages, setPage, resetPage, rangeLabel } = usePagination(sorted, PAGE_SIZE);

  return (
    <div className="animate-in fade-in duration-300 space-y-6">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="audit-logs" />

          <div className="relative w-full sm:w-64">
            <label htmlFor="audit-search" className="sr-only">Search the audit trail</label>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} aria-hidden="true" />
            <input
              id="audit-search"
              data-testid="audit-search"
              type="text"
              placeholder="Search actions, people, subjects..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); resetPage(); }}
              className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-4 text-sm focus:outline-none focus:border-slate-500 text-slate-900 dark:text-white"
            />
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {/* CATEGORY FILTER TABS */}
        <div className="p-4 px-6 md:px-8 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#121212] flex flex-wrap items-center gap-2">
          <Filter size={14} className="text-slate-500 dark:text-slate-400 mr-2" aria-hidden="true" />
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              data-testid={`audit-category-${cat.toLowerCase()}`}
              aria-pressed={activeCategory === cat}
              onClick={() => { setActiveCategory(cat); resetPage(); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                activeCategory === cat
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-sm'
                  : 'bg-white dark:bg-[#1a1a1c] text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-300'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* AUDIT LOG TABLE */}
        <div className="overflow-x-auto min-h-100">
          {isLoading ? (
            <div className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-400 gap-3" role="status">
              <Loader2 size={36} className="animate-spin text-slate-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the audit trail...</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm" data-testid="audit-table">
              <thead className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-xs uppercase font-bold">
                <tr>
                  <SortableHeader label="When (UTC)" sortKey="at" sort={sort} onSort={toggle} />
                  <SortableHeader label="Action" sortKey="action" sort={sort} onSort={toggle} />
                  <SortableHeader label="About" sortKey="target" sort={sort} onSort={toggle} />
                  <SortableHeader label="By" sortKey="by" sort={sort} onSort={toggle} />
                  <SortableHeader label="Level" sortKey="level" sort={sort} onSort={toggle} align="center" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-[#18181b]">
                {pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-600 dark:text-slate-400 text-xs">
                      {loadError || (logsList.length
                        ? 'No audit records match this search or category. Clear the search or choose "All".'
                        : 'No audit records yet. Assign a professor on Assign Faculty, save the Scheduling Policy or generate a schedule; each decision appears here.')}
                    </td>
                  </tr>
                ) : (
                  pageItems.map((log) => {
                    const Icon = CATEGORY_ICONS[log.category];
                    return (
                      <tr key={log.id} data-testid="audit-row" className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                        <td className="px-6 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs whitespace-nowrap align-top">
                          {log.date}
                        </td>
                        <td className="px-6 py-4 align-top min-w-64">
                          <span className="font-bold text-slate-900 dark:text-white flex items-center">
                            {Icon && <Icon size={14} className="mr-1.5 shrink-0 text-slate-500" aria-hidden="true" />}
                            {log.action}
                          </span>
                          <span className="text-xs text-slate-600 dark:text-slate-400 block max-w-xl">
                            {log.detail}
                          </span>
                          {/* A run's method and seed (Phase 3 Step 8): for the system team, folded away. */}
                          {log.technical && (
                            <details data-testid="audit-technical" className="mt-1 text-[11px] text-slate-600 dark:text-slate-400">
                              <summary className="cursor-pointer font-bold rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Technical details</summary>
                              <span className="block mt-0.5">{log.technical}</span>
                            </details>
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-slate-600 dark:text-slate-300 font-medium align-top">
                          {log.target}
                          {log.professor && <span className="block font-sans text-[11px] text-slate-500 dark:text-slate-400">Professor: {log.professor}</span>}
                        </td>
                        <td className="px-6 py-4 align-top" data-testid="audit-by">
                          {log.byRecorded
                            ? <span className="font-bold text-slate-800 dark:text-white text-xs">{log.by}</span>
                            : <span className="text-xs italic text-slate-500 dark:text-slate-400">Not recorded</span>}
                        </td>
                        <td className="px-6 py-4 text-center align-top whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            log.level === 'Critical'
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400 border border-purple-200 dark:border-purple-500/20'
                              : log.level === 'High'
                              ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400 border border-red-200 dark:border-red-500/20'
                              : log.level === 'Moderate'
                              ? 'bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400 border border-orange-200 dark:border-orange-500/20'
                              : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700'
                          }`}>
                            <ShieldCheck size={11} className="mr-1" aria-hidden="true" /> {log.level}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* FOOTER */}
        <div className="p-4 px-6 md:px-8 bg-slate-50 dark:bg-[#1a1a1c] border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-3 justify-between items-center text-xs text-slate-600 dark:text-slate-400">
          <span>
            Showing {rangeLabel} of {filteredLogs.length} events.
          </span>
          <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Audit trail pages" hasError={Boolean(loadError)} />
        </div>

      </div>
    </div>
  );
}
