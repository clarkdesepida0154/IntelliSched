import os
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

from config import MONGO_URI, MONGO_DB_NAME, GBDT_FEATURES, MODEL_PATH
from engine1_nlp import NLPEngine
from engine2_gbdt import GBDTEngine
from engine3_ga import DEFAULT_SETTINGS, GeneticScheduler
from engine4_retrainer import AdaptiveLearner, DecisionsUnavailable
from ml.serving import term_from_request
from ga_jobs import BusyError, JobManager

# Load Server Host and Port from environment
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 8001))

# Security: Enforce non-empty API Key at module import
def _load_admin_key() -> str:
    key = os.getenv("ADMIN_API_KEY")
    if not key or not key.strip():
        raise RuntimeError("CRITICAL: ADMIN_API_KEY environment variable is not set. Refusing to start.")
    return key.strip()

ADMIN_API_KEY = _load_admin_key()

app = FastAPI(
    title="IntelliSched Computational Microservice",
    version="5.0.0",
    description="Production-hardened AI scheduling microservice for CCS-LSPU."
)

# CORS Policy: Restrict to explicit origins defined in .env or authorized dev URLs
allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173")
origins_list = [origin.strip() for origin in allowed_origins_raw.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Authentication Guard
def verify_admin(x_api_key: str = Header(default="")):
    if x_api_key != ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid or missing API Key")

# Engine Lifespan Singletons
nlp_engine: Optional[NLPEngine] = None
gbdt_engine: Optional[GBDTEngine] = None

@app.on_event("startup")
def startup_event():
    global nlp_engine, gbdt_engine
    print("[STARTUP] Booting up IntelliSched AI Engines...")
    nlp_engine = NLPEngine(mongo_uri=MONGO_URI)
    gbdt_engine = GBDTEngine(model_path=MODEL_PATH)
    print(f"[STARTUP] Microservice ready on http://{HOST}:{PORT}")

# Request / Response Schemas
class SubjectItem(BaseModel):
    subjectCode: str = Field(..., alias="subject_code")
    subjectTitle: str = Field(..., alias="subject_title")
    subjectDescription: str = Field(..., alias="subject_description")
    # Phase 5: the catalog id (the teaching history is matched by it) and the programs whose sections
    # take the subject this term (program_experience). Both optional: an older caller sends neither.
    subjectId: Optional[str] = Field(default=None, alias="subject_id")
    programs: List[str] = Field(default_factory=list)

    class Config:
        populate_by_name = True

class RecommendationRequest(BaseModel):
    subjects: List[SubjectItem]
    facultyLimits: Optional[Dict[str, float]] = Field(default_factory=dict, alias="faculty_limits")
    # Phase 5: the term the ranking is for ("2026-2027", 2): the history features count the terms before
    # it. Without it every stored term counts as earlier and no term is "last same semester".
    academicYear: Optional[str] = Field(default=None, alias="academic_year")
    semester: Optional[int] = None

    class Config:
        populate_by_name = True

# ---- Engine 3 request (Phase 1 Step 6). Everything is in slots from the policy's grid origin. ----
DayName = Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
Slot = Annotated[int, Field(ge=0, le=48)]


class SlotWindow(BaseModel):
    startSlot: Slot
    endSlot: Slot

    @model_validator(mode="after")
    def _start_before_end(self):
        if self.startSlot >= self.endSlot:
            raise ValueError("startSlot must be before endSlot")
        return self


class DaySlotWindow(SlotWindow):
    day: DayName


class LunchRule(BaseModel):
    enabled: bool
    startSlot: Slot
    endSlot: Slot
    minFreeSlots: Annotated[int, Field(ge=0, le=48)]


class SoftWeights(BaseModel):
    model_config = ConfigDict(extra="allow")
    saturdayBlock: Annotated[float, Field(ge=0)] = 0
    lectureInLab: Annotated[float, Field(ge=0)] = 0
    # Phase 2: a class in an extra room, and idle hours in a section's or a professor's day.
    overflowRoomBlock: Annotated[float, Field(ge=0)] = 0
    sectionGapHour: Annotated[float, Field(ge=0)] = 0
    facultyGapHour: Annotated[float, Field(ge=0)] = 0
    # Phase 4 Part 1: each TBA room that holds a class, and each class before the preferred earliest start.
    tbaRoomUsed: Annotated[float, Field(ge=0)] = 0
    earlyStart: Annotated[float, Field(ge=0)] = 0


class GaPolicy(BaseModel):
    slotMinutes: Annotated[int, Field(gt=0, le=60)]
    origin: Optional[str] = None
    dayWindows: Dict[DayName, SlotWindow]
    lunch: LunchRule
    sameSubjectDifferentDays: bool
    majorLectureInLab: Literal["NEVER", "PENALTY", "FREE"]
    enforceCapacity: bool
    softWeights: SoftWeights
    # Phase 4 Part 1: a non-fixed block that starts before this slot costs the earlyStart penalty
    # (the gateway's preferredEarliestStart, in slots from the grid origin); None counts nothing.
    preferredEarliestStartSlot: Optional[Slot] = None
    # Phase 8 (odd and even weeks): while True, a room clash counts only between classes of the same
    # week group (DemandItem.weekGroup). Absent on requests built before, which read as False.
    weekGroupsEnabled: bool = False
    # Phase 8 Part 6 (decision 5c): while True, a part-timer's weekday with exactly one class meeting
    # is a hard conflict (HC10). Absent on requests built before, which read as False. Declared here
    # because the model drops undeclared keys.
    partTimerSingleDayHard: bool = False
    seed: Optional[int] = None


class FacultyItem(BaseModel):
    facultyRef: str
    name: str
    # Phase 8 Part 6 (decision 5a): False = a part-timer (the part-timers' single-class-day weight
    # and the fewer-than-two-meetings exemption), True = a full-timer (fullTimerSingleClassDay),
    # None = a request built before Part 6 (the old counting). It must be declared: the model drops
    # undeclared keys.
    fullTime: Optional[bool] = None
    unavailable: List[DaySlotWindow] = Field(default_factory=list)


class RoomItem(BaseModel):
    roomId: str
    roomName: str
    roomType: Literal["LEC", "LAB"]
    capacity: Optional[Annotated[int, Field(ge=1)]] = None
    availability: List[DaySlotWindow] = Field(default_factory=list)
    # Phase 2: a virtual room the Dean must request from outside CCS (roomId EXTRA-LAB-n or
    # EXTRA-LEC-n). Used like any room of its type, with the EXTRA_ROOM soft penalty per class.
    extra: bool = False


class FixedStart(BaseModel):
    day: DayName
    startSlot: Slot


class DemandItem(BaseModel):
    demandId: str
    subjectId: str
    subjectCode: str
    sectionId: str
    sectionCode: str
    sectionSize: Optional[Annotated[int, Field(ge=1)]] = None
    classType: Literal["LEC", "LAB"]
    meetingGroup: str
    durationSlots: Annotated[int, Field(ge=1, le=48)]
    facultyRef: Optional[str] = None
    isMinor: bool
    requiresRoom: bool
    allowedRoomTypes: List[Literal["LEC", "LAB"]]
    allowedDays: List[DayName]
    allowedStarts: Optional[List[Slot]] = None
    fixed: Optional[FixedStart] = None
    # Phase 3 Step 7: a Major lecture held online (a day and a time, no room). The GA treats it like any
    # demand with no room types: no room key, so no room clash; section and professor time, the lunch
    # rule, same-day and idle time still apply. Labs always stay on campus.
    online: bool = False
    # Phase 8 (odd and even weeks): the section's week group. None = the class meets every week.
    weekGroup: Optional[Literal["ODD", "EVEN"]] = None
    # Phase 8 Part 8 (decision 4): a GenEd class taught by an outside teacher (another college's), keyed
    # apart from facultyRef. The GA gives that teacher two rules only: never two classes at the same
    # time (in any week group) and the lunch hour. None on every other demand.
    outsideTeacher: Optional[str] = None

    @model_validator(mode="after")
    def _online_is_a_major_lecture_without_a_room(self):
        if self.online:
            if self.classType != "LEC":
                raise ValueError("online: only a lecture can be held online (labs stay on campus)")
            if self.isMinor:
                raise ValueError("online: only a Major lecture can be held online")
            if self.allowedRoomTypes:
                raise ValueError("online: an online lecture takes no room (allowedRoomTypes must be empty)")
        if self.outsideTeacher is not None and (self.facultyRef is not None or not self.isMinor):
            raise ValueError("outsideTeacher: only a GenEd (Minor) class without a CCS professor has an outside teacher")
        return self


class SchedulePayload(BaseModel):
    policy: GaPolicy
    faculty: List[FacultyItem] = Field(default_factory=list)
    rooms: List[RoomItem]
    demands: List[DemandItem]
    # GA settings forwarded by the Express gateway (see ga_settings: mode, populationSize,
    # mutationRate, crossoverRate, repairRate, tournamentSize, elitism, timeBudgetSeconds,
    # maxGenerations, seed).
    hyperparameters: Optional[Dict[str, Any]] = Field(default_factory=dict)


# GA hyperparameter coercion. A missing or unusable value falls back to the GeneticScheduler
# default; values are clamped to what run_evolution can execute (population >= 2, at least one
# generation, mutation probability within 0..1).
def _hp_int(source: Dict[str, Any], key: str, default: int, minimum: int, maximum: Optional[int] = None) -> int:
    try:
        value = int(round(float(source.get(key, default))))
    except (TypeError, ValueError, OverflowError):  # OverflowError: Infinity
        value = default
    value = max(minimum, value)
    return min(maximum, value) if maximum is not None else value

def _hp_float(source: Dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(source.get(key, default))
    except (TypeError, ValueError):
        return default
    if value != value:  # NaN
        return default
    return min(high, max(low, value))

# API Endpoints
@app.get("/api/health")
async def health_check():
    return {
        "status": "online",
        "engines": {
            "nlp_engine": "loaded" if nlp_engine else "uninitialized",
            "gbdt_engine": "loaded" if gbdt_engine else "uninitialized",
            "genetic_scheduler": "ready",
            "adaptive_learner": "ready"
        },
        "host": HOST,
        "port": PORT,
        # The database name only (never the URI): the gateway's E2E checks require one ending in _test.
        "database": MONGO_DB_NAME
    }

@app.post("/api/get_recommendations", dependencies=[Depends(verify_admin)])
async def get_recommendations(payload: RecommendationRequest):
    if not nlp_engine or not gbdt_engine:
        raise HTTPException(status_code=503, detail="AI Engines not fully initialized.")

    try:
        results = []
        term = term_from_request(payload.academicYear, payload.semester)
        for subj in payload.subjects:
            semantic_scores = nlp_engine.get_semantic_scores(subj.subjectTitle, subj.subjectDescription)
            candidates = gbdt_engine.predict_best_faculty(
                semantic_scores=semantic_scores,
                faculty_roster=nlp_engine.faculty_roster,
                faculty_limits=payload.facultyLimits or {},
                subject={"id": subj.subjectId, "code": subj.subjectCode, "title": subj.subjectTitle},
                term=term,
                programs=subj.programs,
            )
            results.append({
                "subjectCode": subj.subjectCode,
                "candidates": candidates
            })

        return {"status": "success", "predictions": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Recommendation pipeline failed: {str(e)}")

@app.post("/api/sync_roster", dependencies=[Depends(verify_admin)])
def sync_roster():
    # Engines 1 and 2 read the faculty roster from an in-memory copy loaded at startup. The Express
    # gateway calls this after every Faculty create, update and enable/disable so edits take effect
    # without restarting the service. A plain `def` so FastAPI runs the blocking Atlas read in its
    # threadpool instead of on the event loop.
    # Answers {status, loaded, skipped: [{facultyId, reason}]}; status "error" keeps the last good roster.
    if not nlp_engine:
        raise HTTPException(status_code=503, detail="Engine 1 is not initialized.")
    return nlp_engine.load_faculty_from_db()

# The GA settings contract (Phase 2 Step 3): what the gateway may send in hyperparameters, clamped to
# what the GA can run. Anything missing or unusable takes engine3_ga.DEFAULT_SETTINGS. The stop is the
# time budget (at most 10 minutes) or the 1000-generation cap ("generations" is read as the cap too,
# for older callers).
MAX_TIME_BUDGET_SECONDS = 600
MAX_GENERATIONS = 1000


def ga_settings(hp: Dict[str, Any]) -> Dict[str, Any]:
    d = DEFAULT_SETTINGS
    cap_source = hp if "maxGenerations" in hp else {"maxGenerations": hp.get("generations", d["maxGenerations"])}
    return {
        "mode": hp.get("mode") if hp.get("mode") in ("memetic", "baseline") else d["mode"],
        "populationSize": _hp_int(hp, "populationSize", d["populationSize"], 2, 500),
        "mutationRate": _hp_float(hp, "mutationRate", d["mutationRate"], 0.0, 1.0),
        "crossoverRate": _hp_float(hp, "crossoverRate", d["crossoverRate"], 0.0, 1.0),
        "repairRate": _hp_float(hp, "repairRate", d["repairRate"], 0.0, 1.0),
        "tournamentSize": _hp_int(hp, "tournamentSize", d["tournamentSize"], 2, 10),
        "elitism": _hp_int(hp, "elitism", d["elitism"], 0, 10),
        "timeBudgetSeconds": _hp_float(hp, "timeBudgetSeconds", d["timeBudgetSeconds"], 1.0, MAX_TIME_BUDGET_SECONDS),
        "maxGenerations": _hp_int(cap_source, "maxGenerations", d["maxGenerations"], 1, MAX_GENERATIONS),
    }


def build_scheduler(payload: SchedulePayload, cancel_event: Any = None, progress: Any = None) -> GeneticScheduler:
    """The GA for one validated request (used by the job endpoints and by tests/run_ga_json.py)."""
    hp = payload.hyperparameters or {}
    seed = payload.policy.seed if payload.policy.seed is not None else hp.get("seed")
    return GeneticScheduler(
        request=payload.model_dump(),
        seed=_hp_int({"seed": seed}, "seed", 0, 0) if seed is not None else None,
        settings=ga_settings(hp),
        cancel_event=cancel_event,
        progress=progress,
    )


# GA runs are background jobs (Phase 2 Step 4): one at a time, in a worker thread, with live progress
# and a cancel flag the GA checks between generations and inside repair (it stops within 2 seconds).
# The gateway starts a job, follows it every second and saves the result itself; no call waits for a
# whole run. A job's result is run_evolution()'s answer: {items, stats}.
jobs = JobManager()
UNKNOWN_JOB = "No GA run with that id: the service may have restarted since it started."


@app.post("/api/ga/jobs", status_code=202, dependencies=[Depends(verify_admin)])
def start_ga_job(payload: SchedulePayload):
    try:
        job = jobs.start(lambda cancel_event, progress: build_scheduler(payload, cancel_event, progress))
    except BusyError:
        # Names the job that is going, so the gateway can stop one that no run record follows.
        active = jobs.active() or {}
        raise HTTPException(status_code=409, detail={
            "message": "A GA run is already going. Wait for it to finish, or cancel it, before starting another.",
            "jobId": active.get("jobId"), "ageSeconds": active.get("ageSeconds")})
    return {k: job[k] for k in ("jobId", "status", "createdAt")}


@app.get("/api/ga/jobs/{job_id}", dependencies=[Depends(verify_admin)])
def get_ga_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_JOB)
    return job


@app.post("/api/ga/jobs/{job_id}/cancel", dependencies=[Depends(verify_admin)])
def cancel_ga_job(job_id: str):
    job = jobs.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_JOB)
    return {k: job[k] for k in ("jobId", "status")}

@app.post("/api/retrain", dependencies=[Depends(verify_admin)])
async def trigger_retraining():
    try:
        learner = AdaptiveLearner(model_path=MODEL_PATH, mongo_uri=MONGO_URI)
        report = await run_in_threadpool(learner.retrain_and_save)

        # Hot-reload the GBDT engine into memory if update was approved
        if report.get("status") == "success" and gbdt_engine:
            gbdt_engine.reload_model()

        return report
    except DecisionsUnavailable as e:
        # Phase 4 Part 4: the decisions could not be read: plain words, 503, never "no decisions".
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Retraining operation failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    # reload stays off: uvicorn's polling reloader rescans every .py file under this folder,
    # including .venv, and on Windows that scan fails with WinError 1450 ("Insufficient system
    # resources"), which first broke hot-reload and then killed the server.
    uvicorn.run("main:app", host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", 8001)), reload=False)