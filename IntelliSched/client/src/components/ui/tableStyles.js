/**
 * Shared table styling tokens for the Academic Data Management standard.
 *
 * disabledCellClass: applied to every data cell of a row whose record has isActive === false.
 * The action cell is left out so the Enable icon stays clearly clickable.
 * Since Phase 3 Step 8 a disabled row is no longer faded with opacity (that took its text below the
 * WCAG AA 4.5:1 ratio): the row gets a light grey background and its cells' own text colours stay,
 * and the row's Status column shows the "Disabled" badge (disabledBadgeClass) so the state is
 * readable without colour. Checked ratios (WCAG relative luminance):
 *   slate-600 #475569 on slate-50 #f8fafc  7.24:1;  slate-700 #334155 on slate-100 #f1f5f9  9.45:1
 *   (the badge);  slate-400 #94a3b8 on the dark row #1c1c1f  6.63:1.
 */
export const disabledCellClass = 'bg-slate-50 text-slate-600 dark:bg-[#1c1c1f] dark:text-slate-400';

// The visible "Disabled" badge of a disabled row's Status column (grey, with the Ban icon).
export const disabledBadgeClass =
  'inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-[10px] font-bold ' +
  'bg-slate-100 text-slate-700 border border-slate-300 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30';
