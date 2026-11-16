import { ArrowRight, Scale } from 'lucide-react';
import { SOFT_WEIGHTS } from '../../utils/policyLabels';
import { shownNumber } from '../../utils/gaRun';

// The penalty weights the next run uses (policy.softWeights), read-only in the Generate Schedule page's
// "Advanced (system team)" (Phase 3 Step 4). They are changed in one place, the Scheduling Policy page's
// Advanced area, so the two pages can never disagree; each weight has the name it has there
// (utils/policyLabels.js, e.g. "Class in a TBA room"). onOpenPolicy() opens that page.
export default function GaPenaltyWeights({ policy, policyError = '', onOpenPolicy = null }) {
  const weights = policy?.softWeights || null;
  return (
    <section aria-labelledby="ga-weights-title" data-testid="ga-weights" className="space-y-3">
      <div>
        <h4 id="ga-weights-title" className="font-bold text-sm text-slate-800 dark:text-white flex items-center">
          <Scale size={15} className="mr-2 text-indigo-600 dark:text-indigo-400" aria-hidden="true" /> Penalty weights
        </h4>
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">The soft rules the next run weighs (from the Scheduling Policy). A lower total penalty is a better schedule.</p>
      </div>
      {!weights ? (
        <p data-testid="ga-weights-missing" className="text-xs text-slate-600 dark:text-slate-400">{policyError || 'Loading the Scheduling Policy…'}</p>
      ) : (
        <table className="w-full text-xs">
          <caption className="sr-only">Penalty weights</caption>
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-slate-600 dark:text-slate-400">
              <th scope="col" className="text-left font-bold py-1.5 pr-2">Rule</th>
              <th scope="col" className="text-right font-bold py-1.5">Penalty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {SOFT_WEIGHTS.map(w => (
              <tr key={w.key} data-testid={`ga-weight-${w.key}`}>
                <td className="py-1.5 pr-2 font-medium text-slate-700 dark:text-slate-300">{w.label}</td>
                <td className="py-1.5 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">{shownNumber(weights[w.key])} {w.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {onOpenPolicy && (
        <button
          type="button"
          data-testid="ga-weights-open-policy"
          onClick={onOpenPolicy}
          className="text-xs font-bold underline underline-offset-2 text-indigo-700 dark:text-indigo-300 hover:text-indigo-500 inline-flex items-center cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          Change them on the Scheduling Policy page (Advanced) <ArrowRight size={12} className="ml-1" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
