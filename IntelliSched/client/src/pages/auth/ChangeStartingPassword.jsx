import { useState } from 'react';
import { KeyRound, Loader2, AlertCircle, LogOut } from 'lucide-react';
import api from '../../services/api';
import ThemeToggle from '../../components/ui/ThemeToggle';
import Wordmark from '../../components/ui/Wordmark';

// Phase 12.1 (decision 2): an account that signed in with a starting password sees only this page until
// it has chosen its own (the gateway refuses everything else with PASSWORD_CHANGE_REQUIRED). The current
// password, the new one twice, at least 8 characters, not the starting one. The gateway checks the same
// and writes one Audit Trail row without the password.
const MIN = 8;
const FIELDS = [
  { key: 'current', label: 'Current password', auto: 'current-password' },
  { key: 'next', label: 'New password', auto: 'new-password' },
  { key: 'confirm', label: 'New password again', auto: 'new-password' }
];

export default function ChangeStartingPassword({ user, onChanged, onLogout }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const check = () => {
    const found = {};
    if (!form.current) found.current = 'Type your current password.';
    if (form.next.length < MIN) found.next = `At least ${MIN} characters.`;
    else if (form.next === form.current) found.next = 'Choose a password different from the starting one.';
    else if (form.next !== form.confirm) found.confirm = 'The two new passwords are not the same.';
    return found;
  };

  const submit = async (e) => {
    e.preventDefault();
    setMessage('');
    const found = check();
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const res = await api.post('/auth/change-password', form);
      onChanged(res.data.user);
    } catch (err) {
      const list = Array.isArray(err.response?.data?.errors) ? err.response.data.errors : [];
      setErrors(Object.fromEntries(list.filter(x => x?.field).map(x => [x.field, x.message])));
      setMessage(err.response?.data?.message || 'The password could not be changed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="starting-password-page" className="min-h-screen bg-slate-100 dark:bg-[#0a0a0a] flex items-center justify-center p-6 relative">
      <ThemeToggle className="absolute top-6 right-6" />
      <div className="w-full max-w-md bg-white dark:bg-[#18181b] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800/60 p-8">
        <div className="mb-6">
          <Wordmark />
          <h1 className="mt-4 text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <KeyRound size={22} aria-hidden="true" /> Change your starting password
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{user?.name ? `${user.name}: ` : ''}choose your own password to continue.</p>
        </div>
        {message && (
          <div role="alert" data-testid="starting-password-error" className="mb-4 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-500/10 dark:border-red-500/20 rounded-xl px-4 py-3">
            <AlertCircle size={16} className="shrink-0" aria-hidden="true" /> <span>{message}</span>
          </div>
        )}
        <form onSubmit={submit} noValidate className="space-y-4">
          {FIELDS.map(f => (
            <div key={f.key}>
              <label htmlFor={`starting-${f.key}`} className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 uppercase tracking-wide">
                {f.label} <span aria-hidden="true" className="text-red-600">*</span>
              </label>
              <input
                id={`starting-${f.key}`}
                data-testid={`starting-${f.key}`}
                type="password"
                autoComplete={f.auto}
                required
                aria-required="true"
                aria-invalid={Boolean(errors[f.key])}
                aria-describedby={errors[f.key] ? `starting-${f.key}-error` : undefined}
                value={form[f.key]}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                disabled={saving}
                className="w-full bg-slate-50 dark:bg-[#27272a]/50 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl py-3 px-4 focus:outline-none focus:border-blue-700 focus:ring-1 focus:ring-blue-700"
              />
              {errors[f.key] && <p id={`starting-${f.key}-error`} role="alert" data-testid={`starting-${f.key}-error`} className="mt-1 text-xs font-bold text-red-600 dark:text-red-400">{errors[f.key]}</p>}
            </div>
          ))}
          <button type="submit" data-testid="starting-submit" disabled={saving} className="w-full bg-blue-800 hover:bg-blue-900 text-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-70">
            {saving ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Saving…</> : 'Change password'}
          </button>
        </form>
        <button type="button" data-testid="starting-sign-out" onClick={onLogout} className="mt-4 w-full text-sm font-bold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center gap-2">
          <LogOut size={16} aria-hidden="true" /> Sign out
        </button>
      </div>
    </div>
  );
}
