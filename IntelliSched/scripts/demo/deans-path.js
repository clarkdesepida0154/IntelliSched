// The Dean's path through the gateway, shared by the rehearsal and the system check (Phase 8 Part 2:
// one copy, never two): sign in, the Readiness Check as the page shows it, the ITEP 205 assignments
// the Dean's planned way (Phase 8: Morris Virtus Faculty as an override with her reason; rank 1 would
// be an accept), one Generate run per seed with the saved version's own numbers, and the small helpers
// the records share. Extracted from sem2-rehearsal.js (Phase 4 Part 3; the Phase 8 path of Part 1).
const fs = require('fs');

const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const hoursBetween = (a, b) => (toMinutes(b) - toMinutes(a)) / 60;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (what, res) => new Error(`${what}: ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`);

// The gateway of a running demo (reads .demo-data/run.json's ports): call() and login().
const apiOf = (run) => {
  const API = `http://localhost:${run.ports.gateway}/api`;
  const call = async (method, route, { token, body } = {}) => {
    const res = await fetch(`${API}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  const login = async (who, email, password) => {
    if (!email || !password) throw new Error(`No ${who} login in the secrets file. Start the demo once to create it.`);
    const res = await call('POST', '/auth/login', { body: { username: email, password } });
    if (res.status !== 200) throw new Error(`${who} login: ${res.status} ${JSON.stringify(res.data)}`);
    return res.data.token;
  };
  return { API, call, login };
};

// The Readiness Check's lines, as the page shows them.
const readiness = async (call, token, TERM) => {
  const res = await call('POST', '/schedule/preflight', { token, body: TERM });
  if (res.status !== 200) throw fail('preflight', res);
  const r = res.data.report.readiness;
  return { verdict: r.verdict, toFix: r.toFix, lines: r.lines.map(l => ({ n: l.n, status: l.status, text: l.text })) };
};

// The Dean's planned choice for the ITEP 205 classes (the term file's notes; defense path I).
// Phase 8 Part 8: the names are in one style and the faculty board gives his initial ("Morris V.
// Faculty"); a term file of another era spells him "Morris Virtus Faculty", so he is found by surname.
const DEAN_CHOICE_NAME = 'FacultyMember';
const surnameOf = (name) => String(name || '').split(',')[0].replace(/[^A-Za-z\s-]/g, ' ').trim().split(/\s+/)
  .filter(t => t && !['JR', 'SR', 'II', 'III', 'IV', 'V'].includes(t.toUpperCase())).pop()?.toUpperCase() || '';
const sameProfessor = (a, b) => surnameOf(a) === surnameOf(b);
const DEAN_REASON = "The Dean's own choice, made live at the defense: Mr. Faculty teaches the multimedia subjects (2D and 3D design and animation, sound productions), the closest expertise to Multimedia Systems.";
// Phase 8 Part 6 (Step 8): the defense script's words when the College Secretary enters her choice.
const DEFENSE_REASON = "The Dean's decision";
// Phase 8 Part 7 (decision 4): the practice copy fills every other class the term file leaves for the
// Secretary, so Generate can run — the open Majors to the top-ranked professor the Overload Guardian
// allows, the open On-the-Job Training coordination to Faculty (the Dean's Part 1 answer: "Faculty for
// both WMAD sections") — each with these words. The term file and the defense data keep them open.
const PRACTICE_REASON = 'Practice copy only: the Secretary assigns this class by hand';
const PRACTICE_COORDINATOR = 'FacultyMember';
// The Dean's own classes: the ones nobody on the faculty taught (ITEP 205). A row without a reasonKind
// (a term file before Part 7, whose open list was ITEP 205 alone) is one too.
const isDeansClass = (u) => !u.reasonKind || u.reasonKind === 'nobody-taught';

// The term file's assignment counts by source: Part 7's copy of last year's Teachers' Program
// (`kept`), a Part 1–6 file's new-section rows and balance moves (0 in a Part 7 file), and the classes
// left for the Secretary — the Dean's (ITEP 205) and the others (BSIT 1D, the WMAD B coordination).
const assignmentsBySource = (term) => {
  const open = [...(term.unassignedMajors || []), ...(term.unassignedMinors || []), ...(term.unassignedCoordinations || [])];
  return {
    kept: [...(term.assignments || []), ...(term.minorAssignments || []), ...(term.practicumCoordinators || [])].filter(a => (a.sourceKind || 'kept') === 'kept').length,
    newSection: [...(term.assignments || []), ...(term.practicumCoordinators || [])].filter(a => a.sourceKind === 'new-section').length,
    balanced: (term.assignments || []).filter(a => a.sourceKind === 'balanced').length,
    leftForTheDean: open.filter(isDeansClass).length,
    leftForTheSecretary: open.length,
    openByReason: open.reduce((acc, u) => ({ ...acc, [u.reasonKind || 'nobody-taught']: (acc[u.reasonKind || 'nobody-taught'] || 0) + 1 }), {})
  };
};

// Assign Faculty for the classes the term file leaves open, exactly as the Recommendations page sends
// it. The Dean's classes (ITEP 205): the ranking once per subject; her planned choice as an accept
// (rank 1) or an override with her reason. Phase 8 Part 7 (decision 4, the practice copy only): every
// other open Major goes to the top-ranked professor the Overload Guardian allows (rank 1 an accept, a
// lower rank an override, both with PRACTICE_REASON), and the open coordinations (the term file's
// unassignedCoordinations) to Faculty with the same words. With no candidates from the ranking service,
// the professor with the most free teaching hours and a matching specialization. Returns the record rows.
// `dean` is the token that assigns (Phase 8 Part 8: the one account, the Dean's); the defense script's
// words for the Dean's choice are `reason` "The Dean's decision" (DEFENSE_REASON).
const assignUnassignedMajors = async ({ call, dean, TERM, term, log = () => {}, reason = DEAN_REASON }) => {
  const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const sections = (await call('GET', '/sections', { token: dean })).data.filter(s => s.isActive);
  const catalog = (await call('GET', '/catalog', { token: dean })).data;
  const faculty = (await call('GET', '/faculty', { token: dean })).data.filter(f => f.isActive);
  const locksNow = async () => (await call('GET', `/schedule/locks?${termQuery}`, { token: dean })).data.locks || [];
  const assignments = [];
  const bySubject = new Map();
  for (const u of term.unassignedMajors || []) {
    const section = sections.find(s => s.sectionCode === u.sectionCode);
    const subject = catalog.find(c => c.subjectCode === u.subjectCode && c.descriptiveTitle === u.descriptiveTitle);
    if (!section || !subject) throw new Error(`${u.subjectCode} (${u.sectionCode}): ${!section ? 'no section' : 'no catalog subject'}`);
    const locks = await locksNow();
    const held = locks.find(l => l.sectionCode === section.sectionCode && String(l.subjectId) === String(subject._id));
    if (held) {
      log(`${subject.subjectCode} (${section.sectionCode}) already has ${held.facultyName}; left as it is`);
      assignments.push({ section: section.sectionCode, subject: subject.subjectCode, chosen: held.facultyName, rank: null, alreadyAssigned: true });
      continue;
    }
    // The ranking once per subject (the same ranking the Recommendations page shows for it).
    if (!bySubject.has(String(subject._id))) {
      const rec = await call('POST', '/schedule/recommendations', { token: dean, body: { ...TERM, subjectId: subject._id, subjectCode: subject.subjectCode } });
      bySubject.set(String(subject._id), rec.status === 200 ? (rec.data.candidates || []) : { error: `${rec.status} ${rec.data?.message || ''}` });
    }
    const ranking = bySubject.get(String(subject._id));
    const candidates = Array.isArray(ranking) ? ranking.filter(c => c.id && c.id !== 'FAC-TBA') : [];
    const entry = { section: section.sectionCode, subject: subject.subjectCode, recommendations: candidates.slice(0, 8).map((c, i) => ({ rank: i + 1, name: c.name })), tried: [], chosen: null, rank: null };
    if (candidates.length && !isDeansClass(u)) {
      // Part 7, the practice copy: the top-ranked professor the Overload Guardian allows, tried in
      // the ranking's order (a refusal moves on to the next).
      const top1 = candidates[0];
      for (const [index, cand] of candidates.entries()) {
        const rank = index + 1;
        const res = await call('POST', '/schedule/lock', {
          token: dean,
          body: {
            ...TERM, subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id,
            facultyId: cand.id, facultyName: cand.name, classType: 'ALL', units: subject.units,
            decision: rank === 1 ? 'accept' : 'override',
            originalFacultyId: top1.id, mlTop1Faculty: top1.name, mlTop1Score: top1.score ?? null,
            reason: PRACTICE_REASON
          }
        });
        if (res.status === 200) {
          Object.assign(entry, { chosen: cand.name, rank, decision: rank === 1 ? 'accept' : 'override', practiceOnly: true });
          break;
        }
        entry.tried.push({ rank, name: cand.name, status: res.status, code: res.data?.code || null, message: res.data?.message || '' });
      }
    }
    if (entry.chosen) {
      // assigned above (Part 7, the practice copy)
    } else if (candidates.length && isDeansClass(u)) {
      // Phase 8 (the defense path, I): the Dean sees the weak ranking and assigns Mr. Faculty anyway,
      // her own decision, as an override the system learns from; the Overload Guardian confirms he
      // fits his cap (a refusal here fails the run loudly).
      const top1 = candidates[0];
      const index = candidates.findIndex(c => sameProfessor(c.name, DEAN_CHOICE_NAME));
      const prof = faculty.find(f => sameProfessor(f.name, DEAN_CHOICE_NAME));
      const cand = index >= 0 ? candidates[index] : (prof ? { id: prof.facultyId, name: prof.name, score: null } : null);
      if (!cand) throw new Error(`${subject.subjectCode} (${section.sectionCode}): ${DEAN_CHOICE_NAME} is not an active professor.`);
      const rank = index >= 0 ? index + 1 : null;
      const res = await call('POST', '/schedule/lock', {
        token: dean,
        body: {
          ...TERM, subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id,
          facultyId: cand.id, facultyName: cand.name, classType: 'ALL', units: subject.units,
          decision: rank === 1 ? 'accept' : 'override',
          originalFacultyId: top1.id, mlTop1Faculty: top1.name, mlTop1Score: top1.score ?? null,
          ...(rank === 1 ? {} : { reason }),
          telemetry: {
            selectedSemanticScore: Number.isFinite(Number(cand.score)) ? Number((cand.score / 100).toFixed(4)) : null,
            rejectedSemanticScore: rank === 1 ? null : (Number.isFinite(Number(top1.score)) ? Number((top1.score / 100).toFixed(4)) : null)
          }
        }
      });
      if (res.status !== 200) throw new Error(`${subject.subjectCode} (${section.sectionCode}): the Dean's choice ${cand.name} was refused (${res.data?.message || res.status}).`);
      entry.chosen = cand.name;
      entry.rank = rank;
      entry.decision = rank === 1 ? 'accept' : 'override';
      entry.deansChoice = true;
    } else {
      // No candidates from the ranking service (or, Part 7, every ranked one over the cap): the
      // professor with the most free teaching hours who has a matching specialization (the subject's
      // title words against the profile's expertise).
      if (!candidates.length) entry.rankingUnavailable = ranking?.error || 'no candidates';
      const loads = (await call('GET', `/schedule/loads?${termQuery}`, { token: dean })).data;
      const loadRows = Array.isArray(loads) ? loads : loads?.loads || loads?.faculty || [];
      const words = `${subject.descriptiveTitle} ${subject.subjectDescription || ''}`.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 5);
      const matching = faculty.filter(f => {
        const text = [f.major, ...(f.specializations || []), ...(f.pastSubjectsTaught || []), f.engine1Profile || ''].join(' ').toLowerCase();
        return words.some(w => text.includes(w));
      });
      const remainingOf = (f) => { const row = loadRows.find(r => String(r.facultyRef) === String(f._id) || r.facultyId === f.facultyId); return Number.isFinite(row?.remaining) ? row.remaining : (f.teachingCapHours ?? 0); };
      const pool = (matching.length ? matching : faculty).filter(f => !entry.tried.some(t => t.name === f.name)).sort((a, b) => remainingOf(b) - remainingOf(a));
      const why = candidates.length ? 'every ranked professor is over the teaching cap' : 'no recommendations from the ranking service';
      for (const f of pool) {
        const res = await call('POST', '/schedule/lock', { token: dean, body: { ...TERM, subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id, facultyId: f.facultyId, facultyName: f.name, classType: 'ALL', units: subject.units, reason: `${isDeansClass(u) ? '' : `${PRACTICE_REASON}. `}${why[0].toUpperCase()}${why.slice(1)}: the professor with the most free teaching hours and a matching specialization` } });
        if (res.status === 200) { entry.chosen = f.name; entry.rank = null; entry.fallback = matching.length ? 'most free hours, matching specialization' : 'most free hours (no matching specialization found)'; entry.practiceOnly = !isDeansClass(u); break; }
        entry.tried.push({ rank: null, name: f.name, status: res.status, code: res.data?.code || null, message: res.data?.message || '' });
      }
      if (!entry.chosen) throw new Error(`${subject.subjectCode} (${section.sectionCode}): no professor within the teaching cap.`);
    }
    log(`${entry.subject} (${entry.section}) -> ${entry.chosen}${entry.rank ? ` (rank ${entry.rank}, ${entry.decision}${entry.practiceOnly ? ', practice copy only' : ''})` : entry.deansChoice ? " (the Dean's choice, override)" : ` (${entry.fallback})`}${entry.tried.length ? `; refused first: ${entry.tried.map(t => `${t.name} (${t.code || t.status})`).join(', ')}` : ''}`);
    assignments.push(entry);
  }
  // Part 7: the open On-the-Job Training coordinations (BSIT 4B WMAD) to Faculty, the practice copy only.
  assignments.push(...await assignOpenCoordinations({ call, dean, TERM, term, log, sections, catalog, faculty, locksNow }));
  return assignments;
};

