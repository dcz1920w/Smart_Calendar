"""
Natural-language explanation layer for Smart Study Calendar.

The scheduling DECISION is made by the transparent optimizer (engine.py) using
the Bayesian focus model. This module only turns those decisions into friendly,
grounded explanations and answers the user's "why?" questions.

It uses an LLM (Anthropic Claude) when ANTHROPIC_API_KEY is set, and otherwise
falls back to a deterministic, data-driven template so the app and demo work
with no external dependencies.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = os.environ.get("SSC_LLM_MODEL", "claude-haiku-4-5-20251001")

SYSTEM_PROMPT = (
    "You are the explanation engine inside 'Smart Study Calendar', a study planner. "
    "A separate optimizer has ALREADY decided the schedule, using a Bayesian model of the "
    "student's per-slot completion probability together with deadlines and the student's "
    "preferences. Your only job is to explain those decisions in clear, warm, concise language "
    "and to answer the student's 'why' questions, STRICTLY grounded in the numbers you are given. "
    "Never invent data. Never tell the student you will change the schedule - you only explain. "
    "Keep answers to 2-4 short sentences, plain language, no markdown headers."
)


def llm_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _call_llm(user_content: str, max_tokens: int = 400) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    body = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
    }).encode()
    req = urllib.request.Request(API_URL, data=body, headers={
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        text = "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ).strip()
        return text or None
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, OSError):
        return None


# --------------------------------------------------------------------------
# Deterministic fallback (also a useful, fully-offline explanation)
# --------------------------------------------------------------------------
def _template_plan_summary(plan: list[dict]) -> str:
    if not plan:
        return "There is nothing scheduled yet. Add some tasks and generate a plan to see the reasoning."
    n = len(plan)
    hard = [b for b in plan if b.get("difficulty") == "Hard"]
    morn = [b for b in hard if b.get("time", "").startswith(("09", "10"))]
    urgent = sorted(
        (b for b in plan if isinstance(b.get("days_to_deadline"), int)),
        key=lambda b: b["days_to_deadline"],
    )
    parts = [f"I placed {n} study block{'s' if n != 1 else ''} this week."]
    if morn:
        parts.append(
            f"Demanding work ({', '.join(sorted({b['course'] for b in morn}))}) sits in your "
            f"higher-focus morning slots, where the model predicts you complete the most."
        )
    if urgent:
        first = urgent[0]
        parts.append(
            f"The most urgent task, {first['course']}, comes early "
            f"(deadline in {first['days_to_deadline']} day"
            f"{'s' if first['days_to_deadline'] != 1 else ''})."
        )
    parts.append("Multi-session tasks are spread across the week for better retention.")
    return " ".join(parts)


def _template_block_answer(plan: list[dict], question: str) -> str:
    q = question.lower()
    match = None
    for b in plan:
        if b.get("course", "").lower() in q or b.get("time", "") in q:
            match = b
            break
    if match:
        p = match.get("p")
        pct = f"{int(round(p * 100))}%" if isinstance(p, (int, float)) else "a solid"
        dtl = match.get("days_to_deadline")
        dl = (f", and its deadline is in {dtl} day{'s' if dtl != 1 else ''}"
              if isinstance(dtl, int) and dtl < 90 else "")
        return (
            f"{match['course']} is on {match['time']} ({match['day']}) because the model predicts "
            f"{pct} completion chance for you in that slot{dl}. That made it the highest-utility "
            f"placement among the free slots."
        )
    return _template_plan_summary(plan)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def explain(plan: list[dict], question: str | None = None) -> tuple[str, str]:
    """Return (explanation_text, source) where source is 'ai' or 'template'."""
    if question:
        user = (
            "Proposed weekly study plan as JSON (each block has day, time, course, difficulty, "
            "p = predicted completion probability 0-1, days_to_deadline, session part):\n"
            + json.dumps(plan, indent=1)
            + f"\n\nThe student asks: {question}\n"
            "Answer their question, grounded only in this data."
        )
        text = _call_llm(user)
        if text:
            return text, "ai"
        return _template_block_answer(plan, question), "template"

    user = (
        "Proposed weekly study plan as JSON (each block has day, time, course, difficulty, "
        "p = predicted completion probability 0-1, days_to_deadline, session part):\n"
        + json.dumps(plan, indent=1)
        + "\n\nGive a brief, friendly overview of the main reasoning behind this plan."
    )
    text = _call_llm(user)
    if text:
        return text, "ai"
    return _template_plan_summary(plan), "template"
