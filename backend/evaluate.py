"""
Milestone 4 evaluation: how fast does the planner adapt to a user?
==================================================================
We simulate user personas with a hidden "true" per-slot completion
probability. Each simulated week:
  1. the optimizer generates a plan with the current learned model,
  2. the persona completes/skips every placed block according to its
     true probabilities (Bernoulli draws),
  3. the feedback updates the model.

Metric: "focus alignment" = mean TRUE completion probability of the slots
chosen for HARD blocks. Higher = the planner schedules hard work when this
user actually performs. We compare the hierarchical model (TAU=4, pooled by
time-of-day) against a flat per-cell model (TAU≈0).

Run:  python evaluate.py     (writes evaluation_results.png + .json)
"""

import json
import random

from engine import DAYS, SLOTS, FocusModel, ScheduleOptimizer

WEEKS = 8
RUNS = 25  # random seeds per condition

PERSONAS = {
    "Morning lark": lambda day, slot: {
        "09:00-10:30": 0.85, "10:30-12:00": 0.80,
        "14:00-15:30": 0.55, "16:00-17:30": 0.45, "19:00-20:30": 0.25,
    }[slot] - (0.15 if day in ("Sat", "Sun") else 0.0),
    "Night owl": lambda day, slot: {
        "09:00-10:30": 0.25, "10:30-12:00": 0.35,
        "14:00-15:30": 0.55, "16:00-17:30": 0.70, "19:00-20:30": 0.85,
    }[slot],
    "Weekend warrior": lambda day, slot: (
        0.85 if day in ("Sat", "Sun") else 0.40
    ) - (0.10 if slot == "19:00-20:30" else 0.0),
}

TASKS = [
    {"id": 1, "title": "Exam review", "course": "A", "deadline": None,
     "estimatedHours": 4.5, "difficulty": "Hard", "priority": "High"},
    {"id": 2, "title": "Reading", "course": "B", "deadline": None,
     "estimatedHours": 3.0, "difficulty": "Medium", "priority": "Medium"},
    {"id": 3, "title": "Vocabulary", "course": "C", "deadline": None,
     "estimatedHours": 3.0, "difficulty": "Easy", "priority": "Low"},
    {"id": 4, "title": "Project", "course": "D", "deadline": None,
     "estimatedHours": 3.0, "difficulty": "Hard", "priority": "High"},
]


def run_condition(true_p, learn, seed):
    rng = random.Random(seed)
    model = FocusModel(path=None)
    alignment = []
    for week in range(WEEKS):
        opt = ScheduleOptimizer(model, {"focusWindow": "morning", "maxBlocksPerDay": 3})
        assignment, _, _ = opt.solve(TASKS, seed=seed * 100 + week)
        hard_ps, placed = [], []
        for (d, s), b in assignment.items():
            if b is None:
                continue
            placed.append((d, s))
            if b.difficulty == "Hard":
                hard_ps.append(true_p(d, s))
        alignment.append(sum(hard_ps) / len(hard_ps))
        if learn:
            for (d, s) in placed:  # persona gives feedback on every placed block
                model.update(d, s, rng.random() < true_p(d, s))
    return alignment


def mean(xs):
    return sum(xs) / len(xs)


def main():
    results = {}
    for persona, true_p in PERSONAS.items():
        results[persona] = {}
        # oracle = best achievable: mean of top-6 true slot probabilities
        all_p = sorted((true_p(d, s) for d in DAYS for s in SLOTS), reverse=True)
        results[persona]["oracle"] = mean(all_p[:6])
        for label, learn in [("adaptive (ours)", True), ("static heuristic (no learning)", False)]:
            runs = [run_condition(true_p, learn, seed) for seed in range(RUNS)]
            results[persona][label] = [mean([r[w] for r in runs]) for w in range(WEEKS)]

    with open("evaluation_results.json", "w") as f:
        json.dump(results, f, indent=1)

    # ---- plot ----
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 3, figsize=(12.6, 3.7), sharey=True)
    colors = {"adaptive (ours)": "#0E7490", "static heuristic (no learning)": "#B45309"}
    for ax, (persona, data) in zip(axes, results.items()):
        weeks = list(range(1, WEEKS + 1))
        for label, color in colors.items():
            ax.plot(weeks, data[label], marker="o", ms=4, lw=2.2,
                    color=color, label=label)
        ax.axhline(data["oracle"], ls="--", lw=1.4, color="#10B981", label="oracle (best possible)")
        ax.set_title(persona, fontsize=12, fontweight="bold", color="#0B1623")
        ax.set_xlabel("simulated week")
        ax.set_ylim(0.25, 0.92)
        ax.grid(alpha=0.25)
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].set_ylabel("focus alignment of hard blocks\n(true P(complete) of chosen slots)")
    axes[0].legend(fontsize=8.5, loc="lower right", framealpha=0.9)
    fig.suptitle("The planner adapts: hard blocks migrate to each persona's true high-focus slots",
                 fontsize=13, fontweight="bold", color="#0B1623")
    fig.tight_layout(rect=[0, 0, 1, 0.93])
    fig.savefig("evaluation_results.png", dpi=300)
    print("written evaluation_results.png / .json")
    for persona, data in results.items():
        print(persona, "wk1->wk8:",
              {k: (round(v[0], 2), round(v[-1], 2)) for k, v in data.items() if isinstance(v, list)},
              "oracle", round(data["oracle"], 2))


if __name__ == "__main__":
    main()