// Phase 8 Part 7 (decision 4): the term file's open coordinations (unassignedCoordinations) go to
// PRACTICE_COORDINATOR through Assign Faculty's own route (the Overload Guardian checks the 6 hours),
// with PRACTICE_REASON. A coordination already held is left as it is.
const assignOpenCoordinations = async ({ call, dean, TERM, term, log = () => {}, sections, catalog, faculty, locksNow }) => {
  const rows = [];
  for (const u of term.unassignedCoordinations || []) {
    const section = sections.find(s => s.sectionCode === u.sectionCode);
    const subject = catalog.find(c => c.subjectCode === u.subjectCode && c.descriptiveTitle === u.descriptiveTitle);
    if (!section || !subject) throw new Error(`${u.subjectCode} (${u.sectionCode}): ${!section ? 'no section' : 'no catalog subject'}`);
    const held = (await locksNow()).find(l => l.sectionCode === section.sectionCode && String(l.subjectId) === String(subject._id));
    if (held) {
      log(`${subject.subjectCode} (${section.sectionCode}) already has the coordinator ${held.facultyName}; left as it is`);
      rows.push({ section: section.sectionCode, subject: subject.subjectCode, chosen: held.facultyName, rank: null, alreadyAssigned: true, coordination: true });
      continue;
    }
    const prof = faculty.find(f => sameProfessor(f.name, PRACTICE_COORDINATOR));
    if (!prof) throw new Error(`${subject.subjectCode} (${section.sectionCode}): ${PRACTICE_COORDINATOR} is not an active professor.`);
    const res = await call('POST', '/schedule/lock', {
      token: dean,
      body: { ...TERM, subjectId: subject._id, subjectCode: subject.subjectCode, sectionCode: section.sectionCode, sectionId: section._id, facultyId: prof.facultyId, facultyName: prof.name, classType: 'ALL', units: subject.units, reason: PRACTICE_REASON }
    });
    if (res.status !== 200) throw new Error(`${subject.subjectCode} (${section.sectionCode}): the coordinator ${prof.name} was refused (${res.data?.message || res.status}).`);
    log(`${subject.subjectCode} (${section.sectionCode}) -> ${prof.name} (the coordination, practice copy only)`);
    rows.push({ section: section.sectionCode, subject: subject.subjectCode, chosen: prof.name, rank: null, coordination: true, practiceOnly: true });
  }
  return rows;
};

