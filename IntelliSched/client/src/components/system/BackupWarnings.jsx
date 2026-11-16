import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import api from '../../services/api';
import usePermission from '../../hooks/usePermission';
import { useCurrentUser } from '../../context/user';

// Phase 11.3 (decision 7): the Dean's backup warnings on the Term Checklist, one line each with
// "Fix this" to Administration -> System. Only for a role with system.manage; nothing is shown (and
// nothing asked) for another role, and a failed read shows nothing either (the page itself says more).
export default function BackupWarnings({ onNavigate = null }) {
  const permission = usePermission('system.manage');
  const [backupWarnings, setWarnings] = useState([]);
  // Phase 12.1 (decision 2): while this account still has its starting password, the list reminds it
  // (only for that account; the gateway also keeps every other page closed until it is changed).
  const me = useCurrentUser();
  const own = me?.mustChangePassword ? [{ code: 'STARTING_PASSWORD', text: 'Change your starting password.' }] : [];
  useEffect(() => {
    if (!permission.allowed) return undefined;
    let active = true;
    api.get('/system/warnings')
      .then(res => { if (active) setWarnings(Array.isArray(res.data?.warnings) ? res.data.warnings : []); })
      .catch(() => { /* the System page shows the details */ });
    return () => { active = false; };
  }, [permission.allowed]);
  const warnings = [...own, ...(permission.allowed ? backupWarnings : [])];
  if (!warnings.length) return null;
  return (
    <ul data-testid="backup-warnings" aria-label="Backup warnings" className="space-y-2">
      {warnings.map(w => (
        <li key={w.code} data-testid={`backup-warning-${w.code}`} className="flex flex-wrap items-center gap-2 px-4 py-2.5 rounded-2xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle size={16} aria-hidden="true" className="shrink-0" />
          <span className="font-bold">{w.text}</span>
          {onNavigate && w.code !== 'STARTING_PASSWORD' && (
            <button type="button" data-testid={`backup-warning-fix-${w.code}`} onClick={() => onNavigate('system')} className="ml-auto inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-bold text-amber-950 dark:text-amber-100 bg-white dark:bg-[#18181b] border border-amber-300 dark:border-amber-500/40 hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600">
              Fix this <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
