"""Engine 4: the ranking retrained from the Dean's decisions (Phase 5; rebuilt in Phase 8 Part 11).

What it learns from (is_training_decision, the same rule as the gateway's utils/decisions.js on the
pinned cases of shared/decision-cases.json):
- accept and override rows of overrideLogs (a decision on a recommendation);
- every assignment a PERSON made by hand: a 'lock' row whose actor is a signed-in user (with an id; not the
  System actor, nor the term loader, which calls the lock handler as a user with no id), naming a professor (not the TBA pool or an outside teacher), and not a
  practice-copy fill a script made ("Practice copy only: ..."). Before Part 11 these were left out as
  "placeholders", so the Dean's 69 hand assignments of 9 Oct gave Engine 4 nothing to learn from.
Moves and approvals never count. One class (term, section, subject) counts once: its latest decision.

How it learns: each decision is one ranking question, built as the training data was (every professor on
record a candidate, the Dean's choice labelled 1, ml/serving.py's features). The constrained model
(ml/model.py make_model, the settings in the model's .meta.json) is refitted FROM SCRATCH on the three
training semesters' questions (ml/build_dataset.py's dataset) plus the decisions; never warm-started.

When it keeps the new model: both together, measured on data it did not learn from:
1) the unseen test semester's mean reciprocal rank is not lower than that of the same settings fitted on
   the training semesters alone, minus 0.01;
2) the decisions set aside (30%, by question) are ranked at least as well as by the model in use.
Then the model in use is refitted the same way on all four semesters plus every decision (as
ml/train_eval.py saves its file), checked for the schema and the monotonic sweep, and saved; the old
file stays as .bak and Engine 2 reloads the new one (main.py). Otherwise it says why, in plain words.
"""
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
from pymongo import MongoClient

from config import ML_DATASET_PATH, MODEL_PATH, MONGO_URI, GBDT_FEATURES
from database import get_database
from engine1_nlp import roster_entry
from engine2_gbdt import meta_path_for
from ml.features import semantic_similarity
from ml.model import make_model, sweep_violations
from ml.serving import NEUTRAL_RATING, candidate_features, rating_median, term_from_request

# The rows of overrideLogs that are the Dean's decisions on a ranking; a 'lock' row counts when a person
# made it (is_hand_assignment).
DECISION_ENTRY_TYPES = ("accept", "override")
HAND_ENTRY_TYPE = "lock"
# Approval rows written before entryType existed carry this subject code instead (the gateway's
# APPROVAL_CHAIN; the Audit Trail and the decision route read it the same way).
APPROVAL_CHAIN = "APPROVAL-CHAIN"
# A lock naming nobody (the TBA pool card) or an outside GenEd teacher is not a choice of a professor.
NOT_A_PROFESSOR = ("FAC-TBA", "OUTSIDE")
# The actor the term loader and the gateway write for rows nobody signed (utils/actor.js SYSTEM_ACTOR,
# load-term.js LOADER_ACTOR).
SYSTEM_ROLE = "system"
SYSTEM_ID = "SYSTEM"
# The reason the practice copy's scripts give their fills (scripts/demo/deans-path.js PRACTICE_REASON).
PRACTICE_PREFIX = "practice copy only"
# Fewest decisions a retraining needs; reported with every answer so the page can say it.
MIN_DECISIONS = 5
# The share of decisions set aside to test the retrained ranking, by question.
HOLD_OUT = 0.30
# How much lower the test semester's mean reciprocal rank may be (decision 6).
TEST_MRR_SLACK = 0.01
# The test semester when the model's .meta.json names none (ml/train_eval.py TEST_TERM).
DEFAULT_TEST_TERM = "2nd Sem AY 2025-26"
# The settings when the .meta.json has none: Part 11's chosen ones (ml/train_eval.py).
DEFAULT_PARAMS = {"max_depth": 2, "learning_rate": 0.03, "min_samples_leaf": 10, "l2_regularization": 0.0, "max_iter": 200}
PARAM_KEYS = ("max_depth", "learning_rate", "min_samples_leaf", "l2_regularization", "max_iter", "max_leaf_nodes")
# The monotonic sweep's grids for the two continuous features (the others use the values seen).
SWEEP_GRIDS = {"semantic_match": [i / 20 for i in range(21)], "eval_rating": [1 + i / 4 for i in range(17)]}
SWEEP_ROWS = 300


class DecisionsUnavailable(RuntimeError):
    """The decisions could not be read from the database (Phase 4 Part 4). Raised by pull_override_data,
    never swallowed into "no decisions"; the route answers with these plain words."""


