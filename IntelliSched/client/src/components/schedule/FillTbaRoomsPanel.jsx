import { useEffect, useRef } from 'react';
import { AlertOctagon, DoorOpen, Loader2, Plus, X } from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';
import { availabilityWords, hoursText, numberText } from '../../utils/scheduleDisplay';
import { formatRange12 } from '../../utils/timeGrid';

// "Fill TBA rooms" (Phase 4 Part 1, Step 1) on the Room Program of a Draft: the classes the Draft put in
// TBA rooms (rooms to request) go into real rooms that have free time at the same day and time. Times
// and professors stay the same; only the room changes. The Dean ticks the rooms to fill (every CCS and
// borrowed room is ticked at first), previews the moves (POST /schedule/fill-tba-rooms/preview: nothing
// is saved) and saves them as a NEW Draft (POST /schedule/fill-tba-rooms); the shown Draft stays as it
// is. The page (ScheduleViews) owns the state and the requests; this panel shows them.
//   rooms          the active CCS and borrowed rooms of the version, CCS first then borrowed, each
//                  { roomId, name, kind: 'CCS' | 'BORROWED', hoursUsed, hoursAvailable, availability }
//   ticked         the Set of room ids to fill; onToggle(roomId) ticks or unticks one
//   preview        the gateway's preview (message, byRoom, emptiedTbaRooms, classCount, hoursMoved) or null
//   busyReason     why nothing can be previewed or saved right now (the page is saving a move or reloading)
//   error, errorLines  what the last preview or save answered when it failed (the conflict lines of a refusal)
//   confirmOpen, onSave (opens the confirmation), onKeep, onConfirm, isSaving  "Save as a new Draft"
//   version        the shown Draft's name ("v2"), for the confirmation
//   onAddRoom      opens the Rooms page (null when the page can't navigate); onClose closes the panel
const labelClass = 'block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5 uppercase tracking-wider';
const KIND_WORDS = { CCS: 'CCS room', BORROWED: 'Borrowed room' };

const classesText = (n) => `${n} class${n === 1 ? '' : 'es'}`;
const hoursWords = (h) => `${numberText(h)} hour${Number(h) === 1 ? '' : 's'}`;
// The hours a room still has free, one decimal at most, never below 0.
const free = (available, used) => Math.max(0, Math.round(((Number(available) || 0) - (Number(used) || 0)) * 10) / 10);
// Phase 4 Part 4 (Part 1's open question 2): weekdays and Saturday apart ("48 h free on weekdays, 10 h on
// Saturday"; the Saturday part only while Saturday classes are on); a version read without the split
// still reads "58 h free this week".
const freeHoursWords = (room) => {
  if (!Number.isFinite(Number(room.hoursAvailableWeekdays)) || room.hoursAvailableWeekdays === null) return `${hoursText(free(room.hoursAvailable, room.hoursUsed))} free this week`;
  const weekdays = `${hoursText(free(room.hoursAvailableWeekdays, room.hoursUsedWeekdays ?? room.hoursUsed))} free on weekdays`;
  return room.saturdayOpen ? `${weekdays}, ${hoursText(free(room.hoursAvailableSaturday, room.hoursUsedSaturday))} on Saturday` : weekdays;
};
// "ITEC 101 LEC · BSIT 1A · Monday 8:00 AM–10:00 AM · Test Prof Reyes · from TBA room 1 (lecture)"
const moveText = (m) => [
  `${m.subjectCode} ${m.classType}`, m.section, `${m.day} ${formatRange12(m.startTime, m.endTime)}`, m.facultyName || 'TBA', `from ${m.fromName}`
].join(' · ');

