"""The ranking features at request time (Engine 2) and at retrain time (Engine 4), from the faculty
records the gateway stores (Phase 5, Step 3).

The definitions are ml/features.py's, the ones the dataset builder used; this module only reads them off
a roster row (engine1_nlp.roster_entry) and words the reason text. Nothing here touches a database.

A roster row carries, besides the Phase 4 fields:
    employmentType      "FULL_TIME" | "PART_TIME"
    teachingHistory     [{subjectId, subjectCode, descriptiveTitle, terms: ["1st Sem AY 2024-25", ...],
                          termSections: [{term, sections}]}]  written by the term loader from the past
                        Teachers' Programs; an entry without termSections counts 1 section per term
    programHistory      [{program: "BSIT", terms: [...]}]
    evalAverage / hasEvaluation   the latest 1-5 rating, or none
"""
from __future__ import annotations

import re
import statistics
from typing import Any, Dict, Iterable, List, Optional, Sequence

from ml.features import (FEATURES, TermKey, history_features, previous_same_semester, profile_text,
                         sections_by_term_from_stored, term_key_from_parts)

# The words for the semantic match, by Engine 1's cosine score. The scores are small (a short profile
# against a long course description): on the 4-term history the taught professor's score was above 0.15
# in one question of six and above 0.05 in half of them.
MATCH_HIGH = 0.15
MATCH_MEDIUM = 0.05
# Engine 2's neutral rating when nobody on the roster has one and the model file carries no fallback.
NEUTRAL_RATING = 4.0


def normalise_text(text: Any) -> str:
    text = re.sub(r"\(\s*[A-Za-z]{2,4}\s*\d{3}\s*\)", " ", str(text or "")).lower().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def roster_profile(doc: Dict[str, Any]) -> str:
    """The text Engine 1 matches: the Major/Minor, the specializations and the certifications, as in
    training; the stored engine1Profile only when the record has none of those (an older profile)."""
    major = doc.get("major") if isinstance(doc.get("major"), str) else None
    text = profile_text(major, _strings(doc.get("specializations")), _strings(doc.get("certifications")))
    if text:
        return text
    stored = doc.get("engine1Profile")
    return stored.strip() if isinstance(stored, str) else ""


def _strings(value: Any) -> List[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(v) for v in value if isinstance(v, str) and v.strip()]


def _entries(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, (list, tuple)):
        return []
    return [v for v in value if isinstance(v, dict)]


def _entry_sections(entry: Dict[str, Any]) -> Dict[TermKey, int]:
    """{term: sections} of one stored entry: termSections when it has them (Phase 8 Part 11), else the
    plain `terms` list (an older record), each term 1 section."""
    with_counts = entry.get("termSections")
    if isinstance(with_counts, list) and with_counts:
        return sections_by_term_from_stored(with_counts)
    return sections_by_term_from_stored(t for t in (entry.get("terms") or []) if isinstance(t, (str, dict)))


def subject_sections(row: Dict[str, Any], subject_id: Any = None, subject_code: Any = None, title: Any = None) -> Dict[TermKey, int]:
    """{term: sections} in which this professor taught the subject, from the stored teaching history:
    matched by the catalog id when both sides have one, else by code and title."""
    wanted_id = str(subject_id) if subject_id else ""
    wanted_code = normalise_text(subject_code)
    wanted_title = normalise_text(title)
    by_id: Dict[TermKey, int] = {}
    by_text: Dict[TermKey, int] = {}
    for entry in _entries(row.get("teachingHistory")):
        entry_id = str(entry.get("subjectId") or "")
        if wanted_id and entry_id and entry_id == wanted_id:
            target = by_id
        elif not (wanted_id and entry_id) and wanted_code and normalise_text(entry.get("subjectCode")) == wanted_code                 and (not wanted_title or normalise_text(entry.get("descriptiveTitle")) == wanted_title):
            target = by_text
        else:
            continue
        for term, n in _entry_sections(entry).items():
            target[term] = max(target.get(term, 0), n)
    return by_id or by_text


def program_terms(row: Dict[str, Any], program: Any) -> List[str]:
    wanted = str(program or "").strip().upper()
    out: List[str] = []
    for entry in _entries(row.get("programHistory")):
        if str(entry.get("program") or "").strip().upper() == wanted:
            out.extend(t for t in (entry.get("terms") or []) if isinstance(t, str))
    return sorted(set(out))


