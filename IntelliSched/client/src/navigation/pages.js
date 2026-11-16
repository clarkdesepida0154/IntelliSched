import {
  LayoutDashboard, ListChecks, Database, BookOpen, Layers, Map, Users, Settings2, UserCheck,
  ShieldCheck, Play, CalendarRange, CalendarDays, GitBranch, BadgeCheck, CheckSquare, Printer,
  UserCog, FileCog, Tags, ScrollText, RefreshCw, ServerCog, HardDrive
} from 'lucide-react';
import { can } from '../utils/permissions';

// The one page registry (Phase 3 Step 4). A page's `name` is used everywhere the page is named: the
// menu, the top bar, the page's own heading (PageHeader), the header search, the "Switching to"
// overlay and the browser tab (document.title). `purpose` is the page's one-line purpose under its
// heading. `tone` is the colour of the heading's icon (the page's accent in the existing theme).
// The order below is the Dean's order: set up data, assign faculty, check and generate, review and
// fix, approve and print; the Administration pages come last.

// The pages marked adminOnly are the technical pages (nothing technical unless someone opens it on
// purpose). Only a role that may open "Advanced (system team)" sees them: the permission
// map's advanced.edit (Phase 3 Step 6; utils/permissions.js). Every other page is open to every role.
// The Reference Lists page (Step 8) is a page for everyone to view; its edits are the map's settings.edit.
export const SYSTEM_TEAM_ACTION = 'advanced.edit';

// Menu groups, in order. `main` holds the Main page alone (shown as a single menu item).
export const PAGE_GROUPS = [
  { id: 'main', title: 'Main', icon: LayoutDashboard },
  { id: 'setup', title: 'Set up data', icon: Database },
  { id: 'assign', title: 'Assign faculty', icon: UserCheck },
  { id: 'check', title: 'Check & generate', icon: ShieldCheck },
  { id: 'review', title: 'Review & fix', icon: CalendarRange },
  { id: 'approve', title: 'Approve & print', icon: BadgeCheck },
  { id: 'admin', title: 'Administration', icon: UserCog }
];

