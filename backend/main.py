"""
Smart Study Calendar - API server (FastAPI)

Design principle (per project requirements): the AI never changes the user's
calendar on its own. It *proposes* a plan; the user reviews and explicitly
*commits* it. Only the committed schedule is persisted.

Run:  uvicorn main:app --reload --port 8000   (from the backend/ folder)
"""

import json
import os
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import llm
from engine import (
    DAYS,
    SLOTS,
    FocusModel,
    ScheduleOptimizer,
    _deadline_end,
    _is_manual_block,
    _is_reserved_block,
    _is_skipped_block,
    _reserved_block,
    _slot_datetimes,
)

app = FastAPI(title="Smart Study Calendar API", version="0.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

model = FocusModel()

TASKS_PATH = os.path.join(os.path.dirname(__file__), "tasks.json")
COMMITTED_PATH = os.path.join(os.path.dirname(__file__), "committed_schedule.json")


def _load_json(path, default):
    if os.path.exists(path):
        try:
            return json.load(open(path))
        except (json.JSONDecodeError, OSError):
            return default
    return default


def _save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=1)


# ---------- models ----------
class Task(BaseModel):
    id: int | str
    title: str
    course: str
    deadline: str | None = None
    estimatedHours: float = 1.5
    difficulty: str = "Medium"
    priority: str = "Medium"
    status: str = "Not started"


class Preferences(BaseModel):
    focusWindow: str = "morning"
    maxBlocksPerDay: int = 3
    maxBlockDuration: float = 1.5
    weekStart: str | None = None


class ProposeRequest(BaseModel):
    tasks: list[Task]
    preferences: Preferences = Field(default_factory=Preferences)
    committedSchedule: dict | None = None


class TasksRequest(BaseModel):
    tasks: list[Task]


class CommitRequest(BaseModel):
    schedule: dict  # day -> slot -> block | null


class FeedbackEvent(BaseModel):
    day: str
    slot: str
    completed: bool


class ExplainRequest(BaseModel):
    schedule: dict
    question: str | None = None


# ---------- helpers ----------
def _generated_block_fits_window(block: dict, day: str, slot: str, tasks_by_id: dict[str, dict]) -> bool:
    if _is_manual_block(block) or block.get("status") == "Completed" or _is_skipped_block(block):
        return True

    task = tasks_by_id.get(str(block.get("taskId")))
    if not task:
        return False

    slot_start, slot_end = _slot_datetimes(day, slot, ScheduleOptimizer._monday(None))
    if slot_start < datetime.now():
        return False

    deadline_end = _deadline_end(block.get("deadline") or task.get("deadline"))
    if deadline_end and slot_end > deadline_end:
        return False

    return True


def _locked_schedule(grid: dict | None, tasks: list[dict] | None = None) -> dict:
    tasks_by_id = {str(task.get("id")): task for task in (tasks or [])}
    locked = {d: {} for d in DAYS}
    for d in DAYS:
        for s, b in (grid or {}).get(d, {}).items():
            if not _is_reserved_block(b):
                continue
            if not _generated_block_fits_window(b, d, s, tasks_by_id):
                continue
            locked[d][s] = _reserved_block(b, d, s)
    return locked


def _proposal_protected_task_parts(grid: dict | None, tasks: list[dict] | None = None) -> dict[str, list[int]]:
    task_ids = {str(task.get("id")) for task in (tasks or [])}
    parts: dict[str, set[int]] = {}
    for d in DAYS:
        for _s, b in (grid or {}).get(d, {}).items():
            if not b or _is_manual_block(b):
                continue
            if not (_is_reserved_block(b) or _is_skipped_block(b)):
                continue
            task_id = str(b.get("taskId"))
            if task_id not in task_ids:
                continue
            try:
                part = int(b.get("part", 1))
            except (TypeError, ValueError):
                part = 1
            parts.setdefault(task_id, set()).add(part)
    return {task_id: sorted(values) for task_id, values in parts.items()}


def _plan_list(grid: dict) -> list[dict]:
    out = []
    for d in DAYS:
        day_grid = grid.get(d) or {}
        for s, b in day_grid.items():
            if not b:
                continue
            sb = b.get("scoreBreakdown", {}) or {}
            out.append({
                "day": d, "time": s, "course": b.get("course"),
                "difficulty": b.get("difficulty"),
                "p": sb.get("p_complete"),
                "days_to_deadline": sb.get("days_to_deadline"),
                "part": f"{b.get('part', 1)}/{b.get('parts', 1)}",
            })
    return out