def _entry_type(entry) -> str:
    return str(entry.get("entryType") or "").strip().lower()


def is_hand_assignment(entry) -> bool:
    """A 'lock' row a person made: signed by a user (not the System actor), naming a professor, and not
    a practice-copy fill a script made."""
    if _entry_type(entry) != HAND_ENTRY_TYPE:
        return False
    actor = entry.get("actor")
    if not isinstance(actor, dict) or not str(actor.get("name") or "").strip():
        return False
    # A signed-in user always has an id; the term loader calls the lock handler as a user with none.
    actor_id = str(actor.get("id") or "").strip()
    if not actor_id or actor_id.upper() == SYSTEM_ID or str(actor.get("role") or "").strip().lower() == SYSTEM_ROLE:
        return False
    professor = str(entry.get("assignedFacultyId") or "").strip().upper()
    if not professor or professor in NOT_A_PROFESSOR:
        return False
    return not str(entry.get("reason") or "").strip().lower().startswith(PRACTICE_PREFIX)


def is_training_decision(entry) -> bool:
    """True for a row Engine 4 learns from: entryType accept or override, or a hand assignment by a
    person. A row with no entryType (written before the field existed) is kept as before, because
    nothing but free text tells what it was, unless it is an approval row by its APPROVAL-CHAIN code."""
    entry_type = _entry_type(entry)
    if entry_type:
        return entry_type in DECISION_ENTRY_TYPES or is_hand_assignment(entry)
    return str(entry.get("subjectCode") or "").strip().upper() != APPROVAL_CHAIN


def decision_words(count: int) -> str:
    """The count in words: no / 1 / 3 decision(s)."""
    return f"{count or 'no'} decision{'' if count == 1 else 's'}"


