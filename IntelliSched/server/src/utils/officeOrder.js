// Phase 11.1 (decision 2): the office's own order for the printed sets, ONE place for every all-in-one
// export (the page order of the Teachers' Program, the Class Schedule and the room schedules, odd and
// even files alike), the print view's "all" and Print Outputs' pickers (the outputs answer carries the
// order as `officeOrder`). The editor's own views keep theirs.
//   Faculty: by the name as printed, first name first, titles before the name ignored; ties by surname.
//   Sections: BSIT, then BSCS; year 1 to 4; within a year, the sections without a track by letter,
//     then the tracks alphabetically (AMG, SMP, WMAD), each by letter.
//   Rooms: LAB 1–LAB 4 (by number), then AVR, TSL, ROOM 47, then any other room alphabetically, then
//     the TBA rooms.
const textOf = (v) => String(v ?? '').trim();

// ---------------------------------------------------------------- faculty
const TITLES = new Set(['DR', 'ENGR', 'PROF', 'ATTY', 'MR', 'MRS', 'MS']);
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const nameWords = (name) => {
  const words = textOf(name).split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0].replace(/\./g, '').toUpperCase())) words.shift();
  return words;
};
// "Dr. Maria C. Santos, Jr." -> "MARIA C. SANTOS, JR." (what the order reads: the printed capitals).
const printedName = (name) => nameWords(name).join(' ').toUpperCase();
const surnameOf = (name) => {
  const words = nameWords(textOf(name).split(',')[0]);
  let last = words.length - 1;
  while (last > 0 && SUFFIXES.has(words[last].replace(/\./g, '').toUpperCase())) last -= 1;
  return (words[last] || '').toUpperCase();
};
const compareFaculty = (a, b) => printedName(a?.name).localeCompare(printedName(b?.name), 'en', { sensitivity: 'base' })
  || surnameOf(a?.name).localeCompare(surnameOf(b?.name), 'en', { sensitivity: 'base' })
  || textOf(a?.facultyId ?? a?.id).localeCompare(textOf(b?.facultyId ?? b?.id));

// ---------------------------------------------------------------- sections
const PROGRAMS = { BSIT: 0, BSCS: 1 };
const BSIT_TRACKS = ['WMAD', 'SMP', 'AMG'];
const trackOf = (s) => {
  const track = textOf(s?.track).toUpperCase();
  return BSIT_TRACKS.includes(track) ? track : '';
};
// The letter after the year ("BSIT 3A WMAD" -> "A"), else the code's last letter.
const letterOf = (s) => {
  const code = textOf(s?.code ?? s?.sectionCode);
  const byYear = /\d\s*([A-Za-z])(?![A-Za-z0-9])/.exec(code);
  if (byYear) return byYear[1].toUpperCase();
  const m = /([A-Za-z])\s*$/.exec(code);
  return m ? m[1].toUpperCase() : '';
};
const compareSections = (a, b) => (PROGRAMS[textOf(a?.program).toUpperCase()] ?? 9) - (PROGRAMS[textOf(b?.program).toUpperCase()] ?? 9)
  || textOf(a?.program).localeCompare(textOf(b?.program))
  || (Number(a?.yearLevel) || 0) - (Number(b?.yearLevel) || 0)
  || trackOf(a).localeCompare(trackOf(b))
  || letterOf(a).localeCompare(letterOf(b))
  || textOf(a?.code).localeCompare(textOf(b?.code), 'en', { numeric: true });

// ---------------------------------------------------------------- rooms
const LECTURE_ROOMS = ['AVR', 'TSL', 'ROOM 47'];
const roomRank = (r) => {
  const name = textOf(r?.name).toUpperCase().replace(/\s+/g, ' ');
  if (r?.kind === 'TBA') return [3, 0];
  const lab = /^LAB ?(\d+)$/.exec(name);
  if (lab) return [0, Number(lab[1])];
  const lecture = LECTURE_ROOMS.indexOf(name);
  if (lecture >= 0) return [1, lecture];
  return [2, 0];
};
const compareRooms = (a, b) => {
  const [ra, sa] = roomRank(a);
  const [rb, sb] = roomRank(b);
  return ra - rb || sa - sb
    || (ra === 3 ? (a?.type === 'LAB' ? 0 : 1) - (b?.type === 'LAB' ? 0 : 1) : 0)
    || textOf(a?.name).localeCompare(textOf(b?.name), 'en', { numeric: true })
    || textOf(a?.key).localeCompare(textOf(b?.key), 'en', { numeric: true });
};

const sortedBy = (list, compare) => [...(list || [])].sort(compare);

// The outputs answer's `officeOrder`: the ids (sections, faculty) and keys (rooms) in the office's order.
const officeOrderOf = ({ sections = [], faculty = [], rooms = [] }) => ({
  sections: sortedBy(sections, compareSections).map(s => String(s.id)),
  faculty: sortedBy(faculty, compareFaculty).map(f => String(f.id)),
  rooms: sortedBy(rooms, compareRooms).map(r => String(r.key))
});

module.exports = { compareFaculty, compareSections, compareRooms, officeOrderOf, printedName, surnameOf, LECTURE_ROOMS };
