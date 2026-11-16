import { ChevronDown, Lock, Wrench } from 'lucide-react';
import { reasonFor } from '../../utils/permissions';

// "Advanced (system team)" (Phase 3 Step 4, the Dean's feedback: nothing technical unless the System
// Admin opens it). A collapsed area at the bottom of a page that only the roles of the permission map's
// advanced.edit can open (Phase 3 Step 6: the page passes usePermission('advanced.edit')). For every
// other role the header stays visible but is disabled, with the map's reason next to it, so nothing is
// hidden without an explanation. The content mounts only while the area is open, so a closed area can't
// be reached with Tab.
// Ids: `${idPrefix}-advanced-toggle` (the header button, aria-expanded / aria-controls), the reason or
// summary `${idPrefix}-advanced-reason`, the panel `${idPrefix}-advanced`.
export default function AdvancedSection({
  idPrefix, canOpen, isOpen, onToggle, summary = '', reason = reasonFor('advanced.edit'), children
}) {
  const open = Boolean(canOpen && isOpen);
  const panelId = `${idPrefix}-advanced`;
  const reasonId = `${idPrefix}-advanced-reason`;
  return (
    <section data-testid={`${idPrefix}-advanced-area`} className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-sm">
      <h3 className="text-base font-black">
        <button
          type="button"
          data-testid={`${idPrefix}-advanced-toggle`}
          onClick={onToggle}
          disabled={!canOpen}
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={reasonId}
          className="w-full flex items-center gap-3 px-6 pt-5 pb-2 text-left rounded-t-3xl cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-500"
        >
          <span className="p-2 bg-slate-500/10 rounded-xl shrink-0">
            {canOpen
              ? <Wrench size={18} className="text-slate-700 dark:text-slate-300" aria-hidden="true" />
              : <Lock size={18} className="text-slate-600 dark:text-slate-400" aria-hidden="true" />}
          </span>
          <span className={`flex-1 min-w-0 ${canOpen ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>Advanced (system team)</span>
          {canOpen && <ChevronDown size={18} aria-hidden="true" className={`shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />}
        </button>
      </h3>
      <p id={reasonId} data-testid={reasonId} className="px-6 pb-5 ml-12 text-xs text-slate-600 dark:text-slate-400 leading-snug">
        {canOpen ? summary : reason}
      </p>
      <div id={panelId} data-testid={panelId} hidden={!open} className="px-6 pb-6">
        {open && children}
      </div>
    </section>
  );
}
