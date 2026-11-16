import { useState, useRef, useEffect, useId } from 'react';
import { Search, X, Check, Tag } from 'lucide-react';

/**
 * MultiSelectTags — searchable multi-select that stores its value as an array of strings.
 *
 * Usage:
 *   <MultiSelectTags options={CATALOG} value={form.tags} onChange={(next) => setForm({ ...form, tags: next })} />
 *
 * Behaviour:
 *   - Type to filter the standardized catalog; Enter or click adds the highlighted option as a chip.
 *   - Arrow keys move the highlight, Backspace on an empty query removes the last chip, Escape closes.
 *   - Values that are no longer in `options` (legacy data) still render as removable chips.
 *   - The option panel renders in normal document flow (not absolutely positioned), so it is never
 *     clipped inside scrollable modal bodies.
 */
export default function MultiSelectTags({
  options = [],
  value = [],
  onChange,
  placeholder = 'Search and select...',
  disabled = false,
  emptyMessage = 'No matching options.',
  panelHeightClass = 'max-h-48',
  ariaLabel = 'Searchable multi-select'
}) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listboxId = useId();

  const selected = Array.isArray(value) ? value : [];
  const normalizedQuery = query.trim().toLowerCase();
  const remainingOptions = options.filter(opt => !selected.includes(opt));
  const availableOptions = normalizedQuery
    ? remainingOptions.filter(opt => opt.toLowerCase().includes(normalizedQuery))
    : remainingOptions;
  const safeHighlight = Math.min(highlightIndex, Math.max(availableOptions.length - 1, 0));

  // Close the panel when the user clicks anywhere outside the component.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen]);

  // Keep the highlighted option visible while navigating with the keyboard.
  useEffect(() => {
    if (!isOpen) return;
    const el = document.getElementById(`${listboxId}-opt-${safeHighlight}`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [isOpen, safeHighlight, listboxId]);

  const emit = (next) => {
    if (typeof onChange === 'function') onChange(next);
  };

  const addOption = (opt) => {
    if (!opt || selected.includes(opt)) return;
    emit([...selected, opt]);
    setQuery('');
    setHighlightIndex(0);
    setIsOpen(true);
    inputRef.current?.focus();
  };

  const removeOption = (opt) => {
    emit(selected.filter(item => item !== opt));
    inputRef.current?.focus();
  };

  const clearAll = () => {
    emit([]);
    setQuery('');
    setHighlightIndex(0);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          return;
        }
        setHighlightIndex(i => Math.min(i + 1, Math.max(availableOptions.length - 1, 0)));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlightIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        // Never let Enter submit the surrounding form from inside the search box.
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          return;
        }
        if (availableOptions[safeHighlight]) addOption(availableOptions[safeHighlight]);
        break;
      case 'Backspace':
        if (!query && selected.length) {
          event.preventDefault();
          removeOption(selected[selected.length - 1]);
        }
        break;
      case 'Escape':
        // Only consume Escape while the list is open. When it is already closed the key must
        // bubble so an enclosing dialog can dismiss itself.
        if (!isOpen) break;
        event.preventDefault();
        setIsOpen(false);
        break;
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        break;
    }
  };

  const renderLabel = (label) => {
    if (!normalizedQuery) return label;
    const idx = label.toLowerCase().indexOf(normalizedQuery);
    if (idx === -1) return label;
    return (
      <>
        {label.slice(0, idx)}
        <mark className="bg-transparent text-blue-600 dark:text-blue-400 font-black">
          {label.slice(idx, idx + normalizedQuery.length)}
        </mark>
        {label.slice(idx + normalizedQuery.length)}
      </>
    );
  };

  const openAndFocus = () => {
    if (disabled) return;
    inputRef.current?.focus();
    setIsOpen(true);
  };

  return (
    <div ref={containerRef} className="w-full">
      {/* FIELD SHELL: selected chips + search input */}
      <div
        onClick={openAndFocus}
        className={`w-full min-h-11 flex flex-wrap items-center gap-1.5 bg-slate-50 dark:bg-[#1a1a1c] border rounded-xl px-2.5 py-1.5 transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-text'
        } ${isOpen ? 'border-blue-500 ring-1 ring-blue-500/20' : 'border-slate-200 dark:border-slate-700'}`}
      >
        {selected.map(item => (
          <span
            key={item}
            className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-lg bg-blue-600 text-white text-xs font-bold shadow-sm max-w-full"
          >
            <span className="truncate">{item}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeOption(item); }}
              disabled={disabled}
              aria-label={`Remove ${item}`}
              title={`Remove ${item}`}
              className="p-0.5 rounded-md hover:bg-white/20 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <X size={12} />
            </button>
          </span>
        ))}

        <div className="flex items-center flex-1 min-w-35">
          <Search size={14} className="text-slate-500 dark:text-slate-400 mr-1.5 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={isOpen && availableOptions.length ? `${listboxId}-opt-${safeHighlight}` : undefined}
            value={query}
            disabled={disabled}
            placeholder={selected.length ? 'Add another...' : placeholder}
            onChange={(e) => { setQuery(e.target.value); setHighlightIndex(0); setIsOpen(true); }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent border-none outline-none text-sm text-slate-900 dark:text-white placeholder-slate-400 py-1 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* STATUS LINE */}
      <div className="flex items-center justify-between mt-1.5 px-0.5">
        <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center">
          <Tag size={11} className="mr-1" />
          {selected.length} selected
          <span className="mx-1.5">·</span>
          {normalizedQuery ? `${availableOptions.length} match` : `${remainingOptions.length} available`}
        </p>
        {selected.length > 0 && !disabled && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] font-bold text-slate-500 hover:text-red-500 transition-colors cursor-pointer"
          >
            Clear all
          </button>
        )}
      </div>

      {/* OPTION PANEL (in-flow, never clipped by scrolling modals) */}
      {isOpen && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          className={`mt-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#18181b] shadow-lg overflow-y-auto custom-scrollbar ${panelHeightClass} animate-in fade-in duration-150`}
        >
          {availableOptions.length === 0 ? (
            <li className="px-3.5 py-3 text-xs text-slate-500 dark:text-slate-400 italic" role="presentation">
              {normalizedQuery ? emptyMessage : 'All options have been selected.'}
            </li>
          ) : (
            availableOptions.map((opt, index) => {
              const isHighlighted = index === safeHighlight;
              return (
                <li
                  key={opt}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => addOption(opt)}
                  className={`flex items-center justify-between px-3.5 py-2 text-xs cursor-pointer transition-colors ${
                    isHighlighted
                      ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300'
                      : 'text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <span className="truncate">{renderLabel(opt)}</span>
                  {isHighlighted && <Check size={13} className="shrink-0 ml-2 opacity-70" />}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
