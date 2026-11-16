import { useState } from 'react';
import { Search } from 'lucide-react';
import useSort from '../../hooks/useSort';
import usePagination from '../../hooks/usePagination';
import SortableHeader from '../ui/SortableHeader';
import TablePagination from '../ui/TablePagination';
import { DAY_NAMES } from '../../utils/timeGrid';
import { codeLine, professorLine, tbaRoomName, timeRangeLabel } from '../../utils/scheduleDisplay';
import Select from '../ui/Select';

// The List view of the Schedule Views page: every class of the version in one table, with filters
// (section, professor, day), a search, sortable columns and pages of 25. It starts sorted by the
// current view's entity (section, professor or room), then day and start. In a Draft each row can
// open the same "Move this class" panel as the weekly table; moveBlockedReason (e.g. while a move is
// saved, or the role may not move classes) closes those buttons and says why, and moveReasonId (the
// page's visible note with that reason, Phase 3 Step 6) is their accessible description.
// renderActions(rows, { anyFilter }) (optional) adds controls at the end of the filter bar for the rows
// the filters keep, on every page, in the list's order (the page's "Download CSV").
// Phase 6 (the audit's N8): a Room filter next to Day (the rooms the page lists: CCS, borrowed, the TBA
// rooms with classes, and "No room" for a class that needs none or is online), and the list opens on
// the entity the page had chosen (initialEntity { view, key }: the section, the professor or the room),
// so switching to List on the Room Program keeps the room.
const PAGE_SIZE = 25;
const DAY_INDEX = Object.fromEntries(DAY_NAMES.map((day, i) => [day, i]));
const NO_PROFESSOR = '__TBA__';
const NO_ROOM = '__NO_ROOM__';

// The Room column: a real room by its name, a TBA room to request by its TBA name
// ("TBA room 1 (lab)"), "TBA" for a class that needs no CCS room.
const roomName = (cls) => {
  if (cls.roomKind === 'ONLINE') return 'Online';
  if (cls.roomKind === 'TBA_ROOM' || cls.extraRoomKey) return tbaRoomName(cls.extraRoomKey);
  return (cls.roomKind === 'CCS' || cls.roomKind === 'BORROWED') && cls.roomName ? cls.roomName : 'TBA';
};

// Every column breaks ties by day, then start.
const when = (cls) => `${DAY_INDEX[cls.day] ?? 9}|${cls.startTime}`;
const SORT_GETTERS = {
  section: cls => `${cls.sectionLabel}|${when(cls)}`,
  day: cls => `${when(cls)}|${cls.sectionLabel}`,
  time: cls => `${cls.startTime}|${DAY_INDEX[cls.day] ?? 9}|${cls.sectionLabel}`,
  subject: cls => `${codeLine(cls)}|${cls.sectionLabel}|${when(cls)}`,
  title: cls => `${cls.subjectTitle}|${cls.sectionLabel}|${when(cls)}`,
  professor: cls => `${professorLine(cls)}|${when(cls)}`,
  room: cls => `${roomName(cls)}|${when(cls)}`
};
const FIRST_SORT = { section: 'section', professor: 'professor', room: 'room' };

const selectClass = 'bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500';
const labelClass = 'block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider';
// The actions column stays in view when a narrow screen scrolls the table sideways.
const STICKY_CELL = 'sticky right-0 border-l border-slate-100 dark:border-slate-800/60';

