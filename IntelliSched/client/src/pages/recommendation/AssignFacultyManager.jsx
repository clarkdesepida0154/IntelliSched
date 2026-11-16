import { useEffect, useRef, useState } from 'react';
import { Layers, BrainCircuit } from 'lucide-react';
import CourseMatrixManager from './CourseMatrixManager';
import CandidateRankingManager from './CandidateRankingManager';
import PageHeader from '../../components/layout/PageHeader';
import PartTimeLoadsPanel from '../../components/assign/PartTimeLoadsPanel';
import HelpTip from '../../components/ui/HelpTip';
import { readStorage, writeStorage } from '../academic/subjects/subjectFormat';

// Assign Faculty (Phase 3 Step 4): the Course Assignment Matrix and Candidate Ranking pages merged into
// one page with two tabs, "By class" and "Recommendations", following SubjectManager's tab pattern (a
// tablist with arrow keys, panels that mount only the active tab, the tab remembered in this browser).
// Both tabs write their locks through the one shared queue (utils/lockQueue.js), and each tab reloads
// when it is opened, so a professor chosen on one tab shows on the other.
//
// Props: `initialTab` ('by-class' | 'recommendations': the shell passes the address's ?tab=, the old
// Course Assignment Matrix and Candidate Ranking addresses included) opens that tab, and a new value
// opens it again (a "Fix this" link while the page is open); without one the tab chosen last time opens.
// `onTabChange(tab)` (optional) is told when the user switches; the shell keeps the address in step.
const TAB_STORAGE_KEY = 'intellisched.assignFaculty.tab';
const TABS = [
  {
    id: 'by-class',
    label: 'By class',
    icon: Layers,
    // Phase 8 Part 4 (decision 5): one section at a time, one row per class, a click or two to assign.
    help: 'Accept a pick, or accept them all for the section. GenEd and Minor classes keep their manual choice; NSTP stays TBA.'
  },
  {
    id: 'recommendations',
    label: 'Recommendations',
    icon: BrainCircuit,
    help: 'Approve the first, or choose another with a reason.'
  }
];
const TAB_IDS = TABS.map(tab => tab.id);
const tabOf = (value) => (TAB_IDS.includes(value) ? value : null);
const loadStoredTab = () => tabOf(readStorage(TAB_STORAGE_KEY)) || TAB_IDS[0];

export default function AssignFacultyManager({ initialTab = null, onTabChange }) {
  const requested = tabOf(initialTab);
  const [activeTab, setActiveTab] = useState(() => requested || loadStoredTab());
  // A new request (another address for this page while it is open) opens its tab; the user's own
  // choice stands until then.
  const [lastRequested, setLastRequested] = useState(requested);
  if (requested !== lastRequested) {
    setLastRequested(requested);
    if (requested) setActiveTab(requested);
  }
  const tabRefs = useRef({});

  useEffect(() => {
    writeStorage(TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  const selectTab = (id) => {
    if (id === activeTab) return;
    setActiveTab(id);
    onTabChange?.(id);
  };

  // WAI-ARIA tabs with automatic activation: Left/Right wrap around, Home/End jump to the ends, and
  // focus follows the selection (roving tabindex).
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

  const activeTabMeta = TABS.find(t => t.id === activeTab);

  return (
    <div className="animate-in fade-in duration-300 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col mb-6">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="assign-faculty" />

          <div
            role="tablist"
            aria-label="Ways to assign faculty"
            onKeyDown={handleTabKeyDown}
            className="inline-flex shrink-0 p-1 rounded-xl bg-slate-100 dark:bg-[#121212] border border-slate-200 dark:border-slate-800"
          >
            {TABS.map(t => {
              const isSelected = t.id === activeTab;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  ref={(node) => { tabRefs.current[t.id] = node; }}
                  type="button"
                  role="tab"
                  id={`assign-tab-${t.id}`}
                  data-testid={`assign-tab-${t.id}`}
                  aria-selected={isSelected}
                  aria-controls={`assign-panel-${t.id}`}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => selectTab(t.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                    isSelected
                      ? 'bg-white dark:bg-[#232326] text-cyan-700 dark:text-cyan-300 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
                  }`}
                >
                  <Icon size={16} className="shrink-0" aria-hidden="true" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {/* Both panels stay in the DOM so every tab's aria-controls resolves; only the active one mounts
            its content, which reloads on entry and so always shows the other tab's latest choices. */}
        {TABS.map(t => (
          <div
            key={t.id}
            role="tabpanel"
            id={`assign-panel-${t.id}`}
            data-testid={`assign-panel-${t.id}`}
            aria-labelledby={`assign-tab-${t.id}`}
            hidden={t.id !== activeTab}
          >
            {t.id === activeTab && (t.id === 'by-class'
              ? <CourseMatrixManager embedded intro={<span data-testid="assign-tab-help">{activeTabMeta.help}</span>} />
              : (
                <>
                  <div className="px-6 md:px-8 pt-3"><HelpTip label="this tab" testid="assign-tab-help-tip"><span data-testid="assign-tab-help">{activeTabMeta.help}</span></HelpTip></div>
                  <CandidateRankingManager embedded />
                </>
              ))}
          </div>
        ))}
      </div>

      {/* Phase 8 Step 4: the part-time loads and the Dean's equal-loads balance, under the tabs. */}
      <PartTimeLoadsPanel />
    </div>
  );
}
