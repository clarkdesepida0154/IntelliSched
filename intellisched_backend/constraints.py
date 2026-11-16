"""The shared hard and soft constraints, evaluated on a GA request and its placements, all in slots.

The gateway validator (IntelliSched server/src/utils/constraints.js) counts exactly the same way; the
golden cases in IntelliSched/shared/constraint-cases/ run through both. Keep the two in step.

Hard codes (one violation per):
  HC1_LUNCH                (section, day) or (faculty, day) with >= 1 class and no continuous free
                           lunch.minFreeSlots inside the lunch window; TBA faculty are skipped;
                           Phase 8 Part 8 (decision 4): an outside teacher's (outsideTeacher, day) too
  HC2_ROOM_TYPE            block whose room type is not allowed, that has a room when none is
                           required (an online lecture, `online: true`, included), or that has no
                           room when one is required
  HC3_ROOM_CLASH / HC3_FACULTY_CLASH / HC3_SECTION_CLASH   overlapping pair (None never clashes);
                           rooms are told apart by roomId, which for an extra room is its key
                           (EXTRA-LAB-1 ...), never by name. Phase 8 (odd and even weeks): while
                           policy.weekGroupsEnabled is true, a ROOM clash counts only between classes
                           of the same week group (demand.weekGroup); two classes of different groups
                           may share a room at the same hour (one is on campus in odd weeks, the other
                           in even weeks). A class without a group meets every week and clashes with
                           both. Professor and section clashes always count.
                           Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher
                           (demand.outsideTeacher, a key of its own: never a facultyRef) clashes
                           under HC3_FACULTY_CLASH with that teacher's other classes, in any week
                           group. The lunch hour (HC1) is the teacher's only other rule: no
                           unavailable times, idle time or single-class days.
  HC4_FACULTY_UNAVAILABLE  block overlapping one of the professor's unavailable windows
  HC4_ROOM_UNAVAILABLE     block not fully inside one of the room's windows (rooms with windows)
  HC4_DAY_NOT_ALLOWED      block on a day not in the demand's allowedDays
  HC6_CAPACITY             block in a room smaller than the section (enforceCapacity only; skipped
                           when either number is None)
  HC7_SAME_DAY             pair of meetings of one meetingGroup on the same day (sameSubjectDifferentDays)
  HC8_WINDOW               block not inside the policy window of its day (the Saturday window on
                           Saturday), whether or not the day is allowed for the demand
  HC9_LAB_START            block whose demand lists allowedStarts and that starts elsewhere
  HC10_PART_TIMER_SINGLE_DAY  (Phase 8 Part 6, decision 5c) a part-timer's weekday holding exactly one
                           class meeting, while policy.partTimerSingleDayHard is true (absent on older
                           requests: the rule is off). Counted per (professor, weekday) and named by
                           the lone class; an exempt part-timer (part_timer_exempt) never breaks it.

Soft terms (Phase 2). Each is counted first and multiplied by its weight (policy.softWeights) once,
so both languages get the same number:
  SAT_BLOCK     saturdayBlock     x non-fixed blocks on Saturday
  LEC_IN_LAB    lectureInLab      x Major LEC blocks in a LAB room, extra LAB rooms included
                                    (0 when majorLectureInLab is FREE)
  EXTRA_ROOM    overflowRoomBlock x blocks in an extra room (a room the Dean must request)
  SECTION_IDLE  sectionGapHour    x idle hours in the sections' days
  FACULTY_IDLE  facultyGapHour    x idle hours in the professors' days (TBA professors have none)
  TBA_ROOM      tbaRoomUsed       x extra (TBA) rooms that hold at least one block (Phase 4 Part 1:
                                    once per room, whatever its number of blocks)
  EARLY_START   earlyStart        x non-fixed blocks that start before policy.preferredEarliestStartSlot
                                    (Phase 4 Part 1; on any day; NSTP, a fixed block, is never counted;
                                    no slot in the policy means no early starts are counted)
  FACULTY_SINGLE_DAY  facultySingleClassDay  x weekdays on which a professor has exactly one class
                                    meeting (Phase 8 Part 5: no coming to school for one class).
                                    Saturday and Sunday never count (NSTP's Saturday block is excluded
                                    by that), and a demand with classType 'OJT' (the gateway's
                                    versionCheck adds them for a saved version) is not a class meeting
                                    here: the records are placed after the GA.
                                    Phase 8 Part 6 (decision 5a): the weight applies to PART-TIMERS
                                    (request.faculty[].fullTime false), who come to campus only for
                                    their classes; a part-timer whose lone day cannot be avoided
                                    (part_timer_exempt: fewer than two class meetings in the week, and
                                    the two structural cases it names) is exempt, so it neither costs
                                    nor counts. A FULL-TIMER's
                                    single-class weekday costs fullTimerSingleClassDay (0 by default:
                                    they are on campus for their duties). A faculty entry without the
                                    flag (the pre-Part 6 golden cases) keeps the old counting under
                                    facultySingleClassDay, with no exemption.
  SECTION_SINGLE_DAY  sectionSingleClassDay  x weekdays on which a section has exactly one class
                                    meeting (the lighter penalty of the pair; the same exclusions)
Idle slots of one (section or professor, day) = (last end - first start) - the slots in class (the
union of its blocks) - lunch.minFreeSlots when the lunch rule is on, never below 0. Hours = slots x
slotMinutes / 60. total = SAT_BLOCK + LEC_IN_LAB + EXTRA_ROOM + SECTION_IDLE + FACULTY_IDLE +
TBA_ROOM + EARLY_START + FACULTY_SINGLE_DAY + SECTION_SINGLE_DAY.
Fitness = -(100000 x hard + soft total).
"""
from collections import defaultdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

