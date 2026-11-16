// The one permission map (Phase 3 Step 6; reshaped by Phase 8 Part 6 for the office's two users, and by
// Part 8 for its one account, the Dean's): who may do what. Every signed-in role may view every page, print every output and download every CSV, so
// reading is not an action here. The gateway checks the map on every write route: the route files name
// the action (middleware/roles.js requirePermission), and the handlers whose action depends on the
// request ask can() themselves (a class move or a faculty decision on /schedule/override, the approval
// stage, the Advanced policy settings, the GA settings sent with a run).
//
// Two actions are not in the table (decided in Step 6):
//   roster.sync    refreshing Engine 1's faculty list; the faculty page calls it after every save, so
//                  it goes with data.edit's roles;
//   model.retrain  retraining Engine 4 from the Model Feedback page (with advanced.edit's roles since
//                  Phase 8 Part 6).
//
// client/src/utils/permissions.js is an identical mirror: the code between the SHARED markers must be
// byte-for-byte the same in both files (server/tests/unit/permissions.test.js checks it and asks both
// the same questions).

// ---- BEGIN SHARED ----
// The roles an account may have (the User model's enum). Phase 8 Part 8 made the Dean's the one working
// account; Phase 11.4 brought the College Secretary back (the Part 6 name and stored key): the
// Secretary may do everything the Dean does on schedules, approving included (the Audit Trail names who
// approved), but never Administration -> System (a restore replaces the Audit Trail, so an account that
// could restore could erase the record of its own approval) and never Users & Roles (so it cannot make
// a Dean account). The System Admin and the Department Chair stay retired (Part 6): an account kept
// with a retired role can view but change nothing. Faculty stays a view-only role.
const ROLES = ['Dean', 'College Secretary', 'Faculty'];

const DEAN_AND_SECRETARY = ['Dean', 'College Secretary'];

// Each action: the roles that may do it, and the one plain reason shown to a role that may not.
// Approval stays two steps: send the version for review (approval.chairReview: the conflicts and the
// corrections checked), then approve it (approval.deanSignOff).
const PERMISSIONS = {
  // Subjects (Master Catalog), the curriculum, sections, rooms and faculty profiles.
  'data.edit': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can change subjects, the curriculum, sections, rooms and faculty.'
  },
  // The Scheduling Policy's plain settings, the Output Settings and the Reference Lists.
  'settings.edit': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can change these settings.'
  },
  // "Advanced (system team)": the GA settings, the TBA room mode and counts, the penalty weights and
  // the other technical policy settings.
  'advanced.edit': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can change the Advanced (system team) settings.'
  },
  // Locks from Assign Faculty (Majors), manual Minors, practicum coordinators, and releasing them.
  'faculty.assign': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can assign faculty or release an assignment.'
  },
  // Starting or cancelling a GA run.
  'ga.run': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can generate the Mother Schedule or cancel a run.'
  },
  'schedule.move': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can move classes in a Draft.'
  },
  // Restoring a schedule version (the version history), not System's Backup & Restore.
  'version.restore': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can restore a version.'
  },
  // Approval stage 2 (Draft -> Under Review): sending the Mother Schedule for review.
  'approval.chairReview': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can send a version for review.'
  },
  // Approval stage 3 (Under Review -> Approved). Phase 11.4: the College Secretary may approve too;
  // the Audit Trail and the version history name the account and its role.
  'approval.deanSignOff': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can approve a version.'
  },
  // Users & Roles: the Dean's alone (the Secretary cannot make a Dean account).
  'users.manage': {
    roles: ['Dean'],
    reason: 'Only the Dean can manage user accounts.'
  },
  'roster.sync': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can refresh the faculty list the recommendations use.'
  },
  'model.retrain': {
    roles: DEAN_AND_SECRETARY,
    reason: 'Only the Dean or the College Secretary can retrain the recommendation model.'
  },
  // Phase 11.3: Administration -> System (About, Backup & Restore, the backup settings and password).
  // Reading it is guarded too: the page and every route are the Dean's alone.
  'system.manage': {
    roles: ['Dean'],
    reason: 'Only the Dean can open System: backups, restore and the backup password.'
  }
};

const ruleOf = (action) => (Object.prototype.hasOwnProperty.call(PERMISSIONS, action) ? PERMISSIONS[action] : null);

// Whether an account with this role may do this action (false for an unknown role or action, so an
// account kept with a retired role, such as the System Admin since Part 6, can view but change
// nothing).
const can = (role, action) => ROLES.includes(role) && Boolean(ruleOf(action)?.roles.includes(role));

// Why a role that may not do this action is refused, in plain words.
const reasonFor = (action) => ruleOf(action)?.reason || 'Your role cannot do this.';
// ---- END SHARED ----

module.exports = { ROLES, PERMISSIONS, can, reasonFor };
