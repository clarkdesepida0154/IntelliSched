// The Teaching loads panel (Phase 8; Part 4 grew it from "Part-time loads"), on Assign Faculty:
// every professor's teaching hours against their RANGE (the minimum to the cap), the part-time
// average and spread, and "Suggest a balance" — the load balance (the same method the term file was
// built with, utils/partTimeBalance.js balanceTeachingLoads): first raise full-timers below their
// minimum, then part-timers below theirs, then narrow the part-time spread (the Dean's equal-loads
// rule, E6). GET only: nothing here writes. The Dean applies a suggested move with the
// Recommendations' own assign route (POST /schedule/lock, decision 'override', so the Overload
// Guardian checks the cap again and Engine 4 learns from the decision).
//
// GET /api/schedule/part-time-loads?academicYear&semester
//   -> { professors: [{ facultyRef, facultyId, name, employmentType, hours, cap, min, underMin }],
//        partTimers: [{ facultyRef, facultyId, name, hours, cap }], average, spread,
//        suggestion: { moves: [{ subjectId, subjectCode, descriptiveTitle, sectionId, sectionCode,
//                      from: { facultyRef, facultyId, name }, to: { facultyRef, facultyId, name },
//                      hoursFrom, hoursTo, phase, why }], loadsAfter, spreadAfter } | null,
//        cannotReach: [{ name, employmentType, hours, min, underMin, reason, offers }], note }
//
// Phase 8 Part 5 (decision 3): under each minimum the balance cannot reach, `offers` lists the
// classes that COULD move to that professor once the Secretary allows a subject they have not
// taught (his own fix, made one click): any subject, each marked taughtBefore true/false; the giver
// stays at or above their OWN minimum; the taker stays within the cap and their free weekday time
// (the Friday-for-Extension rule rides schedulingUnavailableBlocks); a class of a subject NOBODY on
// the faculty has taught is never offered — those are the Dean's own assignments (ITEP 205). The
// order: the ranking's Likelihood for that professor first, where the ranking service answers, then
// the giver's hours above their own minimum. NOTHING here moves by itself: Apply in the panel is
// one class through POST /schedule/lock as the Dean's override with its reason, so the Overload
// Guardian re-checks and Engine 4 learns.
// The rules, exactly the term file's: movable classes are the professors' Major classes (practicum
// and Minors stay; their hours still count); a taker must have taught the subject before (the
// teaching history the term loader stored), stay within the cap and keep enough free weekday time
// (the Readiness Check's line-8 arithmetic, which also carries the Friday-for-Extension rule); a
// giver stays at or above their own minimum. The Dean's ITEP 205 classes can never move: nobody on
// the faculty has them in a teaching history, so no taker ever qualifies. `suggestion` is null
// while no move helps; `cannotReach` says, per professor, why their minimum cannot be reached.
const mlClient = require('../config/mlClient');
const { loadTermInputs } = require('../utils/termInputs');
const { balanceTeachingLoads } = require('../utils/partTimeBalance');
const { usableIntervals, usableHoursWithLunch } = require('../utils/preflight');
const { facultyLoad, weightedHoursOf, minTeachingHoursOf } = require('../utils/load');
const { buildTermAssignments, buildFacultyResolver, TBA_POOL_FACULTY_ID } = require('../utils/termAssignments');
const { resolveSubjectType, findLockFor } = require('../utils/curriculumMatcher');
// Phase 8 Part 4 (decision 4): the free weekday hours count the Extension day as unavailable.
const { schedulingUnavailableBlocks } = require('../utils/facultyAvailability');

const round2 = (n) => Math.round(n * 100) / 100;