def latest_per_class(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One decision per class (term, section, subject): the latest by timestamp (else the last read), so
    a class assigned twice teaches the ranking only the choice that stands."""
    chosen: Dict[Tuple, Tuple[float, int, Dict[str, Any]]] = {}
    for order, row in enumerate(rows):
        term = row.get("_term") or {}
        key = (str(term.get("academicYear")), str(term.get("semester")),
               str(row.get("sectionCode") or row.get("section") or "").strip().upper(),
               str(row.get("subjectId") or "") or str(row.get("subjectCode") or "").strip().upper())
        stamp = row.get("timestamp")
        stamp = stamp.timestamp() if isinstance(stamp, datetime) else -1.0
        if key not in chosen or (stamp, order) >= chosen[key][:2]:
            chosen[key] = (stamp, order, row)
    return [entry[2] for entry in sorted(chosen.values(), key=lambda e: e[1])]


# ---------------------------------------------------------------------- measuring a ranking
def _question_facts(scores: np.ndarray, labels: np.ndarray) -> Tuple[float, float]:
    """(reciprocal rank, top-1 hit) of one question, ties shared out evenly (as ml/train_eval.py)."""
    positive = int(np.flatnonzero(labels == 1)[0])
    better = int(np.sum(scores > scores[positive]))
    tied = int(np.sum(scores == scores[positive])) - 1
    rr = float(np.mean(1.0 / np.arange(better + 1, better + tied + 2)))
    top1 = min(1.0, max(0.0, (1 - better) / (tied + 1)))
    return rr, top1


def rank_quality(model, frame: pd.DataFrame) -> Dict[str, float]:
    """{mrr, top1, questions} of `model` on a frame of questions (FEATURES + label + question_id)."""
    if frame.empty:
        return {"mrr": 0.0, "top1": 0.0, "questions": 0}
    scores = model.predict_proba(frame[GBDT_FEATURES])[:, 1]
    work = pd.DataFrame({"q": frame["question_id"].values, "s": scores, "y": frame["label"].values})
    facts = [_question_facts(g["s"].to_numpy(), g["y"].to_numpy()) for _, g in work.groupby("q", sort=False) if g["y"].sum() == 1]
    if not facts:
        return {"mrr": 0.0, "top1": 0.0, "questions": 0}
    return {"mrr": round(float(statistics.mean(f[0] for f in facts)), 4),
            "top1": round(float(statistics.mean(f[1] for f in facts)), 4), "questions": len(facts)}


def questions_frame(questions: List[Dict[str, Any]], prefix: str = "decision") -> pd.DataFrame:
    """The decision questions as rows of a training frame."""
    rows = []
    for i, q in enumerate(questions):
        for features, label in zip(q["features"], q["labels"]):
            rows.append({**{f: features[f] for f in GBDT_FEATURES}, "label": int(label), "question_id": f"{prefix}-{i}"})
    return pd.DataFrame(rows, columns=[*GBDT_FEATURES, "label", "question_id"])


def fit(params: Dict[str, Any], frames: List[pd.DataFrame]):
    """The constrained model, fitted from scratch on the frames together."""
    data = pd.concat([f for f in frames if not f.empty], ignore_index=True)
    model = make_model(params)
    model.fit(data[GBDT_FEATURES], data["label"].astype(int))
    return model


class AdaptiveLearner:
    def __init__(self, model_path: Path = MODEL_PATH, mongo_uri: str = MONGO_URI,
                 client_factory: Callable[..., Any] = MongoClient, dataset_path: Optional[Path] = None):
        self.model_path = Path(model_path)
        self.mongo_uri = mongo_uri
        self.client_factory = client_factory
        self.dataset_path = Path(dataset_path) if dataset_path else Path(ML_DATASET_PATH)

    # ------------------------------------------------------------------ reading
    @staticmethod
    def _collection(db, name: str):
        try:
            return db[name]
        except KeyError:  # the tests' fake database serves only the collections they define
            return None

    def pull_override_data(self):
        """Pulls the Dean's decisions (is_training_decision) from every schedule document, each with its
        schedule's term under _term; moves, approvals and locks nobody signed are left out."""
        # Outside the try: a refused live database must stop the caller, not look like "no overrides".
        _, db = get_database(self.mongo_uri, self.client_factory)
        try:
            schedules_col = db["mother_schedules"]
            all_overrides = []
            for sched in schedules_col.find({"overrideLogs": {"$exists": True, "$ne": []}}):
                term = {"academicYear": sched.get("academicYear"), "semester": sched.get("semester")}
                for e in sched.get("overrideLogs", []):
                    if is_training_decision(e):
                        all_overrides.append({**e, "_term": term})
            return all_overrides
        except Exception as e:
            # Phase 4 Part 4: a database that cannot be read is an error with plain words, never "no
            # decisions" (which would have skipped the retraining as if the Dean had decided nothing).
            print(f"[ENGINE 4 ERROR] Could not read the decisions: {e}")
            raise DecisionsUnavailable(
                "The decisions could not be read from the database, so nothing was retrained. "
                "Check that the database is reachable, then try again."
            ) from e

    def load_roster(self) -> List[Dict[str, Any]]:
        """Every professor on record (active or not: the one chosen may have left since), as Engine 1
        reads them. A record that cannot be read is skipped."""
        _, db = get_database(self.mongo_uri, self.client_factory)
        col = self._collection(db, "faculty")
        roster = []
        for doc in (col.find({}) if col is not None else []):
            try:
                roster.append(roster_entry(doc))
            except Exception as e:
                print(f"[ENGINE 4 WARNING] Skipped faculty {doc.get('facultyId') if isinstance(doc, dict) else '?'}: {e}")
        return roster

    def load_catalog(self) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        """The catalog subjects by id and by code (the first active one per code)."""
        _, db = get_database(self.mongo_uri, self.client_factory)
        col = self._collection(db, "subject_catalog")
        by_id: Dict[str, Dict[str, Any]] = {}
        by_code: Dict[str, Dict[str, Any]] = {}
        for doc in (col.find({}) if col is not None else []):
            if not isinstance(doc, dict):
                continue
            by_id[str(doc.get("_id"))] = doc
            code = str(doc.get("subjectCode") or "").strip().upper()
            if code and (code not in by_code or (doc.get("isActive", True) and not by_code[code].get("isActive", True))):
                by_code[code] = doc
        return by_id, by_code

    def load_dataset(self) -> Optional[pd.DataFrame]:
        """The past semesters' ranking questions (ml/build_dataset.py), or None when the file is absent
        or lacks a feature (the public copy has no rating column)."""
        if not self.dataset_path.exists():
            return None
        frame = pd.read_csv(self.dataset_path)
        needed = [*GBDT_FEATURES, "label", "question_id", "term"]
        return frame if all(c in frame.columns for c in needed) else None

    def _meta(self) -> Dict[str, Any]:
        meta_path = meta_path_for(self.model_path)
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                return meta if isinstance(meta, dict) else {}
            except (OSError, ValueError):
                return {}
        return {}

    @staticmethod
    def _params(meta: Dict[str, Any]) -> Dict[str, Any]:
        """The settings ml/train_eval.py chose (the model's .meta.json), only the constrained model's."""
        stored = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        params = {k: stored[k] for k in PARAM_KEYS if k in stored}
        return params or dict(DEFAULT_PARAMS)

    # ------------------------------------------------------------------ the questions
    @staticmethod
    def build_questions(decisions, roster, catalog_by_id, catalog_by_code) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
        """One ranking question per decision: every professor on the roster as a candidate, the Dean's
        choice labelled 1, the features as Engine 2 computes them for that subject and term."""
        skipped = {"no_subject": 0, "no_professor": 0, "no_roster": 0}
        if not roster:
            skipped["no_roster"] = len(decisions)
            return [], skipped
        by_id = {str(r.get("facultyId")): r for r in roster}
        by_name = {str(r.get("name")): r for r in roster}
        median = rating_median(roster, NEUTRAL_RATING)
        profiles = [r.get("profile", "") for r in roster]
        questions = []
        for d in decisions:
            subject = catalog_by_id.get(str(d.get("subjectId") or "")) or catalog_by_code.get(str(d.get("subjectCode") or "").strip().upper())
            if subject is None:
                skipped["no_subject"] += 1
                continue
            chosen = by_id.get(str(d.get("assignedFacultyId") or "")) or by_name.get(str(d.get("assignedFacultyName") or d.get("deanSelectedFaculty") or ""))
            if chosen is None:
                skipped["no_professor"] += 1
                continue
            term_info = d.get("_term") or {}
            term = term_from_request(term_info.get("academicYear"), term_info.get("semester"))
            program = str(d.get("sectionCode") or d.get("section") or "").strip().split(" ")[0].upper() or None
            query = f"{subject.get('descriptiveTitle') or ''} {subject.get('subjectDescription') or subject.get('descriptiveTitle') or ''}".strip()
            semantic = semantic_similarity(query, profiles)
            features = [candidate_features(r, s, term, median, subject_id=subject.get("_id"), subject_code=subject.get("subjectCode"),
                                           title=subject.get("descriptiveTitle"), programs=[program] if program else [])
                        for r, s in zip(roster, semantic)]
            labels = [1 if r is chosen else 0 for r in roster]
            questions.append({"features": features, "labels": labels, "subject": subject.get("subjectCode"), "section": d.get("sectionCode"),
                              "kind": "assigned" if is_hand_assignment(d) else (_entry_type(d) or "unrecorded")})
        return questions, skipped

    # ------------------------------------------------------------------ training
    def retrain_and_save(self) -> dict:
        """Refits the constrained ranking on the past semesters plus the Dean's decisions and keeps it
        only when it ranks the unseen semester and the decisions set aside at least as well."""
        print("\n[ENGINE 4] Initiating Adaptive Retraining Pipeline...")
        decisions = latest_per_class(self.pull_override_data())
        found = len(decisions)
        base = {"total_overrides": found, "minimum_decisions": MIN_DECISIONS}

        if found < MIN_DECISIONS:
            print(f"[ENGINE 4] Retraining skipped: Found {found} decision(s), requires at least {MIN_DECISIONS}.")
            return {"status": "skipped", **base,
                    "message": f"Nothing to learn from yet: {decision_words(found)} recorded, at least {MIN_DECISIONS} needed."}

        dataset = self.load_dataset()
        if dataset is None:
            return {"status": "aborted", **base,
                    "message": ("The past semesters' records the ranking learns from are not on this computer, so nothing "
                                "was retrained. Ask the system team to build them, then try again.")}

        roster = self.load_roster()
        by_id, by_code = self.load_catalog()
        questions, skipped = self.build_questions(decisions, roster, by_id, by_code)
        unusable = sum(skipped.values())
        if len(questions) < MIN_DECISIONS:
            why = ("no professor profiles could be read" if skipped["no_roster"]
                   else f"{unusable} of the decisions name a subject or a professor that is not on record")
            return {"status": "aborted", **base, "unusable_decisions": unusable,
                    "message": f"Nothing to learn from: {why}, so fewer than {MIN_DECISIONS} decisions can be used. Nothing was changed."}
        if all(len(q["labels"]) < 2 for q in questions):
            return {"status": "aborted", **base,
                    "message": "Nothing to learn from: the decisions name no professor who was passed over. Nothing was changed."}

        meta = self._meta()
        params = self._params(meta)
        test_term = str((meta.get("metrics") or {}).get("test_term") or DEFAULT_TEST_TERM)
        past_train = dataset[dataset["term"] != test_term]
        past_test = dataset[dataset["term"] == test_term]
        if past_train.empty or past_test.empty:
            return {"status": "aborted", **base,
                    "message": ("The past semesters' records do not hold both the training semesters and the test semester, "
                                "so nothing was retrained.")}

        rng = np.random.default_rng(42)
        order = rng.permutation(len(questions))
        n_val = max(1, int(round(len(questions) * HOLD_OUT)))
        held = questions_frame([questions[i] for i in order[:n_val]], "held")
        learn = questions_frame([questions[i] for i in order[n_val:]], "learn")

        # Before: the same settings on the training semesters alone (for the unseen semester) and the
        # model in use (for the decisions set aside). After: the candidate, the decisions added.
        baseline = fit(params, [past_train])
        in_use = joblib.load(self.model_path) if self.model_path.exists() else baseline
        if list(getattr(in_use, "feature_names_in_", [])) != GBDT_FEATURES:
            in_use = baseline
        candidate = fit(params, [past_train, learn])
        before = {"test": rank_quality(baseline, past_test), "decisions": rank_quality(in_use, held)}
        after = {"test": rank_quality(candidate, past_test), "decisions": rank_quality(candidate, held)}
        counts = {
            "questions_used": len(questions),
            "held_out": int(n_val),
            "unusable_decisions": unusable,
            "from_rankings": sum(1 for q in questions if q["kind"] != "assigned"),
            "by_hand": sum(1 for q in questions if q["kind"] == "assigned"),
            "test_term": test_term,
            "before": before,
            "after": after,
        }
        print(f"[ENGINE 4] test MRR {before['test']['mrr']} -> {after['test']['mrr']}; "
              f"held-out decisions MRR {before['decisions']['mrr']} -> {after['decisions']['mrr']}")

        reasons = []
        if after["test"]["mrr"] < before["test"]["mrr"] - TEST_MRR_SLACK:
            reasons.append(f"it ranked last year's real choices for the test semester lower "
                           f"({after['test']['mrr']:.3f} against {before['test']['mrr']:.3f})")
        if after["decisions"]["mrr"] < before["decisions"]["mrr"]:
            reasons.append(f"it ranked the Dean's choices set aside to test it lower than the ranking in use does "
                           f"({after['decisions']['mrr']:.3f} against {before['decisions']['mrr']:.3f})")
        if reasons:
            print(f"[ENGINE 4 REJECTED] {'; '.join(reasons)}")
            return {"status": "rejected", **base, **counts,
                    "message": f"The retrained ranking was not kept: {' and '.join(reasons)}. Nothing was changed."}

        # Kept: the model in use is refitted the same way on every semester and every decision.
        everything = questions_frame(questions, "decision")
        final = fit(params, [dataset, everything])
        if list(getattr(final, "feature_names_in_", [])) != GBDT_FEATURES:
            raise RuntimeError(f"[ENGINE 4 CRITICAL] Retrained model schema mismatch! Expected: {GBDT_FEATURES}, "
                               f"Got: {list(getattr(final, 'feature_names_in_', []))}. Deployment blocked!")
        sample = pd.concat([past_test, everything], ignore_index=True)
        sample = sample.sample(n=min(SWEEP_ROWS, len(sample)), random_state=42)
        broken = {f: n for f, n in sweep_violations(final, sample, GBDT_FEATURES, SWEEP_GRIDS).items() if n}
        if broken:
            return {"status": "aborted", **base, **counts,
                    "message": ("The retrained ranking was not kept: in it, more teaching history or a better evaluation "
                                "lowered a professor's score. Nothing was changed.")}

        backup_path = self.model_path.with_suffix(".joblib.bak")
        meta_path = meta_path_for(self.model_path)
        if self.model_path.exists():
            self.model_path.replace(backup_path)
        if meta_path.exists():
            meta_path.replace(meta_path.with_name(meta_path.name + ".bak"))
        joblib.dump(final, self.model_path)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        meta_out = {**meta, "features": GBDT_FEATURES, "params": {**(meta.get("params") or {}), **params},
                    "rows": int(len(dataset) + len(everything)), "questions": int(dataset["question_id"].nunique() + len(questions)),
                    "engine4": {"retrained_at": now, "decisions_used": len(questions), "from_rankings": counts["from_rankings"],
                                "by_hand": counts["by_hand"], "held_out": counts["held_out"], "test_term": test_term,
                                "before": before, "after": after, "monotonic_sweep_violations": 0}}
        meta_path.write_text(json.dumps(meta_out, indent=2) + "\n", encoding="utf-8")
        print(f"[ENGINE 4 SUCCESS] Live model safely updated from {len(questions)} decisions.")

        return {
            "status": "success", **base, **counts,
            "message": (f"The ranking was retrained from {decision_words(len(questions))} and is now in use: it put the "
                        f"Dean's choice first {after['decisions']['top1']:.0%} of the time on the decisions set aside to "
                        f"test it (the ranking it replaced: {before['decisions']['top1']:.0%})."),
            "val_accuracy": after["decisions"]["top1"],
            "val_mrr": after["decisions"]["mrr"],
        }
