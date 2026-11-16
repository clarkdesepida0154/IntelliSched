import { Children, useRef } from 'react';
import WeeklyTable from '../schedule/WeeklyTable';
import PrintWatermark from './PrintWatermark';
import { FormFooter, SignatoryLines } from './SheetParts';
import useFitOnePage from './useFitOnePage';
import './print.css';

// One printed class-schedule sheet on one A4 portrait page (Phase 3 Step 3): the Mother Schedule of
// a section or the Room Program of a room (a Teachers' Program printed in the "Class schedule table"
// layout uses it too). Above, one short header: the college, the title, the section or room, the
// term. Then the Step 1 weekly table exactly as on screen (WeeklyTable variant="print"), what goes
// under it (children), and the signatory lines and the form code, revision and date only when the
// Dean has set them (Output Settings).
//
// Props: collegeName, title, heading { name, detail }, termLabel; policy { dayStart, dayEnd,
// slotMinutes } (the version's); blocks (WeeklyTable blocks); totalsRow (WeeklyTable's optional row
// under the table, e.g. a Teachers' Program's day totals); tableLabel; children; signatories
// [{ label, name, title, auto }], professor ({ name, position }: fills an automatic line), form
// { formCode, revision, date }; watermark (the version is not Approved); kind and
// sheetKey (test hooks: data-sheet, data-key); intro (optional, between the header and the table,
// e.g. a Teachers' Program's facts).

// The table's rows never get shorter than this, so a 1-hour class keeps room for its lines.
const MIN_ROW_MM = 5;

export default function ClassScheduleSheet({
  collegeName = '', title = '', heading = { name: '', detail: '' }, termLabel = '',
  policy, blocks = [], totalsRow = null, tableLabel = '', children = null, intro = null,
  signatories = [], professor = null, form = {}, watermark = false,
  kind = '', sheetKey = ''
}) {
  const pageRef = useRef(null);

  // One sheet, one page: when the sheet is taller than the page (a long subject list, signatory
  // lines), the table's rows get shorter until it fits; the sheets of one print share one grid
  // (useFitOnePage).
  useFitOnePage(pageRef, { grid: '.wt', row: '.wt-cell', variable: '--wt-row', minRowMm: MIN_ROW_MM });

  return (
    <section
      ref={pageRef}
      className="print-page"
      data-testid="print-page"
      data-sheet={kind || undefined}
      data-key={sheetKey || undefined}
      aria-label={[title, heading?.name].filter(Boolean).join(': ')}
    >
      {watermark && <PrintWatermark />}
      <header className="sheet-header">
        <p className="sheet-line sheet-college" data-testid="print-sheet-college">{collegeName}</p>
        <p className="sheet-line sheet-title" data-testid="print-sheet-title">{title}</p>
        <p className="sheet-line sheet-entity" data-testid="print-sheet-entity">
          <b>{heading?.name}</b>
          {heading?.detail ? ` — ${heading.detail}` : ''}
        </p>
        <p className="sheet-line sheet-term" data-testid="print-sheet-term">{termLabel}</p>
      </header>

      {intro}

      <WeeklyTable
        variant="print"
        dayStart={policy?.dayStart}
        dayEnd={policy?.dayEnd}
        slotMinutes={policy?.slotMinutes}
        blocks={blocks}
        totalsRow={totalsRow}
        ariaLabel={tableLabel || title}
        testId={`print-table${sheetKey ? `-${sheetKey}` : ''}`}
      />

      {/* Only when something goes under the table (children may be a list with empty places). */}
      {Children.toArray(children).length > 0 && <div className="sheet-below">{children}</div>}
      <SignatoryLines lines={signatories} professor={professor} />
      <FormFooter formCode={form?.formCode || ''} revision={form?.revision || ''} date={form?.date || ''} />
    </section>
  );
}
