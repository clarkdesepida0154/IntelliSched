const MotherSchedule = require('../models/MotherSchedule');
const AuditEvent = require('../models/AuditEvent');
const GenerationRun = require('../models/GenerationRun');
const { describeActor, systemActor } = require('../utils/actor');
const { shownStatus } = require('../utils/versionCheck');

// "3 conflicts", "1 conflict" (a conflict is a broken hard rule), or "conflicts not recorded".
const conflictsText = (n) => (Number.isFinite(n) ? `${n} ${n === 1 ? 'conflict' : 'conflicts'}` : 'conflicts not recorded');

// "2026-09-29 14:05:00" (UTC), or null for a missing or broken date (never an invented "now").
const formatDate = (val) => {
  const d = val ? new Date(val) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 19) : null;
};

// What each logged decision is (overrideLogs.entryType).
const ENTRY_LABELS = {
  lock: 'Professor assigned',
  accept: 'Recommendation accepted',
  override: 'Recommendation overridden',
  'schedule-edit': 'Class moved in the Schedule Views & Editor'
};
const EVENT_LABELS = {
  'policy-save': 'Scheduling Policy saved',
  'output-settings-save': 'Output Settings saved',
  'reference-list-save': 'Reference list saved',
  'version-restore': 'Version restored',
  'lock-release': 'Assignment released',
  'manual-assignment': 'Professor assigned (Minor, manual)',
  'coordinator-assignment': 'Practicum coordinator assigned',
  // Phase 4 Part 1: a schedule edit (never a faculty decision).
  'fill-tba-rooms': 'TBA rooms filled',
  // Phase 4 Part 2: two classes exchanged in the Schedule Views & Editor (a schedule edit).
  'swap-classes': 'Two classes swapped'
};

// The approver of an approval row written before Phase 2 was stored in other fields (name in
// deanSelectedFaculty, role in aiRecommendedFacultyId); that is a real record, so it is shown.
const legacyApprover = (ovr) => (ovr.deanSelectedFaculty ? { name: ovr.deanSelectedFaculty, role: ovr.aiRecommendedFacultyId || null } : null);