// `params`: the address parameters the page takes (#/<key>?<param>=…); any other parameter is
// dropped from the address. `termParams`: those parameters name records of the term they were given
// in, so a term switch opens the page plainly. `also`: older names the header search still finds.
export const PAGES = [
  {
    key: 'checklist', name: 'Term Checklist', group: 'main', icon: ListChecks, tone: 'blue',
    purpose: 'Where this term stands, and what to do next.',
    also: ['Main', 'Home', 'Overview', 'Dashboard']
  },
  {
    // `tab`: catalog | builder (Phase 3 Step 7: the Readiness Check's online option opens the Master Catalog).
    key: 'subjects', name: 'Curriculum & Subjects', group: 'setup', icon: BookOpen, tone: 'yellow', params: ['tab'],
    purpose: 'Subjects, and where each sits in the curriculum.',
    also: ['Master Catalog', 'Curriculum Builder']
  },
  {
    key: 'sections', name: 'Sections', group: 'setup', icon: Layers, tone: 'blue',
    purpose: 'The sections that get a Mother Schedule.',
    also: ['Sections & Tracks', 'Blocks']
  },
  {
    key: 'rooms', name: 'Rooms', group: 'setup', icon: Map, tone: 'emerald',
    purpose: 'The rooms classes may use.',
    also: ['Room & Facility Inventory', 'Laboratories', 'Facilities']
  },
  {
    key: 'faculty', name: 'Faculty', group: 'setup', icon: Users, tone: 'blue',
    purpose: "Professors, their loads and unavailable times.",
    also: ['Faculty Directory', 'Professors'],
    // Phase 4 Part 2 Step 3: the Readiness Check's "Fix this" opens one professor (`professor`: the faculty code).
    params: ['professor']
  },
  {
    key: 'policy', name: 'Scheduling Policy', group: 'setup', icon: Settings2, tone: 'purple', params: ['section'],
    purpose: 'The days, hours and rules every schedule follows.',
    also: ['Constraint Configuration', 'Rules', 'Lunch', 'Saturday']
  },
  {
    key: 'assign-faculty', name: 'Assign Faculty', group: 'assign', icon: UserCheck, tone: 'cyan', params: ['tab'],
    purpose: 'Choose the professor for every class.',
    also: ['Course Assignment Matrix', 'Candidate Ranking', 'Recommendations', 'By class']
  },
  {
    key: 'readiness', name: 'Readiness Check', group: 'check', icon: ShieldCheck, tone: 'red',
    purpose: "Whether a conflict-free schedule is possible, and what to fix.",
    also: ['Pre-flight Check', 'Feasibility']
  },
  {
    key: 'generate', name: 'Generate Schedule', group: 'check', icon: Play, tone: 'indigo',
    purpose: "Build every section's Mother Schedule as a Draft.",
    also: ['GA Generation Control', 'Generate Mother Schedule']
  },
  {
    // `fill` ('1'): opens the Room Program with "Fill TBA rooms" open (Phase 4 Part 1, Step 1: the link
    // on the Generate Schedule result).
    key: 'schedule-views', name: 'Schedule Views & Editor', group: 'review', icon: CalendarDays, tone: 'violet',
    params: ['scheduleId', 'view', 'entityKey', 'fill'], termParams: true,
    purpose: "Mother Schedules, Teachers' Programs and Room Programs.",
    also: ['Mother Schedule', "Teachers' Program", 'Room Program', 'Timetable Editor', 'TBA rooms to request']
  },
  {
    key: 'versions', name: 'Versions', group: 'review', icon: GitBranch, tone: 'violet',
    purpose: "Every saved version of this term's schedule.",
    also: ['Version Management', 'History']
  },
  {
    key: 'approval', name: 'Approval', group: 'approve', icon: CheckSquare, tone: 'violet',
    purpose: "Send for review, then approve.",
    also: ['Formal Approval Workflow', 'Publish', 'Sign-off']
  },
  {
    key: 'print-outputs', name: 'Print Outputs', group: 'approve', icon: Printer, tone: 'orange',
    purpose: "Print or export the schedules.",
    also: ['Form Exporters', 'SF-029', 'PDF', 'CSV']
  },
  {
    // Phase 11.4: the Dean's alone (users.manage), seeing it included.
    key: 'users-roles', name: 'Users & Roles', group: 'admin', icon: UserCog, tone: 'blue', permission: 'users.manage',
    purpose: 'Who can sign in, and their roles.',
    also: ['User Management', 'Accounts']
  },
  {
    key: 'output-settings', name: 'Output Settings', group: 'admin', icon: FileCog, tone: 'purple',
    purpose: "Titles, signatories and print choices.",
    also: ['Signatories', 'Form codes']
  },
  {
    // Step 8: open to every role to view; changing a list is the permission map's settings.edit.
    key: 'reference-lists', name: 'Reference Lists', group: 'admin', icon: Tags, tone: 'purple',
    purpose: "Specializations and position titles.",
    also: ['Specialization domains', 'Position titles', 'Specializations']
  },
  {
    key: 'audit-logs', name: 'Audit Trail', group: 'admin', icon: ScrollText, tone: 'slate', params: ['entry'],
    purpose: 'Who did what, and when.',
    also: ['System Audit Trail', 'Log']
  },
  {
    key: 'model-feedback', name: 'Model Feedback', group: 'admin', icon: RefreshCw, tone: 'cyan', adminOnly: true,
    purpose: "The Dean's decisions that teach the ranking.",
    also: ['Active Learning']
  },
  {
    key: 'api-health', name: 'Service Health', group: 'admin', icon: ServerCog, tone: 'emerald', adminOnly: true,
    purpose: 'Whether the services answer, and how fast.',
    also: ['Engine API', 'System Health']
  },
  {
    // Phase 11.3: the Dean's alone (the permission map's system.manage), seeing it included.
    key: 'system', name: 'System', group: 'admin', icon: HardDrive, tone: 'blue', permission: 'system.manage',
    purpose: 'Version, backups and the backup password.',
    also: ['Backup', 'Restore', 'About', 'Backup password']
  }
];

