"""Builds the ranking dataset from the 4 past semesters of Teachers' Programs (Phase 5, Step 1).

Run from ../intellisched_backend with its .venv:
    .venv/Scripts/python ml/build_dataset.py [--data-dir ../IntelliSched/docs/data] [--out-dir ../IntelliSched/docs/ml]
                                            [--no-private]

Reads (from --data-dir):
    past_class_blocks.csv, past_faculty_loads.csv       the 4 transcribed semesters (public)
    intellisched_seed_data.json                         the catalog and the curriculum mappings (public)
    term_2nd_sem_AY2026_27.json                         the Major/Minor text per professor (public)
    faculty_data.json                                   specializations and certifications (PRIVATE, gitignored)
    faculty_data.ratings_history.json                   the logged SET ratings (PRIVATE, gitignored)
Without the private files (or with --no-private) the profiles come from the seed's faculty_draft and every
rating is missing.

Writes (under --out-dir):
    private/dataset_full.csv     every column, ratings included: gitignored, never committed
    dataset_public.csv           the same rows without the rating columns
    subject_mapping.csv          every printed (code, title) and the catalog subject it became, with the score
    DATASET_CARD.md              the counts, the exclusions and the feature definitions

A ranking question is one (term, section, Major subject) the CCS taught; the candidates are every
professor with at least one undergraduate CCS class in that term; the label is 1 for the professor who
taught it (the one with more hours when the lecture and the lab differ). Every feature is computed as of
the term: nothing from that term or later. The script prints counts and names only, never a rating.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ml.features import (FEATURES, TeachingHistory, TermKey, impute_ratings, latest_rating_before,  # noqa: E402
                         profile_text, semantic_similarity, term_key, term_label)

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = BACKEND_DIR.parent / "IntelliSched" / "docs" / "data"
DEFAULT_OUT_DIR = BACKEND_DIR.parent / "IntelliSched" / "docs" / "ml"

CLASS_KINDS = ("LEC", "LAB", "UNSPECIFIED")
PROGRAMS = ("BSIT", "BSCS")
# A fuzzy title match below this ratio is no match (difflib ratio on the normalised titles).
FUZZY_MIN = 0.80
# Engine 2's neutral rating, used only when no candidate of a term has a rating.
NEUTRAL_RATING = 4.0
# Ratings are reported as group statistics only, and a mean only over at least this many professors.
MIN_GROUP = 5

# Section labels the transcription could not parse; the curriculum they belong to (program, year, letter, track).
SECTION_FIXES: Dict[str, Tuple[str, int, str, str]] = {
    "BSIT SMP": ("BSIT", 3, "", "SMP"),  # 2nd Sem AY 2025-26, ITST 304 (an SMP track subject of the 3rd year)
}

RATING_COLUMNS = ("eval_rating", "eval_rating_raw", "eval_missing")
COLUMNS = [
    "term", "term_index", "semester_type", "question_id", "section", "program", "year", "track",
    "subject_key", "subject_code", "subject_title", "candidate", "label", "n_candidates",
    *FEATURES, "eval_rating_raw", "legacy_prep_count", "legacy_ancillary_hours",
]


@dataclass(frozen=True)
class Subject:
    key: str
    code: str
    title: str
    type: str
    is_practicum: bool
    description: str
    track: str = ""


@dataclass
class Sources:
    blocks: List[Dict[str, Any]]
    loads: List[Dict[str, Any]]
    catalog: List[Dict[str, Any]]
    mappings: List[Dict[str, Any]]
    profiles: Dict[str, Dict[str, Any]] = field(default_factory=dict)   # by professor name
    fallback_profiles: Dict[str, Dict[str, Any]] = field(default_factory=dict)  # the seed draft, for an empty profile
    ratings_history: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)  # by professor name
    major_minor: Dict[str, str] = field(default_factory=dict)           # by professor name
    profile_source: str = "none"
    ratings_source: str = "none"


@dataclass
class BuildResult:
    rows: List[Dict[str, Any]]
    mapping: List[Dict[str, Any]]
    card: Dict[str, Any]


# ----------------------------------------------------------------------------- text helpers
TRACK_SUFFIX = re.compile(r"\(\s*[A-Za-z]{2,4}\s*\d{3}\s*\)")  # "(WMA 304)", "(IS 103)": the catalog's track suffixes


def normalise_title(text: str) -> str:
    text = TRACK_SUFFIX.sub(" ", str(text or "")).lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalise_code(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").upper().strip())


def year_of(label: str) -> int:
    match = re.match(r"^\s*(\d)", str(label or ""))
    if match:
        return int(match.group(1))
    raise ValueError(f"not a year level: {label!r}")


def semester_type_of(label: str) -> int:
    return 2 if re.match(r"^\s*2", str(label or "")) else 1


def section_code(program: str, year: int, letter: str, track: str) -> str:
    code = f"{program} {year}{letter}"
    return f"{code} {track}" if track else code


def surname_matches(key: str, name: str) -> bool:
    """The surname key of the CSV ('Faculty') against a full name ('Morris Virtus Faculty')."""
    words = re.sub(r"[^A-Za-z ]", " ", str(name or "")).lower().split()
    return str(key or "").lower() in words


# ----------------------------------------------------------------------------- the catalog
def build_catalog(catalog_rows: Sequence[Dict[str, Any]]) -> Dict[str, Subject]:
    subjects: Dict[str, Subject] = {}
    for row in catalog_rows:
        key = str(row.get("seedKey") or row.get("subjectCode"))
        subjects[key] = Subject(
            key=key,
            code=normalise_code(row.get("subjectCode")),
            title=str(row.get("descriptiveTitle") or "").strip(),
            type=str(row.get("type") or "").strip(),
            is_practicum=bool(row.get("isPracticum")),
            description=str(row.get("subjectDescription") or "").strip(),
            track=str(row.get("track") or "").strip(),
        )
    return subjects


def build_curriculum(mappings: Sequence[Dict[str, Any]], subjects: Dict[str, Subject]
                     ) -> Dict[Tuple[str, int, int, str], List[Subject]]:
    """(program, year, semester type, 'CORE' | track) -> the subjects mapped there."""
    out: Dict[Tuple[str, int, int, str], List[Subject]] = defaultdict(list)
    for m in mappings:
        subject = subjects.get(str(m.get("subjectSeedKey")))
        if subject is None:
            continue
        key = (str(m["program"]), year_of(m["yearLevel"]), semester_type_of(m["semester"]), str(m.get("track") or "CORE"))
        if subject not in out[key]:
            out[key].append(subject)
    return out


def curriculum_for(curriculum: Dict[Tuple[str, int, int, str], List[Subject]], program: str, year: int,
                   semester_type: int, track: str) -> List[Subject]:
    """The section's subjects for that semester: the CORE mappings plus its own track's. A BSCS section's
    track mappings are 'IS' (every BSCS section is on that track)."""
    subjects = list(curriculum.get((program, year, semester_type, "CORE"), []))
    mapping_track = "IS" if program == "BSCS" else track
    if mapping_track:
        for s in curriculum.get((program, year, semester_type, mapping_track), []):
            if s not in subjects:
                subjects.append(s)
    return subjects


def match_subject(code: str, title: str, candidates: Sequence[Subject]) -> Tuple[Optional[Subject], float, str]:
    """The catalog subject a printed (code, title) means, within the section's curriculum: an exact
    normalised title ('exact', 1.0); else the closest title at or above FUZZY_MIN ('fuzzy', the ratio);
    else, when the printed code is the code of exactly one subject of the curriculum, that subject
    ('code', the title ratio: an abbreviated or reworded title such as "QMMS" or "Discrete Structure");
    else no match ('unmatched', the best ratio). Two subjects with the same title (ITEC 306 and the SMP
    track's ITST 306 both read 'Applications Development and Emerging Technologies') are told apart by the
    printed code; when the code helps neither, the first in curriculum order is taken ('exact-ambiguous')."""
    wanted = normalise_title(title)
    if not candidates:
        return None, 0.0, "unmatched"
    exact = [s for s in candidates if normalise_title(s.title) == wanted] if wanted else []
    if len(exact) == 1:
        return exact[0], 1.0, "exact"
    if len(exact) > 1:
        by_code = [s for s in exact if s.code == normalise_code(code)]
        if len(by_code) == 1:
            return by_code[0], 1.0, "exact"
        return exact[0], 1.0, "exact-ambiguous"
    best, best_score = None, 0.0
    for s in candidates:
        score = difflib.SequenceMatcher(None, wanted, normalise_title(s.title)).ratio() if wanted else 0.0
        if score > best_score:
            best, best_score = s, score
    if best is not None and best_score >= FUZZY_MIN:
        return best, round(best_score, 3), "fuzzy"
    by_code = [s for s in candidates if s.code == normalise_code(code)]
    if len(by_code) == 1:
        score = difflib.SequenceMatcher(None, wanted, normalise_title(by_code[0].title)).ratio() if wanted else 0.0
        return by_code[0], round(score, 3), "code"
    return None, round(best_score, 3), "unmatched"


# ----------------------------------------------------------------------------- sections
def section_of(row: Dict[str, Any]) -> Tuple[Optional[Tuple[str, int, str, str]], Optional[str]]:
    """(program, year, letter, track) of a class block, or (None, the reason it has no CCS section)."""
    printed = str(row.get("section_as_printed") or "").strip()
    if printed in SECTION_FIXES:
        return SECTION_FIXES[printed], None
    program = str(row.get("program") or "").strip()
    if program not in PROGRAMS:
        return None, "a section of another college, a petition class or no section"
    try:
        year = int(str(row.get("year") or "").strip())
    except ValueError:
        return None, "a CCS section without a year level"
    letter = str(row.get("letter") or "").strip().upper()
    track = str(row.get("track") or "").strip().upper()
    if program == "BSIT" and year >= 3 and not track:
        return None, "a BSIT 3rd/4th-year section without a track"
    if program == "BSCS":
        track = ""
    return (program, year, letter, track), None


# ----------------------------------------------------------------------------- the build
def build(sources: Sources) -> BuildResult:
    subjects = build_catalog(sources.catalog)
    curriculum = build_curriculum(sources.mappings, subjects)

    exclusions: Dict[str, Counter] = {"blocks": Counter(), "questions": Counter()}
    examples: Dict[str, List[str]] = defaultdict(list)

    def exclude(level: str, reason: str, example: str) -> None:
        exclusions[level][reason] += 1
        if len(examples[reason]) < 5 and example not in examples[reason]:
            examples[reason].append(example)

    # 1. Every class block of a CCS section, with its catalog subject.
    mapping_rows: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    matched: List[Dict[str, Any]] = []
    terms_in_blocks: set = set()
    no_section: Dict[str, Any] = {"graduate": 0, "undergraduate": 0, "undergraduate_examples": []}
    for row in sources.blocks:
        kind = str(row.get("kind") or "").upper()
        if kind not in CLASS_KINDS:
            continue  # duties and OJT coordination are not classes
        if not str(row.get("section_as_printed") or "").strip():
            # A class row printed with no section at all: the graduate weekend batches, and a few
            # undergraduate blocks the form left blank. Counted for the card, never a question.
            level = "graduate" if str(row.get("level") or "").upper() == "GRADUATE" else "undergraduate"
            no_section[level] += 1
            if level == "undergraduate" and len(no_section["undergraduate_examples"]) < 5:
                no_section["undergraduate_examples"].append(f"{row['semester']}: {row.get('faculty')} {row.get('code')} {row.get('title')}")
            continue
        term = term_key(row["semester"])
        terms_in_blocks.add(term)
        if str(row.get("level") or "UNDERGRAD").upper() != "UNDERGRAD":
            exclude("blocks", "a graduate class", f"{row['semester']}: {row.get('code')} {row.get('title')}")
            continue
        section, reason = section_of(row)
        if section is None:
            exclude("blocks", reason, f"{row['semester']}: {row.get('section_as_printed')} ({row.get('code')} {row.get('title')})")
            continue
        program, year, letter, track = section
        pool = curriculum_for(curriculum, program, year, term[1], track)
        subject, score, how = match_subject(row.get("code"), row.get("title"), pool)
        mkey = (program, year, term[1], track, normalise_code(row.get("code")), str(row.get("title") or "").strip())
        entry = mapping_rows.setdefault(mkey, {
            "program": program, "year": year, "semester_type": term[1], "track": track or ("IS" if program == "BSCS" else ""),
            "printed_code": mkey[4], "printed_title": mkey[5],
            "subject_key": subject.key if subject else "", "subject_code": subject.code if subject else "",
            "subject_title": subject.title if subject else "", "subject_type": subject.type if subject else "",
            "match": how, "score": score, "blocks": 0, "terms": set(),
        })
        entry["blocks"] += 1
        entry["terms"].add(term)
        if subject is None:
            exclude("blocks", "no subject of this title in the section's curriculum",
                    f"{row['semester']}: {section_code(*section)} {row.get('code')} {row.get('title')}")
            continue
        matched.append({
            "term": term, "section": section, "subject": subject, "professor": str(row["faculty"]).strip(),
            "hours": float(row.get("hours") or 0), "kind": kind,
            "label": f"{row['semester']}: {section_code(*section)} {subject.code}",
        })

    # 2. A block printed without the section letter ("BSIT III AMG") in a term where one lettered section
    #    of that year and track exists ("BSIT IIIA AMG") is the same section written two ways: it joins it.
    #    With two or more lettered sections (IIIA and IIIB WMAD) the block cannot be placed: left out.
    lettered = defaultdict(set)
    for b in matched:
        program, year, letter, track = b["section"]
        if letter:
            lettered[(b["term"], program, year, track)].add(letter)
    kept: List[Dict[str, Any]] = []
    merged = 0
    for b in matched:
        program, year, letter, track = b["section"]
        letters = lettered.get((b["term"], program, year, track), set())
        if not letter and len(letters) == 1:
            b["section"] = (program, year, next(iter(letters)), track)
            b["label"] = f"{term_label(b['term'])}: {section_code(*b['section'])} {b['subject'].code}"
            merged += 1
        elif not letter and len(letters) > 1:
            exclude("blocks", "the section letter is missing while two or more lettered sections of that year and track exist", b["label"])
            continue
        kept.append(b)
    matched = kept

    # 3. The teaching history (every matched class, Majors and Minors alike) and the candidates per term.
    history = TeachingHistory()
    for b in matched:
        history.add(b["professor"], b["subject"].key, b["section"][0], b["term"], section=b["section"])
    in_loads: Dict[TermKey, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    for row in sources.loads:
        in_loads[term_key(row["sem"])][str(row["fac"]).strip()] = row
    taught_ccs: Dict[TermKey, set] = defaultdict(set)
    for b in matched:
        taught_ccs[b["term"]].add(b["professor"])
    terms = sorted(terms_in_blocks)
    candidates: Dict[TermKey, List[str]] = {}
    loads_only: Dict[TermKey, List[str]] = {}
    for term in terms:
        candidates[term] = sorted(p for p in in_loads.get(term, {}) if p in taught_ccs[term])
        loads_only[term] = sorted(p for p in in_loads.get(term, {}) if p not in taught_ccs[term])

    # 4. The questions: (term, section, Major subject) -> who taught it (the most hours).
    by_question: Dict[Tuple[TermKey, Tuple[str, int, str, str], str], List[Dict[str, Any]]] = defaultdict(list)
    for b in matched:
        subject = b["subject"]
        if subject.is_practicum:
            exclude("blocks", "a practicum (OJT) class", b["label"])
            continue
        if subject.type != "Major":
            exclude("blocks", "a Minor, GenEd or NSTP class", b["label"])
            continue
        by_question[(b["term"], b["section"], subject.key)].append(b)

    # 5. The professors' facts per term: profile, rating before the term, employment, the old model's inputs.
    name_of: Dict[str, Optional[str]] = {}
    all_keys = sorted({str(r["fac"]).strip() for r in sources.loads} | {b["professor"] for b in matched})
    names = list(sources.profiles.keys())
    for key in all_keys:
        hits = [n for n in names if surname_matches(key, n)]
        name_of[key] = hits[0] if len(hits) == 1 else None
    fallback_names = list(sources.fallback_profiles.keys())
    used_fallback: List[str] = []

    def profile_of(key: str) -> str:
        name = name_of.get(key)
        text = ""
        if name:
            prof = sources.profiles.get(name, {})
            major = sources.major_minor.get(name) or prof.get("major") or ""
            text = profile_text(major, prof.get("specializations"), prof.get("certifications"))
        if not text:
            hits = [n for n in fallback_names if surname_matches(key, n)]
            if len(hits) == 1:
                draft = sources.fallback_profiles[hits[0]]
                text = profile_text(sources.major_minor.get(hits[0]), draft.get("specializations"), draft.get("certifications"))
                if text and key not in used_fallback:
                    used_fallback.append(key)
        return text

    without_profile = sorted(k for k in all_keys if not profile_of(k))

    def latest_load_before(key: str, term: TermKey) -> Optional[Tuple[TermKey, Dict[str, Any]]]:
        earlier = [(t, rows[key]) for t, rows in in_loads.items() if t < term and key in rows]
        return max(earlier, key=lambda pair: pair[0]) if earlier else None

    facts: Dict[Tuple[TermKey, str], Dict[str, Any]] = {}
    rating_groups: Dict[TermKey, Dict[str, Any]] = {}
    for term in terms:
        raw_ratings = []
        for key in candidates[term]:
            name = name_of.get(key)
            raw_ratings.append(latest_rating_before(sources.ratings_history.get(name) if name else None, term))
        imputed, missing, median = impute_ratings(raw_ratings, NEUTRAL_RATING)
        present = [r for r in raw_ratings if r is not None]
        rating_groups[term] = {
            "candidates": len(candidates[term]), "rated": len(present), "missing": len(candidates[term]) - len(present),
            "mean": round(statistics.mean(present), 2) if len(present) >= MIN_GROUP else None,
            "median_used_for_missing": round(median, 2) if len(present) >= MIN_GROUP else None,
        }
        for key, raw, value, flag in zip(candidates[term], raw_ratings, imputed, missing):
            load = in_loads[term][key]
            earlier = latest_load_before(key, term)
            prep = 0
            ancillary = 0.0
            if earlier is not None:
                earlier_term, earlier_row = earlier
                prep = len({b["subject"].key for b in matched if b["professor"] == key and b["term"] == earlier_term})
                try:
                    ancillary = float(earlier_row.get("ancillary") or 0)
                except ValueError:
                    ancillary = 0.0
            facts[(term, key)] = {
                "profile": profile_of(key),
                "eval_rating": round(value, 2), "eval_rating_raw": raw, "eval_missing": flag,
                "is_full_time": int(str(load.get("emp") or "").upper() == "FULL_TIME"),
                "legacy_prep_count": prep, "legacy_ancillary_hours": ancillary,
            }

    # 6. The rows.
    rows: List[Dict[str, Any]] = []
    ties = 0
    questions_per_term: Counter = Counter()
    sections_per_term: Dict[TermKey, set] = defaultdict(set)
    subjects_per_term: Dict[TermKey, set] = defaultdict(set)
    term_index = {t: i + 1 for i, t in enumerate(terms)}
    for (term, section, subject_key), blocks in sorted(by_question.items(), key=lambda kv: (kv[0][0], section_code(*kv[0][1]), kv[0][2])):
        subject = blocks[0]["subject"]
        hours: Dict[str, float] = defaultdict(float)
        lecture: Dict[str, float] = defaultdict(float)
        for b in blocks:
            hours[b["professor"]] += b["hours"]
            if b["kind"] == "LEC":
                lecture[b["professor"]] += b["hours"]
        top = max(hours.values())
        leaders = sorted(p for p, h in hours.items() if h == top)
        if len(leaders) > 1:
            ties += 1
            with_lecture = [p for p in leaders if lecture.get(p, 0) > 0]
            leaders = with_lecture or leaders
        teacher = leaders[0]
        pool = candidates[term]
        if teacher not in pool:
            exclude("questions", "the professor who taught it is not a candidate of the term", blocks[0]["label"])
            continue
        program, year, letter, track = section
        query = f"{subject.title} {subject.description}".strip()
        scores = semantic_similarity(query, [facts[(term, p)]["profile"] for p in pool])
        question_id = f"{term_label(term)}|{section_code(*section)}|{subject.key}"
        questions_per_term[term] += 1
        sections_per_term[term].add(section_code(*section))
        subjects_per_term[term].add(subject.key)
        for p, score in zip(pool, scores):
            f = facts[(term, p)]
            rows.append({
                "term": term_label(term), "term_index": term_index[term], "semester_type": term[1],
                "question_id": question_id, "section": section_code(*section), "program": program, "year": year,
                "track": track or ("IS" if program == "BSCS" else ""),
                "subject_key": subject.key, "subject_code": subject.code, "subject_title": subject.title,
                "candidate": p, "label": int(p == teacher), "n_candidates": len(pool),
                "semantic_match": round(score, 6),
                **history.subject_features(p, subject.key, term),
                "eval_rating": f["eval_rating"], "eval_missing": f["eval_missing"],
                "is_full_time": f["is_full_time"],
                "program_experience": history.program_experience(p, program, term),
                "eval_rating_raw": "" if f["eval_rating_raw"] is None else f["eval_rating_raw"],
                "legacy_prep_count": f["legacy_prep_count"], "legacy_ancillary_hours": f["legacy_ancillary_hours"],
            })

    mapping = sorted(mapping_rows.values(), key=lambda m: (m["match"] != "exact", m["program"], m["year"], m["semester_type"], m["printed_code"], m["printed_title"]))
    for m in mapping:
        m["terms"] = "; ".join(term_label(t) for t in sorted(m["terms"]))

    # The teaching history the term loader writes into each professor's record (Step 3): per surname key,
    # the catalog subjects taught (Majors and Minors alike) with their terms, and the programs with theirs.
    teaching_history: Dict[str, Dict[str, Any]] = {}
    for b in matched:
        entry = teaching_history.setdefault(b["professor"], {"subjects": {}, "programs": {}})
        s = entry["subjects"].setdefault(b["subject"].key, {"seedKey": b["subject"].key, "subjectCode": b["subject"].code,
                                                             "descriptiveTitle": b["subject"].title, "terms": defaultdict(set)})
        s["terms"][b["term"]].add(b["section"])
        entry["programs"].setdefault(b["section"][0], set()).add(b["term"])
    history_out = {}
    for key in sorted(teaching_history):
        entry = teaching_history[key]
        history_out[key] = {
            # Phase 8 Part 11: each term with the number of sections of the subject the professor taught in it.
            "subjects": [{**s, "terms": [{"term": term_label(t), "sections": len(s["terms"][t])} for t in sorted(s["terms"])]}
                         for _, s in sorted(entry["subjects"].items())],
            "programs": [{"program": p, "terms": [term_label(t) for t in sorted(ts)]} for p, ts in sorted(entry["programs"].items())],
        }

    card = {
        "terms": [{
            "term": term_label(t), "index": term_index[t], "questions": questions_per_term[t],
            "candidates": len(candidates[t]), "rows": questions_per_term[t] * len(candidates[t]),
            "positives": questions_per_term[t], "sections": len(sections_per_term[t]), "subjects": len(subjects_per_term[t]),
            "candidate_keys": candidates[t], "in_loads_without_a_ccs_class": loads_only[t],
            "ratings": rating_groups[t],
        } for t in terms],
        "rows": len(rows), "questions": sum(questions_per_term.values()), "ties": ties,
        "exclusions_blocks": dict(exclusions["blocks"]), "exclusions_questions": dict(exclusions["questions"]),
        "examples": dict(examples),
        "mapping_counts": dict(Counter(m["match"] for m in mapping)),
        "mapping_blocks": dict(Counter({how: sum(m["blocks"] for m in mapping if m["match"] == how) for how in {m["match"] for m in mapping}})),
        "without_profile": without_profile, "profile_fallback_keys": sorted(used_fallback),
        "profile_source": sources.profile_source, "ratings_source": sources.ratings_source,
        "class_blocks_read": sum(1 for r in sources.blocks if str(r.get("section_as_printed") or "").strip() and str(r.get("kind") or "").upper() in CLASS_KINDS),
        "no_section": no_section,
        "matched_blocks": len(matched), "merged_unlettered_blocks": merged,
        "section_fixes": {k: section_code(*v) for k, v in SECTION_FIXES.items()},
        "fuzzy_min": FUZZY_MIN, "neutral_rating": NEUTRAL_RATING,
        "teaching_history": {"terms": [term_label(t) for t in terms], "professors": history_out},
    }
    return BuildResult(rows=rows, mapping=mapping, card=card)


# ----------------------------------------------------------------------------- files
def read_csv(path: Path) -> List[Dict[str, Any]]:
    with path.open(encoding="utf-8", newline="") as fh:
        return list(csv.DictReader(fh))


def read_sources(data_dir: Path, use_private: bool = True) -> Sources:
    data_dir = Path(data_dir)
    seed = json.loads((data_dir / "intellisched_seed_data.json").read_text(encoding="utf-8"))
    sources = Sources(
        blocks=read_csv(data_dir / "past_class_blocks.csv"),
        loads=read_csv(data_dir / "past_faculty_loads.csv"),
        catalog=seed["catalog"], mappings=seed["mappings"],
    )
    term_file = data_dir / "term_2nd_sem_AY2026_27.json"
    if term_file.exists():
        term = json.loads(term_file.read_text(encoding="utf-8"))
        sources.major_minor = {str(f.get("name")): str(f.get("majorMinorOnTeachersProgram") or "")
                               for f in term.get("faculty", []) if f.get("name")}
    draft_profiles = {str(f["displayName"]): {"specializations": f.get("specializations") or [], "certifications": []}
                      for f in seed.get("faculty_draft", []) if f.get("displayName")}
    private_profiles = data_dir / "faculty_data.json"
    if use_private and private_profiles.exists():
        data = json.loads(private_profiles.read_text(encoding="utf-8"))
        sources.profiles = {str(f["name"]): {"specializations": f.get("specializations") or [],
                                             "certifications": f.get("certifications") or []}
                            for f in data.get("faculty", []) if f.get("name")}
        sources.profile_source = "faculty_data.json (private)"
        # A professor whose private record lists no specialization and no certification (the former
        # faculty) takes the seed draft's specializations when it has any (build() does the lookup).
        sources.fallback_profiles = draft_profiles
    else:
        sources.profiles = draft_profiles
        sources.profile_source = "intellisched_seed_data.json faculty_draft (public fallback)"
    private_history = data_dir / "faculty_data.ratings_history.json"
    if use_private and private_history.exists():
        data = json.loads(private_history.read_text(encoding="utf-8"))
        sources.ratings_history = {str(k): list(v) for k, v in (data.get("history") or {}).items()}
        sources.ratings_source = "faculty_data.ratings_history.json (private)"
    else:
        sources.ratings_source = "none (every rating missing)"
    # The Major/Minor text is keyed by the term file's names; the profile names may differ slightly, so
    # match them by surname-and-initials-insensitive comparison: same normalised words.
    if sources.major_minor and sources.profiles:
        def words(n: str) -> frozenset:
            return frozenset(w for w in re.sub(r"[^A-Za-z ]", " ", n).lower().split() if len(w) > 1 and w not in {"phd", "jr", "mit", "dit", "edd", "msit", "mscs", "maed", "mpa"})
        by_words = {words(n): mm for n, mm in sources.major_minor.items()}
        for name in list(sources.profiles):
            if name not in sources.major_minor:
                hit = by_words.get(words(name))
                if hit:
                    sources.major_minor[name] = hit
    return sources


def write_csv(path: Path, rows: Sequence[Dict[str, Any]], columns: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(columns), lineterminator="\n", extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def public_rows(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{k: v for k, v in row.items() if k not in RATING_COLUMNS} for row in rows]


def feature_definitions() -> List[Tuple[str, str]]:
    return [
        ("semantic_match", "Engine 1's score (TF-IDF with English stop words, cosine similarity, 0-1) between the subject's title and description and the professor's profile: the Major/Minor text, the specializations and the certifications. The TF-IDF is fitted on the query and the term's candidates' profiles, so the score is relative to the term's candidates (as the live service fits it on the active roster). The profile is the Aug 2026 one for every term (a stated limitation). Past subjects are not in the profile."),
        ("semesters_taught", "The number of earlier terms (in the 4-term history) in which the professor taught this catalog subject to any CCS section. A subject taught to two sections in one term counts once. (Phase 5 called it times_taught_before.)"),
        ("sections_taught", "The number of earlier class sections of this subject the professor taught, counted per section per term (two sections in one term count 2; the lecture and the lab of one section count 1)."),
        ("terms_since_last_taught", "How many terms before this one the professor last taught the subject (1 = the term just before; the 1st and 2nd semesters are consecutive terms); 99 when never in the history."),
        ("taught_it_last_same_semester", "1 when the professor taught this subject in the same semester type of the previous academic year (for 2nd Sem AY 2025-26: 2nd Sem AY 2024-25); 0 otherwise, also when that term is not in the history."),
        ("eval_rating", "The latest SET rating on the 1-5 scale logged for a term before this one. A missing rating (no entry, or only percentages) becomes the median of the ratings present among the term's candidates (one value per professor); when no candidate has one, 4.0."),
        ("eval_missing", "1 when the rating was missing and imputed; 0 when it was logged."),
        ("is_full_time", "1 when the professor's Teachers' Program of the term says full-time (the employment contract of the term, known before the assignment); 0 for part-time."),
        ("program_experience", "The number of earlier terms with at least one CCS class for the question's program (BSIT or BSCS)."),
    ]


def write_card(path: Path, card: Dict[str, Any], out_dir: Path) -> None:
    L: List[str] = []
    L.append("# Dataset card: the ranking examples from 4 semesters of Teachers' Programs")
    L.append("")
    L.append("Built by `../intellisched_backend/ml/build_dataset.py` (Phase 5, Step 1) from `docs/data/past_class_blocks.csv`, "
             "`past_faculty_loads.csv`, `intellisched_seed_data.json` (the catalog and the curriculum mappings), "
             f"`term_2nd_sem_AY2026_27.json` (the Major/Minor text), the profiles from **{card['profile_source']}** and the ratings from **{card['ratings_source']}**. "
             "This card holds counts and surname keys only; no rating of any person.")
    L.append("")
    L.append("## What one row is")
    L.append("A **question** is one (term, section, Major subject) the CCS taught. Its **candidates** are every professor with at least one undergraduate CCS class in that term "
             "(a row of `past_faculty_loads.csv` with at least one class block for a BSIT or BSCS section). **One row = one (question, candidate)**; `label` is 1 for the professor who taught it "
             "(when the lecture and the lab had different professors, the one with more hours; a tie goes to the lecture's professor) and 0 for the other candidates. "
             "Every feature is computed **as of the term**: only earlier terms and ratings logged before the term count. Minors, GenEd, NSTP and practicum classes are not questions, "
             "but every matched class (Major or Minor) counts in the teaching history.")
    L.append("")
    L.append("## The counts")
    L.append("")
    L.append("| Term | Questions | Candidates | Rows (= questions × candidates) | Positives | Sections | Subjects |")
    L.append("|---|---|---|---|---|---|---|")
    for t in card["terms"]:
        L.append(f"| {t['term']} | {t['questions']} | {t['candidates']} | {t['rows']} | {t['positives']} | {t['sections']} | {t['subjects']} |")
    L.append(f"| **All** | **{card['questions']}** | | **{card['rows']}** | **{card['questions']}** | | |")
    L.append("")
    L.append(f"Class blocks read (a CCS or other section, kinds LEC / LAB / UNSPECIFIED): {card['class_blocks_read']}; matched to a catalog subject of a CCS section's curriculum: {card['matched_blocks']}, "
             f"of which {card['merged_unlettered_blocks']} were printed without the section letter in a term with exactly one lettered section of that year and track (\"BSIT III AMG\" and \"BSIT IIIA AMG\" are the same section) and joined it. "
             f"Questions where two professors had the same hours (the lecture's professor labelled): {card['ties']}.")
    ns = card.get("no_section") or {}
    if ns:
        L.append("")
        L.append(f"Class rows printed with no section at all were not read: {ns.get('graduate', 0)} graduate classes (the weekend batches) and {ns.get('undergraduate', 0)} undergraduate blocks"
                 + (f" ({'; '.join(ns.get('undergraduate_examples', []))})" if ns.get("undergraduate_examples") else "") + ".")
    L.append("")
    L.append("### The candidates of each term")
    for t in card["terms"]:
        extra = f"; in `past_faculty_loads.csv` without a CCS class block, so not candidates: {', '.join(t['in_loads_without_a_ccs_class'])}" if t["in_loads_without_a_ccs_class"] else ""
        L.append(f"- **{t['term']}** ({t['candidates']}): {', '.join(t['candidate_keys'])}{extra}.")
    L.append("")
    L.append("## What was left out, and why")
    L.append("")
    L.append("| Reason | Class blocks |")
    L.append("|---|---|")
    for reason, n in sorted(card["exclusions_blocks"].items(), key=lambda kv: -kv[1]):
        L.append(f"| {reason} | {n} |")
    if card["exclusions_questions"]:
        L.append("")
        L.append("| Reason | Questions |")
        L.append("|---|---|")
        for reason, n in card["exclusions_questions"].items():
            L.append(f"| {reason} | {n} |")
    L.append("")
    L.append("Examples (at most five each):")
    for reason, ex in card["examples"].items():
        L.append(f"- *{reason}*: " + "; ".join(ex))
    if card["section_fixes"]:
        L.append("")
        L.append("Section labels the transcription left unparsed and the section they were read as: " + "; ".join(f"\"{k}\" → {v}" for k, v in card["section_fixes"].items()) + ".")
    L.append("")
    L.append("## Subject matching")
    counts = card["mapping_counts"]
    blocks = card["mapping_blocks"]
    L.append(f"Each printed (code, title) was matched **by title** to the subjects of the section's curriculum for that semester (the CORE mappings plus the section's track; every BSCS section is on the IS track), "
             f"because the forms' codes have typos. Distinct printed pairs: exact title {counts.get('exact', 0)} ({blocks.get('exact', 0)} blocks), "
             f"exact title told apart by the printed code or curriculum order {counts.get('exact-ambiguous', 0)} ({blocks.get('exact-ambiguous', 0)} blocks), "
             f"fuzzy title at ratio ≥ {card['fuzzy_min']} {counts.get('fuzzy', 0)} ({blocks.get('fuzzy', 0)} blocks), "
             f"by the printed code when the title matched nothing but the code names exactly one subject of the curriculum {counts.get('code', 0)} ({blocks.get('code', 0)} blocks), "
             f"unmatched {counts.get('unmatched', 0)} ({blocks.get('unmatched', 0)} blocks). The catalog's track suffixes (\"(WMA 304)\") are ignored when comparing titles. "
             f"The whole table, with the score of every match, is `subject_mapping.csv`; the non-exact rows are the report's appendix.")
    L.append("")
    L.append("## Ratings, as group statistics only")
    L.append("")
    L.append(f"| Term | Candidates | With a 1-5 rating logged before the term | Missing (imputed) | Mean of the ratings present | Median used for the missing |")
    L.append("|---|---|---|---|---|---|")
    for t in card["terms"]:
        r = t["ratings"]
        mean = f"{r['mean']:.2f}" if r["mean"] is not None else f"not shown (fewer than {MIN_GROUP} rated)"
        med = f"{r['median_used_for_missing']:.2f}" if r["median_used_for_missing"] is not None else f"not shown (fewer than {MIN_GROUP} rated)"
        L.append(f"| {t['term']} | {r['candidates']} | {r['rated']} | {r['missing']} | {mean} | {med} |")
    L.append("")
    L.append(f"A percentage rating never counts (the scale changed in 2nd Sem AY 2025-26). When no candidate of a term has a rating, the missing ones take {card['neutral_rating']:.1f} (Engine 2's neutral value).")
    if card.get("profile_fallback_keys"):
        L.append("")
        L.append("Professors whose record in the profile source lists no specialization and no certification, so the seed's `faculty_draft` specializations were used instead: " + ", ".join(card["profile_fallback_keys"]) + ".")
    if card["without_profile"]:
        L.append("")
        L.append("Professors with no profile in any source (an empty profile, so `semantic_match` 0): " + ", ".join(card["without_profile"]) + ".")
    L.append("")
    L.append("## The features")
    L.append("")
    L.append("| Feature | Definition |")
    L.append("|---|---|")
    for name, definition in feature_definitions():
        L.append(f"| `{name}` | {definition} |")
    L.append("")
    L.append("Two more columns serve only the **old model's baseline** (`legacy_prep_count`, `legacy_ancillary_hours`): the number of distinct subjects the professor taught and the ancillary hours on the most recent earlier Teachers' Program (0 when there is none). "
             "They approximate, as of the term, the `prep_count` and `ancillary_load` inputs the shipped Engine 2 reads at request time; the new model does not use them.")
    L.append("")
    L.append("## Files")
    L.append("")
    L.append(f"- `private/dataset_full.csv` (gitignored): every column: {', '.join(COLUMNS)}.")
    L.append(f"- `dataset_public.csv` (committed): the same rows without {', '.join(f'`{c}`' for c in RATING_COLUMNS)}.")
    L.append("- `subject_mapping.csv` (committed): program, year, semester_type, track, printed_code, printed_title, subject_key, subject_code, subject_title, subject_type, match, score, blocks, terms.")
    L.append("")
    L.append("## Limitations stated")
    L.append("- The specializations and certifications come from the Aug 2026 faculty form, so `semantic_match` uses them for earlier terms too.")
    L.append("- The rating scale changed in 2nd Sem AY 2025-26; only 1-5 ratings count.")
    L.append("- The forms have typos; titles were matched, and the non-exact matches are listed.")
    L.append("- The Dean's choices also reflect things the data does not hold (availability, preferences, load).")
    L.append("- The dataset is small: 4 terms.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def write_teaching_history(path: Path, history: Dict[str, Any], source_csv: Path) -> None:
    """docs/ml/teaching_history.json: what the term loader writes into the faculty records (public data:
    who taught which catalog subject in which term, from the past Teachers' Programs). The loader checks
    the source file's hash and refuses a stale file."""
    import hashlib
    payload = {
        "about": "The teaching history per professor (surname key) from past_class_blocks.csv, matched to the catalog by "
                 "../intellisched_backend/ml/build_dataset.py. The term loader (server/scripts/load-term.js) writes it into each "
                 "professor's teachingHistory and programHistory; Engine 2 reads those at request time. Rebuild with the builder "
                 "whenever past_class_blocks.csv changes.",
        "builtFrom": source_csv.name,
        "sourceSha256": hashlib.sha256(source_csv.read_bytes()).hexdigest() if source_csv.exists() else None,
        "terms": history["terms"],
        "professors": history["professors"],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--no-private", action="store_true", help="ignore the private faculty files even when present")
    args = parser.parse_args(argv)
    data_dir, out_dir = Path(args.data_dir), Path(args.out_dir)

    sources = read_sources(data_dir, use_private=not args.no_private)
    result = build(sources)

    full_path = out_dir / "private" / "dataset_full.csv"
    write_csv(full_path, result.rows, COLUMNS)
    write_csv(out_dir / "dataset_public.csv", public_rows(result.rows), [c for c in COLUMNS if c not in RATING_COLUMNS])
    write_csv(out_dir / "subject_mapping.csv", result.mapping,
              ["program", "year", "semester_type", "track", "printed_code", "printed_title", "subject_key", "subject_code",
               "subject_title", "subject_type", "match", "score", "blocks", "terms"])
    write_card(out_dir / "DATASET_CARD.md", result.card, out_dir)
    write_teaching_history(out_dir / "teaching_history.json", result.card["teaching_history"], data_dir / "past_class_blocks.csv")

    card = result.card
    print(f"Profiles from: {card['profile_source']}; ratings from: {card['ratings_source']}")
    for t in card["terms"]:
        print(f"{t['term']}: {t['questions']} questions x {t['candidates']} candidates = {t['rows']} rows; "
              f"ratings logged before the term: {t['ratings']['rated']} of {t['ratings']['candidates']}")
    print(f"Rows: {card['rows']}; questions: {card['questions']}; ties: {card['ties']}")
    print("Left out (blocks):", card["exclusions_blocks"])
    if card["exclusions_questions"]:
        print("Left out (questions):", card["exclusions_questions"])
    print("Subject matches (distinct printed pairs):", card["mapping_counts"])
    print(f"Wrote {full_path} (gitignored), {out_dir / 'dataset_public.csv'}, {out_dir / 'subject_mapping.csv'}, {out_dir / 'DATASET_CARD.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
