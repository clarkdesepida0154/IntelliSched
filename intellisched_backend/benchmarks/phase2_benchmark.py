"""Phase 2 Step 5: evidence for Chapter 4. Runs Engine 3 directly (no database, no web service) on the
Step 1 full-college test case (IntelliSched/shared/fixtures/full-college-2025-s1.json) and writes

  IntelliSched/docs/benchmarks/phase2/results.csv
  IntelliSched/docs/benchmarks/phase2/PHASE2_BENCHMARK.md

Runs:
  1. baseline against memetic: Scenario A with the extra-room counts Step 3 settled on (the
     pre-flight's weekday suggestion, 2 LAB + 2 LEC), seeds 1-5, 180 s budget each;
  2. scaling: 4, 8, 12, 16 and 20 sections (the 4-section fixture first, then sections added by year
     level), memetic, seeds 1-3, 180 s, each size with its own suggested weekday extra-room counts;
  3. rooms: Scenario A against Scenario B (pre-flight numbers and one memetic run each), and the
     smallest extra-room counts for Scenario A that reach 0 hard violations in 3 seeds (start from
     the weekday suggestion, then +1 of each type; at most 3 settings).
Runs with identical settings are run once and reused (e.g. the 20-section scaling runs are the
memetic runs of 1): such a run is one row whose `run` column lists every use. The whole benchmark is
kept under 60 minutes: when the estimate is over, seeds are cut and the report says so.

    .venv/Scripts/python benchmarks/phase2_benchmark.py            (from intellisched_backend/)
    .venv/Scripts/python benchmarks/phase2_benchmark.py --rewrite  (rebuilds results.csv and the report
                                                                    from the recorded results; no GA run)
The report's "Interpretation" section is written by hand for the recorded run; a rewrite keeps it.
"""
import csv
import ctypes
import json
import os
import platform
import sys
import time
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
from engine3_ga import GeneticScheduler  # noqa: E402

REPO = BACKEND_DIR.parent / "IntelliSched"
FIXTURE = REPO / "shared" / "fixtures" / "full-college-2025-s1.json"
OUT_DIR = REPO / "docs" / "benchmarks" / "phase2"
BUDGET_S = 180
TOTAL_LIMIT_S = 60 * 60

COLUMNS = [
    "run", "scenario", "mode", "seed", "sections", "demands", "extraLab", "extraLec",
    "initialHard", "finalHard", "resolutionRatePct", "timeToFirstFeasibleS", "totalS", "generations", "msPerGeneration", "repairS", "stopReason",
    "softTotal", "SAT_BLOCK", "LEC_IN_LAB", "EXTRA_ROOM", "SECTION_IDLE", "FACULTY_IDLE",
    "saturdayBlocks", "lecturesInLab", "sectionIdleHours", "facultyIdleHours",
    "extraRoomClasses", "extraLabRoomsUsed", "extraLecRoomsUsed",
]


# ---------------------------------------------------------------------------------------------------
# The machine
# ---------------------------------------------------------------------------------------------------
def machine() -> dict:
    ram_gb = None
    if os.name == "nt":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            ram_gb = round(stat.ullTotalPhys / 1024 ** 3, 1)
    cpu = platform.processor() or os.environ.get("PROCESSOR_IDENTIFIER", "unknown")
    try:
        import subprocess
        name = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"], capture_output=True, text=True, timeout=20).stdout.strip()
        cpu = name or cpu
    except Exception:
        pass
    return {"cpu": cpu, "logicalCpus": os.cpu_count(), "ramGb": ram_gb, "os": platform.platform(), "python": platform.python_version()}


# ---------------------------------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------------------------------
def extra_rooms(lab: int, lec: int) -> list:
    """The extra rooms exactly as the gateway's demand builder adds them (gaRequest.extraRoomsOf)."""
    def make(kind, count):
        return [{"roomId": f"EXTRA-{kind}-{k}", "roomName": f"Extra {kind} room {k} (TBA – to request)", "roomType": kind,
                 "capacity": None, "availability": [], "extra": True} for k in range(1, count + 1)]
    return make("LAB", lab) + make("LEC", lec)


def with_rooms(request: dict, lab: int, lec: int) -> dict:
    r = json.loads(json.dumps(request))
    r["rooms"] = [room for room in r["rooms"] if not room.get("extra")] + extra_rooms(lab, lec)
    return r


