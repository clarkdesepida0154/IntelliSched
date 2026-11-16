"""The ranking features, defined once for the history and for the live service (Phase 5).

Nothing here reads a database or the service's config, so the module imports offline. Engine 1 and
Engine 2 import it for the live request; ml/build_dataset.py imports it for the 4 past semesters.

A term is written "1st Sem AY 2024-25" / "2nd Sem AY 2024-25" and ordered by (start year, semester
type): 1st Sem AY 2024-25 < 2nd Sem AY 2024-25 < 1st Sem AY 2025-26 < ...

The rule that matters most: a feature for term t uses only what was known before t. The history
features count earlier terms; the rating is the latest one logged before t.
"""
import math
import re
import statistics
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

TermKey = Tuple[int, int]  # (start year of the academic year, semester type 1 or 2)

TERM_RE = re.compile(r"^\s*(1st|2nd)\s+Sem(?:ester)?\s+AY\s*(\d{4})\s*[-–]\s*(\d{2,4})\s*$", re.IGNORECASE)

# The feature columns, in the order the model sees them.
# Phase 8 Part 11: the history is counted three ways (semesters, sections, how recently) instead of one.
FEATURES: List[str] = [
    "semantic_match",
    "semesters_taught",
    "sections_taught",
    "terms_since_last_taught",
    "taught_it_last_same_semester",
    "eval_rating",
    "eval_missing",
    "is_full_time",
    "program_experience",
]

# The direction each feature may move the score (Phase 8 Part 11, decision 2): +1 a higher value can never
# lower it, -1 never raise it, 0 free. The model's monotonic_cst is this list in FEATURES order.
MONOTONIC: Dict[str, int] = {
    "semantic_match": 1,
    "semesters_taught": 1,
    "sections_taught": 1,
    "terms_since_last_taught": -1,
    "taught_it_last_same_semester": 1,
    "eval_rating": 1,
    "eval_missing": 0,
    "is_full_time": 0,
    "program_experience": 1,
}

# terms_since_last_taught when the professor never taught the subject before the term.
NEVER_TAUGHT = 99

# The rating scale the model uses. Entries on another scale (a percentage) are left out.
RATING_SCALE = "1-5"


def term_key(label: str) -> TermKey:
    """'1st Sem AY 2024-25' -> (2024, 1). ValueError for anything else."""
    match = TERM_RE.match(str(label or ""))
    if not match:
        raise ValueError(f"not a term label: {label!r}")
    return int(match.group(2)), (1 if match.group(1).lower() == "1st" else 2)


def term_label(key: TermKey) -> str:
    """(2024, 1) -> '1st Sem AY 2024-25'."""
    year, sem = key
    return f"{'1st' if sem == 1 else '2nd'} Sem AY {year}-{str(year + 1)[-2:]}"


def term_key_from_parts(academic_year: str, semester: str) -> TermKey:
    """The gateway's words ('2026-2027', '2nd Semester') -> (2026, 2)."""
    year_match = re.match(r"^\s*(\d{4})", str(academic_year or ""))
    if not year_match:
        raise ValueError(f"not an academic year: {academic_year!r}")
    sem = 2 if re.match(r"^\s*2", str(semester or "")) else 1
    return int(year_match.group(1)), sem


def term_ordinal(key: TermKey) -> int:
    """Consecutive terms differ by 1: (2024, 2) - (2024, 1) = 1, (2025, 1) - (2024, 2) = 1."""
    return int(key[0]) * 2 + (int(key[1]) - 1)


def terms_since(last: Optional[TermKey], term: TermKey) -> int:
    """How many terms before `term` the term `last` was (1 = the term just before); NEVER_TAUGHT for None."""
    return NEVER_TAUGHT if last is None else term_ordinal(tuple(term)) - term_ordinal(tuple(last))


def previous_same_semester(key: TermKey) -> TermKey:
    """The same semester type one academic year earlier: the term 'taught it last same semester' looks at."""
    return key[0] - 1, key[1]


def profile_text(major: Optional[str], specializations: Optional[Iterable[str]],
                 certifications: Optional[Iterable[str]]) -> str:
    """The professor's profile Engine 1 matches against: the Major/Minor, the specializations and the
    certifications. Past subjects are NOT part of it: they are the history features, and in the
    history they would carry the term being predicted."""
    parts: List[str] = [str(major or "")]
    parts += [str(s or "") for s in (specializations or [])]
    parts += [str(c or "") for c in (certifications or [])]
    return " ".join(p.strip() for p in parts if p and p.strip())


def semantic_similarity(query_text: str, profiles: Sequence[str]) -> List[float]:
    """Engine 1's score: TF-IDF (English stop words) over the query and the profiles, cosine between the
    query and each profile, 0.0 to 1.0. An empty query or a corpus with no words gives zeros."""
    profiles = [str(p or "") for p in profiles]
    if not profiles:
        return []
    if not str(query_text or "").strip():
        return [0.0] * len(profiles)
    # Imported here so the module stays importable without scikit-learn for the term helpers.
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    vectorizer = TfidfVectorizer(stop_words="english", min_df=1)
    try:
        matrix = vectorizer.fit_transform([query_text] + profiles)
    except ValueError:  # empty vocabulary: only stop words, or nothing at all
        return [0.0] * len(profiles)
    scores = cosine_similarity(matrix[0:1], matrix[1:]).flatten()
    return [float(s) if math.isfinite(s) else 0.0 for s in scores]


