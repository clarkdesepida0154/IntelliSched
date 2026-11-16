import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { versionName } from '../../utils/scheduleDisplay';
import { Menu, X, ChevronDown, LogOut, Search, Bell, Loader2, ArrowRight, Lock } from 'lucide-react';
import ThemeToggle from '../../components/ui/ThemeToggle';
import Wordmark from '../../components/ui/Wordmark';
import TermSelector from '../../components/layout/TermSelector';
import PageHeader from '../../components/layout/PageHeader';
import { useTerm } from '../../context/term';
import api from '../../services/api';
import {
  menuFor, pagesFor, pageOf, groupOf, canSeePage, resolvePage, parseAddress, pageAddress, HOME_PAGE_KEY, SYSTEM_TEAM_ACTION
} from '../../navigation/pages';
import { useAddressHash, goToAddress } from '../../navigation/address';
import { whoMay } from '../../utils/permissionText';

// --- PAGES (one per registry key, navigation/pages.js) ---
import TermChecklist from './TermChecklist';
import FacultyManager from '../academic/FacultyManager';
import SubjectManager from '../academic/SubjectManager';
import SectionManager from '../academic/SectionManager';
import RoomManager from '../academic/RoomManager';
import SchedulingPolicyManager from '../academic/SchedulingPolicyManager';
import AssignFacultyManager from '../recommendation/AssignFacultyManager';
import ModelFeedbackManager from '../recommendation/ModelFeedbackManager';
import FeasibilityValidator from '../scheduling/FeasibilityValidator';
import GAGenerationManager from '../scheduling/GAGenerationManager';
import ScheduleViews from '../management/ScheduleViews';
import VersionManager from '../management/VersionManager';
import ApprovalWorkflow from '../management/ApprovalWorkflow';
// TEMP HIDDEN FOR DEFENSE: analytics modules below are parked until after the capstone defense.
// import FacultyWorkloadAnalytics from '../analytics/FacultyWorkloadAnalytics';
// import RoomOccupancyAnalytics from '../analytics/RoomOccupancyAnalytics';
import PrintOutputs from '../analytics/PrintOutputs';
import SystemAuditTrail from '../analytics/SystemAuditTrail';
import UserManagement from '../admin/UserManagement';
import ServiceHealth from '../admin/EngineApiHealth';
import OutputSettings from '../admin/OutputSettings';
import ReferenceLists from '../admin/ReferenceLists';
import SystemPage from '../admin/SystemPage';

const PAGE_PADDING = 'px-6 lg:px-8';
// Phase 13 (decision 3): the menu's collapse and expand. The labels fade (opacity only) and the width
// changes, never both at once, and nothing inside the menu reflows.
const LABEL_FADE_MS = 100;
const MENU_WIDTH_MS = 220;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
// How long the "Switching to …" note shows before a link opens its page.
const SWITCH_DELAY_MS = 320;

