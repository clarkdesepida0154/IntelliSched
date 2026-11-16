import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

// Phase 13 (decision 1): one styled dropdown whose open list matches its button. A drop-in swap for a
// native <select>: the same props (value, onChange, disabled, id, className, aria-*, data-testid) and the
// same <option> / <optgroup> children.
//
// What the user sees and uses is a select-only combobox (WAI-ARIA APG): a button with
// role="combobox", aria-expanded and aria-activedescendant, and a list with role="listbox" drawn in the
// app's own style (radius, border, shadow, hover, a check mark on the chosen item, the dark theme),
// opened below the button or above it when there is no room, kept inside the window and scrolling when
// long; keyboard: Up/Down, Home/End, PageUp/PageDown, Enter and Space, Esc, Tab, and typing to jump.
//
// Beside it sits the native <select> itself, visually hidden and out of the tab order (as Radix Select
// does): a choice is made by setting ITS value and sending a real "change" event, so every onChange
// handler receives the same event as before (e.target.value, e.target.selectedOptions…), and every
// test, label (htmlFor) and form that reads the native control keeps working. The data-testid and the
// id stay on the native control; the button is `<testid>-button`, the list `<testid>-list`. The native
// control comes first and is absolutely placed, so sibling spacing (space-y, gap) stays as it was.

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(node.props.children);
  return '';
};

// The <option> and <optgroup> children as a flat list (fragments and arrays unwrapped).
const collectOptions = (children, group, out) => {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) { collectOptions(child.props.children, group, out); return; }
    if (child.type === 'optgroup') {
      const label = String(child.props.label ?? '');
      out.push({ kind: 'group', label, key: `g${out.length}` });
      collectOptions(child.props.children, { label, disabled: Boolean(child.props.disabled) }, out);
      return;
    }
    if (child.type === 'option') {
      const label = textOf(child.props.children);
      const value = child.props.value !== undefined && child.props.value !== null ? String(child.props.value) : label;
      if (child.props.hidden) return;
      out.push({ kind: 'option', value, label, disabled: Boolean(child.props.disabled || group?.disabled), key: `o${out.length}` });
    }
  });
  return out;
};

// Each option's place among the options (a group is a heading only).
const numberOptions = (list) => {
  const out = [];
  let n = 0;
  for (const item of list) {
    if (item.kind === 'option') { out.push({ ...item, index: n }); n += 1; } else out.push(item);
  }
  return out;
};

const MAX_LIST_HEIGHT = 288;
const GAP = 4;
const EDGE = 8;

