"""
Smart Study Calendar - Scheduling Engine
=========================================
Two intelligent components:

1. FocusModel  - a Bayesian user model. For every (day, time-slot) cell of the
   week it keeps a Beta(alpha, beta) distribution over the probability that the
   user successfully completes a study block placed there. Every "Completed" /
   "Skipped" feedback event is a Bernoulli observation that updates the model.
   (Same family of models as the Bayesian touch/typing models from the lecture.)

2. ScheduleOptimizer - turns tasks into 90-minute study blocks and assigns them
   to calendar slots by maximising a utility function (deadline pressure,
   learned focus probability, user preferences, workload balance, spacing) via
   greedy construction + stochastic local search (hill climbing with swaps).
"""

from __future__ import annotations

import json
import math
import os
import random
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
SLOTS = ["09:00-10:30", "10:30-12:00", "14:00-15:30", "16:00-17:30", "19:00-20:30"]
SLOT_PERIOD = {  # coarse time-of-day category per slot index
    0: "morning", 1: "morning", 2: "afternoon", 3: "afternoon", 4: "evening",
}
BLOCK_HOURS = 1.5
MODEL_PATH = os.path.join(os.path.dirname(__file__), "user_model.json")

DIFFICULTY = {"Easy": 1, "Medium": 2, "Hard": 3}
PRIORITY = {"Low": 1, "Medium": 2, "High": 3}


# --------------------------------------------------------------------------
# 1. Bayesian user model
# --------------------------------------------------------------------------
class FocusModel:
    """Hierarchical Beta-Bernoulli model of per-slot completion probability.

    v2 (Milestone 4): each cell keeps raw event counts (succ, fail). Cells
    share statistical strength within their time-of-day period (morning /
    afternoon / evening): the cell estimate is shrunk towards the pooled
    period estimate with TAU pseudo-counts. This softens the cold-start
    problem - one good Tuesday morning already nudges all morning cells.
    """

    TAU = 4.0  # shrinkage strength (pseudo-counts towards the pooled estimate)
    PERIOD_PRIOR = {  # weak prior per period: (alpha0, beta0)
        "morning": (3.0, 2.0),     # gentle morning bias for cold start
        "afternoon": (2.0, 2.0),
        "evening": (2.0, 2.5),
    }

    def __init__(self, path: str | None = MODEL_PATH, pool_strength: float | None = None):
        self.path = path
        if pool_strength is not None:
            self.TAU = pool_strength
        self.cells: dict[str, dict[str, float]] = {}
        self.events: list[dict] = []
        self._init_cells()
        self.load()

    @staticmethod
    def key(day: str, slot: str) -> str:
        return f"{day}|{slot}"

    @staticmethod
    def period_of(slot: str) -> str:
        if slot in SLOTS:
            return SLOT_PERIOD[SLOTS.index(slot)]
        try:
            hour = int(slot.split("-")[0].split(":")[0])
        except (ValueError, IndexError):
            return "afternoon"
        if hour < 12:
            return "morning"
        if hour < 18:
            return "afternoon"
        return "evening"

    def _init_cells(self):
        for d in DAYS:
            for s in SLOTS:
                self.cells[self.key(d, s)] = {"succ": 0.0, "fail": 0.0}

    # --- pooled (period-level) estimate ----------------------------------
    def _pool(self, period: str) -> float:
        a0, b0 = self.PERIOD_PRIOR[period]
        succ = sum(c["succ"] for k, c in self.cells.items()
                   if self.period_of(k.split("|")[1]) == period)
        fail = sum(c["fail"] for k, c in self.cells.items()
                   if self.period_of(k.split("|")[1]) == period)
        return (succ + a0) / (succ + fail + a0 + b0)

    def _posterior(self, day: str, slot: str) -> tuple[float, float]:
        """Effective Beta(alpha, beta) for a cell after shrinkage."""
        c = self.cells.setdefault(self.key(day, slot), {"succ": 0.0, "fail": 0.0})
        p_pool = self._pool(self.period_of(slot))
        alpha = c["succ"] + self.TAU * p_pool
        beta = c["fail"] + self.TAU * (1.0 - p_pool)
        return alpha, beta

    # --- inference -------------------------------------------------------
    def p_complete(self, day: str, slot: str) -> float:
        a, b = self._posterior(day, slot)
        return a / (a + b)

    def uncertainty(self, day: str, slot: str) -> float:
        a, b = self._posterior(day, slot)
        var = (a * b) / ((a + b) ** 2 * (a + b + 1))
        return math.sqrt(var)

    def observations(self, day: str, slot: str) -> int:
        c = self.cells.setdefault(self.key(day, slot), {"succ": 0.0, "fail": 0.0})
        return int(c["succ"] + c["fail"])

    # --- learning --------------------------------------------------------
    def update(self, day: str, slot: str, completed: bool):
        c = self.cells.setdefault(self.key(day, slot), {"succ": 0.0, "fail": 0.0})
        if completed:
            c["succ"] += 1.0
        else:
            c["fail"] += 1.0
        self.events.append({
            "day": day, "slot": slot, "completed": completed,
            "t": datetime.now().isoformat(timespec="seconds"),
        })
        self.save()

    # --- persistence -----------------------------------------------------
    def save(self):
        if not self.path:
            return
        with open(self.path, "w") as f:
            json.dump({"version": 2, "cells": self.cells, "events": self.events}, f, indent=1)

    def load(self):
        if not self.path or not os.path.exists(self.path):
            return
        try:
            data = json.load(open(self.path))
            if data.get("version") == 2:
                self.cells.update(data.get("cells", {}))
                self.events = data.get("events", [])
            else:  # migrate v1 by replaying events
                for ev in data.get("events", []):
                    c = self.cells[self.key(ev["day"], ev["slot"])]
                    c["succ" if ev["completed"] else "fail"] += 1.0
                self.events = data.get("events", [])
                self.save()
        except (json.JSONDecodeError, OSError, KeyError):
            pass

    def reset(self):
        self.events = []
        self._init_cells()
        self.save()

    def heatmap(self) -> list[dict]:
        out = []
        for d in DAYS:
            for s in SLOTS:
                n = self.observations(d, s)
                out.append({
                    "day": d, "slot": s,
                    "p": round(self.p_complete(d, s), 3),
                    "sd": round(self.uncertainty(d, s), 3),
                    "n": n,
                    "learning": n < 3,  # still relying mostly on pooled prior
                })
        return out