def rating_median(roster: Iterable[Dict[str, Any]], fallback: float = NEUTRAL_RATING) -> float:
    """The median of the ratings present on the roster: what a professor with none gets (as in training,
    where it was the median of the term's candidates)."""
    present = [float(r["evalAverage"]) for r in roster if r.get("hasEvaluation") and r.get("evalAverage") is not None]
    return float(statistics.median(present)) if present else float(fallback)


def term_from_request(academic_year: Any, semester: Any) -> Optional[TermKey]:
    """The term the ranking is for, or None when the request names none (then every stored term counts
    as earlier and no term is 'last same semester')."""
    if not academic_year:
        return None
    try:
        return term_key_from_parts(str(academic_year), str(semester or 1))
    except ValueError:
        return None


def candidate_features(row: Dict[str, Any], semantic: float, term: Optional[TermKey], median: float,
                       subject_id: Any = None, subject_code: Any = None, title: Any = None,
                       programs: Optional[Sequence[str]] = None) -> Dict[str, float]:
    """The feature row of one professor for one subject, in FEATURES order."""
    history = history_features(subject_sections(row, subject_id, subject_code, title), term)
    when = term or (9999, 2)
    rated = bool(row.get("hasEvaluation")) and row.get("evalAverage") is not None
    experience = 0
    for program in (programs or []):
        experience = max(experience, sum(1 for t in sections_by_term_from_stored(program_terms(row, program)) if t < when))
    return {
        "semantic_match": float(semantic or 0.0),
        "semesters_taught": int(history["semesters_taught"]),
        "sections_taught": int(history["sections_taught"]),
        "terms_since_last_taught": int(history["terms_since_last_taught"]),
        "taught_it_last_same_semester": int(history["taught_it_last_same_semester"]),
        "eval_rating": float(row["evalAverage"]) if rated else float(median),
        "eval_missing": 0 if rated else 1,
        "is_full_time": 1 if str(row.get("employmentType") or "").upper() == "FULL_TIME" else 0,
        "program_experience": int(experience),
    }


def match_words(semantic: float) -> str:
    if semantic >= MATCH_HIGH:
        return "high"
    if semantic >= MATCH_MEDIUM:
        return "medium"
    return "low"


def reason_text(features: Dict[str, Any], term: Optional[TermKey]) -> str:
    """The Dean's words, one clause per fact (Phase 8 Part 11): the sections and semesters taught, how
    recently, last year's same semester, the evaluation, the specialization match. E.g. "Taught this
    subject to 6 sections in 3 earlier semesters; Last taught 1 term ago; Student evaluation: 4.40 of 5;
    Specialization match: medium." The evaluation clause keeps the words the gateway's presentation mode
    masks (utils/presentation.js RATING_TEXT): never reword it without that pattern."""
    semesters = int(features.get("semesters_taught", 0))
    sections = int(features.get("sections_taught", 0))
    if semesters:
        parts = [f"Taught this subject to {sections} section{'' if sections == 1 else 's'} in "
                 f"{semesters} earlier semester{'' if semesters == 1 else 's'}"]
        ago = int(features.get("terms_since_last_taught", 0))
        if 0 < ago < 99:
            parts.append(f"Last taught {ago} term{'' if ago == 1 else 's'} ago")
        if int(features.get("taught_it_last_same_semester", 0)) and term is not None:
            parts.append(f"Taught it last {'1st' if previous_same_semester(term)[1] == 1 else '2nd'} semester")
    else:
        parts = ["Has not taught this subject before"]
    if int(features.get("eval_missing", 0)):
        parts.append("No CCS evaluation yet")
    else:
        parts.append(f"Student evaluation: {float(features['eval_rating']):.2f} of 5")
    parts.append(f"Specialization match: {match_words(float(features.get('semantic_match', 0.0)))}")
    return "; ".join(parts) + "."


def feature_frame(rows: Sequence[Dict[str, float]]):
    """A pandas frame in FEATURES order (the model's feature_names_in_)."""
    import pandas as pd
    return pd.DataFrame([{f: r[f] for f in FEATURES} for r in rows], columns=FEATURES)
