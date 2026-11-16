// Phase 13 (decision 2): academic years that update themselves. The university's calendar is a
// setting (Administration -> System, "Academic calendar"), never code: from it come the academic year in
// progress, the semester by date (for the default term only) and the years the term picker offers.
// client/src/utils/academicCalendar.js is an identical mirror: the code between the SHARED markers must
// be byte-for-byte the same in both files (tests/unit/academicCalendar.test.js compares them).

// ---- BEGIN SHARED ----
// The dates as month-day text ("06-01" = June 1). A missing or broken setting reads as these.
const DEFAULT_ACADEMIC_CALENDAR = Object.freeze({ yearStart: '06-01', secondSemesterStart: '11-01', summerStart: '04-01' });
// IntelliSched has the 1st and 2nd semesters only, so the Summer date is kept but never shown or used.
const HAS_SUMMER_TERM = false;
// The term picker offers every year with data, the current one and this many after it.
const NEXT_YEARS_OFFERED = 4;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// February 29 is never offered: every year must have the date.
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// The academic year (its start to the end of the 2nd semester, or to Summer when there is one) is at
// least 9 months: 273 days.
const MIN_YEAR_DAYS = 273;

const pad2 = (n) => String(n).padStart(2, '0');

// "06-01" -> { month: 6, day: 1 }; null for anything else.
const parseMonthDay = (text) => {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { month, day };
};

const formatMonthDay = ({ month, day }) => `${pad2(month)}-${pad2(day)}`;

// "06-01" -> "June 1".
const monthDayWords = (text) => {
  const md = parseMonthDay(text);
  return md ? `${MONTH_NAMES[md.month - 1]} ${md.day}` : '';
};

// The day of a 365-day year (0..364); February 29 counts as February 28.
const dayOfYear = ({ month, day }) => {
  let n = 0;
  for (let i = 0; i < month - 1; i += 1) n += DAYS_IN_MONTH[i];
  return n + Math.min(day, DAYS_IN_MONTH[month - 1]) - 1;
};

// Days from `start` forward to `md` within one cycle (0..364).
const daysFrom = (start, md) => (dayOfYear(md) - dayOfYear(start) + 365) % 365;

// Checks a calendar the Dean typed. Returns { ok, errors: { field: words }, calendar } with the dates as
// "MM-DD"; without Summer its date is kept as it was (or the default) and never checked.
const validateAcademicCalendar = (input, { hasSummer = HAS_SUMMER_TERM } = {}) => {
  const errors = {};
  const fields = hasSummer ? ['yearStart', 'secondSemesterStart', 'summerStart'] : ['yearStart', 'secondSemesterStart'];
  const parsed = {};
  for (const field of fields) {
    const text = String(input?.[field] ?? '').trim();
    const md = parseMonthDay(text);
    if (!md) errors[field] = /^0?2-29$/.test(text) ? 'Choose a day every year has (not February 29).' : 'Choose a month and a day.';
    else parsed[field] = md;
  }
  if (parsed.yearStart && parsed.secondSemesterStart && daysFrom(parsed.yearStart, parsed.secondSemesterStart) === 0) {
    errors.secondSemesterStart = 'The 2nd semester must start after the academic year starts.';
  }
  if (hasSummer && parsed.yearStart && parsed.secondSemesterStart && parsed.summerStart && !errors.secondSemesterStart) {
    const second = daysFrom(parsed.yearStart, parsed.secondSemesterStart);
    const summer = daysFrom(parsed.yearStart, parsed.summerStart);
    if (summer <= second) errors.summerStart = 'Summer must start after the 2nd semester starts.';
    else if (summer < MIN_YEAR_DAYS) errors.summerStart = 'The academic year can\'t be shorter than 9 months. Choose a later Summer start.';
  }
  const ok = Object.keys(errors).length === 0;
  const kept = parseMonthDay(input?.summerStart) ? formatMonthDay(parseMonthDay(input.summerStart)) : DEFAULT_ACADEMIC_CALENDAR.summerStart;
  const calendar = ok ? {
    yearStart: formatMonthDay(parsed.yearStart),
    secondSemesterStart: formatMonthDay(parsed.secondSemesterStart),
    summerStart: hasSummer ? formatMonthDay(parsed.summerStart) : kept
  } : null;
  return { ok, errors, calendar };
};

