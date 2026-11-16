// A schedule version as the Versions and Approval pages word it (Phase 3 Step 5). The facts come from
// GET /schedule/versions: the real status (Draft, Under Review, Approved, Archived; Phase 8 Part 6: there
// is no Publish, and a version stored as Published reads as Approved — the gateway sends it so too),
// currentDraft (the term's current Draft: the one new assignments go to and a restore replaces),
// restoredFrom, lastCheck (the version's last whole-version check, stored by "Check the whole schedule"
// and by every approval stage) and totalScheduled (its classes). Nothing is counted here.
import { conflictsText } from './gaRun.js';

export const VERSION_STATUSES = ['Draft', 'Under Review', 'Approved', 'Archived'];

// The real status (older gateways sent a label in `status` and the status in `workflowStatus`); one
// stored as Published reads as Approved.
export const statusOf = (v) => {
  const status = v?.workflowStatus || v?.status || '';
  return status === 'Published' ? 'Approved' : status;
};

// Badge colours of the existing theme (full class names, so Tailwind keeps them).
export const STATUS_BADGE = {
  Draft: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  'Under Review': 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
  Approved: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-500/10 dark:text-green-300 dark:border-green-500/20',
  Archived: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
};
export const statusBadgeClass = (status) => STATUS_BADGE[status] || STATUS_BADGE.Archived;

// A version with classes, saved in the current format (legacy versions are read-only; a lock-only
// Draft holds assignments only).
export const hasClasses = (v) => Boolean(v) && !v.legacy && Number(v.totalScheduled) > 0;

// The approved version of the term (the official one, final; a legacy one is never changed).
export const isOfficial = (v) => Boolean(v) && !v.legacy && statusOf(v) === 'Approved';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "30 Sep 2026 10:42 PM" ('' for no date). Built by hand: the browsers' month names and the space
// before AM/PM differ between versions.
export const dateTimeText = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${time}`;
};

// The version's last check as { checkedAt, hardTotal }, or null when it was never checked (or the
// check did not record its count).
export const checkOf = (v) => (v?.lastCheck?.checkedAt && Number.isFinite(v.lastCheck.hardTotal)
  ? { checkedAt: v.lastCheck.checkedAt, hardTotal: v.lastCheck.hardTotal }
  : null);

// "0 conflicts, checked 30 Sep 2026 10:42 PM", or "Not checked yet".
export const checkText = (check) => (check
  ? `${conflictsText(check.hardTotal)}, checked ${dateTimeText(check.checkedAt)}`
  : 'Not checked yet');

// "v2", "v1 and v2", "v1, v2 and v3"
export const namesText = (list) => {
  const names = list.map(v => v.id);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
};

// Why a version can't be restored ('' when it can). The gateway refuses the same versions.
export const restoreBlockedReason = (v) => {
  if (v.legacy) return 'Saved in the older format (before Phase 1): it can only be read.';
  if (!(Number(v.totalScheduled) > 0)) return 'It holds assignments only (no classes): there is nothing to restore.';
  if (v.currentDraft) return 'It is the current Draft: open it in the Schedule Views & Editor to change it.';
  return '';
};
