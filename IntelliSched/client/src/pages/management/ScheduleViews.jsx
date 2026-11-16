import { useCallback, useEffect, useRef, useState } from 'react';
import { versionName } from '../../utils/scheduleDisplay';
import {
  AlertOctagon, CalendarDays, CheckCircle2, DoorOpen, FileSpreadsheet, Layers, List, Loader2, Lock, Play, RefreshCw, RotateCcw, ShieldCheck,
  Table2, User, X
} from 'lucide-react';
import api from '../../services/api';
import { useTerm } from '../../context/term';
import usePermission from '../../hooks/usePermission';
import PageHeader from '../../components/layout/PageHeader';
import PermissionNote from '../../components/ui/PermissionNote';
import WeeklyTable from '../../components/schedule/WeeklyTable';
import EntityPicker from '../../components/schedule/EntityPicker';
import TbaRoomsToRequest from '../../components/schedule/TbaRoomsToRequest';
import MoveClassPanel from '../../components/schedule/MoveClassPanel';
import ChangeProfessorPanel from '../../components/schedule/ChangeProfessorPanel';
import SwapClassPanel from '../../components/schedule/SwapClassPanel';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import FillTbaRoomsPanel from '../../components/schedule/FillTbaRoomsPanel';
import ClassListView from '../../components/schedule/ClassListView';
import { ExportThisPage } from '../../components/print/ExportControls';
import { byDayAndStart, roomHoursText, termFileText } from '../../components/print/printForms';
import { DAY_NAMES, dayWindow, fromMinutes, gridTimes, slotOfTime, toMinutes } from '../../utils/timeGrid';
import {
  classLines, classSummary, codeLine, dayTotalsRow, hoursText, isTbaRoomKey, loadRangeLine, sectionWeeksNote, standardLoadLine, summaryValue, tbaRoomName, tbaRoomWording,
  weekGroupWords, timeRangeLabel, unplacedText
} from '../../utils/scheduleDisplay';
import { dutyBlocks, practicumBlocks, unavailableBlocks } from '../../utils/scheduleBlocks';
import { csvFileName, downloadScheduleCsv } from '../../utils/scheduleCsv';
import useDataChanges from '../../hooks/useDataChanges';
import Select from '../../components/ui/Select';

// Schedule Views & Editor (Phase 3 Step 1). One page for the three outputs of one schedule version,
// all read from the same schedule records: the Mother Schedule (per section), the Teachers' Program
// (per professor) and the Room Program (per room), drawn on the shared class-schedule table, plus a
// List view of every class. The Teachers' Program also shows the professor's header facts, the
// ancillary duty blocks, the day totals and the load summary of the SF-029 (Step 2). A lecture held
// online reads "Online" and takes no room in the editor; the Mother Schedule and the Teachers' Program
// list the self-paced online lectures under the table (Step 7). "Download CSV"
// saves the classes the view shows: the chosen section's, professor's or room's, or in the List view
// the rows its filters keep (Step 3). In a Draft a class can be moved: each choice of day, start or
// room is checked by the gateway's validator as it is made, the table previews the move (and any
// clash), and only an allowed move can be saved.
// Everything comes from GET /api/schedule/outputs (the gateway joins the version's classes with
// their subjects, sections, professors and rooms and computes every number, the load included); this
// page only shows it.
//
// "Fill TBA rooms" (Phase 4 Part 1, Step 1), from the Room Program's "TBA rooms to request" box of a
// Draft: the classes in TBA rooms go into real rooms with free time at the same day and time (the
// gateway plans and checks the moves; nothing is saved by the preview), saved as a NEW Draft that this
// page then opens; the shown Draft stays as it is.
//
// Props (Dashboard navParams): scheduleId (the version to open; else the newest Draft), initialView
// ('section' | 'professor' | 'room'), initialEntityKey (the section, professor or room to show),
// initialFill (open "Fill TBA rooms" at once, when the version is a Draft with classes in TBA rooms).

const VIEWS = [
  { id: 'section', label: 'Mother Schedule', noun: 'section', nounPlural: 'sections', icon: Layers },
  { id: 'professor', label: "Teachers' Program", noun: 'professor', nounPlural: 'professors', icon: User },
  { id: 'room', label: 'Room Program', noun: 'room', nounPlural: 'rooms', icon: DoorOpen }
];
const VIEW_IDS = VIEWS.map(v => v.id);

// Each change in the move form is checked this long after the last one.
const CHECK_DELAY_MS = 250;
const CONNECTION_HELP = 'Check that the gateway is running, then press "Try again".';
const YEAR_WORDS = { 1: '1st year', 2: '2nd year', 3: '3rd year', 4: '4th year' };
const EMPLOYMENT_WORDS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time' };
const ROOM_TYPE_WORDS = { LAB: 'lab', LEC: 'lecture' };
const ROOM_GROUPS = { CCS: 'CCS rooms', BORROWED: 'Borrowed rooms', TBA: 'TBA rooms to request' };
const STATUS_BADGE = {
  Draft: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
  'Under Review': 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
  Approved: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-500/10 dark:text-green-300 dark:border-green-500/20'
};
const OTHER_BADGE = 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';

// The page's one read: the version's classes joined by the gateway, with its policy and rooms.
const fetchOutputs = async (academicYear, semester, scheduleId) => {
  const res = await api.get('/schedule/outputs', {
    params: { academicYear, semester, prefer: 'draft', ...(scheduleId ? { scheduleId } : {}) }
  });
  const d = res.data;
  if (!d?.success || !d.schedule?.id || !Array.isArray(d.classes)) {
    throw new Error('the gateway answered without a schedule');
  }
  // The table and the move form follow the version's policy; nothing is assumed without it.
  const p = d.policy;
  if (!p?.dayStart || !p.dayEnd || !(Number(p.slotMinutes) > 0) || !p.saturdayOverflow || !p.nstp) {
    throw new Error("the gateway answered without the schedule's day window");
  }
  return {
    schedule: d.schedule,
    policy: d.policy,
    classes: d.classes,
    sections: Array.isArray(d.sections) ? d.sections : [],
    faculty: Array.isArray(d.faculty) ? d.faculty : [],
    rooms: Array.isArray(d.rooms) ? d.rooms : [],
    tbaRequest: d.tbaRequest || null,
    settings: d.settings || {}
  };
};

// What a failed read shows: the no-schedule state (no version at all, or none that opens here: only
// versions in the older format or archived ones), or an error with the way out (the way to generate
// one is Generate Schedule).
const loadErrorOf = (err) => {
  const status = err.response?.status;
  const body = err.response?.data || {};
  if (status === 404 && body.code === 'NO_SCHEDULE') return { kind: 'empty', reason: 'none' };
  if (status === 404 && body.code === 'NO_OPEN_VERSION') {
    return { kind: 'empty', reason: 'no-open', message: body.message || "None of this term's versions can be shown here. Generate a new Draft on the Generate Schedule page." };
  }
  if ((status === 404 && body.code === 'VERSION_NOT_IN_TERM') || (status === 409 && body.code === 'LEGACY_VERSION')) {
    return { kind: 'error', fix: 'newest', message: body.message || 'This version cannot be shown for this term.' };
  }
  return { kind: 'error', fix: 'retry', message: `The schedule could not be loaded (${body.message || err.message}). ${CONNECTION_HELP}` };
};

const countText = (n) => `${n} class${n === 1 ? '' : 'es'}`;

// "Check the whole schedule": the real validator on a version as it is (nothing saved).
const checkWholeVersion = async (scheduleId) => {
  const res = await api.post('/schedule/validate', { scheduleId });
  return {
    checkedAt: res.data?.checkedAt,
    hardTotal: Number(res.data?.hardTotal) || 0,
    violations: Array.isArray(res.data?.violations) ? res.data.violations : []
  };
};

// Days a class may be moved to under the version's policy: the weekdays, the NSTP day, Saturday when
// its overflow is on, plus the class's current day. Calendar order.
const editorDays = (policy, currentDay) => {
  const days = new Set([...(policy.weekdays || []), policy.nstp?.day, currentDay]);
  if (policy.saturdayOverflow?.enabled) days.add('Saturday');
  return DAY_NAMES.filter(d => days.has(d));
};

// Start times on a day where the class (its length never changes) still fits the policy's window.
const startTimesFor = (policy, day, durationSlots) => {
  const w = dayWindow(policy, day);
  if (!w) return [];
  const last = fromMinutes(toMinutes(w.end) - durationSlots * policy.slotMinutes);
  return gridTimes(w.start, last, policy.slotMinutes);
};

// The room choices of the move form: the CCS and borrowed rooms and the TBA rooms under their TBA
// names. A disabled room is never a choice; only a class already in one sees it, as its current room.
// A lecture held online (Phase 3 Step 7) takes no room: it has no room choice besides "Online (no
// room)", the form's own first option (MoveClassPanel).
const roomGroupsFor = (rooms, cls) => {
  if (cls.roomKind === 'ONLINE') return [];
  const current = cls.roomKey ? String(cls.roomKey) : '';
  const typeWord = (r) => ROOM_TYPE_WORDS[r.type] || 'room';
  const real = (kind) => rooms
    .filter(r => r.kind === kind && (r.isActive !== false || String(r.key) === current))
    .map(r => ({ value: String(r.key), label: `${r.name} (${typeWord(r)})${r.isActive === false ? ' – current room, disabled' : ''}` }));
  const groups = [
    { label: 'CCS rooms', options: real('CCS') },
    { label: 'Borrowed rooms', options: real('BORROWED') },
    { label: 'TBA rooms to request', options: rooms.filter(r => r.kind === 'TBA').map(r => ({ value: String(r.key), label: r.name || tbaRoomName(r.key) })) }
  ].filter(g => g.options.length);
  if (current && !groups.some(g => g.options.some(o => o.value === current))) {
    groups.push({ label: 'Current room', options: [{ value: current, label: `${cls.extraRoomKey ? tbaRoomName(cls.extraRoomKey) : cls.roomName || 'Current room'} (current room)` }] });
  }
  return groups;
};

// The class as it would be after the move (for the preview block on the table).
const movedCopy = (cls, form, room, endTime) => ({
  ...cls,
  day: form.day,
  startTime: form.start,
  endTime,
  roomKey: form.roomKey || null,
  roomId: room && room.kind !== 'TBA' ? room.roomId : null,
  extraRoomKey: room && room.kind === 'TBA' ? room.key : null,
  roomKind: !form.roomKey ? (cls.roomKind === 'ONLINE' ? 'ONLINE' : 'NO_ROOM') : room?.kind === 'TBA' ? 'TBA_ROOM' : room?.kind || cls.roomKind,
  roomName: room && room.kind !== 'TBA' ? room.name : null
});

// Where a class sits now, in the Dean's words ("Tuesday, 08:00 AM – 10:00 AM · ROOM 47").
const placeText = (cls) => {
  const room = cls.roomKind === 'TBA_ROOM' ? tbaRoomName(cls.extraRoomKey)
    : (cls.roomKind === 'CCS' || cls.roomKind === 'BORROWED') && cls.roomName ? cls.roomName
      : cls.roomKind === 'ONLINE' ? 'Online' : 'TBA (no CCS room needed)';
  return `${cls.day}, ${timeRangeLabel(cls.startTime, cls.endTime)} · ${room}`;
};

// The place a class was moved to, for the confirmation: the room by its name, a TBA room by its TBA
// name, "no room" for TBA (no CCS room needed), "online (no room)" for a lecture held online.
const movedToText = (cls, target, end, room) => {
  const where = !target.roomKey ? (cls.roomKind === 'ONLINE' ? 'online (no room)' : 'no room')
    : isTbaRoomKey(target.roomKey) ? tbaRoomName(target.roomKey)
      : room?.name || (String(cls.roomKey) === target.roomKey && cls.roomName) || 'the chosen room';
  return `${codeLine(cls)} moved to ${target.day} ${timeRangeLabel(target.start, end)}, ${where}.`;
};

