// Phase 6 (decision 6): the ranking's score is the model's probability (x100) that this professor is the
// one who would teach the class, learned from the past Teachers' Programs. The pages call it "Likelihood":
// the percentage with a plain level next to it. The level is read from the percentage as shown (one
// decimal), so "50.0%" is never called Medium.
//   High    50% or more
//   Medium  15% to below 50%
//   Low     below 15%
export const LIKELIHOOD_LEVELS = [
  { level: 'High', min: 50 },
  { level: 'Medium', min: 15 },
  { level: 'Low', min: -Infinity }
];

export const likelihoodLevel = (percent) => LIKELIHOOD_LEVELS.find(l => percent >= l.min)?.level || 'Low';

// { percent: '62.0%', level: 'High', text: '62.0% · High' }, or null without a score (or for the TBA pool,
// whose score is not a ranking).
export const likelihoodOf = (score, candidateId = '') => {
  if (['TBA', 'FAC-TBA'].includes(candidateId)) return null;
  if (score === undefined || score === null || score === '') return null;
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return null;
  const shown = Number(numeric.toFixed(1));
  const level = likelihoodLevel(shown);
  return { percent: `${shown.toFixed(1)}%`, level, text: `${shown.toFixed(1)}% · ${level}` };
};

// "Likelihood 62.0% · High", or "Likelihood: not given".
export const likelihoodText = (score, candidateId) => {
  const l = likelihoodOf(score, candidateId);
  return l ? `Likelihood ${l.text}` : 'Likelihood: not given';
};

export const LIKELIHOOD_HELP = "Likelihood: how likely this professor is the one who would teach the class, learned from the past Teachers' Programs. High: 50% or more. Medium: 15% to below 50%. Low: below 15%.";

// One line above the ranking of a class that nobody on the current faculty has taught before.
export const WEAK_RANKING_NOTE = 'Nobody on the current faculty has taught this subject before, so this ranking is weak. Use it as a suggestion; the Dean decides.';
