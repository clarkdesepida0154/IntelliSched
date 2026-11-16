import { Edit2, Ban, RotateCcw, Loader2 } from 'lucide-react';

const iconButtonClass =
  'p-1.5 rounded-lg text-slate-500 dark:text-slate-400 transition-colors cursor-pointer disabled:cursor-not-allowed ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-blue-500';

/**
 * Inline, grouped row actions: Edit, then Disable (Ban) or Enable (RotateCcw) depending on
 * the record's active state. Replaces the former 3-dot dropdown menus. Since Phase 3 Step 5 every
 * page that uses it asks before disabling (a confirmation dialog, then Undo in the message), so the
 * Disable button announces that it opens a dialog; Enable acts at once.
 *
 * Props
 * - isActive:      boolean, the record's current state
 * - onEdit:        () => void
 * - onToggle:      (event) => void, asks to disable the record, or enables it
 * - isPending:     boolean, true while a toggle request is in flight
 * - name:          string, used for accessible labels ("Edit ITEP 415")
 * - blockedReason: string, set when the signed-in role may not change the record (Phase 3 Step 6, the
 *                  permission map's reason): both buttons are disabled, with the reason as their title
 * - reasonId:      the id of the page's visible note with that reason (their accessible description)
 */
export default function RowActions({ isActive, onEdit, onToggle, isPending = false, name = '', blockedReason = '', reasonId }) {
  const accessibleName = name ? ` ${name}` : '';
  const blocked = Boolean(blockedReason);
  const describedBy = blocked ? reasonId : undefined;
  const editTitle = blocked ? blockedReason : 'Edit';
  // Dimmed only while the role may not use them (a pending toggle keeps its spinner at full strength).
  const dim = blocked ? 'opacity-60' : '';

  return (
    <div className="inline-flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={onEdit}
        disabled={isPending || blocked}
        title={editTitle}
        aria-label={`Edit${accessibleName}`}
        aria-describedby={describedBy}
        className={`${iconButtonClass} enabled:hover:text-blue-600 enabled:hover:bg-blue-50 dark:enabled:hover:bg-blue-500/10 ${dim}`}
      >
        <Edit2 size={15} />
      </button>

      {isActive ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={isPending || blocked}
          aria-busy={isPending}
          aria-haspopup="dialog"
          title={blocked ? blockedReason : 'Disable'}
          aria-label={`Disable${accessibleName}`}
          aria-describedby={describedBy}
          className={`${iconButtonClass} enabled:hover:text-red-600 enabled:hover:bg-red-50 dark:enabled:hover:bg-red-500/10 ${dim}`}
        >
          {isPending ? <Loader2 size={15} className="animate-spin text-red-600" /> : <Ban size={15} />}
        </button>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          disabled={isPending || blocked}
          aria-busy={isPending}
          title={blocked ? blockedReason : 'Enable'}
          aria-label={`Enable${accessibleName}`}
          aria-describedby={describedBy}
          className={`${iconButtonClass} enabled:hover:text-green-600 enabled:hover:bg-green-50 dark:enabled:hover:bg-green-500/10 ${dim}`}
        >
          {isPending ? <Loader2 size={15} className="animate-spin text-green-600" /> : <RotateCcw size={15} />}
        </button>
      )}
    </div>
  );
}
