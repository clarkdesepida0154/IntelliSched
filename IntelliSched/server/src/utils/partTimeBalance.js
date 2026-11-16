// The load balance (Phase 8 Part 4, decision 2; grown from the Dean's equal part-time loads, E6):
// ONE method, used by the Teaching loads panel (controllers/partTimeLoadsController.js) and by the
// term-file builder (scripts/build-term-sem2.js, its one-time Part 4 step), so the file and the
// panel can never disagree. It works in this order:
//   1. raise full-timers who are below their minimum teaching load;
//   2. then raise part-timers who are below theirs;
//   3. then narrow the part-time spread, as before (E6);
//   4. (Phase 8 Part 6, decision 4, and only with includeNewSubjects: "Balance all") for anyone
//      still under their minimum, move a class of a subject they have NOT taught — the Secretary's
//      own fix, now part of the one plan. The same guards hold (the giver's own minimum, the
//      taker's cap and free time), and a subject NOBODY on the faculty has taught never moves
//      (those are the Dean's own assignments: ITEP 205). The builder and the older callers leave
//      the flag off, so their results stay exactly as recorded.
// A move takes one class from a professor and gives it to another:
//   - the giver is the most-loaded professor above their own minimum, part-timers before
//     full-timers, and must stay AT OR ABOVE that minimum after the move;
//   - the taker (phases 1-2) is a professor below their minimum who has taught the subject (the
//     stored teaching history); in phase 3, the least-loaded part-timer who has taught it;
//   - every move must fit the taker's cap and their free weekday time (the caller's freeHoursOf
//     carries the Friday-for-Extension rule: a full-timer's Extension day is not free time).
// The 3 ITEP 205 classes never move: they are the Dean's. The builder counts them as fixed hours
// (never in the movable rows), and at run time no professor has ITEP 205 in their teaching history
// (that is why the Dean assigns it), so no taker ever qualifies — the unit tests pin both.
const round2 = (n) => Math.round(n * 100) / 100;