# ---------- endpoints ----------
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "engine": "bayes-optimizer-llm-0.5",
        "llmAvailable": llm.llm_available(),
    }


@app.post("/api/schedule/propose")
def propose(req: ProposeRequest):
    """Compute a PROPOSED plan. Does not persist - the user must approve it."""
    prefs = req.preferences.model_dump()
    task_payload = [t.model_dump() for t in req.tasks]
    locked = _locked_schedule(req.committedSchedule, task_payload)
    prefs["lockedSchedule"] = locked
    prefs["lockedTaskParts"] = _proposal_protected_task_parts(req.committedSchedule, task_payload)
    opt = ScheduleOptimizer(model, prefs)
    assignment, unplaced, score = opt.solve(task_payload)

    grid = {d: {s: None for s in SLOTS} for d in DAYS}
    for d in DAYS:
        for s, b in locked[d].items():
            grid[d][s] = b

    for (d, s), b in assignment.items():
        if b is None:
            continue
        if grid[d].get(s):
            continue
        grid[d][s] = {
            "taskId": b.task_id, "title": b.title, "course": b.course,
            "difficulty": b.difficulty, "priority": b.priority,
            "deadline": b.deadline,
            "part": b.part, "parts": b.parts, "status": "Proposed",
            "explanation": b.explanation, "scoreBreakdown": b.score_breakdown,
        }

    summary, source = llm.explain(_plan_list(grid))
    return {
        "proposal": grid,
        "unplacedBlocks": len(unplaced),
        "objectiveScore": score,
        "summary": summary,
        "summarySource": source,
        "message": (
            "Here is a proposed plan. Review it and approve to apply it to your calendar."
            if not unplaced else
            f"Proposed plan ready, but {len(unplaced)} block(s) did not fit - consider reducing the workload."
        ),
    }


@app.get("/api/schedule/committed")
def get_committed():
    return {"schedule": _load_json(COMMITTED_PATH, None)}


@app.put("/api/schedule/committed")
def put_committed(req: CommitRequest):
    """Persist the schedule the user explicitly approved."""
    _save_json(COMMITTED_PATH, req.schedule)
    return {"committed": True}


@app.post("/api/explain")
def explain(req: ExplainRequest):
    text, source = llm.explain(_plan_list(req.schedule), req.question)
    return {"explanation": text, "source": source}


@app.post("/api/feedback")
def feedback(ev: FeedbackEvent):
    """Record a Done/Skip. Updates the learned model only - never the calendar."""
    model.update(ev.day, ev.slot, ev.completed)
    p = model.p_complete(ev.day, ev.slot)
    msg = (
        f"Logged. {ev.day} {ev.slot} -> {int(p*100)}% expected completion. "
        "Your calendar is unchanged; generate a new plan when you want to use this."
        if ev.completed else
        f"Logged. {ev.day} {ev.slot} -> {int(p*100)}% expected completion. "
        "Your calendar is unchanged; I'll avoid this slot for hard tasks in the next proposal."
    )
    return {"message": msg, "p": p}


@app.post("/api/feedback/undo")
def undo_feedback(ev: FeedbackEvent):
    """Undo the latest matching Done/Skip feedback event."""
    undone = model.undo_update(ev.day, ev.slot, ev.completed)
    p = model.p_complete(ev.day, ev.slot)
    return {
        "undone": undone,
        "message": (
            f"Undone. {ev.day} {ev.slot} is back to {int(p*100)}% expected completion."
            if undone else
            "No matching feedback event was found to undo."
        ),
        "p": p,
    }


@app.get("/api/model")
def get_model():
    return {"heatmap": model.heatmap(), "events": len(model.events)}


@app.post("/api/model/reset")
def reset_model():
    model.reset()
    return {"message": "Focus profile reset to prior."}


@app.get("/api/tasks")
def get_tasks():
    return {"tasks": _load_json(TASKS_PATH, [])}


@app.put("/api/tasks")
def put_tasks(req: TasksRequest):
    _save_json(TASKS_PATH, [t.model_dump() for t in req.tasks])
    return {"saved": len(req.tasks)}
