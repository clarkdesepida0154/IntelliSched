"""Tunes, trains and evaluates Engine 2's ranking model (Phase 8 Part 11; replaces the Phase 5 script).

Run from ../intellisched_backend with its .venv:
    .venv/Scripts/python ml/train_eval.py [--dataset ../IntelliSched/docs/ml/private/dataset_full.csv]
                                         [--out-dir ../IntelliSched/docs/ml] [--seed 42] [--bootstrap 2000]
                                         [--no-figures] [--no-save]

The task is ranking: one class (a section's Major subject), a list of professors (every professor with a
CCS class that term), one correct answer (who taught it). In order:
 1. the split: train on the first three terms, test on 2nd Sem AY 2025-26 (unseen; the same semester
    type as the real target). The test term is used once, at the end; it never chooses anything.
 2. tuning on the training terms only: leave-one-term-out (each training term held out in turn), scored
    by mean reciprocal rank, over the small grid GRID fixed in advance, for the new model (HistGradientBoostingClassifier with
    monotonic constraints, ml/model.py) and over C for the monotonic logistic regression; the Phase 5
    recipe ("the current model": GradientBoostingClassifier, its shipped settings) gets the same folds.
 3. the keep rule: the new model is saved for real use only when its cross-validated MRR is at least the
    current model's AND the sweep of every constrained feature finds no step against its direction.
 4. the test, every method on the same 70 questions: random order, semantic match alone, most sections
    taught, the last same-semester teacher, the current model, the monotonic logistic regression and the
    new model (the three models fitted on the three training terms). Top-1, Top-3, MRR and NDCG@3; the
    top pick as a classification (accuracy, precision, recall, F1 and the confusion matrix over the
    candidate rows); the probability quality per candidate row (ROC-AUC, PR-AUC, log loss, Brier). 95%
    bootstrap intervals (2,000 resamples of the questions, seed 42) and paired differences against the
    rule and the current model.
 5. permutation importance on the test term (the drop in MRR, 20 shuffles each), each feature's effect
    (the mean predicted probability as the feature moves, the others as they are) and six named cases.
 6. the model for real use: the chosen settings fitted on all 4 terms, saved as
    intellisched_gbdt_engine.joblib with its .meta.json; the Phase 5 file is kept once as
    intellisched_gbdt_engine.phase5.joblib (and its meta as .phase5.meta.json).

Writes results.json, RESULTS.md (every number read back from results.json) and four figures (PNG,
300 dpi): top1_top3.png, confusion_matrix.png, permutation_importance.png, feature_effects.png. Prints
counts and metrics only, never a rating; the committed files show a rating only as rated / not rated.

Why leave-one-term-out and not GroupKFold by question: a professor's term-level facts (the rating, full-time,
the program experience) are the same in every question of a term, so folds that split one term's questions
let a model memorise who was busy that term. The first run (14 Oct 2026) tuned with GroupKFold: the Phase 5
recipe scored MRR 0.547 there but 0.207 (random: 0.202) when a whole term was held out. The scheme was
switched after that run, on that training-only diagnosis; FIRST_RUN records it and RESULTS.md says so. The
GroupKFold scores are still computed for the chosen settings, as a diagnostic.

Ties are scored exactly: when the taught professor shares the score with t others, Top-k, the reciprocal
rank and NDCG@3 are their expected values over a random order of the tie. The random baseline is the case
where everyone ties.
"""
from __future__ import annotations

import argparse
import itertools
import json
import platform
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.features import FEATURES, NEVER_TAUGHT  # noqa: E402
from ml.model import (FIXED_PARAMS, MODEL_TYPE, MonotonicLogit, make_model, make_phase5_model,  # noqa: E402
                      monotonic_cst, phase5_frame, sweep_violations)

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = BACKEND_DIR.parent / "IntelliSched" / "docs" / "ml"
DEFAULT_DATASET = DEFAULT_OUT_DIR / "private" / "dataset_full.csv"
PUBLIC_DATASET = DEFAULT_OUT_DIR / "dataset_public.csv"
MODEL_PATH = BACKEND_DIR / "intellisched_gbdt_engine.joblib"
META_PATH = BACKEND_DIR / "intellisched_gbdt_engine.meta.json"
PHASE5_MODEL_PATH = BACKEND_DIR / "intellisched_gbdt_engine.phase5.joblib"
PHASE5_META_PATH = BACKEND_DIR / "intellisched_gbdt_engine.phase5.meta.json"

TEST_TERM = "2nd Sem AY 2025-26"
FOLDS = 5
CV_SCHEME = "leave-one-term-out"
# The first run of 14 Oct 2026 (tuned with GroupKFold by question; not kept), recorded for the disclosure.
FIRST_RUN = {
    "cv_scheme": "GroupKFold by question (5 folds)",
    "chosen": {"max_depth": 2, "learning_rate": 0.1, "min_samples_leaf": 40, "l2_regularization": 1.0, "max_iter": 100},
    "cv_mrr_new": 0.4481, "cv_mrr_current": 0.5473, "kept": False,
    "loto_diagnosis_on_training_terms": {"current_model": 0.2065, "new_model_same_settings": 0.3443, "monotonic_logit_C1": 0.3056,
                                         "last_same_semester_teacher": 0.3722, "random": 0.2018},
    "test_numbers_printed": {"current_model": {"top1": 0.657, "mrr": 0.769}, "new_model": {"top1": 0.614, "mrr": 0.730},
                             "last_same_semester_teacher": {"top1": 0.626, "mrr": 0.712}},
    "note": "The run printed the test term's numbers before the switch; no setting was chosen on them.",
}
PERMUTATION_REPEATS = 20
# The grid, fixed before any run (the prompt's ranges: depth 2-3, learning rate 0.03-0.1, leaves of 10-40
# rows, an L2 penalty; early stopping off).
GRID: Dict[str, List[Any]] = {
    "max_depth": [2, 3],
    "learning_rate": [0.03, 0.1],
    "min_samples_leaf": [10, 20, 40],
    "l2_regularization": [0.0, 1.0],
    "max_iter": [100, 200],
}
LOGIT_GRID: Dict[str, List[Any]] = {"C": [0.01, 0.1, 1.0]}
# The Phase 5 model's shipped settings (intellisched_gbdt_engine.meta.json of 3 Oct 2026).
PHASE5_PARAMS: Dict[str, Any] = {"n_estimators": 200, "learning_rate": 0.1, "max_depth": 3, "min_samples_leaf": 1}
# The rule the model is compared with (Phase 5's strongest baseline) and the current model.
RULE = "last_same_semester_teacher"
CURRENT = "current_model"
NEW = "new_model"
CASE_SEED = 42
CASE_COUNT = 6
CASE_SUBJECT = "ITEC 103"  # Intermediate Programming, the team's example

