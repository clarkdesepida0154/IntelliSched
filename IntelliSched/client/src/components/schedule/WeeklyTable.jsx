import { toMinutes, fromMinutes } from '../../utils/timeGrid';
import { WEEK_DAYS, WEEK_COLUMN_LABELS, timeLabel } from '../../utils/scheduleDisplay';
import './weeklyTable.css';

// The team's class-schedule table (Phase 3 Step 1), shared by the Mother Schedule, the Teachers'
// Program and the Room Program, on screen and in print: TIME plus all seven day columns, one row per
// slot across the policy's day window, thin light-grey lines, black text on white, no colours.
// As in the sample (docs/data/sample-section-schedule.png): a thin strip under the header, then a
// line at each slot time with its label centred on it ("07:00 AM" … "05:00 PM"), and one empty row
// after the last line.
// A block is a white box filling its rows between the lines; clashing blocks (only an editor preview
// can have them) sit side by side with a red outline.
//
// dayStart, dayEnd ('HH:MM') and slotMinutes are required: the version's policy. Nothing here knows
// the college's hours. Rows cover dayStart..dayEnd, widened to any block that falls outside them
// (e.g. a Saturday window). A caller that leaves them out gets rows that follow its blocks (the row
// length is the largest step that fits every block time); with no blocks either, a note says the
// table can't be drawn.
// blocks: [{ id, day, start, end ('HH:MM'), lines: [{ text, bold?, fit? }], kind: 'class' | 'duty' |
//            'unavailable', clash?, selected?, faded?, onSelect?, disabled?, disabledReason?,
//            ariaLabel?, testId? }]
// fit: 'nowrap' (one line), 'ellipsis' (one line, cut with "..."), 'wrap' (as many lines as the box
//      holds, e.g. a duty's label); otherwise a line wraps as far as the box has room for every line
//      (the last line up to three, the others up to two), or stays on one line (cut with "...") in a
//      box too short for that (weeklyTable.css).
// faded: a class's old place while the editor previews its move (dashed, grey text).
// disabled: a block with onSelect that can't be chosen right now; disabledReason says why.
// totalsRow (optional): one row under the table in the same columns, e.g. the Teachers' Program's day
//   totals: { label (in the TIME column, e.g. "Total 36 hours"), days: { Monday: '7', … }, testId? }
//   (testId defaults to `${testId}-totals`; its cells are `-label` and `-{Day}`).

const greatestCommonDivisor = (a, b) => (b ? greatestCommonDivisor(b, a % b) : a);

// Places one day's blocks: blocks that overlap share the column width side by side, one lane each.
const layoutDay = (items) => {
  const sorted = [...items].sort((a, b) => (a.s - b.s) || (b.e - a.e) || String(a.block.id).localeCompare(String(b.block.id)));
  const placed = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach((it) => {
      let lane = laneEnds.findIndex(end => end <= it.s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.e); } else laneEnds[lane] = it.e;
      it.lane = lane;
    });
    cluster.forEach((it) => placed.push({ ...it, lanes: laneEnds.length }));
    cluster = [];
    clusterEnd = -Infinity;
  };
  sorted.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  });
  if (cluster.length) flush();
  return placed;
};

const LINE_FIT = { nowrap: ' wt-line--nowrap', ellipsis: ' wt-line--ellipsis', wrap: ' wt-line--wrap' };

// A line that wraps may also wrap after a slash ("Consultation/" + "Preparation"), which browsers
// don't do on their own; the text itself is unchanged.
const slashBreaks = (text) => String(text ?? '').split('/').flatMap((part, i) => (i === 0 ? [part] : ['/', <wbr key={i} />, part]));

const blockClass = (block) => [
  'wt-block',
  `wt-block--${block.kind || 'class'}`,
  block.clash ? 'wt-block--clash' : '',
  block.selected ? 'wt-block--selected' : '',
  block.faded ? 'wt-block--faded' : '',
  block.onSelect ? 'wt-block--button' : ''
].filter(Boolean).join(' ');

// A box fills its rows from just under its start's line to just above its end's line, and its lane's
// share of the column between the column lines; its own light border and the grid's line beside it
// read as the sample's 2 px frame.
function Block({ item, origin, slotMinutes }) {
  const { block, s, e, lane, lanes } = item;
  const style = {
    top: `calc(var(--wt-strip) + var(--wt-row) * ${(s - origin) / slotMinutes} + 1px)`,
    height: `calc(var(--wt-row) * ${(e - s) / slotMinutes} - 1px)`,
    left: `${(lane / lanes) * 100}%`,
    width: `${100 / lanes}%`
  };
  const content = (block.lines || []).map((line, i) => (
    <span key={i} className={`wt-line${LINE_FIT[line.fit] || ''}${line.bold ? ' wt-line--bold' : ''}`}>{slashBreaks(line.text)}</span>
  ));
  const common = {
    className: blockClass(block),
    style,
    'data-testid': block.testId || 'wt-block',
    'data-block-id': block.id,
    'data-kind': block.kind || 'class',
    'data-day': block.day,
    'data-start': block.start,
    'data-end': block.end,
    'data-lane': lane,
    'data-lanes': lanes,
    'data-clash': block.clash ? 'true' : undefined,
    'data-faded': block.faded ? 'true' : undefined,
    'aria-label': block.ariaLabel || (block.lines || []).map(l => l.text).filter(Boolean).join(', ')
  };
  if (block.onSelect) {
    return (
      <button
        type="button"
        {...common}
        aria-pressed={block.selected ? 'true' : 'false'}
        disabled={block.disabled || undefined}
        title={block.disabled && block.disabledReason ? block.disabledReason : undefined}
        onClick={() => block.onSelect(block)}
      >
        {content}
      </button>
    );
  }
  return <div {...common}>{content}</div>;
}

