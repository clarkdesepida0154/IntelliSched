// A professor's student evaluation (the latest SET rating) on the institutional 1.00-5.00 scale, stored
// as evalScore.average (models/Faculty.js). Phase 4 Part 2: 0 and an empty value both mean "no CCS
// evaluation yet" (a new hire, or faculty from another department). A new profile starts at 0, the
// tables show "0 – none yet", and the ranking engines receive it as no rating, never as a low score
// (Engine 1's roster gives such a professor Engine 2's neutral value; Engine 4's decision rows carry
// null, which the retrainer reads as its neutral default).
const EVAL_MIN = 1;
const EVAL_MAX = 5;
const NO_EVALUATION = 0;
const NO_EVALUATION_WORDS = '0 – none yet';
const EVAL_FIELD_MESSAGE = 'Enter 0 for no CCS evaluation yet, or the latest SET rating from 1.00 to 5.00.';

// Returns a finite score (0 = none yet, else 1.00-5.00 rounded to 2 dp), undefined when no score was
// sent (absent, null or ''), or null when the value sent is invalid.
const parseEvalScore = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'object' ? Number(raw.average) : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value === NO_EVALUATION) return NO_EVALUATION;
  if (value < EVAL_MIN || value > EVAL_MAX) return null;
  return Math.round(value * 100) / 100;
};

// The rating as the ranking engines and the decision rows receive it: the score when there is one,
// else null ("no rating": 0, empty, or not a number).
const ratingOrNone = (average) => {
  const n = Number(average);
  return Number.isFinite(n) && n >= EVAL_MIN && n <= EVAL_MAX ? n : null;
};

const hasEvaluation = (average) => ratingOrNone(average) !== null;

// The words of a stored average, for tables and messages: "4.52 / 5.0" or "0 – none yet".
const evalWords = (average) => {
  const rating = ratingOrNone(average);
  return rating === null ? NO_EVALUATION_WORDS : `${rating.toFixed(2)} / 5.0`;
};

module.exports = {
  EVAL_MIN,
  EVAL_MAX,
  NO_EVALUATION,
  NO_EVALUATION_WORDS,
  EVAL_FIELD_MESSAGE,
  parseEvalScore,
  ratingOrNone,
  hasEvaluation,
  evalWords
};
