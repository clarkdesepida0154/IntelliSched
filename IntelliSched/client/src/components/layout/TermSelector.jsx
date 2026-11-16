import { CalendarRange } from 'lucide-react';
import { useTerm } from '../../context/term';
import Select from '../ui/Select';

// The closed pickers keep the pill's look; their open list is the shared Select's (Phase 13, decision 1).
// The keyboard focus ring sits on the pill via focus-within.
const selectClass = 'bg-transparent text-xs font-bold text-slate-800 dark:text-slate-100 cursor-pointer py-1 pr-0.5 max-w-36 lg:max-w-40 rounded-md focus-visible:ring-0 focus-visible:ring-offset-0';

// Persistent top-bar selector for the Global Term Context. Every term-bound page reads this choice.
export default function TermSelector({ className = '' }) {
  const { activeAcademicYear, activeSemester, academicYearOptions, currentAcademicYear, semesterOptions, setActiveAcademicYear, setActiveSemester } = useTerm();
  return (
    <div
      role="group"
      aria-label="Active term"
      title="Active term used by scheduling, locks, timetable and approval pages"
      className={`flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-[#1a1a1c] pl-3 pr-2 py-1 focus-within:ring-2 focus-within:ring-blue-500 ${className}`}
    >
      <CalendarRange size={14} className="text-blue-600 dark:text-blue-400 shrink-0 hidden lg:block" aria-hidden="true" />
      <Select aria-label="Active academic year" data-testid="term-year" valueLabel={o => o.label.replace(' (current)', '')} value={activeAcademicYear} onChange={e => setActiveAcademicYear(e.target.value)} className={selectClass}>
        {academicYearOptions.map(year => <option key={year} value={year}>A.Y. {year}{year === currentAcademicYear ? ' (current)' : ''}</option>)}
      </Select>
      <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">|</span>
      <Select aria-label="Active semester" data-testid="term-semester" value={activeSemester} onChange={e => setActiveSemester(e.target.value)} className={selectClass}>
        {semesterOptions.map(label => <option key={label} value={label}>{label}</option>)}
      </Select>
    </div>
  );
}