def subset(request: dict, section_ids: set) -> dict:
    """The request the gateway would build with only these sections active: their demands, and the
    professors who teach them (a section's demands do not depend on the other sections)."""
    r = json.loads(json.dumps(request))
    r["demands"] = [d for d in r["demands"] if d["sectionId"] in section_ids]
    refs = {d["facultyRef"] for d in r["demands"] if d["facultyRef"]}
    r["faculty"] = [f for f in r["faculty"] if f["facultyRef"] in refs]
    return r


# ---------------------------------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------------------------------
_cache = {}


def run(request: dict, *, scenario: str, mode: str, seed: int, sections: int, lab: int, lec: int, label: str) -> dict:
    key = (scenario, mode, seed, sections, lab, lec)
    if key in _cache:
        # The same run used again: one row, whose run column lists every use.
        _cache[key]["run"] = f"{_cache[key]['run']}; {label}"
        return _cache[key]
    started = time.perf_counter()
    result = GeneticScheduler(request, seed=seed, settings={"mode": mode, "timeBudgetSeconds": BUDGET_S}).run_evolution()
    wall = time.perf_counter() - started
    s = result["stats"]
    use = {}
    for item in result["items"]:
        rid = item["roomId"]
        if isinstance(rid, str) and rid.startswith("EXTRA-"):
            use[rid] = use.get(rid, 0) + 1
    hi, hf = s["initialHard"], s["finalHard"]
    row = {
        "run": label, "scenario": scenario, "mode": mode, "seed": seed, "sections": sections, "demands": len(request["demands"]),
        "extraLab": lab, "extraLec": lec,
        "initialHard": hi, "finalHard": hf,
        "resolutionRatePct": round((hi - hf) / hi * 100, 1) if hi else "n/a (0 at start)",
        "timeToFirstFeasibleS": round(s["timeToFirstFeasibleMs"] / 1000, 1) if s["timeToFirstFeasibleMs"] is not None else "not reached",
        "totalS": round(wall, 1), "generations": s["generations"], "msPerGeneration": s["msPerGeneration"],
        "repairS": round(s["repairMs"] / 1000, 1), "stopReason": s["stopReason"],
        "softTotal": s["soft"], **s["softBreakdown"],
        "saturdayBlocks": s["softCounts"]["saturdayBlocks"], "lecturesInLab": s["softCounts"]["lecturesInLab"],
        "sectionIdleHours": s["softCounts"]["sectionIdleHours"], "facultyIdleHours": s["softCounts"]["facultyIdleHours"],
        "extraRoomClasses": sum(use.values()),
        "extraLabRoomsUsed": len([k for k in use if k.startswith("EXTRA-LAB-")]),
        "extraLecRoomsUsed": len([k for k in use if k.startswith("EXTRA-LEC-")]),
    }
    _cache[key] = row
    print(f"  {label}: hard {hi} -> {hf}, first feasible {row['timeToFirstFeasibleS']} s, {row['totalS']} s, {s['generations']} gens, soft {s['soft']}, stop {s['stopReason']}", flush=True)
    return row


