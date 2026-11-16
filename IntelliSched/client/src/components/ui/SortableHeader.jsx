import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

// A table header cell whose label is a button that sorts by `sortKey` (see hooks/useSort.js).
// `padding` lets a dense table (the Faculty table, which must fit at 1280 px) use narrower cells.
export default function SortableHeader({ label, sortKey, sort, onSort, className = '', align = 'left', padding = 'px-6 py-4' }) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`${padding} font-bold text-xs ${className}`}>
      <button
        type="button"
        data-testid={`sort-${sortKey}`}
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 cursor-pointer rounded hover:text-slate-800 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${align === 'center' ? 'justify-center w-full' : ''} ${active ? 'text-slate-800 dark:text-slate-100' : ''}`}
      >
        {label}
        <Icon size={12} aria-hidden="true" className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  );
}
