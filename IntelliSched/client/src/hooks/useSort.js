import { useMemo, useState } from 'react';

// Table sorting. `getters` maps a column key to (row) => comparable value; nulls sort last.
// Returns the sorted rows, the current { key, dir } and toggle(key) for the header buttons.
// initialDir: 'asc' (default) or 'desc' (e.g. newest first).
export default function useSort(rows, getters, initialKey, initialDir = 'asc') {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const sorted = useMemo(() => {
    const get = getters[sort.key];
    if (!get) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * factor;
    });
  }, [rows, getters, sort]);
  const toggle = (key) => setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
  return { sorted, sort, toggle };
}