METHOD_WORDS = {
    "random": "Random order (expected value)",
    "semantic_match_only": "Semantic match alone (Engine 1)",
    "most_sections_taught": "Most sections taught",
    "last_same_semester_teacher": "Last same-semester teacher",
    "current_model": "Current model (Phase 5: GradientBoostingClassifier, unconstrained, refitted on the training terms)",
    "monotonic_logit": "Monotonic logistic regression",
    "new_model": "New model (HistGradientBoostingClassifier, monotonic)",
}
METHOD_ORDER = list(METHOD_WORDS)
PROBABILITY_METHODS = ("current_model", "monotonic_logit", "new_model")


# ----------------------------------------------------------------------------- ranking metrics
def question_metrics(scores: Sequence[float], labels: Sequence[int]) -> Dict[str, float]:
    """Top-1, Top-3, reciprocal rank and NDCG@3 of the one positive among the candidates, ties scored exactly."""
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=int)
    positive = int(np.flatnonzero(labels == 1)[0])
    better = int(np.sum(scores > scores[positive]))
    tied = int(np.sum(scores == scores[positive])) - 1
    ranks = np.arange(better + 1, better + tied + 2)

    def hit(k: int) -> float:
        return float(min(1.0, max(0.0, (k - better) / (tied + 1))))

    ndcg = np.where(ranks <= 3, 1.0 / np.log2(ranks + 1.0), 0.0)
    return {"top1": hit(1), "top3": hit(3), "rr": float(np.mean(1.0 / ranks)), "ndcg3": float(np.mean(ndcg))}


RANK_KEYS = ("top1", "top3", "rr", "ndcg3")


def per_question(frame: pd.DataFrame, scores: Sequence[float]) -> pd.DataFrame:
    """One row per question: its metrics and its number of candidate rows."""
    work = frame[["question_id", "label"]].copy()
    work["score"] = np.asarray(scores, dtype=float)
    rows = []
    for qid, group in work.groupby("question_id", sort=False):
        rows.append({"question_id": qid, "n": int(len(group)), **question_metrics(group["score"].to_numpy(), group["label"].to_numpy())})
    return pd.DataFrame(rows)


def _ci(boot: np.ndarray) -> List[float]:
    return [round(float(np.percentile(boot, 2.5)), 4), round(float(np.percentile(boot, 97.5)), 4)]


def bootstrap_index(n: int, seed: int, resamples: int) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, n, size=(resamples, n))


def classification_from(table: pd.DataFrame) -> Dict[str, float]:
    """The top pick as a classification over the candidate rows: one predicted professor per class (the
    top-scored; a tie shares the pick, so the counts are expected values) and one true one. TP = classes
    whose top pick taught it; FP = FN = the other classes; TN = every other candidate row."""
    q = float(len(table))
    rows = float(table["n"].sum())
    tp = float(table["top1"].sum())
    fp = fn = q - tp
    tn = rows - tp - fp - fn
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "accuracy": (tp + tn) / rows, "precision": precision, "recall": recall, "f1": f1}


def summarise(table: pd.DataFrame, seed: int, resamples: int) -> Dict[str, Any]:
    """Means with 95% bootstrap intervals over questions (percentile method): the ranking metrics and the
    classification at the top pick."""
    n = len(table)
    idx = bootstrap_index(n, seed, resamples)
    out: Dict[str, Any] = {"questions": int(n)}
    for key in RANK_KEYS:
        values = table[key].to_numpy()
        out[key] = {"mean": round(float(values.mean()), 4), "ci95": _ci(values[idx].mean(axis=1))}
    point = classification_from(table)
    top1 = table["top1"].to_numpy()
    sizes = table["n"].to_numpy(dtype=float)
    # accuracy per resample = sum(n - 2 + 2 top1) / sum(n): each class adds its TP and its TN rows
    acc_boot = (sizes[idx] - 2.0 + 2.0 * top1[idx]).sum(axis=1) / sizes[idx].sum(axis=1)
    p_boot = top1[idx].mean(axis=1)
    out["classification"] = {
        "confusion": {k: round(point[k], 2) for k in ("tp", "fp", "fn", "tn")},
        "accuracy": {"mean": round(point["accuracy"], 4), "ci95": _ci(acc_boot)},
        "precision": {"mean": round(point["precision"], 4), "ci95": _ci(p_boot)},
        "recall": {"mean": round(point["recall"], 4), "ci95": _ci(p_boot)},
        "f1": {"mean": round(point["f1"], 4), "ci95": _ci(p_boot)},
    }
    return out


def paired_difference(a: pd.DataFrame, b: pd.DataFrame, seed: int, resamples: int) -> Dict[str, Any]:
    """Bootstrap of (a - b) per ranking metric over the same resampled questions."""
    merged = a.merge(b, on="question_id", suffixes=("_a", "_b"))
    idx = bootstrap_index(len(merged), seed, resamples)
    out: Dict[str, Any] = {}
    for key in RANK_KEYS:
        diff = (merged[f"{key}_a"] - merged[f"{key}_b"]).to_numpy()
        out[key] = {"mean": round(float(diff.mean()), 4), "ci95": _ci(diff[idx].mean(axis=1))}
    return out


def probability_quality(frame: pd.DataFrame, scores: np.ndarray, is_probability: bool, seed: int, resamples: int) -> Dict[str, Any]:
    """Per candidate row: ROC-AUC and PR-AUC (any score), log loss and Brier (probabilities only), with
    95% intervals from resampling whole questions."""
    from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score
    y = frame["label"].to_numpy()
    s = np.asarray(scores, dtype=float)
    qids = frame["question_id"].to_numpy()
    rows_of = [np.flatnonzero(qids == q) for q in dict.fromkeys(qids)]
    funcs: Dict[str, Callable[[np.ndarray, np.ndarray], float]] = {"roc_auc": roc_auc_score, "pr_auc": average_precision_score}
    if is_probability:
        funcs["log_loss"] = lambda yt, p: log_loss(yt, np.clip(p, 1e-6, 1 - 1e-6), labels=[0, 1])
        funcs["brier"] = brier_score_loss
    idx = bootstrap_index(len(rows_of), seed, resamples)
    samples = [np.concatenate([rows_of[i] for i in sample]) for sample in idx]
    out: Dict[str, Any] = {}
    for name, fn in funcs.items():
        boot = [float(fn(y[take], s[take])) for take in samples if y[take].min() != y[take].max()]
        out[name] = {"mean": round(float(fn(y, s)), 4), "ci95": _ci(np.asarray(boot))}
    return out


# ----------------------------------------------------------------------------- tuning
def cv_splits(train: pd.DataFrame, folds: Optional[int] = None):
    """Leave-one-term-out: one fold per training term, that term's questions held out (with a single
    term, GroupKFold by question instead)."""
    terms = sorted(train["term_index"].unique())
    if len(terms) < 2:
        return groupkfold_splits(train, folds or FOLDS)
    index = train["term_index"].to_numpy()
    return [(np.flatnonzero(index != t), np.flatnonzero(index == t)) for t in terms]


