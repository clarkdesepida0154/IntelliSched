// Output Settings (Phase 3): what the outputs carry besides the schedule itself. One stored document
// (collection output_settings, key 'active', models/OutputSettings.js) that the Dean edits on the
// Output Settings page. These are its defaults, and the answer while none is stored; every read merges
// the stored document over them, so a setting added later has its default until the Dean saves.
//   campusCode       printed after room names ("ROOM 47 (LBC)", "TBA (LBC)"); empty prints the name alone
//   collegeName      the college named on every output
//   teachersProgram  form LSPU-ACAD-SF-029: the title, form code, revision and date printed on the real
//                    form, its signatory lines, whether the rooms print (the real form has none), and the
//                    print layout: 'SF029' (the official form) or 'TABLE' (the class schedule table)
//   motherSchedule   no form code, revision, date or signatory lines until the Dean sets them; the
//                    subject list under the table is off, as on the team's sample
//   roomProgram      no form code, revision, date or signatory lines until the Dean sets them
//   showEvaluationRatings  Phase 7, presentation mode: "Show evaluation ratings on screen" (on by default;
//                    the defense switches it off when it loads the term). Off, the gateway masks every
//                    rating before an answer leaves (utils/presentation.js); the ranking still uses them.
// A signatory line is { label, name, title, auto }. An empty name prints as a blank line to sign on,
// never a placeholder. auto 'professor' (Teachers' Program only) fills the line with the professor's
// name and position when printed, so the line's own name and title stay empty.
const deepFreeze = (obj) => {
  Object.values(obj).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(obj);
};

const AUTO_PROFESSOR = 'professor';
const TEACHERS_PROGRAM_LAYOUTS = ['SF029', 'TABLE'];
const OUTPUT_KEYS = ['teachersProgram', 'motherSchedule', 'roomProgram'];
// Signatory lines per output: more would push a form onto a second page.
const MAX_SIGNATORIES = 8;
// The longest text each field takes (models/OutputSettings.js uses the same numbers).
const MAX_LENGTH = deepFreeze({
  campusCode: 20,
  collegeName: 120,
  form: { title: 100, formCode: 60, revision: 30, date: 40 },
  signatory: { label: 60, name: 100, title: 100 }
});

const signatoryLine = (label, auto = '') => ({ label, name: '', title: '', auto });