export const HOME_PAGE_KEY = 'checklist';

const PAGE_BY_KEY = Object.fromEntries(PAGES.map(page => [page.key, page]));

// The registry entry of a page key (undefined for a key that is not a page).
export const pageOf = (key) => PAGE_BY_KEY[key];

// The group entry of a group id.
export const groupOf = (id) => PAGE_GROUPS.find(group => group.id === id);

// Old page keys (the Phase 1-2 menu, and the Step 1 and 3 renames) and the page each one opens now.
// A redirect replaces the address, so the browser's Back button skips it.
export const PAGE_REDIRECTS = {
  overview: { key: 'checklist' },
  'course-matrix': { key: 'assign-faculty', params: { tab: 'by-class' } },
  'candidate-ranking': { key: 'assign-faculty', params: { tab: 'recommendations' } },
  feasibility: { key: 'readiness' },
  'ga-control': { key: 'generate' },
  constraints: { key: 'policy', params: { section: 'rules' } },
  'timetable-editor': { key: 'schedule-views' },
  'matrix-views': { key: 'schedule-views' },
  'form-exporters': { key: 'print-outputs' }
};

// Whether a user with this role sees the page (in the menu and the header search) and may open it.
export const canSeePage = (page, role) => Boolean(page) && (!page.adminOnly || can(role, SYSTEM_TEAM_ACTION)) && (!page.permission || can(role, page.permission));

// The pages a role sees, in the Dean's order.
export const pagesFor = (role) => PAGES.filter(page => canSeePage(page, role));

// The menu for a role: every group with the pages it sees (a group left empty is not shown).
export const menuFor = (role) => PAGE_GROUPS
  .map(group => ({ ...group, pages: PAGES.filter(page => page.group === group.id && canSeePage(page, role)) }))
  .filter(group => group.pages.length > 0);

// Keeps only the parameters the page takes, as strings, without empty values.
const allowedParams = (page, params) => Object.fromEntries(
  Object.entries(params || {})
    .filter(([name, value]) => (page.params || []).includes(name) && value !== undefined && value !== null && String(value) !== '')
    .map(([name, value]) => [name, String(value)])
);

// The page a key and its parameters open: an old key opens the page that replaced it (its own
// parameters first, the redirect's on top, e.g. the tab), and a key that is not a page opens the
// Term Checklist. Returns { key, params, redirected }.
export const resolvePage = (key, params = {}) => {
  const redirect = PAGE_REDIRECTS[key];
  const targetKey = redirect ? redirect.key : key;
  const page = pageOf(targetKey);
  if (!page) return { key: HOME_PAGE_KEY, params: {}, redirected: true };
  return { key: page.key, params: allowedParams(page, { ...params, ...(redirect?.params || {}) }), redirected: Boolean(redirect) };
};

// "#/<key>?<params>", with the parameters in a fixed (alphabetical) order so one page and its
// parameters always have one address.
export const pageAddress = (key, params = {}) => {
  const entries = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(entries.map(([name, value]) => [name, String(value)])).toString();
  return `#/${key}${query ? `?${query}` : ''}`;
};

// { key, params } of an address's hash ("#/assign-faculty?tab=recommendations"). An empty hash is
// the Main page; anything that is not "#/<key>" gives key '' (which opens the Term Checklist).
export const parseAddress = (hash) => {
  const text = String(hash || '');
  if (text === '' || text === '#' || text === '#/') return { key: HOME_PAGE_KEY, params: {} };
  const match = /^#\/([^?]*)(?:\?(.*))?$/.exec(text);
  if (!match) return { key: '', params: {} };
  let key = match[1];
  try { key = decodeURIComponent(key); } catch { /* keep the raw key */ }
  const params = {};
  for (const [name, value] of new URLSearchParams(match[2] || '')) params[name] = value;
  return { key, params };
};

// Two parameter sets name the same thing (same names and values, in any order).
export const sameParams = (a = {}, b = {}) => {
  const left = Object.keys(a || {}).sort();
  const right = Object.keys(b || {}).sort();
  return left.length === right.length && left.every((name, i) => name === right[i] && String(a[name]) === String(b[name]));
};
