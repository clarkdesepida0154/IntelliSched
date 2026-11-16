import { useCallback, useEffect, useRef, useState } from 'react';
import useDataChanges from '../../hooks/useDataChanges';
import { Scale, ChevronDown, Loader2, AlertCircle, CheckCircle2, ArrowRight } from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import usePermission from '../../hooks/usePermission';
import { numberText } from '../../utils/scheduleDisplay';
import { likelihoodOf } from '../../utils/likelihood';
import HelpTip from '../ui/HelpTip';

// The Teaching loads panel (Phase 8 Step 4; Part 4 grew it from "Part-time loads"), under Assign
// Faculty's tabs: every professor's teaching hours against their RANGE (the minimum to the cap),
// the part-time average and spread, and "Balance all" (Phase 8 Part 6, decision 4) — ONE plan that
// brings everyone into their range where possible: first the moves of subjects the taker has
// taught (full-timers below their minimum, then part-timers, then the equal part-time loads), then
// a new subject for anyone still under ("Not taught before", marked). The confirmation lists every
// move with a checkbox (all ticked); Apply saves the ticked moves one by one through the
// Recommendations' own assign route (POST /schedule/lock) as overrides with their reasons, so the
// Overload Guardian re-checks each one and the system learns from the decisions. A professor whose
// minimum still cannot be reached is named with the reason. Collapsed by default; the loads are
// read when it is opened.
const h = (n) => `${numberText(n)} h`;
const EMPLOYMENT_LABELS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
// The saved reason of one applied move (the Overload Guardian re-checks it; Engine 4 learns from it).
const reasonOfMove = (m) => (m.phase === 'new-subject'
  ? `A new subject for the Secretary's minimum load: ${m.subjectCode} (${m.sectionCode}) moved from ${m.from.name} to ${m.to.name}.`
  : `Teaching loads balance (${m.why || "the Dean's equal part-time loads"}): moved from ${m.from.name}. The Dean can undo it by assigning the class back.`);

