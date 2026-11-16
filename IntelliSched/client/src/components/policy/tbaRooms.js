// TBA rooms (Phase 3 Step 4; Phase 2 called them "extra rooms"): helpers for the policy's overflowRooms
// { mode, enabled, lab, lec } on the Scheduling Policy page (TbaRoomsFields.jsx). The modes and their
// names are the Generate Schedule page's (utils/gaRun.js):
//   'auto'   (the default) before each run the gateway sets the counts from the Readiness Check (its
//            weekday suggestion plus one room of each type it needs);
//   'manual' every run gets the saved lab and lec counts;
//   'off'    no TBA rooms.
// A policy saved before Step 4 has no mode and reads as automatic (the gateway's mergePolicy fills it).
import { TBA_ROOM_MODES } from '../../utils/gaRun';

export const TBA_ROOM_FIELD_LABELS = { lab: 'TBA lab rooms', lec: 'TBA lecture rooms' };

export const tbaRoomsModeOf = (value) => (TBA_ROOM_MODES.includes(value?.mode) ? value.mode : 'auto');
const isRoomCount = (n) => Number.isInteger(n) && n >= 0;

// A manual count that is not a whole number is marked at once, before any save (the gateway checks the
// rest, its upper limit included, and its answer is shown next to the same field). The counts of the
// other modes are not used, so they are not checked here.
export const tbaRoomsProblems = (value) => {
  const problems = {};
  if (tbaRoomsModeOf(value) !== 'manual') return problems;
  for (const field of ['lab', 'lec']) {
    if (!isRoomCount(value?.[field])) problems[field] = `Enter a whole number of ${TBA_ROOM_FIELD_LABELS[field]}, 0 or more.`;
  }
  return problems;
};

// The value after choosing a mode: `enabled` follows it (off -> false, as the resolved policy has it).
// Leaving "Manual counts" puts the counts back to the saved ones (`savedValue`; 0 without one), since
// their fields are locked in the other modes and an unsaved or refused count would only block the save.
export const withTbaRoomsMode = (value, mode, savedValue = null) => {
  const countOf = (field) => {
    if (mode === 'manual') return value?.[field];
    if (isRoomCount(savedValue?.[field])) return savedValue[field];
    return isRoomCount(value?.[field]) ? value[field] : 0;
  };
  return { ...value, mode, enabled: mode !== 'off', lab: countOf('lab'), lec: countOf('lec') };
};
