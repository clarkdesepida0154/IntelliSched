"""Engine 3: the genetic scheduler (Phase 2 Step 3: one GA, two modes).

Modes (settings "mode"):
  memetic   (default) greedy + random initialisation, tournament selection, section-preserving
            crossover, conflict-targeted mutation and repair (local search) inside the GA;
  baseline  the Phase 1 operators, kept only for comparison: random initialisation, parents drawn
            from the best 15, single-point crossover, per-gene re-draw mutation, the best 4 kept.
Both modes use the same fitness (constraints.Evaluator's counting, kept incrementally in occupancy
tables), the same domains (extra rooms included) and the same stop rules: 0 hard violations and no
soft improvement for `stallGenerations` generations, or a perfect schedule (0 hard, 0 soft) that
nothing can improve ("converged"), the time budget ("time-budget"), the generation cap
("generation-cap") or a cancel ("cancelled").

The memetic repair goes beyond single-gene moves in three ways (reported as Phase 2 deviations): a
gene still in a violation may make a sideways move (hard count unchanged, soft may worsen); when few
genes are in violation, every (day, start) is tried and a swap pass trades the day and start of two
classes of one professor or section (kept only when the schedule gets strictly better); and a
feasible individual has its genes with a soft cost improved (strictly better moves only).

Every day, window, start and room comes from the request (policy, rooms, faculty, demands; all in
slots). A gene is (day, startSlot, roomId or None) drawn from the demand's domain: allowed days,
starts where the whole block fits the day's window (the lab start times for a full-length lab), and
rooms of an allowed type (CCS, borrowed and extra rooms; none when the demand needs no room). Fixed
demands (NSTP) keep their day and start. The same input and seed give the same result when a run is
limited by generations (a time limit depends on the machine's speed).
"""
import random
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from constraints import Evaluator, Gene, WEEKEND_DAYS, has_free_run

# The GA settings contract (Phase 2 Step 3). main.py clamps what the gateway sends to these ranges.
DEFAULT_SETTINGS: Dict[str, Any] = {
    "mode": "memetic",
    "populationSize": 60,
    "mutationRate": 0.05,          # per gene
    "violationMutationBoost": 5,   # memetic: x5 for a gene in a hard violation
    "crossoverRate": 0.9,          # memetic
    "repairRate": 0.3,             # memetic: share of children repaired (the best is always repaired)
    "repairPasses": 2,             # memetic
    "repairSample": 40,            # memetic: (day, start) candidates tried per gene (all rooms of each)
    "repairFullBelow": 12,         # memetic: every (day, start) when at most this many genes are in violation
    "tournamentSize": 3,           # memetic
    "elitism": 2,                  # memetic (baseline keeps its Phase 1 best 4)
    "greedyShare": 0.25,           # memetic: share of the first population from the greedy builder
    "stallGenerations": 30,
    "timeBudgetSeconds": 180,
    "maxGenerations": 1000,
}
BASELINE_ELITES = 4
SOFT_EPSILON = 1e-9
# Phase 8 Part 6 (decision 5b): the Secretary's-move pass after the GA reaches 0 conflicts — at most
# this many rounds (each removes at least one part-timer's lone day) within this many extra seconds.
PART6_PASS_ROUNDS = 40
PART6_PASS_SECONDS = 10.0
BASELINE_PARENT_POOL = 15
HISTORY_POINTS = 200


def _clash_pairs(blocks: Sequence[Tuple[int, int, int]]) -> int:
    """Overlapping pairs among (start, end, gene) blocks."""
    n = len(blocks)
    if n < 2:
        return 0
    bs = sorted(blocks)
    pairs = 0
    for a in range(n):
        end_a = bs[a][1]
        for b in range(a + 1, n):
            if bs[b][0] >= end_a:
                break
            pairs += 1
    return pairs


def _person_day(blocks: Sequence[Tuple[int, int, int]], lunch: Optional[Tuple[int, int, int]], lunch_slots: int) -> Tuple[int, int]:
    """(hard, idle slots) of one section's or professor's day in one pass over its sorted blocks:
    overlapping pairs (HC3), a missing lunch run (HC1, when the rule is on; the same answer as
    constraints.has_free_run) and the idle slots (constraints.idle_slots)."""
    if not blocks:
        return 0, 0
    bs = sorted(blocks)
    n = len(bs)
    hard = 0
    for a in range(n - 1):
        end_a = bs[a][1]
        for b in range(a + 1, n):
            if bs[b][0] >= end_a:
                break
            hard += 1
    # The union of the blocks as disjoint, sorted runs.
    runs = []
    cur_s, cur_e = bs[0][0], bs[0][1]
    for s, e, _ in bs:
        if s >= cur_e:
            runs.append((cur_s, cur_e))
            cur_s, cur_e = s, e
        elif e > cur_e:
            cur_e = e
    runs.append((cur_s, cur_e))
    if lunch is not None:
        start, end, need = lunch
        cursor = start
        free = False
        for s, e in runs:
            if e <= start:
                continue
            if s >= end:
                break
            if max(s, start) - cursor >= need:
                free = True
                break
            cursor = max(cursor, min(e, end))
        if not free and end - cursor < need:
            hard += 1
    in_class = 0
    for s, e in runs:
        in_class += e - s
    return hard, max(0, runs[-1][1] - bs[0][0] - in_class - lunch_slots)


