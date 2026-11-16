import { useState } from 'react';

export const DEFAULT_PAGE_SIZE = 15;

/**
 * Client-side pagination over an already-filtered list.
 *
 * The page is clamped on render rather than reset in an effect, so a list that shrinks
 * (a toggle hides a row, a filter narrows the set) never leaves the user on an empty page.
 * Callers reset to page 1 explicitly whenever the query set changes (search, filters).
 */
export default function usePagination(items, pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);

  const list = Array.isArray(items) ? items : [];
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageItems = list.slice(pageStart, pageStart + pageSize);
  const showPagination = totalItems > pageSize;
  const rangeLabel = totalItems === 0 ? '0' : `${pageStart + 1}–${pageStart + pageItems.length}`;

  const resetPage = () => setPage(1);
  const goToPage = (next) => setPage(Math.min(Math.max(1, Number(next) || 1), totalPages));

  return {
    page: currentPage,
    currentPage,
    totalPages,
    totalItems,
    pageSize,
    pageStart,
    pageItems,
    showPagination,
    rangeLabel,
    setPage: goToPage,
    resetPage
  };
}
