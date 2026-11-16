import { useEffect, useState } from 'react';
import api from '../services/api';
import { onDataChange } from '../utils/dataChanges';

// The reference lists (GET /api/reference-lists): specialization domains, position titles. One
// cached copy for every page; each mount revalidates it in the background.
// The Reference Lists page (Phase 3 Step 8; pages/admin/ReferenceLists.jsx): every role may view the lists; editing
// them (PUT /api/reference-lists/:key) is the permission map's settings.edit (Step 6). Read it with
// usePermission('settings.edit'), disable the edit controls with its reason (PermissionNote), and show
// the gateway's own message on a 403 (code NOT_ALLOWED).
let cache = null;
let inflight = null;

// Reads every list from the gateway (one request at a time) and keeps the answer as the cached copy.
export const fetchReferenceLists = () => {
  if (!inflight) {
    inflight = api.get('/reference-lists')
      .then(res => {
        if (!res.data?.lists) throw new Error('The gateway answered without reference lists.');
        cache = res.data.lists;
        return cache;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
};

// After the Reference Lists page saves a list: the gateway's answer (PUT's `list`) replaces that list in
// the cached copy, so the next page that opens (e.g. a faculty profile) shows it at once.
export const rememberReferenceList = (key, list) => {
  if (!key || !list) return;
  cache = { ...(cache || {}), [key]: list };
};

// The cached lists (null until they were read once).
export const cachedReferenceLists = () => cache;

// { lists: { key: { label, items, persisted } } | null, error }. items() returns [] until loaded.
export default function useReferenceLists() {
  const [lists, setLists] = useState(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetchReferenceLists()
      .then(next => { if (active) { setLists(next); setError(''); } })
      .catch(err => {
        if (active) setError(err.response?.data?.message || `The reference lists could not be loaded (${err.message}). Check that the gateway is running, then reopen this page.`);
      });
    // Phase 8 Part 8 (decision 6): a list saved anywhere reaches this page at once.
    const off = onDataChange((change) => {
      if (!change.topics.includes('referenceLists')) return;
      fetchReferenceLists().then(next => { if (active) setLists(next); }).catch(() => { /* kept as it was */ });
    });
    return () => { active = false; off(); };
  }, []);

  return { lists, error, items: (key) => lists?.[key]?.items || [] };
}
