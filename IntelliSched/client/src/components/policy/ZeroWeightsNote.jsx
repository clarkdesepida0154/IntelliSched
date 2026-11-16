import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import api from '../../services/api';
import { zeroNewSoftWeights } from '../../utils/policyLabels';

// A policy saved before Phase 2 may hold 0 for the new soft rules (class in a TBA room, idle
// hours), which switches them off. This note says so on the Scheduling Policy page (its penalty
// weights, under "Advanced (system team)"), with the defaults read from the gateway
// (GET /api/policy/defaults).
const joinWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

export default function ZeroWeightsNote({ softWeights, testId }) {
  const zero = zeroNewSoftWeights(softWeights);
  const needed = zero.length > 0;
  const [defaults, setDefaults] = useState(null);

  useEffect(() => {
    if (!needed || defaults) return undefined;
    let active = true;
    api.get('/policy/defaults')
      .then(res => { if (active && res.data?.softWeights) setDefaults(res.data.softWeights); })
      .catch(() => { /* the note still reads well without the numbers */ });
    return () => { active = false; };
  }, [needed, defaults]);

  if (!needed) return null;
  const numbers = defaults ? zero.map(w => defaults[w.key]).filter(n => Number.isFinite(n)) : [];
  const defaultsText = numbers.length === zero.length ? ` (default${numbers.length === 1 ? '' : 's'} ${joinWords(numbers.map(String))})` : '';
  return (
    <p data-testid={testId} role="note" className="sm:col-span-2 flex items-start gap-2 p-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-[11px] leading-relaxed text-amber-900 dark:text-amber-200">
      <Info size={14} className="shrink-0 mt-px" aria-hidden="true" />
      <span>
        The saved policy has a weight of 0 for {joinWords(zero.map(w => `"${w.label}"`))}, so the scheduler ignores {zero.length === 1 ? 'that rule' : 'those rules'}.
        {' '}It was probably saved before {zero.length === 1 ? 'the rule' : 'these rules'} existed: the Dean may want to set {zero.length === 1 ? 'it' : 'them'}{defaultsText}, or press &ldquo;Reset to defaults&rdquo;.
      </span>
    </p>
  );
}