// The heading above the table for the chosen section, professor or room. A section names its program,
// track and year ("BSCS · IS track · 1st year"; "BSIT · 1st year" when it has no track).
const entityHeading = (view, entity) => {
  const r = entity.record;
  if (view === 'section') {
    return {
      title: r.label || r.code,
      detail: [r.program, r.track && r.track !== 'NONE' ? `${r.track} track` : null, YEAR_WORDS[r.yearLevel], r.isActive === false ? 'not active' : null].filter(Boolean).join(' · '),
      // Phase 8: the note on the section's weeks (null while the odd/even practice is off).
      note: sectionWeeksNote(r.weekGroup)
    };
  }
  if (view === 'professor') {
    return { title: r.label || r.name, detail: [r.position, EMPLOYMENT_WORDS[r.employmentType], r.isActive === false ? 'not active' : null].filter(Boolean).join(' · ') };
  }
  if (r.kind === 'TBA') return { title: r.name || tbaRoomName(r.key), detail: 'To request from another department' };
  const kind = r.kind === 'BORROWED' ? 'Borrowed' : 'CCS';
  return { title: r.name, detail: `${kind} ${ROOM_TYPE_WORDS[r.type] || ''} room${r.kind === 'BORROWED' ? ', available at set times' : ''}${r.isActive === false ? ' · disabled' : ''}` };
};

const versionFacts = (s) => {
  const parts = [];
  if (s.generated) {
    parts.push(s.finalHard === 0 ? 'Generated with no conflicts.'
      : Number.isFinite(s.finalHard) ? `Generated with ${s.finalHard} conflict${s.finalHard === 1 ? '' : 's'}.` : 'Generated by a run.');
  }
  // A Draft made by "Fill TBA rooms" names the Draft it was filled from (GET /schedule/outputs filledFrom).
  const filled = s.filledFrom;
  if (filled?.version) parts.push(`TBA rooms filled from ${versionName(filled.version)}${Number.isFinite(filled.classCount) ? ` (${countText(filled.classCount)} moved into real rooms)` : ''}.`);
  const moves = Number(s.editedAfterRun) || 0;
  if (moves > 0) parts.push(`${moves} class move${moves === 1 ? '' : 's'} since then.`);
  return parts.join(' ');
};

const clockOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');

// Why the classes of a version that is not a Draft can't be moved: the gateway's own words when it
// refuses such a move (409 READ_ONLY_VERSION), so the page and the gateway say the same (Phase 3 Step 5).
// Phase 8 Part 6: an Approved version is final (there is no Publish): restore it to change it.
const readOnlyNote = (status) => (status === 'Approved'
  ? "This version is Approved: classes can't be moved. Restore it to make a new Draft."
  : `This version is ${status || 'not a Draft'}: classes can't be moved. Open a Draft to move classes.`);

// ---------------------------------------------------------------- "Fill TBA rooms" (Phase 4 Part 1, Step 1)
// The panel's state: open; ticked (the Set of room ids to fill; null = every room, the default);
// preview (the gateway's answer: moves, byRoom, emptiedTbaRooms, classCount, hoursMoved, previewHash,
// message); previewing; error and errorLines (what a failed preview or save answered); confirm (the
// "Save as a new Draft?" dialog); saving.
const FILL_CLOSED = { open: false, ticked: null, preview: null, previewing: false, error: '', errorLines: [], errorLink: null, confirm: false, saving: false };
const FILL_SAVE_FAILED = 'The rooms could not be filled: the gateway did not answer. Try again.';
const FILL_PREVIEW_FAILED = 'The preview could not be made: the gateway did not answer. Try again.';

// A saved fill is opened as the new Draft (Dashboard mounts this page afresh for the new address): the
// confirmation waits here for that mount and is shown once the new Draft is read.
let handoffToast = null; // { scheduleId, message }

// ---------------------------------------------------------------- the Teachers' Program (Step 2)
// The professor's header facts, in the SF-029's two info columns (left the professor, right the
// college and the subjects), as the gateway sends them (the profile, and the version's own
// assignments for the subjects). An empty fact shows "—", never a placeholder.
const TP_FACTS = [
  [
    { key: 'name', label: 'Name', of: h => h.name },
    { key: 'position', label: 'Position', of: h => h.position },
    { key: 'employment', label: 'Employment type', of: h => h.employmentLabel },
    { key: 'major', label: 'Major/Minor', of: h => h.majorMinor },
    { key: 'cocurricular', label: 'Co-Curricular Activities', of: h => h.coCurricular }
  ],
  [
    { key: 'college', label: 'College', of: h => h.college },
    { key: 'subjects', label: 'Subject Taught', of: h => (Array.isArray(h.subjectsTaught) ? h.subjectsTaught.join(', ') : h.subjectsTaught) },
    { key: 'preparations', label: 'Preparation', of: h => h.preparations }
  ]
];
const factText = (value) => (value === null || value === undefined || String(value).trim() === '' ? '—' : String(value));

function TeachersProgramFacts({ header }) {
  return (
    <div data-testid="tp-header" className="grid md:grid-cols-2 gap-x-8 gap-y-1.5 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#18181b]">
      {TP_FACTS.map((column, c) => (
        <dl key={c} className="space-y-1.5 min-w-0">
          {column.map(fact => {
            const text = factText(fact.of(header));
            return (
              <div key={fact.key} className="flex gap-3">
                <dt className="w-40 shrink-0 pt-0.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">{fact.label}</dt>
                <dd data-testid={`tp-header-${fact.key}`} data-empty={text === '—' ? 'true' : undefined} className="min-w-0 break-words text-sm font-semibold text-slate-900 dark:text-white">{text}</dd>
              </div>
            );
          })}
        </dl>
      ))}
    </div>
  );
}

// The duty hours the grid had no free time for; the summary still counts them.
function TeachersProgramUnplaced({ unplaced }) {
  return (
    <div data-testid="tp-unplaced" role="note" className="p-3.5 rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-xs text-amber-900 dark:text-amber-200">
      <ul className="space-y-0.5 font-bold">
        {unplaced.map((item, i) => <li key={`${item.type}-${i}`} data-testid={`tp-unplaced-${i}`}>{unplacedText(item)}</li>)}
      </ul>
      <p className="mt-1">No free weekday time was left for these hours after the classes, the unavailable times and the lunch hour. The load summary still counts every hour.</p>
    </div>
  );
}

