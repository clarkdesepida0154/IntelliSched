// One queue for every lock and unlock write in the app (Candidate Ranking, Course Matrix). The lock
// routes update the term's draft inside a transaction, and concurrent writes to it would abort each
// other, so writes run one at a time. The queue lives at module level and outlives page remounts:
// a page waits for it before reading, so its first picture already includes every write the Dean
// has made. A write that fails after its page unmounted is kept here so the next page can report it.

let queue = Promise.resolve();
const lostWrites = [];

// Tasks catch their own errors; the extra catch only keeps one failure from stalling the queue.
export const enqueueLockWrite = (task) => {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
};

export const waitForLockWrites = () => queue;

export const reportLostLockWrite = (label, message) => {
  lostWrites.push({ label, message });
};

// Returns and clears the failures no page was mounted to show.
export const drainLostLockWrites = () => lostWrites.splice(0, lostWrites.length);

// One sentence for the failures a page drained on mount.
export const describeLostLockWrites = (lost) =>
  `${lost.length} lock change${lost.length === 1 ? '' : 's'} could not be saved after you left the page: ${lost.map(w => `${w.label} (${w.message})`).join('; ')}.`;