export default function ClassListView({ classes, view, sections, faculty, rooms = [], initialEntity = null, editable, moveBlockedReason = '', moveReasonId, onMove, renderActions = null }) {
  const chosen = (kind) => (initialEntity && initialEntity.view === kind && initialEntity.key ? String(initialEntity.key) : '');
  const [sectionId, setSectionId] = useState(() => chosen('section'));
  const [facultyRef, setFacultyRef] = useState(() => chosen('professor'));
  const [roomKey, setRoomKey] = useState(() => chosen('room'));
  const [day, setDay] = useState('');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const filtered = classes.filter(cls =>
    (!sectionId || String(cls.sectionId) === sectionId)
    && (!facultyRef || (facultyRef === NO_PROFESSOR ? !cls.facultyRef : String(cls.facultyRef) === facultyRef))
    && (!roomKey || (roomKey === NO_ROOM ? !cls.roomKey : String(cls.roomKey) === roomKey))
    && (!day || cls.day === day)
    && (!q || [cls.subjectCode, cls.subjectTitle, cls.sectionLabel, professorLine(cls), roomName(cls)].some(v => String(v || '').toLowerCase().includes(q))));
  const { sorted, sort, toggle } = useSort(filtered, SORT_GETTERS, FIRST_SORT[view] || 'section');
  const { pageItems, currentPage, totalPages, setPage, resetPage, rangeLabel } = usePagination(sorted, PAGE_SIZE);
  const anyFilter = Boolean(sectionId || facultyRef || roomKey || day || q);
  const clearFilters = () => { setSectionId(''); setFacultyRef(''); setRoomKey(''); setDay(''); setQuery(''); resetPage(); };
  const columns = editable ? 8 : 7;

  return (
    // tabIndex -1: the page puts the focus here when the class a closed move panel came from is no
    // longer on this page of the list.
    <section aria-label="All classes of this version" data-testid="views-list-region" tabIndex={-1} className="space-y-4 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="list-filter-section" className={labelClass}>Section</label>
          <Select id="list-filter-section" data-testid="list-filter-section" value={sectionId} onChange={(e) => { setSectionId(e.target.value); resetPage(); }} className={selectClass}>
            <option value="">All sections</option>
            {sections.map(s => <option key={s.id} value={String(s.id)}>{s.label || s.code}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="list-filter-professor" className={labelClass}>Professor</label>
          <Select id="list-filter-professor" data-testid="list-filter-professor" value={facultyRef} onChange={(e) => { setFacultyRef(e.target.value); resetPage(); }} className={selectClass}>
            <option value="">All professors</option>
            {faculty.map(f => <option key={f.id} value={String(f.id)}>{f.label || f.name}</option>)}
            <option value={NO_PROFESSOR}>TBA (no professor)</option>
          </Select>
        </div>
        <div>
          <label htmlFor="list-filter-day" className={labelClass}>Day</label>
          <Select id="list-filter-day" data-testid="list-filter-day" value={day} onChange={(e) => { setDay(e.target.value); resetPage(); }} className={selectClass}>
            <option value="">All days</option>
            {DAY_NAMES.map(d => <option key={d} value={d}>{d}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="list-filter-room" className={labelClass}>Room</label>
          <Select id="list-filter-room" data-testid="list-filter-room" value={roomKey} onChange={(e) => { setRoomKey(e.target.value); resetPage(); }} className={selectClass}>
            <option value="">All rooms</option>
            {rooms.map(r => <option key={r.key} value={String(r.key)}>{r.name}</option>)}
            <option value={NO_ROOM}>No room (TBA or online)</option>
          </Select>
        </div>
        <div className="flex-1 min-w-48 max-w-sm">
          <label htmlFor="list-search" className={labelClass}>Search classes</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={15} aria-hidden="true" />
            <input
              id="list-search"
              data-testid="list-search"
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); resetPage(); }}
              placeholder="Subject, title, section, professor or room…"
              className="w-full bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 pl-9 pr-3 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
            />
          </div>
        </div>
        {anyFilter && (
          <button
            type="button"
            data-testid="list-clear"
            onClick={clearFilters}
            className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            Clear the filters
          </button>
        )}
        {renderActions && <div className="ml-auto">{renderActions(sorted, { anyFilter })}</div>}
      </div>

      <div className="overflow-x-auto custom-scrollbar rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#18181b]">
        <table data-testid="views-list" className="w-full text-left text-sm">
          <thead className="bg-slate-50 dark:bg-[#1a1a1c] border-b border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 text-xs uppercase">
            <tr>
              <SortableHeader label="Section" sortKey="section" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Day" sortKey="day" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Time" sortKey="time" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Subject" sortKey="subject" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Title" sortKey="title" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Professor" sortKey="professor" sort={sort} onSort={toggle} className="px-3! py-3!" />
              <SortableHeader label="Room" sortKey="room" sort={sort} onSort={toggle} className="px-3! py-3!" />
              {editable && <th scope="col" className={`px-3 py-3 text-right ${STICKY_CELL} bg-slate-50 dark:bg-[#1a1a1c]`}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {pageItems.length === 0 ? (
              <tr>
                <td colSpan={columns} data-testid="list-empty" className="p-8 text-center text-xs text-slate-600 dark:text-slate-300">
                  {classes.length === 0 ? 'This version has no classes.' : 'No class matches these filters.'}
                  {anyFilter && (
                    <button type="button" data-testid="list-empty-clear" onClick={clearFilters} className="ml-2 font-bold underline text-violet-700 dark:text-violet-300 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                      Clear the filters
                    </button>
                  )}
                </td>
              </tr>
            ) : pageItems.map(cls => (
              <tr key={cls.itemId} data-testid={`list-row-${cls.itemId}`} className="group hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                <td className="px-3 py-2.5 text-xs font-bold text-slate-800 dark:text-white whitespace-nowrap">{cls.sectionLabel}</td>
                <td className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">{cls.day}</td>
                <td className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">{timeRangeLabel(cls.startTime, cls.endTime)}</td>
                <td className="px-3 py-2.5 text-xs font-bold text-slate-800 dark:text-white whitespace-nowrap">{codeLine(cls)}</td>
                <td className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-300 min-w-40">{cls.subjectTitle}</td>
                <td className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-300">{professorLine(cls)}</td>
                <td data-testid="list-room" className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-300">{roomName(cls)}</td>
                {editable && (
                  <td className={`px-3 py-2.5 text-right whitespace-nowrap ${STICKY_CELL} bg-white dark:bg-[#18181b] group-hover:bg-slate-50 dark:group-hover:bg-[#232326] transition-colors`}>
                    {cls.isFixed ? (
                      <span className="text-[11px] text-slate-600 dark:text-slate-300">Fixed (NSTP block)</span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`list-move-${cls.itemId}`}
                        onClick={() => onMove(cls)}
                        disabled={Boolean(moveBlockedReason)}
                        title={moveBlockedReason || undefined}
                        aria-describedby={moveBlockedReason && moveReasonId ? moveReasonId : undefined}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-slate-100 enabled:hover:bg-violet-600 text-slate-800 enabled:hover:text-white dark:bg-slate-800 dark:text-slate-200 dark:enabled:hover:bg-violet-600 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                      >
                        Move this class
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3 justify-between items-center text-xs text-slate-600 dark:text-slate-300">
        <span data-testid="list-count">Showing {rangeLabel} of {filtered.length} class{filtered.length === 1 ? '' : 'es'}.</span>
        <TablePagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} label="Class list pages" showSync={false} />
      </div>
    </section>
  );
}