// balanceTeachingLoads({ assignments, professors, hoursOf, capOf, minOf, fixedHours, taughtBefore,
//                        freeHoursOf })
//   assignments    the movable class rows ({ sectionCode, subjectCode, descriptiveTitle, faculty });
//                  the callers pass the term's Major classes (never practicum, never the Dean's
//                  ITEP 205 classes at build time)
//   professors     every professor in the balance: [{ name, employmentType }] ('FULL_TIME' |
//                  'PART_TIME')
//   hoursOf(row, name)   weighted hours of that class for that professor (lecture + lab x factor)
//   capOf(name)          the teaching cap
//   minOf(name)          the minimum teaching load (utils/load.js minTeachingHoursOf's number)
//   fixedHours           Map name -> hours counted but never movable (Minors, practicum
//                        coordination; the builder adds ITEP 205 as Faculty's)
//   taughtBefore(name, row)  true when the professor taught the subject (the stored history)
//   freeHoursOf(name)    the professor's free weekday hours; a move must leave their class hours
//                        within it
// Returns { loadsBefore, loadsAfter, spreadBefore, spreadAfter, moves, assignments, cannotReach }:
//   - loadsBefore/After cover every professor; spreadBefore/After stay the PART-TIME spread (E6);
//   - each move is { subjectCode, descriptiveTitle, sectionCode, from, to, hoursFrom, hoursTo,
//     phase ('full-time-minimum' | 'part-time-minimum' | 'spread'), why };
//   - assignments is the list with the moved rows re-staffed (sourceKind 'balanced', with a
//     `source` sentence);
//   - cannotReach lists the professors still below their minimum, each with the reason no move
//     could raise them. Mutates nothing.
const balanceTeachingLoads = ({ assignments, professors, hoursOf, capOf, minOf, fixedHours = new Map(), taughtBefore, freeHoursOf = () => Infinity, includeNewSubjects = false }) => {
  const rows = (assignments || []).map(r => ({ ...r }));
  const everyone = (professors || []).map(p => ({ name: p.name, employmentType: p.employmentType === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME' }));
  const typeOf = new Map(everyone.map(p => [p.name, p.employmentType]));
  const isPT = (name) => typeOf.get(name) === 'PART_TIME';
  const partTimers = everyone.filter(p => p.employmentType === 'PART_TIME').map(p => p.name);

  const loadOf = () => {
    const loads = new Map(everyone.map(p => [p.name, round2(fixedHours.get(p.name) || 0)]));
    for (const r of rows) {
      if (!loads.has(r.faculty)) continue;
      loads.set(r.faculty, round2(loads.get(r.faculty) + hoursOf(r, r.faculty)));
    }
    return loads;
  };
  const spreadOf = (loads) => {
    const values = partTimers.map(name => loads.get(name) || 0);
    return values.length ? round2(Math.max(...values) - Math.min(...values)) : 0;
  };
  // A professor's class hours (for the free-time rule): the real class hours they hold, fixed included.
  const classHoursOf = (loads, name) => loads.get(name) || 0;

  const loadsBefore = loadOf();
  const spreadBefore = spreadOf(loadsBefore);
  const moves = [];

  const record = (row, donor, to, phase, why) => {
    // The giver's and the taker's hours before and after THIS move (the loads as the plan stands),
    // so a confirmation can list every move with its numbers (Phase 8 Part 6, decision 4).
    const loads = loadOf();
    const fromBefore = round2(loads.get(donor) || 0);
    const toBefore = round2(loads.get(to) || 0);
    moves.push({
      subjectCode: row.subjectCode,
      descriptiveTitle: row.descriptiveTitle,
      sectionCode: row.sectionCode,
      from: donor,
      to,
      hoursFrom: hoursOf(row, donor),
      hoursTo: hoursOf(row, to),
      fromBefore,
      fromAfter: round2(fromBefore - hoursOf(row, donor)),
      toBefore,
      toAfter: round2(toBefore + hoursOf(row, to)),
      taughtBefore: taughtBefore(to, row),
      phase,
      why
    });
    row.faculty = to;
    row.sourceKind = 'balanced';
    row.source = `balanced from ${donor} (${why}; the Dean can undo it with Change professor)`;
  };

  // The giver must stay at or above their own minimum after losing the row; a professor outside the
  // balance (a name not in `professors`) never gives.
  const canGive = (loads, donor, row) => typeOf.has(donor)
    && round2((loads.get(donor) || 0) - hoursOf(row, donor)) >= minOf(donor);
  // The taker must have taught the subject, stay within their cap and keep their free weekday time.
  // A row with no hours for the taker never moves (nothing to raise; it would loop forever).
  const canTake = (loads, name, row) => name !== row.faculty && hoursOf(row, name) > 0 && taughtBefore(name, row)
    && round2((loads.get(name) || 0) + hoursOf(row, name)) <= capOf(name)
    && round2(classHoursOf(loads, name) + hoursOf(row, name)) <= freeHoursOf(name);

  // ---- phases 1 and 2: raise the professors below their minimum --------------------------------
  // One move at a time: the most-under taker first; the giver is the most-loaded professor above
  // their own minimum, part-timers before full-timers (decision 2), ties by subject then section.
  const raisePhase = (employmentType, phase, why) => {
    for (;;) {
      const loads = loadOf();
      const takers = everyone
        .filter(p => p.employmentType === employmentType)
        .filter(p => minOf(p.name) > 0 && (loads.get(p.name) || 0) < minOf(p.name))
        .sort((a, b) => (minOf(b.name) - (loads.get(b.name) || 0)) - (minOf(a.name) - (loads.get(a.name) || 0)) || a.name.localeCompare(b.name));
      let moved = false;
      for (const taker of takers) {
        const candidates = rows
          .filter(row => canTake(loads, taker.name, row) && canGive(loads, row.faculty, row))
          .sort((a, b) => (Number(isPT(b.faculty)) - Number(isPT(a.faculty)))
            || ((loads.get(b.faculty) || 0) - (loads.get(a.faculty) || 0))
            || String(a.subjectCode).localeCompare(String(b.subjectCode))
            || String(a.sectionCode).localeCompare(String(b.sectionCode)));
        const row = candidates[0];
        if (!row) continue;
        record(row, row.faculty, taker.name, phase, why);
        moved = true;
        break; // re-measure before the next move
      }
      if (!moved) break;
    }
  };
  raisePhase('FULL_TIME', 'full-time-minimum', "the Secretary's minimum teaching load");
  raisePhase('PART_TIME', 'part-time-minimum', "the Secretary's minimum teaching load");

  // ---- phase 3: narrow the part-time spread (E6, unchanged but for the giver's own minimum) ----
  for (;;) {
    const loads = loadOf();
    const spread = spreadOf(loads);
    const ptLoads = partTimers.map(name => loads.get(name) || 0);
    if (!ptLoads.length) break;
    const maxLoad = Math.max(...ptLoads);
    // The most-loaded part-timers (ties in name order), the only donors the Dean's rule names.
    const donors = partTimers.filter(name => (loads.get(name) || 0) === maxLoad).sort();
    let best = null;
    for (const donor of donors) {
      for (const row of rows) {
        if (row.faculty !== donor || !canGive(loads, donor, row)) continue;
        // The least-loaded part-timer who has taught that subject before and can take it.
        const takers = partTimers.filter(name => canTake(loads, name, row))
          .sort((a, b) => (loads.get(a) || 0) - (loads.get(b) || 0) || a.localeCompare(b));
        const to = takers[0];
        if (!to) continue;
        const after = new Map(loads);
        after.set(donor, round2(after.get(donor) - hoursOf(row, donor)));
        after.set(to, round2((after.get(to) || 0) + hoursOf(row, to)));
        const newSpread = spreadOf(after);
        if (newSpread >= spread) continue;
        const key = [newSpread, row.subjectCode, row.sectionCode];
        if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
          best = { key, row, to, donor };
        }
      }
      if (best) break; // the most-loaded donor moved; re-measure before the next move
    }
    if (!best) break;
    record(best.row, best.donor, best.to, 'spread', "the Dean's equal part-time loads");
  }

  // ---- phase 4 ("Balance all", Phase 8 Part 6): a new subject for anyone still under ------------
  // The same loop shape as phases 1-2, but the taker need not have taught the subject; a class of a
  // subject nobody on the faculty has taught never moves (the Dean's own assignments, ITEP 205,
  // excluded structurally). Among the candidates, a class the taker HAS taught comes first, then
  // the giver with the most room above their own minimum.
  if (includeNewSubjects) {
    const anybodyTaught = (row) => everyone.some(p => taughtBefore(p.name, row));
    const canTakeNew = (loads, name, row) => name !== row.faculty && hoursOf(row, name) > 0 && anybodyTaught(row)
      && round2((loads.get(name) || 0) + hoursOf(row, name)) <= capOf(name)
      && round2(classHoursOf(loads, name) + hoursOf(row, name)) <= freeHoursOf(name);
    for (;;) {
      const loads = loadOf();
      const takers = everyone
        .filter(p => minOf(p.name) > 0 && (loads.get(p.name) || 0) < minOf(p.name))
        .sort((a, b) => (minOf(b.name) - (loads.get(b.name) || 0)) - (minOf(a.name) - (loads.get(a.name) || 0)) || a.name.localeCompare(b.name));
      let moved = false;
      for (const taker of takers) {
        const candidates = rows
          .filter(row => canTakeNew(loads, taker.name, row) && canGive(loads, row.faculty, row))
          .sort((a, b) => (Number(taughtBefore(taker.name, b)) - Number(taughtBefore(taker.name, a)))
            || (round2((loads.get(b.faculty) || 0) - hoursOf(b, b.faculty) - minOf(b.faculty)) - round2((loads.get(a.faculty) || 0) - hoursOf(a, a.faculty) - minOf(a.faculty)))
            || String(a.subjectCode).localeCompare(String(b.subjectCode))
            || String(a.sectionCode).localeCompare(String(b.sectionCode)));
        const row = candidates[0];
        if (!row) continue;
        record(row, row.faculty, taker.name, 'new-subject', "a new subject for the Secretary's minimum load");
        moved = true;
        break; // re-measure before the next move
      }
      if (!moved) break;
    }
  }

  // ---- the professors a minimum could not be reached for, each with the reason -----------------
  const loadsAfter = loadOf();
  const cannotReach = [];
  for (const p of everyone) {
    const min = minOf(p.name);
    const load = loadsAfter.get(p.name) || 0;
    if (!(min > 0 && load < min)) continue;
    // With includeNewSubjects every class of a subject SOMEBODY on the faculty has taught counts
    // (phase 4 may give a new subject); otherwise only the classes this professor has taught.
    const taught = includeNewSubjects
      ? rows.filter(row => row.faculty !== p.name && everyone.some(q => taughtBefore(q.name, row)))
      : rows.filter(row => row.faculty !== p.name && taughtBefore(p.name, row));
    let reason;
    if (!taught.length) {
      reason = includeNewSubjects
        ? 'No movable class can go to them: the remaining classes are of subjects nobody on the faculty has taught (the Dean assigns those herself).'
        : 'No movable class is one they have taught.';
    } else {
      const blockers = new Set();
      for (const row of taught) {
        if (round2(load + hoursOf(row, p.name)) > capOf(p.name)) blockers.add('their cap');
        else if (round2(classHoursOf(loadsAfter, p.name) + hoursOf(row, p.name)) > freeHoursOf(p.name)) blockers.add('their free weekday time');
        else blockers.add("its professor's own minimum");
      }
      reason = `No class ${includeNewSubjects ? '' : 'they have taught '}can move to them within ${[...blockers].join(', ')}.`;
    }
    cannotReach.push({ name: p.name, employmentType: p.employmentType, hours: load, min, underMin: round2(min - load), reason });
  }
  cannotReach.sort((a, b) => b.underMin - a.underMin || a.name.localeCompare(b.name));

  return { loadsBefore, loadsAfter, spreadBefore, spreadAfter: spreadOf(loadsAfter), moves, assignments: rows, cannotReach };
};

module.exports = { balanceTeachingLoads };
