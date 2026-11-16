// Phase 8 Part 8 (decision 1f), read only: the Dean's term (docs/data/term_2nd_sem_AY2026_27.json, saved from
// the defense database) against Part 7's file (server/tests/fixtures/term_2nd_sem_AY2026_27.part7.json):
//   - every section whose flag differs, and the sections only one list has;
//   - every assignment that differs: the class, and Part 7's professor -> the Dean's.
// The two files name some sections differently (Part 7's "BSIT 3C AMG" is the Dean's "BSIT 3A AMG": the
// one 3rd-year AMG section), so a section is matched by program, year level, track and its order among
// that group's sections; a class by that section and the subject's code and title; a professor by
// surname. Nothing is changed. Writes .demo-data/logs/part8-differences.json and prints the lists.
//   node scripts/demo/part8-differences.js
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, DEMO_DATA } = require('./paths');

const DEAN = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'data', 'term_2nd_sem_AY2026_27.json'), 'utf8'));
const PART7 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'server', 'tests', 'fixtures', 'term_2nd_sem_AY2026_27.part7.json'), 'utf8'));
const OUT = path.join(DEMO_DATA, 'logs', 'part8-differences.json');
const SUFFIX = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const surnameOf = (name) => String(name || '').split(',')[0].replace(/[^A-Za-z\s-]/g, ' ').trim().split(/\s+/).filter(t => t && !SUFFIX.has(t.toUpperCase())).pop()?.toUpperCase() || '';
const letterOf = (code) => (/\b\d([A-Z])\b/.exec(String(code)) || [])[1] || '';

// "BSIT|3|AMG|1": the section's group and its place in it (by letter).
const slotsOf = (sections) => {
  const groups = new Map();
  for (const s of sections) {
    const g = `${s.program}|${s.yearLevel}|${s.track}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const bySlot = new Map();
  for (const [g, list] of groups) {
    list.sort((a, b) => letterOf(a.sectionCode).localeCompare(letterOf(b.sectionCode)) || a.sectionCode.localeCompare(b.sectionCode));
    list.forEach((s, i) => bySlot.set(`${g}|${i + 1}`, s));
  }
  return bySlot;
};
const deanSlots = slotsOf(DEAN.sections);
const part7Slots = slotsOf(PART7.sections);
const slotOfCode = (slots) => new Map([...slots].map(([slot, s]) => [s.sectionCode, slot]));
const deanSlotOf = slotOfCode(deanSlots);
const part7SlotOf = slotOfCode(part7Slots);

// sections
const flags = [];
const onlyDean = [];
const onlyPart7 = [];
const renamed = [];
for (const [slot, d] of deanSlots) {
  const p = part7Slots.get(slot);
  if (!p) { onlyDean.push(`${d.sectionCode} (${d.enabled ? 'enabled' : 'disabled'})`); continue; }
  if (p.sectionCode !== d.sectionCode) renamed.push(`${p.sectionCode} (Part 7) is ${d.sectionCode} (the Dean's)`);
  if (Boolean(p.enabled !== false) !== Boolean(d.enabled !== false)) flags.push(`${d.sectionCode}${p.sectionCode !== d.sectionCode ? ` (Part 7: ${p.sectionCode})` : ''}: Part 7 ${p.enabled !== false ? 'enabled' : 'disabled'} -> the Dean's ${d.enabled !== false ? 'enabled' : 'disabled'}`);
}
for (const [slot, p] of part7Slots) if (!deanSlots.has(slot)) onlyPart7.push(`${p.sectionCode} (${p.enabled !== false ? 'enabled' : 'disabled'})`);

// assignments
const rowsOf = (file, slotOf) => {
  const rows = new Map();
  const add = (list, kind) => (list || []).forEach(a => rows.set(`${slotOf.get(a.sectionCode) || a.sectionCode}|${a.subjectCode}|${String(a.descriptiveTitle).toLowerCase()}`, { ...a, kind }));
  add(file.assignments, 'Major');
  add(file.minorAssignments, 'Minor');
  add(file.practicumCoordinators, 'coordination');
  const open = new Map();
  [...(file.unassignedMajors || []), ...(file.unassignedMinors || []), ...(file.unassignedCoordinations || [])]
    .forEach(u => open.set(`${slotOf.get(u.sectionCode) || u.sectionCode}|${u.subjectCode}|${String(u.descriptiveTitle).toLowerCase()}`, u));
  return { rows, open };
};
const dean = rowsOf(DEAN, deanSlotOf);
const part7 = rowsOf(PART7, part7SlotOf);
const differences = [];
const same = [];
for (const [key, d] of dean.rows) {
  const p = part7.rows.get(key);
  const label = `${d.subjectCode} (${d.sectionCode}${part7Slots.get(key.split('|').slice(0, 4).join('|'))?.sectionCode && part7Slots.get(key.split('|').slice(0, 4).join('|')).sectionCode !== d.sectionCode ? `; Part 7: ${part7Slots.get(key.split('|').slice(0, 4).join('|')).sectionCode}` : ''})${d.kind === 'Major' ? '' : `, ${d.kind}`}`;
  if (p && surnameOf(p.faculty) === surnameOf(d.faculty)) { same.push(label); continue; }
  const before = p ? p.faculty : part7.open.has(key) ? `open in Part 7 (${part7.open.get(key).reasonKind === 'nobody-taught' ? "the Dean's decision" : 'left for the Secretary'})` : part7Slots.has(key.split('|').slice(0, 4).join('|')) ? 'not assigned in Part 7' : 'not in Part 7 (its section is not in Part 7\'s list)';
  differences.push({ class: label, part7: before, dean: d.faculty });
}
const onlyInPart7 = [...part7.rows].filter(([key]) => !dean.rows.has(key)).map(([, p]) => ({ class: `${p.subjectCode} (${p.sectionCode})${p.kind === 'Major' ? '' : `, ${p.kind}`}`, part7: p.faculty, dean: 'not in the Dean\'s term' }));

const record = { at: new Date().toISOString(), sections: { flags, renamed, onlyDean, onlyPart7 }, assignments: { same: same.length, differences, onlyInPart7 } };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Sections whose flag differs from Part 7's list (${flags.length}):`);
flags.forEach(l => console.log(`  ${l}`));
console.log(`Same section, another code (${renamed.length}):`);
renamed.forEach(l => console.log(`  ${l}`));
console.log(`Only in the Dean's list (${onlyDean.length}): ${onlyDean.join(', ') || 'none'}`);
console.log(`Only in Part 7's list (${onlyPart7.length}): ${onlyPart7.join(', ') || 'none'}`);
console.log(`Assignments: ${same.length} as in Part 7; ${differences.length} differ (Part 7 -> the Dean's):`);
differences.forEach(d => console.log(`  ${d.class}: ${d.part7} -> ${d.dean}`));
console.log(`In Part 7 only (${onlyInPart7.length}):`);
onlyInPart7.forEach(d => console.log(`  ${d.class}: ${d.part7}`));
console.log(`Record: ${path.relative(REPO_ROOT, OUT).split(path.sep).join('/')}`);