exports.getPartTimeLoads = async (req, res, next) => {
  try {
    const academicYear = String(req.query.academicYear || '').trim();
    const semester = Number(req.query.semester);
    if (!academicYear || ![1, 2].includes(semester)) {
      return res.status(400).json({ success: false, message: 'Name the term: academicYear and semester (1 or 2).' });
    }
    const inputs = await loadTermInputs({ academicYear, semester });
    const { policy, pairs, locks, faculty } = inputs;
    const active = faculty.filter(f => f.isActive !== false);
    const nameOf = new Map(active.map(f => [f.name, f]));

    // Each professor's teaching hours: the one load rule over the term's assignments.
    const assignmentsByFaculty = buildTermAssignments({ faculty, pairs, locks });
    const loadByName = new Map(active.map(f => [f.name, facultyLoad(f, assignmentsByFaculty.get(String(f._id)) || [], policy)]));

    // The movable rows (a professor's Major classes) and the fixed hours (Minors and practicum
    // coordination: counted, never moved), from the term's pairs and locks.
    const resolveHolder = buildFacultyResolver(faculty);
    const movable = [];
    const fixedHours = new Map();
    for (const { section, subject } of pairs) {
      const type = resolveSubjectType(subject);
      if (type === 'NSTP') continue;
      const found = findLockFor(locks, section.sectionCode, subject);
      const lock = found && (type !== 'Minor' || found.source === 'manual') ? found : null;
      if (!lock || lock.facultyId === TBA_POOL_FACULTY_ID) continue;
      const holder = resolveHolder(lock);
      if (!holder || holder.isActive === false) continue;
      if (type === 'Major' && !subject.isPracticum) {
        movable.push({
          sectionId: String(section._id), sectionCode: section.sectionCode,
          subjectId: String(subject._id), subjectCode: subject.subjectCode, descriptiveTitle: subject.descriptiveTitle,
          subject, faculty: holder.name
        });
      } else {
        fixedHours.set(holder.name, round2((fixedHours.get(holder.name) || 0) + weightedHoursOf(subject, holder, policy)));
      }
    }

    const capOf = (name) => {
      const prof = nameOf.get(name);
      const cap = Number(prof?.teachingCapHours);
      if (Number.isFinite(cap)) return cap;
      const byType = Number(policy.load.defaultTeachingCap?.[prof?.employmentType]);
      return Number.isFinite(byType) ? byType : 40;
    };
    const minOf = (name) => minTeachingHoursOf(nameOf.get(name) || {}, policy);
    const hoursOfRow = (row, name) => weightedHoursOf(row.subject, nameOf.get(name) || { employmentType: 'PART_TIME' }, policy);
    // Taught the subject before: the teaching history the term loader stored, joined by catalog id.
    const taughtBefore = (name, row) => (nameOf.get(name)?.teachingHistory || [])
      .some(h => h.subjectId && String(h.subjectId) === String(row.subjectId));
    // Free weekday hours, the Readiness Check's line-8 arithmetic (schedulingUnavailableBlocks
    // carries the Friday-for-Extension day once the policy sets one).
    const weekdays = (policy.weekdays || []).filter(d => d !== 'Saturday');
    const freeHoursOf = (name) => {
      const prof = nameOf.get(name);
      if (!prof) return Infinity;
      const blocks = schedulingUnavailableBlocks(prof, policy);
      return round2(weekdays.reduce((sum, day) => sum + usableHoursWithLunch(policy, usableIntervals(policy, day, blocks)), 0));
    };

    // Phase 8 Part 6 (decision 4, "Balance all"): ONE plan — the taught-before moves as before,
    // then a new subject for anyone still under (the giver's own minimum, the taker's cap and free
    // time all hold across the whole plan; a subject nobody has taught never moves). The builder's
    // own one-time call keeps the flag off, so the term file's recorded balance is untouched.
    const result = balanceTeachingLoads({
      assignments: movable,
      professors: active.map(f => ({ name: f.name, employmentType: f.employmentType })),
      hoursOf: hoursOfRow,
      capOf,
      minOf,
      fixedHours,
      taughtBefore,
      freeHoursOf,
      includeNewSubjects: true
    });
    const who = (name) => {
      const prof = nameOf.get(name);
      return { facultyRef: String(prof._id), facultyId: prof.facultyId, name };
    };

    // ---- Phase 8 Part 5 (decision 3): the offers under each unreachable minimum -----------------
    // Computed on the loads AS THEY STAND (loadsBefore and the current holders), never on the
    // suggestion's hypothetical moves: each offer is a class the Dean could move right now. A
    // subject nobody on the faculty has taught is the Dean's own call (ITEP 205), never offered.
    const anybodyTaught = (subjectId) => active.some(f => (f.teachingHistory || [])
      .some(h => h.subjectId && String(h.subjectId) === String(subjectId)));
    const loadsNow = result.loadsBefore;
    const cannotReach = result.cannotReach.map((c) => {
      const offers = [];
      for (const row of movable) {
        if (row.faculty === c.name || !nameOf.has(row.faculty)) continue;
        if (!anybodyTaught(row.subjectId)) continue;
        const hoursTo = hoursOfRow(row, c.name);
        const hoursFrom = hoursOfRow(row, row.faculty);
        if (!(hoursTo > 0)) continue;
        const giverAfter = round2((loadsNow.get(row.faculty) || 0) - hoursFrom);
        if (giverAfter < minOf(row.faculty)) continue;
        const takerAfter = round2((loadsNow.get(c.name) || 0) + hoursTo);
        if (takerAfter > capOf(c.name) || takerAfter > freeHoursOf(c.name)) continue;
        offers.push({
          subjectId: row.subjectId,
          subjectCode: row.subjectCode,
          descriptiveTitle: row.descriptiveTitle,
          sectionId: row.sectionId,
          sectionCode: row.sectionCode,
          from: who(row.faculty),
          hours: hoursTo,
          hoursFrom,
          giverHoursAfter: giverAfter,
          giverMin: minOf(row.faculty),
          giverAboveMin: round2(giverAfter - minOf(row.faculty)),
          takerHoursAfter: takerAfter,
          taughtBefore: taughtBefore(c.name, row)
        });
      }
      return { ...c, taker: who(c.name), offers };
    });
    // The ranking's Likelihood for that professor, where the ranking service answers (one call for
    // the distinct offered subjects; without an answer the giver's headroom alone orders the list).
    const offeredSubjects = [...new Map(cannotReach.flatMap(c => c.offers).map(o => [o.subjectId, o])).keys()];
    if (offeredSubjects.length) {
      try {
        const subjectOf = new Map(movable.map(r => [r.subjectId, r.subject]));
        const engineSubjects = offeredSubjects.map((id) => {
          const subject = subjectOf.get(id);
          const programs = (inputs.termMappings || [])
            .filter(m => String(m.subject?._id ?? m.subject ?? '') === id)
            .map(m => String(m.program || '').toUpperCase());
          return {
            subjectCode: subject.subjectCode,
            subjectTitle: subject.descriptiveTitle,
            subjectDescription: subject.subjectDescription || subject.descriptiveTitle,
            subjectId: id,
            programs: [...new Set(programs.filter(Boolean))]
          };
        });
        const aiRes = await mlClient.post('/api/get_recommendations', { subjects: engineSubjects, academicYear, semester }, { timeout: 15000 });
        const candidatesOf = new Map();
        (aiRes.data.predictions || []).forEach((p, i) => candidatesOf.set(engineSubjects[i].subjectId, p.candidates || []));
        for (const c of cannotReach) {
          const prof = nameOf.get(c.name);
          for (const o of c.offers) {
            const cand = (candidatesOf.get(o.subjectId) || []).find(x => x.name === c.name || (prof?.facultyId && x.id === prof.facultyId));
            if (cand && Number.isFinite(Number(cand.score))) o.likelihood = Math.round(Number(cand.score) * 10) / 10;
          }
        }
      } catch { /* the Likelihood is an ordering aid only; the panel still lists the offers */ }
    }
    for (const c of cannotReach) {
      c.offers.sort((a, b) => ((b.likelihood ?? -1) - (a.likelihood ?? -1))
        || (b.giverAboveMin - a.giverAboveMin)
        || String(a.subjectCode).localeCompare(String(b.subjectCode))
        || String(a.sectionCode).localeCompare(String(b.sectionCode)));
    }
    const professors = active.map(f => {
      const load = loadByName.get(f.name);
      return {
        facultyRef: String(f._id),
        facultyId: f.facultyId,
        name: f.name,
        employmentType: f.employmentType || null,
        hours: round2(load?.teaching || 0),
        cap: capOf(f.name),
        min: minOf(f.name),
        underMin: round2(load?.underMin || 0)
      };
    }).sort((a, b) => b.underMin - a.underMin || b.hours - a.hours || a.name.localeCompare(b.name));
    // The part-time rows, average and spread (the office comparison the system check quotes).
    const partRows = professors.filter(p => p.employmentType === 'PART_TIME')
      .map(({ facultyRef, facultyId, name, hours, cap }) => ({ facultyRef, facultyId, name, hours, cap }))
      .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
    const values = partRows.map(r => r.hours);
    const average = values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : 0;
    const spread = values.length ? round2(Math.max(...values) - Math.min(...values)) : 0;

    res.json({
      success: true,
      professors,
      partTimers: partRows,
      average,
      spread,
      suggestion: result.moves.length ? {
        moves: result.moves.map(m => {
          const row = movable.find(r => r.sectionCode === m.sectionCode && r.subjectCode === m.subjectCode);
          return {
            subjectId: row?.subjectId, subjectCode: m.subjectCode, descriptiveTitle: m.descriptiveTitle,
            sectionId: row?.sectionId, sectionCode: m.sectionCode,
            from: who(m.from), to: who(m.to), hoursFrom: m.hoursFrom, hoursTo: m.hoursTo,
            // Phase 8 Part 6 ("Balance all"): the numbers the confirmation lists, and the
            // "Not taught before" mark for a phase-4 move.
            fromBefore: m.fromBefore, fromAfter: m.fromAfter, toBefore: m.toBefore, toAfter: m.toAfter,
            taughtBefore: m.taughtBefore !== false,
            phase: m.phase, why: m.why
          };
        }),
        loadsBefore: Object.fromEntries([...result.loadsBefore.entries()]),
        loadsAfter: Object.fromEntries([...result.loadsAfter.entries()]),
        spreadAfter: result.spreadAfter
      } : null,
      cannotReach,
      note: 'Teaching hours count lecture plus lab at the lab factor, practicum coordination included. A suggested move raises a professor below their minimum first (full-timers, then part-timers), then evens the part-time loads; the taker taught the subject before (the transcribed Teachers\' Programs), stays within the cap and keeps their free weekday time, and the giver stays at or above their own minimum; the Overload Guardian checks again when it is applied.',
      offersNote: 'Under a minimum the balance cannot reach, "Classes that could move" lists any subject (each marked when the professor has not taught it): the giver stays at or above their own minimum, the taker stays within their cap and free weekday time, and a subject nobody on the faculty has taught is never offered (the Dean assigns those herself). Nothing moves by itself: Apply saves one class as your decision, with its reason, and the system checks the teaching cap again and learns from it.'
    });
  } catch (err) {
    next(err);
  }
};
