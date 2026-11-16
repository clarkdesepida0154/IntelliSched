import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import { onDataChange } from '../utils/dataChanges';

// The Scheduling Policy (GET /api/policy): the one source for days, hours, lunch, meetings, rooms
// and load numbers. Pages share one cached copy; each mount revalidates it in the background, and a
// save anywhere updates every mounted page through setPolicyCache.
let cache = null;
let inflight = null;
const listeners = new Set();

const publish = (policy) => {
  cache = policy;
  listeners.forEach(listener => listener(policy));
};

const fetchPolicy = () => {
  if (!inflight) {
    inflight = api.get('/policy')
      .then(res => {
        if (!res.data || !Array.isArray(res.data.weekdays) || !res.data.lunch) {
          throw new Error('The gateway answered without a Scheduling Policy.');
        }
        publish(res.data);
        return res.data;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
};

export const setPolicyCache = (policy) => publish(policy);

// Phase 8 Part 8 (decision 6): a policy save (this tab, another tab or another user) applies at once:
// every mounted page reads the new copy.
onDataChange((change) => {
  if (change.topics.includes('policy') && listeners.size) fetchPolicy().catch(() => { /* the next save or mount retries */ });
});

const loadErrorMessage = (err) =>
  err.response?.data?.message || `The Scheduling Policy could not be loaded (${err.message}). Check that the gateway is running, then retry.`;

export default function usePolicy() {
  const [policy, setPolicy] = useState(cache);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(!cache);

  useEffect(() => {
    listeners.add(setPolicy);
    let active = true;
    fetchPolicy()
      .then(() => { if (active) setError(''); })
      .catch(err => { if (active) setError(loadErrorMessage(err)); })
      .finally(() => { if (active) setIsLoading(false); });
    return () => {
      active = false;
      listeners.delete(setPolicy);
    };
  }, []);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      await fetchPolicy();
    } catch (err) {
      setError(loadErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { policy, isLoading, error, reload };
}
