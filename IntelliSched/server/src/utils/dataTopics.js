// Phase 8 Part 8 (decision 6, live updates): what each save changes. The gateway records every
// successful write's topics in its change feed (utils/changeFeed.js; GET /api/changes), which the open
// tabs read every ~2 seconds; the client announces its own writes' topics on the page at once
// (client/src/services/api.js). Every page that shows the data subscribes to its topics and reads it
// again — so one map says it for both.
// client/src/utils/dataTopics.js is an identical mirror: the code between the SHARED markers must be
// byte-for-byte the same in both files (tests/unit/dataTopics.test.js compares them).

// ---- BEGIN SHARED ----
// The kinds of data a page can show (a page subscribes to the ones it reads).
const DATA_TOPICS = ['assignments', 'faculty', 'sections', 'rooms', 'curriculum', 'policy', 'outputSettings', 'referenceLists', 'schedule', 'users', 'outsideTeachers', 'model', 'system'];

// [method or '*', the path without /api, the topics]: the first match wins. The reads sent as POST
// (the Readiness Check, the rankings, the checks and previews) and the sign-in change nothing.
const WRITE_TOPICS = [
  ['*', /^\/(auth\/)?login$/, []],
  ['*', /^\/(auth\/)?change-password$/, ['users']],
  ['POST', /^\/schedule\/(preflight|recommendations|recommendations\/batch|change-professor\/check|swap\/check|fill-tba-rooms\/preview)$/, []],
  ['*', /^\/schedule\/lock-outside$/, ['assignments', 'outsideTeachers']],
  ['*', /^\/schedule\/lock$/, ['assignments']],
  ['*', /^\/schedule\/change-professor$/, ['assignments', 'schedule']],
  ['*', /^\/schedule\/override$/, ['assignments', 'schedule']],
  ['*', /^\/schedule\/(retrain|sync-roster)$/, ['model']],
  ['*', /^\/schedule\//, ['schedule']],
  ['*', /^\/outside-teachers(\/|$)/, ['outsideTeachers', 'assignments']],
  ['*', /^\/faculty(\/|$)/, ['faculty']],
  ['*', /^\/sections(\/|$)/, ['sections']],
  ['*', /^\/facilities(\/|$)/, ['rooms']],
  ['*', /^\/(catalog|curriculum-mappings)(\/|$)/, ['curriculum']],
  ['*', /^\/policy(\/|$)/, ['policy']],
  ['*', /^\/output-settings(\/|$)/, ['outputSettings']],
  ['*', /^\/reference-lists(\/|$)/, ['referenceLists']],
  ['*', /^\/users(\/|$)/, ['users']],
  // Phase 11.3: Administration -> System. The restore's checks are reads; a restore changes everything.
  ['POST', /^\/system\/restore\/(upload|preview)$/, []],
  ['POST', /^\/system\/restore$/, ['assignments', 'faculty', 'sections', 'rooms', 'curriculum', 'policy', 'outputSettings', 'referenceLists', 'schedule', 'users', 'outsideTeachers', 'model', 'system']],
  ['*', /^\/system\//, ['system']]
];

// The topics a successful write changes ([] for a read or an unknown route). `path` may carry the
// /api prefix and a query string.
const topicsOfWrite = (method, path) => {
  const verb = String(method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return [];
  const clean = String(path || '').split('?')[0].replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
  for (const [want, pattern, topics] of WRITE_TOPICS) {
    if ((want === '*' || want === verb) && pattern.test(clean)) return [...topics];
  }
  return [];
};
// ---- END SHARED ----

module.exports = { DATA_TOPICS, WRITE_TOPICS, topicsOfWrite };
