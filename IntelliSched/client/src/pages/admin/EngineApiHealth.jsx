import { useState, useEffect } from 'react';
import { ServerCog, Activity, Database, BrainCircuit, RefreshCw, CheckCircle2, Loader2, X, Zap, AlertCircle } from 'lucide-react';
import api from '../../services/api';
import PageHeader from '../../components/layout/PageHeader';

// Nothing is assumed: every status and latency shown comes from GET /api/health, and so do the services'
// names (the gateway's plain names, Phase 3 Step 8). The page checks when it opens and when "Check again"
// is pressed; it does not poll, so it says when it last checked instead of claiming to be live.
// Test ids: health-check-again, health-checked-at, health-service-{node|python|mongo}, health-status-{key}, health-log.
const DEFAULT_SERVICES = {
  node: { name: 'Web server (gateway)', role: 'Sign-in, and every page\'s data', status: 'Checking…', latency: '—' },
  python: { name: 'Scheduling and ranking service', role: 'Builds the Mother Schedule and ranks professors', status: 'Checking…', latency: '—' },
  mongo: { name: 'Database', role: 'Keeps every record', status: 'Checking…', latency: '—' }
};
const KEYS = ['node', 'python', 'mongo'];
const ICONS = { node: Activity, python: BrainCircuit, mongo: Database };

// The services as the gateway answered, its names first.
const fromAnswer = (s) => Object.fromEntries(KEYS.map(key => [key, {
  ...DEFAULT_SERVICES[key], name: s?.[key]?.name || DEFAULT_SERVICES[key].name, status: s?.[key]?.status || 'Unknown', latency: s?.[key]?.latency || '—'
}]));