def groupkfold_splits(train: pd.DataFrame, folds: int = FOLDS):
    """GroupKFold by question: the diagnostic scheme (questions of one term fall on both sides)."""
    from sklearn.model_selection import GroupKFold
    groups = train["question_id"].to_numpy()
    return list(GroupKFold(n_splits=min(folds, train["question_id"].nunique())).split(train, train["label"], groups))


def cv_score(train: pd.DataFrame, splits, fit_score: Callable[[pd.DataFrame, pd.DataFrame], np.ndarray]) -> Dict[str, Any]:
    fold_mrr, fold_top1 = [], []
    for tr_idx, va_idx in splits:
        tr, va = train.iloc[tr_idx], train.iloc[va_idx]
        m = per_question(va, fit_score(tr, va))
        fold_mrr.append(float(m["rr"].mean()))
        fold_top1.append(float(m["top1"].mean()))
    return {"mean_mrr": round(float(np.mean(fold_mrr)), 4), "mean_top1": round(float(np.mean(fold_top1)), 4),
            "fold_mrr": [round(v, 4) for v in fold_mrr], "folds": len(fold_mrr)}


def fitter(kind: str, params: Dict[str, Any], seed: int, features: List[str]):
    """(train, test) -> scores for one model kind: 'new', 'logit' or 'phase5'."""
    def run(tr: pd.DataFrame, te: pd.DataFrame) -> np.ndarray:
        if kind == "new":
            model = make_model(params, seed, features).fit(tr[features], tr["label"])
            return model.predict_proba(te[features])[:, 1]
        if kind == "logit":
            model = MonotonicLogit(features=features, **params).fit(tr, tr["label"])
            return model.predict_proba(te)[:, 1]
        model = make_phase5_model(params, seed).fit(phase5_frame(tr), tr["label"])
        return model.predict_proba(phase5_frame(te))[:, 1]
    return run


def simplicity(params: Dict[str, Any]) -> Tuple:
    """Ties on the rounded CV MRR go to the simpler setting: fewer trees, shallower, bigger leaves, more L2,
    the smaller step."""
    return (params.get("max_iter", 0), params.get("max_depth", 0), -params.get("min_samples_leaf", 0),
            -params.get("l2_regularization", 0), params.get("learning_rate", 0))


def tune(train: pd.DataFrame, seed: int, features: List[str], grid: Dict[str, List[Any]] = GRID, kind: str = "new",
         splits=None) -> Dict[str, Any]:
    splits = splits if splits is not None else cv_splits(train)
    results = []
    for values in itertools.product(*grid.values()):
        params = dict(zip(grid.keys(), values))
        results.append({"params": params, **cv_score(train, splits, fitter(kind, params, seed, features))})
    if kind == "new":
        results.sort(key=lambda r: (-r["mean_mrr"], simplicity(r["params"])))
    else:
        results.sort(key=lambda r: (-r["mean_mrr"], r["params"].get("C", 0)))
    return {"chosen": results[0]["params"], "cv_mrr": results[0]["mean_mrr"], "cv_top1": results[0]["mean_top1"],
            "grid": results, "folds": results[0]["folds"], "scored_by": f"mean reciprocal rank ({CV_SCHEME}, training terms only)"}


# ----------------------------------------------------------------------------- the rules
def rule_scores(frame: pd.DataFrame) -> Dict[str, np.ndarray]:
    return {
        "random": np.zeros(len(frame)),
        "semantic_match_only": frame["semantic_match"].to_numpy(dtype=float),
        "most_sections_taught": frame["sections_taught"].to_numpy(dtype=float),
        "last_same_semester_teacher": frame["taught_it_last_same_semester"].to_numpy(dtype=float),
    }


# ----------------------------------------------------------------------------- explanation
def permutation_importance(model, test: pd.DataFrame, features: List[str], seed: int, repeats: int) -> List[Dict[str, Any]]:
    base = per_question(test, model.predict_proba(test[features])[:, 1])
    base_mrr, base_top1 = float(base["rr"].mean()), float(base["top1"].mean())
    rng = np.random.default_rng(seed)
    rows = []
    for feature in features:
        drops_mrr, drops_top1 = [], []
        for _ in range(repeats):
            shuffled = test.copy()
            shuffled[feature] = rng.permutation(shuffled[feature].to_numpy())
            m = per_question(shuffled, model.predict_proba(shuffled[features])[:, 1])
            drops_mrr.append(base_mrr - float(m["rr"].mean()))
            drops_top1.append(base_top1 - float(m["top1"].mean()))
        rows.append({"feature": feature, "mrr_drop_mean": round(float(np.mean(drops_mrr)), 4),
                     "mrr_drop_std": round(float(np.std(drops_mrr)), 4),
                     "top1_drop_mean": round(float(np.mean(drops_top1)), 4), "top1_drop_std": round(float(np.std(drops_top1)), 4)})
    rows.sort(key=lambda r: -r["mrr_drop_mean"])
    return rows


def effect_grid(feature: str, frame: pd.DataFrame) -> List[float]:
    """The values a feature's effect is drawn over: every value for a count, 13 quantiles for a score."""
    values = frame[feature].astype(float)
    if feature == "terms_since_last_taught":
        return [float(v) for v in sorted(set(values.unique()) | {1.0, 2.0, 3.0, float(NEVER_TAUGHT)})]
    if feature == "eval_rating":
        # A fixed grid over the scale, never values read from the data (a quantile of a dozen ratings
        # could be one professor's rating).
        return [round(3.0 + 0.25 * i, 2) for i in range(9)]
    if feature == "semantic_match":
        return sorted(set(round(float(q), 4) for q in values.quantile(np.linspace(0.0, 1.0, 13))))
    return [float(v) for v in sorted(values.unique())]


def feature_effects(model, frame: pd.DataFrame, features: List[str]) -> Dict[str, Dict[str, List[float]]]:
    """Each feature's effect: the mean predicted probability over `frame` with the feature set to each grid
    value (the others as they are). For the rating it is a curve over a fixed grid of the scale (3.00 to
    5.00), never one professor's rating."""
    out: Dict[str, Dict[str, List[float]]] = {}
    for f in features:
        grid = effect_grid(f, frame)
        means = []
        for value in grid:
            work = frame[features].copy()
            work[f] = value
            means.append(round(float(model.predict_proba(work)[:, 1].mean()), 5))
        out[f] = {"values": grid, "mean_probability": means}
    return out