export default function Select({
  value, defaultValue, onChange, onBlur, children, disabled = false, className = '', id, name, required,
  title, style, listClassName = '', valueLabel, 'data-testid': testId, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy, 'aria-invalid': ariaInvalid, ref: externalRef, ...rest
}) {
  const autoId = useId().replace(/:/g, '');
  const baseId = id || `sel-${autoId}`;
  const buttonId = `${baseId}-button`;
  const listId = `${baseId}-list`;
  const buttonRef = useRef(null);
  const nativeRef = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState(null);
  const [labelId, setLabelId] = useState(null);
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue !== undefined ? String(defaultValue) : undefined);

  const items = useMemo(() => numberOptions(collectOptions(children, null, [])), [children]);
  const options = useMemo(() => items.filter(i => i.kind === 'option'), [items]);
  const current = controlled ? (value === null ? '' : String(value)) : (inner ?? options[0]?.value ?? '');
  const selectedIndex = options.findIndex(o => o.value === current);
  const shown = selectedIndex >= 0 ? options[selectedIndex] : (current === '' ? options[0] : null);

  // A <label htmlFor={id}> names the button too (it labels the native control by its id).
  // So does a <label> around it.
  useLayoutEffect(() => {
    if (ariaLabel || ariaLabelledBy) return;
    const label = (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null) || buttonRef.current?.closest('label');
    if (!label) return;
    if (!label.id) label.id = `${baseId}-label`;
    setLabelId(label.id);
  }, [id, baseId, ariaLabel, ariaLabelledBy]);

  const firstEnabled = useCallback((from, step) => {
    for (let i = from; i >= 0 && i < options.length; i += step) if (!options[i].disabled) return i;
    return -1;
  }, [options]);

  const openList = useCallback((at) => {
    if (disabled) return;
    const start = at ?? (selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : firstEnabled(0, 1));
    setActive(start);
    setOpen(true);
  }, [disabled, selectedIndex, options, firstEnabled]);

  const closeList = useCallback((focusButton = true) => {
    setOpen(false);
    setPlace(null);
    if (focusButton) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // A choice: the native control's value, then a real change event (React's onChange runs as for a user).
  const choose = useCallback((index) => {
    const option = options[index];
    if (!option || option.disabled) return;
    closeList(true);
    if (option.value === current) return;
    const el = nativeRef.current;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, option.value);
    if (!controlled) setInner(option.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [options, current, controlled, closeList]);

  // Where the list goes: below the button, or above it when there is more room there; inside the window.
  const measure = useCallback(() => {
    const button = buttonRef.current;
    const list = listRef.current;
    if (!button || !list) return;
    const r = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const natural = Math.min(list.scrollHeight, MAX_LIST_HEIGHT);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = below < natural && above > below;
    const maxHeight = Math.max(80, Math.min(MAX_LIST_HEIGHT, up ? above : below));
    const width = Math.min(Math.max(list.offsetWidth, r.width), vw - EDGE * 2);
    const left = Math.min(Math.max(EDGE, r.left), vw - EDGE - width);
    setPlace({ up, left, minWidth: Math.min(r.width, vw - EDGE * 2), maxHeight, top: up ? undefined : r.bottom + GAP, bottom: up ? vh - r.top + GAP : undefined });
  }, []);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const again = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const outside = (e) => {
      if (buttonRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      closeList(false);
    };
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    // Esc closes the list wherever the focus is (the button handles it first when it has the focus).
    const escape = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeList(true); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
    };
  }, [open, measure, closeList]);

  // The active option stays in view inside the list.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [open, active, place]);

  // Typing jumps to the next option that starts with the typed letters.
  const jumpTo = (char) => {
    const now = Date.now();
    const t = typeahead.current;
    t.text = now - t.at > 600 ? char : t.text + char;
    t.at = now;
    const text = t.text.toLowerCase();
    const repeated = text.split('').every(c => c === text[0]);
    const from = open ? active : selectedIndex;
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (Math.max(from, -1) + (repeated || text.length === 1 ? k : k - 1) + n) % n;
      const o = options[i];
      if (o.disabled) continue;
      const label = o.label.toLowerCase().trim();
      if (label.startsWith(repeated ? text[0] : text) || (repeated && label.startsWith(text))) return i;
    }
    return -1;
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(key)) {
        e.preventDefault();
        if (key === 'Home') openList(firstEnabled(0, 1));
        else if (key === 'End') openList(firstEnabled(options.length - 1, -1));
        else openList();
        return;
      }
      if (key.length === 1 && /\S/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = jumpTo(key);
        if (i >= 0) openList(i);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown': { e.preventDefault(); if (e.altKey) break; const i = firstEnabled(active + 1, 1); if (i >= 0) setActive(i); break; }
      case 'ArrowUp': { e.preventDefault(); if (e.altKey) { choose(active); break; } const i = firstEnabled(active - 1, -1); if (i >= 0) setActive(i); break; }
      case 'Home': { e.preventDefault(); setActive(firstEnabled(0, 1)); break; }
      case 'End': { e.preventDefault(); setActive(firstEnabled(options.length - 1, -1)); break; }
      case 'PageDown': { e.preventDefault(); const i = firstEnabled(Math.min(options.length - 1, active + 10), 1); setActive(i >= 0 ? i : firstEnabled(options.length - 1, -1)); break; }
      case 'PageUp': { e.preventDefault(); const i = firstEnabled(Math.max(0, active - 10), -1); setActive(i >= 0 ? i : firstEnabled(0, 1)); break; }
      case 'Enter': { e.preventDefault(); choose(active); break; }
      case ' ': {
        e.preventDefault();
        if (Date.now() - typeahead.current.at < 600 && typeahead.current.text) { const i = jumpTo(' '); if (i >= 0) setActive(i); } else choose(active);
        break;
      }
      // Esc closes the list only: a dialog around it stays open.
      case 'Escape': { e.preventDefault(); e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); closeList(true); break; }
      case 'Tab': { closeList(false); break; }
      default:
        if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { const i = jumpTo(key); if (i >= 0) setActive(i); }
    }
  };

  const activeId = open && active >= 0 ? `${baseId}-opt-${active}` : undefined;
  const optionTestId = (i) => (testId ? `${testId}-option-${i}` : undefined);

  return (
    <>
      <select
        ref={(el) => { nativeRef.current = el; if (typeof externalRef === 'function') externalRef(el); else if (externalRef) externalRef.current = el; }}
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        data-testid={testId}
        aria-label={ariaLabel}
        title={title}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        {...(controlled ? { value: value === null ? '' : value } : { defaultValue })}
        onChange={(e) => { if (!controlled) setInner(e.target.value); onChange?.(e); }}
        onFocus={() => buttonRef.current?.focus({ preventScroll: true })}
        {...rest}
      >
        {children}
      </select>
      <button
        ref={buttonRef}
        type="button"
        id={buttonId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy || (!ariaLabel && labelId ? labelId : undefined)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-required={required || undefined}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={title}
        style={style}
        data-testid={testId ? `${testId}-button` : undefined}
        data-value={current}
        className={`is-select-button inline-flex items-center justify-between gap-1 text-left select-none disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-[#18181b] ${className}`}
        // WebKit (Safari) does not focus a button on a click: focus it, so the keyboard reaches the list.
        onClick={() => { buttonRef.current?.focus({ preventScroll: true }); if (open) closeList(true); else openList(); }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        {/* Every label in one grid cell, so the button is as wide as the longest option (as a native select is). */}
        <span className="grid min-w-0 flex-1" aria-hidden={false}>
          <span className="col-start-1 row-start-1 truncate">{shown ? (valueLabel ? valueLabel(shown) : shown.label) : '\u00a0'}</span>
          {options.length <= 60 && options.map(o => valueLabel ? { ...o, label: valueLabel(o) } : o).map(o => (
            <span key={o.key} aria-hidden="true" className="col-start-1 row-start-1 truncate invisible h-0 overflow-hidden">{o.label}</span>
          ))}
        </span>
        <ChevronDown size={12} aria-hidden="true" className={`shrink-0 opacity-60 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={ariaLabelledBy || labelId || undefined}
          aria-label={!ariaLabelledBy && !labelId ? ariaLabel : undefined}
          data-testid={testId ? `${testId}-list` : undefined}
          data-side={place?.up ? 'top' : 'bottom'}
          onMouseDown={(e) => e.preventDefault()}
          className={`is-select-list fixed z-[1000] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c] shadow-xl shadow-slate-900/10 dark:shadow-black/40 p-1 text-xs font-bold text-slate-800 dark:text-slate-100 ${place?.up ? 'origin-bottom' : 'origin-top'} ${listClassName}`}
          style={place
            ? { left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth, maxWidth: `calc(100vw - ${EDGE * 2}px)`, maxHeight: place.maxHeight }
            : { left: -9999, top: 0, visibility: 'hidden', maxHeight: MAX_LIST_HEIGHT }}
        >
          {items.map((item) => {
            if (item.kind === 'group') {
              return <li key={item.key} role="presentation" className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 whitespace-nowrap">{item.label}</li>;
            }
            const i = item.index;
            const selected = i === selectedIndex;
            const isActive = i === active;
            return (
              <li
                key={item.key}
                id={`${baseId}-opt-${i}`}
                role="option"
                data-index={i}
                data-testid={optionTestId(i)}
                data-value={item.value}
                aria-selected={selected}
                aria-disabled={item.disabled || undefined}
                onMouseMove={() => { if (!item.disabled && active !== i) setActive(i); }}
                onClick={() => choose(i)}
                className={`flex items-center gap-2 rounded-lg pl-2 pr-3 py-1.5 whitespace-nowrap ${
                  item.disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'
                } ${isActive && !item.disabled ? 'bg-slate-100 dark:bg-white/[0.07]' : ''} ${selected ? 'text-blue-700 dark:text-blue-300' : ''}`}
              >
                <Check size={13} aria-hidden="true" className={`shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                <span className="truncate">{item.label || '\u00a0'}</span>
              </li>
            );
          })}
        </ul>,
        document.body
      )}
    </>
  );
}
