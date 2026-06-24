# Smart Study Calendar — StudyPlan
**Intelligent User Interfaces · Summer 2026 · Group 7**
Muhammad Shahzaib · Chengzhao Dai · Luna Luo Yunru · Kash

A study planner that learns *when you actually study best*, **proposes** a weekly
plan, **explains every decision with an AI assistant**, and only changes your
calendar **after you explicitly approve** it.

## Three design commitments
1. **Uses an AI model.** A learned Bayesian user model + optimizer make the
   decisions; an **LLM (Anthropic Claude)** then explains those decisions in
   natural language and answers free-text "why?" questions about the plan.
   Explanations are *grounded* — the model is given the optimizer's actual
   numbers and told never to invent data. Falls back to deterministic,
   data-driven explanations when no API key is set, so it always works.
2. **Explains its decisions.** Every block shows the optimizer's grounded
   rationale plus an on-demand AI explanation; the proposal shows an AI plan
   summary; a Q&A box answers questions like "Why is Friday light?". Every AI
   answer is labelled **AI** or **rule-based** so the user knows the source.
3. **Never changes the calendar without approval.** The assistant *proposes* a
   plan (shown as a diff with "new/moved/removed" tags). Nothing is written to
   the calendar until the user clicks **Approve & apply**. Reject discards it.
   Direct user edits (drag-and-drop, Done/Skip) are the user's own explicit
   actions and are saved immediately. Feedback updates the learned model only —
   never the calendar.

## Architecture
- **Frontend** (`src/`): React 19 + Vite + Tailwind. Committed-vs-proposal
  state machine, approval review bar, AI explanation display, focus heatmap,
  settings that feed the optimizer.
- **Backend** (`backend/`): Python FastAPI.
  - `engine.py` — `FocusModel` (hierarchical Beta-Bernoulli user model) and
    `ScheduleOptimizer` (utility scoring + stochastic local search).
  - `llm.py` — the AI explanation layer (Anthropic API + grounded fallback).
  - `main.py` — API. Key endpoints:
    `POST /api/schedule/propose` (computes a plan, **does not persist**),
    `GET/PUT /api/schedule/committed` (the approved calendar),
    `POST /api/explain` (grounded AI Q&A), `POST /api/feedback`,
    `GET /api/model`, `GET/PUT /api/tasks`.
  - The committed calendar persists in `committed_schedule.json`; the learned
    profile in `user_model.json` (a seeded demo profile is included).

## Run it
Terminal 1 — backend:
```bash
cd backend
pip install -r requirements.txt
# optional: enable AI explanations
export ANTHROPIC_API_KEY=sk-ant-...      # see .env.example
uvicorn main:app --reload --port 8000
```
Terminal 2 — frontend:
```bash
npm install
npm run dev          # http://localhost:5173 (proxies /api to :8000)
```
The app works with no API key (rule-based explanations); set the key to enable
LLM-written explanations.

## Demo script (~2 min)
1. Tasks → **Propose a Plan**. The plan opens as a **proposal** (amber review
   bar, "new" tags) — note it is NOT yet on the calendar.
2. Read the AI plan summary; click a block → grounded facts + "**Ask the
   assistant to explain this**" → natural-language, grounded explanation.
3. Ask the Q&A box something like "Why is the weekend empty?".
4. Click **Approve & apply** → the plan becomes your calendar. Drag a block to
   adjust it (your own change, saved immediately).
5. Mark a block Skipped → the model updates, but the calendar is unchanged; the
   next proposal avoids that slot for hard tasks.
