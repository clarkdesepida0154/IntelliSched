"""Phase 10, Step 2: Engine 2's held-out model for 2nd Sem AY 2025-26.

The same settings ml/train_eval.py chose (results.json "tuning.new_model.chosen", seed 42), fitted on the
three earlier terms ONLY (as train_eval.py does for the test term), never on the test term itself.

    ../intellisched_backend/.venv/Scripts/python scripts/eval/heldout_model.py [--save]

Writes
  docs/eval/phase10/sanity_check.json     Top-1 / Top-3 / MRR on the 70 test classes against docs/ml/RESULTS.md
  docs/eval/phase10/shap_rows.csv         the 1,190 test rows, features only, in the model's order, rows shuffled
                                          (seed 42) so no row can be tied to a class or a professor; gitignored
                                          because the eval_rating column holds logged ratings
  .demo-data/logs/phase10-heldout-rankings.json   per test class: each candidate's model score and the as-of
                                          features the comparison needs (no rating), for scripts/eval/assignment.js
  with --save, and only when the sanity check passes: the model and its .meta.json into
  .demo-data/models/intellisched_eval_test/ (the evaluation stack's own model copy; the deployed copy that was
  there is kept beside it as *.deployed.joblib / *.deployed.meta.json).
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT.parent / "intellisched_backend"
sys.path.insert(0, str(BACKEND))

import joblib  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from ml.features import FEATURES  # noqa: E402
from ml.model import FIXED_PARAMS, MODEL_TYPE, make_model, monotonic_cst  # noqa: E402
from ml.train_eval import TEST_TERM, question_metrics, rating_fallback  # noqa: E402

DATASET = ROOT / "docs" / "ml" / "private" / "dataset_full.csv"
RESULTS = ROOT / "docs" / "ml" / "results.json"
OUT = ROOT / "docs" / "eval" / "phase10"
LOGS = ROOT / ".demo-data" / "logs"
MODEL_DIR = ROOT / ".demo-data" / "models" / "intellisched_eval_test"
MODEL_FILE, META_FILE = "intellisched_gbdt_engine.joblib", "intellisched_gbdt_engine.meta.json"
EXPECTED = {"top1": 0.643, "top3": 0.814, "mrr": 0.745}  # docs/ml/RESULTS.md, test 2nd Sem AY 2025-26


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", action="store_true")
    a = ap.parse_args()
    results = json.loads(RESULTS.read_text(encoding="utf-8"))
    params, seed = results["tuning"]["new_model"]["chosen"], int(results["seed"])
    frame = pd.read_csv(DATASET).sort_values(["term_index", "question_id", "candidate"]).reset_index(drop=True)
    test_index = int(frame.loc[frame.term == TEST_TERM, "term_index"].iloc[0])
    train = frame[frame.term_index < test_index].reset_index(drop=True)
    test = frame[frame.term_index == test_index].reset_index(drop=True)
    model = make_model(params, seed, FEATURES).fit(train[FEATURES], train["label"])
    test = test.assign(score=model.predict_proba(test[FEATURES])[:, 1])

    per_q = [question_metrics(g.score.values, g.label.values) for _, g in test.groupby("question_id", sort=False)]
    got = {"top1": float(np.mean([q["top1"] for q in per_q])), "top3": float(np.mean([q["top3"] for q in per_q])),
           "mrr": float(np.mean([q["rr"] for q in per_q]))}
    passed = all(round(got[k], 3) == EXPECTED[k] for k in EXPECTED)
    OUT.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    sanity = {"test_term": TEST_TERM, "questions": len(per_q), "rows": int(len(test)),
              "candidates_per_class": sorted(int(n) for n in test.groupby("question_id").size().unique()),
              "train_terms": sorted(train.term.unique().tolist(), key=lambda t: int(train.loc[train.term == t, "term_index"].iloc[0])),
              "params": {**FIXED_PARAMS, **params, "random_state": seed},
              "expected": EXPECTED, "got": {k: round(v, 4) for k, v in got.items()}, "passed": passed}
    (OUT / "sanity_check.json").write_text(json.dumps(sanity, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(sanity, indent=2))

    test[FEATURES].sample(frac=1.0, random_state=42).to_csv(OUT / "shap_rows.csv", index=False)
    classes = []
    for qid, g in test.groupby("question_id", sort=False):
        first = g.iloc[0]
        classes.append({"question": qid, "section": first.section, "subjectCode": first.subject_code, "subjectTitle": first.subject_title,
                        "subjectKey": first.subject_key, "track": None if pd.isna(first.track) else first.track,
                        "candidates": [{"surname": r.candidate, "label": int(r.label), "score": float(r.score),
                                        "semantic_match": float(r.semantic_match), "semesters_taught": int(r.semesters_taught),
                                        "sections_taught": int(r.sections_taught),
                                        "taught_it_last_same_semester": int(r.taught_it_last_same_semester),
                                        "is_full_time": int(r.is_full_time)} for r in g.itertuples()]})
    (LOGS / "phase10-heldout-rankings.json").write_text(json.dumps({"testTerm": TEST_TERM, "classes": classes}, indent=1), encoding="utf-8")

    if a.save:
        if not passed:
            raise SystemExit("The sanity check failed: the held-out model is NOT saved.")
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for name, kept in ((MODEL_FILE, "intellisched_gbdt_engine.deployed.joblib"), (META_FILE, "intellisched_gbdt_engine.deployed.meta.json")):
            if (MODEL_DIR / name).exists() and not (MODEL_DIR / kept).exists():
                shutil.copyfile(MODEL_DIR / name, MODEL_DIR / kept)
        meta = {"phase": "10 (held-out)", "model_type": MODEL_TYPE, "features": list(FEATURES),
                "monotonic_cst": dict(zip(FEATURES, monotonic_cst(FEATURES))), "params": sanity["params"],
                "trained_on_terms": sanity["train_terms"], "rows": int(len(train)), "questions": int(train.question_id.nunique()),
                "rating_imputation": "a missing rating takes the median of the rated candidates at request time; when none is rated, the fallback below",
                "rating_fallback_median": rating_fallback(train),
                "metrics": {"test_term": TEST_TERM, "test_top1": round(got["top1"], 4), "test_top3": round(got["top3"], 4), "test_mrr": round(got["mrr"], 4),
                            "note": "held out: fitted on the three earlier terms only (Phase 10)"},
                "dataset": DATASET.name, "trained_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        joblib.dump(model, MODEL_DIR / MODEL_FILE)
        (MODEL_DIR / META_FILE).write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print(f"Saved the held-out model into {MODEL_DIR.relative_to(ROOT).as_posix()}/")


if __name__ == "__main__":
    main()
