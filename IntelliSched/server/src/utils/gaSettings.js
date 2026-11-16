// The GA settings the Dean can set (Phase 2 Steps 3-4): defaults and limits from
// shared/ga-settings.json (Engine 3's DEFAULT_SETTINGS equals them; a Python test checks it). The
// gateway keeps only recognised, finite settings and clamps them to the limits; what the Dean set is
// exactly what Engine 3 receives and what the run records. The stop is the time budget (at most 10
// minutes, default 3) or the 1000-generation cap.
const path = require('path');
const GA_SETTINGS = require(path.join(__dirname, '..', '..', '..', 'shared', 'ga-settings.json'));

const { defaults: DEFAULTS, limits: LIMITS, modes: MODES } = GA_SETTINGS;

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clamp = (n, { min, max }) => Math.min(max, Math.max(min, n));

const INT_KEYS = ['populationSize', 'tournamentSize', 'elitism'];
const FLOAT_KEYS = ['mutationRate', 'crossoverRate', 'repairRate'];

// The settings for Engine 3: { mode, populationSize, mutationRate, crossoverRate, repairRate,
// tournamentSize, elitism, timeBudgetSeconds, maxGenerations, seed? }. The time budget may come in
// minutes (the GA page) or seconds; older callers' "generations" is read as the generation cap and
// "elitismCount" as elitism. A missing value takes its default.
const sanitizeHyperparameters = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const out = { mode: MODES.includes(src.mode) ? src.mode : DEFAULTS.mode };
  for (const key of INT_KEYS) {
    const raw = finite(src[key] ?? (key === 'elitism' ? src.elitismCount : undefined));
    out[key] = raw === null ? DEFAULTS[key] : Math.round(clamp(raw, LIMITS[key]));
  }
  // Room for the repaired best and at least one child every generation (Engine 3 caps it the same way).
  out.elitism = Math.max(0, Math.min(out.elitism, out.populationSize - 2));
  for (const key of FLOAT_KEYS) {
    const raw = finite(src[key]);
    out[key] = raw === null ? DEFAULTS[key] : clamp(raw, LIMITS[key]);
  }
  const minutes = finite(src.timeBudgetMinutes);
  const seconds = finite(src.timeBudgetSeconds);
  const budget = seconds !== null ? seconds / 60 : minutes !== null ? minutes : DEFAULTS.timeBudgetMinutes;
  out.timeBudgetSeconds = Math.round(clamp(budget, LIMITS.timeBudgetMinutes) * 60);
  const cap = finite(src.maxGenerations ?? src.generations);
  out.maxGenerations = Math.round(clamp(cap === null ? LIMITS.maxGenerations.max : cap, LIMITS.maxGenerations));
  const seed = finite(src.seed);
  if (seed !== null && seed >= 0) out.seed = Math.round(seed);
  return out;
};

module.exports = { GA_SETTINGS, sanitizeHyperparameters };
