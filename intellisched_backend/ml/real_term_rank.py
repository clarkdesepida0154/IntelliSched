"""Phase 8 Part 11, decision 5: the full ranking of a term's subjects, for the real-term check
(IntelliSched/scripts/demo/real-term-check.js). The same path as the service's /api/get_recommendations
(Engine 1's roster and semantic match, Engine 2's features, model and reason text), but every professor
is returned, with the feature row, instead of the top three.

    MONGO_URI=<a throwaway _test copy> python -m ml.real_term_rank < request.json > answer.json

The request: {"academicYear": "2026-2027", "semester": 2, "subjects": [{subjectId, subjectCode,
subjectTitle, subjectDescription, programs}]}. The answer: {"subjects": [{subjectCode, subjectId,
candidates: [{id, name, rank, score, reason, features}]}]}. It reads only (config.py refuses the live
database). The answer holds the ratings: the caller keeps it in .demo-data/ and never commits it.
"""
from __future__ import annotations

import json
import sys

from engine1_nlp import NLPEngine
from engine2_gbdt import GBDTEngine
from ml.serving import term_from_request


def main() -> int:
    request = json.load(sys.stdin)
    nlp = NLPEngine()
    gbdt = GBDTEngine()
    term = term_from_request(request.get("academicYear"), request.get("semester"))
    out = []
    for subject in request.get("subjects") or []:
        scores = nlp.get_semantic_scores(subject.get("subjectTitle") or "", subject.get("subjectDescription") or "")
        ranked = gbdt.rank_candidates(
            scores, nlp.faculty_roster, {},
            subject={"id": subject.get("subjectId"), "code": subject.get("subjectCode"), "title": subject.get("subjectTitle")},
            term=term, programs=subject.get("programs") or [])
        out.append({
            "subjectCode": subject.get("subjectCode"),
            "subjectId": subject.get("subjectId"),
            "candidates": [{k: r[k] for k in ("id", "name", "rank", "score", "reason", "features")} for r in ranked],
        })
    # The engines print their start-up lines on stdout; the answer is the LAST line.
    sys.stdout.write("\n" + json.dumps({"subjects": out}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
