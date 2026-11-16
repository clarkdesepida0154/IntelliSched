import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../context/theme';

export default function ThemeToggle({ className = '' }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className={`w-10 h-10 rounded-full flex items-center justify-center transition-all
        bg-slate-200 hover:bg-slate-300 text-slate-600
        dark:bg-white/10 dark:hover:bg-white/20 dark:text-white
        border border-slate-300 dark:border-white/10
        focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${className}`}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}