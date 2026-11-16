import { useState } from 'react';
import { AlertOctagon, ArrowRight, CheckCircle2, ChevronDown, Info, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import ReadinessTechnical from './ReadinessTechnical';

// The Readiness panel (Phase 3 Step 4): whether the term is ready to generate, in the Dean's words. It
// sits at the top of the Generate Schedule page (summary), fills the Readiness Check page, and is step 3 of the
// Term Checklist (compact). It lays out the gateway's report.readiness as it came: the verdict
// ("Ready to generate" / "Not ready yet: N things to fix") and seven lines, each ✔ / ⚠ / ✖, a ✖ (or a
// ⚠ a page fixes) with a link to that page, chosen by the line's `fix.page` (the Step 4 page keys),
// never by its text. It computes nothing a second time. Technical detail stays inside a collapsed
// "Technical details".
//
// Props: state { status: 'checking' | 'done' | 'error', report, message } (useReadiness), onRecheck
// (shows "Check again"), onNavigate(key, params) (the "Fix this" links), compact (the checklist: the
// verdict and the lines that are not ✔; no note, no technical details), summary (Phase 8 Part 12, the
// Generate Schedule page's gate: the verdict with "N of M checks passed", the ✖ and ⚠ lines in full,
// "See all checks →" to the Readiness Check page and "Check again"; the ✔ lines are counted, not
// listed, and the technical details stay on the Readiness Check page).
// Test ids: readiness-panel (data-summary="true" in summary), readiness-recheck, readiness-checking,
// readiness-error, readiness-verdict (data-verdict ready | not-ready), readiness-verdict-count and
// readiness-see-all (summary), readiness-warnings-note, readiness-lines, readiness-line-{n}
// (data-status pass | warn | fail, data-line = the line's id), readiness-line-{n}-text,
// readiness-line-{n}-options-label, readiness-line-{n}-options (each readiness-line-{n}-option), readiness-fix-{n}, readiness-note,
// readiness-technical-toggle, readiness-technical (and the ids in ReadinessTechnical.jsx).

const LINE_STATUS = {
  pass: {
    symbol: '✔', label: 'Passed',
    tone: 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/20 text-green-900 dark:text-green-200',
    symbolTone: 'text-green-700 dark:text-green-400',
    link: ''
  },
  warn: {
    symbol: '⚠', label: 'Warning, does not block',
    tone: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-900 dark:text-amber-200',
    symbolTone: 'text-amber-700 dark:text-amber-400',
    link: 'text-amber-900 dark:text-amber-100 border-amber-300 dark:border-amber-500/40 hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:ring-amber-600'
  },
  fail: {
    symbol: '✖', label: 'Must be fixed',
    tone: 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-900 dark:text-red-200',
    symbolTone: 'text-red-700 dark:text-red-400',
    link: 'text-red-900 dark:text-red-100 border-red-300 dark:border-red-500/40 hover:bg-red-100 dark:hover:bg-red-500/20 focus-visible:ring-red-600'
  }
};

const GENERATE_NOTE = 'The system gives every class a day and a time, and a CCS room to every class that needs one, in one pass, so no section, professor or room is ever double-booked. Classes that don\'t need a CCS room show TBA. When the CCS rooms are full, the rest also show TBA and are listed under TBA rooms to request. Nothing is final until you approve it.';

// U+FE0E asks for the text form of a mark, so it takes the line's colour (not an emoji's).
const mark = (symbol) => `${symbol}\uFE0E`;
const thingsToFix = (n) => `${n} thing${n === 1 ? '' : 's'} to fix`;

// One line of the check: its mark, its words, the other options (rooms), and the link to the page
// that fixes it.
function ReadinessLine({ line, n, onNavigate, compact }) {
  const status = LINE_STATUS[line.status] || LINE_STATUS.pass;
  const textId = `readiness-line-${n}-text`;
  const canFix = Boolean(onNavigate && line.fix?.page && line.status !== 'pass');
  const options = Array.isArray(line.options) ? line.options.filter(Boolean) : [];
  return (
    <li data-testid={`readiness-line-${n}`} data-status={line.status} data-line={line.id} className={`rounded-xl border flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 ${compact ? 'p-2.5' : 'p-3'} ${status.tone}`}>
      <div className="flex items-start gap-2.5 flex-1 min-w-0">
        <span aria-hidden="true" className={`font-black leading-5 shrink-0 ${status.symbolTone}`}>{mark(status.symbol)}</span>
        <div className="min-w-0">
          <p id={textId} data-testid={textId} className={`${compact ? 'text-xs' : 'text-sm'} font-bold leading-5`}>
            <span className="sr-only">{status.label}: </span>{line.text}
          </p>
          {/* Phase 4 Part 4: "How we know", the rooms line's plain numbers (the labs against the lab rooms,
              the lecture hours against the lecture rooms), in the gateway's words. */}
          {line.howWeKnow && !compact && (
            <p data-testid={`readiness-line-${n}-how`} className="mt-1 text-xs leading-relaxed">
              <span className="font-bold">How we know: </span>{line.howWeKnow}
            </p>
          )}
          {/* Phase 8 Part 4: a line's own plain list (the professors under their minimum teaching
              load, each with their load against the range), in the gateway's words. */}
          {Array.isArray(line.list) && line.list.length > 0 && !compact && (
            <ul data-testid={`readiness-line-${n}-list`} className="mt-1 list-disc pl-5 text-xs leading-relaxed">
              {line.list.map(item => <li key={item} data-testid={`readiness-line-${n}-list-item`}>{item}</li>)}
            </ul>
          )}
          {/* The other options, right under the line, in the gateway's words, after a lead-in that reads
              well before a lone "Saturday classes …" and before the online option's "Or hold about N
              lecture hours online …" (Phase 3 Step 7; the list is named by the lead-in). */}
          {options.length > 0 && !compact && (
            <>
              <p id={`${textId}-options-label`} data-testid={`readiness-line-${n}-options-label`} className="mt-1 text-xs font-bold">Other ways to make room:</p>
              <ul data-testid={`readiness-line-${n}-options`} aria-labelledby={`${textId}-options-label`} className="list-disc pl-5 text-xs leading-relaxed">
                {options.map(option => <li key={option} data-testid={`readiness-line-${n}-option`}>{option}</li>)}
              </ul>
            </>
          )}
        </div>
      </div>
      {canFix && (
        <button
          type="button"
          data-testid={`readiness-fix-${n}`}
          aria-describedby={textId}
          onClick={() => onNavigate(line.fix.page, line.fix.params || undefined)}
          className={`self-start shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border bg-white/70 dark:bg-white/5 cursor-pointer focus:outline-none focus-visible:ring-2 ${status.link}`}
        >
          {line.status === 'fail' ? 'Fix this' : 'Review this'} <ArrowRight size={12} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export default function ReadinessPanel({ state, onRecheck = null, onNavigate = null, compact = false, summary = false }) {
  const [showTechnical, setShowTechnical] = useState(false);
  const report = state?.report || null;
  const readiness = report?.readiness || null;
  const isChecking = state?.status === 'checking';
  const ready = readiness?.verdict === 'ready';
  const toFix = Number(readiness?.toFix) || 0;
  const lines = (readiness?.lines || []).map((line, i) => ({ line, n: Number.isFinite(line.n) ? line.n : i + 1 }));
  const shownLines = compact || summary ? lines.filter(({ line }) => line.status !== 'pass') : lines;
  const warnCount = lines.filter(({ line }) => line.status === 'warn').length;
  const passCount = lines.filter(({ line }) => line.status === 'pass').length;

  const verdict = readiness && (
    <div
      data-testid="readiness-verdict"
      data-verdict={ready ? 'ready' : 'not-ready'}
      className={`rounded-2xl border flex items-start gap-3 ${compact ? 'p-3' : 'p-4'} ${ready
        ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/20 text-green-900 dark:text-green-200'
        : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20 text-red-900 dark:text-red-200'}`}
    >
      {ready
        ? <CheckCircle2 size={compact ? 20 : 26} className="shrink-0 text-green-700 dark:text-green-400" aria-hidden="true" />
        : <AlertOctagon size={compact ? 20 : 26} className="shrink-0 text-red-700 dark:text-red-400" aria-hidden="true" />}
      <div className="min-w-0">
        <p data-testid="readiness-verdict-label" className={`${compact ? 'text-base' : 'text-xl'} font-black leading-tight`}>
          {ready ? 'Ready to generate' : `Not ready yet: ${thingsToFix(toFix)}`}
        </p>
        {summary && lines.length > 0 && (
          <p data-testid="readiness-verdict-count" className="text-sm font-bold mt-1">{passCount} of {lines.length} checks passed</p>
        )}
        {ready && warnCount > 0 && (
          <p data-testid="readiness-warnings-note" className="text-xs font-bold mt-1">
            {warnCount === 1 ? `The line marked ${mark('⚠')} does not stop you from generating.` : `The ${warnCount} lines marked ${mark('⚠')} do not stop you from generating.`}
          </p>
        )}
        {!ready && !compact && <p className="text-xs font-bold mt-1">Fix each line marked {mark('✖')}; its link opens the page that fixes it. Then press &ldquo;Check again&rdquo;.</p>}
        {isChecking && <p className="text-xs font-bold mt-1">Checking again…</p>}
      </div>
    </div>
  );

  if (compact) {
    return (
      <div data-testid="readiness-panel" data-compact="true" className="space-y-2" aria-live="polite">
        {isChecking && !report && (
          <p data-testid="readiness-checking" className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-300">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking the term…
          </p>
        )}
        {state?.status === 'error' && <p role="alert" data-testid="readiness-error" className="text-xs font-bold text-red-700 dark:text-red-400">{state.message}</p>}
        {verdict}
        {shownLines.length > 0 && (
          <ol data-testid="readiness-lines" className="space-y-1.5">
            {shownLines.map(({ line, n }) => <ReadinessLine key={line.id || n} line={line} n={n} onNavigate={onNavigate} compact />)}
          </ol>
        )}
      </div>
    );
  }

  return (
    <section data-testid="readiness-panel" data-summary={summary ? 'true' : undefined} aria-labelledby="readiness-title" className="bg-white dark:bg-[#1a1a1c] p-6 rounded-3xl border border-slate-200 dark:border-slate-800 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h3 id="readiness-title" className="font-bold text-base text-slate-800 dark:text-white flex items-center">
            <ShieldCheck size={16} className="mr-2 text-blue-800 dark:text-blue-400" aria-hidden="true" /> Is the term ready to generate?
          </h3>
        </div>
        {onRecheck && (
          <button
            type="button"
            data-testid="readiness-recheck"
            onClick={() => onRecheck()}
            disabled={isChecking}
            className="shrink-0 self-start px-4 py-2 rounded-xl text-xs font-bold text-blue-900 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 hover:bg-blue-100 dark:hover:bg-blue-500/20 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {isChecking ? <Loader2 size={14} className="mr-1.5 animate-spin" aria-hidden="true" /> : <RefreshCw size={14} className="mr-1.5" aria-hidden="true" />}
            {isChecking ? 'Checking…' : 'Check again'}
          </button>
        )}
      </div>

      <div aria-live="polite" className="space-y-4">
        {isChecking && !report && (
          <p data-testid="readiness-checking" className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-300 py-4">
            <Loader2 size={16} className="animate-spin text-blue-800 dark:text-blue-400" aria-hidden="true" /> Checking the term&apos;s sections, curriculum, rooms and assignments…
          </p>
        )}
        {state?.status === 'error' && (
          <p role="alert" data-testid="readiness-error" className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-xs font-bold text-red-700 dark:text-red-400">
            <AlertOctagon size={14} className="shrink-0 mt-px" aria-hidden="true" /> {state.message}
          </p>
        )}
        {verdict}
      </div>

      {report && shownLines.length > 0 && (
        <ol data-testid="readiness-lines" aria-label={summary ? 'The checks to act on' : 'The checks'} className="space-y-2">
          {shownLines.map(({ line, n }) => <ReadinessLine key={line.id || n} line={line} n={n} onNavigate={onNavigate} compact={false} />)}
        </ol>
      )}

      {summary && report && onNavigate && (
        <button
          type="button"
          data-testid="readiness-see-all"
          onClick={() => onNavigate('readiness')}
          className="inline-flex items-center gap-1 text-xs font-bold text-blue-800 dark:text-blue-300 hover:underline cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          See all checks <ArrowRight size={12} aria-hidden="true" />
        </button>
      )}

      {report && (
        <details data-testid="readiness-note" className="p-4 rounded-2xl bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer flex items-center gap-3 text-xs font-black text-slate-800 dark:text-white">
            <Info size={16} className="shrink-0 text-blue-800 dark:text-blue-400" aria-hidden="true" />
            What happens when I press Generate
          </summary>
          <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed mt-2">{GENERATE_NOTE}</p>
        </details>
      )}

      {report && !summary && (
        <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
          <button
            type="button"
            data-testid="readiness-technical-toggle"
            aria-expanded={showTechnical}
            aria-controls="readiness-technical"
            onClick={() => setShowTechnical(v => !v)}
            className="w-full flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-200 py-1 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Technical details
            <ChevronDown size={14} className={`transition-transform ${showTechnical ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          <div id="readiness-technical" data-testid="readiness-technical" hidden={!showTechnical} className="mt-3">
            {showTechnical && <ReadinessTechnical report={report} onNavigate={onNavigate} />}
          </div>
        </div>
      )}
    </section>
  );
}