def main() -> None:
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    A, B = fx["scenarios"]["A"], fx["scenarios"]["B"]
    settled = A["withSuggestedRooms"]["extraRooms"]            # Step 3: the weekday suggestion (2 + 2)
    assert extra_rooms(settled["lab"], settled["lec"]) == A["withSuggestedRooms"]["extraRoomEntries"], "extra rooms must match the gateway's"
    scaling = fx["scaling"]
    started = time.perf_counter()
    rows = []
    notes = []

    def add(row):
        if all(row is not r for r in rows):
            rows.append(row)
        return row

    # Estimate: the worst case is every run using its whole budget; small sizes finish far sooner.
    seeds_main, seeds_scaling = [1, 2, 3, 4, 5], [1, 2, 3]
    print(f"[benchmark] {len(fx['assignments'])} pairs; Scenario A {len(A['request']['demands'])} demands; settled extra rooms {settled}", flush=True)

    print("[benchmark] 1. baseline against memetic", flush=True)
    full_a = with_rooms(A["request"], settled["lab"], settled["lec"])
    for mode in ("memetic", "baseline"):
        for seed in seeds_main:
            add(run(full_a, scenario="A", mode=mode, seed=seed, sections=20, lab=settled["lab"], lec=settled["lec"], label=f"1 {mode} seed {seed}"))

    print("[benchmark] 2. scaling", flush=True)
    for size in scaling:
        ids = set(size["sectionIds"])
        lab, lec = size["suggestion"]["weekdays"]["lab"], size["suggestion"]["weekdays"]["lec"]
        req = with_rooms(subset(A["request"], ids), lab, lec) if size["sections"] < 20 else full_a
        for seed in seeds_scaling:
            if time.perf_counter() - started > TOTAL_LIMIT_S - 4 * BUDGET_S and seed > 1:
                notes.append(f"Scaling {size['sections']} sections: seed {seed} cut to stay under 60 minutes.")
                continue
            add(run(req, scenario="A", mode="memetic", seed=seed, sections=size["sections"], lab=lab, lec=lec, label=f"2 scaling {size['sections']} sections seed {seed}"))

    print("[benchmark] 3. rooms", flush=True)
    b_rooms = B["withSuggestedRooms"]["extraRooms"]
    add(run(full_a, scenario="A", mode="memetic", seed=1, sections=20, lab=settled["lab"], lec=settled["lec"], label="3 Scenario A"))
    add(run(with_rooms(B["request"], b_rooms["lab"], b_rooms["lec"]), scenario="B", mode="memetic", seed=1, sections=20, lab=b_rooms["lab"], lec=b_rooms["lec"], label="3 Scenario B"))
    smallest = None
    tried = []
    for lab, lec in [(settled["lab"], settled["lec"]), (settled["lab"] + 1, settled["lec"]), (settled["lab"], settled["lec"] + 1)]:
        if len(tried) >= 3 or smallest:
            break
        results = [run(with_rooms(A["request"], lab, lec), scenario="A", mode="memetic", seed=seed, sections=20, lab=lab, lec=lec, label=f"3 smallest {lab}+{lec} seed {seed}") for seed in (1, 2, 3)]
        for r in results:
            add(r)
        ok = all(r["finalHard"] == 0 for r in results)
        tried.append({"lab": lab, "lec": lec, "zeroHardSeeds": sum(r["finalHard"] == 0 for r in results), "ok": ok})
        if ok:
            smallest = {"lab": lab, "lec": lec}

    elapsed = time.perf_counter() - started
    write(fx, rows, machine(), elapsed, notes, smallest, tried, settled, b_rooms, datetime.now())


# ---------------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------------
def write(fx, rows, mach, elapsed, notes, smallest, tried, settled, b_rooms, generated_at) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in COLUMNS})
    (OUT_DIR / "benchmark-summary.json").write_text(json.dumps({
        "machine": mach, "elapsedS": round(elapsed), "notes": notes, "smallest": smallest, "tried": tried,
        "settled": settled, "scenarioBRooms": b_rooms, "generatedAt": generated_at.isoformat(timespec="seconds")
    }, indent=1) + "\n", encoding="utf-8")
    report = OUT_DIR / "PHASE2_BENCHMARK.md"
    kept = kept_interpretation(report)
    report.write_text(markdown(fx, rows, mach, elapsed, notes, smallest, tried, settled, b_rooms, generated_at, kept), encoding="utf-8")
    print(f"[benchmark] wrote results.csv ({len(rows)} rows), PHASE2_BENCHMARK.md and benchmark-summary.json in {round(elapsed)} s", flush=True)


INTERPRETATION_PLACEHOLDER = "(to be written by hand from the numbers above, for this run)"


def kept_interpretation(report: Path):
    """The hand-written Interpretation section of an existing report, if any (kept by a rewrite)."""
    if not report.exists():
        return None
    text = report.read_text(encoding="utf-8")
    marker = "## Interpretation\n"
    if marker not in text:
        return None
    body = text.split(marker, 1)[1].strip()
    return body if body and "written from the numbers above" not in body and body != INTERPRETATION_PLACEHOLDER else None


def _number(value: str):
    try:
        f = float(value)
        return int(f) if f.is_integer() and "." not in value else f
    except (TypeError, ValueError):
        return value


def rewrite() -> None:
    """Rebuilds results.csv (one row per distinct run) and the report from the recorded results."""
    summary = json.loads((OUT_DIR / "benchmark-summary.json").read_text(encoding="utf-8"))
    merged = {}
    with open(OUT_DIR / "results.csv", newline="", encoding="utf-8") as f:
        for raw in csv.DictReader(f):
            row = {k: _number(v) for k, v in raw.items()}
            row["run"] = raw["run"]
            key = tuple(raw[k] for k in ("scenario", "mode", "seed", "sections", "extraLab", "extraLec"))
            if key in merged:
                uses = merged[key]["run"].split("; ")
                merged[key]["run"] = "; ".join(uses + [u for u in raw["run"].split("; ") if u not in uses])
            else:
                merged[key] = row
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    write(fx, list(merged.values()), summary["machine"], summary["elapsedS"], summary["notes"], summary["smallest"], summary["tried"],
          summary["settled"], summary["scenarioBRooms"], datetime.fromisoformat(summary["generatedAt"]))


