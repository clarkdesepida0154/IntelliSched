import { SignatoryLines } from './SheetParts';
import { labFactorExpression, numberText, signedBy } from '../../utils/scheduleDisplay';

// The parts of a printed Teachers' Program (Phase 3 Step 3) that both print layouts share, the SF-029
// form (TeachersProgramForm.jsx) and the "Class schedule table" (TeachersProgramTable.jsx). Every fact
// and number is the gateway's (GET /schedule/outputs faculty[]: header, summary, ancillary, all from
// the one load rule, utils/load.js); nothing here computes one.

// ---------------------------------------------------------------- the professor's facts
// The SF-029's two info columns: left Name, Position, Major/Minor, Co-Curricular Activities; right
// College, Subject Taught (each code once), Preparation. An empty fact prints as a blank line, never a
// placeholder. omit: facts the layout already shows (the table layout names the professor above).
const FACT_COLUMNS = [
  [
    // Phase 8 Part 3 (decision 1d): the Name line carries the degree after the name, in the form's
    // capitals with the degree's own case ("FacultyMember, MSIT"); the gateway builds it.
    { key: 'name', label: 'Name', of: h => h.nameWithDegree || h.name },
    { key: 'position', label: 'Position', of: h => h.position },
    { key: 'major', label: 'Major/Minor', of: h => h.majorMinor },
    { key: 'cocurricular', label: 'Co-Curricular Activities', of: h => h.coCurricular }
  ],
  [
    { key: 'college', label: 'College', of: h => h.college },
    { key: 'subjects', label: 'Subject Taught', of: h => (Array.isArray(h.subjectsTaught) ? h.subjectsTaught.join(', ') : h.subjectsTaught) },
    { key: 'preparations', label: 'Preparation', of: h => h.preparations }
  ]
];
const factText = (value) => (value === null || value === undefined ? '' : String(value).trim());