// The calendar to use: the stored one when it is whole and valid, otherwise the defaults (a missing
// setting is never an error).
const normalizeAcademicCalendar = (raw) => {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ACADEMIC_CALENDAR };
  const filled = {
    yearStart: raw.yearStart ?? DEFAULT_ACADEMIC_CALENDAR.yearStart,
    secondSemesterStart: raw.secondSemesterStart ?? DEFAULT_ACADEMIC_CALENDAR.secondSemesterStart,
    summerStart: raw.summerStart ?? DEFAULT_ACADEMIC_CALENDAR.summerStart
  };
  const checked = validateAcademicCalendar(filled);
  return checked.ok ? checked.calendar : { ...DEFAULT_ACADEMIC_CALENDAR };
};

// "2026-2027": four digits, a hyphen, and the next year.
const isAcademicYear = (text) => {
  const m = /^(\d{4})-(\d{4})$/.exec(String(text ?? ''));
  return Boolean(m) && Number(m[1]) >= 1900 && Number(m[2]) === Number(m[1]) + 1;
};

// The academic year a date falls in: from the "academic year starts on" date of year Y until the day
// before it in Y+1 it is "Y-Y+1".
const academicYearOf = (date = new Date(), calendar) => {
  const start = parseMonthDay(normalizeAcademicCalendar(calendar).yearStart);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const before = month < start.month || (month === start.month && day < start.day);
  const startYear = date.getFullYear() - (before ? 1 : 0);
  return `${startYear}-${startYear + 1}`;
};

// The semester a date falls in (1 or 2): the 2nd from its start date until the next academic year.
const semesterOf = (date = new Date(), calendar) => {
  const cal = normalizeAcademicCalendar(calendar);
  const start = parseMonthDay(cal.yearStart);
  const today = { month: date.getMonth() + 1, day: date.getDate() };
  return daysFrom(start, today) < daysFrom(start, parseMonthDay(cal.secondSemesterStart)) ? 1 : 2;
};

// { academicYear, semester } for a date.
const termOfDate = (date = new Date(), calendar) => ({ academicYear: academicYearOf(date, calendar), semester: semesterOf(date, calendar) });

// The years the term picker offers: every year that has data, the current one and the next four,
// newest first.
const academicYearOptions = ({ today = new Date(), calendar, yearsWithData = [], next = NEXT_YEARS_OFFERED } = {}) => {
  const current = academicYearOf(today, calendar);
  const startYear = Number(current.slice(0, 4));
  const years = new Set((yearsWithData || []).filter(isAcademicYear));
  for (let i = 0; i <= next; i += 1) years.add(`${startYear + i}-${startYear + i + 1}`);
  return [...years].sort((a, b) => b.localeCompare(a));
};

// 1 -> "1st Semester", 2 -> "2nd Semester".
const semesterLabelOf = (semester) => (Number(semester) === 2 ? '2nd Semester' : '1st Semester');

// The term shown when the app opens, as { academicYear, semester, source }: the term this user chose
// last; otherwise the term the build names (the demos only); otherwise the newest term with a schedule
// version; otherwise the year in progress with today's semester. Each must be a year on offer.
const chooseDefaultTerm = ({ saved, buildTerm, newestVersionTerm, current, options } = {}) => {
  const usable = (t) => Boolean(t) && isAcademicYear(t.academicYear) && [1, 2].includes(Number(t.semester))
    && (!options || options.includes(t.academicYear));
  const order = [['saved', saved], ['build', buildTerm], ['newest-version', newestVersionTerm], ['today', current]];
  for (const [source, t] of order) {
    if (usable(t)) return { academicYear: t.academicYear, semester: Number(t.semester), source };
  }
  const today = termOfDate(new Date());
  return { ...today, source: 'today' };
};
// ---- END SHARED ----

module.exports = {
  DEFAULT_ACADEMIC_CALENDAR, HAS_SUMMER_TERM, NEXT_YEARS_OFFERED, MONTH_NAMES, DAYS_IN_MONTH, MIN_YEAR_DAYS,
  parseMonthDay, formatMonthDay, monthDayWords, validateAcademicCalendar, normalizeAcademicCalendar,
  isAcademicYear, academicYearOf, semesterOf, termOfDate, academicYearOptions, semesterLabelOf, chooseDefaultTerm
};
