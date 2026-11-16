import { CalendarDays } from 'lucide-react';
import { useTerm } from '../../context/term';

// "Current term: 1st Semester, A.Y. 2026-2027" under a page title (UI standard: every page shows
// its title, a one-line purpose and the current term). The term is changed in the top bar.
export default function CurrentTermNote({ className = '' }) {
  const { termLabel } = useTerm();
  return (
    <p data-testid="current-term" className={`text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5 ${className}`}>
      <CalendarDays size={12} aria-hidden="true" />
      Current term: <span className="font-bold text-slate-700 dark:text-slate-200">{termLabel}</span>
    </p>
  );
}
