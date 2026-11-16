import { useLayoutEffect } from 'react';

// One form, one page (Phase 3 Step 3): when a printed form is taller than the printable height of an
// A4 portrait page (297 mm less the 10 mm margins of print.css's @page), the rows of its grid get
// shorter until it fits, never below minRowMm. Sizes are in millimetres and points, so a form
// measures the same on screen as on paper.
// The forms printed together (the pages of one print view) share one grid: each records the row it
// needs on its grid (data-fit-row) and gives every grid of the batch the shortest one, so whichever
// form runs last leaves them all alike (a shorter row never makes a form taller). Runs after every
// render, before the paint.
//   pageRef    the form's .print-page element
//   grid       the grid's selector inside it ('.wt', '.tp-grid'); the grid carries data-rows, and
//              data-tail-rows when more rows of the same height follow them (the weekly table's empty
//              row after its last line)
//   row        the selector of one row of the grid, measured for its height
//   variable   the CSS custom property that sets the row height ('--wt-row', '--tp-row')
//   minRowMm   the shortest row allowed
const PX_PER_MM = 96 / 25.4;
export const PAGE_HEIGHT_MM = 277;

export default function useFitOnePage(pageRef, { grid, row, variable, minRowMm }) {
  useLayoutEffect(() => {
    const page = pageRef.current;
    const table = page?.querySelector(grid);
    if (!table) return;
    const rowOf = (t) => t.querySelector(row)?.getBoundingClientRect().height || 0;
    table.style.removeProperty(variable);
    const rows = (Number(table.dataset.rows) || 0) + (Number(table.dataset.tailRows) || 0);
    const natural = rowOf(table);
    if (!(rows > 0 && natural > 0)) return;
    const overflow = parseFloat(getComputedStyle(page).height) - PAGE_HEIGHT_MM * PX_PER_MM;
    const needed = overflow > 0 ? Math.max(minRowMm * PX_PER_MM, natural - overflow / rows) : natural;
    table.dataset.fitRow = String(Math.floor(needed * 100) / 100);
    const batch = [...(page.parentElement?.querySelectorAll(`:scope > .print-page ${grid}[data-fit-row]`) || [table])];
    const shortest = Math.min(...batch.map(t => Number(t.dataset.fitRow)).filter(n => n > 0));
    batch.forEach(t => {
      if (shortest < natural - 0.01) t.style.setProperty(variable, `${shortest}px`);
      else t.style.removeProperty(variable);
    });
  });
}