def _mean(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(sum(values) / len(values), 1) if values else "–"


def _table(headers, lines):
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(str(x) for x in line) + " |" for line in lines]
    return "\n".join(out)


def markdown(fx, rows, mach, elapsed, notes, smallest, tried, settled, b_rooms, generated_at, interpretation=None) -> str:
    """The report's tables and facts. The interpretation section is written from these numbers."""
    by = lambda pred: [r for r in rows if pred(r)]  # noqa: E731
    first = lambda label: next(r for r in rows if label in r["run"])  # noqa: E731
    main_rows = {m: by(lambda r, m=m: r["run"].startswith(f"1 {m}")) for m in ("memetic", "baseline")}
    per_run = lambda r: [r["mode"], r["seed"], r["initialHard"], r["finalHard"], r["resolutionRatePct"], r["timeToFirstFeasibleS"], r["totalS"], r["generations"], r["stopReason"], r["softTotal"], r["extraRoomClasses"]]  # noqa: E731
    lines = []
    lines.append("# Phase 2 benchmark: the GA at college scale")
    lines.append("")
    lines.append(f"Generated by `intellisched_backend/benchmarks/phase2_benchmark.py` on {generated_at.strftime('%Y-%m-%d %H:%M')}; the raw rows are in `results.csv` (one row per run; a run used for more than one comparison lists every use in the `run` column). Engine 3 ran directly on the Step 1 test case (the real 1st Semester AY 2025-2026, 20 sections, the professors who taught them), with no database and no web service. Budget per run: {BUDGET_S} s. Whole benchmark: {round(elapsed / 60, 1)} minutes.")
    lines.append("")
    lines.append(f"**Machine.** {mach['cpu']} ({mach['logicalCpus']} logical CPUs), {mach['ramGb']} GB RAM, {mach['os']}, Python {mach['python']}. One run at a time.")
    lines.append("")
    if notes:
        lines.append("**Cut to stay under 60 minutes:** " + " ".join(notes))
        lines.append("")
    lines.append("## 1. Phase 1 GA (baseline) against the improved GA (memetic)")
    lines.append("")
    lines.append(f"Scenario A (GenEd in CCS rooms), {first('1 memetic seed 1')['demands']} class meetings, the 6 CCS rooms plus {settled['lab']} extra LAB and {settled['lec']} extra LEC rooms (the pre-flight's weekday suggestion), seeds 1–5.")
    lines.append("")
    lines.append(_table(["Mode", "Seed", "Initial H", "Final H", "Resolution %", "First feasible (s)", "Total (s)", "Generations", "Stopped", "Soft", "Classes in extra rooms"],
                        [per_run(r) for r in main_rows["memetic"] + main_rows["baseline"]]))
    lines.append("")
    summary = []
    for m in ("memetic", "baseline"):
        rs = main_rows[m]
        summary.append([m, f"{sum(r['finalHard'] == 0 for r in rs)} / {len(rs)}", _mean([r["finalHard"] for r in rs]), _mean([r["resolutionRatePct"] for r in rs]),
                        _mean([r["timeToFirstFeasibleS"] for r in rs]), _mean([r["totalS"] for r in rs]), _mean([r["msPerGeneration"] for r in rs]), _mean([r["softTotal"] for r in rs])])
    lines.append(_table(["Mode", "Runs with 0 hard", "Mean final H", "Mean resolution %", "Mean first feasible (s, runs that reached it)", "Mean total (s)", "ms per generation", "Mean soft"], summary))
    lines.append("")
    lines.append("## 2. Scaling (memetic)")
    lines.append("")
    scale_lines = []
    for size in fx["scaling"]:
        rs = by(lambda r, n=size["sections"]: f"2 scaling {n} sections" in r["run"])
        scale_lines.append([size["sections"], rs[0]["demands"] if rs else "–", f"{size['suggestion']['weekdays']['lab']} + {size['suggestion']['weekdays']['lec']}",
                            f"{sum(r['finalHard'] == 0 for r in rs)} / {len(rs)}", _mean([r["timeToFirstFeasibleS"] for r in rs]), _mean([r["totalS"] for r in rs]),
                            _mean([r["generations"] for r in rs]), _mean([r["msPerGeneration"] for r in rs]), _mean([r["softTotal"] for r in rs])])
    lines.append(_table(["Sections", "Class meetings", "Extra rooms (LAB + LEC)", "Runs with 0 hard", "Mean first feasible (s)", "Mean total (s)", "Mean generations", "ms per generation", "Mean soft"], scale_lines))
    lines.append("")
    lines.append("Sections per size: " + "; ".join(f"{s['sections']}: {', '.join(s['sectionCodes'])}" for s in fx["scaling"]) + ".")
    lines.append("")
    lines.append("## 3. Rooms")
    lines.append("")
    A, B = fx["scenarios"]["A"]["preflight"], fx["scenarios"]["B"]["preflight"]
    ra, rb = first("3 Scenario A"), first("3 Scenario B")
    lines.append(_table(["", "Scenario A: GenEd in CCS rooms", "Scenario B: GenEd hosted by other departments"], [
        ["Lecture hours needing a room", f"{A['numbers']['lecHoursNeeded']} h", f"{B['numbers']['lecHoursNeeded']} h"],
        ["Three-hour labs", A["numbers"]["labsNeeded"], B["numbers"]["labsNeeded"]],
        ["Pre-flight with the 6 CCS rooms", "refused" if not A["ok"] else "passes", "refused" if not B["ok"] else "passes"],
        ["Smallest extra rooms, weekdays only (LAB + LEC)", f"{A['extraRooms']['suggestion']['weekdays']['lab']} + {A['extraRooms']['suggestion']['weekdays']['lec']}", f"{B['extraRooms']['suggestion']['weekdays']['lab']} + {B['extraRooms']['suggestion']['weekdays']['lec']}"],
        ["Also using Saturday (2nd/3rd years)", f"{A['extraRooms']['suggestion']['withSaturday']['lab']} + {A['extraRooms']['suggestion']['withSaturday']['lec']}", f"{B['extraRooms']['suggestion']['withSaturday']['lab']} + {B['extraRooms']['suggestion']['withSaturday']['lec']}"],
        ["Memetic run, seed 1: final H", ra["finalHard"], rb["finalHard"]],
        ["First feasible (s)", ra["timeToFirstFeasibleS"], rb["timeToFirstFeasibleS"]],
        ["Classes in extra rooms (LAB rooms / LEC rooms used)", f"{ra['extraRoomClasses']} ({ra['extraLabRoomsUsed']} / {ra['extraLecRoomsUsed']})", f"{rb['extraRoomClasses']} ({rb['extraLabRoomsUsed']} / {rb['extraLecRoomsUsed']})"],
        ["Saturday blocks", ra["saturdayBlocks"], rb["saturdayBlocks"]],
        ["Soft total", ra["softTotal"], rb["softTotal"]],
    ]))
    lines.append("")
    lines.append("**Smallest extra-room counts for Scenario A that reach 0 hard violations in 3 seeds** (from the weekday suggestion, then +1 of a type; at most 3 settings):")
    lines.append("")
    lines.append(_table(["Extra LAB", "Extra LEC", "Seeds with 0 hard (of 3)"], [[t["lab"], t["lec"], t["zeroHardSeeds"]] for t in tried]))
    lines.append("")
    lines.append(f"Result: {'**' + str(smallest['lab']) + ' extra LAB + ' + str(smallest['lec']) + ' extra LEC rooms**' if smallest else 'none of the settings tried reached 0 hard violations in all 3 seeds'}.")
    lines.append("")
    lines.append("## Soft terms per run")
    lines.append("")
    lines.append(_table(["Run", "Soft", "Saturday", "Lecture in LAB", "Extra room", "Section idle", "Professor idle", "Saturday blocks", "Lectures in LAB", "Section idle h", "Professor idle h"],
                        [[r["run"], r["softTotal"], r["SAT_BLOCK"], r["LEC_IN_LAB"], r["EXTRA_ROOM"], r["SECTION_IDLE"], r["FACULTY_IDLE"], r["saturdayBlocks"], r["lecturesInLab"], r["sectionIdleHours"], r["facultyIdleHours"]] for r in rows]))
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    lines.append(interpretation or INTERPRETATION_PLACEHOLDER)
    lines.append("")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    rewrite() if "--rewrite" in sys.argv[1:] else main()
