import React, { useState, useEffect, useCallback } from 'react';
import Login from './pages/auth/Login';
import Dashboard from './pages/dashboard/Dashboard';
import PrintView from './pages/print/PrintView';
import ChangeStartingPassword from './pages/auth/ChangeStartingPassword';
import { ThemeProvider } from './context/ThemeContext';
import { TermProvider } from './context/TermContext';
import { CurrentUserProvider } from './context/CurrentUserContext';
import { useAddressHash } from './navigation/address';
import api from './services/api';
import { startChangeFeed, onConnectionChange } from './utils/dataChanges';

// The print view's address, "#/print?output=…" (Phase 3 Step 3): its query ("output=…"), or null for
// any other address. Every other "#/<page>" address is a dashboard page (navigation/pages.js).
const printSearchOf = (hash) => {
  const match = /^#\/print(?:\?(.*))?$/.exec(hash || '');
  return match ? match[1] || '' : null;
};

export default function App() {
  // A signed-in user at "#/print?…" sees the print view alone, outside the dashboard (whose
  // full-height, clipped layout would print one screen only).
  const printSearch = printSearchOf(useAddressHash());
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');

  // 1. Declare handleLogout first to satisfy ESLint hoisting and immutability rules
  const handleLogout = useCallback(() => {
    localStorage.removeItem('intellisched_token');
    delete api.defaults.headers.common['Authorization'];
    setCurrentUser(null);
    setIsLoggedIn(false);
    setErrorMessage('');
  }, []);

  // 2. Validate existing token on mount
  useEffect(() => {
    let isMounted = true;

    async function checkAuthSession() {
      const token = localStorage.getItem('intellisched_token');
      if (!token) {
        if (isMounted) setIsLoading(false);
        return;
      }

      // Attach token to Axios default headers
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      try {
        const res = await api.get('/auth/me');
        if (!isMounted) return;

        if (res.data?.success && res.data?.user) {
          setCurrentUser(res.data.user);
          setIsLoggedIn(true);
        } else {
          handleLogout();
        }
      } catch (err) {
        if (!isMounted) return;
        console.warn('[Session Verify Failed]:', err.response?.data?.message || err.message);
        handleLogout();
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    checkAuthSession();

    return () => {
      isMounted = false;
    };
  }, [handleLogout]);

  // Phase 8 Part 8 (decision 6): while signed in, this tab reads the gateway's change feed, so the other
  // tabs' and users' saves reach its pages within about 2 seconds (utils/dataChanges.js).
  useEffect(() => {
    if (!isLoggedIn) return undefined;
    return startChangeFeed(api);
  }, [isLoggedIn]);

  // Phase 12.1 (decision 4): a page left open after IntelliSched closed itself shows one calm message
  // instead of errors; it goes away by itself if the gateway answers again.
  const [appClosed, setAppClosed] = useState(false);
  useEffect(() => onConnectionChange(setAppClosed), []);

  // The browser tab while signed out (the dashboard and the print view name their own page).
  useEffect(() => {
    if (!isLoggedIn) document.title = 'Sign in – IntelliSched';
  }, [isLoggedIn]);

  // 3. Authenticate with the Express Gateway
  const handleLogin = async (credentials) => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const res = await api.post('/auth/login', {
        username: credentials.username,
        password: credentials.password
      });

      const { token, user } = res.data;

      // Persist session token
      localStorage.setItem('intellisched_token', token);
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      setCurrentUser(user);
      setIsLoggedIn(true);
    } catch (err) {
      const data = err.response?.data;
      // The sign-in throttle names the time to try again; show it in this computer's own clock.
      const retryAt = data?.code === 'LOGIN_THROTTLED' && data.retryAt ? new Date(data.retryAt) : null;
      const backendMessage = retryAt && !Number.isNaN(retryAt.getTime())
        ? `Too many failed sign-in attempts from this address. Try again at ${retryAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : data?.message || 'Could not reach the IntelliSched server. Check the network connection and try again.';
      setErrorMessage(backendMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Prevent UI flashing while checking stored credentials. The screen wears the saved theme (Phase 8
  // Part 6, decision 6): index.html's head script set the class before the app loaded.
  if (isLoading && !isLoggedIn && localStorage.getItem('intellisched_token')) {
    return (
      <div data-testid="app-verifying" className="min-h-screen bg-slate-100 dark:bg-[#0a0a0a] flex flex-col items-center justify-center text-slate-600 dark:text-white text-sm font-bold gap-2">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span>Verifying institutional credentials...</span>
      </div>
    );
  }

  if (appClosed) {
    return (
      <div data-testid="app-closed" className="min-h-screen bg-slate-100 dark:bg-[#0a0a0a] flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white dark:bg-[#18181b] border border-slate-200 dark:border-slate-800/60 rounded-2xl shadow-lg p-8">
          <p className="text-lg font-bold text-slate-900 dark:text-white">IntelliSched was closed after a while without use.</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Open it again from the IntelliSched icon on the desktop.</p>
        </div>
      </div>
    );
  }

  // The signed-in user reaches every page through CurrentUserProvider (Phase 3 Step 6): each page asks
  // the permission map what this role may do (hooks/usePermission.js).
  return (
    <ThemeProvider>
      <TermProvider user={isLoggedIn ? currentUser : null}>
        <CurrentUserProvider user={isLoggedIn ? currentUser : null}>
          {/* Phase 12.1 (decision 2): a starting password is changed before anything else opens. */}
          {isLoggedIn && currentUser?.mustChangePassword ? (
            <ChangeStartingPassword user={currentUser} onChanged={setCurrentUser} onLogout={handleLogout} />
          ) : isLoggedIn && printSearch !== null ? (
            <PrintView key={printSearch} search={printSearch} />
          ) : (
            <div className="min-h-screen bg-slate-100 dark:bg-[#0a0a0a] font-sans text-slate-700 dark:text-slate-300 transition-colors duration-300">
              {isLoggedIn ? (
                <Dashboard onLogout={handleLogout} currentUser={currentUser} />
              ) : (
                <Login onLogin={handleLogin} isLoading={isLoading} errorMessage={errorMessage} />
              )}
            </div>
          )}
        </CurrentUserProvider>
      </TermProvider>
    </ThemeProvider>
  );
}