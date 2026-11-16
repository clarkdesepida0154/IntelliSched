// Phase 11.2 (decision 2): the Room Schedule's pages in the office's own order, ONE place for the
// room -> heading mapping and the page list (docs/formats/Room-Schedule_2nd-Sem-AY2025-26.docx, the
// office's file). Every all-rooms export, the single-room export and the print view read this.
//
//   #   Room      Heading (title line 2)                     Week group shown
//   1   LAB 1     Week 1 and 3 Computer Laboratory 1         Odd weeks
//   2   LAB 2     Week 1 and 3 Computer Laboratory 2         Odd weeks
//   3   LAB 3     Week 1 and 3 Computer Laboratory 3         Odd weeks
//   4   LAB 1     Week 2 and 4 Computer Laboratory 1         Even weeks
//   5   LAB 2     Week 2 and 4 Computer Laboratory 2         Even weeks
//   6   LAB 3     Week 2 and 4 Computer Laboratory 3         Even weeks
//   7   AVR       AVR                                        All weeks
//   8   TSL       Lecture Room 1 (TSL Room)                  All weeks
//   9   ROOM 47   CCS Room 47                                All weeks
//   10  LAB 4     Lab 4 (Lecture Room)                       All weeks
//
// The rules:
//   - a meeting that runs every week (its section has no week group) appears on both of a lab's pages;
//   - Phase 11.4 (decision 1): a lecture-room page (7-10) is ONE page with every meeting in the room,
//     both week groups and every week, under the plain heading, as the office prints it. The only
//     exception: two meetings in the room overlap on the same day (an odd-week and an even-week class
//     can share a room at one hour), which one box cannot show; only that room then keeps two pages,
//     "Week 1 and 3 <heading>" then "Week 2 and 4 <heading>" (roomScheduleClashes lists them);
//   - any other room (borrowed, new) follows after page 10, alphabetically, by the same rules;
//   - a room with no classes still gets its page (an empty grid), as in the office's file;
//   - TBA rooms are not room pages (their classes go on the last page, "Classes without a room (TBA)");
//   - a version that does not alternate weeks (no class has a week group) prints one page per room,
//     the labs included, under the plain heading (no "Week …" words: every page would be the same).
const textOf = (v) => String(v ?? '').trim();
const norm = (name) => textOf(name).toUpperCase().replace(/\s+/g, ' ');

const ODD_WORDS = 'Week 1 and 3';
const EVEN_WORDS = 'Week 2 and 4';

// The office's rooms: name as the system holds it, the heading the office prints, and whether the
// office always splits it by week group (the labs 1-3).
const OFFICE_ROOMS = [
  { room: 'LAB 1', heading: 'Computer Laboratory 1', split: true },
  { room: 'LAB 2', heading: 'Computer Laboratory 2', split: true },
  { room: 'LAB 3', heading: 'Computer Laboratory 3', split: true },
  { room: 'AVR', heading: 'AVR', split: false },
  { room: 'TSL', heading: 'Lecture Room 1 (TSL Room)', split: false },
  { room: 'ROOM 47', heading: 'CCS Room 47', split: false },
  { room: 'LAB 4', heading: 'Lab 4 (Lecture Room)', split: false }
];
const OFFICE_BY_NAME = new Map(OFFICE_ROOMS.map(r => [r.room, r]));

// The heading a room prints: the office's for the seven, the system's name for any other.
const roomHeadingOf = (room) => OFFICE_BY_NAME.get(norm(room?.name))?.heading || textOf(room?.name);

const meetingKey = (cls) => textOf(cls.itemId) || [cls.sectionId, cls.subjectId, cls.classType, cls.day, cls.startTime, cls.endTime].join('|');
const minutesOf = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(textOf(t)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// The pairs of meetings in one room that overlap on the same day (each pair once).
const overlapsOf = (classes) => {
  const list = [...new Map(classes.map(c => [meetingKey(c), c])).values()];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (textOf(a.day) !== textOf(b.day)) continue;
      const [as, ae, bs, be] = [minutesOf(a.startTime), minutesOf(a.endTime), minutesOf(b.startTime), minutesOf(b.endTime)];
      if ([as, ae, bs, be].some(v => v === null)) continue;
      if (as < be && bs < ae) pairs.push([a, b]);
    }
  }
  return pairs;
};

