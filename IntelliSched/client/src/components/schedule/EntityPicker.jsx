import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

// The picker of the Schedule Views page: a search box over the view's sections, professors or rooms,
// the matching ones as buttons (the chosen one has aria-current), and Previous / Next through the
// matching list. entities: [{ key, label, detail?, group? }] in display order; consecutive entities
// with the same group (rooms: CCS, borrowed, TBA) sit under one small heading.
// children: shown above the search (the Room Program's "TBA rooms to request").
export default function EntityPicker({ noun, nounPlural, entities, currentKey, search, onSearch, onChoose, children }) {
  const q = search.trim().toLowerCase();
  const shown = q ? entities.filter(e => e.label.toLowerCase().includes(q)) : entities;
  const index = shown.findIndex(e => e.key === currentKey);
  // When the chosen one does not match the search, Next goes to the first match and Previous to the last.
  const prev = index > 0 ? shown[index - 1] : index === -1 ? shown[shown.length - 1] || null : null;
  const next = index === -1 ? shown[0] || null : shown[index + 1] || null;

  const where = q ? ' that matches the search' : '';
  const reason = entities.length === 0
    ? `There is no ${noun} to show in this version.`
    : shown.length === 0
      ? `No ${noun} matches the search.`
      : shown.length === 1 && index === 0
        ? `This is the only ${noun}${where}.`
        : !prev
          ? `This is the first ${noun}${where}.`
          : !next
            ? `This is the last ${noun}${where}.`
            : '';

  const groups = [];
  for (const entity of shown) {
    const last = groups[groups.length - 1];
    if (last && last.name === (entity.group || '')) last.items.push(entity);
    else groups.push({ name: entity.group || '', items: [entity] });
  }

  const navButton = 'inline-flex items-center gap-1 px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';

  return (
    <section data-testid="views-picker" aria-label={`Choose a ${noun}`} className="space-y-3">
      {children}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0 sm:max-w-sm">
          <label htmlFor="views-picker-search" className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider">
            Search {nounPlural}
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={15} aria-hidden="true" />
            <input
              id="views-picker-search"
              data-testid="views-picker-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={`Type part of a ${noun} name…`}
              className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-3 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="views-prev"
            onClick={() => prev && onChoose(prev.key)}
            disabled={!prev}
            aria-describedby={reason ? 'views-nav-reason' : undefined}
            title={prev ? `Previous ${noun}: ${prev.label}` : reason}
            className={navButton}
          >
            <ChevronLeft size={14} aria-hidden="true" /> Previous
          </button>
          <button
            type="button"
            data-testid="views-next"
            onClick={() => next && onChoose(next.key)}
            disabled={!next}
            aria-describedby={reason ? 'views-nav-reason' : undefined}
            title={next ? `Next ${noun}: ${next.label}` : reason}
            className={navButton}
          >
            Next <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {reason && (
        <p id="views-nav-reason" data-testid="views-nav-reason" className="text-[11px] text-slate-600 dark:text-slate-300">{reason}</p>
      )}

      <div className="max-h-44 overflow-y-auto custom-scrollbar space-y-2 pr-1">
        {shown.length === 0 ? (
          <p data-testid="views-picker-empty" className="text-xs text-slate-600 dark:text-slate-300">
            {entities.length === 0 ? reason : `No ${noun} matches "${search}". Clear the search to see every ${noun}.`}
          </p>
        ) : groups.map((group, g) => (
          <div key={`${group.name}-${g}`}>
            {group.name && <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300 mb-1">{group.name}</p>}
            <div className="flex flex-wrap gap-2">
              {group.items.map(entity => {
                const isCurrent = entity.key === currentKey;
                return (
                  <button
                    key={entity.key}
                    type="button"
                    data-testid={`views-picker-item-${entity.key}`}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => onChoose(entity.key)}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
                      isCurrent
                        ? 'bg-violet-600 border-violet-600 text-white shadow-sm'
                        : 'bg-white dark:bg-[#1a1a1c] border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-violet-400'
                    }`}
                  >
                    {entity.label}
                    {entity.detail && (
                      <span className={`font-medium ${isCurrent ? 'text-violet-100' : 'text-slate-600 dark:text-slate-300'}`}>{entity.detail}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
