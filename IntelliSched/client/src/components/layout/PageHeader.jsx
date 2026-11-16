import CurrentTermNote from './CurrentTermNote';
import { pageOf } from '../../navigation/pages';

// The icon colours of the existing theme (full class names, so Tailwind keeps them).
const TONES = {
  blue: 'bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400',
  yellow: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-600 dark:text-yellow-500',
  emerald: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
  purple: 'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400',
  cyan: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-600 dark:text-cyan-400',
  red: 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400',
  indigo: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400',
  violet: 'bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400',
  orange: 'bg-orange-500/10 border-orange-500/20 text-orange-700 dark:text-orange-400',
  slate: 'bg-slate-500/10 border-slate-500/20 text-slate-600 dark:text-slate-400'
};

// A page's heading block: its icon, its name and one-line purpose from the page registry
// (navigation/pages.js), and the current term, so every page names itself the way the menu, the top
// bar and the browser tab do, and shows the current term exactly once (UI standard; audit X2, X4).
// It fills the left part of the page's own header card; the page keeps its controls beside it.
//   pageKey     the registry key of the page (required)
//   titleAddon  shown next to the name, e.g. an "Unsaved changes" badge
//   children    shown under the current term, e.g. the last-saved line or an error
export default function PageHeader({ pageKey, titleAddon = null, children = null, className = '' }) {
  const page = pageOf(pageKey);
  if (!page) throw new Error(`PageHeader: "${pageKey}" is not a page in navigation/pages.js.`);
  const Icon = page.icon;
  return (
    <div className={`flex items-center gap-4 min-w-0 ${className}`}>
      {/* On a phone the text gets the whole width. */}
      <div className={`hidden sm:block p-3 rounded-xl border shrink-0 ${TONES[page.tone] || TONES.blue}`}>
        <Icon size={28} aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Focusable by script only: the dashboard moves the focus here after a link opens the page. */}
          <h2 data-testid="page-title" tabIndex={-1} className="text-2xl font-black text-slate-900 dark:text-white tracking-wide focus:outline-none">
            {page.name}
          </h2>
          {titleAddon}
        </div>
        <p data-testid="page-purpose" className="text-sm text-slate-600 dark:text-slate-400 mt-1">{page.purpose}</p>
        <CurrentTermNote />
        {children}
      </div>
    </div>
  );
}