export default function PartTimeLoadsPanel() {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  const assignPermission = usePermission('faculty.assign');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: 'idle', data: null, error: '' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Phase 8 Part 6 ("Balance all"): the confirmation's checkboxes — the move indexes still ticked.
  const [tickedMoves, setTickedMoves] = useState(() => new Set());
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState('');
  const [applyError, setApplyError] = useState('');
  // Phase 8 Part 5 (decision 3): one offered class at a time — never automatic.
  const [confirmOfferKey, setConfirmOfferKey] = useState('');
  const [applyingOffer, setApplyingOffer] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading', data: null, error: '' });
    setApplied('');
    setApplyError('');
    setConfirmOpen(false);
    try {
      const res = await api.get('/schedule/part-time-loads', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } });
      setState({ status: 'ready', data: res.data, error: '' });
    } catch (err) {
      setState({ status: 'error', data: null, error: err.response?.data?.message || err.message });
    }
  }, [activeAcademicYear, activeSemesterNumber]);

  // Phase 8 Part 8 (decision 6): live updates — an assignment anywhere (the table above, another tab,
  // another user) reads the loads again while the panel is open, quietly (what is shown stays until the
  // answer lands); never under an open confirmation or while a move is being applied.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = applying || Boolean(applyingOffer) || confirmOpen || Boolean(confirmOfferKey); }, [applying, applyingOffer, confirmOpen, confirmOfferKey]);
  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const res = await api.get('/schedule/part-time-loads', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } });
      setState(prev => (prev.status === 'idle' ? prev : { status: 'ready', data: res.data, error: '' }));
    } catch { /* the panel keeps what it shows */ }
  }, [activeAcademicYear, activeSemesterNumber]);
  useDataChanges(['assignments', 'faculty', 'policy', 'outsideTeachers'], refresh, { enabled: state.status !== 'idle', ignoreOrigin: 'teaching-loads' });

  const data = state.data;
  const moves = data?.suggestion?.moves || [];
  const cannotReach = data?.cannotReach || [];

  // Each TICKED move is the assign route's own call, as an override with that move's reason; an
  // unticked move is never sent (Phase 8 Part 6, decision 4). The Overload Guardian re-checks each.
  const applyBalance = async () => {
    const chosen = moves.filter((m, i) => tickedMoves.has(i));
    if (!chosen.length || applying) return;
    setApplying(true);
    setApplyError('');
    const done = [];
    try {
      for (const m of chosen) {
        await api.post('/schedule/lock', {
          academicYear: activeAcademicYear,
          semester: activeSemesterNumber,
          subjectId: m.subjectId,
          subjectCode: m.subjectCode,
          sectionCode: m.sectionCode,
          facultyId: m.to.facultyId,
          facultyName: m.to.name,
          classType: 'ALL',
          decision: 'override',
          originalFacultyId: m.from.facultyId,
          reason: reasonOfMove(m)
        }, { origin: 'teaching-loads' });
        done.push(`${m.subjectCode} (${m.sectionCode}) to ${m.to.name}`);
      }
      setApplied(`Balance applied: ${done.join('; ')}.`);
      await load();
      setApplied(`Balance applied: ${done.join('; ')}.`);
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      setApplyError(`${done.length ? `Applied so far: ${done.join('; ')}. ` : ''}The next move was refused: ${message} Nothing else was changed; press "Balance all" again for a fresh plan.`);
      await load();
      setApplyError(`${done.length ? `Applied so far: ${done.join('; ')}. ` : ''}The next move was refused: ${message} Nothing else was changed.`);
    } finally {
      setApplying(false);
      setConfirmOpen(false);
    }
  };

  const applyBlocked = !assignPermission.allowed ? assignPermission.reason
    : applying ? 'Applying…' : '';

  // Phase 8 Part 5 (decision 3): apply ONE offered class as the Dean's override, with its reason
  // ("A new subject for the Secretary's minimum load"); the Overload Guardian re-checks it and the
  // system learns from the decision. Nothing is applied without this click.
  const applyOffer = async (c, o, key) => {
    if (applyingOffer) return;
    setApplyingOffer(key);
    setApplyError('');
    setApplied('');
    try {
      await api.post('/schedule/lock', {
        academicYear: activeAcademicYear,
        semester: activeSemesterNumber,
        subjectId: o.subjectId,
        subjectCode: o.subjectCode,
        sectionId: o.sectionId,
        sectionCode: o.sectionCode,
        facultyId: c.taker?.facultyId,
        facultyName: c.name,
        classType: 'ALL',
        decision: 'override',
        originalFacultyId: o.from.facultyId,
        reason: `A new subject for the Secretary's minimum load: ${o.subjectCode} (${o.sectionCode}) moved from ${o.from.name} to ${c.name}.`
      }, { origin: 'teaching-loads' });
      setApplied(`${o.subjectCode} (${o.sectionCode}) moved from ${o.from.name} to ${c.name}, saved as your decision with its reason.`);
      await load();
      setApplied(`${o.subjectCode} (${o.sectionCode}) moved from ${o.from.name} to ${c.name}, saved as your decision with its reason.`);
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      setApplyError(`The move was refused: ${message} Nothing was changed.`);
      await load();
      setApplyError(`The move was refused: ${message} Nothing was changed.`);
    } finally {
      setApplyingOffer('');
      setConfirmOfferKey('');
    }
  };

  return (
    <section data-testid="pt-loads-panel" className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden mb-6">
      <h3>
        <button
          type="button"
          data-testid="pt-loads-toggle"
          aria-expanded={open}
          aria-controls="pt-loads-body"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && state.status === 'idle') load();
          }}
          className="w-full flex items-center justify-between gap-3 p-5 md:px-8 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="p-2 bg-cyan-500/10 rounded-xl"><Scale size={18} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" /></span>
            <span className="min-w-0">
              <span className="block text-base font-black text-slate-900 dark:text-white">Teaching loads</span>
              <span className="block text-xs text-slate-600 dark:text-slate-400">Hours against each range.</span>
            </span>
          </span>
          <ChevronDown size={18} className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h3>
      <div id="pt-loads-body" hidden={!open} className="px-5 md:px-8 pb-6 border-t border-slate-200 dark:border-slate-800">
        {state.status === 'loading' && (
          <p data-testid="pt-loads-loading" role="status" className="flex items-center gap-2 pt-4 text-xs font-bold text-slate-600 dark:text-slate-300">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Reading the teaching loads…
          </p>
        )}
        {state.status === 'error' && (
          <p data-testid="pt-loads-error" role="alert" className="flex items-start gap-2 pt-4 text-xs font-bold text-red-700 dark:text-red-400">
            <AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" />
            The loads could not be read ({state.error}). <button type="button" onClick={load} className="underline cursor-pointer">Try again</button>
          </p>
        )}
        {data && (
          <div className="pt-4 space-y-4">
            <table data-testid="pt-loads-table" className="w-full text-xs border-separate border-spacing-0">
              <caption className="sr-only">Every professor&apos;s teaching hours against their range (minimum to cap)</caption>
              <thead>
                <tr>
                  <th scope="col" className="text-left font-bold text-slate-600 dark:text-slate-300 pb-1.5">Professor</th>
                  <th scope="col" className="text-right font-bold text-slate-600 dark:text-slate-300 pb-1.5">Teaching hours (of minimum–cap)</th>
                </tr>
              </thead>
              <tbody>
                {(data.professors || data.partTimers || []).map(p => (
                  <tr key={p.facultyRef} data-testid={`pt-loads-row-${p.facultyId}`}>
                    <th scope="row" className="text-left font-bold text-slate-800 dark:text-slate-100 py-1 pr-3">
                      {p.name}
                      {p.employmentType && <span className="ml-1.5 font-normal text-slate-500 dark:text-slate-400">{EMPLOYMENT_LABELS[p.employmentType]}</span>}
                    </th>
                    <td className="text-right py-1 text-slate-700 dark:text-slate-200">
                      {Number.isFinite(Number(p.min)) ? `${h(p.hours)} of ${numberText(p.min)}–${h(p.cap)}` : `${h(p.hours)} of ${h(p.cap)}`}
                      {Number(p.underMin) > 0 && (
                        <b data-testid={`pt-loads-under-${p.facultyId}`} className="ml-1.5 text-amber-700 dark:text-amber-400">· {h(p.underMin)} under</b>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p data-testid="pt-loads-summary" className="text-xs text-slate-700 dark:text-slate-200">
              Part-time average <b>{h(data.average)}</b> · spread (most to least) <b>{h(data.spread)}</b>
            </p>
            <HelpTip label="how the hours are counted" testid="pt-loads-note"><span data-testid="pt-loads-note-body">{data.note}</span></HelpTip>

            {cannotReach.length > 0 && (
              <div data-testid="pt-loads-cannot-reach" className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/5 p-3">
                <p className="text-xs font-bold text-amber-900 dark:text-amber-200 mb-1">
                  {cannotReach.length === 1 ? 'One minimum cannot be reached' : `${cannotReach.length} minimums cannot be reached`}
                </p>
                <ul className="space-y-2">
                  {cannotReach.map(c => (
                    <li key={c.name} data-testid={`pt-loads-cannot-${c.name.replace(/\s+/g, '-')}`} className="text-[11px] text-amber-900 dark:text-amber-200">
                      <b>{c.name}</b> stays at {h(c.hours)} of {h(c.min)} ({h(c.underMin)} under): {c.reason}
                      {(c.offers || []).length > 0 && (
                        <div data-testid={`pt-loads-offers-${c.name.replace(/\s+/g, '-')}`} className="mt-1.5 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-white/60 dark:bg-black/20 p-2 space-y-1.5">
                          <p className="font-bold">Classes that could move to {c.name} (a new subject, the Secretary&apos;s own fix):</p>
                          {c.offers.slice(0, 6).map((o) => {
                            const key = `${c.name}|${o.subjectId}|${o.sectionId}`;
                            const likelihood = likelihoodOf(o.likelihood);
                            return (
                              <div key={key} data-testid={`pt-loads-offer-${o.subjectCode.replace(/\s+/g, '-')}-${o.sectionCode.replace(/\s+/g, '-')}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                <b>{o.subjectCode}</b> {o.descriptiveTitle} for <b>{o.sectionCode}</b> ({h(o.hours)})
                                {o.taughtBefore === false && (
                                  <span data-testid={`pt-loads-offer-new-${o.subjectCode.replace(/\s+/g, '-')}-${o.sectionCode.replace(/\s+/g, '-')}`} className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-200/70 dark:bg-amber-500/20">Not taught before</span>
                                )}
                                {likelihood && <span className="text-amber-800 dark:text-amber-300">Likelihood {likelihood.text}</span>}
                                <span>— from {o.from.name}, who stays at {h(o.giverHoursAfter)} (minimum {numberText(o.giverMin)}).</span>
                                {confirmOfferKey === key ? (
                                  <span className="flex items-center gap-1.5">
                                    <span className="font-bold">Save as your decision, with the reason recorded?</span>
                                    <button type="button" data-testid={`pt-loads-offer-confirm-${o.subjectCode.replace(/\s+/g, '-')}-${o.sectionCode.replace(/\s+/g, '-')}`} disabled={Boolean(applyingOffer)} onClick={() => applyOffer(c, o, key)} className="px-2 py-0.5 rounded-md text-[10px] font-bold text-white bg-cyan-700 hover:bg-cyan-600 cursor-pointer disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-cyan-500">
                                      {applyingOffer === key ? 'Saving…' : 'Yes, move it'}
                                    </button>
                                    <button type="button" disabled={Boolean(applyingOffer)} onClick={() => setConfirmOfferKey('')} className="px-2 py-0.5 rounded-md text-[10px] font-bold cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-cyan-500">Keep it</button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    data-testid={`pt-loads-offer-apply-${o.subjectCode.replace(/\s+/g, '-')}-${o.sectionCode.replace(/\s+/g, '-')}`}
                                    disabled={Boolean(applyBlocked || applyingOffer)}
                                    title={applyBlocked || undefined}
                                    onClick={() => setConfirmOfferKey(key)}
                                    className="px-2 py-0.5 rounded-md text-[10px] font-bold text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/40 hover:bg-cyan-50 dark:hover:bg-cyan-500/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-cyan-500"
                                  >
                                    Apply
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          {c.offers.length > 6 && <p data-testid={`pt-loads-offers-more-${c.name.replace(/\s+/g, '-')}`}>…and {c.offers.length - 6} more could move; the top of the list comes first (the ranking&apos;s Likelihood, then the giver&apos;s hours above their minimum).</p>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {data.offersNote && <p className="mt-1.5 text-[11px] text-amber-900/80 dark:text-amber-200/80 leading-snug">{data.offersNote}</p>}
              </div>
            )}

            {applied && (
              <p data-testid="pt-loads-applied" role="status" className="flex items-start gap-2 text-xs font-bold text-green-700 dark:text-green-400">
                <CheckCircle2 size={14} className="mt-px shrink-0" aria-hidden="true" /> {applied}
              </p>
            )}
            {applyError && (
              <p data-testid="pt-loads-apply-error" role="alert" className="flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
                <AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" /> {applyError}
              </p>
            )}

            {data.suggestion ? (
              <div data-testid="pt-loads-suggestion" className="rounded-2xl border border-cyan-200 dark:border-cyan-500/30 bg-cyan-50/60 dark:bg-cyan-500/5 p-4 space-y-3">
                <p className="text-xs font-black text-slate-900 dark:text-white">Balance all: {data.suggestion.moves.length} move{data.suggestion.moves.length === 1 ? '' : 's'} bring{data.suggestion.moves.length === 1 ? 's' : ''} everyone into their range where possible</p>
                <ul className="space-y-1.5">
                  {data.suggestion.moves.map((m, i) => (
                    <li key={i} data-testid={`pt-loads-move-${i}`} className="flex flex-wrap items-center gap-1.5 text-xs text-slate-800 dark:text-slate-100">
                      <b>{m.subjectCode}</b> {m.descriptiveTitle} for <b>{m.sectionCode}</b>:
                      <span>{m.from.name} ({h(m.fromBefore ?? m.hoursFrom)} → {h(m.fromAfter ?? 0)})</span>
                      <ArrowRight size={12} aria-hidden="true" />
                      <span className="font-bold">{m.to.name} ({h(m.toBefore ?? 0)} → {h(m.toAfter ?? m.hoursTo)})</span>
                      {m.taughtBefore === false && (
                        <span data-testid={`pt-loads-move-new-${i}`} className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-200/70 dark:bg-amber-500/20 text-amber-900 dark:text-amber-200">Not taught before</span>
                      )}
                      {m.why && <span className="text-[11px] text-slate-600 dark:text-slate-400">— {m.why}</span>}
                    </li>
                  ))}
                </ul>
                <p data-testid="pt-loads-after" className="text-[11px] text-slate-700 dark:text-slate-300">
                  After the balance the part-time spread is <b>{h(data.suggestion.spreadAfter)}</b>.
                </p>
                {!confirmOpen ? (
                  <div className="flex flex-col items-start gap-1">
                    <button
                      type="button"
                      data-testid="pt-loads-apply"
                      disabled={Boolean(applyBlocked)}
                      aria-describedby={applyBlocked ? 'pt-loads-apply-reason' : undefined}
                      onClick={() => { setTickedMoves(new Set(data.suggestion.moves.map((m, i) => i))); setConfirmOpen(true); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-cyan-700 hover:bg-cyan-600 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-cyan-500"
                    >
                      Balance all
                    </button>
                    {applyBlocked && <p id="pt-loads-apply-reason" data-testid="pt-loads-apply-reason" className="text-[11px] text-slate-600 dark:text-slate-400">{applyBlocked}</p>}
                  </div>
                ) : (
                  <div data-testid="pt-loads-confirm" className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-3 space-y-2">
                    <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                      Each ticked move changes the professor of the whole class and is saved as your decision, with its reason. Untick a move to keep that class as it is. To undo a move, assign the class back.
                    </p>
                    <ul className="space-y-1">
                      {data.suggestion.moves.map((m, i) => (
                        <li key={i} className="text-[11px] text-amber-950 dark:text-amber-100">
                          <label className="flex flex-wrap items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              data-testid={`pt-loads-tick-${i}`}
                              checked={tickedMoves.has(i)}
                              disabled={applying}
                              onChange={() => setTickedMoves(prev => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i); else next.add(i);
                                return next;
                              })}
                              className="h-3.5 w-3.5 accent-cyan-600"
                            />
                            <b>{m.subjectCode}</b> ({m.sectionCode}): {m.from.name} {h(m.fromBefore ?? m.hoursFrom)} → {h(m.fromAfter ?? 0)}, {m.to.name} {h(m.toBefore ?? 0)} → {h(m.toAfter ?? m.hoursTo)}
                            {m.taughtBefore === false && <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-amber-200/70 dark:bg-amber-500/20">Not taught before</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2">
                      <button type="button" data-testid="pt-loads-confirm-apply" disabled={applying || tickedMoves.size === 0} title={tickedMoves.size === 0 ? 'Every move is unticked: tick at least one to apply.' : undefined} onClick={applyBalance} className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-white bg-cyan-700 hover:bg-cyan-600 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-cyan-500">
                        {applying ? 'Applying…' : `Apply ${tickedMoves.size} move${tickedMoves.size === 1 ? '' : 's'}`}
                      </button>
                      <button type="button" data-testid="pt-loads-confirm-keep" disabled={applying} onClick={() => setConfirmOpen(false)} className="px-3.5 py-1.5 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer focus-visible:ring-2 focus-visible:ring-cyan-500">
                        Keep the loads as they are
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p data-testid="pt-loads-balanced" className="text-xs font-bold text-green-700 dark:text-green-400">
                No move helps: everyone a move could raise is at their minimum, and the part-time loads are as even as the rule can make them.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
