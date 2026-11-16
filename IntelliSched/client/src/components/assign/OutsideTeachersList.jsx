import { useState } from 'react';
import { Pencil, Trash2, Loader2, UserRound } from 'lucide-react';
import api from '../../services/api';
import ConfirmDialog from '../ui/ConfirmDialog';
import { blockedBy } from '../../hooks/usePermission';

// Phase 8 Part 8 (decision 4): the small "Outside teachers" list under Assign Faculty's "By class" table.
// GenEd teachers from outside CCS, kept apart from the CCS faculty: a name typed in a GenEd class's
// picker joins this list (and every GenEd picker); here it can be renamed, or removed while no schedule
// version names it. `teachers` comes from GET /outside-teachers (the term's classes and `inUse`);
// `onChanged` reloads the list and the table after a save; `assign` is the faculty.assign permission.
const fieldClass = 'min-w-0 w-full max-w-56 bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-lg py-1 px-2 text-xs font-bold text-slate-800 dark:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';
const smallButton = 'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed';

const classesText = (classes) => (classes.length
  ? `${classes.length === 1 ? '1 class' : `${classes.length} classes`} this term: ${classes.map(c => `${c.subjectCode} (${c.sectionCode})`).join(', ')}`
  : 'No class this term');

export default function OutsideTeachersList({ teachers = [], onChanged, assign, notify }) {
  const [editing, setEditing] = useState(null);         // { id, name, error }
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);       // the teacher whose removal is being confirmed
  const [removeError, setRemoveError] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);

  const saveName = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setEditing({ ...editing, error: 'Type the new name.' }); return; }
    setSaving(true);
    try {
      const res = await api.patch(`/outside-teachers/${editing.id}`, { name }, { origin: 'by-class' });
      setEditing(null);
      notify?.(res.data?.message || 'The name was changed.');
      await onChanged?.();
    } catch (err) {
      // A failed save keeps what was typed.
      setEditing({ ...editing, error: err.response?.data?.message || 'The name could not be changed. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      const res = await api.delete(`/outside-teachers/${removing._id}`, { origin: 'by-class' });
      setRemoving(null);
      notify?.(res.data?.message || 'The teacher was removed.');
      await onChanged?.();
    } catch (err) {
      setRemoveError(err.response?.data?.message || 'The teacher could not be removed. Try again.');
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section data-testid="outside-teachers" aria-labelledby="outside-teachers-title" className="mt-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#1a1a1c] p-4">
      <h3 id="outside-teachers-title" className="text-sm font-black text-slate-800 dark:text-white flex items-center gap-1.5">
        <UserRound size={14} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" /> Outside teachers
      </h3>
      <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
        GenEd teachers from outside CCS. They get no Teachers' Program, load, cap or CCS room.
      </p>
      {teachers.length === 0 ? (
        <p data-testid="outside-teachers-empty" className="text-xs text-slate-600 dark:text-slate-400 mt-2">
          None yet. Add one from a GenEd class's picker.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
          {teachers.map(t => {
            const isEditing = editing?.id === t._id;
            const removeReason = !assign?.allowed ? assign?.reason : t.inUse ? 'In use: set their classes to TBA first (a saved schedule version keeps its record).' : '';
            return (
              <li key={t._id} data-testid={`outside-teacher-${t._id}`} className="py-2 flex flex-wrap items-center gap-2">
                {isEditing ? (
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`outside-teacher-name-${t._id}`} className="block text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">New name <span aria-hidden="true">*</span></label>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <input
                        id={`outside-teacher-name-${t._id}`}
                        data-testid={`outside-teacher-name-${t._id}`}
                        value={editing.name}
                        required
                        aria-invalid={Boolean(editing.error)}
                        aria-describedby={editing.error ? `outside-teacher-error-${t._id}` : undefined}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value, error: '' })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditing(null); }}
                        className={fieldClass}
                      />
                      <button type="button" data-testid={`outside-teacher-save-${t._id}`} onClick={saveName} disabled={saving} className={`${smallButton} bg-cyan-600 text-white hover:bg-cyan-700`}>
                        {saving && <Loader2 size={11} className="animate-spin" aria-hidden="true" />} Save
                      </button>
                      <button type="button" data-testid={`outside-teacher-cancel-${t._id}`} onClick={() => setEditing(null)} disabled={saving} className={`${smallButton} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200`}>
                        Cancel
                      </button>
                    </div>
                    {editing.error && <p id={`outside-teacher-error-${t._id}`} role="alert" className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">{editing.error}</p>}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-slate-800 dark:text-white">{t.name}</p>
                    <p className="text-[10px] text-slate-600 dark:text-slate-400">{classesText(t.classes || [])}</p>
                  </div>
                )}
                {!isEditing && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`outside-teacher-rename-${t._id}`}
                      onClick={() => setEditing({ id: t._id, name: t.name, error: '' })}
                      disabled={!assign?.allowed}
                      title={!assign?.allowed ? assign?.reason : undefined}
                      {...blockedBy(assign, 'matrix-permission-note')}
                      className={`${smallButton} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700`}
                    >
                      <Pencil size={11} aria-hidden="true" /> Rename
                    </button>
                    <button
                      type="button"
                      data-testid={`outside-teacher-remove-${t._id}`}
                      onClick={() => { setRemoveError(''); setRemoving(t); }}
                      disabled={Boolean(removeReason)}
                      title={removeReason || undefined}
                      aria-describedby={removeReason ? `outside-teacher-why-${t._id}` : undefined}
                      className={`${smallButton} bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-100`}
                    >
                      <Trash2 size={11} aria-hidden="true" /> Remove
                    </button>
                    {removeReason && <span id={`outside-teacher-why-${t._id}`} data-testid={`outside-teacher-why-${t._id}`} className="text-[10px] text-slate-500 dark:text-slate-400">{removeReason}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          testId="outside-teacher-remove-dialog"
          title={`Remove ${removing.name} from the outside teachers?`}
          confirmLabel={`Remove ${removing.name}`}
          busyLabel="Removing…"
          busy={removeBusy}
          error={removeError}
          onKeep={() => setRemoving(null)}
          onConfirm={confirmRemove}
        >
          <p>{removing.name} leaves the list and every GenEd class's picker. No class or schedule version names them, so nothing else changes.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