// Below Tailwind's md breakpoint the menu is an off-canvas panel; while it is closed its buttons are
// inert, so Tab never reaches them (audit X5).
const WIDE_QUERY = '(min-width: 48rem)';
const subscribeToWidth = (onChange) => {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const isWideScreen = () => window.matchMedia(WIDE_QUERY).matches;

// Moves the keyboard focus to the heading of the page shown in this container (PageHeader).
const focusPageTitle = (container) => container?.querySelector('[data-testid="page-title"]')?.focus({ preventScroll: true });

// A page this role may not open (it is not in the role's menu, but its address was typed or kept). Who
// may open it comes from the permission map (the page's own permission, else the system team's: navigation/pages.js).
function NotAllowedPage({ pageKey, onNavigate }) {
  const page = pageOf(pageKey);
  // Phase 11.4: a page with its own permission (System, Users & Roles) names who may open it.
  const who = whoMay(page.permission || SYSTEM_TEAM_ACTION);
  return (
    <div data-testid="page-not-allowed" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg p-6 md:p-8 space-y-5">
      <PageHeader pageKey={pageKey} />
      <div role="alert" className="flex items-start gap-3 p-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200">
        <Lock size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-3">
          <p>Only {who} can open {page.name}. Ask {who} if you need what it shows.</p>
          <button
            type="button"
            data-testid="page-not-allowed-home"
            onClick={() => onNavigate(HOME_PAGE_KEY)}
            className="inline-flex items-center px-4 py-2 rounded-xl text-xs font-bold text-white bg-blue-800 hover:bg-blue-700 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Open the {pageOf(HOME_PAGE_KEY).name} <ArrowRight size={14} className="ml-1.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

// The Schedule Views & Editor params that open the version GET /schedule/active names. Only a
// version in the current format with classes opens there; otherwise the page opens its own default.
const viewsParamsOf = (activeAnswer) => {
  const s = activeAnswer?.schedule;
  return s?._id && activeAnswer.legacy === false && s.scheduleData?.length > 0 ? { scheduleId: String(s._id) } : null;
};

// The top bar's notifications for the term: the schedule the term shows now, and any service that
// does not answer. Measured when the dashboard opens, when the term changes and when the list opens.
// `isAdmin`: the user sees Service Health (the system team's page), so a service notice opens it;
// anyone else is told whom to tell (the permission map's system team).
const loadNotifications = async ({ academicYear, semester, isAdmin }) => {
  const tell = `Tell ${whoMay(SYSTEM_TEAM_ACTION)}.`;
  const [healthRes, activeRes] = await Promise.allSettled([
    api.get('/health'),
    api.get('/schedule/active', { params: { academicYear, semester } })
  ]);
  const list = [];
  const active = activeRes.status === 'fulfilled' ? activeRes.value.data : null;
  const schedule = active?.schedule;
  if (schedule && schedule.scheduleData?.length > 0) {
    const classes = schedule.scheduleData.length;
    list.push({
      id: 'schedule',
      title: `Mother Schedule ${versionName(schedule.version)}: ${schedule.status}`,
      detail: `${classes} ${classes === 1 ? 'class' : 'classes'}. Open it in ${pageOf('schedule-views').name}.`,
      target: 'schedule-views',
      params: viewsParamsOf(active)
    });
  }
  if (healthRes.status === 'rejected') {
    list.push({ id: 'gateway', title: 'The IntelliSched server is not answering', detail: 'Check the network connection, then reload the page.' });
  } else {
    const services = healthRes.value.data?.services;
    if (services?.mongo?.status && services.mongo.status !== 'Online') {
      list.push({ id: 'database', title: 'The database is not connected', detail: `Nothing can be saved until it is back. ${tell}`, target: isAdmin ? 'api-health' : null });
    }
    if (services?.python?.status && services.python.status !== 'Online') {
      list.push({
        id: 'service',
        title: 'The scheduling service is not answering',
        detail: `The recommendations and ${pageOf('generate').name} need it. ${isAdmin ? `Check it in ${pageOf('api-health').name}.` : tell}`,
        target: isAdmin ? 'api-health' : null
      });
    }
  }
  return list;
};

export default function Dashboard({ onLogout, currentUser }) {
  const role = currentUser?.role || '';
  // Whether this role sees the system team's pages (Service Health among them): the permission map.
  const isAdmin = canSeePage(pageOf('api-health'), role);
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  // Term-scoped pages remount on a term switch, so no result, selection or in-flight load from the
  // previous term can surface under the new one.
  const termKey = `${activeAcademicYear}-${activeSemesterNumber}`;

  // ---------------------------------------------------------------- the address (#/<page>?<params>)
  const hash = useAddressHash();
  const asked = parseAddress(hash);
  const target = resolvePage(asked.key, asked.params);
  const page = pageOf(target.key);
  // Parameters that name a term's records (a version, a section) hold only for the term they were
  // given in: a term switch opens the page plainly (the address then drops them).
  const [addressTerm, setAddressTerm] = useState({ hash, termKey });
  if (addressTerm.hash !== hash) setAddressTerm({ hash, termKey });
  const params = page.termParams && addressTerm.termKey !== termKey ? {} : target.params;
  const shownAddress = pageAddress(page.key, params);
  const allowed = canSeePage(page, role);

  // An old key, a key that is not a page, or parameters the page does not take: the address is
  // replaced by the page's own (Back then skips the old one).
  useEffect(() => {
    if (hash !== shownAddress) goToAddress(shownAddress, { replace: true });
  }, [hash, shownAddress]);

  // The browser tab names the page (and becomes the file name when a page is saved).
  useEffect(() => {
    document.title = `${page.name} – IntelliSched`;
  }, [page.name]);

  // ---------------------------------------------------------------- menu state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openMenuButtonRef = useRef(null);
  // Closing the off-canvas menu from inside it gives the focus back to the button that opened it
  // (the closed menu is inert, so the focus would otherwise fall to the page).
  const closeSidebar = () => {
    setSidebarOpen(false);
    openMenuButtonRef.current?.focus();
  };
  // expanded | collapsing (the labels fade out, then the width shrinks) | collapsed | expanding (the width
  // grows, then the labels fade in). The labels stay in the page, on one line, clipped by the menu.
  const [menuPhase, setMenuPhase] = useState('expanded');
  const isCollapsed = menuPhase === 'collapsing' || menuPhase === 'collapsed';
  const menuWide = menuPhase !== 'collapsed';
  const labelsShown = menuPhase === 'expanded';
  const compactFooter = menuPhase === 'collapsed' || menuPhase === 'expanding';
  // The page's name beside an icon while the menu is collapsed (the labels are hidden then).
  const [navTip, setNavTip] = useState(null);
  const phaseTimer = useRef(null);
  const setCollapsed = (collapse) => {
    clearTimeout(phaseTimer.current);
    setNavTip(null);
    if (reducedMotion()) { setMenuPhase(collapse ? 'collapsed' : 'expanded'); return; }
    setMenuPhase(collapse ? 'collapsing' : 'expanding');
    phaseTimer.current = setTimeout(() => setMenuPhase(collapse ? 'collapsed' : 'expanded'), collapse ? LABEL_FADE_MS : MENU_WIDTH_MS);
  };
  useEffect(() => () => clearTimeout(phaseTimer.current), []);
  const tipHandlers = (text) => ({
    onMouseEnter: (e) => { if (!labelsShown) { const r = e.currentTarget.getBoundingClientRect(); setNavTip({ text, top: r.top + r.height / 2, left: r.right + 10 }); } },
    onMouseLeave: () => setNavTip(null),
    onFocus: (e) => { if (!labelsShown) { const r = e.currentTarget.getBoundingClientRect(); setNavTip({ text, top: r.top + r.height / 2, left: r.right + 10 }); } },
    onBlur: () => setNavTip(null)
  });
  const isWide = useSyncExternalStore(subscribeToWidth, isWideScreen, () => true);
  // A group the Dean opened or closed; one never touched is open while it holds the page shown.
  const [openSections, setOpenSections] = useState({});
  const isGroupOpen = (id) => openSections[id] ?? id === page.group;
  // When the page shown changes, however it changed (a link, the menu, Back or Forward, a typed or
  // pasted address, a redirect), its group opens, even one the Dean closed earlier, so the item marked
  // aria-current is never hidden in a closed (inert) group. The Dean can close it again. (Set while
  // rendering, like addressTerm above: no effect that sets state.)
  const [groupOpenedFor, setGroupOpenedFor] = useState(page.key);
  if (groupOpenedFor !== page.key) {
    setGroupOpenedFor(page.key);
    setOpenSections((prev) => (prev[page.group] === false ? { ...prev, [page.group]: true } : prev));
  }

  const toggleSection = (id) => {
    if (isCollapsed) {
      setCollapsed(false);
      setOpenSections((prev) => ({ ...prev, [id]: true }));
      return;
    }
    setOpenSections((prev) => ({ ...prev, [id]: !(prev[id] ?? id === page.group) }));
  };

  // ---------------------------------------------------------------- opening pages
  const [transition, setTransition] = useState(null);
  const transitionTimerRef = useRef(null);
  const focusHeadingRef = useRef(false);
  const contentScrollRef = useRef(null);
  useEffect(() => () => { if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current); }, []);

  // Opens an address; with `focus`, the keyboard focus then moves to the page's heading (at once when
  // the address is already open, otherwise once the new page has rendered).
  const openAddress = (address, { focus = false } = {}) => {
    if (window.location.hash === address) {
      if (focus) focusPageTitle(contentScrollRef.current);
      return;
    }
    if (focus) focusHeadingRef.current = true;
    goToAddress(address);
  };

  // From the menu: the page opens at once. On a narrow screen the menu then closes (and turns inert),
  // so the focus moves to the new page's heading.
  const openFromMenu = (key) => {
    const fromClosingMenu = !isWide && sidebarOpen;
    setSidebarOpen(false);
    openAddress(pageAddress(key), { focus: fromClosingMenu });
  };

  // From a link inside a page, the header search or a notification: names the page it opens
  // ("Switching to …"), then opens it and moves the focus to its heading. An old key opens the page
  // that replaced it. `params` are what the page should open, e.g. { scheduleId, view, entityKey } for
  // the Schedule Views & Editor or { tab } for Assign Faculty. (A label as the second argument, the
  // older way of calling it, is ignored.)
  const navigate = (targetKey, paramsOrLabel = null, legacyParams = null) => {
    const given = typeof paramsOrLabel === 'string' ? legacyParams : paramsOrLabel;
    const next = resolvePage(targetKey, given || {});
    const nextPage = pageOf(next.key);
    setOpenSections((prev) => ({ ...prev, [nextPage.group]: true }));
    setSidebarOpen(false);
    setTransition({ name: nextPage.name });
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    transitionTimerRef.current = setTimeout(() => {
      transitionTimerRef.current = null;
      setTransition(null);
      if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
      openAddress(pageAddress(next.key, next.params), { focus: true });
    }, SWITCH_DELAY_MS);
  };

  // A tab chosen on the page (Assign Faculty, Curriculum & Subjects) is kept in the address, in place of
  // the current entry.
  const keepTabInAddress = (tab) => goToAddress(pageAddress(page.key, { ...params, tab }), { replace: true });

  // A new page starts at the top.
  useEffect(() => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [page.key]);

  // A page opened from a link gets the keyboard focus on its heading (the link that opened it is gone).
  useEffect(() => {
    if (!focusHeadingRef.current) return undefined;
    focusHeadingRef.current = false;
    const frame = window.requestAnimationFrame(() => focusPageTitle(contentScrollRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [shownAddress]);

  // ---------------------------------------------------------------- header search
  const [headerSearch, setHeaderSearch] = useState('');
  const query = headerSearch.trim().toLowerCase();
  const searchMatches = query
    ? pagesFor(role).filter(p => [p.name, groupOf(p.group)?.title || '', ...(p.also || [])].some(text => text.toLowerCase().includes(query))).slice(0, 6)
    : [];
  const openSearchMatch = (key) => {
    setHeaderSearch('');
    navigate(key);
  };

  // ---------------------------------------------------------------- notifications
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  useEffect(() => {
    let active = true;
    loadNotifications({ academicYear: activeAcademicYear, semester: activeSemesterNumber, isAdmin })
      .then(list => { if (active) setNotifications(list); })
      .catch(() => { /* loadNotifications reports each failure as a notification */ });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber, isAdmin]);
  const toggleNotifications = async () => {
    const opening = !isNotifOpen;
    setIsNotifOpen(opening);
    if (opening) setNotifications(await loadNotifications({ academicYear: activeAcademicYear, semester: activeSemesterNumber, isAdmin }));
  };

  // ---------------------------------------------------------------- the page shown
  const pageProps = { currentUser, onNavigate: navigate };
  // What the Schedule Views & Editor page was asked to open: a new ask mounts it afresh.
  const viewsKey = `${termKey}|${params.scheduleId || ''}|${params.view || ''}|${params.entityKey || ''}|${params.fill || ''}`;
  const renderPage = () => {
    if (!allowed) return <NotAllowedPage pageKey={page.key} onNavigate={navigate} />;
    switch (page.key) {
      case 'checklist': return <TermChecklist key={termKey} {...pageProps} />;
      case 'subjects': return <SubjectManager {...pageProps} initialTab={params.tab || null} onTabChange={keepTabInAddress} />;
      case 'sections': return <SectionManager {...pageProps} />;
      case 'rooms': return <RoomManager {...pageProps} />;
      case 'faculty': return <FacultyManager {...pageProps} initialProfessor={params.professor || null} />;
      case 'policy': return <SchedulingPolicyManager {...pageProps} initialSection={params.section || null} />;
      case 'assign-faculty': return <AssignFacultyManager key={termKey} {...pageProps} initialTab={params.tab || null} onTabChange={keepTabInAddress} />;
      case 'readiness': return <FeasibilityValidator key={termKey} {...pageProps} />;
      case 'generate': return <GAGenerationManager key={termKey} {...pageProps} />;
      case 'schedule-views':
        return (
          <ScheduleViews
            key={viewsKey}
            {...pageProps}
            scheduleId={params.scheduleId || null}
            initialView={params.view || null}
            initialEntityKey={params.entityKey || null}
            initialFill={params.fill === '1'}
          />
        );
      case 'versions': return <VersionManager {...pageProps} />;
      case 'approval': return <ApprovalWorkflow {...pageProps} />;
      case 'print-outputs': return <PrintOutputs key={termKey} {...pageProps} />;
      case 'users-roles': return <UserManagement {...pageProps} />;
      case 'output-settings': return <OutputSettings {...pageProps} />;
      case 'reference-lists': return <ReferenceLists {...pageProps} />;
      case 'audit-logs': return <SystemAuditTrail key={params.entry || ''} entry={params.entry || ''} {...pageProps} />;
      case 'model-feedback': return <ModelFeedbackManager {...pageProps} />;
      case 'api-health': return <ServiceHealth {...pageProps} />;
      case 'system': return <SystemPage {...pageProps} />;
      // TEMP HIDDEN FOR DEFENSE: FacultyWorkloadAnalytics and RoomOccupancyAnalytics (re-enable with
      // their registry entries and imports).
      default: return null;
    }
  };

  const menu = menuFor(role);
  const PageIcon = page.icon;
  const iconButton = 'items-center justify-center p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

  return (
    <div className="flex h-screen w-full bg-slate-50 dark:bg-[#09090b] font-sans text-slate-600 dark:text-slate-300 selection:bg-blue-800/30 transition-colors duration-300 pt-[3px] overflow-hidden">

      {/* BRAND ACCENT STRIP */}
      <div className="fixed top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-blue-800 via-red-800 to-orange-500 z-50" />

      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      {/* SIDEBAR */}
      <aside
        inert={!isWide && !sidebarOpen}
        onKeyDown={(e) => { if (e.key === 'Escape' && sidebarOpen) closeSidebar(); }}
        data-testid="nav-sidebar"
        data-phase={menuPhase}
        className={`fixed md:static inset-y-0 left-0 h-full bg-white dark:bg-[#121212] shadow-2xl border-r border-slate-200 dark:border-slate-800/60 z-40 overflow-hidden shrink-0 transform transition-[width,translate] duration-[220ms] ease-out motion-reduce:transition-none
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
          ${menuWide ? 'w-72' : 'w-20'}`}
      >
       <div className="w-72 h-full flex flex-col">
        <div className="h-20 flex items-center justify-between pl-5 pr-6 border-b border-slate-200 dark:border-slate-800/60 shrink-0">
          <div className="flex items-center min-w-0">
            <div className="w-10 h-10 flex items-center justify-center shrink-0 bg-white rounded-full p-0.5 shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
              <img src="/ccs-logo.png" alt="CCS Logo" className="w-full h-full object-contain" />
            </div>
            {/* Never wraps (Phase 13): one line each, clipped by the menu while it narrows, faded by opacity. */}
            <div data-testid="nav-brand-labels" aria-hidden={!labelsShown} className={`ml-3 min-w-0 overflow-hidden whitespace-nowrap transition-opacity duration-100 ease-out motion-reduce:transition-none ${labelsShown ? 'opacity-100' : 'opacity-0'}`}>
              <h1 className="leading-tight whitespace-nowrap"><Wordmark size="compact" /></h1>
              <p data-testid="nav-console" title={role ? `${role} Console` : 'CCS Console'} className={`text-[10px] font-bold leading-snug text-red-800 dark:text-red-500 uppercase whitespace-nowrap truncate ${role && role.length > 10 ? 'tracking-wider' : 'tracking-widest'}`}>
                {role ? `${role} Console` : 'CCS Console'}
              </p>
            </div>
          </div>
          {!isCollapsed && (
            <button type="button" data-testid="nav-close" aria-label="Close the menu" className={`md:hidden flex ${iconButton}`} onClick={closeSidebar}>
              <X size={20} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* SIDEBAR NAVIGATION (the registry's groups, in the Dean's order) */}
        <nav aria-label="Pages" className="flex-1 px-3 py-6 flex flex-col justify-start gap-1 overflow-y-auto custom-scrollbar overflow-x-hidden">
          {menu.map((group) => {
            if (group.id === 'main') {
              return (
                <div key={group.id} className="mb-2">
                  {group.pages.map(({ key, name, icon: Icon }) => {
                    const isActive = page.key === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        data-testid={`nav-${key}`}
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={isCollapsed ? name : undefined}
                        onClick={() => openFromMenu(key)}
                        {...tipHandlers(name)}
                        className={`${menuWide ? 'w-full' : 'w-14'} flex items-center pl-[19px] pr-4 py-3 overflow-hidden rounded-xl transition-[width,background-color,border-color,color] duration-[220ms] ease-out motion-reduce:transition-none group text-sm font-semibold border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
                          ${isActive
                            ? 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20 shadow-sm'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50 border-transparent'}`}
                      >
                        <Icon className={`shrink-0 ${isActive ? 'text-blue-800 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-300'}`} size={18} aria-hidden="true" />
                        <span className={`ml-3 whitespace-nowrap overflow-hidden transition-opacity duration-100 ease-out motion-reduce:transition-none ${labelsShown ? 'opacity-100' : 'opacity-0'}`}>{name}</span>
                      </button>
                    );
                  })}
                </div>
              );
            }

            const expanded = isGroupOpen(group.id) && labelsShown;
            const GroupIcon = group.icon;
            const itemsId = `nav-group-${group.id}-items`;
            return (
              <div key={group.id} className="mb-2">
                <button
                  type="button"
                  data-testid={`nav-group-${group.id}`}
                  onClick={() => toggleSection(group.id)}
                  aria-expanded={expanded}
                  aria-controls={itemsId}
                  aria-label={isCollapsed ? group.title : undefined}
                  {...tipHandlers(group.title)}
                  className={`${menuWide ? 'w-full' : 'w-14'} flex items-center justify-between pl-[19px] pr-4 py-3 overflow-hidden text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/50 rounded-xl transition-[width,background-color] duration-[220ms] ease-out motion-reduce:transition-none border border-transparent cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
                >
                  <span className="flex items-center min-w-0">
                    <GroupIcon className="shrink-0 text-slate-500 dark:text-slate-400" size={18} aria-hidden="true" />
                    <span className={`ml-3 whitespace-nowrap overflow-hidden transition-opacity duration-100 ease-out motion-reduce:transition-none ${labelsShown ? 'opacity-100' : 'opacity-0'}`}>{group.title}</span>
                  </span>
                  <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-slate-500 dark:text-slate-400 transition-[transform,opacity] duration-200 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''} ${labelsShown ? 'opacity-100' : 'opacity-0'}`} />
                </button>

                {/* A closed group keeps its items in the page but inert: hidden, and never reached with Tab. */}
                <div id={itemsId} inert={!expanded} className={`grid transition-all duration-200 ease-in-out ${expanded ? 'grid-rows-[1fr] opacity-100 mt-1' : 'grid-rows-[0fr] opacity-0'}`}>
                  <div className="overflow-hidden">
                    <div className="space-y-1 py-1 border-l-2 border-slate-100 dark:border-slate-800/60 ml-6 pl-4">
                      {group.pages.map(({ key, name, icon: Icon }) => {
                        const isActive = page.key === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            data-testid={`nav-${key}`}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => openFromMenu(key)}
                            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all group border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
                              ${isActive
                                ? 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20 shadow-sm'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white border-transparent'}`}
                          >
                            <span className="flex items-center min-w-0">
                              <Icon className={`mr-3 shrink-0 transition-colors ${isActive ? 'text-blue-800 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-white'}`} size={16} aria-hidden="true" />
                              <span className="truncate whitespace-nowrap">{name}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#0f0f11] shrink-0 flex flex-col gap-3">
          {!compactFooter && currentUser?.name && (
            <div data-testid="nav-user" className={`px-1 min-w-0 whitespace-nowrap transition-opacity duration-100 ease-out motion-reduce:transition-none ${labelsShown ? 'opacity-100' : 'opacity-0'}`}>
              <p className="text-[11px] text-slate-600 dark:text-slate-400">Signed in as</p>
              <p className="text-sm font-bold text-slate-800 dark:text-white truncate" title={currentUser.name}>{currentUser.name}</p>
              {role && <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">{role}</p>}
            </div>
          )}
          <button type="button" onClick={onLogout} aria-label={compactFooter ? 'Sign Out' : undefined} {...tipHandlers('Sign Out')} className={`flex items-center justify-center whitespace-nowrap overflow-hidden ${compactFooter ? 'w-10 h-10 p-0 ml-1' : 'w-full px-4 py-3'} ${!compactFooter && !labelsShown ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100 motion-reduce:transition-none bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 dark:bg-red-500/5 dark:hover:bg-red-500/15 dark:text-red-400 dark:border-red-500/10 rounded-xl text-sm font-semibold transition-all group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500`}>
            <LogOut className={`${!compactFooter ? 'mr-2' : ''} group-hover:-translate-x-1 transition-transform`} size={16} aria-hidden="true" />
            {!compactFooter && <span>Sign Out</span>}
          </button>
        </div>
       </div>
      </aside>
      {navTip && createPortal(
        <div role="tooltip" data-testid="nav-tooltip" style={{ top: navTip.top, left: navTip.left }} className="fixed z-[1000] -translate-y-1/2 px-2.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white text-xs font-bold shadow-lg pointer-events-none whitespace-nowrap">
          {navTip.text}
        </div>,
        document.body
      )}

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col overflow-hidden relative min-w-0 bg-slate-50 dark:bg-[#09090b]">

        {/* HEADER */}
        <header className={`h-20 bg-white/90 dark:bg-[#121212]/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800/60 flex items-center justify-between ${PAGE_PADDING} sticky top-0 z-20 transition-colors duration-300`}>
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              data-testid="nav-collapse"
              onClick={() => setCollapsed(!isCollapsed)}
              aria-label={isCollapsed ? 'Expand the menu' : 'Collapse the menu'}
              aria-pressed={isCollapsed}
              className={`hidden md:flex ${iconButton}`}
            >
              <Menu size={20} aria-hidden="true" className={`transition-transform duration-300 ${isCollapsed ? 'rotate-90' : ''}`} />
            </button>
            <button ref={openMenuButtonRef} type="button" data-testid="nav-open" aria-label="Open the menu" aria-expanded={sidebarOpen} className={`md:hidden flex shrink-0 ${iconButton}`} onClick={() => setSidebarOpen(true)}>
              <Menu size={22} aria-hidden="true" />
            </button>
            <div className="flex items-center ml-2 border-l border-slate-200 dark:border-slate-700 pl-4 min-w-0">
              <div className="p-1.5 border border-orange-200 dark:border-orange-500/20 bg-orange-50 dark:bg-orange-500/10 rounded-md mr-3 shadow-sm shrink-0">
                <PageIcon className="text-orange-600 dark:text-orange-500" size={16} aria-hidden="true" />
              </div>
              <h2 data-testid="topbar-page-name" className="text-lg font-bold text-slate-800 dark:text-white truncate">
                {page.name}
              </h2>
            </div>
          </div>

          <div className="flex items-center space-x-3 md:space-x-4 2xl:space-x-6 shrink-0">
            <div className="relative hidden xl:block">
              <label htmlFor="page-search" className="sr-only">Search pages</label>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={16} aria-hidden="true" />
              <input
                id="page-search"
                data-testid="page-search"
                type="text"
                autoComplete="off"
                placeholder="Search pages..."
                value={headerSearch}
                aria-describedby="page-search-status"
                onChange={(e) => setHeaderSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setHeaderSearch('');
                  if (e.key === 'Enter' && searchMatches.length) openSearchMatch(searchMatches[0].key);
                }}
                className="bg-slate-100 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800 rounded-full py-1.5 pl-10 pr-4 text-sm focus:outline-none focus:border-blue-800/60 focus:ring-1 focus:ring-blue-800/30 text-slate-900 dark:text-white w-48 2xl:w-64 transition-all placeholder-slate-500 dark:placeholder-slate-400"
              />
              <span id="page-search-status" role="status" className="sr-only">
                {query ? (searchMatches.length ? `${searchMatches.length} ${searchMatches.length === 1 ? 'page matches' : 'pages match'}. Press Enter to open ${searchMatches[0].name}, or Tab to the list.` : 'No page matches.') : ''}
              </span>
              {query && (
                <div id="page-search-results" data-testid="page-search-results" className="absolute top-11 right-0 w-72 bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-2 z-50">
                  {searchMatches.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">No page matches &ldquo;{headerSearch.trim()}&rdquo;.</p>
                  ) : searchMatches.map(match => (
                    <button
                      key={match.key}
                      type="button"
                      data-testid={`page-search-${match.key}`}
                      onClick={() => openSearchMatch(match.key)}
                      className="w-full text-left px-3 py-1.5 rounded-lg flex items-center justify-between hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-bold text-slate-800 dark:text-slate-200 truncate">{match.name}</span>
                        <span className="block text-[11px] text-slate-600 dark:text-slate-400 truncate">{groupOf(match.group)?.title}</span>
                      </span>
                      <ArrowRight size={12} className="text-slate-500 shrink-0 ml-2" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <TermSelector className="hidden lg:flex" />

            <ThemeToggle />

            {/* NOTIFICATIONS */}
            <div className="relative">
              <button
                type="button"
                data-testid="notif-toggle"
                onClick={toggleNotifications}
                aria-label={notifications.length ? `Notifications (${notifications.length})` : 'Notifications'}
                aria-expanded={isNotifOpen}
                aria-controls={isNotifOpen ? 'notif-panel' : undefined}
                className="relative p-2 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <Bell size={20} aria-hidden="true" />
                {notifications.length > 0 && (
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-600 rounded-full border-2 border-white dark:border-[#121212]" aria-hidden="true" />
                )}
              </button>

              {isNotifOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsNotifOpen(false)} aria-hidden="true"></div>
                  <div id="notif-panel" data-testid="notif-panel" className="absolute right-0 mt-2 w-80 bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-50 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#1a1a1c] flex items-center justify-between">
                      <h3 className="font-bold text-slate-800 dark:text-white text-sm">Notifications</h3>
                      <button type="button" aria-label="Close the notifications" onClick={() => setIsNotifOpen(false)} className="p-1 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="max-h-64 overflow-y-auto custom-scrollbar divide-y divide-slate-100 dark:divide-slate-800/50">
                      {notifications.length === 0 ? (
                        <p className="p-4 text-center text-xs text-slate-600 dark:text-slate-400">No notifications for this term.</p>
                      ) : (
                        notifications.map(notif => {
                          const body = (
                            <>
                              <p className="text-xs font-bold text-slate-800 dark:text-white mb-0.5">{notif.title}</p>
                              <p className="text-xs text-slate-600 dark:text-slate-400 leading-snug">{notif.detail}</p>
                            </>
                          );
                          return notif.target ? (
                            <button
                              key={notif.id}
                              type="button"
                              data-testid={`notif-${notif.id}`}
                              onClick={() => { setIsNotifOpen(false); navigate(notif.target, notif.params || null); }}
                              className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-white/5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                            >
                              {body}
                            </button>
                          ) : (
                            <div key={notif.id} data-testid={`notif-${notif.id}`} className="px-4 py-3">{body}</div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* THE SIGNED-IN USER (opens Users & Roles) */}
            <button
              type="button"
              data-testid="topbar-user"
              onClick={() => openFromMenu('users-roles')}
              aria-label={currentUser?.name ? `${currentUser.name}${role ? ` (${role})` : ''}: open ${pageOf('users-roles').name}` : `Open ${pageOf('users-roles').name}`}
              title={currentUser?.name ? `${currentUser.name}${role ? ` (${role})` : ''}` : undefined}
              className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-700 to-indigo-500 border border-white/20 flex items-center justify-center text-white font-black text-xs shadow-md cursor-pointer hover:scale-105 transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <span aria-hidden="true">{currentUser?.name?.charAt(0) || '?'}</span>
            </button>
          </div>
        </header>

        {/* Below lg the term selector gets its own row under the header, so the header controls
            (menu button, theme, notifications, avatar) never overflow on tablets and phones. */}
        <div className={`lg:hidden sticky top-20 z-10 ${PAGE_PADDING} py-2 bg-white/90 dark:bg-[#121212]/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800/60 flex justify-end`}>
          <TermSelector />
        </div>

        {/* CONTENT CONTAINER */}
        <div ref={contentScrollRef} className={`${PAGE_PADDING} py-6 md:py-8 overflow-y-auto h-full relative custom-scrollbar`}>

          {transition && (
            <div data-testid="nav-switching" role="status" className="absolute inset-0 bg-slate-50/75 dark:bg-[#09090b]/80 backdrop-blur-[2px] z-30 flex items-center justify-center animate-in fade-in duration-200">
              <div className="flex items-center gap-3 px-6 py-3.5 rounded-2xl bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800 shadow-2xl animate-in zoom-in-95 duration-200">
                <Loader2 className="animate-spin text-blue-800 dark:text-blue-400" size={20} aria-hidden="true" />
                <span className="text-sm font-bold text-slate-800 dark:text-white tracking-wide">
                  Switching to {transition.name}…
                </span>
              </div>
            </div>
          )}

          {renderPage()}
        </div>
      </main>
    </div>
  );
}
