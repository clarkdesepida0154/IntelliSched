"""The ranking models, built in one place (Phase 8 Part 11): ml/train_eval.py tunes and evaluates them,
Engine 4 refits the chosen one, Engine 2 loads the saved file.

- `make_model(params)`: Engine 2's model since Part 11, scikit-learn's HistGradientBoostingClassifier
  (gradient-boosted trees, the same family as Phase 5's GradientBoostingClassifier) with monotonic
  constraints from ml/features.py MONOTONIC, strong regularisation for small data and no early stopping.
- `make_phase5_model(params)`: the Phase 5 recipe (GradientBoostingClassifier, unconstrained), refitted
  only as the comparison "the current model".
- `MonotonicLogit`: a logistic regression whose coefficients keep the constrained features' signs
  (L-BFGS-B with bounds over standardised features, an L2 penalty): the simple ML baseline.

Nothing here reads a database or the service's config.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from ml.features import FEATURES, MONOTONIC

MODEL_TYPE = "HistGradientBoostingClassifier (monotonic)"
# The settings every fit shares; the grid in ml/train_eval.py varies the others.
FIXED_PARAMS: Dict[str, Any] = {"early_stopping": False}

# The Phase 5 model's features: Part 11's semesters_taught was called times_taught_before.
PHASE5_FEATURES: List[str] = ["semantic_match", "times_taught_before", "taught_it_last_same_semester",
                              "eval_rating", "eval_missing", "is_full_time", "program_experience"]


def monotonic_cst(features: Sequence[str] = FEATURES) -> List[int]:
    """The constraint list in the order of `features` (0 for a feature with no direction)."""
    return [int(MONOTONIC.get(f, 0)) for f in features]


def make_model(params: Dict[str, Any], seed: int = 42, features: Sequence[str] = FEATURES):
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(random_state=seed, monotonic_cst=monotonic_cst(features),
                                          **{**FIXED_PARAMS, **params})


def make_phase5_model(params: Dict[str, Any], seed: int = 42):
    from sklearn.ensemble import GradientBoostingClassifier
    return GradientBoostingClassifier(random_state=seed, **params)


def phase5_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """The Phase 5 model's input columns from a Part 11 frame."""
    out = frame.rename(columns={"semesters_taught": "times_taught_before"})
    return out[PHASE5_FEATURES]


class MonotonicLogit:
    """Logistic regression with sign-constrained coefficients: +1 features get a coefficient >= 0, -1
    features <= 0, 0 features free; the intercept is free. Fitted on standardised features by L-BFGS-B
    with an L2 penalty of strength 1/C (as scikit-learn's C). predict_proba mirrors scikit-learn's."""

    def __init__(self, C: float = 1.0, features: Sequence[str] = FEATURES):
        self.C = float(C)
        self.features = list(features)

    def fit(self, X: pd.DataFrame, y: Sequence[int]) -> "MonotonicLogit":
        from scipy.optimize import minimize
        Xv = np.asarray(X[self.features], dtype=float)
        yv = np.asarray(y, dtype=float)
        self.mean_ = Xv.mean(axis=0)
        self.scale_ = Xv.std(axis=0)
        self.scale_[self.scale_ == 0] = 1.0
        Z = (Xv - self.mean_) / self.scale_
        n, d = Z.shape

        def loss(w: np.ndarray):
            b, coef = w[0], w[1:]
            z = Z @ coef + b
            p = 1.0 / (1.0 + np.exp(-z))
            # log(1 + e^z) - y z, written stably
            nll = np.sum(np.logaddexp(0.0, z) - yv * z)
            value = nll + 0.5 / self.C * np.dot(coef, coef)
            grad_z = p - yv
            grad = np.concatenate([[grad_z.sum()], Z.T @ grad_z + coef / self.C])
            return value, grad

        bounds = [(None, None)] + [((0.0, None) if MONOTONIC.get(f, 0) > 0 else (None, 0.0) if MONOTONIC.get(f, 0) < 0 else (None, None))
                                   for f in self.features]
        result = minimize(loss, np.zeros(d + 1), jac=True, method="L-BFGS-B", bounds=bounds)
        self.intercept_ = float(result.x[0])
        self.coef_ = result.x[1:]
        self.converged_ = bool(result.success)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        Z = (np.asarray(X[self.features], dtype=float) - self.mean_) / self.scale_
        p = 1.0 / (1.0 + np.exp(-(Z @ self.coef_ + self.intercept_)))
        return np.column_stack([1.0 - p, p])


def sweep_violations(model, frame: pd.DataFrame, features: Sequence[str] = FEATURES,
                     grids: Optional[Dict[str, Sequence[float]]] = None, tolerance: float = 1e-12) -> Dict[str, int]:
    """The monotonic check: for each constrained feature, every row of `frame` is swept over the
    feature's grid (the values seen in `frame`, or `grids`) with the other features as they are; a
    violation is a step where the probability moves against the feature's direction by more than
    `tolerance`. Returns {feature: the number of violating steps} (all 0 for a monotonic model)."""
    out: Dict[str, int] = {}
    base = frame[list(features)].reset_index(drop=True)
    for f in features:
        direction = MONOTONIC.get(f, 0)
        if not direction:
            continue
        grid = sorted(set(float(v) for v in (grids or {}).get(f, base[f].unique())))
        if len(grid) < 2:
            out[f] = 0
            continue
        probs = []
        for value in grid:
            work = base.copy()
            work[f] = value
            probs.append(model.predict_proba(work)[:, 1])
        steps = np.diff(np.vstack(probs), axis=0) * direction
        out[f] = int(np.sum(steps < -tolerance))
    return out
