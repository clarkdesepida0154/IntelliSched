"""Background GA runs (Phase 2 Step 4): one run at a time, in a worker thread, with live progress and a
cancel flag the GA checks between generations and inside repair.

A job: {jobId, status: queued | running | done | failed | cancelled, progress: {generation, elapsedMs,
bestHard, bestSoft}, result (when done), stats (the GA's statistics when done or cancelled), error (when
failed), createdAt, startedAt, finishedAt}. While a job runs, elapsedMs is the time since it started
at every read (the GA itself reports once per generation, which can take a few seconds); generation,
bestHard and bestSoft are None until the first population is built.
Jobs live in memory: when the service restarts they are gone, and the gateway marks its runs failed.
"""
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

ACTIVE = ("queued", "running")
KEEP_FINISHED = 20


class BusyError(Exception):
    def __init__(self, job_id: str):
        super().__init__(job_id)
        self.job_id = job_id


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._events: Dict[str, threading.Event] = {}
        self._started: Dict[str, float] = {}
        self._order = []

    def start(self, make_scheduler: Callable[[threading.Event, Callable[[Dict[str, Any]], None]], Any]) -> Dict[str, Any]:
        """make_scheduler(cancel_event, progress) -> an object with run_evolution(). Raises BusyError
        when a run is queued or running."""
        with self._lock:
            for job_id in self._order:
                if self._jobs[job_id]["status"] in ACTIVE:
                    raise BusyError(job_id)
            job_id = uuid.uuid4().hex
            event = threading.Event()
            job = {"jobId": job_id, "status": "queued", "progress": None, "result": None, "stats": None, "error": None,
                   "createdAt": _now(), "startedAt": None, "finishedAt": None}
            self._jobs[job_id] = job
            self._events[job_id] = event
            self._order.append(job_id)
            self._trim()

        def progress(p: Dict[str, Any]) -> None:
            with self._lock:
                job["progress"] = dict(p)

        def work() -> None:
            with self._lock:
                job["status"] = "running"
                job["startedAt"] = _now()
                self._started[job_id] = time.monotonic()
            try:
                result = make_scheduler(event, progress).run_evolution()
                stats = result["stats"]
                with self._lock:
                    # A cancel asked for wins even when the run stopped for another reason meanwhile.
                    cancelled = stats.get("stopReason") == "cancelled" or event.is_set()
                    job["status"] = "cancelled" if cancelled else "done"
                    job["result"] = None if cancelled else result
                    job["stats"] = stats
                    if stats.get("finalHard") is not None:   # None: cancelled before the first population
                        job["progress"] = {**(job["progress"] or {}), "generation": stats["generations"],
                                           "elapsedMs": stats["runtimeMs"], "bestHard": stats["finalHard"],
                                           "bestSoft": stats["soft"]}
                    job["finishedAt"] = _now()
            except Exception as exc:  # the run failed: say so, never pretend it finished
                with self._lock:
                    job["status"] = "failed"
                    job["error"] = f"The GA stopped with an error: {exc}"
                    job["finishedAt"] = _now()

        threading.Thread(target=work, name=f"ga-job-{job_id[:8]}", daemon=True).start()
        return self.get(job_id)

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            out = dict(job)
            if job["status"] == "running" and job_id in self._started:
                base = job["progress"] or {"generation": None, "bestHard": None, "bestSoft": None}
                out["progress"] = {**base, "elapsedMs": round((time.monotonic() - self._started[job_id]) * 1000)}
            return out

    def active(self) -> Optional[Dict[str, Any]]:
        """The job that is queued or running, if any, with its age in seconds."""
        with self._lock:
            for job_id in self._order:
                job = self._jobs[job_id]
                if job["status"] in ACTIVE:
                    started = self._started.get(job_id)
                    return {"jobId": job_id, "status": job["status"],
                            "ageSeconds": round(time.monotonic() - started, 1) if started else 0.0}
            return None

    def cancel(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job["status"] in ACTIVE:
                self._events[job_id].set()
            return dict(job)

    def _trim(self) -> None:
        finished = [j for j in self._order if self._jobs[j]["status"] not in ACTIVE]
        for job_id in finished[:-KEEP_FINISHED] if len(finished) > KEEP_FINISHED else []:
            self._order.remove(job_id)
            self._jobs.pop(job_id, None)
            self._events.pop(job_id, None)
            self._started.pop(job_id, None)
