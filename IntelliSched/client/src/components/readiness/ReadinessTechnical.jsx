import { useState } from 'react';
import { AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import { tbaRoomCountsText, tbaRoomModeLabel } from '../../utils/gaRun';
import { whoMay } from '../../utils/permissionText';

// "Technical details" of the Readiness Check (Phase 3 Step 4), collapsed under the panel: the numbers
// behind each line, the room arithmetic, the TBA rooms the next run gets, the online option while the
// CCS rooms are short (Phase 3 Step 7: report.extraRooms.online, its subjects and the hours they would
// cover, with "Fix this" to the Master Catalog), the six technical checks with every message and its
// fix (the grouped "no description yet" warning among them), and the notes. All of it is the gateway's
// report as it came (POST /schedule/preflight); nothing is counted here. onNavigate(key, params)
// (optional) opens the page a "Fix this" names.

// How many messages a check shows before "Show all".
const COLLAPSED_COUNT = 5;

const CHECK_STATUS = {
  pass: { symbol: '✔', label: 'Passed', icon: CheckCircle2, tone: 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/20 text-green-900 dark:text-green-200', iconTone: 'text-green-700 dark:text-green-400' },
  warn: { symbol: '⚠', label: 'Warning', icon: AlertTriangle, tone: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900 dark:text-amber-200', iconTone: 'text-amber-700 dark:text-amber-400' },
  fail: { symbol: '✖', label: 'Must be fixed', icon: AlertOctagon, tone: 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-900 dark:text-red-200', iconTone: 'text-red-700 dark:text-red-400' }
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shown = (value) => (Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '—');

// One technical check with its own errors and warnings (each with its fix, and the list behind a
// grouped warning in `detail`).
function CheckRow({ check, errors, warnings }) {
  const [expanded, setExpanded] = useState(false);
  const status = CHECK_STATUS[check.status] || CHECK_STATUS.pass;
  const Icon = status.icon;
  const messages = [...errors.map(e => ({ ...e, kind: 'fail' })), ...warnings.map(w => ({ ...w, kind: 'warn' }))];
  const visible = expanded ? messages : messages.slice(0, COLLAPSED_COUNT);
  return (
    <li data-testid={`preflight-check-${check.id}`} data-status={check.status} className={`p-3 rounded-xl border flex items-start ${status.tone}`}>
      <Icon size={16} className={`mr-2.5 mt-0.5 shrink-0 ${status.iconTone}`} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="font-bold text-xs">
          <span className="sr-only">{status.label}: </span>{check.title}
        </p>
        <p className="text-xs leading-relaxed mt-0.5">{check.detail}</p>
        {visible.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {visible.map((m, i) => (
              <li key={`${m.code || m.check}-${i}`} data-testid="preflight-message" data-code={m.code || ''} className="text-xs leading-relaxed">
                <span className="font-bold" aria-hidden="true">{m.kind === 'fail' ? '✖\uFE0E ' : '⚠\uFE0E '}</span>
                <span className="sr-only">{m.kind === 'fail' ? 'Must be fixed: ' : 'Warning: '}</span>
                {m.message}
                {m.detail && typeof m.detail === 'string' && <span className="block">{m.code === 'SHORT_DESCRIPTION' ? 'Subjects: ' : ''}{m.detail}</span>}
                {m.fix && <span className="block">How to fix: {m.fix}</span>}
              </li>
            ))}
          </ul>
        )}
        {messages.length > COLLAPSED_COUNT && (
          <button
            type="button"
            data-testid={`preflight-check-${check.id}-toggle`}
            aria-expanded={expanded}
            onClick={() => setExpanded(v => !v)}
            className="mt-2 text-xs font-bold underline cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {expanded ? 'Show fewer' : `Show all ${messages.length}`}
          </button>
        )}
      </div>
    </li>
  );
}

const Figure = ({ label, testId, value, sub }) => (
  <div className="p-3 rounded-xl bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-800">
    <p className="text-[10px] font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest">{label}</p>
    <p data-testid={testId} className="text-lg font-black text-slate-900 dark:text-white mt-0.5">{value}</p>
    {sub && <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 leading-snug">{sub}</p>}
  </div>
);

const SubHeading = ({ children }) => (
  <h4 className="text-xs font-black text-slate-800 dark:text-white uppercase tracking-wider">{children}</h4>
);

// Phase 3 Step 7: holding Major lectures online, the third option while the CCS rooms are short
// (report.extraRooms.online: { hours, coveredHours, weekdaysAfter, subjects, fix }). The Dean chooses
// each subject's Lecture mode in the Master Catalog; "Fix this" opens it there (the Master Catalog tab
// of Curriculum & Subjects).
function OnlineOption({ online, onNavigate }) {
  const subjects = Array.isArray(online.subjects) ? online.subjects : [];
  const page = online.fix?.page || 'subjects';
  const params = online.fix?.params || (page === 'subjects' ? { tab: 'catalog' } : undefined);
  return (
    <section aria-label="Lectures held online" data-testid="readiness-online" className="space-y-1.5">
      <SubHeading>Lectures held online (an option)</SubHeading>
      <p id="readiness-online-summary" data-testid="readiness-online-summary" className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
        On weekdays, with the TBA lab rooms the labs need, the lectures are short of about {shown(online.hours)} h of room time.
        {' '}Holding the lectures of these Major subjects online, at a set day and time with no room, covers {shown(online.coveredHours)} h
        {online.weekdaysAfter ? `: the fewest TBA rooms on weekdays only would then be ${tbaRoomCountsText(online.weekdaysAfter)}` : ''}.
        {' '}Labs always stay on campus.
      </p>
      {subjects.length > 0 && (
        <ol data-testid="readiness-online-subjects" aria-label="Major subjects whose lectures would cover it, largest first" className="list-decimal pl-5 space-y-0.5 text-xs text-slate-700 dark:text-slate-300">
          {subjects.map(s => (
            <li key={s.subjectId || s.subjectCode} data-testid="readiness-online-subject" data-subject-id={s.subjectId || undefined}>
              <span className="font-bold">{s.subjectCode}</span>{s.subjectTitle ? ` ${s.subjectTitle}` : ''}: {shown(s.lectureHours)} h of lectures in {plural(s.sections, 'section')}
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <p className="text-xs text-slate-700 dark:text-slate-300">Whether to hold lectures online is the Dean&apos;s decision: set the Lecture mode of each subject in the Master Catalog. This check shows the effect after you save.</p>
        {onNavigate && (
          <button
            type="button"
            data-testid="readiness-online-fix"
            aria-describedby="readiness-online-summary"
            onClick={() => onNavigate(page, params)}
            className="self-start shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border text-blue-900 dark:text-blue-200 border-blue-200 dark:border-blue-500/30 bg-white dark:bg-white/5 hover:bg-blue-50 dark:hover:bg-blue-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Fix this <ArrowRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}

export default function ReadinessTechnical({ report, onNavigate = null }) {
  const n = report.numbers || {};
  const lines = report.readiness?.lines || [];
  const withDetail = lines.filter(l => l.detail);
  const extra = report.extraRooms || null;
  const resolved = extra?.resolved || (extra ? { lab: extra.lab, lec: extra.lec } : null);
  const suggestion = extra?.suggestion || null;
  const online = extra?.online || null;
  const errors = report.errors || [];
  const warnings = report.warnings || [];
  const info = report.info || [];

  return (
    <div className="space-y-5">
      <section aria-label="The numbers behind each line" className="space-y-2">
        <SubHeading>The numbers behind each line</SubHeading>
        {withDetail.length ? (
          <ul className="space-y-1.5">
            {withDetail.map(l => (
              <li key={l.id} data-testid={`readiness-detail-${l.n}`} className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                <span className="font-bold">{l.n}. {l.text}</span> {l.detail}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-600 dark:text-slate-400">No line has more to say: every line above tells the whole story.</p>
        )}
      </section>

      <section aria-label="Counts" className="space-y-2">
        <SubHeading>Counts</SubHeading>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <Figure label="Sections" testId="readiness-number-sections" value={shown(n.sections)} sub={Number.isFinite(n.pairs) ? `${plural(n.pairs, 'subject-section pair')}` : null} />
          <Figure label="Class meetings" testId="readiness-number-meetings" value={shown(n.demands)} sub={n.practicumPairs ? `+ ${plural(n.practicumPairs, 'practicum pair')} (not on the timetable)` : 'to place in the week'} />
          <Figure
            label="Lab blocks needed / fit"
            testId="readiness-number-labs"
            value={`${shown(n.labsNeeded)} / ${shown(n.labsFit)}`}
            sub={`${shown(n.labBlocksWeekday)} fit on weekdays${n.labBlocksSaturdayUsable ? ` + ${shown(n.labBlocksSaturdayUsable)} on Saturday` : ''}${n.labShort ? `; short by ${shown(n.labShort)}` : ''}`}
          />
          <Figure
            label="Lecture-room hours needed / available"
            testId="readiness-number-lectures"
            value={`${shown(n.lecHoursNeeded)} / ${shown(n.lecHoursAvailable)}`}
            sub={n.lecShortHours ? `short by about ${shown(n.lecShortHours)} h` : 'enough room hours'}
          />
        </div>
        {Number.isFinite(n.tbaClassesEstimate) && n.tbaClassesEstimate > 0 && (
          <p data-testid="readiness-number-tba" className="text-xs text-slate-700 dark:text-slate-300">
            About {plural(n.tbaClassesEstimate, 'class', 'classes')} the CCS rooms can&apos;t hold on weekdays (labs short, plus the fewest meetings that cover the room hours short, longest first).
          </p>
        )}
      </section>

      {extra && (
        <section aria-label="TBA rooms" data-testid="readiness-tba-rooms" className="space-y-1.5">
          <SubHeading>TBA rooms</SubHeading>
          <p className="text-xs text-slate-700 dark:text-slate-300">
            How they are set: <span className="font-bold">{tbaRoomModeLabel(extra.mode)}</span> (only {whoMay('advanced.edit')} changes it, in Advanced).
            {' '}The check counted, and the next run gets: <span data-testid="readiness-tba-resolved" className="font-bold">{resolved && (resolved.lab || resolved.lec) ? tbaRoomCountsText(resolved) : 'no TBA room'}</span>.
          </p>
          {suggestion ? (
            <p data-testid="readiness-tba-suggestion" className="text-xs text-slate-700 dark:text-slate-300">
              The fewest TBA rooms that make the room arithmetic fit: {suggestion.weekdays ? `${tbaRoomCountsText(suggestion.weekdays)} on weekdays only` : 'none on weekdays only'}
              {suggestion.withSaturday ? `; ${tbaRoomCountsText(suggestion.withSaturday)} also using Saturday` : ''}.
              {suggestion.note ? ` ${suggestion.note}` : ''}
            </p>
          ) : (
            <p data-testid="readiness-tba-suggestion" className="text-xs text-slate-700 dark:text-slate-300">The CCS rooms alone hold every class that needs a room.</p>
          )}
        </section>
      )}

      {online && <OnlineOption online={online} onNavigate={onNavigate} />}

      {Array.isArray(report.checks) && report.checks.length > 0 && (
        <section aria-label="Checks" className="space-y-2">
          <SubHeading>Checks</SubHeading>
          <ul className="space-y-2">
            {report.checks.map(check => (
              <CheckRow
                key={check.id}
                check={check}
                errors={errors.filter(e => e.check === check.id)}
                warnings={warnings.filter(w => w.check === check.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {info.length > 0 && (
        <section aria-label="Notes" className="space-y-1.5">
          <SubHeading>Notes</SubHeading>
          <ul className="space-y-1.5">
            {info.map((item, i) => (
              <li key={`${item.code}-${i}`} data-testid="readiness-info" className="text-xs text-slate-700 dark:text-slate-300 flex items-start">
                <Info size={14} className="mr-2 mt-px shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" /> {item.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