export function ProgramFacts({ header, omit = [], compact = false }) {
  const h = header || {};
  return (
    <div className={`tp-info${compact ? ' tp-info--compact' : ''}`} data-testid="print-tp-info">
      {FACT_COLUMNS.map((column, c) => (
        <dl key={c} className="tp-info-col">
          {column.filter(fact => !omit.includes(fact.key)).map(fact => (
            <div key={fact.key} className="tp-info-row">
              <dt>{fact.label}:</dt>
              <dd data-testid={`print-tp-info-${fact.key}`}>{factText(fact.of(h))}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the load summary
// The SF-029's summary box, lower left, in the real form's order: "SUMMARY OF TEACHING LOAD (Maximum
// of hours per week)" with the teaching hours; then AREA and HRS.&MIN./WK: the ancillary areas, the
// lecture hours, the lab line ("(Lab.) 15 × .75 =" and "11.25"), Practicum coordination when the
// professor has one; then TOTAL NO. OF HOURS and Excess No. of Hours. A line without hours (an area
// the professor doesn't have, no Excess) is blank, as on the form.
const TOTAL_KEYS = ['TOTAL', 'EXCESS'];
// Phase 8 Part 3 (decision 1e): the HRS.&MIN./WK column carries the forms' own words — "8 Hours",
// "0 Hours" on a full-timer's empty duty row, plain "Hours" on a part-timer's blank rows and a blank
// Excess; the teaching headline reads "21 HOURS"; the lab line's value stays the "=" result.
const hoursOf = (line) => {
  if (line.key === 'LAB') {
    return line.hours === null || line.hours === undefined ? ''
      : numberText(line.weighted !== undefined && line.weighted !== null ? line.weighted : line.hours);
  }
  if (line.key === 'TEACHING') return `${numberText(line.hours)} HOURS`;
  if (line.hours === null || line.hours === undefined) return 'Hours';
  return `${numberText(line.hours)} Hours`;
};
// The lab line as the form prints it: "(Lab.) 15 × .75 =" with the weighted hours for a part-timer;
// the form's own blank template "(Lab.) ___ × .75 =" for a full-timer (Phase 4 Part 4: their lab hours
// sit inside "Teaching Duties", as on the real forms).
const labelOf = (line) => {
  if (line.key !== 'LAB') return line.label;
  if (line.hours === null || line.hours === undefined) return `${line.label} ___ × .75 =`;
  const expression = labFactorExpression(line.hours, line.factor);
  return expression ? `${line.label} ${expression} =` : line.label;
};

function SummaryRow({ line }) {
  return (
    <tr data-testid={`print-tp-summary-${line.key}`} className={TOTAL_KEYS.includes(line.key) ? 'tp-summary-total' : undefined}>
      <th scope="row" data-testid={`print-tp-summary-${line.key}-label`}>{labelOf(line)}</th>
      <td data-testid={`print-tp-summary-${line.key}-value`}>{hoursOf(line)}</td>
    </tr>
  );
}

export function LoadSummaryBox({ summary }) {
  const lines = (Array.isArray(summary) ? summary : []).filter(line => line && line.key);
  if (!lines.length) return null;
  const teaching = lines.find(line => line.key === 'TEACHING');
  const areas = lines.filter(line => line.key !== 'TEACHING' && !TOTAL_KEYS.includes(line.key));
  const totals = TOTAL_KEYS.map(key => lines.find(line => line.key === key)).filter(Boolean);
  return (
    <table className="tp-summary" data-testid="print-tp-summary">
      <colgroup>
        <col />
        <col className="tp-summary-hours" />
      </colgroup>
      <tbody>
        {teaching && (
          <tr className="tp-summary-head" data-testid="print-tp-summary-TEACHING">
            <th scope="row" data-testid="print-tp-summary-TEACHING-label">
              {teaching.label}
              <span className="tp-summary-sub">(Maximum of hours per week)</span>
            </th>
            <td data-testid="print-tp-summary-TEACHING-value">{hoursOf(teaching)}</td>
          </tr>
        )}
        <tr className="tp-summary-cols">
          <th scope="col">AREA</th>
          <th scope="col">HRS.&amp;MIN./WK</th>
        </tr>
        {areas.map(line => <SummaryRow key={line.key} line={line} />)}
        {totals.map(line => <SummaryRow key={line.key} line={line} />)}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- the signatories, as on the scans
// Phase 8 Part 3 (decision 1a): the four signatory blocks placed as on the office's scans, never
// stacked in one column — "Prepared by:" at the right, "Conformed/Received by:" lower and toward the
// centre, "Recommending Approval:" lower again at the right, "Approved:" at the bottom with its label
// left of centre and the name centred. The positions are the export layout's own measurements
// (server/src/exports/layouts.js signatureArea, twips), here as fractions of the content width and
// millimetres from the area's top; the vertical room above each name is for the signature. A fifth or
// later line (one the Dean added) stacks under the area the old way.
const SF029_SIGNATURE_BLOCKS = [
  { key: 'prepared', labelLeft: '67.5%', labelTop: '0mm', nameCenter: '77.4%', nameTop: '8.6mm' },
  { key: 'conformed', labelLeft: '49%', labelTop: '22mm', nameCenter: '64.9%', nameTop: '29.5mm' },
  { key: 'recommending', labelLeft: '67.5%', labelTop: '40mm', nameCenter: '81.7%', nameTop: '47.6mm' },
  { key: 'approved', labelLeft: '29.4%', labelTop: '58.8mm', nameCenter: '50%', nameTop: '63.7mm' }
];

export function Sf029Signatories({ lines = [], professor = null }) {
  const shown = (Array.isArray(lines) ? lines : []).filter(line => line && typeof line === 'object');
  if (!shown.length) return null;
  const placed = shown.slice(0, SF029_SIGNATURE_BLOCKS.length);
  const extras = shown.slice(SF029_SIGNATURE_BLOCKS.length);
  return (
    <>
      <div className="tp-sig-area" data-testid="print-signatories">
        {placed.map((line, i) => {
          const pos = SF029_SIGNATURE_BLOCKS[i];
          const { name, title } = signedBy(line, professor);
          return (
            <div key={pos.key} data-testid="print-signatory" data-block={pos.key}>
              <p className="tp-sig-label" style={{ left: pos.labelLeft, top: pos.labelTop }}>{line.label}</p>
              <div className="tp-sig-name-box" style={{ left: pos.nameCenter, top: pos.nameTop }}>
                <p className={`tp-sig-name${name ? '' : ' tp-sig-name--blank'}`} data-testid="print-signatory-name">{name}</p>
                <p className="tp-sig-title">{title}</p>
              </div>
            </div>
          );
        })}
      </div>
      {extras.length > 0 && <SignatoryLines lines={extras} professor={professor} columns={2} />}
    </>
  );
}

// ---------------------------------------------------------------- under the grid
// Below the grid: the load summary on the left and the signatories — the SF-029 form places its four
// blocks as on the scans (staggered); the "Class schedule table" layout keeps the two-column lines.
// The automatic line ("Conformed/Received by:") carries the professor's name and position.
export function ProgramBelow({ summary, signatories = [], professor = null, staggered = false }) {
  return (
    <div className={`tp-below${staggered ? ' tp-below--sf029' : ''}`}>
      <LoadSummaryBox summary={summary} />
      {staggered
        ? <Sf029Signatories lines={signatories} professor={professor} />
        : <SignatoryLines lines={signatories} professor={professor} columns={2} />}
    </div>
  );
}
