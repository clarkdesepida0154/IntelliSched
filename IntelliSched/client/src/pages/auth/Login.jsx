import React, { useState } from 'react';
import { User, Lock, LogIn, Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import ThemeToggle from '../../components/ui/ThemeToggle';
import Wordmark from '../../components/ui/Wordmark';

export default function Login({ onLogin, isLoading, errorMessage }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(form);
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-gradient-to-br dark:from-[#020617] dark:via-[#0f172a] dark:to-[#020617] flex items-center justify-center p-6 relative overflow-hidden transition-colors duration-300">
      <ThemeToggle className="absolute top-6 right-6 z-30" />
      
      {/* Updated Ambient background to match CCS Colors (Blue & Orange) */}
      <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-blue-800/20 dark:bg-blue-600/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-orange-500/10 dark:bg-orange-600/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="flex flex-col md:flex-row w-full max-w-5xl bg-white/95 dark:bg-[#121212]/80 backdrop-blur-xl rounded-2xl shadow-2xl overflow-hidden min-h-[600px] border border-slate-200 dark:border-slate-800/50 z-10 transition-colors duration-300">
        
        {/* LEFT: Branding - Updated to CCS Maroon/Blue gradient */}
        <div className="w-full md:w-5/12 relative flex flex-col items-center justify-center p-12 text-center overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-900/95 to-red-900/90 z-10 mix-blend-multiply" />
          <div className="relative z-20 flex flex-col items-center">
            
            {/* The Actual CCS Logo */}
            <div className="w-32 h-32 bg-white rounded-full flex items-center justify-center mb-6 shadow-2xl border-4 border-white/20 p-1 overflow-hidden">
              <img src="/ccs-logo.png" alt="CCS Logo" className="w-full h-full object-contain" />
            </div>

            <h1 className="mb-2 drop-shadow-lg"><Wordmark size="large" /></h1>
            <p className="text-orange-300 text-sm font-semibold tracking-[0.2em] uppercase mb-2">College of Computer Studies</p>
            {/* Phase 8 Part 3 (decision 3): the school's name on two lines, with no dash. */}
            <p className="text-white/80 text-xs mt-8 max-w-[220px]">Laguna State Polytechnic University<br />Los Baños Campus</p>
          </div>
        </div>

        {/* RIGHT: Form */}
        <div className="w-full md:w-7/12 p-8 md:p-16 flex flex-col justify-center bg-white dark:bg-[#18181b] transition-colors duration-300">
          <div className="mb-8 text-center md:text-left">
            <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">Welcome back</h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm">Sign in to continue.</p>
          </div>

          {errorMessage && (
            <div role="alert" className="mb-6 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 dark:text-red-400 dark:bg-red-500/10 dark:border-red-500/20 rounded-xl px-4 py-3">
              <AlertCircle size={16} className="shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5 w-full max-w-md mx-auto md:mx-0">
            <div>
              <label htmlFor="login-username" className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wide">Institutional email <span aria-hidden="true" className="text-red-600">*</span></label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 dark:text-slate-500 group-focus-within:text-blue-700 transition-colors">
                  <User size={18} />
                </div>
                <input id="login-username" data-testid="login-username" name="username" type="email" autoComplete="username" required aria-required="true" value={form.username} onChange={handleChange} placeholder="person@example.test" className="w-full bg-slate-50 dark:bg-[#27272a]/50 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl py-3.5 pl-12 pr-4 focus:outline-none focus:border-blue-700 focus:ring-1 focus:ring-blue-700 transition-all placeholder-slate-400 dark:placeholder-slate-600" />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wide">Password <span aria-hidden="true" className="text-red-600">*</span></label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 dark:text-slate-500 group-focus-within:text-blue-700 transition-colors">
                  <Lock size={18} />
                </div>
                <input id="login-password" data-testid="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required aria-required="true" value={form.password} onChange={handleChange} placeholder="••••••••" className="w-full bg-slate-50 dark:bg-[#27272a]/50 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white rounded-xl py-3.5 pl-12 pr-12 focus:outline-none focus:border-blue-700 focus:ring-1 focus:ring-blue-700 transition-all placeholder-slate-400 dark:placeholder-slate-600" />
                <button type="button" data-testid="login-show-password" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((s) => !s)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Changed button to exact Blue of the CCS Logo */}
            <button type="submit" data-testid="login-submit" disabled={isLoading} className="w-full bg-blue-800 hover:bg-blue-900 text-white rounded-xl py-3.5 font-bold tracking-wide flex items-center justify-center space-x-2 transition-all active:scale-[0.98] shadow-lg shadow-blue-900/20 mt-6">
              {isLoading ? (
                <><Loader2 size={18} className="animate-spin" /><span>Signing in…</span></>
              ) : (
                <><LogIn size={18} /><span>Secure Sign In</span></>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}