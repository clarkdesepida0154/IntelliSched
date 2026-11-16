import { Lock } from 'lucide-react';

// Phase 3 Step 6: why the signed-in role can only view what this part of a page shows, in the permission
// map's words (hooks/usePermission.js). The write controls it closes point at it with
// aria-describedby={id} (blockedBy), so the reason is also their accessible description; nothing is
// hidden without an explanation. Shows nothing while the role may act.
//   permission  the usePermission result
//   lead        what the role can still do, e.g. "You can view the sections."
export default function PermissionNote({ id, testId = id, permission, lead = 'You can view this page.', className = '' }) {
  if (!permission || permission.allowed) return null;
  return (
    <p
      id={id}
      data-testid={testId}
      className={`flex items-start gap-2 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-xs text-slate-700 dark:text-slate-300 ${className}`}
    >
      <Lock size={14} className="shrink-0 mt-px" aria-hidden="true" />
      <span>{permission.loading ? permission.reason : `${lead} ${permission.reason}`}</span>
    </p>
  );
}