// How many CCS classes (with a professor) and labs meet at once, at most, over the week.
const atOnce = (classes) => {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const c of classes) {
    if (!c.day || !c.startTime || !c.endTime) continue;
    for (let m = toMinutes(c.startTime); m < toMinutes(c.endTime); m += 30) {
      bump(`${c.day}|${m}|all`);
      if (c.classType === 'LAB') bump(`${c.day}|${m}|lab`);
    }
  }
  const max = (kind) => Math.max(0, ...[...counts.entries()].filter(([k]) => k.endsWith(`|${kind}`)).map(([, n]) => n));
  return { classes: max('all'), labs: max('lab') };
};

// One Generate run (the seed as the Dean, as on "Advanced"; Phase 8 Part 8: one account), followed to its end, with the
// saved version's own numbers: the whole-version check, the outputs' counts, the TBA rooms, Saturday
// blocks, early starts, and the most classes at once per week group. The same row the rehearsal records.
const generateSeed = async ({ call, dean, TERM, seed, log = () => {}, pollMs = 2000 }) => {
  const termQuery = `academicYear=${TERM.academicYear}&semester=${TERM.semester}`;
  const wallStart = Date.now();
  const start = await call('POST', '/schedule/generate', { token: dean, body: { targetAcademicYear: TERM.academicYear, targetSemester: TERM.semester, hyperparameters: { seed } } });
  if (start.status !== 202) throw fail('generate', start);
  log(`run ${start.data.runId} started with seed ${seed}`);
  let runDoc;
  for (;;) {
    await sleep(pollMs);
    runDoc = (await call('GET', `/schedule/runs/${start.data.runId}`, { token: dean })).data.run;
    if (['done', 'failed', 'cancelled'].includes(runDoc.status)) break;
  }
  const wallMs = Date.now() - wallStart;
  const row = {
    seed, status: runDoc.status, message: runDoc.message, version: runDoc.version, scheduleId: runDoc.scheduleId,
    runtimeMs: runDoc.runtimeMs ?? runDoc.gaStats?.runtimeMs ?? null, wallMs,
    timeToFirstFeasibleMs: runDoc.gaStats?.timeToFirstFeasibleMs ?? null,
    generations: runDoc.gaStats?.generations ?? null,
    conflicts: runDoc.hard?.total ?? runDoc.gaStats?.finalHard ?? null,
    // A failed run's `hard` IS the per-rule map ({ HC3_ROOM_CLASH: 10, ... }).
    conflictsByRule: runDoc.hard && typeof runDoc.hard === 'object' ? runDoc.hard : null,
    tbaRoomsRequested: runDoc.tbaRooms || null, classesInTbaRooms: runDoc.classesInTbaRooms ?? null, tbaRoomsUsed: runDoc.tbaRoomsUsed || null,
    saturdayBlocks: runDoc.saturdayClasses ?? null, noRoomClasses: runDoc.noRoomClasses ?? null,
    // Phase 8 Part 5 (decision 2c): the plain cause a failed run names while the rooms sit above
    // the headroom level, and (decision 1) the saved schedule's single-class days with last year's.
    cause: runDoc.cause || null,
    singleClassDays: runDoc.singleClassDays || runDoc.gaStats?.singleClassDays || null,
    lastYearSingleClassDays: runDoc.lastYearSingleClassDays || null
  };
  if (runDoc.status === 'done' && runDoc.scheduleId) {
    const out = (await call('GET', `/schedule/outputs?${termQuery}&scheduleId=${runDoc.scheduleId}`, { token: dean })).data;
    const classes = out.classes || [];
    const ccs = classes.filter(c => c.facultyRef);
    const check = await call('POST', '/schedule/validate', { token: dean, body: { scheduleId: runDoc.scheduleId } });
    const violations = check.data?.violations || [];
    const byCode = {};
    violations.forEach(v => { byCode[v.code] = (byCode[v.code] || 0) + 1; });
    Object.assign(row, {
      classes: { total: classes.length, ccs: ccs.length, ccsHours: Math.round(ccs.reduce((a, c) => a + hoursBetween(c.startTime, c.endTime), 0) * 10) / 10, labs: ccs.filter(c => c.classType === 'LAB').length },
      tbaRequest: out.tbaRequest ? { lab: out.tbaRequest.labRooms, lec: out.tbaRequest.lecRooms, classes: out.tbaRequest.classCount } : null,
      classesInTbaRooms: classes.filter(c => c.roomKind === 'TBA_ROOM').length,
      saturdayBlocks: classes.filter(c => c.day === 'Saturday' && !c.isFixed).length,
      startsBefore8: classes.filter(c => !c.isFixed && c.startTime && toMinutes(c.startTime) < 8 * 60).length,
      lunchFailures: byCode.HC1_LUNCH || 0,
      roomClashes: byCode.HC3_ROOM_CLASH || 0,
      checkedConflicts: check.data?.hardTotal ?? null,
      conflictsByRule: byCode,
      atOnce: atOnce(ccs),
      // Phase 8 (the odd/even weeks): the most classes at once within each week group — what a
      // room really holds in one of its weeks (a class without a group meets every week, so it
      // counts in both).
      atOncePerGroup: {
        odd: atOnce(ccs.filter(c => !c.weekGroup || c.weekGroup === 'ODD')),
        even: atOnce(ccs.filter(c => !c.weekGroup || c.weekGroup === 'EVEN'))
      },
      onlineClasses: classes.filter(c => c.isOnline).length
    });
  }
  return row;
};