function RoomGroup({ title, rooms, ticked, onToggle, disabled, emptyText, children }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300 mb-1.5">{title}</p>
      {rooms.length === 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">{emptyText}</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {rooms.map(room => {
            const id = `views-fill-room-${room.roomId}`;
            return (
              <li key={room.roomId} className="flex items-start gap-2.5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]">
                <input
                  type="checkbox"
                  id={id}
                  data-testid={id}
                  checked={ticked.has(room.roomId)}
                  onChange={() => onToggle(room.roomId)}
                  disabled={disabled}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600 cursor-pointer disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                />
                <label htmlFor={id} data-testid={`${id}-label`} className="min-w-0 text-xs text-slate-800 dark:text-slate-100 cursor-pointer">
                  <span className="font-bold text-slate-900 dark:text-white">{room.name}</span>
                  {' · '}{KIND_WORDS[room.kind] || 'Room'}
                  {' · '}<span data-testid={`${id}-free`}>{freeHoursWords(room)}</span>
                  {room.kind === 'BORROWED' && (
                    <span data-testid={`${id}-times`} className="block text-[11px] text-slate-600 dark:text-slate-300">Free times: {availabilityWords(room.availability, 'not set')}</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {children}
    </div>
  );
}

//   errorLink      { label, onClick } shown under the error when the gateway named where to go (Phase 4
//                  Part 4: "This Draft was already filled into v3. Open v3 to fill more." → "Open v3")
export default function FillTbaRoomsPanel({
  rooms, ticked, onToggle, preview, isPreviewing, onPreview, busyReason = '', error = '', errorLines = [], errorLink = null,
  confirmOpen = false, onSave, onKeep, onConfirm, isSaving = false, version = '', onAddRoom = null, onClose
}) {
  const headingRef = useRef(null);
  const saveRef = useRef(null);
  // Keyboard users land in the panel when it opens.
  useEffect(() => { headingRef.current?.focus(); }, []);

  const busy = isPreviewing || isSaving;
  const ccsRooms = rooms.filter(r => r.kind === 'CCS');
  const borrowedRooms = rooms.filter(r => r.kind === 'BORROWED');
  const tickedCount = rooms.filter(r => ticked.has(r.roomId)).length;
  const previewBlockedReason = busy ? '' : busyReason || (tickedCount === 0 ? 'Tick at least one room.' : '');
  const moved = preview && preview.classCount > 0;
  const filledRooms = moved ? (preview.byRoom || []).filter(r => r.classCount > 0) : [];
  const emptied = moved && Array.isArray(preview.emptiedTbaRooms) ? preview.emptiedTbaRooms : [];
  const saveBlockedReason = busy ? '' : busyReason;

  return (
    <>
      <section
        data-testid="views-fill-panel"
        aria-labelledby="views-fill-title"
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } }}
        className="bg-white dark:bg-[#18181b] border-2 border-indigo-300 dark:border-indigo-500/40 rounded-2xl shadow-md overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex justify-between items-start gap-3">
          <div className="min-w-0">
            <h3 id="views-fill-title" ref={headingRef} tabIndex={-1} data-testid="views-fill-title" className="inline-flex items-center text-base font-black text-slate-900 dark:text-white tracking-wide focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">
              <DoorOpen size={17} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> Fill TBA rooms
            </h3>
            <p data-testid="views-fill-purpose" className="text-xs text-slate-700 dark:text-slate-200 mt-0.5">
              Put the classes in TBA rooms into real rooms with free time. Times and professors stay the same. Only the room changes.
            </p>
          </div>
          <button
            type="button"
            data-testid="views-fill-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close the Fill TBA rooms panel without saving"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-100 p-1 rounded-lg cursor-pointer disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <fieldset className="min-w-0 space-y-3">
            <legend className={labelClass}>Rooms to fill</legend>
            <p className="text-xs text-slate-600 dark:text-slate-300 -mt-1">Rooms are filled in this order: CCS lecture rooms, CCS lab rooms, then borrowed rooms (lecture rooms first). A lecture put in a lab room keeps its usual penalty.</p>
            <RoomGroup title="CCS rooms" rooms={ccsRooms} ticked={ticked} onToggle={onToggle} disabled={busy} emptyText="This version has no active CCS room." />
            <RoomGroup title="Borrowed rooms" rooms={borrowedRooms} ticked={ticked} onToggle={onToggle} disabled={busy} emptyText="No borrowed room yet. A room from another department, with its free times, can take classes too.">
              {onAddRoom && (
                <button
                  type="button"
                  data-testid="views-fill-add-room"
                  onClick={onAddRoom}
                  disabled={busy}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2 text-indigo-800 dark:text-indigo-300 hover:text-indigo-600 cursor-pointer disabled:opacity-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Plus size={13} aria-hidden="true" /> Add a borrowed room
                </button>
              )}
            </RoomGroup>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="views-fill-preview"
              onClick={onPreview}
              disabled={Boolean(previewBlockedReason) || busy}
              aria-describedby={previewBlockedReason ? 'views-fill-preview-reason' : undefined}
              title={previewBlockedReason || 'See which classes would move, and where (nothing is saved).'}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-900/20 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              {isPreviewing ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : null}
              {isPreviewing ? 'Previewing…' : 'Preview'}
            </button>
            {previewBlockedReason && (
              <p id="views-fill-preview-reason" data-testid="views-fill-preview-reason" className="text-[11px] text-slate-600 dark:text-slate-300">{previewBlockedReason}</p>
            )}
            {!previewBlockedReason && !busy && !preview && (
              <p className="text-[11px] text-slate-600 dark:text-slate-300">Nothing is saved by a preview.</p>
            )}
          </div>

          {preview && (
            <div data-testid="views-fill-result" aria-live="polite" className="space-y-3">
              {moved ? (
                <>
                  <p data-testid="views-fill-summary" className="p-3.5 rounded-xl border border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-xs font-bold text-green-800 dark:text-green-300">
                    {preview.message}
                  </p>
                  <ul className="space-y-2">
                    {(preview.byRoom || []).map(group => (
                      <li key={group.roomId} data-testid={`views-fill-group-${group.roomId}`} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#121212]">
                        <p data-testid={`views-fill-group-${group.roomId}-title`} className="text-xs font-black text-slate-900 dark:text-white">
                          {group.roomName} · {classesText(group.classCount)} · {hoursText(group.hours)}
                        </p>
                        {group.classCount > 0 ? (
                          <ul className="mt-1 space-y-0.5">
                            {(group.moves || []).map(m => (
                              <li key={m.itemId} data-testid={`views-fill-move-${m.itemId}`} className="text-xs text-slate-800 dark:text-slate-100">{moveText(m)}</li>
                            ))}
                          </ul>
                        ) : (
                          <p data-testid={`views-fill-group-${group.roomId}-none`} className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">No class fits</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {emptied.length > 0 && (
                    <p data-testid="views-fill-emptied" className="text-xs font-bold text-slate-800 dark:text-slate-100">
                      TBA rooms that become empty: {emptied.map(r => r.name).join(', ')}
                    </p>
                  )}
                </>
              ) : (
                <p data-testid="views-fill-none" className="p-3.5 rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-xs font-bold text-amber-900 dark:text-amber-300">
                  {preview.message || 'No TBA class fits the free times of these rooms.'}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800/60 bg-slate-50 dark:bg-[#1a1a1c] flex flex-col sm:flex-row sm:items-center justify-end gap-3">
          {error && (
            <div role="alert" data-testid="views-fill-error" className="text-xs font-bold text-red-700 dark:text-red-400 sm:mr-auto flex items-start gap-2">
              <AlertOctagon size={15} className="shrink-0 mt-px" aria-hidden="true" />
              <div>
                <p>{error}</p>
                {errorLines.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 font-medium space-y-0.5">
                    {errorLines.map((line, i) => <li key={i} data-testid="views-fill-error-line">{line}</li>)}
                  </ul>
                )}
                {errorLink && (
                  <button
                    type="button"
                    data-testid="views-fill-error-link"
                    onClick={errorLink.onClick}
                    disabled={busy}
                    className="mt-1 inline-flex items-center gap-1 text-xs font-bold underline underline-offset-2 text-indigo-800 dark:text-indigo-300 hover:text-indigo-600 cursor-pointer disabled:opacity-50 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    {errorLink.label}
                  </button>
                )}
              </div>
            </div>
          )}
          {moved && saveBlockedReason && !busy && (
            <p id="views-fill-save-reason" data-testid="views-fill-save-reason" className="text-[11px] text-slate-600 dark:text-slate-300 sm:mr-auto">{saveBlockedReason}</p>
          )}
          <button
            type="button"
            data-testid="views-fill-cancel"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Cancel
          </button>
          {moved && (
            <button
              ref={saveRef}
              type="button"
              data-testid="views-fill-save"
              onClick={onSave}
              disabled={Boolean(saveBlockedReason) || busy}
              aria-describedby={saveBlockedReason ? 'views-fill-save-reason' : undefined}
              title={saveBlockedReason || undefined}
              className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin mr-1.5" aria-hidden="true" /> : null}
              {isSaving ? 'Saving…' : 'Save as a new Draft'}
            </button>
          )}
        </div>
      </section>

      {confirmOpen && moved && (
        <ConfirmDialog
          testId="fill-confirm"
          title="Save as a new Draft?"
          keepLabel="Cancel"
          confirmLabel="Save as a new Draft"
          busyLabel="Saving…"
          onKeep={onKeep}
          onConfirm={onConfirm}
          busy={isSaving}
          tone="indigo"
          icon={DoorOpen}
          returnFocusRef={saveRef}
        >
          <p data-testid="fill-confirm-text">
            {classesText(preview.classCount)} ({hoursWords(preview.hoursMoved)}) move into {filledRooms.map(r => r.roomName).join(', ')}.
            {' '}Times and professors stay the same. Only the room changes.
            {' '}This makes a new Draft; {version || 'this Draft'} stays as it is and can be restored on Versions.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
