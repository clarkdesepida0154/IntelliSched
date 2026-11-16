import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

const buttonClass =
  'inline-flex items-center gap-1 px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium ' +
  'text-slate-700 dark:text-slate-300 bg-white dark:bg-[#18181b] hover:bg-slate-100 dark:hover:bg-slate-800 shadow-sm cursor-pointer';

/**
 * Footer controls shared by every Academic Data Management table: smart pagination, rendered
 * bottom-right of the card next to the page's own "Showing 1–25 of 84" line.
 *
 * Pagination
 * - The Previous / Page / Next group is hidden entirely when there is only one page.
 * - "Previous" is hidden on the first page; "Next" is hidden on the last page.
 *
 * Status (Phase 3 Step 8): the old "Live · synced" / "Syncing with Atlas" indicator is gone, because the
 * pages do not poll. While a table re-reads its list after a change (isSyncing) a plain "Updating the
 * list…" line shows; a failed read is reported by the page's own error message, so the callers'
 * hasError and lastSyncedAt props are ignored. showSync={false} leaves the
 * status line out entirely.
 *
 * Returns a fragment so both pieces sit directly in the parent's flex-wrap row.
 */
export default function TablePagination({
  currentPage,
  totalPages,
  onPageChange,
  label = 'Table pages',
  isSyncing = false,
  showSync = true
}) {
  const hasPages = Boolean(totalPages) && totalPages > 1;
  const page = hasPages ? Math.min(Math.max(1, currentPage), totalPages) : 1;
  const isFirst = page === 1;
  const isLast = page === totalPages;

  return (
    <>
      {hasPages && (
        <nav aria-label={label} className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          {!isFirst && (
            <button type="button" onClick={() => onPageChange(page - 1)} className={buttonClass}>
              <ChevronLeft size={14} /> Previous
            </button>
          )}
          <span className="px-1 font-medium tabular-nums">
            Page {page} of {totalPages}
          </span>
          {!isLast && (
            <button type="button" onClick={() => onPageChange(page + 1)} className={buttonClass}>
              Next <ChevronRight size={14} />
            </button>
          )}
        </nav>
      )}

      {showSync && isSyncing && (
        <p className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
          <Loader2 size={12} aria-hidden="true" className="animate-spin" />
          Updating the list…
        </p>
      )}
    </>
  );
}