// The optional row under the table: its label under TIME, each day's value in that day's column (the
// day's name is there for screen readers).
function TotalsRow({ row, testId }) {
  const id = row.testId || `${testId}-totals`;
  return (
    <div className="wt-totals" data-testid={id}>
      <div className="wt-totals-cell wt-totals-cell--label" data-testid={`${id}-label`}>{row.label}</div>
      {WEEK_DAYS.map(day => (
        <div key={day} className="wt-totals-cell" data-day={day} data-testid={`${id}-${day}`}>
          <span className="wt-visually-hidden">{`${day}: `}</span>
          <span className="wt-totals-value">{row.days?.[day] ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

export default function WeeklyTable({
  dayStart, dayEnd, slotMinutes, blocks = [], totalsRow = null,
  ariaLabel = 'Weekly class schedule', testId = 'weekly-table', variant = 'screen', className = ''
}) {
  const timed = blocks
    .map(block => ({ block, s: toMinutes(block.start), e: toMinutes(block.end) }))
    .filter(it => it.s !== null && it.e !== null && it.e > it.s && WEEK_DAYS.includes(it.block.day));
  const windowStart = toMinutes(dayStart);
  const windowEnd = toMinutes(dayEnd);
  // The row length: the policy's, else the largest step that fits the window and every block time.
  const slot = Number(slotMinutes) > 0
    ? Number(slotMinutes)
    : [windowStart, windowEnd, ...timed.flatMap(it => [it.s, it.e])].filter(m => m !== null).reduce(greatestCommonDivisor, 0);
  const first = Math.min(...[windowStart, ...timed.map(it => it.s)].filter(m => m !== null));
  const last = Math.max(...[windowEnd, ...timed.map(it => it.e)].filter(m => m !== null));
  const rootClass = `wt${variant === 'print' ? ' wt--print' : ''}${className ? ` ${className}` : ''}`;

  if (!(slot > 0) || !Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return (
      <div className={`${rootClass} wt--missing`} role="note" data-testid={testId} data-rows={0}>
        This table can&apos;t be drawn: the schedule&apos;s day window is missing.
      </div>
    );
  }

  const origin = Math.floor(first / slot) * slot;
  const end = Math.ceil(last / slot) * slot;
  const rowCount = (end - origin) / slot;
  const rows = Array.from({ length: rowCount }, (_, i) => fromMinutes(origin + i * slot));
  const byDay = WEEK_DAYS.map(day => layoutDay(timed.filter(it => it.block.day === day)));

  // Each row draws the line at its start time; the TIME column labels it there. The empty row after
  // the last line (the tail) carries that line and its label ("05:00 PM").
  // tabIndex -1: focusable from code only, so a page can put the focus on the table (e.g. when the
  // class that had it has left this view). data-tail-rows: the rows of the same height after the
  // data-rows (useFitOnePage shortens them all).
  return (
    <div
      className={rootClass}
      role="region"
      aria-label={ariaLabel}
      tabIndex={-1}
      data-testid={testId}
      data-rows={rowCount}
      data-tail-rows={1}
      data-origin={fromMinutes(origin)}
    >
      <div className="wt-grid">
        <div className="wt-th wt-th--time">TIME</div>
        {WEEK_COLUMN_LABELS.map((label, i) => (
          <div key={label} className="wt-th" data-testid={`${testId}-day-${WEEK_DAYS[i]}`}>{label}</div>
        ))}
        <div className="wt-col wt-col--time" aria-hidden="true">
          {[...rows, fromMinutes(end)].map((time, i) => (
            <div key={time} className={i < rowCount ? 'wt-cell wt-cell--time' : 'wt-tail'} data-time={time}>
              <span className="wt-time-label">{timeLabel(time)}</span>
            </div>
          ))}
        </div>
        {WEEK_DAYS.map((day, d) => (
          <div key={day} className="wt-col" data-day={day} data-testid={`${testId}-col-${day}`}>
            {rows.map(time => <div key={time} className="wt-cell" />)}
            <div className="wt-tail" />
            {byDay[d].map(item => (
              <Block key={item.block.id} item={item} origin={origin} slotMinutes={slot} />
            ))}
          </div>
        ))}
      </div>
      {totalsRow && <TotalsRow row={totalsRow} testId={testId} />}
    </div>
  );
}
