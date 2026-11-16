// Phase 8 Part 8 (decision 6): live updates. After a save, everything on screen that shows that data
// reads it again — at once on this page, within about 2 seconds in the other tabs and browsers.
//   - A successful write through `api` announces its topics here at once (services/api.js, from the
//     shared map utils/dataTopics.js), tagged with the `origin` its caller gave (a part that already
//     shows its own change can skip its own announcements).
//   - The gateway keeps every write's topics (GET /api/changes); startChangeFeed asks every 2 seconds
//     (at once when the tab comes back into view) and announces the changes other tabs and users made.
//     This tab's own writes carry its id (X-Client-Id), so they are not announced twice.
//   - A part subscribes with hooks/useDataChanges.js and reads its data again.
// Nothing here is business data: a change is only a hint to read again.
import { DATA_TOPICS } from './dataTopics';

const POLL_MS = 2000;
const listeners = new Set();

// This tab's id (sent with every request); random, never stored.
export const CLIENT_ID = (() => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
})();

// Tells every subscriber that `topics` changed. { origin } names the part that saved (local writes);
// `remote` marks changes read from the gateway's feed.
export const announceChange = (topics, { origin = null, remote = false } = {}) => {
  const list = [...new Set((topics || []).filter(Boolean))];
  if (!list.length) return;
  const change = { topics: list, origin, remote, at: Date.now() };
  listeners.forEach((listener) => {
    try { listener(change); } catch (err) { console.error('[Live updates] a subscriber failed:', err); }
  });
};

// Subscribes to every change; returns the unsubscribe function.
export const onDataChange = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Phase 12.1 (decision 4): IntelliSched closes itself after a while without use. A tab left open then
// finds the gateway gone: after the feed had reached it, two polls in a row without any answer (not an
// error answer) tell the listeners "closed"; an answer again tells them "open".
const CLOSED_AFTER = 2;
const connectionListeners = new Set();
export const onConnectionChange = (listener) => {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
};
const tellConnection = (closed) => connectionListeners.forEach((listener) => {
  try { listener(closed); } catch (err) { console.error('[Live updates] a connection listener failed:', err); }
});

// The gateway's feed: one poll loop per tab while signed in. `api` is the axios instance.
let feed = null;
export const startChangeFeed = (api) => {
  if (feed) return feed.stop;
  const state = { boot: null, seq: -1, timer: null, stopped: false, busy: false, reached: false, missed: 0 };
  const poll = async () => {
    if (state.stopped || state.busy) return;
    // A tab out of view keeps asking too (the browser may slow its timer), so it is current when it is
    // looked at; coming back into view asks at once.
    state.busy = true;
    try {
      const res = await api.get('/changes', { params: { since: state.seq, boot: state.boot || '' } });
      const data = res.data || {};
      if (data.reset) {
        // The first read only learns where the feed stands; a later reset (a gateway restart, or a tab
        // that fell far behind) reads everything again.
        if (state.boot) announceChange(DATA_TOPICS, { remote: true });
      } else {
        const topics = (data.changes || []).filter(c => c.clientId !== CLIENT_ID).flatMap(c => c.topics || []);
        if (topics.length) announceChange(topics, { remote: true });
      }
      if (data.boot) state.boot = data.boot;
      if (Number.isInteger(data.seq)) state.seq = data.seq;
      if (state.missed >= CLOSED_AFTER) tellConnection(false);
      state.reached = true;
      state.missed = 0;
    } catch (err) {
      // Signed out, or the gateway is down: try again on the next tick. No answer at all, twice, after
      // the gateway had answered: IntelliSched was closed.
      if (err?.response) {
        state.missed = 0;
      } else if (state.reached && ++state.missed === CLOSED_AFTER) {
        tellConnection(true);
      }
    } finally {
      state.busy = false;
      schedule();
    }
    return undefined;
  };
  const schedule = () => {
    if (state.stopped) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(poll, POLL_MS);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(state.timer); poll(); } };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  poll();
  const stop = () => {
    state.stopped = true;
    clearTimeout(state.timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    feed = null;
  };
  feed = { stop };
  return stop;
};

export const stopChangeFeed = () => feed?.stop();
