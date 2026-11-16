import { useSyncExternalStore } from 'react';

// The address's hash ("#/<page>?<params>"), kept in step with the browser: a menu click, a link, the
// Back and Forward buttons and a pasted address all fire `hashchange`.
const subscribe = (onChange) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const currentHash = () => window.location.hash;

export const useAddressHash = () => useSyncExternalStore(subscribe, currentHash, () => '');

// Opens an address. `replace` swaps the current history entry (a redirect), so Back skips it;
// otherwise the address gets its own entry. Both fire `hashchange`.
export const goToAddress = (address, { replace = false } = {}) => {
  if (window.location.hash === address) return;
  if (replace) window.location.replace(address);
  else window.location.hash = address;
};
