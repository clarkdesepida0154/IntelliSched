// Where a demo database's faculty came from (Phase 3 Step 3). Committed evidence (the sample PDFs in
// docs/outputs-samples/) is made from tracked data only, so demo.js records the source when it seeds,
// in demo_meta (facultySource) and in .demo-data/run.json (facultySource):
//   'seed'          the seed file's faculty_draft (docs/data/intellisched_seed_data.json, tracked):
//                   with --faculty-seed, or when docs/data/faculty_data.json does not exist
//   'faculty_data'  docs/data/faculty_data.json (gitignored), read whenever it exists otherwise
// --faculty-seed applies when the demo seeds. On a database kept from an earlier start whose faculty
// came from elsewhere, or that does not say, the demo stops with a plain message instead of ignoring
// the flag; it never reseeds by itself.
const path = require('path');
const { SERVER_DIR } = require('./paths');
const { facultySourceOf } = require(path.join(SERVER_DIR, 'scripts', 'seed-test-db.js'));

const SOURCES = ['seed', 'faculty_data'];
const WORDS = {
  seed: "the seed file's faculty_draft (docs/data/intellisched_seed_data.json)",
  faculty_data: 'docs/data/faculty_data.json'
};

// The source a demo_meta document records; a database seeded before it was recorded says it in its
// seedCounts. null when neither says.
const facultySourceOfMeta = (meta) => (SOURCES.includes(meta?.facultySource) ? meta.facultySource : facultySourceOf(meta?.seedCounts));

// The source in words (the demo's "Ready" lines).
const facultySourceWords = (source) => WORDS[source] || 'not recorded (seeded before the demo recorded it)';

// The npm command that reseeds a mode from the seed file's faculty.
const resetCommandOf = (modeName) => `npm run ${{ normal: 'demo', defense: 'defense' }[modeName] || `demo:${modeName}`}:reset -- --faculty-seed`;

// A database kept as it was left: where its faculty came from, and why --faculty-seed can't be
// honoured on it ('' when it can, or when the flag was not given).
const keptDatabaseFaculty = ({ meta, facultySeedOnly, modeName }) => {
  const source = facultySourceOfMeta(meta);
  if (!facultySeedOnly || source === 'seed') return { source, problem: '' };
  const why = source === 'faculty_data'
    ? 'This demo database was seeded from docs/data/faculty_data.json.'
    : 'This demo database does not record where its faculty came from (it was seeded before the demo recorded it).';
  return { source, problem: `${why} Start it with --reset --faculty-seed to reseed it from the seed file: ${resetCommandOf(modeName)}. Nothing was changed.` };
};

module.exports = { facultySourceOf, facultySourceOfMeta, facultySourceWords, keptDatabaseFaculty, resetCommandOf };