// The badge's colour and icon follow the real status: green Online, amber Standby or still checking, red otherwise.
const toneOf = (status) => (status === 'Online'
  ? { badge: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20', bar: 'bg-emerald-500', ok: true }
  : status === 'Standby' || status === 'Checking…'
    ? { badge: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20', bar: 'bg-amber-500', ok: false }
    : { badge: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20', bar: 'bg-red-500', ok: false });

const timeText = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : null;
};

// One line per service, in plain words.
const answerLines = (s) => KEYS.map(key => `> ${s?.[key]?.name || DEFAULT_SERVICES[key].name}: ${s?.[key]?.status || 'Unknown'} (answered in ${s?.[key]?.latency || 'no time recorded'}).`);

export default function EngineApiHealth() {
  const [isPinging, setIsPinging] = useState(false);
  const [toast, setToast] = useState(null);
  const [services, setServices] = useState(DEFAULT_SERVICES);
  const [checkedAt, setCheckedAt] = useState(null);
  const [logs, setLogs] = useState(['> Checking the web server, the database and the scheduling and ranking service…']);

useEffect(() => {
    let isMounted = true;

    async function initialProbe() {
      try {
        const res = await api.get('/health');
        if (!isMounted) return;

        if (res.data?.services) {
          setServices(fromAnswer(res.data.services));
          setCheckedAt(res.data.timestamp || null);
          setLogs([...answerLines(res.data.services), '> Press "Check again" to check again.']);
        }
      } catch (err) {
        console.warn('[Health Check] Gateway probe failed:', err.message);
        if (isMounted) {
          setServices({ node: { ...DEFAULT_SERVICES.node, status: 'Offline' }, python: { ...DEFAULT_SERVICES.python, status: 'Unknown' }, mongo: { ...DEFAULT_SERVICES.mongo, status: 'Unknown' } });
          setLogs(['> The web server did not answer. Check that it is running, then press "Check again".']);
        }
      }
    }

    initialProbe();
    return () => { isMounted = false; };
  }, []);

  const handlePingServices = async () => {
    setIsPinging(true);
    setLogs(['> Checking the web server, the database and the scheduling and ranking service…']);

    try {
      const res = await api.get('/health');
      const s = res.data?.services;

      setLogs(prev => [...prev, ...answerLines(s)]);
      if (s) setServices(fromAnswer(s));
      setCheckedAt(res.data?.timestamp || null);

      const allOnline = s && KEYS.every(key => s[key]?.status === 'Online');
      setToast({ message: allOnline ? 'Check done: every service answered.' : 'Check done: at least one service is not online; see its card.' });
    } catch (err) {
      setLogs(prev => [
        ...prev,
        `> The web server did not answer (${err.message}).`
      ]);
      setToast({ message: 'The web server did not answer. Check that it is running, then press "Check again".' });
    } finally {
      setIsPinging(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  return (
    <div className="animate-in fade-in duration-300 space-y-6 relative">
      <div className="bg-white dark:bg-[#18181b] rounded-3xl border border-slate-200 dark:border-slate-800/60 shadow-lg overflow-hidden flex flex-col">
        
        {/* HEADER */}
        <div className="p-6 md:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-white/5">
          <PageHeader pageKey="api-health" />
          <div className="flex flex-col items-start sm:items-end gap-1.5">
            <button
              type="button"
              data-testid="health-check-again"
              onClick={handlePingServices}
              disabled={isPinging}
              aria-describedby={isPinging ? 'health-checking-note' : undefined}
              className="bg-emerald-700 hover:bg-emerald-800 disabled:bg-emerald-800 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center transition-all shadow-lg shadow-emerald-900/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            >
              {isPinging ? <Loader2 className="animate-spin mr-2" size={16} aria-hidden="true" /> : <RefreshCw size={16} className="mr-2" aria-hidden="true" />}
              {isPinging ? 'Checking…' : 'Check again'}
            </button>
            {isPinging && <span id="health-checking-note" className="sr-only">A check is running; the button opens again when it ends.</span>}
            <p data-testid="health-checked-at" className="text-xs text-slate-600 dark:text-slate-400">
              {timeText(checkedAt) ? `Last checked at ${timeText(checkedAt)}` : 'Not checked yet'}
            </p>
          </div>
        </div>

        <div className="h-1 w-full bg-linear-to-r from-blue-800 via-red-800 to-orange-400"></div>

        <div className="p-6 md:p-8 bg-slate-50 dark:bg-[#09090b] grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-125">
          
          {/* THE SERVICES: one card each, coloured by the status the gateway reported */}
          <ul className="lg:col-span-1 space-y-6" aria-label="Services">
            {KEYS.map(key => {
              const service = services[key];
              const tone = toneOf(service.status);
              const Icon = ICONS[key];
              return (
                <li key={key} data-testid={`health-service-${key}`} className="bg-white dark:bg-[#1a1a1c] p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm relative overflow-hidden">
                  <div aria-hidden="true" className={`absolute top-0 left-0 w-1 h-full ${tone.bar}`}></div>
                  <div className="flex justify-between items-start mb-2 gap-2">
                    {/* Phase 13: a two-line name keeps its icon on the first line. */}
                    <div className="flex items-start min-w-0">
                      <Icon size={20} className="text-slate-600 dark:text-slate-300 mr-2.5 mt-0.5 shrink-0" aria-hidden="true" />
                      <h3 className="font-bold text-slate-800 dark:text-white text-base leading-snug">{service.name}</h3>
                    </div>
                    <span data-testid={`health-status-${key}`} className={`shrink-0 flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full border ${tone.badge}`}>
                      {tone.ok ? <CheckCircle2 size={12} className="mr-1" aria-hidden="true" /> : <AlertCircle size={12} className="mr-1" aria-hidden="true" />}
                      {service.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 font-medium">{service.role}</p>
                  <p className="flex items-center text-xs font-bold mt-4 pt-4 border-t border-slate-100 dark:border-slate-800/80 text-slate-600 dark:text-slate-400">
                    <Zap size={13} className="mr-1" aria-hidden="true" /> Answered in: <span className="ml-1 text-slate-800 dark:text-slate-200">{service.latency}</span>
                  </p>
                </li>
              );
            })}
          </ul>

          {/* WHAT THE LAST CHECK FOUND (the page does not poll: it checks when it opens and on "Check again") */}
          <div className="lg:col-span-2 bg-[#1e1e24] p-6 rounded-3xl border border-slate-800 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between mb-4 border-b border-slate-700/50 pb-4">
              <h3 className="font-bold text-slate-200 text-sm flex items-center">
                <ServerCog size={16} className="mr-2 text-emerald-400" aria-hidden="true" /> What the last check found
              </h3>
            </div>

            <div data-testid="health-log" role="log" aria-live="polite" className="flex-1 bg-black/60 rounded-xl p-6 font-mono text-xs sm:text-sm border border-white/5 overflow-y-auto space-y-2.5">
              <div className="space-y-2 text-emerald-400">
                {logs.map((log, i) => (
                  <p key={i} className={i === logs.length - 1 && isPinging ? 'text-slate-200 font-bold' : ''}>
                    {log}
                  </p>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-900/95 dark:bg-white/95 text-white dark:text-slate-900 border border-slate-700/50 dark:border-slate-200 px-5 py-4 rounded-2xl shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-5 fade-in duration-300">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/20 dark:bg-emerald-500/15 flex items-center justify-center text-emerald-500 shrink-0">
            <CheckCircle2 size={18} />
          </div>
          <span className="text-sm font-bold tracking-wide">{toast.message}</span>
          <button 
            onClick={() => setToast(null)} 
            className="ml-3 text-slate-400 dark:text-slate-600 hover:text-white dark:hover:text-slate-900 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}