# --------------------------------------------------------------------------
# 2. Schedule optimisation
# --------------------------------------------------------------------------
@dataclass
class Block:
    task_id: int | str
    title: str
    course: str
    difficulty: str
    priority: str
    part: int
    parts: int
    deadline: str | None = None
    explanation: str = ""
    score_breakdown: dict = field(default_factory=dict)


def _days_until(deadline: str | None, week_monday: date) -> dict[str, int]:
    """Maps each weekday name to 'days remaining before deadline' (can be <0)."""
    res = {}
    for i, d in enumerate(DAYS):
        day_date = week_monday + timedelta(days=i)
        if deadline:
            try:
                dl = datetime.strptime(deadline, "%Y-%m-%d").date()
                res[d] = (dl - day_date).days
            except ValueError:
                res[d] = 99
        else:
            res[d] = 99
    return res


def _slot_datetimes(day: str, slot: str, week_monday: date) -> tuple[datetime, datetime]:
    day_date = week_monday + timedelta(days=DAYS.index(day))
    start_text, end_text = slot.split("-")
    start_hour, start_minute = [int(part) for part in start_text.split(":")]
    end_hour, end_minute = [int(part) for part in end_text.split(":")]
    start = datetime.combine(day_date, datetime.min.time()).replace(
        hour=start_hour, minute=start_minute
    )
    end = datetime.combine(day_date, datetime.min.time()).replace(
        hour=end_hour, minute=end_minute
    )
    if end <= start:
        end += timedelta(days=1)
    return start, end


def _deadline_end(deadline: str | None) -> datetime | None:
    if not deadline:
        return None
    try:
        deadline_date = datetime.strptime(deadline, "%Y-%m-%d").date()
    except ValueError:
        return None
    return datetime.combine(deadline_date, datetime.max.time())


def _minutes(clock: str) -> int:
    hour, minute = [int(part) for part in clock.split(":")]
    return hour * 60 + minute


def _slots_overlap(first: str, second: str) -> bool:
    try:
        first_start, first_end = first.split("-")
        second_start, second_end = second.split("-")
        return _minutes(first_start) < _minutes(second_end) and _minutes(second_start) < _minutes(first_end)
    except (ValueError, IndexError):
        return first == second


def _is_manual_block(block: dict | None) -> bool:
    return str((block or {}).get("taskId", "")).startswith("manual-")


def _is_previously_moved_block(block: dict | None) -> bool:
    return "You moved this block yourself" in str((block or {}).get("explanation", ""))


def _is_stable_locked(block: dict | None) -> bool:
    if not block:
        return False
    if block.get("stableLocked") is False:
        return False
    if block.get("stableLocked") is True:
        return True
    return _is_manual_block(block) or _is_previously_moved_block(block)


