import { AlertCircle, Loader2, RotateCcw, Settings2 } from 'lucide-react';
import { GA_FIELDS, MAX_SEED, modeLabel, rangeText, unusedInMode } from '../../utils/gaRun';
import Select from '../ui/Select';

const inputClass = 'w-full bg-slate-50 dark:bg-[#121212] border border-slate-200 dark:border-slate-700 rounded-xl py-2 px-3 text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60 aria-[invalid=true]:border-red-500';

const Required = () => (
  <>
    <span className="text-red-600 dark:text-red-400" aria-hidden="true"> *</span>
    <span className="sr-only"> (required)</span>
  </>
);

const FieldError = ({ id, message }) => (message ? (
  <p id={id} data-testid={id} role="alert" className="mt-1 flex items-start gap-1 text-[11px] font-bold text-red-600 dark:text-red-400">
    <AlertCircle size={12} className="mt-px shrink-0" aria-hidden="true" /> {message}
  </p>
) : null);

// One number setting: label (required mark), the input with its unit, help with the range and the
// default, and the problem next to the field.
function NumberField({ field, value, limit, defaultValue, error, disabled, unusedReason, onChange }) {
  const id = `ga-${field.key}`;
  const describedBy = [`${id}-help`, unusedReason ? `${id}-unused` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
        {field.label}{!unusedReason && <Required />}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          type="number"
          inputMode={field.whole ? 'numeric' : 'decimal'}
          min={limit?.min}
          max={limit?.max}
          step={field.step}
          required={!unusedReason}
          aria-required={!unusedReason}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          value={value}
          onChange={e => onChange(field.key, e.target.value)}
          disabled={disabled || Boolean(unusedReason)}
          className={inputClass}
        />
        {field.unit && <span className="shrink-0 text-xs text-slate-600 dark:text-slate-400">{field.unit}</span>}
      </div>
      <p id={`${id}-help`} data-testid={`${id}-help`} className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
        {field.help}{limit ? ` Allowed: ${rangeText(field, limit)}.` : ''}{defaultValue !== undefined ? ` Default: ${defaultValue}.` : ''}
      </p>
      {unusedReason && <p id={`${id}-unused`} data-testid={`${id}-unused`} className="text-[11px] font-bold text-slate-700 dark:text-slate-300 mt-1">{unusedReason}</p>}
      <FieldError id={`${id}-error`} message={unusedReason ? '' : error} />
    </div>
  );
}

// The GA settings (Phase 2 Step 4), inside the Generate Schedule page's "Advanced (system team)" since
// Phase 3 Step 4 (advanced.edit — the Dean's since Phase 8 Part 8, the office's one account; everyone
// else generates with the defaults and a new random
// seed): only the settings the GA really uses, with the gateway's defaults and limits (GET
// /api/schedule/ga-settings). `settings` is { status: 'loading' | 'ready' | 'error', defaults, limits,
// modes, message }; the form holds what was typed (strings). Settings left at the defaults are not sent
// (settingsToSend in utils/gaRun.js).
export default function GaSettingsForm({ settings, form, problems, onChange, onRetry, onUseDefaults, disabled, lockedReason }) {
  const ready = settings.status === 'ready' && form;
  const defaults = settings.defaults || {};
  const limits = settings.limits || {};
  const modes = settings.modes || [];
  const field = (f) => (
    <NumberField
      key={f.key}
      field={f}
      value={form[f.key]}
      limit={limits[f.key]}
      defaultValue={defaults[f.key]}
      error={problems[f.key]}
      disabled={disabled}
      unusedReason={unusedInMode(f, form.mode) ? `Not used by the ${modeLabel('baseline')}: it has its own fixed steps.` : ''}
      onChange={onChange}
    />
  );

  return (
    <section aria-labelledby="ga-settings-title" data-testid="ga-settings" className="space-y-4">
      <div>
        <h4 id="ga-settings-title" className="font-bold text-sm text-slate-800 dark:text-white flex items-center">
          <Settings2 size={15} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> GA settings
        </h4>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">
          Used by the next run started here. Settings left at the defaults are not sent, so that run is the same as the Dean&apos;s. <span aria-hidden="true">*</span> marks a required field.
        </p>
      </div>

      {settings.status === 'loading' && (
        <p data-testid="ga-settings-loading" className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 py-2">
          <Loader2 size={16} className="animate-spin text-indigo-500" aria-hidden="true" /> Loading the GA settings…
        </p>
      )}

      {settings.status === 'error' && (
        <div role="alert" data-testid="ga-settings-error" className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs font-bold text-red-700 dark:text-red-400 space-y-2">
          <p className="flex items-start gap-2"><AlertCircle size={14} className="shrink-0 mt-px" aria-hidden="true" /> {settings.message}</p>
          <button
            type="button"
            data-testid="ga-settings-retry"
            onClick={onRetry}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500"
          >
            Try again
          </button>
        </div>
      )}

      {ready && (
        <form noValidate onSubmit={e => e.preventDefault()} data-testid="ga-settings-form" className="space-y-4">
          {lockedReason && <p data-testid="ga-settings-locked" className="text-[11px] font-bold text-slate-700 dark:text-slate-300">{lockedReason}</p>}
          <fieldset disabled={disabled} className="min-w-0 grid grid-cols-1 md:grid-cols-2 gap-4">
            <legend className="sr-only">GA settings</legend>
            <div>
              <label htmlFor="ga-mode" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">GA to run<Required /></label>
              <Select
                id="ga-mode"
                data-testid="ga-mode"
                required
                aria-required="true"
                aria-invalid={Boolean(problems.mode)}
                aria-describedby={`ga-mode-help${problems.mode ? ' ga-mode-error' : ''}`}
                value={form.mode}
                onChange={e => onChange('mode', e.target.value)}
                className={inputClass}
              >
                {modes.map(m => <option key={m} value={m}>{modeLabel(m)}</option>)}
              </Select>
              <p id="ga-mode-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                The {modeLabel('memetic')} also repairs broken hard rules while it searches. The {modeLabel('baseline')} is kept only to compare results. Default: {modeLabel(defaults.mode)}.
              </p>
              <FieldError id="ga-mode-error" message={problems.mode} />
            </div>
            <div>
              <label htmlFor="ga-seed" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Seed <span className="font-normal text-slate-600 dark:text-slate-400">(optional)</span></label>
              <input
                id="ga-seed"
                data-testid="ga-seed"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_SEED}
                step={1}
                placeholder="Empty: a new random seed"
                aria-invalid={Boolean(problems.seed)}
                aria-describedby={`ga-seed-help${problems.seed ? ' ga-seed-error' : ''}`}
                value={form.seed}
                onChange={e => onChange('seed', e.target.value)}
                className={inputClass}
              />
              <p id="ga-seed-help" className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 leading-snug">
                Leave it empty for a new random seed. The seed is recorded with the run, so the same seed and settings can repeat it. &ldquo;Try again&rdquo; always uses a new seed.
              </p>
              <FieldError id="ga-seed-error" message={problems.seed} />
            </div>
            {GA_FIELDS.map(field)}
          </fieldset>
          <button
            type="button"
            data-testid="ga-settings-defaults"
            onClick={onUseDefaults}
            disabled={disabled}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <RotateCcw size={12} className="mr-1.5" aria-hidden="true" /> Use the defaults
          </button>
        </form>
      )}
    </section>
  );
}
