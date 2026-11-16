// Validation of day + time windows ({ day, start, end }) on the policy grid: room availability
// and faculty unavailable blocks. Storage is 24-hour "HH:MM".
const { DAY_NAMES, isTime, isOnGrid, toMinutes } = require('./timeGrid');

// Returns { windows, errors }. `windows` are the cleaned rows (day, start, end plus any `keep` keys);
// `errors` are [{ field, message }] with fields like "availability.2.start". Windows on the same
// day may not overlap.
const validateTimeWindows = (raw, { field, slotMinutes, days = DAY_NAMES, keep = [] }) => {
  const errors = [];
  const windows = [];
  if (raw === undefined || raw === null) return { windows, errors };
  if (!Array.isArray(raw)) return { windows, errors: [{ field, message: 'Send the time windows as a list.' }] };

  const valid = [];
  raw.forEach((entry, i) => {
    const at = `${field}.${i}`;
    const day = String(entry?.day ?? '').trim();
    const start = String(entry?.start ?? '').trim();
    const end = String(entry?.end ?? '').trim();
    let ok = true;
    if (!days.includes(day)) {
      errors.push({ field: `${at}.day`, message: `Choose a day from ${days[0]} to ${days[days.length - 1]}.` });
      ok = false;
    }
    for (const [key, value] of [['start', start], ['end', end]]) {
      if (!isTime(value)) {
        errors.push({ field: `${at}.${key}`, message: 'Enter a time as HH:MM (24-hour), for example 13:00.' });
        ok = false;
      } else if (!isOnGrid(value, slotMinutes)) {
        errors.push({ field: `${at}.${key}`, message: `Times must fall on a ${slotMinutes}-minute boundary (:00 or :30).` });
        ok = false;
      }
    }
    if (isTime(start) && isTime(end) && toMinutes(start) >= toMinutes(end)) {
      errors.push({ field: `${at}.end`, message: 'The window must end after it starts.' });
      ok = false;
    }
    const row = { day, start, end };
    keep.forEach(key => {
      if (entry?.[key] !== undefined && entry[key] !== null) row[key] = String(entry[key]).trim();
    });
    windows.push(row);
    if (ok) valid.push({ i, ...row });
  });

  // Overlaps among the individually valid windows, day by day.
  const byDay = new Map();
  valid.forEach(w => byDay.set(w.day, [...(byDay.get(w.day) || []), w]));
  for (const [day, list] of byDay) {
    list.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (let k = 1; k < list.length; k++) {
      const prev = list[k - 1];
      if (toMinutes(list[k].start) < toMinutes(prev.end)) {
        errors.push({ field: `${field}.${list[k].i}.start`, message: `This window overlaps another one on ${day} (${prev.start}–${prev.end}).` });
      }
    }
  }
  return { windows, errors };
};

module.exports = { validateTimeWindows };
