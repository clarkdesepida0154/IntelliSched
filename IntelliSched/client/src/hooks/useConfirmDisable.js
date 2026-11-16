import { useState } from 'react';

// The question before a record is disabled (Phase 3 Step 5, audit X6: "Disable ROOM 47? It is no
// longer offered to the scheduler. You can enable it again."). Enabling never asks.
//   ask(record)  opens the question for that record
//   confirm()    runs disable(record), which resolves '' when it worked (the question closes) or the
//                message to show inside the question (it stays open, to try again or cancel)
//   keep()       closes it (not while the request is out)
// The page renders ConfirmDialog while `target` is set, with `busy` and `error`.
export default function useConfirmDisable(disable) {
  const [target, setTarget] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = (record) => {
    setError('');
    setTarget(record);
  };
  const keep = () => {
    if (busy) return;
    setTarget(null);
    setError('');
  };
  const confirm = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    const problem = await disable(target);
    setBusy(false);
    if (problem) setError(problem);
    else setTarget(null);
  };

  return { target, error, busy, ask, keep, confirm };
}