// "Online (self-paced)" under the table (Phase 3 Step 7): the Major lectures of the section or the
// professor shown that are held online at the student's own pace, as the gateway lists them (selfPaced:
// code, title, hours, and the professor in the Mother Schedule or the section in the Teachers'
// Program). They have no day, time or room, so they are never drawn on the table; in the Teachers'
// Program their hours still count in the load summary.
function SelfPacedList({ rows, view }) {
  const forProfessor = view === 'professor';
  return (
    <section data-testid="views-selfpaced" aria-labelledby="views-selfpaced-title" className="max-w-3xl">
      <h4 id="views-selfpaced-title" className="text-sm font-black text-slate-900 dark:text-white">Online (self-paced)</h4>
      <p className="mt-0.5 mb-2 text-xs text-slate-600 dark:text-slate-300">
        These lectures have no day, time or room, so they are not on the table.{forProfessor ? ' Their hours count in the load summary.' : ''}
      </p>
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#18181b] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-white/5">
            <tr>
              <th scope="col" className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">Subject</th>
              <th scope="col" className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">Title</th>
              <th scope="col" className="px-4 py-2 text-right text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">Hours per week</th>
              <th scope="col" className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">{forProfessor ? 'Section' : 'Professor'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.subjectId}-${row.sectionLabel}-${i}`} data-testid="views-selfpaced-row" className="border-t border-slate-200 dark:border-slate-800">
                <th scope="row" className="px-4 py-1.5 text-left font-black text-slate-900 dark:text-white whitespace-nowrap">{row.subjectCode}</th>
                <td className="px-4 py-1.5 text-slate-800 dark:text-slate-100">{row.subjectTitle}</td>
                <td className="px-4 py-1.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white whitespace-nowrap">{hoursText(row.hours)}</td>
                <td className="px-4 py-1.5 text-slate-800 dark:text-slate-100">{forProfessor ? row.sectionLabel : row.facultyName || 'TBA'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// The load summary, line for line as on the SF-029, in the gateway's order and with its numbers (the
// one load rule every page uses): the ancillary areas, the lecture hours, the lab line
// ("15 × .75 = 11.25"), practicum coordination when there is one, then the teaching load, the total
// and the Excess (blank when none).
const SUMMARY_TOTAL_KEYS = new Set(['TEACHING', 'TOTAL', 'EXCESS']);

function TeachersProgramSummary({ summary }) {
  return (
    <section data-testid="tp-summary" aria-labelledby="tp-summary-title" className="max-w-xl">
      <h4 id="tp-summary-title" className="text-sm font-black text-slate-900 dark:text-white">Load summary</h4>
      <p className="mt-0.5 mb-2 text-xs text-slate-600 dark:text-slate-300">
        Hours per week, as on the Teachers&apos; Program form: lab hours count at the lab factor of the employment type. The day totals under the table count them the same way, as the real forms do.
      </p>
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#18181b] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-white/5">
            <tr>
              <th scope="col" className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">Area</th>
              <th scope="col" className="px-4 py-2 text-right text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">Hours per week</th>
            </tr>
          </thead>
          <tbody>
            {summary.map(line => {
              const weight = SUMMARY_TOTAL_KEYS.has(line.key) ? 'font-black' : 'font-semibold';
              return (
                <tr key={line.key} data-testid={`tp-summary-${line.key}`} className={`border-t ${line.key === 'TEACHING' ? 'border-slate-400 dark:border-slate-500' : 'border-slate-200 dark:border-slate-800'}`}>
                  <th scope="row" className={`px-4 py-1.5 text-left ${weight} text-slate-800 dark:text-slate-100`}>{line.label}</th>
                  <td data-testid={`tp-summary-${line.key}-value`} className={`px-4 py-1.5 text-right tabular-nums ${weight} text-slate-900 dark:text-white`}>{summaryValue(line)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// "Download CSV" (Phase 3 Step 3): the classes the view shows, as saved, as a spreadsheet file
// (utils/scheduleCsv.js). It is off and says why while a move is saved or the version is read again
// after it, or when that reading failed (busyReason: the table may still show the old places), and
// when there is no class to download.
function CsvButton({ count, blockedReason, busyReason = '', onDownload }) {
  const blocked = busyReason || (count > 0 ? '' : blockedReason);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="views-csv"
        onClick={onDownload}
        disabled={Boolean(blocked)}
        aria-describedby={blocked ? 'views-csv-reason' : undefined}
        title={blocked || (count === 1 ? 'Download this class as CSV' : `Download these ${count} classes as CSV`)}
        className="shrink-0 inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] enabled:hover:bg-slate-100 dark:enabled:hover:bg-slate-800"
      >
        <FileSpreadsheet size={14} className="mr-1.5" aria-hidden="true" /> Download CSV
      </button>
      {blocked && <p id="views-csv-reason" data-testid="views-csv-reason" className="text-[11px] text-slate-600 dark:text-slate-300 text-right">{blocked}</p>}
    </div>
  );
}

// The visible reason (Phase 3 Step 6) why this role may not move classes in a Draft.
const MOVE_NOTE_ID = 'views-move-permission-note';

export default function ScheduleViews({ scheduleId = null, initialView = null, initialEntityKey = null, initialFill = false, onNavigate = null }) {
  const { activeAcademicYear, activeSemesterNumber } = useTerm();
  // "Move this class" in a Draft: the permission map's schedule.move. Viewing, printing and the CSV
  // download are open to every role.
  const movePermission = usePermission('schedule.move');
  // "Change professor" (Phase 4 Part 2) is a faculty decision: the permission map's faculty.assign.
  const assignPermission = usePermission('faculty.assign');
  // Asked to open "Fill TBA rooms" without a view, the page starts on the Room Program, where it lives.
  const startView = VIEW_IDS.includes(initialView) ? initialView : initialFill ? 'room' : 'section';

  // ---------------------------------------------------------------- the version shown
  const [request, setRequest] = useState({ scheduleId: scheduleId || null, n: 0 });
  const [result, setResult] = useState({ status: 'loading', data: null, error: null, refreshing: false, refreshError: '' });

  // ---------------------------------------------------------------- toast
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message, tone = 'success') => {
    setToast({ message, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), tone === 'error' ? 7000 : 5000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  useEffect(() => {
    let active = true;
    fetchOutputs(activeAcademicYear, activeSemesterNumber, request.scheduleId)
      .then(data => {
        if (!active) return;
        setResult({ status: 'ready', data, error: null, refreshing: false, refreshError: '' });
        // The confirmation of a fill saved just before this mount (handoffToast), once its Draft is read.
        if (handoffToast && String(handoffToast.scheduleId) === String(data.schedule.id)) {
          const { message } = handoffToast;
          handoffToast = null;
          showToast(message);
        }
      })
      .catch(err => {
        if (!active) return;
        const error = loadErrorOf(err);
        // A reload after a save that fails keeps the schedule on screen and says so.
        setResult(prev => (prev.refreshing && prev.data
          ? { ...prev, refreshing: false, refreshError: error.message || 'The schedule could not be reloaded.' }
          : { status: error.kind, data: null, error, refreshing: false, refreshError: '' }));
      });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber, request, showToast]);

  // The term's versions for the selector: those with classes, saved in the current format. Read again
  // with "Reload" (versionsNonce).
  const [versions, setVersions] = useState({ list: [], failed: false });
  const [versionsNonce, setVersionsNonce] = useState(0);
  useEffect(() => {
    let active = true;
    api.get('/schedule/versions', { params: { academicYear: activeAcademicYear, semester: activeSemesterNumber } })
      .then(res => {
        if (!active) return;
        const list = Array.isArray(res.data?.versions) ? res.data.versions : [];
        setVersions({ list: list.filter(v => !v.legacy && v.totalScheduled > 0 && v.mongoId), failed: false });
      })
      .catch(() => { if (active) setVersions({ list: [], failed: true }); });
    return () => { active = false; };
  }, [activeAcademicYear, activeSemesterNumber, versionsNonce]);

  // ---------------------------------------------------------------- view, entity, display
  const [view, setView] = useState(startView);
  const [mode, setMode] = useState('table');
  const [entityKeys, setEntityKeys] = useState(() => ({
    section: null, professor: null, room: null, ...(initialEntityKey ? { [startView]: String(initialEntityKey) } : {})
  }));
  const [search, setSearch] = useState('');
  // Phase 8 (odd and even weeks): the Room Program's filter, like the office's two files. 'both'
  // shows the whole room; a class without a group meets every week, so it shows under either.
  const [weekFilter, setWeekFilter] = useState('both');
  const tabRefs = useRef({});

  // ---------------------------------------------------------------- move form and checks
  // move: { itemId, day, start, roomKey, reason, from: { day, start, roomKey }, origin } (from: the
  // class's place when the form was opened; origin: 'table' or 'list', where it was opened from).
  const [move, setMove] = useState(null);
  const [moveCheck, setMoveCheck] = useState(null); // { key, allowed, violations, message, failed? }
  const [checkNonce, setCheckNonce] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // Phase 4 Part 2: the two other edits of a class, opened from the move panel. Only one of the three
  // panels is open at a time, for one class (`move` names it; `edit` says which panel shows).
  //   edit: null | { kind: 'professor' | 'swap' }
  //   professorEdit: { status: 'loading' | 'ready' | 'error', message, retry, ...the gateway's answer,
  //                    verdicts (recommended first), rankingNote, chosen: facultyRef | null | undefined, reason, confirm }
  //   swapEdit: { withId: itemId | null, check: { key, ...the gateway's answer } | null, nonce }
  const [edit, setEdit] = useState(null);
  const [professorEdit, setProfessorEdit] = useState(null);
  const [swapEdit, setSwapEdit] = useState(null);
  const [professorNonce, setProfessorNonce] = useState(0);
  // { data, checkedAt, hardTotal, violations } or, when an automatic check failed, { data, failed }.
  const [fullCheck, setFullCheck] = useState(null);
  const [isCheckingAll, setIsCheckingAll] = useState(false);
  // When the move panel closes or its move is saved, the focus goes back to where it was opened
  // ({ itemId, from }), once the version is read again after a save.
  const pendingFocusRef = useRef(null);
  // A saved move (or "Reload") while a whole-schedule check was on screen checks the version again
  // once it is read again.
  const recheckRef = useRef(false);

  // ---------------------------------------------------------------- "Fill TBA rooms"
  // Opened from the "TBA rooms to request" box, or at once when the page was asked to (initialFill);
  // it shows only on the Room Program of a Draft with classes in TBA rooms (see fillPanelShown).
  const [fill, setFill] = useState(() => (initialFill ? { ...FILL_CLOSED, open: true } : FILL_CLOSED));

  // After the move panel closes (Cancel, ×, Escape, or a save once the version is read again): the
  // focus goes back to the class's block (or its List view button); to the table (or the list) when
  // the class has left this view. Runs after every render; it waits while the version is reloaded.
  useEffect(() => {
    const want = pendingFocusRef.current;
    if (!want || result.refreshing) return;
    pendingFocusRef.current = null;
    if (result.status !== 'ready') return;
    const own = document.querySelector(`[data-testid="${want.from === 'list' ? 'list-move' : 'views-block'}-${want.itemId}"]`);
    const fallback = document.querySelector(want.from === 'list' ? '[data-testid="views-list-region"]' : '[data-testid="views-table"]');
    (own?.matches('button:not(:disabled)') ? own : fallback)?.focus();
  });

  // The whole-schedule check again, on the version as it was just read (see recheckRef).
  useEffect(() => {
    if (!recheckRef.current || result.refreshing || result.status !== 'ready' || !result.data) return undefined;
    recheckRef.current = false;
    const checked = result.data;
    let active = true;
    checkWholeVersion(checked.schedule.id)
      .then(found => { if (active) setFullCheck({ data: checked, ...found }); })
      .catch(err => {
        if (active) setFullCheck({ data: checked, failed: `The schedule could not be checked again (${err.response?.data?.message || err.message}). Press "Check the whole schedule" to try again.` });
      })
      .finally(() => setIsCheckingAll(false));
    return () => { active = false; };
  }, [result]);

  // ---------------------------------------------------------------- what is on screen
  const data = result.data;
  const schedule = data?.schedule || null;
  const policy = data?.policy || null;
  const campusCode = data?.settings?.campusCode || '';
  const editable = Boolean(schedule?.editable);
  // A Draft's classes can be moved, by a role the map allows (the gateway checks the same action).
  const canMove = editable && movePermission.allowed;
  const viewMeta = VIEWS.find(v => v.id === view);

  // Professors are told apart by id; two who share a name also show their codes ("Name (FAC-007)").
  const nameCount = new Map();
  (data?.faculty || []).forEach(f => nameCount.set(f.name, (nameCount.get(f.name) || 0) + 1));
  const faculty = (data?.faculty || []).map(f => ({ ...f, label: nameCount.get(f.name) > 1 && f.facultyId ? `${f.name} (${f.facultyId})` : f.name }));
  const entitiesByView = data ? {
    section: data.sections.map(s => ({ key: String(s.id), label: s.label || s.code, detail: countText(s.classCount || 0), record: s })),
    professor: faculty.map(f => ({ key: String(f.id), label: f.label, detail: countText(f.classCount || 0), record: f })),
    // Rooms: CCS, borrowed, then the TBA rooms that received classes (the gateway's order). The TBA
    // room on screen stays listed when a move takes its last class away (0 classes).
    room: data.rooms.filter(r => r.kind !== 'TBA' || r.classCount > 0 || String(r.key) === entityKeys.room).map(r => ({
      key: String(r.key), label: `${r.name}${r.isActive === false ? ' (disabled)' : ''}`, detail: countText(r.classCount || 0), group: ROOM_GROUPS[r.kind] || '', record: r
    }))
  } : { section: [], professor: [], room: [] };
  const entities = entitiesByView[view];
  const current = entities.find(e => e.key === entityKeys[view]) || entities[0] || null;
  const weekGroupsOn = Boolean(data?.policy?.weekGroups?.enabled);
  const weekFilterShown = view === 'room' && mode === 'table' && weekGroupsOn;
  const belongs = (cls) => Boolean(current) && (view === 'section'
    ? String(cls.sectionId) === current.key
    : view === 'professor'
      ? cls.facultyRef != null && String(cls.facultyRef) === current.key
      : (cls.roomKey != null && String(cls.roomKey) === current.key
        && (!weekFilterShown || weekFilter === 'both' || !cls.weekGroup || cls.weekGroup === weekFilter)));

  // Why a class can't be chosen (nor the classes shown downloaded) right now: while a move is saved
  // and the version is read again after it (the table shows the old places until then), or when that
  // reading failed (the table may be out of date). The version selector is closed while a move is
  // saved or the version is reloaded.
  const selectionBlocked = isSaving ? 'Wait until the move is saved.'
    : fill.saving ? 'Wait until the new Draft is saved.'
      : result.refreshing ? 'Wait until the schedule is reloaded.'
        : result.refreshError ? 'The schedule could not be reloaded: press "Try again" above first.' : '';
  const versionBlocked = isSaving ? 'Wait until the move is saved.' : fill.saving ? 'Wait until the new Draft is saved.' : result.refreshing ? 'Wait until the schedule is reloaded.' : '';

  // The class being moved, looked up in the data shown (a reload may have changed or removed it).
  const movingCls = move && data && canMove ? data.classes.find(c => String(c.itemId) === String(move.itemId)) || null : null;
  const endOf = (start) => (movingCls && policy ? fromMinutes(toMinutes(start) + movingCls.durationSlots * policy.slotMinutes) : start);
  const dayOptions = movingCls ? editorDays(policy, movingCls.day) : [];
  const startOptions = movingCls ? startTimesFor(policy, move.day, movingCls.durationSlots) : [];
  // The form is compared with the place the class had when it was opened; if a reload shows the class
  // somewhere else, the form is out of date and nothing is checked or saved from it.
  const placeChanged = Boolean(movingCls) && (movingCls.day !== move.from.day || movingCls.startTime !== move.from.start
    || (movingCls.roomKey ? String(movingCls.roomKey) : '') !== move.from.roomKey);
  const unchanged = movingCls
    ? move.day === move.from.day && move.start === move.from.start && move.roomKey === move.from.roomKey
    : true;
  const startFits = Boolean(movingCls) && startOptions.includes(move.start);
  const pending = Boolean(movingCls) && !movingCls.isFixed && !placeChanged && !unchanged && startFits;
  // The move the validator answers for: a late answer for an earlier choice is never shown. A reload
  // (request.n) checks the choice again against what was read.
  const formKey = movingCls ? `${move.itemId}|${move.day}|${move.start}|${move.roomKey}#${checkNonce}@${request.n}` : '';
  const answer = moveCheck && moveCheck.key === formKey ? moveCheck : null;

  // Live check: the real validator with this one class moved (POST /schedule/validate; nothing saved).
  const shownId = schedule?.id || null;
  const checkItem = pending ? String(move.itemId) : null;
  const checkDay = pending ? move.day : null;
  const checkSlot = pending ? slotOfTime(policy, move.start) : null;
  const checkRoom = pending ? (move.roomKey || null) : null;
  useEffect(() => {
    if (!checkItem || !shownId) return undefined;
    const key = formKey;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const res = await api.post('/schedule/validate', { scheduleId: shownId, change: { itemId: checkItem, day: checkDay, startSlot: checkSlot, roomId: checkRoom } });
        if (!active) return;
        const allowed = res.data?.changeAllowed === true;
        setMoveCheck({
          key,
          allowed,
          violations: Array.isArray(res.data?.movedViolations) ? res.data.movedViolations : [],
          // Phase 8 Part 6 (decision 5): the gateway's warning when an allowed move leaves a
          // part-timer with only one class on a weekday (it names the professor and the day).
          warning: typeof res.data?.partTimerWarning === 'string' ? res.data.partTimerWarning : null,
          message: allowed ? 'This move is allowed.' : 'This move is not allowed:'
        });
      } catch (err) {
        if (!active) return;
        setMoveCheck({ key, allowed: false, failed: true, violations: [], message: `This move could not be checked (${err.response?.data?.message || err.message}). Check that the gateway is running, then press "Check again".` });
      }
    }, CHECK_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [formKey, shownId, checkItem, checkDay, checkSlot, checkRoom]);

  const checkView = !movingCls ? null
    : placeChanged ? { tone: 'invalid', message: `This class was changed after you opened it (now ${placeText(movingCls)}). Close this panel and open the class again.` }
      : unchanged ? { tone: 'idle', message: 'Choose a new day, start time or room. Each choice is checked right away.' }
        : !startFits ? { tone: 'invalid', message: `This start time does not fit ${move.day}. Choose one of the listed start times.` }
          : !answer ? { tone: 'checking', message: 'Checking this move…' }
            : answer.failed ? { tone: 'error', message: answer.message, retry: true }
              : answer.allowed ? { tone: 'ok', message: answer.message, warning: answer.warning || null }
                : { tone: 'error', message: answer.message, violations: answer.violations.map(v => tbaRoomWording(v.message)) };
  const saveBlockedReason = !movingCls ? ''
    : placeChanged ? 'This class was changed after you opened it: close this panel and open it again.'
      : unchanged ? 'Choose a new day, start time or room first.'
        : !startFits ? 'Choose a start time that fits this day.'
          : result.refreshing ? 'Wait until the schedule is reloaded.'
            : !answer ? 'Wait for the check of this move.'
              : answer.failed ? 'The move could not be checked yet: press "Check again".'
                : !answer.allowed ? 'This move is not allowed: choose another day, start time or room.'
                  : '';

  // Blocks to outline in red: those the check names for the move being previewed, else the
  // conflicts the last whole-version check found (for the data it checked).
  const checkShown = fullCheck && fullCheck.data === data ? fullCheck : null;
  const clashIds = new Set();
  if (pending && answer && !answer.allowed) answer.violations.forEach(v => (v.itemIds || []).forEach(id => clashIds.add(String(id))));
  else if (!pending && checkShown) (checkShown.violations || []).forEach(v => (v.itemIds || []).forEach(id => clashIds.add(String(id))));

  const roomByKey = new Map((data?.rooms || []).map(r => [String(r.key), r]));
  const previewCls = pending ? movedCopy(movingCls, move, roomByKey.get(move.roomKey), endOf(move.start)) : null;

  // ---------------------------------------------------------------- handlers
  // origin: 'table' (a class block) or 'list' (its "Move this class" button); the focus returns there.
  const openMove = (cls, origin = 'table') => {
    if (!canMove || selectionBlocked || String(move?.itemId) === String(cls.itemId)) return;
    const place = { day: cls.day, start: cls.startTime, roomKey: cls.roomKey ? String(cls.roomKey) : '' };
    setMove({ itemId: String(cls.itemId), ...place, reason: '', from: place, origin });
    setMoveCheck(null);
    setEdit(null);
    setProfessorEdit(null);
    setSwapEdit(null);
    setSaveError('');
  };
  // From the List view: the table then shows the class's own section, professor or room.
  const openMoveFromList = (cls) => {
    if (!canMove || selectionBlocked) return;
    const key = view === 'section' ? cls.sectionId : view === 'professor' ? cls.facultyRef : cls.roomKey;
    if (key != null) setEntityKeys(prev => ({ ...prev, [view]: String(key) }));
    openMove(cls, 'list');
  };
  // The focus goes back to where the panel of this move was opened from (after the next render).
  const returnFocus = (closing) => {
    pendingFocusRef.current = closing ? { itemId: String(closing.itemId), from: closing.origin } : null;
  };
  const closeMove = () => {
    if (isSaving) return;
    returnFocus(move);
    setMove(null);
    setEdit(null);
    setProfessorEdit(null);
    setSwapEdit(null);
    setSaveError('');
  };
  const changeMove = (patch) => {
    setMove(prev => (prev ? { ...prev, ...patch } : prev));
    setSaveError('');
  };

  // ---------------------------------------------------------------- Change professor (Phase 4 Part 2)
  // Why the action is closed for this class: the role (faculty.assign), or the class.
  const professorBlockedReason = !movingCls ? ''
    : !assignPermission.allowed ? assignPermission.reason
      : movingCls.isFixed || movingCls.isNstp ? "NSTP's professor is always TBA: there is no professor to change."
        : '';
  const swapBlockedReason = !movingCls ? '' : movingCls.isFixed ? 'The NSTP block is fixed by the Scheduling Policy and cannot be swapped.' : '';
  const openProfessor = () => {
    if (!movingCls || professorBlockedReason || isSaving) return;
    setEdit({ kind: 'professor' });
    setProfessorEdit({ status: 'loading', chosen: undefined, reason: '', confirm: false });
    setSaveError('');
  };
  const openSwap = () => {
    if (!movingCls || swapBlockedReason || isSaving) return;
    setEdit({ kind: 'swap' });
    setSwapEdit({ withId: null, check: null, nonce: 0 });
    setSaveError('');
  };
  const backToMove = () => {
    if (isSaving) return;
    setEdit(null);
    setProfessorEdit(null);
    setSwapEdit(null);
    setSaveError('');
  };
  const changeProfessorForm = (patch) => {
    setProfessorEdit(prev => (prev ? { ...prev, ...patch } : prev));
    setSaveError('');
  };
  // The second class of a swap: from the panel's list, or a click on a class block while the panel is open.
  const chooseSwapPartner = (itemId) => {
    if (isSaving) return;
    setSwapEdit(prev => (prev ? { ...prev, withId: itemId ? String(itemId) : null, check: null } : prev));
    setSaveError('');
  };
  const recheckSwap = () => setSwapEdit(prev => (prev ? { ...prev, check: null, nonce: prev.nonce + 1 } : prev));

  // The verdict of every professor on this class's pair, recommended first when the ranking service
  // has them (the professors are matched by their code; a Minor's ranking is the TBA pool, no ranks).
  useEffect(() => {
    if (edit?.kind !== 'professor' || !movingCls || !shownId) return undefined;
    let active = true;
    const sectionId = String(movingCls.sectionId);
    const subjectId = String(movingCls.subjectId);
    (async () => {
      let answer;
      try {
        const res = await api.post('/schedule/change-professor/check', { scheduleId: shownId, sectionId, subjectId });
        answer = res.data;
      } catch (err) {
        if (!active) return;
        const body = err.response?.data || {};
        setProfessorEdit(prev => ({ ...(prev || {}), status: 'error', retry: true, message: `The professors could not be checked (${body.message || err.message}). Check that the gateway is running, then press "Check again".` }));
        return;
      }
      let ranks = new Map();
      let rankingNote = '';
      if (!movingCls.isMinor) {
        try {
          const res = await api.post('/schedule/recommendations', { subjectId, subjectCode: movingCls.subjectCode, academicYear: activeAcademicYear, semester: activeSemesterNumber });
          (res.data?.candidates || []).forEach(c => { if (c.id && c.id !== 'TBA') ranks.set(String(c.id).toUpperCase(), { rank: Number(c.rank) || null, score: c.score, reason: c.reason || '' }); });
          if (!ranks.size) rankingNote = 'The ranking service returned no recommendation for this subject, so the professors are listed by name.';
        } catch {
          rankingNote = 'The ranking service did not answer, so the professors are listed by name (every verdict is still live).';
        }
      }
      if (!active) return;
      const verdicts = (answer.verdicts || []).map(v => {
        const r = v.facultyId ? ranks.get(String(v.facultyId).toUpperCase()) : null;
        return { ...v, rank: r?.rank || null, score: r?.score ?? null, rankReason: r?.reason || '' };
      });
      verdicts.sort((a, b) => (a.facultyRef === null ? -1 : b.facultyRef === null ? 1 : 0) || ((a.rank || 99) - (b.rank || 99)) || String(a.name).localeCompare(String(b.name), 'en'));
      setProfessorEdit(prev => ({
        ...(prev || {}),
        status: 'ready',
        message: '',
        changeText: answer.changeText,
        current: answer.pair?.current || null,
        tbaAllowed: Boolean(answer.tbaAllowed),
        newestDraft: answer.newestDraft !== false,
        notNewestMessage: answer.notNewestMessage || '',
        verdicts,
        rankingNote,
        mlTop1: verdicts.find(v => v.rank === 1) || null
      }));
    })();
    return () => { active = false; };
  }, [edit?.kind, movingCls?.itemId, shownId, professorNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // The live check of a swap (POST /schedule/swap/check; nothing saved); a late answer for an earlier
  // choice is never shown.
  useEffect(() => {
    if (edit?.kind !== 'swap' || !movingCls || !shownId || !swapEdit?.withId) return undefined;
    let active = true;
    const key = `${movingCls.itemId}|${swapEdit.withId}#${swapEdit.nonce}@${request.n}`;
    (async () => {
      try {
        const res = await api.post('/schedule/swap/check', { scheduleId: shownId, itemA: String(movingCls.itemId), itemB: swapEdit.withId });
        if (!active) return;
        setSwapEdit(prev => (prev ? { ...prev, check: { key, ...res.data } } : prev));
      } catch (err) {
        if (!active) return;
        const body = err.response?.data || {};
        setSwapEdit(prev => (prev ? { ...prev, check: { key, failed: true, message: `This swap could not be checked (${body.message || err.message}). Check that the gateway is running, then press "Check again".` } } : prev));
      }
    })();
    return () => { active = false; };
  }, [edit?.kind, movingCls?.itemId, shownId, swapEdit?.withId, swapEdit?.nonce, request.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosenVerdict = professorEdit?.status === 'ready' && professorEdit.chosen !== undefined
    ? (professorEdit.verdicts || []).find(v => (v.facultyRef ?? null) === (professorEdit.chosen ?? null)) || null
    : null;
  const professorSaveBlockedReason = !professorEdit ? ''
    : professorEdit.status !== 'ready' ? 'Wait for the check of every professor.'
      : professorEdit.notNewestMessage ? professorEdit.notNewestMessage
        : result.refreshing ? 'Wait until the schedule is reloaded.'
          : !chosenVerdict ? 'Choose a professor whose check says "Free at these times".'
            : !chosenVerdict.ok ? chosenVerdict.text
              : '';
  const swapKey = movingCls && swapEdit?.withId ? `${movingCls.itemId}|${swapEdit.withId}#${swapEdit.nonce}@${request.n}` : '';
  const swapAnswer = swapEdit?.check && swapEdit.check.key === swapKey ? swapEdit.check : null;
  const swapPartner = swapEdit?.withId && data ? data.classes.find(c => String(c.itemId) === swapEdit.withId) || null : null;
  const swapCheckView = !swapEdit ? null
    : !swapEdit.withId ? { tone: 'idle', message: 'Choose the class to swap with. The swap is checked right away.' }
      : !swapAnswer ? { tone: 'checking', message: 'Checking this swap…' }
        : swapAnswer.failed ? { tone: 'error', message: swapAnswer.message, retry: true }
          : swapAnswer.ok ? { tone: 'ok', message: 'Free at these times: both classes can be swapped.', places: swapAnswer.places, roomText: swapAnswer.roomText }
            : { tone: 'error', message: 'Not allowed: this swap would cause a conflict.', places: swapAnswer.places, roomText: swapAnswer.roomText, reasons: swapAnswer.reasons || [] };
  const swapSaveBlockedReason = !swapEdit ? ''
    : !swapEdit.withId ? 'Choose the class to swap with first.'
      : result.refreshing ? 'Wait until the schedule is reloaded.'
        : !swapAnswer ? 'Wait for the check of this swap.'
          : swapAnswer.failed ? 'The swap could not be checked yet: press "Check again".'
            : !swapAnswer.ok ? 'This swap is not allowed: choose another class.'
              : '';
  // The classes offered for a swap: the same section's, then the same professor's other classes.
  const swapCandidates = movingCls && data ? [
    { group: `Same section (${movingCls.sectionLabel})`, options: data.classes.filter(c => String(c.sectionId) === String(movingCls.sectionId) && String(c.itemId) !== String(movingCls.itemId) && !c.isFixed) },
    { group: `Same professor (${movingCls.facultyName || 'TBA'})`, options: movingCls.facultyRef ? data.classes.filter(c => c.facultyRef != null && String(c.facultyRef) === String(movingCls.facultyRef) && String(c.sectionId) !== String(movingCls.sectionId) && !c.isFixed) : [] }
  ].map(g => ({ group: g.group, options: g.options.map(c => ({ value: String(c.itemId), label: `${codeLine(c)} · ${c.sectionLabel} · ${c.day} ${timeRangeLabel(c.startTime, c.endTime)} · ${c.roomKind === 'TBA_ROOM' ? tbaRoomName(c.extraRoomKey) : c.roomName || (c.roomKind === 'ONLINE' ? 'Online' : 'TBA')}` })) })).filter(g => g.options.length) : [];

  const saveProfessor = async () => {
    if (!movingCls || !chosenVerdict || professorSaveBlockedReason || isSaving) return;
    const chosen = chosenVerdict;
    const target = move;
    const wasChecked = Boolean(checkShown);
    setIsSaving(true);
    setSaveError('');
    try {
      const mlTop1 = professorEdit.mlTop1;
      const res = await api.post('/schedule/change-professor', {
        scheduleId: schedule.id,
        sectionId: String(movingCls.sectionId),
        subjectId: String(movingCls.subjectId),
        facultyRef: chosen.facultyRef ?? null,
        reason: professorEdit.reason.trim(),
        ...(mlTop1 ? { mlTop1Faculty: mlTop1.name, mlTop1Score: mlTop1.score } : {})
      });
      returnFocus(target);
      setMove(null);
      setEdit(null);
      setProfessorEdit(null);
      setMoveCheck(null);
      setFullCheck(null);
      if (wasChecked) {
        recheckRef.current = true;
        setIsCheckingAll(true);
      }
      showToast(res.data?.message || `${codeLine(movingCls)} is now taught by ${chosen.name}.`);
      reload();
    } catch (err) {
      const body = err.response?.data || {};
      if (err.response?.status === 409 && body.code === 'CHANGE_REFUSED') {
        setProfessorEdit(prev => (prev ? { ...prev, confirm: false, verdicts: prev.verdicts.map(v => ((v.facultyRef ?? null) === (chosen.facultyRef ?? null) ? { ...v, ok: false, text: (body.reasons || []).join('; ') || body.message, reasons: body.reasons || [] } : v)) } : prev));
        setSaveError(`Not saved: ${body.message}`);
      } else if (err.response?.status === 409 && (body.code === 'READ_ONLY_VERSION' || body.code === 'NOT_NEWEST_DRAFT')) {
        returnFocus(target);
        setMove(null);
        setEdit(null);
        setProfessorEdit(null);
        showToast(`${body.message || "This version can't be changed any more."} Nothing was saved.`, 'error');
        reload();
      } else if (err.response?.status === 403) {
        setSaveError(`The professor was not changed: ${body.message || assignPermission.reason || 'your role cannot assign faculty.'} Nothing changed.`);
      } else {
        setSaveError(`The professor was not changed (${body.message || err.message}). Nothing changed. Check that the gateway is running, then press "Save" again.`);
      }
      setProfessorEdit(prev => (prev ? { ...prev, confirm: false } : prev));
    } finally {
      setIsSaving(false);
    }
  };

  const saveSwap = async () => {
    if (!movingCls || !swapAnswer?.ok || swapSaveBlockedReason || isSaving) return;
    const target = move;
    const wasChecked = Boolean(checkShown);
    setIsSaving(true);
    setSaveError('');
    try {
      const res = await api.post('/schedule/swap', { scheduleId: schedule.id, itemA: String(movingCls.itemId), itemB: swapEdit.withId });
      returnFocus(target);
      setMove(null);
      setEdit(null);
      setSwapEdit(null);
      setMoveCheck(null);
      setFullCheck(null);
      if (wasChecked) {
        recheckRef.current = true;
        setIsCheckingAll(true);
      }
      showToast(res.data?.message || 'The two classes were swapped.');
      reload();
    } catch (err) {
      const body = err.response?.data || {};
      if (err.response?.status === 409 && body.code === 'SWAP_REFUSED') {
        setSwapEdit(prev => (prev ? { ...prev, check: { key: swapKey, ok: false, places: body.places || null, reasons: body.reasons || [], roomText: '' } } : prev));
        setSaveError(`Not saved: ${body.message}`);
      } else if (err.response?.status === 409 && body.code === 'READ_ONLY_VERSION') {
        returnFocus(target);
        setMove(null);
        setEdit(null);
        setSwapEdit(null);
        showToast(`${body.message || "This version can't be changed any more."} Nothing was saved.`, 'error');
        reload();
      } else if (err.response?.status === 403) {
        setSaveError(`The swap was not saved: ${body.message || movePermission.reason || 'your role cannot move classes.'} Nothing changed.`);
      } else {
        setSaveError(`The swap was not saved (${body.message || err.message}). Nothing changed. Check that the gateway is running, then press "Save the swap" again.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Reads the shown version again (the same id), keeping the view and the chosen entity.
  const reload = () => {
    setResult(prev => ({ ...prev, refreshing: true, refreshError: '' }));
    setRequest(prev => ({ scheduleId: schedule?.id || prev.scheduleId, n: prev.n + 1 }));
  };
  // Phase 8 Part 8 (decision 6): live updates — another tab's or user's save (a class moved, a professor
  // changed, a version approved, a fill, a record the classes name, the Output Settings) reads the shown
  // version and the version list again, keeping the view; never while this page's own move or save runs.
  useDataChanges(['schedule', 'assignments', 'faculty', 'sections', 'rooms', 'curriculum', 'outputSettings', 'outsideTeachers'], () => {
    if (move || versionBlocked) return;
    setVersionsNonce(n => n + 1);
    reload();
  }, { remoteOnly: true });

  // "Reload": also the term's version list, and the whole-schedule check when its result is shown.
  const reloadShown = () => {
    if (versionBlocked) return;
    if (checkShown) {
      recheckRef.current = true;
      setIsCheckingAll(true);
    }
    setVersionsNonce(n => n + 1);
    reload();
  };
  const chooseVersion = (id) => {
    if (versionBlocked) return;
    setMove(null);
    setMoveCheck(null);
    setFullCheck(null);
    setFill(FILL_CLOSED);
    setResult({ status: 'loading', data: null, error: null, refreshing: false, refreshError: '' });
    setRequest(prev => ({ scheduleId: id || null, n: prev.n + 1 }));
  };
  const retry = () => {
    setResult({ status: 'loading', data: null, error: null, refreshing: false, refreshError: '' });
    setRequest(prev => ({ ...prev, n: prev.n + 1 }));
  };

  const chooseView = (id) => {
    setView(id);
    setSearch('');
  };
  // WAI-ARIA tabs with automatic activation: Left/Right wrap around, Home/End jump to the ends.
  const handleTabKeyDown = (event) => {
    const index = VIEW_IDS.indexOf(view);
    const nextIndex = {
      ArrowRight: (index + 1) % VIEW_IDS.length,
      ArrowLeft: (index - 1 + VIEW_IDS.length) % VIEW_IDS.length,
      Home: 0,
      End: VIEW_IDS.length - 1
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextId = VIEW_IDS[nextIndex];
    chooseView(nextId);
    tabRefs.current[nextId]?.focus();
  };
  const chooseEntity = (key) => setEntityKeys(prev => ({ ...prev, [view]: key }));
  const openRoom = (key) => setEntityKeys(prev => ({ ...prev, room: key }));

  const saveMove = async () => {
    if (!movingCls || saveBlockedReason || isSaving) return;
    const cls = movingCls;
    const target = { ...move };
    const key = formKey;
    const confirmation = movedToText(cls, target, endOf(target.start), roomByKey.get(target.roomKey));
    const wasChecked = Boolean(checkShown);
    setIsSaving(true);
    setSaveError('');
    try {
      await api.post('/schedule/override', {
        academicYear: schedule.academicYear,
        semester: schedule.semester,
        scheduleId: schedule.id,
        subjectCode: cls.subjectCode,
        sectionCode: cls.sectionCode,
        originalFacultyId: cls.facultyId || 'TBA',
        newFacultyId: cls.facultyId || 'TBA',
        reason: target.reason.trim() || 'Schedule editor move',
        updates: { itemId: String(cls.itemId), day: target.day, startSlot: slotOfTime(policy, target.start), roomId: target.roomKey || null }
      });
      returnFocus(target);
      setMove(null);
      setMoveCheck(null);
      setFullCheck(null);
      // The old editor checked the whole version again after a move; so does this page when that
      // check's result was on screen (once the version is read again).
      if (wasChecked) {
        recheckRef.current = true;
        setIsCheckingAll(true);
      }
      showToast(confirmation);
      reload();
    } catch (err) {
      const body = err.response?.data || {};
      if (err.response?.status === 409 && Array.isArray(body.violations) && body.violations.length) {
        setMoveCheck({ key, allowed: false, violations: body.violations, message: 'Not saved: this move is not allowed:' });
      } else if (err.response?.status === 409 && body.code === 'READ_ONLY_VERSION') {
        // The version stopped being a Draft while the page was open (e.g. it went to review):
        // nothing was saved, and the page reads it again to show it read-only.
        returnFocus(target);
        setMove(null);
        setMoveCheck(null);
        showToast(`${body.message || "This version can't be changed any more."} Nothing was saved.`, 'error');
        reload();
      } else if (err.response?.status === 403) {
        // The gateway's own words (the permission map's reason).
        setSaveError(`The move was not saved: ${body.message || movePermission.reason || 'your role cannot move classes.'} Nothing changed.`);
      } else {
        setSaveError(`The move was not saved (${body.message || err.message}). Nothing changed. Check that the gateway is running, then press "Save the move" again.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  // "Download CSV": the classes the view shows, as saved (a move being previewed is not in it), named
  // after what they are, the term and the version.
  const downloadClasses = (rows, scope) => {
    const fileName = csvFileName([...scope, termFileText(schedule), `${schedule.version} ${schedule.status}`]);
    downloadScheduleCsv(fileName, rows);
    showToast(`Downloaded "${fileName}" (${countText(rows.length)}).`);
  };

  // "Check the whole schedule": the real validator on the version as it is (nothing saved).
  const runFullCheck = async () => {
    if (!schedule || isCheckingAll) return;
    const checked = data;
    setIsCheckingAll(true);
    try {
      setFullCheck({ data: checked, ...(await checkWholeVersion(schedule.id)) });
    } catch (err) {
      showToast(`The schedule could not be checked (${err.response?.data?.message || err.message}). Check that the gateway is running, then try again.`, 'error');
    } finally {
      setIsCheckingAll(false);
    }
  };

  // ---------------------------------------------------------------- "Fill TBA rooms" (Phase 4 Part 1, Step 1)
  // The TBA rooms that hold classes (the box lists these), and the real rooms that can take them: the
  // version's active CCS and borrowed rooms, CCS first then borrowed (the gateway fills them in that
  // order), each with the hours it still has free this week.
  const tbaRoomsWithClasses = (data?.tbaRequest?.rooms || []).filter(r => r.classCount > 0);
  const fillRooms = ['CCS', 'BORROWED'].flatMap(kind => (data?.rooms || [])
    .filter(r => r.kind === kind && r.isActive !== false && r.roomId)
    .map(r => ({
      roomId: String(r.roomId), name: r.name, kind: r.kind, type: r.type, availability: r.availability,
      hoursUsed: r.hoursUsed, hoursAvailable: r.hoursAvailable,
      // Phase 4 Part 4: weekdays and Saturday apart (absent on a version read from an older gateway).
      hoursUsedWeekdays: r.hoursUsedWeekdays, hoursUsedSaturday: r.hoursUsedSaturday,
      hoursAvailableWeekdays: r.hoursAvailableWeekdays, hoursAvailableSaturday: r.hoursAvailableSaturday, saturdayOpen: r.saturdayOpen
    })));
  const fillTicked = fill.ticked ?? new Set(fillRooms.map(r => r.roomId));
  // Why "Fill TBA rooms" is closed: only a Draft's TBA rooms can be filled, by a role that may move
  // classes (the gateway checks the same action), and not while the page saves or reloads.
  const fillBlockedReason = !schedule ? ''
    : !editable ? `This version is ${schedule.status}: only a Draft's TBA rooms can be filled.`
      : !movePermission.allowed ? movePermission.reason
        : selectionBlocked;
  const fillPanelShown = fill.open && view === 'room' && mode === 'table' && editable && movePermission.allowed && tbaRoomsWithClasses.length > 0;

  const openFill = () => {
    if (fillBlockedReason) return;
    setFill(prev => ({ ...prev, open: true, error: '', errorLines: [], errorLink: null }));
  };
  // Closing (×, Cancel, Escape) forgets the ticks and the preview; the focus goes back to the button.
  const closeFill = () => {
    if (fill.saving || fill.previewing) return;
    setFill(FILL_CLOSED);
    window.requestAnimationFrame(() => document.querySelector('[data-testid="views-fill-tba"]')?.focus());
  };
  // A tick changes the rooms to fill, so the preview (made for the rooms ticked then) is dropped.
  const toggleFillRoom = (roomId) => {
    setFill(prev => {
      if (prev.previewing || prev.saving) return prev;
      const ticked = new Set(prev.ticked ?? fillRooms.map(r => r.roomId));
      if (ticked.has(roomId)) ticked.delete(roomId); else ticked.add(roomId);
      return { ...prev, ticked, preview: null, error: '', errorLines: [], errorLink: null };
    });
  };
  const fillBody = () => ({
    academicYear: activeAcademicYear,
    semester: activeSemesterNumber,
    scheduleId: schedule.id,
    roomIds: fillRooms.map(r => r.roomId).filter(id => fillTicked.has(id))
  });
  // What a failed preview or save shows, in the gateway's words where it has them; the version that
  // stopped being a Draft meanwhile closes the panel and reads the page again (as a refused move does).
  const failFill = (err, action) => {
    const status = err.response?.status;
    const body = err.response?.data || {};
    if (status === 409 && body.code === 'READ_ONLY_VERSION') {
      setFill(FILL_CLOSED);
      showToast(`${body.message || "This version can't be changed any more."} Nothing was saved.`, 'error');
      reload();
      return;
    }
    const stale = status === 409 && (body.code === 'PREVIEW_STALE' || body.code === 'NOTHING_FITS');
    const conflicts = status === 409 && body.code === 'NEW_CONFLICTS' && Array.isArray(body.violations) ? body.violations : [];
    // Phase 4 Part 4: a Draft is filled once; the gateway names the filled Draft ("This Draft was already
    // filled into v3. Open v3 to fill more."), and the link opens its Room Program with the panel.
    const filledInto = status === 409 && body.code === 'ALREADY_FILLED' && body.filledInto?.id ? body.filledInto : null;
    const known = status === 400 || status === 403 || status === 404 || status === 409;
    const message = known && body.message ? body.message
      : status === 403 ? movePermission.reason || 'Your role cannot move classes in a Draft.'
        : action === 'save' ? FILL_SAVE_FAILED : FILL_PREVIEW_FAILED;
    setFill(prev => ({
      ...prev, previewing: false, saving: false, confirm: false, error: message,
      errorLines: conflicts.map(v => tbaRoomWording(v.message)),
      errorLink: filledInto ? {
        label: `Open ${filledInto.version || 'the filled Draft'}`,
        onClick: () => {
          setFill(FILL_CLOSED);
          if (onNavigate) onNavigate('schedule-views', { scheduleId: String(filledInto.id), view: 'room', fill: '1' });
          else { setView('room'); setResult({ status: 'loading', data: null, error: null, refreshing: false, refreshError: '' }); setRequest(prev2 => ({ scheduleId: String(filledInto.id), n: prev2.n + 1 })); }
        }
      } : null,
      // A stale preview, or a Draft already filled, is dropped so the Dean previews again (or elsewhere); the ticks stay as they are.
      preview: stale || filledInto ? null : prev.preview
    }));
  };
  // POST /schedule/fill-tba-rooms/preview: the moves the gateway would make for the ticked rooms (nothing saved).
  const previewFill = async () => {
    if (!schedule || fill.previewing || fill.saving || selectionBlocked) return;
    const body = fillBody();
    if (!body.roomIds.length) return;
    setFill(prev => ({ ...prev, previewing: true, preview: null, error: '', errorLines: [], errorLink: null }));
    try {
      const res = await api.post('/schedule/fill-tba-rooms/preview', body);
      setFill(prev => ({ ...prev, previewing: false, preview: res.data }));
    } catch (err) {
      failFill(err, 'preview');
    }
  };
  const askSaveFill = () => {
    if (!(fill.preview?.classCount > 0) || fill.saving || fill.previewing || selectionBlocked) return;
    setFill(prev => ({ ...prev, confirm: true, error: '', errorLines: [], errorLink: null }));
  };
  const keepFill = () => {
    if (fill.saving) return;
    setFill(prev => ({ ...prev, confirm: false }));
  };
  // POST /schedule/fill-tba-rooms with the preview's hash: the moves are saved as a NEW Draft, which
  // the page then opens (the gateway's confirmation is shown there); the shown Draft stays as it is.
  const confirmFill = async () => {
    if (!schedule || !fill.preview || fill.saving) return;
    const body = { ...fillBody(), previewHash: fill.preview.previewHash };
    setFill(prev => ({ ...prev, saving: true, error: '', errorLines: [], errorLink: null }));
    try {
      const res = await api.post('/schedule/fill-tba-rooms', body);
      const newId = res.data?.scheduleId ? String(res.data.scheduleId) : '';
      const message = res.data?.message || 'The TBA rooms were filled and saved as a new Draft.';
      setFill(FILL_CLOSED);
      if (newId && onNavigate) {
        handoffToast = { scheduleId: newId, message };
        onNavigate('schedule-views', { scheduleId: newId, view: 'room' });
      } else {
        showToast(message);
        if (newId) {
          setView('room');
          setResult({ status: 'loading', data: null, error: null, refreshing: false, refreshError: '' });
          setRequest(prev => ({ scheduleId: newId, n: prev.n + 1 }));
        } else {
          reload();
        }
      }
    } catch (err) {
      failFill(err, 'save');
    }
  };

  // ---------------------------------------------------------------- the weekly table's blocks
  const blocks = [];
  if (data && current && mode === 'table') {
    for (const cls of data.classes) {
      if (!belongs(cls)) continue;
      const isMoving = Boolean(movingCls) && String(cls.itemId) === String(movingCls.itemId);
      const summary = classSummary(cls, view, { campusCode });
      blocks.push({
        id: String(cls.itemId),
        day: cls.day,
        start: cls.startTime,
        end: cls.endTime,
        kind: 'class',
        lines: classLines(cls, view, { campusCode }),
        testId: `views-block-${cls.itemId}`,
        selected: isMoving && !pending,
        faded: isMoving && pending,
        clash: !isMoving && clashIds.has(String(cls.itemId)),
        // While "Swap with another class" is open, a click on another class chooses it as the partner.
        onSelect: canMove ? () => (edit?.kind === 'swap' && movingCls && String(cls.itemId) !== String(movingCls.itemId) && !cls.isFixed ? chooseSwapPartner(cls.itemId) : openMove(cls)) : undefined,
        disabled: canMove && Boolean(selectionBlocked),
        disabledReason: selectionBlocked,
        ariaLabel: canMove ? `${summary}. ${cls.isFixed ? 'Fixed NSTP block' : edit?.kind === 'swap' && movingCls && String(cls.itemId) !== String(movingCls.itemId) ? 'Press to swap with this class' : 'Press to edit this class: move it, change its professor or swap it'}.` : summary
      });
    }
    if (previewCls && belongs(previewCls)) {
      blocks.push({
        id: `${previewCls.itemId}:preview`,
        day: previewCls.day,
        start: previewCls.startTime,
        end: previewCls.endTime,
        kind: 'class',
        lines: classLines(previewCls, view, { campusCode }),
        testId: `views-block-${previewCls.itemId}-preview`,
        selected: true,
        clash: clashIds.has(String(previewCls.itemId)),
        ariaLabel: `Where the class would move: ${classSummary(previewCls, view, { campusCode })}`
      });
    }
    if (view === 'professor') {
      // The professor's ancillary duty blocks, placed by the gateway in free weekday time (never over
      // a class, an unavailable time or the lunch hour) and labelled as on the real forms, and the
      // professor's unavailable times in grey with their note (not counted in any total; only their
      // part inside that day's window, so they never stretch the table). The printed "Class schedule
      // table" layout draws them with the same helpers (utils/scheduleBlocks.js).
      blocks.push(
        ...practicumBlocks(current.record.practicum?.blocks),
        ...dutyBlocks(current.record.ancillary?.blocks, policy),
        ...unavailableBlocks(current.record.unavailable, policy)
      );
    }
  }
  const classBlockCount = blocks.filter(b => b.kind === 'class').length;
  const heading = current ? entityHeading(view, current) : null;
  // The weekly table's CSV: the section's classes in the gateway's order (day, then start); a
  // professor's or a room's by day and start.
  const shownClasses = data && current ? data.classes.filter(belongs) : [];
  const csvRows = view === 'section' ? shownClasses : [...shownClasses].sort(byDayAndStart);
  // The Teachers' Program's own content for the professor shown (Step 2), all from the gateway for
  // this version: the header facts, the duty blocks (on the table above), the day totals under the
  // table, the duty hours that did not fit, and the load summary.
  const program = view === 'professor' && current ? current.record : null;
  const totalsRow = program ? dayTotalsRow(program.dayTotals) : null;
  // Phase 8 Part 2 (F2): the standard full-time teaching load as information on the Teachers' Program
  // view ("Standard load: 18 h", and full-time teaching above it as "Overload: N h"). The caps still
  // gate assignments; nothing changes on the printed SF-029.
  const profStandardLoad = program?.load
    ? standardLoadLine({ teaching: program.load.teaching, employmentType: program.load.employmentType ?? program.employmentType, standardTeachingHours: policy?.load?.standardTeachingHours })
    : null;
  // Phase 8 Part 4 (decision 1): the load against the professor's range ("14 of 18–21 h · 4 h under").
  const profLoadRange = program?.load
    ? loadRangeLine({ teaching: program.load.teaching, min: program.load.min, cap: program.load.cap })
    : null;
  // The On-The-Job Training boxes and the duty hours the grid had no free time for (Phase 4 Part 4).
  const unplaced = [
    ...(Array.isArray(program?.practicum?.unplaced) ? program.practicum.unplaced : []),
    ...(Array.isArray(program?.ancillary?.unplaced) ? program.ancillary.unplaced : [])
  ];
  const summary = Array.isArray(program?.summary) ? program.summary : [];
  // The self-paced online lectures of the section or professor shown (Phase 3 Step 7); a room has none.
  const selfPaced = current && view !== 'room' && Array.isArray(current.record.selfPaced) ? current.record.selfPaced : [];

  // ---------------------------------------------------------------- version selector
  const versionOptions = versions.list.map(v => ({ value: String(v.mongoId), label: `${versionName(v.id)} · ${v.workflowStatus || v.status} · ${v.date}` }));
  const selectedVersion = schedule ? String(schedule.id) : (request.scheduleId ? String(request.scheduleId) : '');
  if (schedule && !versionOptions.some(o => o.value === selectedVersion)) {
    versionOptions.unshift({ value: selectedVersion, label: `${versionName(schedule.version)} · ${schedule.status}` });
  } else if (!schedule && !versionOptions.some(o => o.value === selectedVersion)) {
    versionOptions.unshift({ value: selectedVersion, label: selectedVersion ? 'The version asked for' : 'The newest Draft' });
  }

  // One panel for the chosen class: "Move this class" (with the two other actions in its header), or,
  // from there, "Change professor" or "Swap with another class" (Phase 4 Part 2).
  const movePanel = movingCls && (edit?.kind === 'professor' && professorEdit ? (
    <>
      <ChangeProfessorPanel
        cls={movingCls}
        nowText={placeText(movingCls)}
        state={professorEdit}
        form={professorEdit}
        onChange={changeProfessorForm}
        onRecheck={() => { setProfessorEdit(prev => ({ ...(prev || {}), status: 'loading' })); setProfessorNonce(n => n + 1); }}
        saveBlockedReason={professorSaveBlockedReason}
        saveError={saveError}
        isSaving={isSaving}
        onSave={() => changeProfessorForm({ confirm: true })}
        onClose={closeMove}
        onBack={backToMove}
      />
      {professorEdit.confirm && chosenVerdict && (
        <ConfirmDialog
          testId="professor-confirm"
          title={`Change the professor of ${codeLine(movingCls)}?`}
          keepLabel="Cancel"
          confirmLabel={`Assign ${chosenVerdict.name}`}
          busyLabel="Saving…"
          onKeep={() => changeProfessorForm({ confirm: false })}
          onConfirm={saveProfessor}
          busy={isSaving}
          error=""
          tone="violet"
          icon={User}
        >
          <span data-testid="professor-confirm-text">
            {professorEdit.changeText} will be taught by <strong>{chosenVerdict.name}</strong> instead of {movingCls.facultyName || 'TBA'}. Times and rooms stay the same.
            {movingCls.isMinor ? '' : ' The term\'s assignment changes too, so a new generation keeps this professor.'}
          </span>
        </ConfirmDialog>
      )}
    </>
  ) : edit?.kind === 'swap' && swapEdit ? (
    <SwapClassPanel
      cls={movingCls}
      nowText={placeText(movingCls)}
      partner={swapPartner}
      candidates={swapCandidates}
      withId={swapEdit.withId}
      onChoose={chooseSwapPartner}
      check={swapCheckView}
      onRecheck={recheckSwap}
      saveBlockedReason={swapSaveBlockedReason}
      saveError={saveError}
      isSaving={isSaving}
      onSave={saveSwap}
      onClose={closeMove}
      onBack={backToMove}
    />
  ) : (
    <MoveClassPanel
      cls={movingCls}
      nowText={placeText(movingCls)}
      form={move}
      onChange={changeMove}
      dayOptions={dayOptions}
      startOptions={startOptions}
      endOf={endOf}
      roomGroups={roomGroupsFor(data.rooms, movingCls)}
      check={checkView}
      onRecheck={() => setCheckNonce(n => n + 1)}
      saveBlockedReason={saveBlockedReason}
      saveError={saveError}
      isSaving={isSaving}
      onSave={saveMove}
      onClose={closeMove}
      actions={[
        { key: 'professor', label: 'Change professor', onClick: openProfessor, blockedReason: professorBlockedReason, testId: 'move-action-professor' },
        { key: 'swap', label: 'Swap with another class', onClick: openSwap, blockedReason: swapBlockedReason, testId: 'move-action-swap' }
      ]}
    />
  ));

  const smallButton = 'shrink-0 inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2';

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">

        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="schedule-views" />
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        {/* VERSION */}
        <div className="px-6 md:px-8 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <label htmlFor="views-version" className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">Version</label>
            <Select
              id="views-version"
              data-testid="views-version"
              value={selectedVersion}
              onChange={(e) => chooseVersion(e.target.value)}
              disabled={Boolean(versionBlocked)}
              title={versionBlocked || undefined}
              aria-describedby={versionBlocked ? 'views-busy' : undefined}
              className="bg-white dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700 rounded-lg py-2 px-3 text-xs font-bold text-slate-900 dark:text-white max-w-full disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500"
            >
              {versionOptions.map(o => <option key={o.value || 'newest'} value={o.value}>{o.label}</option>)}
            </Select>
            {schedule && (
              <span data-testid="views-version-status" className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-bold border ${STATUS_BADGE[schedule.status] || OTHER_BADGE}`}>
                {schedule.status}{canMove ? ': classes can be moved' : ''}
              </span>
            )}
            {/* While a move is saved and the version is read again, nothing on the table can be chosen. */}
            <span id="views-busy" data-testid="views-busy" data-state={isSaving ? 'saving' : fill.saving ? 'filling' : result.refreshing ? 'reloading' : ''} role="status" className="inline-flex items-center text-xs font-bold text-slate-700 dark:text-slate-200">
              {(isSaving || fill.saving || result.refreshing) && (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" />
                  {isSaving ? 'Saving the move…' : fill.saving ? 'Saving the new Draft…' : 'Reloading the schedule…'}
                </>
              )}
            </span>
            {versions.failed && (
              <span data-testid="views-versions-error" className="text-xs text-amber-800 dark:text-amber-300">
                The other versions of this term could not be listed; press &ldquo;Reload&rdquo; to try again.
              </span>
            )}
          </div>
          {schedule && (
            <div className="flex flex-wrap items-center gap-3">
              {versionFacts(schedule) && <p data-testid="views-version-facts" className="text-xs text-slate-600 dark:text-slate-300">{versionFacts(schedule)}</p>}
              <button
                type="button"
                data-testid="views-reload"
                onClick={reloadShown}
                disabled={Boolean(versionBlocked)}
                aria-label="Reload this version"
                title={versionBlocked || 'Read this version again, to see changes made elsewhere (nothing is saved).'}
                className={`${smallButton} text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-600 bg-white dark:bg-[#1a1a1c] hover:bg-slate-100 dark:hover:bg-slate-800`}
              >
                <RefreshCw size={14} className={`mr-1.5 ${result.refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Reload
              </button>
              <button
                type="button"
                data-testid="views-check-all"
                onClick={runFullCheck}
                disabled={isCheckingAll || Boolean(versionBlocked)}
                title={isCheckingAll ? 'Checking the whole schedule…' : versionBlocked || 'Check every class of this version for conflicts (nothing is saved).'}
                className={`${smallButton} text-white bg-violet-600 hover:bg-violet-700`}
              >
                {isCheckingAll ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : <ShieldCheck size={14} className="mr-1.5" aria-hidden="true" />}
                {isCheckingAll ? 'Checking…' : 'Check the whole schedule'}
              </button>
            </div>
          )}
        </div>

        {/* VIEW TABS + DISPLAY */}
        <div className="px-6 md:px-8 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#121212] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div role="tablist" aria-label="Schedule views" onKeyDown={handleTabKeyDown} className="inline-flex flex-wrap p-1 rounded-xl bg-slate-100 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700">
            {VIEWS.map(v => {
              const isSelected = v.id === view;
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  ref={(node) => { tabRefs.current[v.id] = node; }}
                  type="button"
                  role="tab"
                  id={`views-tab-${v.id}`}
                  data-testid={`views-tab-${v.id}`}
                  aria-selected={isSelected}
                  aria-controls="views-panel"
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => chooseView(v.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
                    isSelected ? 'bg-white dark:bg-[#27272a] text-violet-700 dark:text-violet-300 shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon size={15} className="shrink-0" aria-hidden="true" /> {v.label}
                </button>
              );
            })}
          </div>
          <div role="group" aria-label="Display" className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-[#1a1a1c] border border-slate-200 dark:border-slate-700">
            {[
              { id: 'table', label: 'Weekly table', icon: Table2 },
              { id: 'list', label: 'List', icon: List }
            ].map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`views-mode-${m.id}`}
                  aria-pressed={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
                    mode === m.id ? 'bg-white dark:bg-[#27272a] text-violet-700 dark:text-violet-300 shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon size={13} aria-hidden="true" /> {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* THE VIEW */}
        <div role="tabpanel" id="views-panel" aria-labelledby={`views-tab-${view}`} className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b] space-y-5">
          {result.status === 'loading' ? (
            <div data-testid="views-loading" role="status" className="p-16 flex flex-col items-center justify-center text-slate-600 dark:text-slate-300 gap-3">
              <Loader2 size={36} className="animate-spin text-violet-500" aria-hidden="true" />
              <p className="text-xs font-bold uppercase tracking-wider">Loading the schedule…</p>
            </div>
          ) : result.status === 'empty' ? (
            <div data-testid="views-empty" data-reason={result.error?.reason || 'none'} className="p-12 text-center max-w-md mx-auto my-6">
              <CalendarDays size={40} className="text-slate-400 mx-auto mb-3" aria-hidden="true" />
              {result.error?.reason === 'no-open' ? (
                <>
                  {/* The term has versions, but none this page can open (older format, or archived). */}
                  <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">No version to show here</h3>
                  <p data-testid="views-empty-message" className="text-sm text-slate-700 dark:text-slate-300 mb-4">{result.error.message}</p>
                </>
              ) : (
                <>
                  <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">No schedule yet</h3>
                  <p data-testid="views-empty-message" className="text-sm text-slate-700 dark:text-slate-300">No schedule has been generated for this term yet.</p>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 mb-4">Generate it on the Generate Schedule page.</p>
                </>
              )}
              {onNavigate && (
                <button type="button" data-testid="views-open-ga" onClick={() => onNavigate('generate')} className={`${smallButton} text-white bg-violet-600 hover:bg-violet-700 mx-auto`}>
                  <Play size={14} className="mr-1.5" aria-hidden="true" /> Open Generate Schedule
                </button>
              )}
            </div>
          ) : result.status === 'error' ? (
            <div data-testid="views-error" role="alert" className="p-12 text-center max-w-lg mx-auto my-6">
              <AlertOctagon size={40} className="text-amber-500 mx-auto mb-3" aria-hidden="true" />
              <h3 className="text-base font-bold text-slate-800 dark:text-white mb-1">The schedule can&apos;t be shown</h3>
              <p data-testid="views-error-message" className="text-sm text-slate-700 dark:text-slate-300 mb-4">{result.error?.message}</p>
              {result.error?.fix === 'newest' ? (
                <button type="button" data-testid="views-show-newest" onClick={() => chooseVersion(null)} className={`${smallButton} text-white bg-violet-600 hover:bg-violet-700 mx-auto`}>
                  Show this term&apos;s newest version
                </button>
              ) : (
                <button type="button" data-testid="views-retry" onClick={retry} className={`${smallButton} text-white bg-violet-600 hover:bg-violet-700 mx-auto`}>
                  <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
                </button>
              )}
            </div>
          ) : (
            <>
              {result.refreshError && (
                <div data-testid="views-refresh-error" role="alert" className="p-3 rounded-xl border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-red-800 dark:text-red-300">
                  <span>The schedule could not be updated, so it may be out of date: {result.refreshError} Classes can be moved again once it is read again.</span>
                  <button type="button" data-testid="views-refresh-retry" onClick={reload} className={`${smallButton} text-red-800 dark:text-red-200 border border-red-300 dark:border-red-500/40 bg-white dark:bg-transparent`}>
                    <RefreshCw size={14} className="mr-1.5" aria-hidden="true" /> Try again
                  </button>
                </div>
              )}

              {editable && !movePermission.allowed && (
                <PermissionNote id={MOVE_NOTE_ID} permission={movePermission} lead="You can view this Draft." />
              )}

              {!editable && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p data-testid="views-readonly-note" className="flex items-center text-xs font-bold text-slate-700 dark:text-slate-200">
                    <Lock size={14} className="mr-2 shrink-0" aria-hidden="true" />
                    {readOnlyNote(schedule.status)}
                  </p>
                  {schedule.status === 'Approved' && onNavigate && (
                    <button
                      type="button"
                      data-testid="views-open-versions"
                      onClick={() => onNavigate('versions')}
                      className={`${smallButton} text-violet-800 dark:text-violet-200 border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10 hover:bg-violet-100 dark:hover:bg-violet-500/20`}
                    >
                      <RotateCcw size={13} className="mr-1.5" aria-hidden="true" /> Restore it on the Versions page
                    </button>
                  )}
                </div>
              )}

              {checkShown?.failed && (
                <p data-testid="views-check-result" data-failed="true" role="alert" className="p-3.5 rounded-xl border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-xs font-bold text-red-800 dark:text-red-300">
                  {checkShown.failed}
                </p>
              )}
              {checkShown && !checkShown.failed && (
                <div
                  data-testid="views-check-result"
                  role="status"
                  className={`p-3.5 rounded-xl border text-xs ${checkShown.hardTotal === 0
                    ? 'border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-green-800 dark:text-green-300'
                    : 'border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-800 dark:text-red-300'}`}
                >
                  <p className="font-bold flex items-center">
                    {checkShown.hardTotal === 0 ? <CheckCircle2 size={15} className="mr-1.5" aria-hidden="true" /> : <AlertOctagon size={15} className="mr-1.5" aria-hidden="true" />}
                    Checked at {clockOf(checkShown.checkedAt)}: {checkShown.hardTotal === 0
                      ? 'no conflicts in this version.'
                      : `${checkShown.hardTotal} conflict${checkShown.hardTotal === 1 ? '' : 's'} in this version (outlined in red in the table):`}
                  </p>
                  {checkShown.violations.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 space-y-0.5">
                      {checkShown.violations.map((v, i) => <li key={i}>{tbaRoomWording(v.message)}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {mode === 'table' ? (
                <>
                  <EntityPicker
                    noun={viewMeta.noun}
                    nounPlural={viewMeta.nounPlural}
                    entities={entities}
                    currentKey={current?.key || null}
                    search={search}
                    onSearch={setSearch}
                    onChoose={chooseEntity}
                  >
                    {view === 'room' && (
                      <TbaRoomsToRequest
                        tbaRequest={data.tbaRequest}
                        currentKey={current?.key || null}
                        onOpenRoom={openRoom}
                        onFill={openFill}
                        fillBlockedReason={fillBlockedReason}
                        fillOpen={fillPanelShown}
                      />
                    )}
                  </EntityPicker>

                  {fillPanelShown && (
                    <FillTbaRoomsPanel
                      rooms={fillRooms}
                      ticked={fillTicked}
                      onToggle={toggleFillRoom}
                      preview={fill.preview}
                      isPreviewing={fill.previewing}
                      onPreview={previewFill}
                      busyReason={selectionBlocked}
                      error={fill.error}
                      errorLines={fill.errorLines}
                      errorLink={fill.errorLink}
                      confirmOpen={fill.confirm}
                      onSave={askSaveFill}
                      onKeep={keepFill}
                      onConfirm={confirmFill}
                      isSaving={fill.saving}
                      version={versionName(schedule.version)}
                      onAddRoom={onNavigate ? () => onNavigate('rooms') : null}
                      onClose={closeFill}
                    />
                  )}

                  {heading && (
                    <div data-testid="views-entity-title" className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 border-t border-slate-200 dark:border-slate-800 pt-4">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300">{viewMeta.label}</p>
                        <h3 data-testid="views-entity-name" className="text-xl font-black text-slate-900 dark:text-white">{heading.title}</h3>
                        {heading.detail && <p data-testid="views-entity-detail" className="text-xs text-slate-600 dark:text-slate-300">{heading.detail}</p>}
                        {heading.note && <p data-testid="views-entity-weeks" className="text-xs font-bold text-purple-700 dark:text-purple-300 mt-0.5">{heading.note}</p>}
                        {/* Phase 8 Part 4 (decision 1): the load against the professor's range. */}
                        {profLoadRange && (
                          <p data-testid="views-load-range" className="text-xs text-slate-600 dark:text-slate-300 mt-0.5" title="The range is the minimum teaching load to the teaching cap.">
                            {`Teaching ${profLoadRange.text}`}{profLoadRange.under ? <span className="font-bold text-amber-700 dark:text-amber-400">{` · ${profLoadRange.under}`}</span> : ''}
                          </p>
                        )}
                        {/* Phase 8 Part 2 (F2): information only — the teaching cap still gates assignments. */}
                        {profStandardLoad && (
                          <p data-testid="views-standard-load" className="text-xs text-slate-600 dark:text-slate-300 mt-0.5" title="The standard full-time teaching load (information only; the teaching cap still gates assignments).">
                            {profStandardLoad.text}{profStandardLoad.overload ? <span className="font-bold text-amber-700 dark:text-amber-400">{` · ${profStandardLoad.overload}`}</span> : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-end sm:justify-end gap-3">
                        {weekFilterShown && (
                          <div data-testid="views-week-filter" role="group" aria-label="Show odd weeks, even weeks or both" className="flex rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                            {[['both', 'All weeks'], ['ODD', 'Odd weeks'], ['EVEN', 'Even weeks']].map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                data-testid={`views-week-filter-${value.toLowerCase()}`}
                                aria-pressed={weekFilter === value}
                                onClick={() => setWeekFilter(value)}
                                className={`px-3 py-1.5 text-xs font-bold cursor-pointer focus-visible:ring-2 focus-visible:ring-purple-500 ${weekFilter === value
                                  ? 'bg-purple-600 text-white'
                                  : 'bg-white dark:bg-[#1a1a1c] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'}`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                        {view === 'room' && (
                          <p data-testid="views-room-hours" className="text-sm font-bold text-slate-800 dark:text-slate-100">
                            {/* Phase 4 Part 1 (Step 3): a TBA room reads as in print ("22 classes (41 h a week) need this room."), never "available" hours of a room still to request. */}
                            {roomHoursText(current.record)}
                          </p>
                        )}
                        <CsvButton
                          count={csvRows.length}
                          blockedReason={`No class in this ${viewMeta.label}: there is nothing to download.`}
                          busyReason={selectionBlocked}
                          onDownload={() => downloadClasses(csvRows, [viewMeta.label, heading.title])}
                        />
                        {/* The office's file of this page (Phase 8 Part 2): Word or PDF. */}
                        <ExportThisPage
                          view={view}
                          entity={current ? { key: current.key, name: current.label } : null}
                          schedule={schedule}
                          weekGroupsOn={weekGroupsOn}
                          weekFilter={weekFilter}
                          busyReason={selectionBlocked}
                        />
                      </div>
                    </div>
                  )}

                  {program?.header && <TeachersProgramFacts header={program.header} />}

                  {movePanel}

                  {current ? (
                    <>
                      {classBlockCount === 0 && (
                        <p data-testid="views-entity-empty" className="text-xs text-slate-600 dark:text-slate-300">
                          {weekFilterShown && weekFilter !== 'both'
                            ? `No class in this room in the ${weekFilter === 'ODD' ? 'odd' : 'even'} weeks.`
                            : `No class in this ${viewMeta.label} in this version.`}
                        </p>
                      )}
                      <div className="overflow-x-auto custom-scrollbar rounded-xl border border-slate-200 dark:border-slate-800 bg-white">
                        <div className="min-w-[760px] p-3">
                          <WeeklyTable
                            dayStart={policy.dayStart}
                            dayEnd={policy.dayEnd}
                            slotMinutes={policy.slotMinutes}
                            blocks={blocks}
                            totalsRow={totalsRow ? { ...totalsRow, testId: 'tp-day-totals' } : null}
                            testId="views-table"
                            ariaLabel={`${viewMeta.label} of ${heading?.title || ''}`}
                          />
                        </div>
                      </div>
                      {selfPaced.length > 0 && <SelfPacedList rows={selfPaced} view={view} />}
                      {unplaced.length > 0 && <TeachersProgramUnplaced unplaced={unplaced} />}
                      {summary.length > 0 && <TeachersProgramSummary summary={summary} />}
                    </>
                  ) : (
                    <p data-testid="views-no-entity" className="text-sm text-slate-700 dark:text-slate-300">
                      This version has no {viewMeta.noun} with classes to show.
                    </p>
                  )}
                </>
              ) : (
                <>
                  {movePanel}
                  <ClassListView
                    key={view}
                    classes={data.classes}
                    view={view}
                    sections={data.sections}
                    faculty={faculty}
                    rooms={data.rooms.filter(r => r.kind !== 'TBA' || r.classCount > 0)}
                    initialEntity={current ? { view, key: current.key } : null}
                    editable={editable}
                    moveBlockedReason={movePermission.allowed ? selectionBlocked : movePermission.reason}
                    moveReasonId={movePermission.allowed ? undefined : MOVE_NOTE_ID}
                    onMove={openMoveFromList}
                    renderActions={(rows, { anyFilter }) => (
                      <CsvButton
                        count={rows.length}
                        blockedReason={anyFilter ? 'No class matches these filters: there is nothing to download.' : 'This version has no classes: there is nothing to download.'}
                        busyReason={selectionBlocked}
                        onDownload={() => downloadClasses(rows, ['Class list', anyFilter ? 'Filtered classes' : 'All classes'])}
                      />
                    )}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300 max-w-md">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${toast.tone === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-violet-500/20 dark:bg-violet-500/15 text-violet-400 dark:text-violet-600'}`}>
            {toast.tone === 'error' ? <AlertOctagon size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
          </div>
          <span data-testid="views-toast" className="text-xs font-bold tracking-wide">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
            className="ml-2 text-slate-400 hover:text-white dark:text-slate-600 dark:hover:text-slate-900 transition-colors cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
