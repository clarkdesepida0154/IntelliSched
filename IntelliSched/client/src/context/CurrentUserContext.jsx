import { CurrentUserContext } from './user';

// Provides the signed-in user (App.jsx's currentUser; null while signed out) to the pages.
export function CurrentUserProvider({ user = null, children }) {
  return (
    <CurrentUserContext.Provider value={user}>
      {children}
    </CurrentUserContext.Provider>
  );
}
