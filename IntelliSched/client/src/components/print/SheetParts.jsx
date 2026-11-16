// Parts every printed form shares (Phase 3 Step 3), both from the Output Settings and printed only
// when the Dean has set them: the signatory lines and the form code footer.

// The signatory wording (signedBy) lives in utils/scheduleDisplay.js, shared with the SF-029's
// staggered blocks (TeachersProgramParts.jsx).
import { signedBy } from '../../utils/scheduleDisplay';

// The signatory lines, up to four side by side: the label ("Prepared by:"), room to sign, the name on
// the line, and the title under it. A line takes at most a third of the width, so one or two lines
// keep the width of a signature. columns (optional) sets how many lines share a row (the SF-029 puts
// two side by side next to its load summary).
export function SignatoryLines({ lines = [], professor = null, columns = null }) {
  const shown = (Array.isArray(lines) ? lines : []).filter(line => line && typeof line === 'object');
  if (!shown.length) return null;
  return (
    <div
      className="sheet-signatories"
      data-testid="print-signatories"
      style={{ gridTemplateColumns: `repeat(${columns || Math.min(4, Math.max(3, shown.length))}, minmax(0, 1fr))` }}
    >
      {shown.map((line, i) => {
        const { name, title } = signedBy(line, professor);
        return (
          <div key={i} className="sheet-sign" data-testid="print-signatory">
            <p className="sheet-line sheet-sign-label">{line.label}</p>
            <div className="sheet-sign-space" />
            <p className="sheet-line sheet-sign-name" data-testid="print-signatory-name">{name}</p>
            <p className="sheet-line sheet-sign-title">{title}</p>
          </div>
        );
      })}
    </div>
  );
}

// The form code bottom left, the revision in the middle, the date bottom right; nothing when none is
// set.
export function FormFooter({ formCode = '', revision = '', date = '' }) {
  if (!formCode && !revision && !date) return null;
  return (
    <div className="sheet-form-footer" data-testid="print-form-footer">
      <span className="sheet-line">{formCode}</span>
      <span className="sheet-line">{revision}</span>
      <span className="sheet-line">{date}</span>
    </div>
  );
}
