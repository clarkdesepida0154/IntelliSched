// Phase 13 (decision 2): the Academic calendar setting and the term picker's years.
//   GET /api/academic-calendar          every signed-in role: the calendar, the year in progress and its
//                                       semester, the years to offer, the newest term with a schedule
//                                       version (the default term when the user chose none).
//   PUT /api/system/academic-calendar   the Dean's (system.manage): saves the dates, audited.
const AcademicCalendar = require('../models/AcademicCalendar');
const MotherSchedule = require('../models/MotherSchedule');
const GenerationRun = require('../models/GenerationRun');
const AuditEvent = require('../models/AuditEvent');
const { actorOf } = require('../utils/actor');
const { plainMessage } = require('../utils/messages');
const cal = require('../utils/academicCalendar');

const KEY = 'calendar';

const storedCalendar = async () => AcademicCalendar.findOne({ key: KEY }).lean();

// Every academic year that has any data: the schedule versions (legacy ones included) and the runs.
const yearsWithData = async () => {
  const [schedules, runs] = await Promise.all([
    MotherSchedule.distinct('academicYear'),
    GenerationRun.distinct('academicYear')
  ]);
  return [...new Set([...schedules, ...runs])].filter(cal.isAcademicYear);
};

// The newest term that has a schedule version the pages show (schemaVersion 2), or null.
const newestVersionTerm = async () => {
  const terms = await MotherSchedule.aggregate([
    { $match: { schemaVersion: 2 } },
    { $group: { _id: { academicYear: '$academicYear', semester: '$semester' } } }
  ]);
  const valid = terms.map(t => t._id).filter(t => cal.isAcademicYear(t.academicYear) && [1, 2].includes(t.semester));
  valid.sort((a, b) => b.academicYear.localeCompare(a.academicYear) || b.semester - a.semester);
  return valid[0] || null;
};

const answer = async (today = new Date()) => {
  const stored = await storedCalendar();
  const calendar = cal.normalizeAcademicCalendar(stored);
  const years = await yearsWithData();
  return {
    success: true,
    calendar,
    isDefault: !stored,
    hasSummer: cal.HAS_SUMMER_TERM,
    current: cal.termOfDate(today, calendar),
    options: cal.academicYearOptions({ today, calendar, yearsWithData: years }),
    yearsWithData: years.sort((a, b) => b.localeCompare(a)),
    newestVersionTerm: await newestVersionTerm(),
    updatedAt: stored?.updatedAt || null
  };
};

exports.answer = answer;
exports.yearsWithData = yearsWithData;

exports.getCalendar = async (req, res) => {
  try {
    res.status(200).json(await answer());
  } catch (err) {
    res.status(500).json({ success: false, message: plainMessage(err, 'The academic calendar could not be read. Try again.') });
  }
};

exports.updateCalendar = async (req, res) => {
  try {
    const checked = cal.validateAcademicCalendar(req.body || {});
    if (!checked.ok) {
      const field = Object.keys(checked.errors)[0];
      return res.status(400).json({ success: false, code: 'INVALID_CALENDAR', field, errors: checked.errors, message: checked.errors[field] });
    }
    const before = cal.normalizeAcademicCalendar(await storedCalendar());
    const next = checked.calendar;
    const changed = ['yearStart', 'secondSemesterStart', ...(cal.HAS_SUMMER_TERM ? ['summerStart'] : [])]
      .filter(f => before[f] !== next[f]);
    await AcademicCalendar.updateOne({ key: KEY }, { $set: { ...next, key: KEY } }, { upsert: true });
    if (changed.length) {
      const words = { yearStart: 'the academic year starts on', secondSemesterStart: 'the 2nd semester starts on', summerStart: 'Summer starts on' };
      const detail = changed.map(f => `${words[f]} ${cal.monthDayWords(next[f])} (was ${cal.monthDayWords(before[f])})`).join('; ');
      try {
        await AuditEvent.create({ action: 'Academic calendar changed', category: 'System', target: 'Academic calendar', detail: `Set ${detail}.`, actor: actorOf(req), at: new Date() });
      } catch (err) { console.error('[Academic calendar] The Audit Trail entry could not be written:', err.message); }
    }
    res.status(200).json({ ...(await answer()), message: changed.length ? 'Saved.' : 'No change.' });
  } catch (err) {
    res.status(500).json({ success: false, message: plainMessage(err, 'The academic calendar could not be saved. Try again.') });
  }
};