HARD_WEIGHT = 100000
SOFT_TERMS = ("SAT_BLOCK", "LEC_IN_LAB", "EXTRA_ROOM", "SECTION_IDLE", "FACULTY_IDLE", "TBA_ROOM", "EARLY_START",
              "FACULTY_SINGLE_DAY", "SECTION_SINGLE_DAY")
# Single-class days (Phase 8 Part 5) count on these days only: never on Saturday or Sunday.
WEEKEND_DAYS = ("Saturday", "Sunday")


def early_start_slot_of(policy: Dict[str, Any]) -> Optional[int]:
    """The slot before which a non-fixed block counts as an early start, or None when the policy
    carries none (an older request): then nothing is counted. The same rule as the gateway's."""
    slot = policy.get("preferredEarliestStartSlot")
    return int(slot) if isinstance(slot, int) and not isinstance(slot, bool) else None

# A placement aligned with the request's demands: (day, startSlot, roomId or None).
Gene = Tuple[str, int, Optional[str]]


def has_free_run(busy: Sequence[Tuple[int, int]], start: int, end: int, need: int) -> bool:
    """True when [start, end) holds a continuous free run of at least `need` slots."""
    clipped = sorted((max(s, start), min(e, end)) for s, e in busy if min(e, end) > max(s, start))
    cursor = start
    for s, e in clipped:
        if s - cursor >= need:
            return True
        cursor = max(cursor, e)
    return end - cursor >= need


def idle_slots(busy: Sequence[Tuple[int, int]], lunch_slots: int) -> int:
    """Idle slots in one day: the span from the first start to the last end, minus the slots in
    class (the union of the blocks), minus the lunch allowance; never below 0."""
    if not busy:
        return 0
    blocks = sorted(busy)
    first, last = blocks[0][0], max(e for _, e in blocks)
    in_class = 0
    cur_s, cur_e = blocks[0]
    for s, e in blocks[1:]:
        if s >= cur_e:
            in_class += cur_e - cur_s
            cur_s, cur_e = s, e
        elif e > cur_e:
            cur_e = e
    in_class += cur_e - cur_s
    return max(0, last - first - in_class - lunch_slots)


