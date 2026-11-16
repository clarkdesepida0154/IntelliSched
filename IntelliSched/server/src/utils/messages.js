// The one place an unexpected error becomes words for a page (Phase 4 Part 4, "Messages"): the page gets
// the plain fallback the caller wrote ("The preview could not be made. Try again."), never raw text such
// as "connect ECONNREFUSED 127.0.0.1:8001", in every mode (the demo, the defense, the live database). The
// raw error goes to the server log. SHOW_RAW_ERRORS=1 (a developer's shell, never a mode's) puts the raw
// text in the message instead, for debugging.
//
// A message our own services wrote in plain words (the Python service's `detail`, a refusal's `message`)
// is not an unexpected error: callers pass it on themselves (serviceWords below helps with the Python
// service's answers).
const plainMessage = (err, fallback, { log = console.error, label = '[Error]' } = {}) => {
  if (err) log(`${label} ${err?.stack || err?.message || String(err)}`);
  if (process.env.SHOW_RAW_ERRORS === '1' && err?.message) return err.message;
  return fallback;
};

// The Python service's own plain words from an axios error, when it answered with a JSON `detail` string
// (our service writes those for the Dean); null for a connection error or anything else.
const serviceWords = (err) => {
  const detail = err?.response?.data?.detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
};

module.exports = { plainMessage, serviceWords };
