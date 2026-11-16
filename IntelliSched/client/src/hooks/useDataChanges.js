import { useEffect, useRef } from 'react';
import { onDataChange } from '../utils/dataChanges';

// Phase 8 Part 8 (decision 6): reads a part's data again when a save changes it — on this page at once,
// from the other tabs and browsers within about 2 seconds (utils/dataChanges.js).
//   topics          the data the part shows (utils/dataTopics.js DATA_TOPICS), e.g. ['assignments']
//   refetch         reads the data again; called once per burst (the topics of one save fold together)
//   ignoreOrigin    skip this page's own writes made with that `origin` (a part that already shows its
//                   own change at once)
//   remoteOnly      only the other tabs' and users' saves (a page whose own saves already re-read it)
//   enabled         false while the part shows nothing that could change (e.g. a closed panel)
export default function useDataChanges(topics, refetch, { ignoreOrigin = null, remoteOnly = false, enabled = true, delay = 120 } = {}) {
  const refetchRef = useRef(refetch);
  useEffect(() => { refetchRef.current = refetch; }, [refetch]);
  const key = (topics || []).join('|');
  useEffect(() => {
    if (!enabled) return undefined;
    const wanted = new Set(key.split('|').filter(Boolean));
    let timer = null;
    const off = onDataChange((change) => {
      if (remoteOnly && !change.remote) return;
      if (ignoreOrigin && !change.remote && change.origin === ignoreOrigin) return;
      if (!change.topics.some(t => wanted.has(t))) return;
      clearTimeout(timer);
      timer = setTimeout(() => { refetchRef.current?.(change); }, delay);
    });
    return () => { off(); clearTimeout(timer); };
  }, [key, ignoreOrigin, remoteOnly, enabled, delay]);
}
