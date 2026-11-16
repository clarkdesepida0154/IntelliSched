import math
from typing import Dict, List, Any, Callable, Optional
from pymongo import MongoClient
from config import MONGO_URI
from database import get_database
from engine2_gbdt import ancillary_hours
from ml.features import semantic_similarity
from ml.serving import roster_profile

# Engine 2's neutral evaluation when a professor has none on record (absent or null): the value the
# roster always used for a missing evalScore.
DEFAULT_EVAL = 4.0
# The teaching cap when neither teachingCapHours nor the deprecated maxLoad is on record.
DEFAULT_CAP = 21.0


def optional_number(value: Any, field: str) -> Optional[float]:
    """None for an absent or null value; a float for a number; ValueError for anything else."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{field} is not a number ({value!r})")
    return float(value)


def roster_entry(f: Dict[str, Any]) -> Dict[str, Any]:
    """One roster row from a faculty document, read null-safely. A present value of the wrong type
    raises ValueError, and the caller skips that document."""
    if not isinstance(f, dict):
        raise ValueError("the record is not a document")
    raw_profile = f.get("engine1Profile")
    if raw_profile is not None and not isinstance(raw_profile, str):
        raise ValueError(f"engine1Profile is not text ({raw_profile!r})")
    # Phase 5: the profile Engine 1 matches is the Major/Minor, the specializations and the
    # certifications (as the model was trained), and the stored engine1Profile only when the record
    # has none of those. Past subjects are the teaching history, not profile text.
    profile = roster_profile(f)
    has_valid_profile = bool(profile)
    name = f.get("name")
    if name is not None and not isinstance(name, str):
        raise ValueError(f"name is not text ({name!r})")
    if not has_valid_profile:
        print(f"[ENGINE 1 WARNING] Faculty '{name}' ({f.get('facultyId')}) has no profile. Similarity may be low.")

    # evalScore: {average, history} (current), a bare number (legacy), or absent/null. A stored 0 (the
    # Faculty form's default for a new profile since Phase 4 Part 2) means the same as an absent value:
    # "no CCS evaluation yet". Such a professor carries Engine 2's neutral value and hasEvaluation
    # False, so having no rating never ranks anyone down, and the reason text says so.
    raw_eval = f.get("evalScore")
    eval_average = optional_number(raw_eval.get("average") if isinstance(raw_eval, dict) else raw_eval, "evalScore")
    has_evaluation = eval_average is not None and eval_average > 0
    # The teaching cap (Phase 1), else the deprecated maxLoad.
    cap = optional_number(f.get("teachingCapHours"), "teachingCapHours")
    if cap is None:
        cap = optional_number(f.get("maxLoad"), "maxLoad")

    return {
        "facultyId": f.get("facultyId") or str(f.get("_id")),
        "name": name or "Unknown Faculty",
        "department": f.get("department") or "BSIT",
        "profile": profile if has_valid_profile else (name or ""),
        "evalAverage": eval_average if has_evaluation else DEFAULT_EVAL,
        "hasEvaluation": has_evaluation,
        "maxLoad": DEFAULT_CAP if cap is None else cap,
        "ancillaryHours": ancillary_hours(f),
        "hasValidProfile": has_valid_profile,
        # Phase 5: what the ranking's history features read (written by the term loader).
        "employmentType": f.get("employmentType") if isinstance(f.get("employmentType"), str) else None,
        "teachingHistory": f.get("teachingHistory") if isinstance(f.get("teachingHistory"), list) else [],
        "programHistory": f.get("programHistory") if isinstance(f.get("programHistory"), list) else [],
    }


class NLPEngine:
    def __init__(self, mongo_uri: str = MONGO_URI, client_factory: Callable[..., Any] = MongoClient):
        self.mongo_uri = mongo_uri
        self.client_factory = client_factory
        self.faculty_roster: List[Dict[str, Any]] = []
        self.load_faculty_from_db()

    def load_faculty_from_db(self) -> Dict[str, Any]:
        """
        Pulls the active faculty from MongoDB and rebuilds the roster. Each document is read on its
        own: a document that cannot be read is skipped and reported, and never empties the roster.
        Returns {status, loaded, skipped: [{facultyId, reason}]} (the /api/sync_roster answer). When
        active faculty exist but none can be read, status is "error" and the last good roster stays.
        """
        # Outside the try: a refused live database must stop the caller, not empty the roster.
        _, db = get_database(self.mongo_uri, self.client_factory)
        try:
            records = list(db["faculty"].find({"isActive": True}))
        except Exception as e:
            print(f"[ENGINE 1 ERROR] Database read failed: {e}. Keeping the last roster.")
            return {"status": "error", "loaded": len(self.faculty_roster), "skipped": [],
                    "message": f"The faculty could not be read ({e}); the last roster was kept."}

        roster: List[Dict[str, Any]] = []
        skipped: List[Dict[str, str]] = []
        for f in records:
            try:
                roster.append(roster_entry(f))
            except Exception as e:
                code = str(f.get("facultyId") or f.get("_id")) if isinstance(f, dict) else "unknown"
                print(f"[ENGINE 1 WARNING] Skipped faculty {code}: {e}")
                skipped.append({"facultyId": code, "reason": str(e)})

        if records and not roster:
            print("[ENGINE 1 ERROR] No active faculty could be read. Keeping the last good roster.")
            return {"status": "error", "loaded": 0, "skipped": skipped,
                    "message": "None of the active faculty could be read, so the last good roster was kept."}
        if not records:
            print("[ENGINE 1 WARNING] No active faculty found in MongoDB.")
        self.faculty_roster = roster
        print(f"[ENGINE 1] Loaded {len(roster)} faculty profiles ({len(skipped)} skipped).")
        return {"status": "success", "loaded": len(roster), "skipped": skipped}

    def get_semantic_scores(self, subject_title: str, subject_description: str) -> Dict[str, float]:
        """
        Computes cosine similarity between course description and each faculty's engine1Profile.
        Returns a dictionary mapping facultyId to similarity score (0.0 to 1.0).
        """
        if not self.faculty_roster:
            return {}

        query_text = f"{subject_title} {subject_description}".strip()
        # The one similarity function the dataset builder used (ml/features.py).
        similarities = semantic_similarity(query_text, [f["profile"] for f in self.faculty_roster])

        scores = {}
        for idx, faculty in enumerate(self.faculty_roster):
            scores[str(faculty["facultyId"])] = float(similarities[idx])

        return scores