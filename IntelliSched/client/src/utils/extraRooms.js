// TBA rooms to request (Phase 2 called them "extra rooms"): virtual rooms that stand for rooms the Dean
// must request from outside CCS, keyed EXTRA-LAB-1..n and EXTRA-LEC-1..n and never stored in Facilities.
// On screen they read by their TBA names (utils/scheduleDisplay.js: tbaRoomName, tbaRoomWording), never
// by the stored "Extra LAB room 1 (TBA – to request)". Phase 3 Step 5 removed the "Extra …" labels that
// were left here once no page showed them.

// What a TBA lab room takes, worded from the policy's "Major lecture in a LAB room" setting (the
// Scheduling Policy's TBA rooms fields).
export const extraLabRoomHelp = (majorLectureInLab) => ({
  NEVER: 'Take labs only (Major lectures never go in LAB rooms under this policy).',
  FREE: 'Take labs and Major lectures (no lecture-in-a-LAB-room penalty under this policy).'
}[majorLectureInLab] || 'Take labs, and Major lectures with the lecture-in-a-LAB-room penalty.');