class TeachingHistory:
    """What a professor taught in which terms, by catalog subject and by program.

    add(professor, subject, program, term, section) records one class of `subject` (a catalog subject key)
    for `section` of `program` ("BSIT" / "BSCS") in `term`. A section counts once per term however many
    blocks (lecture and lab) the professor had in it. The features read only terms before the term asked
    about."""

    def __init__(self) -> None:
        self._subjects: Dict[Any, Dict[Any, Dict[TermKey, Set[Any]]]] = {}
        self._programs: Dict[Any, Dict[str, Set[TermKey]]] = {}

    def add(self, professor: Any, subject: Any, program: Optional[str], term: TermKey, section: Any = None) -> None:
        if subject is not None:
            sections = self._subjects.setdefault(professor, {}).setdefault(subject, {}).setdefault(tuple(term), set())
            sections.add(section if section is not None else ("", program))
        if program:
            self._programs.setdefault(professor, {}).setdefault(str(program), set()).add(tuple(term))

    def sections_by_term(self, professor: Any, subject: Any) -> Dict[TermKey, int]:
        """{term: the number of sections of the subject the professor taught that term}."""
        return {t: len(s) for t, s in self._subjects.get(professor, {}).get(subject, {}).items()}

    def terms_taught(self, professor: Any, subject: Any) -> List[TermKey]:
        return sorted(self.sections_by_term(professor, subject))

    def subject_features(self, professor: Any, subject: Any, term: TermKey) -> Dict[str, int]:
        """semesters_taught, sections_taught, terms_since_last_taught and taught_it_last_same_semester."""
        return history_features(self.sections_by_term(professor, subject), term)

    def program_experience(self, professor: Any, program: Optional[str], term: TermKey) -> int:
        """The number of earlier terms with any class for that program."""
        return sum(1 for t in self._programs.get(professor, {}).get(str(program or ""), set()) if t < tuple(term))


def history_features(sections_by_term: Dict[TermKey, int], term: Optional[TermKey]) -> Dict[str, int]:
    """The four history features from {term: sections taught that term}, as of `term` (only earlier terms
    count). With term None every stored term counts as earlier, none is 'last same semester' and the
    last one is read as 1 term ago."""
    when = tuple(term) if term is not None else (9999, 2)
    earlier = {t: n for t, n in sections_by_term.items() if tuple(t) < when}
    last = max(earlier) if earlier else None
    return {
        "semesters_taught": len(earlier),
        "sections_taught": int(sum(max(1, int(n)) for n in earlier.values())),
        # No term: there is nothing to count back from, so a professor who taught it reads as 1 term ago.
        "terms_since_last_taught": terms_since(last, when) if term is not None or last is None else 1,
        "taught_it_last_same_semester": int(term is not None and previous_same_semester(when) in earlier),
    }


def sections_by_term_from_stored(terms: Iterable[Any]) -> Dict[TermKey, int]:
    """The stored teachingHistory entry's `terms`, in either shape: the Phase 8 Part 11 list of
    {term, sections}, or the older plain list of term labels (each counted as 1 section). Entries that are
    not a term are skipped; a term listed twice adds its sections."""
    out: Dict[TermKey, int] = {}
    for item in terms or []:
        if isinstance(item, dict):
            label, count = item.get("term"), item.get("sections", 1)
        else:
            label, count = item, 1
        try:
            key = term_key(label)
            n = int(count) if count is not None and not isinstance(count, bool) else 1
        except (TypeError, ValueError):
            continue
        out[key] = out.get(key, 0) + max(1, n)
    return out


def history_features_from_terms(terms_taught: Iterable[Any], term: Optional[TermKey]) -> Dict[str, int]:
    """The four history features from a stored teachingHistory entry's `terms` (either shape): what the
    live service reads from the faculty record."""
    return history_features(sections_by_term_from_stored(terms_taught), term)


def latest_rating_before(entries: Optional[Iterable[Dict[str, Any]]], term: TermKey) -> Optional[float]:
    """The latest 1-5 rating logged for a term before `term`, or None. Entries are {semester, scale,
    value}; a percentage or a 'none' entry never counts, nor does a value outside 1-5, nor a rating of
    the term itself or later."""
    best: Optional[Tuple[TermKey, float]] = None
    for entry in entries or []:
        if not isinstance(entry, dict) or str(entry.get("scale") or "") != RATING_SCALE:
            continue
        try:
            when = term_key(entry.get("semester"))
            value = float(entry.get("value"))
        except (TypeError, ValueError):
            continue
        if not (1.0 <= value <= 5.0) or when >= tuple(term):
            continue
        if best is None or when > best[0]:
            best = (when, value)
    return None if best is None else best[1]


def rating_or_none(value: Any) -> Optional[float]:
    """The stored rating as the live service reads it: a 1.00-5.00 number, or None for 0, an empty value
    or anything outside the scale ("no CCS evaluation yet")."""
    if isinstance(value, dict):
        value = value.get("average")
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or not (1.0 <= number <= 5.0):
        return None
    return number


def impute_ratings(ratings: Sequence[Optional[float]], fallback: float) -> Tuple[List[float], List[int], float]:
    """A missing rating becomes the median of the ratings present among the candidates (one value per
    candidate); when none is present, `fallback`. Returns (imputed values, missing flags, the median used)."""
    present = [r for r in ratings if r is not None]
    median = float(statistics.median(present)) if present else float(fallback)
    values = [median if r is None else float(r) for r in ratings]
    flags = [1 if r is None else 0 for r in ratings]
    return values, flags, median
