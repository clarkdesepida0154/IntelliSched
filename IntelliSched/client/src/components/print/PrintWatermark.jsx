// "DRAFT – NOT APPROVED" across one printed sheet (print.css .print-watermark). Every sheet of a
// version that is not Approved carries it; the print view's toolbar says why, so screen
// readers skip the watermark itself.
export default function PrintWatermark() {
  return (
    <div className="print-watermark" data-testid="print-watermark" aria-hidden="true">
      <span>DRAFT – NOT APPROVED</span>
    </div>
  );
}
