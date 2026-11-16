// A professor's unavailable time as blocks ({ day, start, end } in 24-hour "HH:MM").
// Migrated records carry unavailableBlocks; an unmigrated record's deprecated unavailableDays are
// read as whole-day blocks until the migration converts them.
const { gridOrigin, toMinutes, fromMinutes, WEEKDAY_NAMES } = require('./timeGrid');

// The whole scheduling day of the policy: the grid origin to the latest window end.
const wholeDay = (policy) => ({
  start: gridOrigin(policy),
  end: fromMinutes(Math.max(toMinutes(policy.dayEnd), toMinutes(policy.saturdayOverflow.end), toMinutes(policy.nstp.end)))
});

const facultyUnavailableBlocks = (faculty, policy) => {
  if (Array.isArray(faculty?.unavailableBlocks)) {
    return faculty.unavailableBlocks.map(b => ({ day: b.day, start: b.start, end: b.end, note: b.note }));
  }
  const { start, end } = wholeDay(policy);
  return (faculty?.unavailableDays || []).map(day => ({ day, start, end, note: 'Whole day (from the old unavailable-days list)' }));
};

// The full-timer's day for Extension (Phase 8 Part 4, decision 4): the profile's own override when
// one is stored ('None' = no day for this professor; a weekday = that day), else the policy's
// extensionDay; null for a part-timer, for 'none', and for anything that is not a weekday name.
const extensionDayFor = (faculty, policy) => {
  if (faculty?.employmentType !== 'FULL_TIME') return null;
  const own = String(faculty?.extensionDay ?? '').trim();
  const chosen = own || String(policy?.extensionDay ?? 'none');
  const day = WEEKDAY_NAMES.find(d => d.toLowerCase() === chosen.toLowerCase());
  return day || null;
};

// The SCHEDULER's view of the professor's unavailable time: the stored blocks plus the whole
// Extension day (so the GA request, the validator, the Readiness Check and the load balance all
// keep the day class-free without any engine change). The outputs keep reading
// facultyUnavailableBlocks — the Extension day is not drawn as unavailable time on the Teachers'
// Program; the duty fill puts EXTENSION there instead (utils/ancillaryFill.js).
const schedulingUnavailableBlocks = (faculty, policy) => {
  const blocks = facultyUnavailableBlocks(faculty, policy);
  const day = extensionDayFor(faculty, policy);
  if (!day) return blocks;
  const { start, end } = wholeDay(policy);
  return [...blocks, { day, start, end, note: 'Day for Extension (the Scheduling Policy keeps it class-free)' }];
};

module.exports = { facultyUnavailableBlocks, schedulingUnavailableBlocks, extensionDayFor, wholeDay };