def weekday_capacity(policy: Dict[str, Any]) -> int:
    """The most class slots one weekday can hold for one person: the widest Monday-to-Friday window
    less the lunch rule's free run when the rule is on (one person's meetings never overlap, and the
    free run lies inside the window). 0 when the policy has no weekday window."""
    windows = policy.get("dayWindows") or {}
    widest = max((int(w["endSlot"]) - int(w["startSlot"]) for day, w in windows.items() if day not in WEEKEND_DAYS), default=0)
    lunch = policy.get("lunch") or {}
    free = int(lunch.get("minFreeSlots") or 0) if lunch.get("enabled") else 0
    return max(0, widest - free)


def part_timer_exempt(meetings: Sequence[Tuple[str, int]], policy: Dict[str, Any]) -> bool:
    """Phase 8 Part 6 (decisions 5a and 5c): True when a part-timer's class meetings (their non-OJT
    demands as (meetingGroup, durationSlots)) cannot be laid out without a weekday that holds exactly
    one of them, so such a day is exempt: it neither costs, nor counts, nor breaks HC10.
      - fewer than two meetings in the week;
      - more meetings of one subject for one section than all their other meetings together (those
        must fall on different days, so one of their days keeps a meeting alone);
      - an odd number of meetings when no three of them (three different subjects-for-a-section)
        fit in one weekday (weekday_capacity): with an odd number, some day must hold three.
    The gateway's constraints.js decides the same way."""
    n = len(meetings)
    if n < 2:
        return True
    distinct = bool(policy.get("sameSubjectDifferentDays"))
    if distinct:
        sizes: Dict[str, int] = {}
        for group, _ in meetings:
            sizes[group] = sizes.get(group, 0) + 1
        if 2 * max(sizes.values()) > n:
            return True
    if n % 2 == 1:
        cap = weekday_capacity(policy)
        for a in range(n):
            for b in range(a + 1, n):
                for c in range(b + 1, n):
                    if distinct and len({meetings[a][0], meetings[b][0], meetings[c][0]}) < 3:
                        continue
                    if meetings[a][1] + meetings[b][1] + meetings[c][1] <= cap:
                        return False
        return True
    return False


def faculty_classes(faculty: Sequence[Dict[str, Any]], demands: Sequence[Dict[str, Any]], policy: Dict[str, Any]) -> Dict[str, str]:
    """Each professor's single-class-day class (Phase 8 Part 6): 'full' (fullTime true), 'part'
    (fullTime false), 'exempt' (a part-timer whose lone day cannot be avoided: part_timer_exempt) or
    'legacy' (no fullTime flag: the pre-Part 6 counting)."""
    meetings: Dict[str, List[Tuple[str, int]]] = {}
    for d in demands:
        ref = d.get("facultyRef")
        if ref and d.get("classType") != "OJT":
            meetings.setdefault(ref, []).append((d["meetingGroup"], int(d["durationSlots"])))
    out: Dict[str, str] = {}
    for f in faculty:
        ref = f["facultyRef"]
        full = f.get("fullTime")
        if full is True:
            out[ref] = "full"
        elif full is False:
            out[ref] = "exempt" if part_timer_exempt(meetings.get(ref, []), policy) else "part"
        else:
            out[ref] = "legacy"
    return out


