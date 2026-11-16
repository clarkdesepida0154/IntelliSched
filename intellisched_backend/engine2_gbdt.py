"""Engine 2: the ranking of professors for a Major subject (Phase 5).

The model is scikit-learn's GradientBoostingClassifier trained by ml/train_eval.py on the 4 past semesters
of Teachers' Programs, with the features of ml/features.py computed at request time by ml/serving.py from
the roster Engine 1 loads: the semantic match (Engine 1), the professor's teaching history for the subject
(written by the term loader), the latest evaluation, the employment type and the program experience.
Candidates are ranked by the predicted probability within the subject; the API answer keeps its shape
(id, name, score, reason, rank, dataQualityFlag, maxWeeklyHours) and adds the feature row under
`features` for the technical details.
"""
import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import joblib

from config import MODEL_PATH, GBDT_FEATURES
from ml.serving import NEUTRAL_RATING, candidate_features, feature_frame, rating_median, reason_text

warnings.filterwarnings("ignore")


def _hours(value: Any) -> float:
    """A number of hours; None (null) counts as 0. Anything else that is not a finite number raises
    ValueError, so Engine 1 skips that faculty record and reports it instead of guessing."""
    if value is None:
        return 0.0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"ancillary hours is not a number ({value!r})")
    return float(value)


def ancillary_hours(faculty: Dict[str, Any]) -> float:
    """Weekly ancillary hours: the sum of ancillary[].hours. A record that is not migrated yet (no
    ancillary list) falls back to ancillaryLoad.hours. Null counts as 0. Reported next to the ranking,
    not a feature of it."""
    rows = faculty.get("ancillary")
    if isinstance(rows, list):
        return sum(_hours(row.get("hours")) for row in rows if isinstance(row, dict))
    legacy = faculty.get("ancillaryLoad")
    return _hours(legacy.get("hours")) if isinstance(legacy, dict) else 0.0


def meta_path_for(model_path: Path) -> Path:
    """intellisched_gbdt_engine.joblib -> intellisched_gbdt_engine.meta.json (written by ml/train_eval.py)."""
    model_path = Path(model_path)
    stem = model_path.name[: -len(model_path.suffix)] if model_path.suffix else model_path.name
    return model_path.with_name(stem + ".meta.json")


class GBDTEngine:
    def __init__(self, model_path: Path = MODEL_PATH, model_file_path: Optional[Path] = None):
        self.model_path = Path(model_file_path or model_path)
        self.meta: Dict[str, Any] = {}
        self.rating_fallback = NEUTRAL_RATING
        self.load_model()

    def load_model(self):
        """Loads the model and refuses one whose features are not the ranking's (a mismatched file
        would score nonsense), then reads the sidecar .meta.json (the rating fallback)."""
        try:
            self.model = joblib.load(self.model_path)
            actual_features = list(getattr(self.model, "feature_names_in_", []))
            if actual_features != GBDT_FEATURES:
                raise RuntimeError(f"Mismatched schema. Expected {GBDT_FEATURES}, got {actual_features}")
            meta_path = meta_path_for(self.model_path)
            self.meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            fallback = self.meta.get("rating_fallback_median")
            self.rating_fallback = float(fallback) if isinstance(fallback, (int, float)) and 1.0 <= fallback <= 5.0 else NEUTRAL_RATING
            print("SUCCESS: Engine 2 (GBDT) initialized and AI Brain loaded.")
        except Exception as e:
            print(f"\nCRITICAL ERROR: Could not load Engine 2. Details: {e}")
            sys.exit(1)

    def reload_model(self):
        """Hot-reloads updated model weights into memory after retraining."""
        print("[ENGINE 2] Hot-reloading model weights...")
        self.load_model()

    def rank_candidates(
        self,
        semantic_scores: Dict[str, float],
        faculty_roster: Optional[Sequence[Dict[str, Any]]] = None,
        faculty_limits: Optional[Dict[str, float]] = None,
        subject: Optional[Dict[str, Any]] = None,
        term: Optional[Any] = None,
        programs: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Every professor in semantic_scores, scored and sorted (best first), rank set. `subject` is
        {id, code, title} for the history lookup; `term` the (year, semester) the ranking is for;
        `programs` the programs whose sections take the subject."""
        if not semantic_scores:
            return []
        faculty_limits = faculty_limits or {}
        subject = subject or {}
        roster_lookup: Dict[str, Dict[str, Any]] = {}
        for f in faculty_roster or []:
            roster_lookup[str(f.get("facultyId"))] = f
            roster_lookup[str(f.get("name"))] = f
        median = rating_median(faculty_roster or [], self.rating_fallback)

        rows: List[Dict[str, Any]] = []
        for prof_id_or_name, semantic_score in semantic_scores.items():
            faculty_data = roster_lookup.get(str(prof_id_or_name), {})
            features = candidate_features(
                faculty_data, float(semantic_score or 0.0), term, median,
                subject_id=subject.get("id"), subject_code=subject.get("code"), title=subject.get("title"), programs=programs)
            prof_name = faculty_data.get("name", prof_id_or_name)
            cap = float(faculty_limits[prof_name]) if prof_name in faculty_limits else float(faculty_data.get("maxLoad", 21.0))
            rows.append({
                "id": str(faculty_data.get("facultyId", prof_id_or_name)),
                "name": prof_name,
                "reason": reason_text(features, term),
                "dataQualityFlag": bool(faculty_data.get("hasValidProfile", True)),
                "maxWeeklyHours": cap,
                "features": features,
                "_semantic_score": float(semantic_score or 0.0),
            })
        probabilities = self.model.predict_proba(feature_frame([r["features"] for r in rows]))[:, 1]
        for row, p in zip(rows, probabilities):
            row["_raw_score"] = float(p) * 100.0
            row["score"] = round(row["_raw_score"], 2)
        rows.sort(key=lambda r: (r["_raw_score"], r["_semantic_score"]), reverse=True)
        for rank, row in enumerate(rows, start=1):
            row["rank"] = rank
            row.pop("_raw_score", None)
            row.pop("_semantic_score", None)
        return rows

    def predict_best_faculty(
        self,
        semantic_scores: Optional[Dict[str, float]] = None,
        nlp_scores_dict: Optional[Dict[str, float]] = None,
        faculty_roster: Optional[Sequence[Dict[str, Any]]] = None,
        faculty_limits: Optional[Dict[str, float]] = None,
        dean_overrides_limits: Optional[Dict[str, float]] = None,
        subject: Optional[Dict[str, Any]] = None,
        term: Optional[Any] = None,
        programs: Optional[Sequence[str]] = None,
        top_n: int = 3,
    ) -> List[Dict[str, Any]]:
        """The top three (the API's answer), in the shape the gateway and the pages read."""
        scores_dict = semantic_scores if semantic_scores is not None else (nlp_scores_dict or {})
        limits_dict = faculty_limits if faculty_limits is not None else (dean_overrides_limits or {})
        ranked = self.rank_candidates(scores_dict, faculty_roster, limits_dict, subject=subject, term=term, programs=programs)
        return ranked[:top_n]