// @desc    The Audit Trail: who did what and when. Rows come from the schedule documents (each saved
//          version and its decision rows), from audit_events (policy saves, restores, lock
//          releases, manual Minor and coordinator assignments) and from generation_runs (each GA run
//          started, and each run cancelled or failed; a finished run is its saved version). Newest first.
// @route   GET /api/audit/logs
exports.getAuditLogs = async (req, res, next) => {
  try {
    // scheduleData is projected to one field per class so the class count below is the real one.
    // lean(): nothing is re-saved.
    const [schedules, events, runs] = await Promise.all([
      MotherSchedule.find()
        .select('academicYear semester program status version overrideLogs createdAt updatedAt createdBy gaStats restoredFrom filledFrom scheduleData.day')
        .lean(),
      AuditEvent.find().lean(),
      GenerationRun.find()
        .select('academicYear semester status startedBy startedAt finishedAt settings seed demands message cancelledBy')
        .lean()
    ]);

    const rows = [];
    const push = (row) => rows.push({ ...row, date: formatDate(row.at) || 'Not recorded', by: describeActor(row.actor) });

    schedules.forEach((sched) => {
      const id = String(sched._id);
      const term = `${sched.academicYear} Sem ${sched.semester}`;
      const classes = sched.scheduleData?.length || 0;
      // A Draft made by a restore (Phase 3 Step 5) copies the run statistics of the version it restores,
      // but was not generated: it is a saved version, restored by the user in createdBy.
      const restored = sched.restoredFrom?.id ? sched.restoredFrom : null;
      // Phase 4 Part 1: a Draft made by Fill TBA rooms copies a Draft with its TBA classes put into real rooms.
      const filled = sched.filledFrom?.id ? sched.filledFrom : null;
      push({
        id: `VER-${id}`,
        action: sched.gaStats && !restored && !filled ? `Timetable generated (${sched.version || 'v1.0'})` : `Schedule version saved (${sched.version || 'v1.0'})`,
        category: 'Timetable',
        target: term,
        detail: restored
          ? `Status: ${shownStatus(sched.status)}; ${classes} classes; restored from ${restored.version || 'an earlier version'} (${shownStatus(restored.status) || 'status not recorded'} when restored).`
          : filled
            ? `Status: ${shownStatus(sched.status)}; ${classes} classes; ${filled.version || 'an earlier Draft'} with ${Number.isFinite(filled.classCount) ? filled.classCount : 'its'} TBA classes put into real rooms (Fill TBA rooms).`
          : sched.gaStats
            ? `Status: ${shownStatus(sched.status)}; ${classes} classes; ${conflictsText(sched.gaStats.finalHard)}.`
            : `Status: ${shownStatus(sched.status)}; ${classes} classes (assignments only when 0).`,
        actor: sched.createdBy || null,
        at: sched.createdAt,
        // Phase 8 Part 6: the final (Approved) version is the critical one; there is no Publish.
        level: shownStatus(sched.status) === 'Approved' ? 'Critical' : 'High'
      });

      (sched.overrideLogs || []).forEach((ovr, idx) => {
        const isApproval = ovr.entryType === 'approval' || ovr.subjectCode === 'APPROVAL-CHAIN';
        const section = ovr.sectionCode || ovr.section;
        push({
          id: `LOG-${id}-${idx}`,
          action: isApproval ? 'Approval stage signed' : `${ENTRY_LABELS[ovr.entryType] || 'Decision logged'}: ${ovr.subjectCode} (${section})`,
          category: isApproval ? 'Approval' : ovr.entryType === 'schedule-edit' ? 'Timetable' : 'Assignments',
          target: isApproval ? term : `${ovr.subjectCode} • ${section}`,
          professor: isApproval ? null : (ovr.assignedFacultyName || ovr.deanSelectedFaculty || ovr.assignedFacultyId || null),
          detail: ovr.reason || '',
          actor: ovr.actor || (isApproval ? legacyApprover(ovr) : null),
          at: ovr.timestamp || null,
          level: isApproval ? 'Critical' : 'Moderate'
        });
      });
    });

    events.forEach((ev) => {
      push({
        id: `EVT-${String(ev._id)}`,
        action: EVENT_LABELS[ev.action] || ev.action,
        category: ev.category,
        target: ev.target,
        detail: ev.detail || '',
        actor: ev.actor || null,
        at: ev.at,
        level: ev.category === 'Approval' ? 'Critical' : 'Moderate'
      });
    });

    runs.forEach((run) => {
      const id = String(run._id);
      const term = `${run.academicYear} Sem ${run.semester}`;
      const budget = run.settings?.timeBudgetSeconds ? `, time budget ${Math.round(run.settings.timeBudgetSeconds / 60 * 10) / 10} min` : '';
      push({
        id: `RUN-${id}`,
        action: 'Schedule generation started',
        category: 'Timetable',
        target: term,
        // Phase 3 Step 8: the plain words in `detail`; the run's GA settings and seed apart in
        // `technical`, for a "Technical details" area only.
        detail: Number.isFinite(run.demands) ? `${run.demands} ${run.demands === 1 ? 'class' : 'classes'} to place.` : 'Classes to place: not recorded.',
        technical: `${run.settings?.mode === 'baseline' ? 'Phase 1 GA' : 'Improved GA'}${budget}; seed ${run.seed ?? 'not recorded'}.`,
        actor: run.startedBy || null,
        at: run.startedAt,
        level: 'Moderate'
      });
      if (run.status === 'cancelled' || run.status === 'failed') {
        push({
          id: `RUN-${id}-end`,
          action: run.status === 'cancelled' ? 'Schedule generation cancelled' : 'Schedule generation failed',
          category: 'Timetable',
          target: term,
          detail: run.message || '',
          // A cancel names who cancelled; a failure is the system's, on behalf of who started the run.
          actor: run.status === 'cancelled' ? (run.cancelledBy || null) : systemActor(run.startedBy || null),
          at: run.finishedAt,
          level: 'Moderate'
        });
      }
    });

    // Newest first; rows without a date go last.
    const time = (r) => { const t = r.at ? new Date(r.at).getTime() : NaN; return Number.isNaN(t) ? -Infinity : t; };
    rows.sort((a, b) => time(b) - time(a));

    // No invented rows: an empty trail is answered empty and the page shows its empty state.
    res.status(200).json({
      success: true,
      count: rows.length,
      logs: rows.map(({ actor, ...row }) => ({ ...row, at: Number.isFinite(time(row)) ? new Date(row.at).toISOString() : null, byRecorded: Boolean(actor?.name) }))
    });
  } catch (err) {
    next(err);
  }
};