class Evaluator:
    """Precomputes the request once; evaluate() then scores any aligned list of genes."""

    def __init__(self, request: Dict[str, Any]):
        self.policy = request["policy"]
        self.demands: List[Dict[str, Any]] = list(request.get("demands") or [])
        self.index = {d["demandId"]: i for i, d in enumerate(self.demands)}
        self.rooms = {r["roomId"]: r for r in request.get("rooms") or []}
        self.faculty = {f["facultyRef"]: f for f in request.get("faculty") or []}
        weights = self.policy.get("softWeights") or {}
        self.weights = {
            "SAT_BLOCK": float(weights.get("saturdayBlock") or 0),
            "LEC_IN_LAB": float(weights.get("lectureInLab") or 0),
            "EXTRA_ROOM": float(weights.get("overflowRoomBlock") or 0),
            "SECTION_IDLE": float(weights.get("sectionGapHour") or 0),
            "FACULTY_IDLE": float(weights.get("facultyGapHour") or 0),
            "TBA_ROOM": float(weights.get("tbaRoomUsed") or 0),
            "EARLY_START": float(weights.get("earlyStart") or 0),
            "FACULTY_SINGLE_DAY": float(weights.get("facultySingleClassDay") or 0),
            "FACULTY_SINGLE_DAY_FT": float(weights.get("fullTimerSingleClassDay") or 0),
            "SECTION_SINGLE_DAY": float(weights.get("sectionSingleClassDay") or 0),
        }
        self.early_before = early_start_slot_of(self.policy)
        self.windows = self.policy.get("dayWindows") or {}
        self.lunch = self.policy.get("lunch") or {}
        self.lunch_slots = int(self.lunch.get("minFreeSlots") or 0) if self.lunch.get("enabled") else 0
        self.slot_hours = float(self.policy.get("slotMinutes") or 30) / 60
        self.lec_in_lab_on = self.policy.get("majorLectureInLab") != "FREE"
        self.room_windows = {rid: r.get("availability") or [] for rid, r in self.rooms.items()}
        self.extra_rooms = {rid for rid, r in self.rooms.items() if r.get("extra")}
        self.unavailable = {ref: f.get("unavailable") or [] for ref, f in self.faculty.items()}
        # Phase 8 (odd and even weeks): each demand's week group, read only while the switch is on.
        # wg[i] is None for a class that meets every week (it clashes with both groups).
        self.week_groups_on = self.policy.get("weekGroupsEnabled") is True
        self.wg = [d.get("weekGroup") if self.week_groups_on else None for d in self.demands]
        # Phase 8 Part 6 (decision 5a): each professor's single-class-day class - 'full' | 'part' |
        # 'exempt' (a part-timer whose lone day cannot be avoided: part_timer_exempt) | 'legacy' (no
        # fullTime flag on the faculty entry: the pre-Part 6 counting). engine3_ga mirrors it.
        self.fac_class: Dict[str, str] = faculty_classes(list(self.faculty.values()), self.demands, self.policy)
        # Phase 8 Part 6 (decision 5c): HC10 while the request's policy carries the rule.
        self.part_single_hard = self.policy.get("partTimerSingleDayHard") is True

    def cross_group(self, ia: int, ib: int) -> bool:
        """True when two demands are in different week groups, so they may share a room."""
        a, b = self.wg[ia], self.wg[ib]
        return a is not None and b is not None and a != b

    def soft_from_counts(self, counts: Dict[str, float]) -> Dict[str, float]:
        """{term: weight x count} for the nine soft terms, plus their total (summed in SOFT_TERMS
        order). counts: saturdayBlocks, lecturesInLab, extraRoomBlocks (blocks), sectionIdleSlots,
        facultyIdleSlots (slots), tbaRoomsUsed (rooms), earlyStarts (blocks), facultySingleDays and
        sectionSingleDays (weekdays with exactly one class meeting, Phase 8 Part 5)."""
        soft = {
            "SAT_BLOCK": self.weights["SAT_BLOCK"] * counts["saturdayBlocks"],
            "LEC_IN_LAB": self.weights["LEC_IN_LAB"] * counts["lecturesInLab"],
            "EXTRA_ROOM": self.weights["EXTRA_ROOM"] * counts["extraRoomBlocks"],
            "SECTION_IDLE": self.weights["SECTION_IDLE"] * (counts["sectionIdleSlots"] * self.slot_hours),
            "FACULTY_IDLE": self.weights["FACULTY_IDLE"] * (counts["facultyIdleSlots"] * self.slot_hours),
            "TBA_ROOM": self.weights["TBA_ROOM"] * counts.get("tbaRoomsUsed", 0),
            "EARLY_START": self.weights["EARLY_START"] * counts.get("earlyStarts", 0),
            "FACULTY_SINGLE_DAY": self.weights["FACULTY_SINGLE_DAY"]
            * (counts.get("facultySingleDaysLegacy", counts.get("facultySingleDays", 0)) + counts.get("facultySingleDaysPart", 0))
            + self.weights["FACULTY_SINGLE_DAY_FT"] * counts.get("facultySingleDaysFull", 0),
            "SECTION_SINGLE_DAY": self.weights["SECTION_SINGLE_DAY"] * counts.get("sectionSingleDays", 0),
        }
        total = 0.0
        for term in SOFT_TERMS:
            total += soft[term]
        soft["total"] = total
        return soft

    # ------------------------------------------------------------------------------------------
    def evaluate(self, genes: Sequence[Optional[Gene]], with_violations: bool = False) -> Dict[str, Any]:
        """genes[i] is demand i's (day, startSlot, roomId), or None when that demand is not placed."""
        hard: Dict[str, int] = defaultdict(int)
        violations: List[Dict[str, Any]] = []
        saturday_blocks = 0
        lectures_in_lab = 0
        extra_blocks = 0
        extra_rooms_used = set()
        early_starts = 0
        early_before = self.early_before

        def add(code: str, demand_ids: List[str], message: str) -> None:
            hard[code] += 1
            if with_violations:
                violations.append({"code": code, "demandIds": demand_ids, "message": message})

        by_room = defaultdict(list)
        by_faculty = defaultdict(list)
        by_section = defaultdict(list)
        by_group = defaultdict(list)
        # Phase 8 Part 8 (decision 4): an outside teacher's (outsideTeacher, day) - a key of its own,
        # never a facultyRef: the clash (in any week group) and the lunch hour only.
        by_outside = defaultdict(list)

        for i, gene in enumerate(genes):
            if gene is None:
                continue
            d = self.demands[i]
            day, start, room_id = gene
            end = start + d["durationSlots"]
            did = d["demandId"]
            label = f"{d['subjectCode']} {d['classType']} ({d['sectionCode']})" if with_violations else ""
            room = self.rooms.get(room_id) if room_id is not None else None

            # HC2 (a lecture held online, Phase 3 Step 7, is a meeting with no room types)
            allowed = d.get("allowedRoomTypes") or []
            if not allowed:
                if room_id is not None:
                    add("HC2_ROOM_TYPE", [did], f"{label} is online, so it takes no room." if d.get("online") else f"{label} needs no room but was given one.")
            elif room_id is None:
                add("HC2_ROOM_TYPE", [did], f"{label} needs a {' or '.join(allowed)} room but has none.")
            elif room is None or room["roomType"] not in allowed:
                add("HC2_ROOM_TYPE", [did], f"{label} is in a room of the wrong type.")

            # HC4 faculty
            ref = d.get("facultyRef")
            if ref is not None and any(w["day"] == day and start < w["endSlot"] and w["startSlot"] < end
                                       for w in self.unavailable.get(ref, ())):
                add("HC4_FACULTY_UNAVAILABLE", [did], f"{label}: the professor is unavailable then ({day}).")
            # HC4 room windows
            if room is not None:
                windows = self.room_windows.get(room_id) or []
                if windows and not any(w["day"] == day and w["startSlot"] <= start and end <= w["endSlot"] for w in windows):
                    add("HC4_ROOM_UNAVAILABLE", [did], f"{label}: {room['roomName']} is not available then ({day}).")
            # HC4 day
            if day not in (d.get("allowedDays") or ()):
                add("HC4_DAY_NOT_ALLOWED", [did], f"{label} is on {day}, which is not allowed for it.")
            # HC6
            if (self.policy.get("enforceCapacity") and room is not None and room.get("capacity") is not None
                    and d.get("sectionSize") is not None and room["capacity"] < d["sectionSize"]):
                add("HC6_CAPACITY", [did], f"{label}: {room['roomName']} is smaller than the section.")
            # HC8
            w = self.windows.get(day)
            if w is None or start < w["startSlot"] or end > w["endSlot"]:
                add("HC8_WINDOW", [did], f"{label} does not fit inside the {day} window.")
            # HC9
            starts = d.get("allowedStarts")
            if starts and start not in starts:
                add("HC9_LAB_START", [did], f"{label} starts at a time labs may not start.")

            # Soft counts
            if day == "Saturday" and not d.get("fixed"):
                saturday_blocks += 1
            if d["classType"] == "LEC" and not d.get("isMinor") and room is not None and room["roomType"] == "LAB" and self.lec_in_lab_on:
                lectures_in_lab += 1
            if room_id in self.extra_rooms:
                extra_blocks += 1
                extra_rooms_used.add(room_id)
            if early_before is not None and not d.get("fixed") and start < early_before:
                early_starts += 1

            block = (start, end, i)
            if room_id is not None:
                by_room[(room_id, day)].append(block)
            if ref is not None:
                by_faculty[(ref, day)].append(block)
            outside = d.get("outsideTeacher")
            if outside is not None:
                by_outside[(outside, day)].append(block)
            if d.get("sectionId") is not None:
                by_section[(d["sectionId"], day)].append(block)
            by_group[(d["meetingGroup"], day)].append(block)

        # HC3 clashes: one per overlapping pair. Phase 8: a ROOM pair of two different week groups is
        # allowed (cross_group), professor and section pairs always count.
        for code, groups in (("HC3_ROOM_CLASH", by_room), ("HC3_FACULTY_CLASH", by_faculty), ("HC3_FACULTY_CLASH", by_outside), ("HC3_SECTION_CLASH", by_section)):
            for (_, day), blocks in groups.items():
                if len(blocks) < 2:
                    continue
                blocks = sorted(blocks)
                for a in range(len(blocks)):
                    for b in range(a + 1, len(blocks)):
                        if blocks[b][0] >= blocks[a][1]:
                            break
                        ia, ib = blocks[a][2], blocks[b][2]
                        if code == "HC3_ROOM_CLASH" and self.cross_group(ia, ib):
                            continue
                        add(code, [self.demands[ia]["demandId"], self.demands[ib]["demandId"]],
                            f"Double-booked on {day}: {self.demands[ia]['subjectCode']} and {self.demands[ib]['subjectCode']}.")

        # HC7: meetings of one subject for one section on the same day.
        if self.policy.get("sameSubjectDifferentDays"):
            for (_, day), blocks in by_group.items():
                n = len(blocks)
                for a in range(n):
                    for b in range(a + 1, n):
                        ia, ib = blocks[a][2], blocks[b][2]
                        add("HC7_SAME_DAY", [self.demands[ia]["demandId"], self.demands[ib]["demandId"]],
                            f"{self.demands[ia]['subjectCode']} ({self.demands[ia]['sectionCode']}) meets twice on {day}.")

        # HC1 lunch: per (section, day) and (faculty, day) with at least one class.
        lunch = self.lunch
        if lunch.get("enabled"):
            for groups in (by_section, by_faculty, by_outside):
                for (_, day), blocks in groups.items():
                    if not has_free_run([(s, e) for s, e, _ in blocks], lunch["startSlot"], lunch["endSlot"], lunch["minFreeSlots"]):
                        add("HC1_LUNCH", [self.demands[i]["demandId"] for _, _, i in blocks], f"No free lunch hour on {day}.")

        # Idle time (soft), per (section, day) and (professor, day); the same groups give the
        # single-class days (Phase 8 Part 5): a weekday whose group holds exactly one class meeting,
        # OJT demands left out.
        section_idle = sum(idle_slots([(s, e) for s, e, _ in blocks], self.lunch_slots) for blocks in by_section.values())
        faculty_idle = sum(idle_slots([(s, e) for s, e, _ in blocks], self.lunch_slots) for blocks in by_faculty.values())

        def single_days_of(groups):
            days = 0
            for (_, day), blocks in groups.items():
                if day in WEEKEND_DAYS:
                    continue
                if sum(1 for _, _, i in blocks if self.demands[i].get("classType") != "OJT") == 1:
                    days += 1
            return days

        # Phase 8 Part 6 (decision 5a): the professors' single days by employment type; (5c) while
        # the rule is on, each non-exempt part-timer's lone weekday is also HC10, named by its class.
        fac_single = {"legacy": 0, "part": 0, "exempt": 0, "full": 0}
        for (ref, day), blocks in by_faculty.items():
            if day in WEEKEND_DAYS:
                continue
            counted = [i for _, _, i in blocks if self.demands[i].get("classType") != "OJT"]
            if len(counted) != 1:
                continue
            cls = self.fac_class.get(ref, "legacy")
            fac_single[cls] += 1
            if cls == "part" and self.part_single_hard:
                lone = self.demands[counted[0]]
                name = (self.faculty.get(ref) or {}).get("name") or "A part-time professor"
                add("HC10_PART_TIMER_SINGLE_DAY", [lone["demandId"]],
                    f"{name} (part-time) has only one class on {day}: {lone['subjectCode']} ({lone['sectionCode']}).")

        counts = {
            "saturdayBlocks": saturday_blocks,
            "lecturesInLab": lectures_in_lab,
            "extraRoomBlocks": extra_blocks,
            "sectionIdleSlots": section_idle,
            "facultyIdleSlots": faculty_idle,
            "tbaRoomsUsed": len(extra_rooms_used),
            "earlyStarts": early_starts,
            "facultySingleDaysLegacy": fac_single["legacy"],
            "facultySingleDaysPart": fac_single["part"],
            "facultySingleDaysFull": fac_single["full"],
            "sectionSingleDays": single_days_of(by_section),
        }
        soft = self.soft_from_counts(counts)
        hard_total = sum(hard.values())
        return {
            "hard": dict(hard),
            "hardTotal": hard_total,
            "soft": soft,
            "softCounts": {
                "saturdayBlocks": saturday_blocks,
                "lecturesInLab": lectures_in_lab,
                "extraRoomBlocks": extra_blocks,
                "sectionIdleHours": section_idle * self.slot_hours,
                "facultyIdleHours": faculty_idle * self.slot_hours,
                "tbaRoomsUsed": len(extra_rooms_used),
                "earlyStarts": early_starts,
                "facultySingleClassDays": fac_single["legacy"] + fac_single["part"] + fac_single["full"],
                "facultySingleClassDaysPartTime": fac_single["part"],
                "facultySingleClassDaysFullTime": fac_single["full"],
                "sectionSingleClassDays": counts["sectionSingleDays"],
            },
            "fitness": -(HARD_WEIGHT * hard_total + soft["total"]),
            "violations": violations,
        }

    def genes_from_placements(self, placements: Sequence[Dict[str, Any]]) -> List[Optional[Gene]]:
        """[{demandId, day, startSlot, roomId}] -> genes aligned with the demands (None = not placed)."""
        genes: List[Optional[Gene]] = [None] * len(self.demands)
        for p in placements:
            i = self.index.get(p["demandId"])
            if i is not None:
                genes[i] = (p["day"], int(p["startSlot"]), p.get("roomId"))
        return genes


def evaluate_placements(request: Dict[str, Any], placements: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The golden-case entry point: the same result shape as the gateway's evaluatePlacements."""
    ev = Evaluator(request)
    return ev.evaluate(ev.genes_from_placements(placements), with_violations=True)
