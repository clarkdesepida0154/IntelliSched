// The light/dark switch (Phase 8 Part 6, decision 6): it cross-fades in about 220 ms, with no flash.
// - Where the browser has the View Transitions API, the whole page cross-fades from a picture of the
//   old theme to the new one (the duration is in index.css). Every CSS transition is off while the
//   new theme is drawn, so nothing under the fade lags behind it.
// - Elsewhere a short colour transition runs on every element, only during the switch.
// - "Reduce motion" switches at once.
// The first paint already wears the saved theme: the script in index.html's head sets the class
// before the app loads, with the same key and the same fallback to the system setting as here.
export const THEME_STORAGE_KEY = 'intellisched-theme';
export const THEME_FADE_MS = 220;
export const SWITCHING_CLASS = 'theme-switching';
export const INSTANT_CLASS = 'theme-switching-instant';
export const BOOT_CLASS = 'theme-boot';

const matches = (query) => {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
};

export const prefersReducedMotion = () => matches('(prefers-reduced-motion: reduce)');

// The saved theme, else the system's. Storage that cannot be read (a private window, blocked site
// data) falls back to the system setting.
export const readSavedTheme = () => {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage blocked: follow the system
  }
  return matches('(prefers-color-scheme: dark)') ? 'dark' : 'light';
};

// A UI preference only, so a write that fails is ignored.
export const saveTheme = (theme) => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage blocked: the theme still applies to this page
  }
};

export const applyTheme = (theme) => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
};

// After two frames the new theme has been styled with every transition off.
const afterTwoFrames = (fn) => window.requestAnimationFrame(() => window.requestAnimationFrame(fn));

let fadeTimer = null;

// Runs `update` (which changes the theme at once: the class and the React state) the smooth way.
// Returns how it ran: 'instant', 'view-transition' or 'transition'.
export const switchThemeSmoothly = (update) => {
  const root = document.documentElement;
  if (prefersReducedMotion()) {
    root.classList.add(INSTANT_CLASS);
    update();
    afterTwoFrames(() => root.classList.remove(INSTANT_CLASS));
    return 'instant';
  }
  if (typeof document.startViewTransition === 'function') {
    try {
      const transition = document.startViewTransition(() => {
        root.classList.add(INSTANT_CLASS);
        update();
      });
      const done = () => root.classList.remove(INSTANT_CLASS);
      transition.finished.then(done, done);
      return 'view-transition';
    } catch {
      // the browser refused the transition: fall back to the colour transition below
    }
  }
  root.classList.add(SWITCHING_CLASS);
  update();
  window.clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => root.classList.remove(SWITCHING_CLASS), THEME_FADE_MS + 60);
  return 'transition';
};