class Problem:
    """Everything about a request that stays the same during a run."""

    def __init__(self, request: Dict[str, Any]):
        self.request = request
        self.ev = Evaluator(request)
        self.demands = self.ev.demands
        self.n = len(self.demands)
        policy = request["policy"]
        self.windows = policy.get("dayWindows") or {}
        lunch = policy.get("lunch") or {}
        self.lunch = (int(lunch["startSlot"]), int(lunch["endSlot"]), int(lunch["minFreeSlots"])) if lunch.get("enabled") else None
        self.lunch_slots = self.ev.lunch_slots
        self.same_day_rule = bool(policy.get("sameSubjectDifferentDays"))
        self.dur = [int(d["durationSlots"]) for d in self.demands]
        self.ref = [d.get("facultyRef") for d in self.demands]
        # Phase 8 Part 8 (decision 4): each demand's outside teacher (None for nearly all): a person key
        # of its own ("o") with the clash and the lunch hour only - no idle time, no single-class day.
        self.out = [d.get("outsideTeacher") for d in self.demands]
        self.sec = [d.get("sectionId") for d in self.demands]
        self.grp = [d["meetingGroup"] for d in self.demands]
        w = self.ev.weights
        self.w_sat = w["SAT_BLOCK"]
        self.w_lab = w["LEC_IN_LAB"]
        self.w_extra = w["EXTRA_ROOM"]
        self.w_sec_slot = w["SECTION_IDLE"] * self.ev.slot_hours
        self.w_fac_slot = w["FACULTY_IDLE"] * self.ev.slot_hours
        # Phase 4 Part 1: once per TBA room that holds a class, and once per class before the
        # preferred earliest start (the slot the policy carries; None counts nothing).
        self.w_tba = w["TBA_ROOM"]
        self.w_early = w["EARLY_START"]
        self.early_before = self.ev.early_before
        # Phase 8 Part 5: once per weekday on which a professor (or, lighter, a section) has exactly
        # one class meeting. A demand with classType 'OJT' is never a class meeting here (the GA's own
        # requests carry none; the gateway's version checks do).
        self.w_fac_single = w["FACULTY_SINGLE_DAY"]          # part-timers' (and the legacy counting's)
        self.w_fac_single_ft = w["FACULTY_SINGLE_DAY_FT"]    # full-timers' (0 by default; Phase 8 Part 6)
        self.w_sec_single = w["SECTION_SINGLE_DAY"]
        self.counted = [d.get("classType") != "OJT" for d in self.demands]
        # Phase 8 Part 6 (decision 5a): the Evaluator's per-professor class drives the weight; an
        # exempt part-timer's lone day is not a single-class day at all (group_cost returns 0 for it).
        self.fac_class = self.ev.fac_class
        # Phase 8 Part 6 (decision 5c): HC10 - while on, a non-exempt part-timer's lone weekday is a
        # hard conflict of its (professor, day) group (group_cost; scan adds the same term).
        self.part_single_hard = self.ev.part_single_hard
        self._time_static: Dict[Tuple[int, str, int], int] = {}
        self._room_static: Dict[Tuple[int, str, int, Optional[str]], Tuple[int, int, int]] = {}
        self._profiles: Dict[Tuple[int, Tuple], List[Tuple]] = {}

    def fac_single_weight(self, ref) -> float:
        """The single-class-day weight of one professor (Phase 8 Part 6): part-timers (and faculty
        entries without the fullTime flag, the pre-Part 6 counting) pay facultySingleClassDay,
        full-timers fullTimerSingleClassDay (0 by default), an exempt part-timer nothing."""
        cls = self.fac_class.get(ref, "legacy")
        if cls == "full":
            return self.w_fac_single_ft
        if cls == "exempt":
            return 0.0
        return self.w_fac_single

    def room_profile(self, i: int, rooms: Sequence[Optional[str]]) -> List[Tuple]:
        """For each room of gene i's domain: (roomId, hard that does not depend on the time (HC2,
        HC6), lecture-in-lab 0/1, extra room 0/1, the room's windows or None). Only a room with
        windows (a borrowed room) needs a per-time check (HC4 room window)."""
        key = (i, tuple(rooms))
        prof = self._profiles.get(key)
        if prof is None:
            d = self.demands[i]
            allowed = d.get("allowedRoomTypes") or []
            prof = []
            for room_id in rooms:
                room = self.ev.rooms.get(room_id) if room_id is not None else None
                hard = 0
                if not allowed:
                    if room_id is not None:
                        hard += 1
                elif room_id is None or room is None or room["roomType"] not in allowed:
                    hard += 1
                if (room is not None and self.ev.policy.get("enforceCapacity") and room.get("capacity") is not None
                        and d.get("sectionSize") is not None and room["capacity"] < d["sectionSize"]):
                    hard += 1
                lab = 1 if (d["classType"] == "LEC" and not d.get("isMinor") and room is not None and room["roomType"] == "LAB" and self.ev.lec_in_lab_on) else 0
                extra = 1 if room_id in self.ev.extra_rooms else 0
                windows = (self.ev.room_windows.get(room_id) or None) if room is not None else None
                prof.append((room_id, hard, lab, extra, windows))
            self._profiles[key] = prof
        return prof

    def time_static(self, i: int, day: str, start: int) -> int:
        """Hard violations of the time alone: HC4 professor unavailable, HC4 day, HC8 window, HC9."""
        key = (i, day, start)
        v = self._time_static.get(key)
        if v is None:
            d = self.demands[i]
            end = start + self.dur[i]
            v = 0
            ref = self.ref[i]
            if ref is not None and any(w["day"] == day and start < w["endSlot"] and w["startSlot"] < end for w in self.ev.unavailable.get(ref, ())):
                v += 1
            if day not in (d.get("allowedDays") or ()):
                v += 1
            w = self.windows.get(day)
            if w is None or start < w["startSlot"] or end > w["endSlot"]:
                v += 1
            starts = d.get("allowedStarts")
            if starts and start not in starts:
                v += 1
            self._time_static[key] = v
        return v

    def room_static(self, i: int, day: str, start: int, room_id: Optional[str]) -> Tuple[int, int, int]:
        """(hard: HC2, HC4 room window, HC6; lecture-in-lab 0/1; extra room 0/1) of a room choice."""
        key = (i, day, start, room_id)
        v = self._room_static.get(key)
        if v is None:
            d = self.demands[i]
            end = start + self.dur[i]
            hard = 0
            allowed = d.get("allowedRoomTypes") or []
            room = self.ev.rooms.get(room_id) if room_id is not None else None
            if not allowed:
                if room_id is not None:
                    hard += 1
            elif room_id is None or room is None or room["roomType"] not in allowed:
                hard += 1
            if room is not None:
                windows = self.ev.room_windows.get(room_id) or []
                if windows and not any(w["day"] == day and w["startSlot"] <= start and end <= w["endSlot"] for w in windows):
                    hard += 1
                if (self.ev.policy.get("enforceCapacity") and room.get("capacity") is not None
                        and d.get("sectionSize") is not None and room["capacity"] < d["sectionSize"]):
                    hard += 1
            lab = 1 if (d["classType"] == "LEC" and not d.get("isMinor") and room is not None and room["roomType"] == "LAB" and self.ev.lec_in_lab_on) else 0
            extra = 1 if room_id in self.ev.extra_rooms else 0
            v = (hard, lab, extra)
            self._room_static[key] = v
        return v

    def sat_count(self, i: int, day: str) -> int:
        return 1 if (day == "Saturday" and not self.demands[i].get("fixed")) else 0

    def early_count(self, i: int, start: int) -> int:
        """1 when a non-fixed gene starts before the preferred earliest start (constraints.py's rule)."""
        return 1 if (self.early_before is not None and start < self.early_before and not self.demands[i].get("fixed")) else 0

    def room_clash_pairs(self, blocks: Sequence[Tuple[int, int, int]]) -> int:
        """Overlapping pairs in one room's day. Phase 8 (odd and even weeks): while the switch is on,
        a pair of two different week groups is allowed (constraints.Evaluator counts the same way)."""
        if not self.ev.week_groups_on:
            return _clash_pairs(blocks)
        n = len(blocks)
        if n < 2:
            return 0
        wg = self.ev.wg
        bs = sorted(blocks)
        pairs = 0
        for a in range(n):
            end_a = bs[a][1]
            ga = wg[bs[a][2]]
            for b in range(a + 1, n):
                if bs[b][0] >= end_a:
                    break
                gb = wg[bs[b][2]]
                if ga is not None and gb is not None and ga != gb:
                    continue
                pairs += 1
        return pairs

    def single_day(self, day: str, blocks: Sequence[Tuple[int, int, int]]) -> int:
        """1 when the day is a weekday and exactly one counted (non-OJT) block sits on it (Phase 8
        Part 5: the single-class-day penalty), else 0."""
        if day in WEEKEND_DAYS:
            return 0
        c = 0
        for b in blocks:
            if self.counted[b[2]]:
                c += 1
                if c > 1:
                    return 0
        return 1 if c == 1 else 0

    def group_cost(self, key: Tuple, blocks: Sequence[Tuple[int, int, int]]) -> Tuple[int, int, int]:
        """(hard, idle slots, single-class day 0/1) of one group's day; the last two are 0 for room
        and meeting-group keys."""
        kind = key[0]
        if kind == "r":
            return self.room_clash_pairs(blocks), 0, 0
        if kind == "g":
            n = len(blocks)
            return (n * (n - 1) // 2 if self.same_day_rule else 0), 0, 0
        hard, idle = _person_day(blocks, self.lunch, self.lunch_slots)
        if kind == "o":
            return hard, 0, 0   # an outside teacher: the clash and the lunch hour only (Part 8)
        # An exempt part-timer's lone weekday is unavoidable (part_timer_exempt), so it is not a
        # single-class day at all (Phase 8 Part 6).
        if kind == "f" and self.fac_class.get(key[1]) == "exempt":
            return hard, idle, 0
        single = self.single_day(key[2], blocks)
        if single and kind == "f" and self.part_hard_ref(key[1]):
            hard += 1   # HC10 (decision 5c)
        return hard, idle, single

    def part_hard_ref(self, ref) -> bool:
        """True when HC10 is on and this professor is a non-exempt part-timer (Phase 8 Part 6)."""
        return self.part_single_hard and self.fac_class.get(ref) == "part"


class State:
    """One schedule with its occupancy tables: the blocks of every (room, day), (professor, day),
    (section, day) and (meeting group, day), each group's (hard, idle) cost, and running totals. Its
    totals always equal the shared Evaluator's (tested on random schedules)."""

    __slots__ = ("p", "genes", "tables", "cost", "hard_static", "hard_groups", "sat", "lab", "extra", "sec_idle", "fac_idle",
                 "early", "tba_use", "tba_used", "fac_single_legacy", "fac_single_part", "fac_single_full", "sec_single", "_key")

    def __init__(self, p: Problem, genes: Optional[List[Optional[Gene]]] = None):
        self.p = p
        self.genes: List[Optional[Gene]] = list(genes) if genes is not None else [None] * p.n
        self.tables: Dict[Tuple, List[Tuple[int, int, int]]] = {}
        self.cost: Dict[Tuple, Tuple[int, int, int]] = {}
        self.hard_static = self.hard_groups = 0
        self.sat = self.lab = self.extra = 0
        self.sec_idle = self.fac_idle = 0
        # Phase 4 Part 1: early starts, and the blocks each TBA room holds (tba_used = rooms with > 0).
        self.early = 0
        self.tba_use: Dict[str, int] = {}
        self.tba_used = 0
        # Phase 8 Part 5: the professors' and the sections' single-class weekdays (Part 6: the
        # professors' split by employment type; an exempt part-timer's day counts in none).
        self.fac_single_legacy = self.fac_single_part = self.fac_single_full = self.sec_single = 0
        self._key = None
        for i, g in enumerate(self.genes):
            if g is not None:
                self._add_static(i, g)
                blk = (g[1], g[1] + p.dur[i], i)
                for key in self.keys_of(i, g):
                    self.tables.setdefault(key, []).append(blk)
        for key, blocks in self.tables.items():
            c = p.group_cost(key, blocks)
            self.cost[key] = c
            self._count(key, c, 1)

    # ---------------------------------------------------------------- bookkeeping
    def keys_of(self, i: int, g: Gene) -> List[Tuple]:
        day, _, room = g
        p = self.p
        keys = []
        if room is not None:
            keys.append(("r", room, day))
        if p.ref[i] is not None:
            keys.append(("f", p.ref[i], day))
        if p.out[i] is not None:
            keys.append(("o", p.out[i], day))
        if p.sec[i] is not None:
            keys.append(("s", p.sec[i], day))
        keys.append(("g", p.grp[i], day))
        return keys

    def _add_static(self, i: int, g: Gene, sign: int = 1) -> None:
        day, start, room = g
        p = self.p
        h, lab, extra = p.room_static(i, day, start, room)
        self.hard_static += sign * (p.time_static(i, day, start) + h)
        self.lab += sign * lab
        self.extra += sign * extra
        self.sat += sign * p.sat_count(i, day)
        self.early += sign * p.early_count(i, start)
        if extra:
            n = self.tba_use.get(room, 0) + sign
            self.tba_use[room] = n
            if sign > 0 and n == 1:
                self.tba_used += 1
            elif sign < 0 and n == 0:
                self.tba_used -= 1

    def _count(self, key: Tuple, cost: Tuple[int, int, int], sign: int) -> None:
        self.hard_groups += sign * cost[0]
        if key[0] == "s":
            self.sec_idle += sign * cost[1]
            self.sec_single += sign * cost[2]
        elif key[0] == "f":
            self.fac_idle += sign * cost[1]
            cls = self.p.fac_class.get(key[1], "legacy")
            if cls == "full":
                self.fac_single_full += sign * cost[2]
            elif cls == "part":
                self.fac_single_part += sign * cost[2]
            else:
                self.fac_single_legacy += sign * cost[2]

    def hard(self) -> int:
        return self.hard_static + self.hard_groups

    def counts(self) -> Dict[str, int]:
        return {"saturdayBlocks": self.sat, "lecturesInLab": self.lab, "extraRoomBlocks": self.extra,
                "sectionIdleSlots": self.sec_idle, "facultyIdleSlots": self.fac_idle,
                "tbaRoomsUsed": self.tba_used, "earlyStarts": self.early,
                "facultySingleDaysLegacy": self.fac_single_legacy, "facultySingleDaysPart": self.fac_single_part,
                "facultySingleDaysFull": self.fac_single_full, "sectionSingleDays": self.sec_single}

    def soft(self) -> float:
        return self.p.ev.soft_from_counts(self.counts())["total"]

    def key(self) -> Tuple[int, float]:
        """(hard, soft): fewer hard violations first, then the lower soft score (fitness order)."""
        if self._key is None:
            self._key = (self.hard(), self.soft())
        return self._key

    def copy(self) -> "State":
        other = State.__new__(State)
        other.p = self.p
        other.genes = list(self.genes)
        other.tables = {k: list(v) for k, v in self.tables.items()}
        other.cost = dict(self.cost)
        other.hard_static, other.hard_groups = self.hard_static, self.hard_groups
        other.sat, other.lab, other.extra = self.sat, self.lab, self.extra
        other.sec_idle, other.fac_idle = self.sec_idle, self.fac_idle
        other.early, other.tba_use, other.tba_used = self.early, dict(self.tba_use), self.tba_used
        other.fac_single_legacy, other.fac_single_part = self.fac_single_legacy, self.fac_single_part
        other.fac_single_full, other.sec_single = self.fac_single_full, self.sec_single
        other._key = self._key
        return other

    # ---------------------------------------------------------------- moves
    def apply(self, i: int, new: Gene) -> None:
        """Moves gene i to `new` (or places it when it was None), updating every table it touches."""
        old = self.genes[i]
        p = self.p
        touched: List[Tuple] = []
        if old is not None:
            self._add_static(i, old, -1)
            for key in self.keys_of(i, old):
                self.tables[key] = [b for b in self.tables[key] if b[2] != i]
                touched.append(key)
        self.genes[i] = new
        self._add_static(i, new, 1)
        blk = (new[1], new[1] + p.dur[i], i)
        for key in self.keys_of(i, new):
            self.tables.setdefault(key, []).append(blk)
            if key not in touched:
                touched.append(key)
        for key in touched:
            before = self.cost.get(key, (0, 0, 0))
            after = p.group_cost(key, self.tables[key])
            self.cost[key] = after
            self._count(key, before, -1)
            self._count(key, after, 1)
        self._key = None

    def in_violation(self, i: int) -> bool:
        """True when gene i is itself in a hard violation: a violation of its own (room type, window,
        availability, day, lab start), a block it overlaps (room, professor or section), a second
        meeting of its subject on its day, or a day of its section or professor with no lunch run
        (every class of such a day is named, as the Evaluator does)."""
        g = self.genes[i]
        if g is None:
            return False
        p = self.p
        day, start, room = g
        if p.time_static(i, day, start) or p.room_static(i, day, start, room)[0]:
            return True
        end = start + p.dur[i]
        wg = p.ev.wg
        gi = wg[i]
        for key in self.keys_of(i, g):
            hard = self.cost.get(key, (0, 0, 0))[0]
            if not hard:
                continue
            if key[0] == "g":
                return True
            blocks = self.tables[key]
            if key[0] == "r":
                # Phase 8: a cross-group overlap in a room is allowed, so it never marks the gene.
                if any(b[2] != i and b[0] < end and start < b[1]
                       and not (gi is not None and wg[b[2]] is not None and wg[b[2]] != gi) for b in blocks):
                    return True
                continue
            if any(b[2] != i and b[0] < end and start < b[1] for b in blocks):
                return True
            if key[0] in ("f", "s", "o") and hard > _clash_pairs(blocks):
                return True   # the day has no lunch run
        return False

    def violating(self) -> List[int]:
        """Genes in a hard violation (in_violation), in gene order."""
        return [i for i in range(self.p.n) if self.in_violation(i)]

    def soft_genes(self) -> List[int]:
        """Genes that carry a soft cost: an extra room, a non-fixed Saturday block, a Major lecture in
        a LAB room, an early start (Phase 4 Part 1), a day with idle time (its section's or
        professor's), or the one class of a single-class weekday (Phase 8 Part 5). In gene order."""
        p = self.p
        out = set()
        for i, g in enumerate(self.genes):
            if g is None:
                continue
            day, start, room = g
            _, lab, extra = p.room_static(i, day, start, room)
            if lab or extra or p.sat_count(i, day) or p.early_count(i, start):
                out.add(i)
        for key, (_, idle, single) in self.cost.items():
            if key[0] not in ("s", "f"):
                continue
            # A single-class day whose professor's weight is 0 (a full-timer by default) moves the
            # soft score nothing, so it is not a target (Phase 8 Part 6).
            if key[0] == "f" and single and not idle and p.fac_single_weight(key[1]) <= 0:
                continue
            if idle or single:
                out.update(b[2] for b in self.tables[key])
        return sorted(out)

    def scan(self, i: int, time_options: Sequence[Tuple[str, int]], rooms: Sequence[Optional[str]],
             ignore_lone: bool = False) -> Tuple[Optional[Tuple[int, float, int]], List[Gene]]:
        """The best (hard change, soft change, preference) of moving gene i to any (day, start) of
        `time_options` in any of `rooms`, and every gene that reaches it (the current gene excluded).
        `ignore_lone` (Phase 8 Part 6, the greedy builder only): the hard change leaves out HC10, a
        part-timer's lone weekday - a whole-week property that a schedule built one class at a time
        cannot judge yet (a part-timer's first class is always alone at first), so the builder never
        trades a clash for it; repair and selection count it as any conflict.
        The removal of the old block is costed once, the time part once per (day, start), the room
        part per room. The third part of the key is the Phase 4 Part 1 placement preference, which
        only breaks ties between moves with the same hard and soft change (so it never costs a
        conflict, and still acts when the two weights are 0): 0 for a start at or after the preferred
        earliest start in a real room or a TBA room already in use, +1 for an early start, +1 for a
        TBA room that would otherwise be empty."""
        p = self.p
        old = self.genes[i]
        dur = p.dur[i]
        base_h = 0
        base_s = 0.0
        oroom = None
        removed: Dict[Tuple, List[Tuple[int, int, int]]] = {}
        removed_cost: Dict[Tuple, Tuple[int, int]] = {}
        base_lone = 0   # HC10's part of base_h (ignore_lone)
        if old is not None:
            oday, ostart, oroom = old
            oh, olab, oex = p.room_static(i, oday, ostart, oroom)
            base_h -= p.time_static(i, oday, ostart) + oh
            base_s -= p.w_lab * olab + p.w_extra * oex + p.w_sat * p.sat_count(i, oday) + p.w_early * p.early_count(i, ostart)
            # Taking the old block out of a TBA room it alone uses frees that room.
            if oex and self.tba_use.get(oroom, 0) == 1:
                base_s -= p.w_tba
            for key in self.keys_of(i, old):
                blocks = [b for b in self.tables[key] if b[2] != i]
                removed[key] = blocks
                after = p.group_cost(key, blocks)
                removed_cost[key] = after
                before = self.cost[key]
                base_h += after[0] - before[0]
                if key[0] == "s":
                    base_s += p.w_sec_slot * (after[1] - before[1]) + p.w_sec_single * (after[2] - before[2])
                elif key[0] == "f":
                    base_s += p.w_fac_slot * (after[1] - before[1]) + p.fac_single_weight(key[1]) * (after[2] - before[2])
                    if p.part_hard_ref(key[1]):
                        base_lone += after[2] - before[2]
        people = []
        if p.ref[i] is not None:
            people.append(("f", p.ref[i], p.w_fac_slot, p.fac_single_weight(p.ref[i]), p.part_hard_ref(p.ref[i])))
        if p.out[i] is not None:
            people.append(("o", p.out[i], 0.0, 0.0, False))   # Part 8: no idle time, no single day
        if p.sec[i] is not None:
            people.append(("s", p.sec[i], p.w_sec_slot, p.w_sec_single, False))
        grp = p.grp[i]
        wg = p.ev.wg
        gi = wg[i]
        profile = p.room_profile(i, rooms)
        best: Optional[Tuple[int, float, int]] = None
        found: List[Gene] = []
        for day, start in time_options:
            end = start + dur
            nblk = (start, end, i)
            th = base_h + p.time_static(i, day, start)
            tl = base_lone
            early = p.early_count(i, start)
            ts = base_s + p.w_sat * p.sat_count(i, day) + p.w_early * early
            for kind, ident, weight, single_weight, single_hard in people:
                key = (kind, ident, day)
                if key in removed:
                    blocks, (h0, idle0, single0) = removed[key], removed_cost[key]
                else:
                    blocks = self.tables.get(key, [])
                    h0, idle0, single0 = self.cost.get(key, (0, 0, 0))
                with_block = list(blocks) + [nblk]
                h1, idle1 = _person_day(with_block, p.lunch, p.lunch_slots)
                single1 = p.single_day(day, with_block)
                if single_hard:
                    if single1:
                        h1 += 1   # HC10, as group_cost counts it
                    tl += single1 - single0
                th += h1 - h0
                ts += weight * (idle1 - idle0) + single_weight * (single1 - single0)
            if p.same_day_rule:
                key = ("g", grp, day)
                th += len(removed[key] if key in removed else self.tables.get(key, ()))
            for room, rh, lab, extra, windows in profile:
                g = (day, start, room)
                if g == old:
                    continue
                h = th + rh
                if windows is not None and not any(w["day"] == day and w["startSlot"] <= start and end <= w["endSlot"] for w in windows):
                    h += 1
                if room is not None:
                    key = ("r", room, day)
                    for b in (removed[key] if key in removed else self.tables.get(key, ())):
                        if b[0] < end and start < b[1]:
                            # Phase 8: a block of the other week group shares the room freely.
                            gb = wg[b[2]]
                            if gi is not None and gb is not None and gb != gi:
                                continue
                            h += 1
                s = ts + p.w_lab * lab + p.w_extra * extra
                # A TBA room that no other block uses (the old block, if it is there, has left it).
                empty_tba = extra and (self.tba_use.get(room, 0) - (1 if room == oroom else 0)) == 0
                if empty_tba:
                    s += p.w_tba
                # Rounded, so float noise from decimal weights never makes two equal moves differ.
                k = (h - tl if ignore_lone else h, round(s, 9), early + (1 if empty_tba else 0))
                if best is None or k < best:
                    best, found = k, [g]
                elif k == best:
                    found.append(g)
        return best, found


class Cancelled(Exception):
    pass


class GeneticScheduler:
    def __init__(
        self,
        request: Dict[str, Any],
        population_size: Optional[int] = None,
        max_generations: Optional[int] = None,
        mutation_rate: Optional[float] = None,
        seed: Optional[int] = None,
        stall_generations: Optional[int] = None,
        settings: Optional[Dict[str, Any]] = None,
        cancel_event: Any = None,
        progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        s = dict(DEFAULT_SETTINGS)
        s.update(settings or {})
        for name, value in (("populationSize", population_size), ("maxGenerations", max_generations),
                            ("mutationRate", mutation_rate), ("stallGenerations", stall_generations)):
            if value is not None:
                s[name] = value
        self.settings = s
        self.mode = s["mode"]
        self.request = request
        self.demands: List[Dict[str, Any]] = list(request.get("demands") or [])
        self.population_size = max(2, int(s["populationSize"]))
        self.max_generations = int(s["maxGenerations"])
        self.mutation_rate = float(s["mutationRate"])
        self.stall_generations = int(s["stallGenerations"])
        self.time_budget = float(s["timeBudgetSeconds"])
        self.seed = seed if seed is not None else random.randrange(2 ** 31)
        self.rng = random.Random(self.seed)
        self.cancel_event = cancel_event
        self.progress = progress
        self.p = Problem(request)
        self.evaluator = self.p.ev
        self.time_options = [self._time_options(d) for d in self.demands]
        self.room_options = [self._room_domain(d) for d in self.demands]
        # Sections -> their demands, in first-seen order (section-preserving crossover).
        self.by_section: Dict[Any, List[int]] = {}
        for i, d in enumerate(self.demands):
            self.by_section.setdefault(d.get("sectionId"), []).append(i)
        self.repair_seconds = 0.0
        self.part_single_moves = 0   # Phase 8 Part 6: lone part-timer days the last phase removed
        self._deadline = float("inf")
        self._members = None   # (professor|section) -> its genes, for the endgame swaps
        self._part_members: Dict[str, List[int]] = {}   # part-timer -> their movable class genes (HC10)
        self._free = None      # professor -> free slots in the week (greedy order)
        # At least one child per generation beside the elites and the repaired best.
        self.elites = max(0, min(int(s["elitism"]), self.population_size - 2))
        self._time_option_sets = [set(options) for options in self.time_options]

    # ------------------------------------------------------------------------------------------
    # Domains
    # ------------------------------------------------------------------------------------------
    def _time_options(self, demand: Dict[str, Any]) -> List[Tuple[str, int]]:
        """Every (day, startSlot) the demand may take."""
        fixed = demand.get("fixed")
        if fixed:
            return [(fixed["day"], int(fixed["startSlot"]))]
        windows = self.request["policy"].get("dayWindows") or {}
        duration = int(demand["durationSlots"])
        allowed_starts = demand.get("allowedStarts")
        options = []
        for day in demand.get("allowedDays") or []:
            w = windows.get(day)
            if not w:
                continue
            candidates = allowed_starts if allowed_starts else range(w["startSlot"], w["endSlot"])
            options.extend((day, s) for s in candidates if w["startSlot"] <= s and s + duration <= w["endSlot"])
        if not options:
            # Nothing fits (e.g. a block longer than every window): keep a gene so the demand is still
            # placed, and let the constraints report it.
            days = demand.get("allowedDays") or list(windows)
            if not days:
                raise ValueError(f"{demand['demandId']} has no allowed day and the policy has no day window.")
            w = windows.get(days[0]) or {"startSlot": 0}
            options = [(days[0], int(w["startSlot"]))]
        return options

    def _room_domain(self, demand: Dict[str, Any]) -> List[Optional[str]]:
        """Rooms whose type is allowed (CCS, borrowed and extra rooms; when capacity is enforced, large
        enough); [None] when the demand needs no room, or when no room qualifies (HC2 then reports it)."""
        allowed = demand.get("allowedRoomTypes") or []
        if not allowed:
            return [None]
        enforce = bool(self.request["policy"].get("enforceCapacity"))
        size = demand.get("sectionSize")
        rooms = [
            r["roomId"] for r in self.request.get("rooms") or []
            if r["roomType"] in allowed
            and not (enforce and size is not None and r.get("capacity") is not None and r["capacity"] < size)
        ]
        return rooms or [None]

    def _random_gene(self, i: int) -> Gene:
        day, start = self.rng.choice(self.time_options[i])
        return (day, start, self.rng.choice(self.room_options[i]))

    def calculate_conflicts(self, chromosome: List[Gene]) -> Tuple[int, float]:
        return State(self.p, chromosome).key()

    # ------------------------------------------------------------------------------------------
    # Stop checks
    # ------------------------------------------------------------------------------------------
    def _check_cancel(self) -> None:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise Cancelled()

    def _out_of_time(self) -> bool:
        return time.perf_counter() > self._deadline

    # ------------------------------------------------------------------------------------------
    # Memetic operators
    # ------------------------------------------------------------------------------------------
    def _free_time(self) -> Dict[str, int]:
        """Each professor's free slots in the week: the windows of the days their classes may use,
        minus their unavailable times, their own classes and a lunch allowance per day."""
        p = self.p
        if self._free is None:
            days: Dict[str, set] = {}
            own: Dict[str, int] = {}
            for i, ref in enumerate(p.ref):
                if ref is None:
                    continue
                days.setdefault(ref, set()).update(self.demands[i].get("allowedDays") or ())
                own[ref] = own.get(ref, 0) + p.dur[i]
            free = {}
            for ref, ds in days.items():
                window = sum(p.windows[d]["endSlot"] - p.windows[d]["startSlot"] for d in ds if d in p.windows)
                unavailable = sum(w["endSlot"] - w["startSlot"] for w in p.ev.unavailable.get(ref, ()) if w["day"] in ds)
                free[ref] = window - unavailable - own[ref] - p.lunch_slots * len(ds)
            self._free = free
        return self._free

    def _greedy(self) -> List[Gene]:
        """Randomized greedy builder: the most constrained meetings first (labs, then long lectures,
        then the professors with the least free time), each at the (day, start, room) that adds the
        fewest hard violations, then the least soft cost (ties broken at random)."""
        p = self.p
        free_time = self._free_time()
        noise = [self.rng.random() for _ in range(p.n)]
        order = sorted(range(p.n), key=lambda i: (
            0 if self.demands[i]["classType"] == "LAB" else 1,
            -p.dur[i],
            free_time.get(p.ref[i], float("inf")),   # TBA last
            noise[i]))
        st = State(p)
        sample = int(self.settings["repairSample"]) or None
        for i in order:
            self._check_cancel()
            options = self.time_options[i]
            if sample and len(options) > sample:
                options = self.rng.sample(options, sample)
            _, found = st.scan(i, options, self.room_options[i], ignore_lone=True)
            st.apply(i, self.rng.choice(found))
        return st.genes

    def _tournament(self, population: List[State]) -> State:
        best = None
        for _ in range(int(self.settings["tournamentSize"])):
            s = population[self.rng.randrange(len(population))]
            if best is None or s.key() < best.key():
                best = s
        return best

    def _section_crossover(self, a: State, b: State) -> List[Gene]:
        """A child takes all of a section's meetings from one parent."""
        child = list(a.genes)
        if self.rng.random() >= float(self.settings["crossoverRate"]):
            return child
        for indexes in self.by_section.values():
            if self.rng.random() < 0.5:
                for i in indexes:
                    child[i] = b.genes[i]
        return child

    def _targeted_mutation(self, st: State) -> None:
        """Each gene re-drawn from its domain with probability mutationRate, x violationMutationBoost
        for a gene in a hard violation."""
        bad = set(st.violating())
        base = self.mutation_rate
        boosted = min(1.0, base * float(self.settings["violationMutationBoost"]))
        for i in range(self.p.n):
            if self.rng.random() < (boosted if i in bad else base):
                g = self._random_gene(i)
                if g != st.genes[i]:
                    st.apply(i, g)

    def _repair(self, st: State) -> None:
        """Local search: up to repairPasses passes over the genes in hard violations. Each moves to the
        (day, start, room) of its domain that lowers the hard count most, then the soft score, ties
        broken by the seeded generator; a move that would raise the hard count is never made. When
        the best move keeps the hard count (a sideways move) it is still made, even at a soft cost:
        a professor whose week is nearly full (e.g. 45 teaching hours) can only be untangled by
        such moves (only for a gene that is still in a violation when its turn comes). Options: every
        (day, start) of the domain when at most repairFullBelow genes are in violation, otherwise a
        seeded random sample of repairSample; every room of each. In that endgame a swap pass follows
        (_swap_pass). An individual with no hard violation has its genes with a soft cost improved
        instead (strictly better moves only). The cancel flag and the time budget are checked for
        every gene."""
        started = time.perf_counter()
        sample = int(self.settings["repairSample"]) or None
        full_below = int(self.settings["repairFullBelow"])
        try:
            for _ in range(int(self.settings["repairPasses"])):
                hard_mode = st.hard() > 0
                if hard_mode and self.p.part_single_hard:
                    self._lone_day_moves(st)
                    hard_mode = st.hard() > 0
                targets = st.violating() if hard_mode else st.soft_genes()
                if not targets:
                    break
                exhaustive = hard_mode and len(targets) <= full_below
                self.rng.shuffle(targets)
                for i in targets:
                    self._check_cancel()
                    if self._out_of_time():
                        return
                    # A gene that an earlier move of this pass freed is left where it is.
                    if hard_mode and not st.in_violation(i):
                        continue
                    options = self.time_options[i]
                    if sample and len(options) > sample and not exhaustive:
                        options = self.rng.sample(options, sample)
                    best, found = st.scan(i, options, self.room_options[i])
                    if best is None or not found:
                        continue
                    if (best[0] <= 0) if hard_mode else (best[0] <= 0 and (best[0] < 0 or best[1] < -SOFT_EPSILON)):
                        st.apply(i, self.rng.choice(found))
                if exhaustive and st.hard() > 0:
                    self._swap_pass(st)
        finally:
            self.repair_seconds += time.perf_counter() - started

    def _lone_day_moves(self, st: State) -> None:
        """Phase 8 Part 6 (decision 5c): HC10's own repair. The repair below moves only classes that
        are in a conflict, but a part-timer's lone weekday is often cleared by moving one of their OTHER
        classes onto it. For each lone (part-timer, weekday), in a seeded order: each of that
        part-timer's movable classes is scanned on the lone day, and the lone class on each other
        weekday they teach (exact scans of those days only); the best of those moves is made when it
        lowers the hard count. Only part-timers' classes are scanned, and only while HC10 is on (a
        request without the rule never reaches here, so its seeded runs are unchanged)."""
        p = self.p
        lone = sorted((key for key, cost in st.cost.items()
                       if key[0] == "f" and cost[2] == 1 and p.part_hard_ref(key[1])),
                      key=lambda k: (str(k[1]), str(k[2])))
        self.rng.shuffle(lone)
        for key in lone:
            self._check_cancel()
            if self._out_of_time():
                return
            if st.cost.get(key, (0, 0, 0))[2] != 1:
                continue   # an earlier move cleared (or changed) this day
            _, ref, day = key
            members = self._part_members.get(ref)
            if members is None:
                members = [j for j in range(p.n) if p.ref[j] == ref and p.counted[j] and not self.demands[j].get("fixed")]
                self._part_members[ref] = members
            lone_gene = next(b[2] for b in st.tables[key] if p.counted[b[2]])
            teaching = {k2[2] for k2 in st.cost
                        if k2[0] == "f" and k2[1] == ref and k2[2] != day and k2[2] not in WEEKEND_DAYS
                        and any(p.counted[b[2]] for b in st.tables.get(k2, ()))}
            best = None   # (scan key, gene index, the genes that reach it)
            for j in members:
                g = st.genes[j]
                if g is None:
                    continue
                if j == lone_gene:
                    options = [o for o in self.time_options[j] if o[0] in teaching]
                elif g[0] != day:
                    options = [o for o in self.time_options[j] if o[0] == day]
                else:
                    continue
                if not options:
                    continue
                k, found = st.scan(j, options, self.room_options[j])
                if k is not None and found and (best is None or k < best[0]):
                    best = (k, j, found)
            if best is not None and best[0][0] < 0:
                st.apply(best[1], self.rng.choice(best[2]))

    def _swap_pass(self, st: State) -> None:
        """Endgame local search (few hard violations left): a class in a violation trades its day and
        start with another class of the same professor or section (each taking its best room at the new
        time). The swap is kept only when the schedule gets strictly better (fewer hard violations, or
        as many and a lower soft score); otherwise both classes go back. A professor or section whose
        week is nearly full can only be untangled this way."""
        p = self.p
        if self._members is None:
            members: Dict[Tuple, List[int]] = {}
            for j in range(p.n):
                if self.demands[j].get("fixed"):
                    continue
                if p.ref[j] is not None:
                    members.setdefault(("f", p.ref[j]), []).append(j)
                if p.sec[j] is not None:
                    members.setdefault(("s", p.sec[j]), []).append(j)
            self._members = members
        targets = st.violating()
        self.rng.shuffle(targets)
        for i in targets:
            if st.hard() == 0:
                return
            if self.demands[i].get("fixed"):
                continue
            partners: List[int] = []
            for key in (("f", p.ref[i]), ("s", p.sec[i])):
                partners.extend(j for j in self._members.get(key, ()) if j != i and j not in partners)
            self.rng.shuffle(partners)
            options_i = self._time_option_sets[i]
            for j in partners:
                self._check_cancel()
                if self._out_of_time():
                    return
                gi, gj = st.genes[i], st.genes[j]
                if (gj[0], gj[1]) == (gi[0], gi[1]) or (gj[0], gj[1]) not in options_i or (gi[0], gi[1]) not in self._time_option_sets[j]:
                    continue
                before = st.key()
                _, found_i = st.scan(i, [(gj[0], gj[1])], self.room_options[i])
                if not found_i:
                    continue
                st.apply(i, found_i[0])
                _, found_j = st.scan(j, [(gi[0], gi[1])], self.room_options[j])
                if found_j:
                    st.apply(j, found_j[0])
                if st.key() < before:
                    break
                # Not better: both classes go back exactly where they were.
                if found_j:
                    st.apply(j, gj)
                st.apply(i, gi)

    # ------------------------------------------------------------------------------------------
    # Baseline operators (Phase 1)
    # ------------------------------------------------------------------------------------------
    def _single_point_crossover(self, a: List[Gene], b: List[Gene]) -> List[Gene]:
        if len(a) < 2:
            return list(a)
        idx = self.rng.randint(1, len(a) - 1)
        return a[:idx] + b[idx:]

    def _redraw_mutation(self, genes: List[Gene]) -> List[Gene]:
        child = list(genes)
        for i in range(len(child)):
            if self.rng.random() < self.mutation_rate:
                child[i] = self._random_gene(i)
        return child

    # ------------------------------------------------------------------------------------------
    def _first_population(self) -> List[State]:
        population = []
        n_greedy = int(round(self.population_size * float(self.settings["greedyShare"]))) if self.mode == "memetic" else 0
        for k in range(self.population_size):
            self._check_cancel()
            genes = self._greedy() if k < n_greedy else [self._random_gene(i) for i in range(self.p.n)]
            population.append(State(self.p, genes))
        return population

    def _next_population(self, population: List[State]) -> List[State]:
        """population is sorted best first."""
        if self.mode == "baseline":
            nxt = population[:min(BASELINE_ELITES, self.population_size - 1)]
            pool = population[:BASELINE_PARENT_POOL]
            while len(nxt) < self.population_size:
                self._check_cancel()
                a, b = self.rng.choice(pool), self.rng.choice(pool)
                nxt.append(State(self.p, self._redraw_mutation(self._single_point_crossover(a.genes, b.genes))))
            return nxt
        nxt = population[:self.elites]
        best = population[0].copy()
        self._repair(best)   # the best is always repaired (its elite copy is kept unchanged)
        if len(nxt) < self.population_size - 1:
            nxt.append(best)
        repair_rate = float(self.settings["repairRate"])
        while len(nxt) < self.population_size:
            self._check_cancel()
            child = State(self.p, self._section_crossover(self._tournament(population), self._tournament(population)))
            self._targeted_mutation(child)
            if self.rng.random() < repair_rate:
                self._repair(child)
            nxt.append(child)
        return nxt

    def run_evolution(self) -> Dict[str, Any]:
        started = time.perf_counter()
        self._deadline = started + self.time_budget
        if not self.demands:
            return self._response(State(self.p, []), 0, 0, started, "no-demands", None, [])
        best: Optional[State] = None
        initial_hard = None
        first_feasible = None
        history: List[List[float]] = []
        generations = 0
        stop = "generation-cap"
        last_improvement = 0
        try:
            population = sorted(self._first_population(), key=State.key)
            best = population[0]
            initial_hard = min(s.hard() for s in population)
            if best.hard() == 0:
                first_feasible = time.perf_counter() - started
            history.append([0, best.hard(), round(best.soft(), 2)])
            self._report(0, started, best)
            while True:
                # Converged: feasible and no soft improvement for stallGenerations generations, or a
                # perfect schedule (0 hard and 0 soft), which nothing can improve.
                if best.hard() == 0 and (generations - last_improvement >= self.stall_generations or best.soft() == 0):
                    stop = "converged"
                    break
                if generations >= self.max_generations:
                    stop = "generation-cap"
                    break
                if self._out_of_time():
                    stop = "time-budget"
                    break
                self._check_cancel()
                population = sorted(self._next_population(population), key=State.key)
                generations += 1
                if population[0].key() < best.key():
                    best = population[0]
                    last_improvement = generations
                    if best.hard() == 0 and first_feasible is None:
                        first_feasible = time.perf_counter() - started
                history.append([generations, best.hard(), round(best.soft(), 2)])
                self._report(generations, started, best)
        except Cancelled:
            stop = "cancelled"
            if best is None:
                # Cancelled before the first population was built: there is no schedule and no number
                # to report (never a random one).
                return self._cancelled_before_start(started)
        # Phase 8 Part 6 (decision 5b): once the GA has 0 conflicts, the Secretary's move — remove
        # the part-timers' single-class weekdays where a hard-rule-keeping move exists. On a copy,
        # so a pass that somehow failed could never worsen the answer.
        if best is not None and best.hard() == 0 and stop != "cancelled":
            try:
                fixed = best.copy()
                self.part_single_moves = self._part_timer_single_day_pass(fixed)
                if self.part_single_moves and fixed.hard() == 0:
                    best = fixed
            except Cancelled:
                stop = "cancelled"
        return self._response(best, initial_hard, generations, started, stop, first_feasible, history)

    def _cancelled_before_start(self, started: float) -> Dict[str, Any]:
        return {
            "items": [],
            "stats": {
                "mode": self.mode, "seed": self.seed, "initialHard": None, "finalHard": None, "soft": None,
                "softBreakdown": None, "softCounts": None, "generations": 0,
                "runtimeMs": round((time.perf_counter() - started) * 1000), "timeToFirstFeasibleMs": None,
                "repairMs": round(self.repair_seconds * 1000), "msPerGeneration": None, "stopReason": "cancelled", "history": [],
            },
            "violations": [],
        }

    def _report(self, generation: int, started: float, best: State) -> None:
        if self.progress is not None:
            self.progress({"generation": generation, "elapsedMs": round((time.perf_counter() - started) * 1000),
                           "bestHard": best.hard(), "bestSoft": round(best.soft(), 2)})

    @staticmethod
    def _thin(history: List[List[float]]) -> List[List[float]]:
        """At most HISTORY_POINTS points, evenly spread, the first and the last kept."""
        if len(history) <= HISTORY_POINTS:
            return history
        step = (len(history) - 1) / (HISTORY_POINTS - 1)
        return [history[round(k * step)] for k in range(HISTORY_POINTS)]


    def _part_timer_single_day_pass(self, st: "State") -> int:
        """Phase 8 Part 6 (decision 5b): the Secretary's own move, as the GA's last phase. Runs only
        on a schedule with 0 conflicts. For each ELIGIBLE part-timer's weekday holding exactly one
        class meeting: (a) move that lone class to another weekday the part-timer already teaches,
        or (b) move one of their other classes onto the lone day. A move is kept only when every
        hard rule still holds (the whole state is re-scored: the section's and the professor's free
        time, a room per week group, the lunch hour, the lab starts, different days for the same
        subject, availability and the Friday rule all ride the ordinary tables) and the part-timers'
        single-class weekdays go DOWN; among the keepers the lowest soft score wins. Repeats until
        no move helps, within a small time cap. Returns the number of lone days removed."""
        p = self.p
        removed_total = 0
        deadline = time.perf_counter() + PART6_PASS_SECONDS
        for _ in range(PART6_PASS_ROUNDS):
            if st.hard() != 0 or time.perf_counter() > deadline:
                break
            lone_keys = sorted(
                (key for key, cost in st.cost.items()
                 if key[0] == "f" and cost[2] == 1 and p.fac_class.get(key[1]) == "part"),
                key=lambda k: (str(k[1]), str(k[2])))
            progressed = False
            for key in lone_keys:
                self._check_cancel()
                if time.perf_counter() > deadline:
                    break
                _, ref, day = key
                counted_blocks = [b for b in st.tables.get(key, []) if p.counted[b[2]]]
                if len(counted_blocks) != 1 or st.cost.get(key, (0, 0, 0))[2] != 1:
                    continue  # an earlier move of this round already changed this day
                i = counted_blocks[0][2]
                # The candidate moves: the lone class to a weekday the professor already teaches,
                # or one of their other movable classes onto the lone day.
                candidates: List[Tuple[int, Gene]] = []
                other_days = {k2[2] for k2 in st.cost
                              if k2[0] == "f" and k2[1] == ref and k2[2] != day and k2[2] not in WEEKEND_DAYS
                              and any(p.counted[b[2]] for b in st.tables.get(k2, ()))}
                if not self.demands[i].get("fixed") and other_days:
                    for d2, s2 in self.time_options[i]:
                        if d2 in other_days:
                            for room in self.room_options[i]:
                                candidates.append((i, (d2, s2, room)))
                for j in range(p.n):
                    if j == i or p.ref[j] != ref or st.genes[j] is None or self.demands[j].get("fixed") or not p.counted[j]:
                        continue
                    for d2, s2 in self.time_options[j]:
                        if d2 == day:
                            for room in self.room_options[j]:
                                candidates.append((j, (d2, s2, room)))
                before_part = st.fac_single_part
                best_move = None  # (soft_after, k, gene)
                for k, gene in candidates:
                    old = st.genes[k]
                    if gene == old:
                        continue
                    st.apply(k, gene)
                    if st.hard() == 0 and st.fac_single_part < before_part:
                        soft_after = st.soft()
                        if best_move is None or soft_after < best_move[0] - SOFT_EPSILON:
                            best_move = (soft_after, k, gene)
                    st.apply(k, old)
                if best_move is not None:
                    st.apply(best_move[1], best_move[2])
                    removed_total += before_part - st.fac_single_part
                    progressed = True
            if not progressed:
                break
        return removed_total

    def _response(self, best: State, initial_hard: int, generations: int, started: float, stop: str,
                  first_feasible: Optional[float], history: List[List[float]]) -> Dict[str, Any]:
        runtime = time.perf_counter() - started
        final = self.evaluator.evaluate(best.genes, with_violations=True) if self.demands else {
            "hardTotal": 0, "soft": {"total": 0.0}, "softCounts": {}, "violations": []}
        items = [
            {"demandId": d["demandId"], "day": gene[0], "startSlot": gene[1], "roomId": gene[2]}
            for d, gene in zip(self.demands, best.genes)
        ]
        if self.mode == "baseline":
            # What the Phase 1 operators really use (the memetic settings do not apply to them).
            settings = {"mode": "baseline", "populationSize": self.population_size, "mutationRate": self.mutation_rate,
                        "elitism": min(BASELINE_ELITES, self.population_size - 1), "parentPool": BASELINE_PARENT_POOL,
                        "firstPopulation": "random", "crossover": "single-point", "mutation": "re-draw", "repair": "none",
                        "stallGenerations": self.stall_generations, "timeBudgetSeconds": self.time_budget, "maxGenerations": self.max_generations}
        else:
            settings = {k: self.settings[k] for k in DEFAULT_SETTINGS}
            settings["elitism"] = self.elites
        return {
            "items": items,
            "stats": {
                "mode": self.mode,
                "settings": settings,
                "seed": self.seed,
                "initialHard": initial_hard,
                "finalHard": final["hardTotal"],
                "soft": round(final["soft"]["total"], 2),
                "softBreakdown": {k: round(v, 2) for k, v in final["soft"].items() if k != "total"},
                "softCounts": final["softCounts"],
                "generations": generations,
                "partTimerSingleDayMoves": self.part_single_moves,
                "runtimeMs": round(runtime * 1000),
                "timeToFirstFeasibleMs": round(first_feasible * 1000) if first_feasible is not None else None,
                "repairMs": round(self.repair_seconds * 1000),
                "msPerGeneration": round(runtime * 1000 / generations, 1) if generations else None,
                "stopReason": stop,
                "history": self._thin(history),
            },
            "violations": final["violations"],
        }
