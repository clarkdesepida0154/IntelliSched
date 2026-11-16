// Phase 7, presentation mode: the Output Setting "Show evaluation ratings on screen"
// (showEvaluationRatings; on by default, utils/outputSettings.js). The defense switches it off when it
// loads the term, so the professors' student-evaluation ratings never reach the projector. While it is
// off, every answer of the gateway passes through maskRatings (middleware/presentationMode.js), so no
// rating value reaches the browser:
//   - a faculty record's evalScore ({ average, history }: the Faculty table, the form, the evaluation
//     history, Log Evaluation's answer) becomes { hidden: true }, read as "Hidden (presentation mode)";
//   - the numbers named in RATING_KEYS become null: a decision row's selectedEvalScore /
//     rejectedEvalScore (the schedule's own rows, Model Feedback), the ranking's features.eval_rating
//     (the rating, or the median of the rated professors for one without), the roster's evalAverage;
//   - every text "Student evaluation: 4.45 of 5" (the ranking's reasons, on both recommendation routes,
//     in Change professor, and in a decision's reason) reads "Student evaluation: on record";
//     "No CCS evaluation yet" stays.
// The ratings stay in the database and the ranking still reads them there (the Python service loads
// the roster itself; decision rows store the real values for Engine 4), so no ranking changes.
const { loadOutputSettings } = require('./outputSettings');

const HIDDEN_WORDS = 'Hidden (presentation mode)';
const RATING_KEYS = new Set(['selectedEvalScore', 'rejectedEvalScore', 'eval_rating', 'evalAverage']);
const RATING_TEXT = /Student evaluation: \d+(?:\.\d+)? of 5/g;
const ON_RECORD = 'Student evaluation: on record';

// The answer as it will be sent (JSON), with every rating masked. A faculty record's evalScore object
// becomes { hidden: true }; a bare rating number under that name becomes null.
const maskRatings = (value) => {
  if (typeof value === 'string') return value.replace(RATING_TEXT, ON_RECORD);
  if (Array.isArray(value)) return value.map(maskRatings);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'evalScore') out[key] = item && typeof item === 'object' ? { hidden: true } : null;
    else if (RATING_KEYS.has(key)) out[key] = null;
    else out[key] = maskRatings(item);
  }
  return out;
};

// True while "Show evaluation ratings on screen" is off. Read on every request (one small document),
// so a change on the Output Settings page applies to the next answer.
const ratingsHidden = async () => (await loadOutputSettings()).showEvaluationRatings === false;

// The refusal of Log Evaluation while ratings are hidden (the page closes the button with the same words).
const RATINGS_HIDDEN = Object.freeze({
  success: false,
  code: 'RATINGS_HIDDEN',
  message: 'Evaluation ratings are hidden (presentation mode). Turn "Show evaluation ratings on screen" on in Output Settings to log an evaluation.'
});

module.exports = { HIDDEN_WORDS, ON_RECORD, RATING_KEYS, maskRatings, ratingsHidden, RATINGS_HIDDEN };
