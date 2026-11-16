// Formatting, badge and dialog-focus helpers shared by the Master Catalog and Curriculum Builder
// tabs. Times come from the Scheduling Policy (see utils/timeGrid.js).
import { resolveSubjectType } from '../../../utils/subjectType';
import { formatRange12 } from '../../../utils/timeGrid';

// Minor and NSTP subjects are lecture-only: the Lab input is hidden and 0 lab hours are saved.
export const LECTURE_ONLY_TYPES = ['Minor', 'NSTP'];

// Renders halves without trailing zeros: 3 -> "3", 1.5 -> "1.5".
export const formatHours = (hours) => {
  const numeric = Number(hours);
  if (!Number.isFinite(numeric)) return '0';
  return String(numeric);
};

// Hour inputs are locked to half-hour steps: the GA converts hours to 30-minute slots
// (durationSlots = hours * 2), so anything finer produces a fractional slot count.
export const isHalfStep = (value) =>
  Number.isFinite(value) && value >= 0 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;

// Weekly contact hours of a catalog subject (lecture + laboratory).
export const contactHoursOf = (subject) => (Number(subject?.lecHours) || 0) + (Number(subject?.labHours) || 0);

// Storage can be unavailable (private mode, quota, blocked cookies); every access is guarded so
// the page still works in memory.
export const readStorage = (key) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const writeStorage = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory value still applies.
  }
};

// ---------------------------------------------------------------------------------------------
// Dialog focus
// ---------------------------------------------------------------------------------------------
const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';

// onKeyDown for a modal dialog: Tab and Shift+Tab wrap inside it, so the page behind cannot be
// reached. :disabled (not [disabled]) also skips the controls of a disabled <fieldset>.
export const trapTabKey = (event) => {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  const focusables = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter(el => el.tabIndex >= 0 && !el.matches(':disabled'));
  if (!focusables.length) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
};

// Moves focus to the first candidate that is still on the page and enabled: a dialog's opener,
// then its fallbacks. A control removed by the last render or disabled meanwhile is skipped.
export const focusFirstAvailable = (...candidates) => {
  for (const el of candidates) {
    if (!el?.isConnected || el.disabled) continue;
    el.focus();
    if (document.activeElement === el) return;
  }
};

// ---------------------------------------------------------------------------------------------
// NSTP block (Scheduling Policy)
// ---------------------------------------------------------------------------------------------
// "Saturday 8:00 AM–12:00 PM", the policy's NSTP block. NSTP timing is not set per subject.
export const nstpBlockLabel = (policy) =>
  (policy?.nstp ? `${policy.nstp.day} ${formatRange12(policy.nstp.start, policy.nstp.end)}` : null);

// ---------------------------------------------------------------------------------------------
// Lecture mode (Phase 3 Step 7)
// ---------------------------------------------------------------------------------------------
// How a Major's lectures are held (SubjectCatalog.lectureMode), in the Dean's words: `label` in the
// form's select, `short` on the routing badge. Only a Major that is not a practicum can hold its
// lectures online; any other subject, and a record without the field, reads as On campus (the
// gateway's lectureModeOf, server/src/utils/meetings.js). Labs always stay on campus.
export const LECTURE_MODE_OPTIONS = [
  { value: 'ON_CAMPUS', label: 'On campus', short: 'On campus' },
  { value: 'ONLINE_SCHEDULED', label: 'Online, scheduled (a day and time, no room)', short: 'Online, scheduled' },
  { value: 'ONLINE_SELF_PACED', label: 'Online, self-paced (no day, time or room)', short: 'Online, self-paced' }
];
export const LECTURE_MODE_VALUES = LECTURE_MODE_OPTIONS.map(option => option.value);
export const LECTURE_MODE_HINT = "Labs always stay on campus. Whether to hold lectures online is the Dean's decision (CHED CMO No. 4, s. 2020 allows flexible learning).";

export const canHoldLecturesOnline = (subject) => resolveSubjectType(subject) === 'Major' && !subject?.isPracticum;
export const lectureModeOf = (subject) => (canHoldLecturesOnline(subject) && LECTURE_MODE_VALUES.includes(subject?.lectureMode)
  ? subject.lectureMode
  : 'ON_CAMPUS');

// ---------------------------------------------------------------------------------------------
// Badges (full class strings so Tailwind sees them at build time)
// ---------------------------------------------------------------------------------------------
const TYPE_BADGE_CLASSES = {
  Major: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  Minor: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30',
  NSTP: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/30'
};

export const typeBadgeClass = (subject) => TYPE_BADGE_CLASSES[resolveSubjectType(subject)];

// Only a Minor row carries the 4px purple strip on its leading edge. It is an inset shadow on the
// first data cell (not border-l-4 on the <tr>): the collapsed border model clips half of an outer
// border, and a row decoration would be painted beneath disabledCellClass's opaque cell background.
export const minorStripClass = (subject) =>
  (resolveSubjectType(subject) === 'Minor' ? 'shadow-[inset_4px_0_0_0_#a855f7]' : '');

// A Major's badge names its lecture mode (Phase 3 Step 7); a record without one reads as On campus.
const ONLINE_BADGE = 'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/10 dark:text-cyan-300 border-cyan-200 dark:border-cyan-500/20';
const MAJOR_ROUTING = {
  ON_CAMPUS: {
    title: 'Lecture mode: On campus. Major subjects are scheduled in a physical room.',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400 border-blue-200 dark:border-blue-500/20'
  },
  ONLINE_SCHEDULED: {
    title: 'Lecture mode: Online, scheduled. The lectures get a day and a time but no room; the labs stay on campus.',
    className: ONLINE_BADGE
  },
  ONLINE_SELF_PACED: {
    title: "Lecture mode: Online, self-paced. The lectures get no day, time or room (they still count in the professor's load); the labs stay on campus.",
    className: ONLINE_BADGE
  }
};

// How the GA routes the subject, derived from its type exactly as the gateway stores it:
// Major -> its lecture mode (a practicum: not scheduled); Minor -> room or TBA per requiresRoom;
// NSTP -> TBA in the policy block.
export const routingOf = (subject, policy) => {
  const type = resolveSubjectType(subject);
  if (type === 'NSTP') {
    const block = nstpBlockLabel(policy);
    return {
      label: block ? `TBA · ${block}` : 'TBA · NSTP block',
      title: 'No room: NSTP meets in the Scheduling Policy NSTP block.',
      className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/10 dark:text-yellow-300 border-yellow-200 dark:border-yellow-500/20'
    };
  }
  if (type === 'Minor') {
    return subject.requiresRoom
      ? { label: 'Physical Room', title: 'Needs a CCS room: the scheduler books a CCS room (or a TBA room to request when they are full).', className: 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400 border-purple-200 dark:border-purple-500/20' }
      : { label: 'TBA (No Room)', title: 'Another department hosts this class: no CCS room or TBA room to request is booked (room TBA).', className: 'bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400 border-purple-200 dark:border-purple-500/20' };
  }
  if (subject?.isPracticum) {
    return {
      label: 'Not Scheduled',
      title: 'Practicum: never put on the timetable and needs no room; one coordinator per section.',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200 dark:border-amber-500/20'
    };
  }
  const mode = lectureModeOf(subject);
  return { label: LECTURE_MODE_OPTIONS.find(option => option.value === mode).short, ...MAJOR_ROUTING[mode] };
};
