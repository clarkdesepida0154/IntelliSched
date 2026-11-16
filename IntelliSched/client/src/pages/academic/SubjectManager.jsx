import { useState, useEffect, useRef } from 'react';
import { Library, Layers, CheckCircle2, AlertCircle, X } from 'lucide-react';
import MasterCatalogTab from './subjects/MasterCatalogTab';
import CurriculumBuilderTab from './subjects/CurriculumBuilderTab';
import { readStorage, writeStorage } from './subjects/subjectFormat';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import usePermission from '../../hooks/usePermission';

const TAB_STORAGE_KEY = 'intellisched.subjectManager.tab';
// The visible reason (Phase 3 Step 6) that every write control of both tabs points at.
const EDIT_NOTE_ID = 'subjects-permission-note';

// Master Catalog: what a subject is (timeless, one record per subject). Curriculum Builder: where
// it is taught (program + year level + semester + track placements that reference the catalog).
// The page's heading and purpose come from the page registry (PageHeader).
const TABS = [
  { id: 'catalog', label: 'Master Catalog', icon: Library },
  { id: 'builder', label: 'Curriculum Builder', icon: Layers }
];
const TAB_IDS = TABS.map(tab => tab.id);
const tabOf = (value) => (TAB_IDS.includes(value) ? value : null);

const loadStoredTab = () => tabOf(readStorage(TAB_STORAGE_KEY)) || TAB_IDS[0];

// Props: `initialTab` ('catalog' | 'builder': the shell passes the address's ?tab=, e.g. the Readiness
// Check's link to a subject's Lecture mode, Phase 3 Step 7) opens that tab, and a new value opens it
// again; without one the tab chosen last time opens. `onTabChange(tab)` (optional) is told when the user
// switches; the shell keeps the address in step (as on Assign Faculty).
export default function SubjectManager({ initialTab = null, onTabChange }) {
  // Creating, editing, disabling, attaching and detaching subjects: the permission map's data.edit (each
  // tab reads it too, and points its write controls at this page's note).
  const edit = usePermission('data.edit');
  const requested = tabOf(initialTab);
  const [activeTab, setActiveTab] = useState(() => requested || loadStoredTab());
  // A new request (another address for this page while it is open) opens its tab; the user's own
  // choice stands until then.
  const [lastRequested, setLastRequested] = useState(requested);
  if (requested !== lastRequested) {
    setLastRequested(requested);
    if (requested) setActiveTab(requested);
  }
  const [toast, setToast] = useState(null);
  const tabRefs = useRef({});
  const toastTimerRef = useRef(null);

  useEffect(() => {
    writeStorage(TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  // Never leave a toast timer running after unmount.
  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // Single toast channel shared by both tabs, so a message survives a tab switch. A new message
  // replaces the previous one and restarts the 4s timer, so an older timer can never dismiss a
  // newer toast (or hide a failure before it has been read). `undo` adds an Undo button (and a
  // longer time to press it).
  const showToast = (message, tone = 'success', undo = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, tone, undo });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, undo ? 10000 : 4000);
  };

  const dismissToast = () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setToast(null);
  };

  const selectTab = (id) => {
    if (id === activeTab) return;
    setActiveTab(id);
    onTabChange?.(id);
  };

  // WAI-ARIA tabs with automatic activation: Left/Right wrap around, Home/End jump to the ends,
  // and focus follows the selection (roving tabindex).
  const handleTabKeyDown = (event) => {
    const index = TAB_IDS.indexOf(activeTab);
    const nextIndex = {
      ArrowRight: (index + 1) % TAB_IDS.length,
      ArrowLeft: (index - 1 + TAB_IDS.length) % TAB_IDS.length,
      Home: 0,
      End: TAB_IDS.length - 1
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextId = TAB_IDS[nextIndex];
    selectTab(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <div className="animate-in fade-in duration-300 relative">
      {/* The card intentionally does not clip its children: the Filters popover is anchored inside
          the catalog toolbar and would otherwise be cut off. Corners are rounded per-section. */}
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg flex flex-col">

        {/* HEADER AREA */}
        <div className="p-6 md:p-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-50/50 dark:bg-white/5 rounded-t-3xl">
          <PageHeader pageKey="subjects" />

          <div
            role="tablist"
            aria-label="Curriculum and subjects views"
            onKeyDown={handleTabKeyDown}
            className="inline-flex shrink-0 p-1 rounded-xl bg-slate-100 dark:bg-[#121212] border border-slate-200 dark:border-slate-800"
          >
            {TABS.map(tab => {
              const isSelected = tab.id === activeTab;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  ref={(node) => { tabRefs.current[tab.id] = node; }}
                  type="button"
                  role="tab"
                  id={`subjects-tab-${tab.id}`}
                  aria-selected={isSelected}
                  aria-controls={`subjects-panel-${tab.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => selectTab(tab.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500 ${
                    isSelected
                      ? 'bg-white dark:bg-[#232326] text-yellow-700 dark:text-yellow-400 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {!edit.allowed && (
          <div className="px-6 md:px-8 pt-4">
            <PermissionNote id={EDIT_NOTE_ID} permission={edit} lead="You can view the subjects and the curriculum." />
          </div>
        )}

        {/* Both panels stay in the DOM so every tab's aria-controls resolves; only the active one
            mounts its content, which re-fetches on entry and so always reflects the other tab's
            latest changes (e.g. a subject disabled in the catalog). */}
        {TABS.map(tab => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`subjects-panel-${tab.id}`}
            aria-labelledby={`subjects-tab-${tab.id}`}
            hidden={tab.id !== activeTab}
          >
            {tab.id === activeTab && (tab.id === 'catalog'
              ? <MasterCatalogTab onToast={showToast} editNoteId={EDIT_NOTE_ID} />
              : <CurriculumBuilderTab onToast={showToast} editNoteId={EDIT_NOTE_ID} />)}
          </div>
        ))}
      </div>

      {/* Toast Notification. The live region stays mounted so assistive tech announces every
          message; only the toast body is conditional. Failures get a distinct icon and tint. */}
      <div role="status" aria-live="polite" className="fixed bottom-6 right-6 z-50">
        {toast && (
          <div className="flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
              toast.tone === 'error'
                ? 'bg-red-500/20 dark:bg-red-500/15 text-red-400 dark:text-red-600'
                : 'bg-yellow-500/20 dark:bg-yellow-500/15 text-yellow-600 dark:text-yellow-500'
            }`}>
              {toast.tone === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
            </div>
            <span data-testid="subjects-toast-message" className="text-xs font-bold tracking-wide">{toast.message}</span>
            {toast.undo && (
              <button type="button" data-testid="subjects-undo" onClick={() => { const undo = toast.undo; dismissToast(); undo(); }} className="ml-1 shrink-0 px-2.5 py-1 rounded-lg text-xs font-black text-yellow-300 dark:text-yellow-800 hover:bg-white/10 dark:hover:bg-slate-900/10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500">
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={dismissToast}
              aria-label="Dismiss notification"
              className="ml-2 text-slate-400 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
