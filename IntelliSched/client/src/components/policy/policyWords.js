// Plain-word helpers for the Scheduling Policy page and its Rules list (Phase 3 Step 4).

// ['a'] -> 'a', ['a', 'b'] -> 'a and b', ['a', 'b', 'c'] -> 'a, b and c'
export const joinWords = (words, last = 'and') => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`);

const ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

// [2, 3] -> '2nd and 3rd years', [1] -> '1st years', [] -> 'no year level'
export const yearsWords = (years) => {
  const list = [...(years || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return list.length ? `${joinWords(list.map(y => ORDINALS[y] || `${y}th`))} years` : 'no year level';
};