// The pages: [{ roomKey, roomName, heading, weekGroup: 'ODD' | 'EVEN' | 'ALL', kind: 'room' }] in the
// office's order. rooms: the outputs answer's rooms (CCS, borrowed, TBA); classes: its classes.
const planRoomSchedulePages = ({ rooms = [], classes = [] }) => {
  const realRooms = rooms.filter(r => r.kind !== 'TBA');
  const byName = new Map(realRooms.map(r => [norm(r.name), r]));
  const classesOf = (room) => classes.filter(c => c.roomKey && String(c.roomKey) === String(room.key));
  const alternating = classes.some(c => c.weekGroup);
  const page = (room, heading, weekGroup) => ({ kind: 'room', roomKey: String(room.key), roomName: textOf(room.name), heading, weekGroup });
  const pagesOfRoom = (room, heading, split) => {
    if (!alternating) return [page(room, heading, 'ALL')];
    if (split || overlapsOf(classesOf(room)).length) {
      return [page(room, `${ODD_WORDS} ${heading}`, 'ODD'), page(room, `${EVEN_WORDS} ${heading}`, 'EVEN')];
    }
    return [page(room, heading, 'ALL')];
  };
  const pages = [];
  const labs = OFFICE_ROOMS.filter(r => r.split).map(r => ({ spec: r, room: byName.get(r.room) })).filter(x => x.room);
  if (alternating) {
    // Pages 1-6: the three labs' odd weeks, then their even weeks.
    for (const group of ['ODD', 'EVEN']) {
      for (const { spec, room } of labs) pages.push(page(room, `${group === 'ODD' ? ODD_WORDS : EVEN_WORDS} ${spec.heading}`, group));
    }
  } else {
    for (const { spec, room } of labs) pages.push(page(room, spec.heading, 'ALL'));
  }
  // Pages 7-10: AVR, TSL, ROOM 47, LAB 4.
  for (const spec of OFFICE_ROOMS.filter(r => !r.split)) {
    const room = byName.get(spec.room);
    if (room) pages.push(...pagesOfRoom(room, spec.heading, false));
  }
  // Any other room, alphabetically.
  const others = realRooms
    .filter(r => !OFFICE_BY_NAME.has(norm(r.name)))
    .sort((a, b) => textOf(a.name).localeCompare(textOf(b.name), 'en', { numeric: true }) || textOf(a.key).localeCompare(textOf(b.key)));
  for (const room of others) pages.push(...pagesOfRoom(room, textOf(room.name), false));
  return pages;
};

// Phase 11.4 (decision 1): every lecture room (any room the office does not split) whose meetings
// overlap in time on the same day, with the day, the times, both classes and both week groups. These
// rooms keep two pages; the report lists them for the team.
const roomScheduleClashes = ({ rooms = [], classes = [] }) => {
  const out = [];
  for (const room of rooms.filter(r => r.kind !== 'TBA' && !OFFICE_BY_NAME.get(norm(r.name))?.split)) {
    const mine = classes.filter(c => c.roomKey && String(c.roomKey) === String(room.key));
    for (const [a, b] of overlapsOf(mine)) {
      const one = (c) => ({ subjectCode: textOf(c.subjectCode), section: textOf(c.sectionLabel || c.sectionCode), classType: textOf(c.classType), start: textOf(c.startTime), end: textOf(c.endTime), weekGroup: c.weekGroup || 'ALL' });
      out.push({ roomKey: String(room.key), roomName: textOf(room.name), heading: roomHeadingOf(room), day: textOf(a.day), a: one(a), b: one(b) });
    }
  }
  return out;
};

// The classes listed on the last page, "Classes without a room (TBA)": every class not held in a CCS
// or borrowed room (a TBA room to request, or no CCS room needed), never an online lecture (it has its
// "Online" place) or an On-The-Job Training record (it never takes a room).
const TBA_PAGE_TITLE = 'Classes without a room (TBA)';
const isWithoutRoom = (cls) => (cls.roomKind === 'TBA_ROOM' || cls.roomKind === 'NO_ROOM') && cls.classType !== 'OJT';

module.exports = { OFFICE_ROOMS, ODD_WORDS, EVEN_WORDS, TBA_PAGE_TITLE, roomHeadingOf, planRoomSchedulePages, roomScheduleClashes, isWithoutRoom };