def case_rows(test: pd.DataFrame, scores: Dict[str, np.ndarray], seed: int = CASE_SEED, count: int = CASE_COUNT) -> Dict[str, Any]:
    """The top 3 of the new model with the features for `count` classes of the test term: every class of
    CASE_SUBJECT first (up to `count`), then classes of other subjects drawn with `seed`, one per subject.
    A rating shows only as rated / not rated."""
    work = test.copy()
    for name in (NEW, CURRENT, RULE):
        work[f"score_{name}"] = scores[name]
    subject_of = work.groupby("question_id", sort=False)["subject_code"].first()
    questions = list(subject_of.index)
    first = [q for q in questions if subject_of[q] == CASE_SUBJECT][:count]
    rest = [q for q in questions if q not in first]
    rng = np.random.default_rng(seed)
    picked, subjects = list(first), {subject_of[q] for q in first}
    for q in rng.permutation(np.array(rest, dtype=object)):
        if len(picked) >= count:
            break
        if subject_of[q] not in subjects:
            picked.append(q)
            subjects.add(subject_of[q])
    cases = []
    for q in picked:
        group = work[work["question_id"] == q].sort_values(f"score_{NEW}", ascending=False, kind="stable")
        truth = group[group["label"] == 1].iloc[0]
        rank_of = lambda name: int(1 + (group[f"score_{name}"] > truth[f"score_{name}"]).sum())  # noqa: E731
        top = []
        for _, r in group.head(3).iterrows():
            top.append({"candidate": r["candidate"], "taught_it": bool(r["label"]), "probability": round(float(r[f"score_{NEW}"]), 4),
                        "semantic_match": round(float(r["semantic_match"]), 3),
                        **{f: int(r[f]) for f in ("semesters_taught", "sections_taught", "terms_since_last_taught",
                                                   "taught_it_last_same_semester", "program_experience", "is_full_time")},
                        "rated": "not rated" if int(r.get("eval_missing", 1)) else "rated"})
        cases.append({"question_id": q, "section": truth["section"], "subject_code": truth["subject_code"], "subject_title": truth["subject_title"],
                      "taught_by": truth["candidate"], "rank_new_model": rank_of(NEW), "rank_current_model": rank_of(CURRENT),
                      "rule_says": "taught it last same semester" if int(truth["taught_it_last_same_semester"]) else "did not teach it last same semester",
                      "top3": top})
    return {"seed": seed, "subject_first": CASE_SUBJECT, "cases": cases}


# ----------------------------------------------------------------------------- the run
def load_dataset(path: Path) -> Tuple[pd.DataFrame, List[str], str]:
    """The full dataset when present (every feature); else the public one without the rating features."""
    if path.exists():
        return pd.read_csv(path), list(FEATURES), str(path)
    if PUBLIC_DATASET.exists():
        frame = pd.read_csv(PUBLIC_DATASET)
        features = [f for f in FEATURES if f in frame.columns]
        print(f"[train_eval] {path} is absent: using the public dataset without the rating features ({len(features)} features).")
        return frame, features, str(PUBLIC_DATASET)
    raise SystemExit(f"No dataset found at {path} or {PUBLIC_DATASET}. Run ml/build_dataset.py first.")


def versions() -> Dict[str, str]:
    import sklearn
    out = {"python": platform.python_version(), "scikit-learn": sklearn.__version__, "pandas": pd.__version__, "numpy": np.__version__}
    for name in ("joblib", "scipy", "matplotlib"):
        try:
            out[name] = __import__(name).__version__
        except Exception:  # pragma: no cover
            out[name] = "not installed"
    out["platform"] = platform.platform()
    out["processor"] = platform.processor() or "unknown"
    return out


def rating_fallback(frame: pd.DataFrame) -> float:
    """The fallback for a roster where nobody is rated: the median over the distinct (term, professor)
    ratings logged in the history (a group statistic)."""
    if "eval_rating" in frame and "eval_missing" in frame:
        rated = frame.loc[frame["eval_missing"] == 0].drop_duplicates(["term", "candidate"])["eval_rating"]
        if len(rated):
            return round(float(rated.median()), 2)
    return 4.0


def evaluate(train: pd.DataFrame, test: pd.DataFrame, features: List[str], new_params: Dict[str, Any], logit_params: Dict[str, Any],
             seed: int, resamples: int) -> Tuple[Dict[str, Any], Dict[str, np.ndarray], Any]:
    """Every method on the test term, the three models fitted on the training terms only."""
    new_model = make_model(new_params, seed, features).fit(train[features], train["label"])
    scores = {
        **rule_scores(test),
        CURRENT: fitter("phase5", PHASE5_PARAMS, seed, features)(train, test),
        "monotonic_logit": fitter("logit", logit_params, seed, features)(train, test),
        NEW: new_model.predict_proba(test[features])[:, 1],
    }
    tables = {name: per_question(test, s) for name, s in scores.items()}
    methods = {name: summarise(tables[name], seed, resamples) for name in METHOD_ORDER}
    for name in METHOD_ORDER:
        methods[name]["probability_quality"] = probability_quality(test, scores[name], name in PROBABILITY_METHODS, seed, resamples)
    paired = {
        f"{name}_minus_{other}": paired_difference(tables[name], tables[other], seed, resamples)
        for other in (RULE, CURRENT) for name in METHOD_ORDER if name not in (other, "random")
    }
    return {"methods": methods, "paired": paired, "questions": int(test["question_id"].nunique()), "rows": int(len(test)),
            "candidates_per_question": int(test["n_candidates"].iloc[0])}, scores, new_model


