import { createContext, useContext } from 'react';

// The signed-in user ({ id, name, email, role, status, lastLogin }, from POST /auth/login or GET
// /auth/me), which App.jsx provides to everything it renders (Phase 3 Step 6), so every page and every
// part of a page reads the same role (hooks/useRole.js, hooks/usePermission.js) without passing it down.
// The context object and hook live apart from the provider component, so the provider file exports only
// a component (react-refresh/only-export-components). null outside the provider.
export const CurrentUserContext = createContext(null);

export const useCurrentUser = () => useContext(CurrentUserContext);
