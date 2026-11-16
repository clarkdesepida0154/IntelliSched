import { useEffect, useRef, useState } from 'react';
import { Filter, ChevronDown, X } from 'lucide-react';
import Select from './Select';

// Full class strings per accent so Tailwind can see them at build time.
const ACCENTS = {
  blue: {
    trigger: 'bg-blue-50 dark:bg-blue-500/10 border-blue-300 dark:border-blue-500/40 text-blue-700 dark:text-blue-400',
    badge: 'bg-blue-600 text-white',
    selected: 'border-blue-400 dark:border-blue-500/60',
    focus: 'focus:border-blue-500',
    clear: 'text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10'
  },
  emerald: {
    trigger: 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
    badge: 'bg-emerald-600 text-white',
    selected: 'border-emerald-400 dark:border-emerald-500/60',
    focus: 'focus:border-emerald-500',
    clear: 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
  },
  purple: {
    trigger: 'bg-purple-50 dark:bg-purple-500/10 border-purple-300 dark:border-purple-500/40 text-purple-700 dark:text-purple-400',
    badge: 'bg-purple-600 text-white',
    selected: 'border-purple-400 dark:border-purple-500/60',
    focus: 'focus:border-purple-500',
    clear: 'text-purple-700 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-500/10'
  },
  yellow: {
    trigger: 'bg-yellow-50 dark:bg-yellow-500/10 border-yellow-300 dark:border-yellow-500/40 text-yellow-700 dark:text-yellow-400',
    badge: 'bg-yellow-500 text-slate-900',
    selected: 'border-yellow-400 dark:border-yellow-500/60',
    focus: 'focus:border-yellow-500',
    clear: 'text-yellow-700 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
  },
  indigo: {
    trigger: 'bg-indigo-50 dark:bg-indigo-500/10 border-indigo-300 dark:border-indigo-500/40 text-indigo-700 dark:text-indigo-400',
    badge: 'bg-indigo-600 text-white',
    selected: 'border-indigo-400 dark:border-indigo-500/60',
    focus: 'focus:border-indigo-500',
    clear: 'text-indigo-700 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10'
  }
};

const accentOf = (name) => ACCENTS[name] || ACCENTS.blue;

/**
 * One labelled select inside a FilterPopover. `value === ''` means "All".
 * options: [{ value, label }]
 */
export function FilterSelect({ label, value, onChange, options, allLabel = 'All', accent = 'blue' }) {
  const a = accentOf(accent);
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-slate-50 dark:bg-[#1a1a1c] border rounded-lg py-2 px-3 text-xs font-bold focus:outline-none cursor-pointer text-slate-800 dark:text-white ${a.focus} ${
          value ? a.selected : 'border-slate-200 dark:border-slate-700'
        }`}
      >
        <option value="">{allLabel}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>
    </label>
  );
}

/**
 * Sleek, absolutely positioned "Filters" popover shared by every Academic Data Management table.
 *
 * Props
 * - title:       heading inside the popover ("Filter Rooms")
 * - ariaLabel:   accessible name for the dialog
 * - activeCount: number of filters currently set; shown as a badge on the trigger
 * - summary:     footer text, e.g. "12 of 40 shown"
 * - onClear:     clears every filter
 * - accent:      'blue' | 'emerald' | 'purple' | 'yellow' | 'indigo'
 * - children:    FilterSelect elements
 *
 * Closes on outside click and on Escape (the Escape event is marked defaultPrevented so a
 * modal's own Escape handler ignores it).
 */
export default function FilterPopover({
  title = 'Filters',
  ariaLabel = 'Filters',
  activeCount = 0,
  summary,
  onClear,
  accent = 'blue',
  children
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef(null);
  const a = accentOf(accent);
  const hasActive = activeCount > 0;

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setIsOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={hasActive ? `Filters (${activeCount} active)` : 'Filters'}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold border transition-colors cursor-pointer ${
          hasActive || isOpen
            ? a.trigger
            : 'bg-white dark:bg-[#1a1a1c] border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
        }`}
      >
        <Filter size={16} />
        <span className="hidden sm:inline">Filters</span>
        {hasActive && (
          <span className={`inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[10px] font-black ${a.badge}`}>
            {activeCount}
          </span>
        )}
        <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          className="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-right"
        >
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between">
            <p className="text-xs font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">{title}</p>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close filters"
              className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-white p-0.5 rounded-md cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-4 space-y-3">{children}</div>

          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{summary}</span>
            <button
              type="button"
              onClick={onClear}
              disabled={!hasActive}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${a.clear}`}
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
