import { DoorOpen } from 'lucide-react';
import { hoursText, tbaRequestHeader, tbaRoomName } from '../../utils/scheduleDisplay';

// "TBA rooms to request" (top of the Room Program picker): the classes that need a room while the CCS
// rooms are full, by TBA room, each with a link to its Room Program. Only TBA rooms that received
// classes are listed; the numbers are the gateway's (GET /schedule/outputs tbaRequest).
// "Fill TBA rooms" (Phase 4 Part 1, Step 1) opens the panel that puts these classes into real rooms
// with free time, as a new Draft: onFill opens it; fillBlockedReason (when not '') closes the button
// and says why (not a Draft, the role may not move classes, or the page is busy); fillOpen is whether
// the panel is open now. The button is shown only when at least one TBA room holds classes.
export default function TbaRoomsToRequest({ tbaRequest, currentKey, onOpenRoom, onFill = null, fillBlockedReason = '', fillOpen = false }) {
  const rooms = Array.isArray(tbaRequest?.rooms) ? tbaRequest.rooms.filter(room => room.classCount > 0) : [];
  const header = rooms.length ? tbaRequestHeader(tbaRequest) : null;
  return (
    <section data-testid="views-tba-request" aria-labelledby="views-tba-title" className="p-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/5 space-y-2">
      <h4 id="views-tba-title" className="text-xs font-black text-slate-900 dark:text-white flex items-center uppercase tracking-wider">
        <DoorOpen size={14} className="mr-1.5 text-amber-700 dark:text-amber-400" aria-hidden="true" /> TBA rooms to request
      </h4>
      {header ? (
        <>
          <p data-testid="views-tba-header" className="text-xs text-slate-800 dark:text-slate-200">{header}</p>
          <ul className="space-y-1">
            {rooms.map(room => {
              const name = room.name || tbaRoomName(room.key);
              return (
                <li key={room.key} data-testid="views-tba-line" className="text-xs text-slate-800 dark:text-slate-200 flex flex-wrap items-center gap-x-2">
                  <button
                    type="button"
                    data-testid={`views-tba-room-${room.key}`}
                    onClick={() => onOpenRoom(room.key)}
                    aria-current={room.key === currentKey ? 'true' : undefined}
                    aria-label={`Open the Room Program of ${name}`}
                    className="font-bold underline underline-offset-2 text-indigo-800 dark:text-indigo-300 hover:text-indigo-600 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  >
                    {name}
                  </button>
                  <span>{room.classCount} class{room.classCount === 1 ? '' : 'es'} · {hoursText(room.hours)}</span>
                </li>
              );
            })}
          </ul>
          {onFill && (
            <div className="pt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                data-testid="views-fill-tba"
                onClick={onFill}
                disabled={Boolean(fillBlockedReason)}
                aria-expanded={fillOpen}
                aria-describedby={fillBlockedReason ? 'views-fill-tba-reason' : undefined}
                title={fillBlockedReason || 'Put the classes in TBA rooms into real rooms with free time, as a new Draft.'}
                className="inline-flex items-center justify-center px-3.5 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 enabled:hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-900/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
              >
                <DoorOpen size={14} className="mr-1.5" aria-hidden="true" /> Fill TBA rooms
              </button>
              {fillBlockedReason && (
                <p id="views-fill-tba-reason" data-testid="views-fill-tba-reason" className="text-[11px] text-slate-700 dark:text-slate-300">{fillBlockedReason}</p>
              )}
            </div>
          )}
        </>
      ) : (
        <p data-testid="views-tba-none" className="text-xs text-slate-800 dark:text-slate-200">Every class that needs a room has a CCS room.</p>
      )}
    </section>
  );
}
