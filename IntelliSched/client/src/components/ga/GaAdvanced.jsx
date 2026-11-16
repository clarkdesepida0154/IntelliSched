import { ChevronDown, Lock, Wrench } from 'lucide-react';

// "Advanced (system team)" at the bottom of the Generate Schedule page (Phase 3 Step 4): collapsed, and
// only the roles of the permission map's advanced.edit can open it (Step 6). Everyone else sees the
// header disabled, with the map's reason (closedReason) next to it. Its content (the GA settings, the
// TBA rooms, the penalty weights and the technical results) is mounted only while it is open.
// Test ids: generate-advanced-area, generate-advanced-toggle (aria-expanded, aria-controls),
// generate-advanced-reason (why it is closed), generate-advanced (the region).
export default function GaAdvanced({ canOpen, closedReason, open, onToggle, children }) {
  const isOpen = Boolean(canOpen && open);
  return (
    <section data-testid="generate-advanced-area" aria-labelledby="generate-advanced-toggle" className="bg-white dark:bg-[#1a1a1c] p-6 rounded-3xl border border-slate-200 dark:border-slate-800 space-y-3">
      <h3 className="m-0">
        <button
          type="button"
          id="generate-advanced-toggle"
          data-testid="generate-advanced-toggle"
          aria-expanded={isOpen}
          aria-controls="generate-advanced"
          aria-describedby={canOpen ? undefined : 'generate-advanced-reason'}
          disabled={!canOpen}
          onClick={onToggle}
          className="w-full flex items-center justify-between gap-3 text-sm font-bold text-slate-800 dark:text-white py-1 rounded cursor-pointer disabled:cursor-not-allowed disabled:text-slate-600 dark:disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span className="flex items-center">
            {canOpen
              ? <Wrench size={15} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
              : <Lock size={15} className="mr-2" aria-hidden="true" />}
            Advanced (system team)
          </span>
          <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h3>
      {!canOpen && (
        <p id="generate-advanced-reason" data-testid="generate-advanced-reason" className="text-xs text-slate-600 dark:text-slate-400">{closedReason}</p>
      )}
      {canOpen && !isOpen && (
        <p className="text-xs text-slate-600 dark:text-slate-400">The generation settings, the TBA rooms, the penalty weights, and the technical results of the runs.</p>
      )}
      <div id="generate-advanced" data-testid="generate-advanced" hidden={!isOpen} className="space-y-6 pt-3 border-t border-slate-200 dark:border-slate-800">
        {isOpen && children}
      </div>
    </section>
  );
}