def run(dataset_path: Path, out_dir: Path, seed: int, resamples: int, figures: bool, save: bool,
        model_path: Path = MODEL_PATH, meta_path: Path = META_PATH,
        phase5_path: Path = PHASE5_MODEL_PATH, phase5_meta_path: Path = PHASE5_META_PATH,
        grid: Optional[Dict[str, List[Any]]] = None) -> Dict[str, Any]:
    import joblib
    started = time.time()
    grid = GRID if grid is None else grid
    frame, features, dataset_used = load_dataset(dataset_path)
    frame = frame.sort_values(["term_index", "question_id", "candidate"]).reset_index(drop=True)
    terms = frame.drop_duplicates("term_index").sort_values("term_index")[["term_index", "term"]].to_records(index=False).tolist()
    term_of = {int(i): t for i, t in terms}
    test_index = next(i for i, t in term_of.items() if t == TEST_TERM)
    train = frame[frame["term_index"] < test_index].reset_index(drop=True)
    test = frame[frame["term_index"] == test_index].reset_index(drop=True)

    # 2. tuning on the training terms only (one set of folds for every model)
    t0 = time.time()
    splits = cv_splits(train)
    tuning = tune(train, seed, features, grid, "new", splits)
    logit_tuning = tune(train, seed, features, LOGIT_GRID, "logit", splits)
    current_cv = cv_score(train, splits, fitter("phase5", PHASE5_PARAMS, seed, features))
    rule_cv = cv_score(train, splits, lambda tr, va: va["taught_it_last_same_semester"].to_numpy(dtype=float))
    gkf = groupkfold_splits(train)
    diagnostic = {"scheme": "GroupKFold by question (5 folds)",
                  "new_model": cv_score(train, gkf, fitter("new", tuning["chosen"], seed, features))["mean_mrr"],
                  "current_model": cv_score(train, gkf, fitter("phase5", PHASE5_PARAMS, seed, features))["mean_mrr"],
                  "monotonic_logit": cv_score(train, gkf, fitter("logit", logit_tuning["chosen"], seed, features))["mean_mrr"]}
    tuning_seconds = time.time() - t0
    params = tuning["chosen"]

    # 3. the keep rule, decided before the test term is looked at: the CV comparison, and the monotonic
    #    sweep of a model of the chosen settings over every training row
    sweep_model = make_model(params, seed, features).fit(train[features], train["label"])
    sweep = sweep_violations(sweep_model, train, features)
    keep = {"cv_mrr_new": tuning["cv_mrr"], "cv_mrr_current": current_cv["mean_mrr"],
            "at_least_as_good": tuning["cv_mrr"] >= current_cv["mean_mrr"],
            "monotonic": all(v == 0 for v in sweep.values()), "sweep_violations": sweep}
    keep["kept"] = bool(keep["at_least_as_good"] and keep["monotonic"])

    # 4. the test, once
    t0 = time.time()
    test_result, scores, new_model = evaluate(train, test, features, params, logit_tuning["chosen"], seed, resamples)
    test_seconds = time.time() - t0

    # 5. explanation
    t0 = time.time()
    importance = permutation_importance(new_model, test, features, seed, PERMUTATION_REPEATS)
    effects = feature_effects(new_model, test, features)
    cases = case_rows(test, scores)
    explain_seconds = time.time() - t0

    # 6. the model for real use
    production: Dict[str, Any] = {"saved": False, "reason": "--no-save" if not save else None}
    if save and not keep["kept"]:
        production["reason"] = "not kept: " + "; ".join(
            ([] if keep["at_least_as_good"] else [f"its cross-validated MRR {keep['cv_mrr_new']} is below the current model's {keep['cv_mrr_current']}"]) +
            ([] if keep["monotonic"] else [f"the sweep found steps against the constraints: {sweep}"]))
    if save and keep["kept"]:
        t0 = time.time()
        if model_path.exists() and not phase5_path.exists():
            shutil.copyfile(model_path, phase5_path)
            if meta_path.exists():
                shutil.copyfile(meta_path, phase5_meta_path)
        final_model = make_model(params, seed, features).fit(frame[features], frame["label"])
        final_sweep = sweep_violations(final_model, frame, features)
        meta = {
            "phase": "8.11", "model_type": MODEL_TYPE, "features": features,
            "monotonic_cst": dict(zip(features, monotonic_cst(features))),
            "params": {**FIXED_PARAMS, **params, "random_state": seed},
            "trained_on_terms": [t for _, t in terms], "rows": int(len(frame)), "questions": int(frame["question_id"].nunique()),
            "rating_imputation": "a missing rating takes the median of the rated candidates at request time; when none is rated, the fallback below",
            "rating_fallback_median": rating_fallback(frame),
            "metrics": {"cv_mrr_training_terms": tuning["cv_mrr"], "cv_top1_training_terms": tuning["cv_top1"],
                        "test_term": TEST_TERM, "test_top1": test_result["methods"][NEW]["top1"]["mean"],
                        "test_top3": test_result["methods"][NEW]["top3"]["mean"], "test_mrr": test_result["methods"][NEW]["rr"]["mean"],
                        "test_ndcg3": test_result["methods"][NEW]["ndcg3"]["mean"],
                        "note": "the test numbers are of the same settings fitted on the three training terms; this file is fitted on all four"},
            "monotonic_sweep_all_rows": final_sweep,
            "sklearn_version": versions()["scikit-learn"], "dataset": Path(dataset_used).name,
            "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        joblib.dump(final_model, model_path)
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        production = {"saved": True, "model_path": model_path.name, "meta_path": meta_path.name, "phase5_kept_as": phase5_path.name,
                      "rows": meta["rows"], "questions": meta["questions"], "monotonic_sweep_all_rows": final_sweep,
                      "seconds": round(time.time() - t0, 2)}

    results = {
        "about": "Phase 8 Part 11: Engine 2's ranking model, tuned on the three training terms and tested once on the unseen term. Every number in RESULTS.md is read from this file.",
        "dataset": Path(dataset_used).name, "features": features, "monotonic_cst": dict(zip(features, monotonic_cst(features))),
        "seed": seed, "bootstrap_resamples": resamples,
        "terms": [{"index": int(i), "term": t, "questions": int(frame.loc[frame["term_index"] == i, "question_id"].nunique()),
                   "rows": int((frame["term_index"] == i).sum()), "candidates": int(frame.loc[frame["term_index"] == i, "n_candidates"].iloc[0])} for i, t in terms],
        "split": {"train": [t for i, t in terms if i < test_index], "test": TEST_TERM},
        "history_range": [{"term": t, **{f: int(frame.loc[frame["term_index"] == i, f].max()) for f in
                                         ("semesters_taught", "sections_taught", "taught_it_last_same_semester") if f in frame}}
                          for i, t in terms],
        "tuning": {"new_model": {**{k: v for k, v in tuning.items() if k != "grid"}, "grid_definition": grid, "grid": tuning["grid"],
                                 "fixed": FIXED_PARAMS},
                   "monotonic_logit": logit_tuning,
                   "current_model": {"params": PHASE5_PARAMS, **current_cv},
                   "last_same_semester_teacher": rule_cv,
                   "scheme": CV_SCHEME, "groupkfold_diagnostic": diagnostic, "first_run": FIRST_RUN,
                   "seconds": round(tuning_seconds, 2)},
        "keep_rule": keep,
        "test": test_result,
        "permutation_importance": {"test_term": TEST_TERM, "repeats": PERMUTATION_REPEATS, "rows": importance},
        "feature_effects": effects,
        "cases": cases,
        "methods": METHOD_WORDS,
        "production_model": production,
        "timing_seconds": {"tuning": round(tuning_seconds, 2), "test": round(test_seconds, 2), "explanation": round(explain_seconds, 2),
                           "total": round(time.time() - started, 2)},
        "versions": versions(),
        "run_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    stored = json.loads((out_dir / "results.json").read_text(encoding="utf-8"))
    write_results_md(out_dir / "RESULTS.md", stored)
    if figures:
        write_figures(out_dir, stored)
    return results


# ----------------------------------------------------------------------------- RESULTS.md
def pct(entry: Dict[str, Any]) -> str:
    lo, hi = entry["ci95"]
    return f"{entry['mean'] * 100:.1f}% [{lo * 100:.1f}, {hi * 100:.1f}]"


def num(entry: Dict[str, Any], digits: int = 3) -> str:
    lo, hi = entry["ci95"]
    return f"{entry['mean']:.{digits}f} [{lo:.{digits}f}, {hi:.{digits}f}]"


def signed(entry: Dict[str, Any], scale: float = 100.0, unit: str = " pp", digits: int = 1) -> str:
    lo, hi = entry["ci95"]
    return f"{entry['mean'] * scale:+.{digits}f}{unit} [{lo * scale:+.{digits}f}, {hi * scale:+.{digits}f}]"


SHORT = {
    "random": "Random order", "semantic_match_only": "Semantic match alone", "most_sections_taught": "Most sections taught",
    "last_same_semester_teacher": "Last same-semester teacher", "current_model": "Current model (Phase 5)",
    "monotonic_logit": "Monotonic logistic regression", "new_model": "**New model (Part 11)**",
}


def write_results_md(path: Path, r: Dict[str, Any]) -> None:
    t = r["test"]
    m = t["methods"]
    tn = r["tuning"]
    k = r["keep_rule"]
    L: List[str] = []
    L.append("# Engine 2's ranking model: results (Phase 8 Part 11)")
    L.append("")
    L.append(f"Written by `../intellisched_backend/ml/train_eval.py` from `results.json` (run {r['run_at']}); every number below is read from that file. "
             "The data are the four transcribed semesters of Teachers' Programs (`DATASET_CARD.md`). No rating appears here: a rating is shown only as rated / not rated.")
    L.append("")
    L.append("## The task and the split")
    L.append("")
    L.append("One question = one class (a section's Major subject in a term). The candidates are every professor with a CCS class that term; exactly one of them "
             "taught it. A method scores every candidate; the question is answered by where the one who taught it lands.")
    L.append("")
    L.append("| Term | Role | Questions | Candidates per question | Rows |")
    L.append("|---|---|---|---|---|")
    for term in r["terms"]:
        role = "test (unseen)" if term["term"] == r["split"]["test"] else "training"
        L.append(f"| {term['term']} | {role} | {term['questions']} | {term['candidates']} | {term['rows']} |")
    L.append("")
    hr = r.get("history_range", [])
    if hr:
        L.append("What the history can say (the largest value of each history feature per term): " + "; ".join(
            f"{h['term']}: semesters {h.get('semesters_taught')}, sections {h.get('sections_taught')}, last same semester {h.get('taught_it_last_same_semester')}" for h in hr)
            + ". A Major subject is offered in one semester type only, so within four terms it has at most one earlier semester in the data, and the first two terms have "
            "none: `semesters_taught` is 0 or 1 and nearly the same fact as `taught_it_last_same_semester`; `sections_taught` is the only history feature with more than two "
            "values, and only in the last two terms. The live ranking sees the same history (up to two earlier same-type semesters for 2nd Sem AY 2026-27).")
        L.append("")
    L.append("Every feature is computed as of its term from earlier terms only. The test term was used once, after every choice was made on the training terms; "
             f"95% intervals are percentile bootstraps over the test questions ({r['bootstrap_resamples']} resamples, seed {r['seed']}).")
    L.append("")
    L.append("## The model and its constraints")
    L.append("")
    L.append("scikit-learn's `HistGradientBoostingClassifier` (gradient-boosted trees, the same family as Phase 5's `GradientBoostingClassifier`) with monotonic "
             "constraints: a feature marked *rises* can never lower the score as it grows; *falls* can never raise it.")
    L.append("")
    L.append("| Feature | Direction |")
    L.append("|---|---|")
    words = {1: "rises", -1: "falls", 0: "none"}
    for f, c in r["monotonic_cst"].items():
        L.append(f"| `{f}` | {words[c]} |")
    L.append("")
    L.append("## Tuning (training terms only)")
    L.append("")
    nm = tn["new_model"]
    L.append(f"Leave-one-term-out over the three training terms ({nm['folds']} folds: each term held out in turn), scored by MRR. The grid was fixed before the run: "
             + ", ".join(f"`{key}` {values}" for key, values in nm["grid_definition"].items()) + f"; fixed: {nm['fixed']}. "
             "Ties on the rounded MRR go to the simpler setting.")
    L.append("")
    L.append(f"- **Chosen:** {nm['chosen']}: cross-validated MRR **{nm['cv_mrr']:.4f}**, Top-1 {nm['cv_top1'] * 100:.1f}%.")
    L.append(f"- The current model (Phase 5's recipe, {tn['current_model']['params']}) on the same folds: MRR {tn['current_model']['mean_mrr']:.4f}, "
             f"Top-1 {tn['current_model']['mean_top1'] * 100:.1f}%.")
    L.append(f"- The monotonic logistic regression: C = {tn['monotonic_logit']['chosen']['C']}, MRR {tn['monotonic_logit']['cv_mrr']:.4f}, "
             f"Top-1 {tn['monotonic_logit']['cv_top1'] * 100:.1f}%.")
    rc = tn["last_same_semester_teacher"]
    L.append(f"- The rule (last same-semester teacher) on the same folds: MRR {rc['mean_mrr']:.4f} "
             f"(per fold {rc['fold_mrr']}: the first two terms have no earlier same semester in the data).")
    L.append("")
    fr = tn["first_run"]
    dg = tn["groupkfold_diagnostic"]
    lo = fr["loto_diagnosis_on_training_terms"]
    tp = fr["test_numbers_printed"]
    L.append(f"**Why leave-one-term-out (a change after the first run).** The first run tuned with {fr['cv_scheme']}, as planned: it chose {fr['chosen']}, "
             f"cross-validated MRR {fr['cv_mrr_new']} against the current model's {fr['cv_mrr_current']}, so the new model was not kept. "
             "But those folds split one term's questions between training and validation, and a professor's term-level facts (rating, full-time, program experience) "
             "are the same in every question of a term, so a model with one-row leaves can memorise who was busy that term. With a whole training term held out at a time, "
             f"the current model fell to MRR {lo['current_model']} (random: {lo['random']}) while the new model's same settings kept {lo['new_model_same_settings']}. "
             "The scheme was switched on that training-only diagnosis (the prompt allowed it from the start; the team agreed). The first run had already printed the "
             f"test term's numbers (Top-1 / MRR: current {tp['current_model']['top1'] * 100:.1f}% / {tp['current_model']['mrr']}, "
             f"new {tp['new_model']['top1'] * 100:.1f}% / {tp['new_model']['mrr']}, rule {tp['last_same_semester_teacher']['top1'] * 100:.1f}% / "
             f"{tp['last_same_semester_teacher']['mrr']}); no setting was chosen on them. This run's chosen settings scored with GroupKFold, for comparison: "
             f"new {dg['new_model']}, current {dg['current_model']}, monotonic logistic {dg['monotonic_logit']}.")
    L.append("")
    L.append("The five best settings of the grid:")
    L.append("")
    L.append("| Settings | CV MRR | CV Top-1 |")
    L.append("|---|---|---|")
    for g in nm["grid"][:5]:
        L.append(f"| {g['params']} | {g['mean_mrr']:.4f} | {g['mean_top1'] * 100:.1f}% |")
    L.append("")
    L.append("## The keep rule")
    L.append("")
    L.append(f"- Cross-validated MRR at least the current model's: {k['cv_mrr_new']:.4f} vs {k['cv_mrr_current']:.4f}: **{'yes' if k['at_least_as_good'] else 'no'}**.")
    L.append(f"- Monotonic (every training row swept over each constrained feature's values; steps against the direction: {k['sweep_violations']}): "
             f"**{'yes' if k['monotonic'] else 'no'}**.")
    p = r["production_model"]
    L.append(f"- **{'Kept' if k['kept'] else 'Not kept'}.** " + (
        f"Saved for real use, fitted on all four terms: `{p['model_path']}` with `{p['meta_path']}`; the Phase 5 file is kept as `{p['phase5_kept_as']}`."
        if p.get("saved") else f"Nothing saved ({p.get('reason')})."))
    L.append("")
    L.append(f"## The test: {r['split']['test']} ({t['questions']} classes x {t['candidates_per_question']} candidates)")
    L.append("")
    L.append("Each model below was fitted on the three training terms; the current model is Phase 5's recipe refitted the same way "
             "(its shipped file was trained on all four terms, the test term included, so it cannot be tested here).")
    L.append("")
    L.append("### Ranking")
    L.append("")
    L.append("| Method | Top-1 | Top-3 | MRR | NDCG@3 |")
    L.append("|---|---|---|---|---|")
    for name in METHOD_ORDER:
        e = m[name]
        L.append(f"| {SHORT[name]} | {pct(e['top1'])} | {pct(e['top3'])} | {num(e['rr'])} | {num(e['ndcg3'])} |")
    L.append("")
    L.append("Paired differences on the same questions (95% bootstrap intervals; an interval that crosses 0 is no measured difference):")
    L.append("")
    L.append("| Comparison | Top-1 | Top-3 | MRR | NDCG@3 |")
    L.append("|---|---|---|---|---|")
    for key, label in ((f"{NEW}_minus_{RULE}", "New model − last same-semester teacher"), (f"{NEW}_minus_{CURRENT}", "New model − current model"),
                       (f"{CURRENT}_minus_{RULE}", "Current model − last same-semester teacher"),
                       (f"monotonic_logit_minus_{RULE}", "Monotonic logistic − last same-semester teacher"),
                       (f"monotonic_logit_minus_{CURRENT}", "Monotonic logistic − current model"),
                       (f"most_sections_taught_minus_{RULE}", "Most sections taught − last same-semester teacher")):
        d = t["paired"][key]
        L.append(f"| {label} | {signed(d['top1'])} | {signed(d['top3'])} | {signed(d['rr'], 1.0, '', 3)} | {signed(d['ndcg3'], 1.0, '', 3)} |")
    L.append("")
    L.append("### As a classification (the top pick)")
    L.append("")
    L.append("Each class gets one predicted professor (the top pick) and has one true one. Over the candidate rows: TP = classes whose top pick taught it; "
             "FP = classes whose top pick did not (that row is a false positive); FN = the same classes (their true professor was not picked); TN = every other row. "
             "So FP = FN, and **precision = recall = F1 = Top-1**: with one predicted and one true professor per class the three are the same fraction. "
             "This is not a mistake. Accuracy counts the many true negatives, so it is high for every method and says little here. "
             "When scores tie at the top the pick is shared, so the counts are expected values (the random order's are fractions).")
    L.append("")
    L.append("| Method | TP | FP | FN | TN | Accuracy | Precision = Recall = F1 |")
    L.append("|---|---|---|---|---|---|---|")
    for name in METHOD_ORDER:
        c = m[name]["classification"]
        cm = c["confusion"]
        L.append(f"| {SHORT[name]} | {cm['tp']:g} | {cm['fp']:g} | {cm['fn']:g} | {cm['tn']:g} | {pct(c['accuracy'])} | {pct(c['f1'])} |")
    L.append("")
    L.append("### Probability quality (per candidate row)")
    L.append("")
    L.append("ROC-AUC and PR-AUC read any score; log loss and the Brier score need a probability, so the rules have none. "
             f"The base rate is 1 in {t['candidates_per_question']} (one positive per class).")
    L.append("")
    L.append("| Method | ROC-AUC | PR-AUC | Log loss | Brier |")
    L.append("|---|---|---|---|---|")
    for name in METHOD_ORDER:
        q = m[name]["probability_quality"]
        cell = lambda key: num(q[key]) if key in q else "–"  # noqa: E731
        L.append(f"| {SHORT[name]} | {cell('roc_auc')} | {cell('pr_auc')} | {cell('log_loss')} | {cell('brier')} |")
    L.append("")
    L.append("## What drives it")
    L.append("")
    pi = r["permutation_importance"]
    L.append(f"Permutation importance on the test term: each feature shuffled across the rows {pi['repeats']} times; the drop in MRR (and in Top-1) when it is.")
    L.append("")
    L.append("| Feature | MRR drop (± SD) | Top-1 drop |")
    L.append("|---|---|---|")
    for row in pi["rows"]:
        L.append(f"| `{row['feature']}` | {row['mrr_drop_mean']:+.3f} (± {row['mrr_drop_std']:.3f}) | {row['top1_drop_mean'] * 100:+.1f} pp |")
    L.append("")
    L.append("Each feature's effect (`feature_effects.png`): the mean predicted probability over the test rows as the one feature moves, the others as they are. "
             "The constrained curves can only rise (or, for `terms_since_last_taught`, only fall).")
    L.append("")
    L.append("## Cases")
    L.append("")
    cs = r["cases"]
    L.append(f"The new model's top 3 for {len(cs['cases'])} classes of the test term: every {cs['subject_first']} class first, then classes of other subjects drawn with seed {cs['seed']}. "
             "Columns: the probability, the semantic match, semesters taught, sections taught, terms since last taught (99 = never), taught it last same semester, "
             "program experience (terms), full-time, the rating (rated / not rated).")
    for c in cs["cases"]:
        L.append("")
        L.append(f"**{c['subject_code']} {c['subject_title']}, {c['section']}.** Taught by {c['taught_by']} ({c['rule_says']}): rank {c['rank_new_model']} "
                 f"in the new model, {c['rank_current_model']} in the current model.")
        L.append("")
        L.append("| # | Candidate | Taught it | P | Sem. match | Semesters | Sections | Since | Last same sem. | Program | Full-time | Rating |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for i, row in enumerate(c["top3"], start=1):
            L.append(f"| {i} | {row['candidate']} | {'yes' if row['taught_it'] else ''} | {row['probability']:.3f} | {row['semantic_match']:.3f} | "
                     f"{row['semesters_taught']} | {row['sections_taught']} | {row['terms_since_last_taught']} | {row['taught_it_last_same_semester']} | "
                     f"{row['program_experience']} | {row['is_full_time']} | {row['rated']} |")
    L.append("")
    L.append("## Figures")
    L.append("")
    L.append("- `top1_top3.png`: Top-1 and Top-3 per method with the 95% intervals.")
    L.append("- `confusion_matrix.png`: the new model's top-pick confusion matrix over the candidate rows.")
    L.append("- `permutation_importance.png`: the MRR drop per feature.")
    L.append("- `feature_effects.png`: each feature's effect on the predicted probability.")
    L.append("")
    L.append("## Reproduce")
    L.append("")
    L.append("```")
    L.append("cd ../intellisched_backend")
    L.append(".venv/Scripts/python ml/build_dataset.py")
    L.append(".venv/Scripts/python ml/train_eval.py")
    L.append("```")
    L.append("")
    L.append(f"Time: tuning {r['timing_seconds']['tuning']} s, test {r['timing_seconds']['test']} s, explanation {r['timing_seconds']['explanation']} s, "
             f"total {r['timing_seconds']['total']} s. Versions: " + ", ".join(f"{a} {b}" for a, b in r["versions"].items() if a not in ("platform", "processor")) + ".")
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


# ----------------------------------------------------------------------------- figures
def write_figures(out_dir: Path, r: Dict[str, Any]) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    m = r["test"]["methods"]
    labels = {"random": "Random\norder", "semantic_match_only": "Semantic\nmatch alone", "most_sections_taught": "Most sections\ntaught",
              "last_same_semester_teacher": "Last same-\nsemester teacher", "current_model": "Current model\n(Phase 5)",
              "monotonic_logit": "Monotonic\nlogistic", "new_model": "New model\n(Part 11)"}
    x = np.arange(len(METHOD_ORDER))
    width = 0.38
    fig, ax = plt.subplots(figsize=(11.5, 5.4))
    for offset, key, colour, label in ((-width / 2, "top1", "#1f4e79", "Top-1"), (width / 2, "top3", "#7fa7cf", "Top-3")):
        means = np.array([m[n][key]["mean"] for n in METHOD_ORDER]) * 100
        lows = np.array([m[n][key]["ci95"][0] for n in METHOD_ORDER]) * 100
        highs = np.array([m[n][key]["ci95"][1] for n in METHOD_ORDER]) * 100
        ax.bar(x + offset, means, width, yerr=[means - lows, highs - means], capsize=4, color=colour, label=label)
        for xi, v in zip(x + offset, means):
            ax.text(xi, v + 2, f"{v:.0f}%", ha="center", va="bottom", fontsize=8)
    ax.set_xticks(x)
    ax.set_xticklabels([labels[n] for n in METHOD_ORDER], fontsize=8)
    ax.set_ylabel("Hit rate on the unseen semester (%)")
    ax.set_ylim(0, 105)
    ax.set_title(f"Top-1 and Top-3 on {r['split']['test']} ({r['test']['questions']} classes), 95% bootstrap intervals")
    ax.legend(loc="upper left")
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_dir / "top1_top3.png", dpi=300)
    plt.close(fig)

    cm = m[NEW]["classification"]["confusion"]
    grid = np.array([[cm["tp"], cm["fn"]], [cm["fp"], cm["tn"]]], dtype=float)
    fig, ax = plt.subplots(figsize=(5.2, 4.4))
    shade = np.log1p(grid)
    ax.imshow(shade, cmap="Blues")
    for (i, j), v in np.ndenumerate(grid):
        ax.text(j, i, f"{v:g}", ha="center", va="center", fontsize=13, color="white" if shade[i, j] > shade.max() * 0.6 else "black")
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["Top pick", "Not the top pick"])
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["Taught it", "Did not"])
    ax.set_title(f"New model: the top pick over {r['test']['rows']} candidate rows", fontsize=10)
    fig.tight_layout()
    fig.savefig(out_dir / "confusion_matrix.png", dpi=300)
    plt.close(fig)

    rows = r["permutation_importance"]["rows"]
    fig, ax = plt.subplots(figsize=(7.5, 4.2))
    ax.barh([row["feature"] for row in rows][::-1], [row["mrr_drop_mean"] for row in rows][::-1],
            xerr=[row["mrr_drop_std"] for row in rows][::-1], color="#1f4e79", capsize=3)
    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_xlabel("Drop in MRR when the feature is shuffled")
    ax.set_title(f"Permutation importance on {r['split']['test']}")
    fig.tight_layout()
    fig.savefig(out_dir / "permutation_importance.png", dpi=300)
    plt.close(fig)

    effects = r["feature_effects"]
    names = list(effects)
    cols = 3
    rows_n = int(np.ceil(len(names) / cols))
    fig, axes = plt.subplots(rows_n, cols, figsize=(11, 3.0 * rows_n), squeeze=False)
    for ax, f in zip(axes.flat, names):
        values = effects[f]["values"]
        never = f == "terms_since_last_taught"
        shown = [12.0 if (never and v == NEVER_TAUGHT) else v for v in values]
        ax.plot(shown, effects[f]["mean_probability"], marker="o", markersize=3, color="#1f4e79")
        if never:
            ax.set_xticks(shown)
            ax.set_xticklabels([("never" if v == 12.0 else str(int(v))) for v in shown])
        direction = {1: "rises", -1: "falls", 0: "free"}[r["monotonic_cst"][f]]
        ax.set_title(f"{f} ({direction})", fontsize=9)
        ax.set_ylabel("mean P", fontsize=8)
        ax.tick_params(labelsize=7)
        ax.grid(alpha=0.3)
    for ax in list(axes.flat)[len(names):]:
        ax.axis("off")
    fig.suptitle("Each feature's effect on the new model's probability (test rows, the others as they are)", fontsize=10)
    fig.tight_layout()
    fig.savefig(out_dir / "feature_effects.png", dpi=300)
    plt.close(fig)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--bootstrap", type=int, default=2000)
    parser.add_argument("--no-figures", action="store_true")
    parser.add_argument("--no-save", action="store_true", help="do not write the model for real use")
    args = parser.parse_args(argv)
    r = run(Path(args.dataset), Path(args.out_dir), args.seed, args.bootstrap, figures=not args.no_figures, save=not args.no_save)
    m = r["test"]["methods"]
    print(f"Test term {r['split']['test']}: {r['test']['questions']} classes x {r['test']['candidates_per_question']} candidates")
    for name in METHOD_ORDER:
        print(f"  {name:28s} Top-1 {pct(m[name]['top1']):24s} Top-3 {pct(m[name]['top3']):24s} MRR {num(m[name]['rr'])}")
    k = r["keep_rule"]
    print(f"Chosen: {r['tuning']['new_model']['chosen']}; CV MRR {k['cv_mrr_new']} vs current {k['cv_mrr_current']}; sweep {k['sweep_violations']}; kept: {k['kept']}")
    print(f"Model for real use: {'saved' if r['production_model'].get('saved') else 'not saved (' + str(r['production_model'].get('reason')) + ')'}; "
          f"total {r['timing_seconds']['total']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
