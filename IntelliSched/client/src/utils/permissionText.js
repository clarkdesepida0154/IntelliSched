import { ROLES, can } from './permissions';
import { PAGES, SYSTEM_TEAM_ACTION, canSeePage } from '../navigation/pages';

// Words built from the permission map (utils/permissions.js) for the pages that say who may do
// something or what a role may do (Phase 3 Step 6), so no page keeps a list of roles of its own.

// The account roles that may do an action, in the order of ROLES (a name the map lists that is not an
// account role, the Registrar, never matches; an unknown action has none).
export const rolesAllowed = (action) => ROLES.filter(role => can(role, action));

// "a", "a or b", "a, b or c" (or "and").
const listOf = (items, last = 'or') => (items.length <= 1 ? items[0] || '' : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`);
const sentenceStart = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// "the Dean" (Phase 8 Part 8: every action is the Dean's), or "the Dean or the ..." for a map with more
export const whoMay = (action) => listOf(rolesAllowed(action).map(role => `the ${role}`)) || 'nobody';

// Who signs an approval stage (the Approval page), from the map, as the start of a sentence. With
// today's map (Phase 8 Part 8: one account) both stages read "The Dean".
export const whoSigns = (action) => sentenceStart(listOf(rolesAllowed(action).map(role => `the ${role}`)) || 'nobody');

// Phase 11.4: one line per role for the add-account form.
export const ROLE_SUMMARY = {
  Dean: 'Holds every permission, including Users & Roles and System.',
  'College Secretary': "Prepares and approves schedules. Can't manage accounts or System.",
  Faculty: 'Views and prints. Changes nothing.'
};

// What each action lets a role do, in the order the Users & Roles page lists them. The roster refresh
// (roster.sync) is not listed: the Faculty page asks for it after every save, for the same roles.
const ACTION_WORDS = [
  ['data.edit', 'change subjects, the curriculum, sections, rooms and faculty'],
  ['settings.edit', "change the Scheduling Policy's plain settings, the Output Settings and the Reference Lists"],
  ['advanced.edit', 'change the Advanced (system team) settings'],
  ['faculty.assign', 'assign faculty and release assignments'],
  ['ga.run', 'generate the Mother Schedule and cancel a run'],
  ['schedule.move', 'move classes in a Draft'],
  ['version.restore', 'restore a version'],
  ['approval.chairReview', 'send a version for review'],
  ['approval.deanSignOff', 'approve a version'],
  ['users.manage', 'manage user accounts'],
  ['model.retrain', 'retrain the recommendation model']
];

// "Accounts with this role can view every page except Model Feedback and Service Health, which are only
// for the Dean, and can print the outputs and download CSV files. A Dean can also: change subjects, ...;
// generate the Mother Schedule and cancel a run; move classes in a Draft." The pages
// a role can't open are the page registry's (navigation/pages.js: the system team's pages).
export const roleAbilitiesText = (role) => {
  // The closed pages grouped by who may open them (Phase 11.4: Users & Roles and System are the
  // Dean's alone; Model Feedback and Service Health the system team's).
  const groups = new Map();
  for (const page of PAGES.filter(p => !canSeePage(p, role))) {
    const action = page.permission || SYSTEM_TEAM_ACTION;
    const who = whoMay(action);
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(page.name);
  }
  const closedText = [...groups.entries()].map(([who, names]) => `${listOf(names, 'and')} (only for ${who})`);
  const subject = role ? 'Accounts with this role' : 'Every account';
  const view = closedText.length
    ? `${subject} can view every page except ${closedText.join('; ')}, and can print the outputs and download CSV files.`
    : `${subject} can view every page, print the outputs and download CSV files.`;
  if (!role) return view;
  const more = ACTION_WORDS.filter(([action]) => can(role, action)).map(([, words]) => words);
  const article = /^[AEIOU]/i.test(role) ? 'An' : 'A';
  return more.length
    ? `${view} ${article} ${role} can also: ${more.join('; ')}.`
    : `${view} ${article} ${role} account cannot change anything.`;
};
