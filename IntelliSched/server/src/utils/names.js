// The professors' names in one style (Phase 8 Part 8, decision 3a): "First M. Last".
//   - every word starts with a capital ("ROWAN" -> "Rowan", "maribel" -> "Maribel"; a word typed in
//     mixed case keeps its other letters, so "McArthur" stays);
//   - a period after each initial ("Carolina R Faculty" -> "FacultyMember");
//   - a suffix is written ", Jr." ("Alejandro V. Faculty Jr." -> "FacultyMember"; II, III
//     and IV stay in capitals);
//   - a degree never sits inside the name: "FacultyMember, PhD" -> "FacultyMember" with the degree
//     "PhD", which belongs in "Degree after the name" (Faculty.degreeAfterName).
// The Faculty form (academicController) and the term loader normalize on every save; the Part 8
// migration (server/scripts/migrate-part8.js) fixes the stored names. A middle initial is never
// guessed: "Morris Virtus Faculty" keeps its words (the faculty board gives the initials the migration
// uses). Two places keep their own style, built from this name: the Teachers' Program's name line in
// capitals with the degree (scheduleOutputs.sf029NameWithDegree) and the Class Schedule's cells as
// initial and surname ("M. Faculty").

// The degrees a name may carry after a comma, in the case the forms print them ("PhD", "EdD", "MSIT").
const DEGREES = ['PhD', 'EdD', 'DIT', 'DBA', 'DPA', 'DEng', 'DSc', 'DM', 'MIT', 'MSIT', 'MSCS', 'MSCpE', 'MSCE', 'MSIS',
  'MPA', 'MBA', 'MAEd', 'MAT', 'MEd', 'MEng', 'MSc', 'MA', 'MS', 'MM', 'LPT', 'CPA'];
const DEGREE_BY_KEY = new Map(DEGREES.map(d => [d.toUpperCase(), d]));
const SUFFIXES = { JR: 'Jr.', SR: 'Sr.', II: 'II', III: 'III', IV: 'IV', V: 'V' };

const squeeze = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const keyOf = (token) => String(token).replace(/\./g, '').toUpperCase();
const degreeOf = (token) => DEGREE_BY_KEY.get(keyOf(token)) || null;
const suffixOf = (token) => SUFFIXES[keyOf(token)] || null;
// A comma part made of degrees only ("PhD", "MIT, PhD" split earlier): the degrees, else null.
const degreesIn = (part) => {
  const tokens = squeeze(part).split(/[\s/]+/).filter(Boolean);
  const found = tokens.map(degreeOf);
  return tokens.length && found.every(Boolean) ? found : null;
};

// One word: an initial ("R", "r.", "R.") becomes "R."; a word in all capitals or all lowercase starts
// with a capital and continues in lowercase (each part of a hyphenated word too); a word typed in mixed
// case keeps its letters, only its first one raised.
const wordOf = (token) => {
  if (/^[A-Za-z]\.?$/.test(token)) return `${token[0].toUpperCase()}.`;
  return token.split('-').map((piece) => {
    if (!piece) return piece;
    const letters = piece.replace(/[^A-Za-z]/g, '');
    const plain = letters === letters.toUpperCase() || letters === letters.toLowerCase();
    const body = plain ? piece.toLowerCase() : piece;
    const at = body.search(/[A-Za-z]/);
    return at < 0 ? body : `${body.slice(0, at)}${body[at].toUpperCase()}${body.slice(at + 1)}`;
  }).join('-');
};

// { name, degree, changed } for a name as typed or stored. `degree` is the degree the name carried
// (several joined with ", "), or '' when none; `changed` says whether the name differs from the input.
const normalizeName = (raw) => {
  const input = squeeze(raw);
  if (!input) return { name: '', degree: '', changed: false };
  const parts = input.split(',').map(squeeze).filter(Boolean);
  let base = parts.shift() || '';
  let suffix = '';
  const degrees = [];
  const kept = [];
  for (const part of parts) {
    const asSuffix = !part.includes(' ') && suffixOf(part);
    const asDegrees = degreesIn(part);
    if (asSuffix && !suffix) suffix = asSuffix;
    else if (asDegrees) degrees.push(...asDegrees);
    else kept.push(part);
  }
  // A suffix or a degree typed without a comma at the end of the name ("Faculty Jr.", "Faculty MSIT").
  let tokens = base.split(' ').filter(Boolean);
  for (;;) {
    const last = tokens[tokens.length - 1];
    if (tokens.length > 2 && !suffix && suffixOf(last)) { suffix = suffixOf(last); tokens = tokens.slice(0, -1); continue; }
    if (tokens.length > 2 && degreeOf(last) && keyOf(last).length > 2) { degrees.unshift(degreeOf(last)); tokens = tokens.slice(0, -1); continue; }
    break;
  }
  base = tokens.map(wordOf).join(' ');
  const name = [base + (suffix ? `, ${suffix}` : ''), ...kept.map(p => p.split(' ').map(wordOf).join(' '))].join(', ');
  return { name, degree: [...new Set(degrees)].join(', '), changed: name !== input };
};

module.exports = { normalizeName, DEGREES };