// Last year's manual 2nd semester, from the transcribed Teachers' Programs (CCS faculty's classes for
// CCS sections: the rows with a subject code and a program, OJT left out; as SECOND_SEM_2025_26_NOTES.md).
// Phase 8 Part 5 adds the single-class days through the server's own reader
// (utils/lastYearSchedule.js: a proper CSV parse — some titles hold commas — and the class rows by
// kind, so a row printed without a program, like Faculty's Wednesday lab, still counts a day).
const { singleClassDaysOf } = require('../../server/src/utils/lastYearSchedule');
const lastYearStats = (csvFile, semesterLabel) => {
  const rows = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/);
  const head = rows[0].split(',');
  const recs = rows.slice(1).map(r => Object.fromEntries(head.map((k, i) => [k, r.split(',')[i]])));
  const classes = recs.filter(r => r.semester === semesterLabel && r.level === 'UNDERGRAD' && r.code && r.program && r.kind !== 'OJT');
  const asClasses = classes.map(r => ({ day: r.day, startTime: r.start, endTime: r.end, classType: r.kind === 'LAB' ? 'LAB' : 'LEC' }));
  return {
    source: `docs/data/past_class_blocks.csv, ${semesterLabel} (CCS faculty, CCS sections, OJT left out)`,
    meetings: classes.length,
    hours: Math.round(classes.reduce((a, r) => a + Number(r.hours), 0) * 10) / 10,
    labs: classes.filter(r => r.kind === 'LAB').length,
    professors: new Set(classes.map(r => r.faculty)).size,
    sections: new Set(classes.map(r => r.section_as_printed)).size,
    saturdayBlocks: classes.filter(r => r.day === 'Saturday').length,
    startsBefore8: classes.filter(r => toMinutes(r.start) < 8 * 60).length,
    atOnce: atOnce(asClasses),
    // Phase 8 Part 5: { professors, sections } — weekdays with exactly one class row.
    singleClassDays: singleClassDaysOf(semesterLabel, csvFile),
    roomsPrinted: false
  };
};

module.exports = {
  apiOf, readiness, assignUnassignedMajors, assignOpenCoordinations, assignmentsBySource, isDeansClass, generateSeed, atOnce, lastYearStats,
  toMinutes, hoursBetween, sleep, fail, DEAN_CHOICE_NAME, DEAN_REASON, DEFENSE_REASON, PRACTICE_REASON, PRACTICE_COORDINATOR
};
