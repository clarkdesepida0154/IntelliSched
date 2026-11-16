import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ThemeContext } from './theme';
import { BOOT_CLASS, applyTheme, readSavedTheme, saveTheme, switchThemeSmoothly } from '../utils/themeSwitch';

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readSavedTheme);
  // The theme as drawn right now: a second click during the cross-fade flips from it.
  const current = useRef(theme);

  useEffect(() => {
    current.current = theme;
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // index.html's head script painted the saved theme's background before the app loaded; the app
  // draws its own from here on (Phase 8 Part 6, decision 6).
  useEffect(() => {
    document.documentElement.classList.remove(BOOT_CLASS);
  }, []);

  // The switch cross-fades (utils/themeSwitch.js); the class and the state change together, so the
  // new picture is complete when the fade starts.
  const toggleTheme = useCallback(() => {
    switchThemeSmoothly(() => {
      const next = current.current === 'dark' ? 'light' : 'dark';
      current.current = next;
      applyTheme(next);
      flushSync(() => setTheme(next));
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