const OUTPUT_SETTING_DEFAULTS = deepFreeze({
  campusCode: 'LBC',
  collegeName: 'College of Computer Studies',
  teachersProgram: {
    title: "TEACHERS' PROGRAM",
    formCode: 'LSPU-ACAD-SF-029',
    revision: 'Rev. 0',
    date: '10 August 2016',
    signatories: [
      signatoryLine('Prepared by:'),
      signatoryLine('Conformed/Received by:', AUTO_PROFESSOR),
      signatoryLine('Recommending Approval:'),
      signatoryLine('Approved:')
    ],
    showRooms: true,
    layout: 'SF029'
  },
  motherSchedule: { title: 'MOTHER SCHEDULE', formCode: '', revision: '', date: '', signatories: [], showSubjectList: false },
  roomProgram: { title: 'ROOM PROGRAM', formCode: '', revision: '', date: '', signatories: [] },
  showEvaluationRatings: true
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

// A fresh, mutable copy of the defaults.
const defaultOutputSettings = () => clone(OUTPUT_SETTING_DEFAULTS);

// Text is kept trimmed; a missing or null text is empty. Anything else is kept for the validation to name.
const cleanText = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v.trim() : v);

// A signatory line keeps only { label, name, title, auto }; the professor's line keeps no name or
// title of its own. A line that is not an object (or a list that is not one) is kept for the
// validation to name.
const cleanLines = (lines) => (Array.isArray(lines)
  ? lines.map((l) => {
    if (!isPlainObject(l)) return l === undefined ? null : l;
    const auto = cleanText(l.auto);
    const own = auto === AUTO_PROFESSOR ? { name: '', title: '' } : { name: cleanText(l.name), title: cleanText(l.title) };
    return { label: cleanText(l.label), ...own, auto };
  })
  : clone(lines));

// Deep-merges `patch` onto `base`, keeping only the keys the defaults define (anything else is
// dropped), like mergePolicy. Arrays and scalars replace; objects merge key by key.
const mergeInto = (shape, base, patch) => {
  const out = {};
  for (const key of Object.keys(shape)) {
    const baseValue = base?.[key];
    const patchValue = patch?.[key];
    if (isPlainObject(shape[key])) {
      out[key] = mergeInto(shape[key], isPlainObject(baseValue) ? baseValue : shape[key], isPlainObject(patchValue) ? patchValue : undefined);
      continue;
    }
    const value = patchValue !== undefined ? patchValue : baseValue !== undefined ? baseValue : shape[key];
    if (key === 'signatories') out[key] = cleanLines(value);
    else if (typeof shape[key] === 'string') out[key] = cleanText(value);
    else out[key] = clone(value);
  }
  return out;
};

const mergeOutputSettings = (base, patch) => mergeInto(OUTPUT_SETTING_DEFAULTS, base, patch);

// Returns [{ field, message }] in plain words; an empty list means the settings can be saved.
// Fields are the settings' paths, e.g. 'collegeName', 'teachersProgram.layout',
// 'motherSchedule.signatories.0.label'.
const validateOutputSettings = (s) => {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  // `what` names the field in words; `required` is the message for an empty one (optional when unset).
  const checkText = (field, value, max, what, required = '') => {
    if (typeof value !== 'string') add(field, `Enter ${what} as text.`);
    else if (!value && required) add(field, required);
    else if (value.length > max) add(field, `Keep ${what} to ${max} characters or fewer.`);
  };
  const checkBool = (field, value) => { if (typeof value !== 'boolean') add(field, 'Choose on or off.'); };

  checkText('campusCode', s?.campusCode, MAX_LENGTH.campusCode, 'the campus code');
  checkText('collegeName', s?.collegeName, MAX_LENGTH.collegeName, "the college's name", "Enter the college's name: every output prints it.");
  checkBool('showEvaluationRatings', s?.showEvaluationRatings);

  for (const output of OUTPUT_KEYS) {
    const o = isPlainObject(s?.[output]) ? s[output] : {};
    checkText(`${output}.title`, o.title, MAX_LENGTH.form.title, 'the title', 'Enter a title: it is printed at the top of the form.');
    checkText(`${output}.formCode`, o.formCode, MAX_LENGTH.form.formCode, 'the form code');
    checkText(`${output}.revision`, o.revision, MAX_LENGTH.form.revision, 'the revision');
    checkText(`${output}.date`, o.date, MAX_LENGTH.form.date, 'the date');
    if (output === 'teachersProgram') {
      checkBool('teachersProgram.showRooms', o.showRooms);
      if (!TEACHERS_PROGRAM_LAYOUTS.includes(o.layout)) add('teachersProgram.layout', 'Choose the print layout: "SF-029 form" or "Class schedule table".');
    }
    if (output === 'motherSchedule') checkBool('motherSchedule.showSubjectList', o.showSubjectList);

    const lines = o.signatories;
    if (!Array.isArray(lines)) {
      add(`${output}.signatories`, 'Send the signatory lines as a list.');
      continue;
    }
    if (lines.length > MAX_SIGNATORIES) add(`${output}.signatories`, `Use at most ${MAX_SIGNATORIES} signatory lines, so the form still fits on one page.`);
    let professorLines = 0;
    lines.forEach((l, i) => {
      const at = `${output}.signatories.${i}`;
      if (!isPlainObject(l)) {
        add(at, "Enter this line's label, name and title.");
        return;
      }
      checkText(`${at}.label`, l.label, MAX_LENGTH.signatory.label, 'the label', 'Enter a label for this line, for example "Approved:".');
      checkText(`${at}.name`, l.name, MAX_LENGTH.signatory.name, 'the name');
      checkText(`${at}.title`, l.title, MAX_LENGTH.signatory.title, 'the title');
      if (l.auto === AUTO_PROFESSOR) {
        if (output !== 'teachersProgram') add(`${at}.auto`, "Only the Teachers' Program can fill in a line with the professor's name.");
        else if (++professorLines > 1) add(`${at}.auto`, "Only one line can be filled in with the professor's name.");
      } else if (l.auto !== '') {
        add(`${at}.auto`, "A line can be filled in automatically only with the professor's name and position.");
      }
    });
  }
  return errors;
};

// The settings every output reads: the stored document merged over the defaults, or the defaults
// when none is stored. Never writes.
const loadOutputSettings = async () => {
  const OutputSettings = require('../models/OutputSettings');
  const stored = await OutputSettings.findOne({ key: OutputSettings.ACTIVE_KEY }).lean();
  return stored ? mergeOutputSettings(stored, undefined) : defaultOutputSettings();
};

module.exports = {
  OUTPUT_SETTING_DEFAULTS,
  OUTPUT_KEYS,
  TEACHERS_PROGRAM_LAYOUTS,
  AUTO_PROFESSOR,
  MAX_SIGNATORIES,
  MAX_LENGTH,
  defaultOutputSettings,
  mergeOutputSettings,
  validateOutputSettings,
  loadOutputSettings
};
