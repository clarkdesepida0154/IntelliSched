const MotherSchedule = require('../models/MotherSchedule');
const { describeActor } = require('../utils/actor');
const { isTrainingDecision, kindOf } = require('../utils/decisions');

// "2026-09-29 14:05:00" (UTC), or null for a missing or broken date (never an invented "now").
const formatDate = (val) => {
  const d = val ? new Date(val) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 19) : null;
};

const numberOrNull = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const textOrNull = (value) => (String(value ?? '').trim() || null);

// @desc    The Model Feedback page (Phase 3 Step 8, item 7): the term's decisions on the rankings,
//          read from every schedule document of the term (a Draft made by a run starts with no rows,
//          so one document is not enough), the term's rows that are not decisions by kind, and how
//          many decisions every term holds: what Engine 4 retrains on (utils/decisions.js, the same
//          rule as engine4_retrainer.py). Only recorded values: a missing one is null. A read.
// @route   GET /api/schedule/decisions?academicYear=&semester=
exports.getDecisions = async (req, res) => {
  try {
    const academicYear = String(req.query.academicYear ?? '').trim();
    const semester = Number(req.query.semester);
    if (!academicYear || !Number.isInteger(semester)) {
      return res.status(400).json({ success: false, message: 'Choose the academic year and the semester.' });
    }

    const docs = await MotherSchedule.find({ overrideLogs: { $exists: true, $ne: [] } })
      .select('academicYear semester version status overrideLogs')
      .lean();

    const counts = { accept: 0, override: 0, assigned: 0, unrecorded: 0, lock: 0, 'schedule-edit': 0, approval: 0, other: 0 };
    const decisions = [];
    let allTerms = 0;
    docs.forEach((doc) => {
      const inTerm = doc.academicYear === academicYear && Number(doc.semester) === semester;
      (doc.overrideLogs || []).forEach((row, index) => {
        const isDecision = isTrainingDecision(row);
        if (isDecision) allTerms += 1;
        if (!inTerm) return;
        counts[kindOf(row)] += 1;
        if (!isDecision) return;
        decisions.push({
          id: `${doc._id}-${index}`,
          kind: kindOf(row),
          subjectCode: textOrNull(row.subjectCode),
          section: textOrNull(row.sectionCode || row.section),
          recommended: textOrNull(row.mlTop1Faculty || row.aiRecommendedFacultyName),
          recommendedScore: numberOrNull(row.mlTop1Score),
          chosen: textOrNull(row.assignedFacultyName || row.deanSelectedFaculty),
          reason: textOrNull(row.reason),
          at: formatDate(row.timestamp),
          by: describeActor(row.actor),
          version: doc.version || null
        });
      });
    });
    // Newest first; a row without a date last.
    decisions.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    res.status(200).json({ success: true, term: { academicYear, semester }, decisions, counts, allTerms });
  } catch (err) {
    console.error('[Decisions] read failed', err);
    res.status(500).json({ success: false, message: 'The decisions could not be read. Try again.' });
  }
};