def _is_reserved_block(block: dict | None) -> bool:
    return _is_stable_locked(block) or _is_manual_block(block)


def _lock_reason(block: dict) -> str:
    if block.get("lockReason"):
        return block["lockReason"]
    if _is_manual_block(block):
        return "manual"
    if _is_previously_moved_block(block):
        return "user_moved"
    return "stable"


def _reserved_block(block: dict, day: str, slot: str) -> dict:
    locked = _is_stable_locked(block)
    next_block = {
        **block,
        "day": day,
        "slot": slot,
        "stableLocked": locked,
    }
    if locked:
        next_block["lockReason"] = _lock_reason(block)
    else:
        next_block.pop("lockReason", None)
    return next_block


def _split(task: dict) -> list[Block]:
    n = max(1, math.ceil(float(task.get("estimatedHours", BLOCK_HOURS)) / BLOCK_HOURS))
    return [
        Block(
            task_id=task["id"], title=task["title"], course=task["course"],
            difficulty=task.get("difficulty", "Medium"),
            priority=task.get("priority", "Medium"),
            part=i + 1, parts=n, deadline=task.get("deadline"),
        )
        for i in range(n)
    ]


class ScheduleOptimizer:
    def __init__(self, model: FocusModel, prefs: dict | None = None):
        self.model = model
        prefs = prefs or {}
        self.focus_window = prefs.get("focusWindow", "morning")  # morning/afternoon/evening
        self.max_per_day = int(prefs.get("maxBlocksPerDay", 3))
        self.week_monday = self._monday(prefs.get("weekStart"))
        self.now = datetime.now()
        self.locked_slots = self._locked_slots(prefs.get("lockedSchedule"))
        self.locked_task_parts = self._locked_task_parts(self.locked_slots)

    @staticmethod
    def _monday(week_start: str | None) -> date:
        if week_start:
            try:
                return datetime.strptime(week_start, "%Y-%m-%d").date()
            except ValueError:
                pass
        today = date.today()
        return today - timedelta(days=today.weekday())

    # --- utility of placing a block into (day, slot) ----------------------
    def utility(self, block: Block, day: str, slot: str,
                assignment: dict[tuple[str, str], Block]) -> float:
        period = self.model.period_of(slot)
        days_left = _days_until(block.deadline, self.week_monday)[day]

        # Hard constraint: generated schedules must fit between now and deadline.
        if not self._fits_time_window(block, day, slot):
            return -1e9
        if self._overlaps_locked(day, slot):
            return -1e9

        # 1. learned focus probability, weighted by difficulty
        p = self.model.p_complete(day, slot)
        focus_term = p * (1.0 + 0.5 * (DIFFICULTY[block.difficulty] - 1))

        # 2. deadline pressure: earlier placement for urgent tasks
        urgency = PRIORITY[block.priority] * 2 + DIFFICULTY[block.difficulty]
        day_idx = DAYS.index(day)
        pressure_term = (urgency / 9.0) * (1.0 - day_idx / 7.0) * min(1.5, 3.0 / max(1, days_left))

        # 3. preference: hard tasks inside the user's focus window
        pref_term = 0.0
        if block.difficulty == "Hard":
            pref_term = 0.6 if period == self.focus_window else -0.2

        # 4. workload balance: penalise overloaded days
        load = sum(1 for (d, _s), b in assignment.items() if d == day and b is not None)
        balance_term = -0.45 * max(0, load - (self.max_per_day - 1))
        if load >= self.max_per_day:
            balance_term -= 2.0

        # 5. spacing: don't put two blocks of the same task on the same day
        same_task_today = sum(
            1 for (d, _s), b in assignment.items()
            if d == day and b is not None and b.task_id == block.task_id
        )
        spacing_term = -0.7 * same_task_today

        total = (1.4 * focus_term + 1.2 * pressure_term + pref_term
                 + balance_term + spacing_term)
        return total

    def _fits_time_window(self, block: Block, day: str, slot: str) -> bool:
        slot_start, slot_end = _slot_datetimes(day, slot, self.week_monday)
        if slot_start < self.now:
            return False
        deadline_end = _deadline_end(block.deadline)
        if deadline_end and slot_end > deadline_end:
            return False
        return True

    @staticmethod
    def _locked_slots(schedule: dict | None) -> list[tuple[str, str, dict]]:
        locked = []
        for day in DAYS:
            for slot, block in (schedule or {}).get(day, {}).items():
                if not _is_reserved_block(block):
                    continue
                locked.append((day, slot, _reserved_block(block, day, slot)))
        return locked

    def _overlaps_locked(self, day: str, slot: str) -> bool:
        return any(
            locked_day == day and _slots_overlap(locked_slot, slot)
            for locked_day, locked_slot, _block in self.locked_slots
        )

    @staticmethod
    def _locked_task_parts(locked_slots: list[tuple[str, str, dict]]) -> dict[str, set[int]]:
        parts: dict[str, set[int]] = {}
        for _day, _slot, block in locked_slots:
            task_id = block.get("taskId")
            if task_id is None or _is_manual_block(block):
                continue
            try:
                part = int(block.get("part", 1))
            except (TypeError, ValueError):
                part = 1
            parts.setdefault(str(task_id), set()).add(part)
        return parts

    # --- construction + local search --------------------------------------
    def solve(self, tasks: list[dict], iters: int = 800, seed: int = 7):
        rng = random.Random(seed)
        blocks: list[Block] = []
        for t in tasks:
            if t.get("status") == "Completed":
                continue
            locked_parts = self.locked_task_parts.get(str(t.get("id")), set())
            blocks.extend([b for b in _split(t) if b.part not in locked_parts])

        # most constrained / most urgent first
        def order_key(b: Block):
            dl = _days_until(b.deadline, self.week_monday)["Mon"]
            return (dl, -PRIORITY[b.priority], -DIFFICULTY[b.difficulty])
        blocks.sort(key=order_key)

        assignment: dict[tuple[str, str], Block | None] = {
            (d, s): None for d in DAYS for s in SLOTS
        }

        unplaced = []
        for b in blocks:
            best, best_u = None, -1e8
            for (d, s), occ in assignment.items():
                if occ is not None:
                    continue
                if self._overlaps_locked(d, s):
                    continue
                u = self.utility(b, d, s, assignment)
                if u > best_u:
                    best, best_u = (d, s), u
            if best and best_u > -1e8:
                assignment[best] = b
            else:
                unplaced.append(b)

        # stochastic local search: try swaps / moves, keep improvements
        def total_utility():
            tot = 0.0
            for (d, s), b in assignment.items():
                if b is not None:
                    ctx = {k: v for k, v in assignment.items() if k != (d, s)}
                    tot += self.utility(b, d, s, ctx)
            return tot

        current = total_utility()
        cells = list(assignment.keys())
        for _ in range(iters):
            c1, c2 = rng.sample(cells, 2)
            if assignment[c1] is None and assignment[c2] is None:
                continue
            assignment[c1], assignment[c2] = assignment[c2], assignment[c1]
            new = total_utility()
            if new >= current:
                current = new
            else:
                assignment[c1], assignment[c2] = assignment[c2], assignment[c1]

        # relabel session parts chronologically (local search may shuffle them)
        order = [(d, s) for d in DAYS for s in SLOTS]
        per_task: dict = {}
        for cell in order:
            b = assignment[cell]
            if b is not None:
                per_task.setdefault(b.task_id, []).append(b)
        for task_id, blocks_of_task in per_task.items():
            locked_parts = self.locked_task_parts.get(str(task_id), set())
            available_parts = [part for part in range(1, blocks_of_task[0].parts + 1) if part not in locked_parts]
            for i, b in enumerate(blocks_of_task, start=1):
                if i <= len(available_parts):
                    b.part = available_parts[i - 1]

        # explanations
        for (d, s), b in assignment.items():
            if b is None:
                continue
            b.explanation, b.score_breakdown = self._explain(b, d, s, assignment)

        return assignment, unplaced, round(current, 2)

    def _explain(self, b: Block, day: str, slot: str, assignment):
        p = self.model.p_complete(day, slot)
        n = self.model.observations(day, slot)
        days_left = _days_until(b.deadline, self.week_monday)[day]
        period = self.model.period_of(slot)
        reasons = []
        if n > 0:
            reasons.append(
                f"you complete {int(round(p * 100))}% of blocks here (based on {n} past observations)")
        else:
            reasons.append(
                f"estimated {int(round(p * 100))}% completion chance here (no data yet - prior only)")
        if b.difficulty == "Hard" and period == self.focus_window:
            reasons.append(f"hard task placed in your preferred {self.focus_window} focus window")
        if b.deadline and days_left <= 3:
            reasons.append(f"deadline in {days_left} day{'s' if days_left != 1 else ''} ({b.deadline})")
        if b.parts > 1:
            reasons.append(f"session {b.part} of {b.parts} - spaced over the week for better retention")
        text = "Placed here because " + "; ".join(reasons) + "."
        return text, {"p_complete": round(p, 2), "observations": n, "days_to_deadline": days_left}
