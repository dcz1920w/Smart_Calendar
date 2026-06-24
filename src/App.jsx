import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  checkHealth,
  fetchTasks,
  saveTasks,
  fetchModel,
  proposePlan,
  getCommitted,
  putCommitted,
  explainPlan,
  resetModel,
  sendFeedback,
} from "./api";

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const timeSlots = [
  "09:00-10:30",
  "10:30-12:00",
  "14:00-15:30",
  "16:00-17:30",
  "19:00-20:30",
];

const dayIndexes = Object.fromEntries(days.map((day, index) => [day, index]));
const navItems = ["Dashboard", "Calendar", "Tasks", "Analytics", "Settings"];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toLocalDateString(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfCurrentWeek() {
  const date = new Date();
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function slotFromDates(start, end) {
  return `${formatClock(start)}-${formatClock(end)}`;
}

function parseSlot(slot) {
  const [start = "09:00", end = "10:30"] = slot.split("-");
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return {
    startHour: Number.isFinite(startHour) ? startHour : 9,
    startMinute: Number.isFinite(startMinute) ? startMinute : 0,
    endHour: Number.isFinite(endHour) ? endHour : 10,
    endMinute: Number.isFinite(endMinute) ? endMinute : 30,
  };
}

function minutesFromClock(clock) {
  const [hour, minute] = clock.split(":").map(Number);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function slotsOverlap(first, second) {
  const [firstStart, firstEnd] = first.split("-");
  const [secondStart, secondEnd] = second.split("-");
  if (!firstStart || !firstEnd || !secondStart || !secondEnd) return first === second;
  return (
    minutesFromClock(firstStart) < minutesFromClock(secondEnd) &&
    minutesFromClock(secondStart) < minutesFromClock(firstEnd)
  );
}

function hasSlotConflict(schedule, day, slot, ignoredSlot = null) {
  return Object.entries(schedule?.[day] ?? {}).some(
    ([existingSlot, block]) =>
      block && existingSlot !== ignoredSlot && slotsOverlap(existingSlot, slot)
  );
}

function getCalendarEventColors(block) {
  if (String(block.taskId ?? "").startsWith("manual-")) {
    return {
      backgroundColor: "#e0f2fe",
      borderColor: "#7dd3fc",
      textColor: "#0f172a",
    };
  }

  const palettes = {
    hard: {
      backgroundColor: "#fff1f2",
      borderColor: "#fb7185",
      textColor: "#0f172a",
    },
    medium: {
      backgroundColor: "#fef9c3",
      borderColor: "#facc15",
      textColor: "#0f172a",
    },
    easy: {
      backgroundColor: "#dcfce7",
      borderColor: "#4ade80",
      textColor: "#0f172a",
    },
  };

  return palettes[String(block.difficulty ?? "medium").toLowerCase()] ?? palettes.medium;
}

function datesFromDaySlot(day, slot, weekStart = startOfCurrentWeek()) {
  const date = addDays(weekStart, dayIndexes[day] ?? 0);
  const { startHour, startMinute, endHour, endMinute } = parseSlot(slot);
  const start = new Date(date);
  start.setHours(startHour, startMinute, 0, 0);
  const end = new Date(date);
  end.setHours(endHour, endMinute, 0, 0);
  if (end <= start) end.setTime(start.getTime() + 90 * 60 * 1000);
  return { start, end };
}

function deadlineEndDate(deadline) {
  if (!deadline) return null;
  const end = new Date(`${deadline}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end;
}

function generatedBlockFitsWindow(task, day, slot, now = new Date()) {
  const { start, end } = datesFromDaySlot(day, slot);
  if (start < now) return false;
  const deadlineEnd = deadlineEndDate(task.deadline);
  if (deadlineEnd && end > deadlineEnd) return false;
  return true;
}

function dayFromDate(date, weekStart = startOfCurrentWeek()) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const current = new Date(date);
  current.setHours(0, 0, 0, 0);
  const index = Math.round((current - start) / (24 * 60 * 60 * 1000));
  return days[index] ?? null;
}

function normalizeSchedule(schedule) {
  const next = {};
  days.forEach((day) => {
    next[day] = { ...(schedule?.[day] ?? {}) };
  });
  return next;
}

function iterateSchedule(schedule, callback) {
  days.forEach((day) => {
    Object.entries(schedule?.[day] ?? {}).forEach(([slot, block]) => {
      if (block) callback(day, slot, block);
    });
  });
}

function isoDaysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const initialTasks = [
  {
    id: 1,
    title: "Data Modeling Exam Review",
    course: "Data Modeling",
    deadline: isoDaysFromNow(3),
    estimatedHours: 4.5,
    difficulty: "Hard",
    priority: "High",
    status: "Not started",
  },
  {
    id: 2,
    title: "Philosophy Reading: Kant, Ch. 4-6",
    course: "Philosophy",
    deadline: isoDaysFromNow(5),
    estimatedHours: 3,
    difficulty: "Medium",
    priority: "Medium",
    status: "Not started",
  },
  {
    id: 3,
    title: "German Vocabulary Practice",
    course: "German",
    deadline: isoDaysFromNow(7),
    estimatedHours: 2,
    difficulty: "Easy",
    priority: "Low",
    status: "Not started",
  },
  {
    id: 4,
    title: "IUI Milestone Presentation",
    course: "Intelligent User Interfaces",
    deadline: isoDaysFromNow(2),
    estimatedHours: 3,
    difficulty: "Hard",
    priority: "High",
    status: "Not started",
  },
];

/* ------------------------------------------------------------------ */
/* Local fallback (used only if the Python engine is offline).         */
/* Produces a PROPOSAL too - it is never auto-applied.                 */
/* ------------------------------------------------------------------ */

function getPriorityScore(task) {
  const priorityScore = { High: 3, Medium: 2, Low: 1 };
  const difficultyScore = { Hard: 3, Medium: 2, Easy: 1 };
  const today = new Date();
  const deadline = new Date(task.deadline);
  const daysLeft = Math.max(
    1,
    Math.ceil((deadline - today) / (1000 * 60 * 60 * 24))
  );
  return (
    priorityScore[task.priority] * 2 +
    difficultyScore[task.difficulty] +
    10 / daysLeft
  );
}

function splitTaskIntoBlocks(task) {
  const blockCount = Math.ceil(task.estimatedHours / 1.5);
  return Array.from({ length: blockCount }, (_, index) => ({
    taskId: task.id,
    title: task.title,
    course: task.course,
    deadline: task.deadline,
    difficulty: task.difficulty,
    priority: task.priority,
    part: index + 1,
    parts: blockCount,
    status: "Proposed",
    explanation:
      "Placed by the local fallback heuristic (Python engine offline): sorted by urgency, hard tasks preferred in the morning.",
    scoreBreakdown: {},
  }));
}

function generateLocalProposal(tasks) {
  const sortedTasks = [...tasks]
    .filter((task) => task.status !== "Completed")
    .sort((a, b) => getPriorityScore(b) - getPriorityScore(a));

  const blocks = sortedTasks.flatMap(splitTaskIntoBlocks);
  const schedule = {};
  days.forEach((day) => {
    schedule[day] = {};
    timeSlots.forEach((slot) => (schedule[day][slot] = null));
  });

  for (const block of blocks) {
    let placed = false;
    for (const day of days) {
      for (const slot of timeSlots) {
        if (!generatedBlockFitsWindow(block, day, slot)) continue;
        const isMorning = slot === "09:00-10:30" || slot === "10:30-12:00";
        if (block.difficulty === "Hard" && !isMorning) continue;
        if (!schedule[day][slot]) {
          schedule[day][slot] = { ...block, day, slot };
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) {
      outer: for (const day of days) {
        for (const slot of timeSlots) {
          if (!generatedBlockFitsWindow(block, day, slot)) continue;
          if (!schedule[day][slot]) {
            schedule[day][slot] = { ...block, day, slot };
            break outer;
          }
        }
      }
    }
  }
  return schedule;
}

/* ------------------------------------------------------------------ */
/* Diff between the committed calendar and a proposed plan             */
/* ------------------------------------------------------------------ */

function classifyProposal(committed, proposal) {
  const map = {};
  let added = 0;
  let changed = 0;
  let removed = 0;
  let unchanged = 0;
  days.forEach((d) => {
    const slots = new Set([
      ...Object.keys(committed?.[d] ?? {}),
      ...Object.keys(proposal?.[d] ?? {}),
    ]);
    slots.forEach((s) => {
      const c = committed?.[d]?.[s] || null;
      const p = proposal?.[d]?.[s] || null;
      const key = `${d}|${s}`;
      if (p && !c) {
        map[key] = "new";
        added++;
      } else if (p && c) {
        if (c.taskId === p.taskId && c.part === p.part) {
          map[key] = "same";
          unchanged++;
        } else {
          map[key] = "changed";
          changed++;
        }
      } else if (!p && c) {
        removed++;
      }
    });
  });
  return { map, added, changed, removed, unchanged };
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function Label({ children }) {
  return (
    <label className="block text-sm font-semibold tracking-wide text-slate-700 mb-2">
      {children}
    </label>
  );
}

function StatCard({ number, label }) {
  return (
    <div className="rounded-[1.75rem] border border-slate-200 bg-white shadow-[0_18px_45px_-30px_rgba(15,23,42,0.35)] p-5 text-center">
      <div className="text-3xl font-semibold text-slate-900">{number}</div>
      <div className="text-xs text-slate-500 mt-2 uppercase tracking-[0.2em]">
        {label}
      </div>
    </div>
  );
}

function StatusBadges({ online, llmAvailable }) {
  return (
    <div className="space-y-2">
      <div
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${
          online
            ? "bg-emerald-400/20 text-emerald-200 ring-1 ring-emerald-300/40"
            : "bg-rose-400/20 text-rose-200 ring-1 ring-rose-300/40"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-400" : "bg-rose-400"}`} />
        Python engine {online ? "online" : "offline"}
      </div>
      <div
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${
          llmAvailable
            ? "bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/40"
            : "bg-slate-400/20 text-slate-200 ring-1 ring-slate-300/30"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${llmAvailable ? "bg-cyan-300" : "bg-slate-300"}`} />
        AI explanations {llmAvailable ? "on" : "rule-based"}
      </div>
    </div>
  );
}

function SourceBadge({ source }) {
  const ai = source === "ai";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
        ai
          ? "bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200"
          : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ai ? "bg-cyan-500" : "bg-slate-400"}`} />
      {ai ? "AI" : "rule-based"}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [activePage, setActivePage] = useState(() => {
    const saved = window.localStorage.getItem("studyplan-active-page");
    return navItems.includes(saved) ? saved : "Dashboard";
  });
  const [tasks, setTasks] = useState(initialTasks);

  // The two schedules: what the user has approved, and a pending proposal.
  const [committed, setCommitted] = useState(null);
  const [proposal, setProposal] = useState(null); // { schedule, summary, summarySource, unplaced, message }

  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0);
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [scheduleDraft, setScheduleDraft] = useState(null);
  const [blockExplain, setBlockExplain] = useState(null); // { loading, text, source }
  const [planQA, setPlanQA] = useState(null); // { loading, question, answer, source }

  const [backendOnline, setBackendOnline] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState(false);
  const [heatmap, setHeatmap] = useState(null);
  const [modelEvents, setModelEvents] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [recommendation, setRecommendation] = useState(
    "Add your tasks and ask the assistant to propose a weekly plan. Nothing is added to your calendar until you approve it."
  );

  const [prefs, setPrefs] = useState({
    focusWindow: "morning",
    maxBlocksPerDay: 3,
  });

  const [form, setForm] = useState({
    title: "",
    course: "",
    deadline: "",
    estimatedHours: 1.5,
    difficulty: "Medium",
    priority: "Medium",
  });

  useEffect(() => {
    window.localStorage.setItem("studyplan-active-page", activePage);
  }, [activePage]);

  useEffect(() => {
    let active = true;
    async function init() {
      const health = await checkHealth();
      if (!active) return;
      setBackendOnline(!!health);
      setLlmAvailable(!!health?.llmAvailable);
      if (health) {
        refreshModel();
        try {
          const committedData = await getCommitted();
          if (active && committedData.schedule) setCommitted(committedData.schedule);
        } catch { /* none yet */ }
        try {
          const data = await fetchTasks();
          if (!active) return;
          if (data.tasks?.length) setTasks(data.tasks);
          else saveTasks(initialTasks).catch(() => {});
        } catch { /* keep local defaults */ }
      }
    }
    init();
    const id = setInterval(init, 20000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  async function refreshModel() {
    try {
      const data = await fetchModel();
      setHeatmap(data.heatmap);
      setModelEvents(data.events);
    } catch {
      /* engine offline - heatmap stays stale */
    }
  }

  const analytics = useMemo(() => {
    let total = 0;
    let completed = 0;
    let skipped = 0;
    if (!committed) return { total: 0, completed: 0, skipped: 0, completionRate: 0 };
    iterateSchedule(committed, (_day, _slot, block) => {
      total++;
      if (block.status === "Completed") completed++;
      if (block.status === "Skipped") skipped++;
    });
    return {
      total,
      completed,
      skipped,
      completionRate: total === 0 ? 0 : Math.round((completed / total) * 100),
    };
  }, [committed]);

  function persistCommitted(next) {
    setCommitted(next);
    setCalendarRefreshKey((value) => value + 1);
    putCommitted(next).catch(() => {});
  }

  function handleAddTask(event) {
    event.preventDefault();
    if (!form.title || !form.course || !form.deadline) {
      alert("Please fill in title, course, and deadline.");
      return;
    }
    const newTask = {
      id: Date.now(),
      ...form,
      estimatedHours: Number(form.estimatedHours),
      status: "Not started",
    };
    setTasks((prev) => {
      const next = [...prev, newTask];
      saveTasks(next).catch(() => {});
      return next;
    });
    setForm({
      title: "",
      course: "",
      deadline: "",
      estimatedHours: 1.5,
      difficulty: "Medium",
      priority: "Medium",
    });
    setRecommendation("New task added. Ask the assistant to propose an updated plan when ready.");
  }

  function handleDeleteTask(taskId) {
    setTasks((prev) => {
      const next = prev.filter((task) => task.id !== taskId);
      saveTasks(next).catch(() => {});
      return next;
    });
    setRecommendation("Task deleted. Ask the assistant to propose an updated plan when ready.");
  }

  // --- Propose (never applies; produces a proposal for review) ---------
  async function handlePropose() {
    setGenerating(true);
    setPlanQA(null);
    try {
      const data = await proposePlan(tasks, prefs);
      const grid = {};
      days.forEach((day) => {
        grid[day] = {};
        timeSlots.forEach((slot) => {
          const b = data.proposal[day][slot];
          grid[day][slot] = b ? { ...b, day, slot } : null;
        });
      });
      setProposal({
        schedule: grid,
        summary: data.summary,
        summarySource: data.summarySource,
        unplaced: data.unplacedBlocks,
        message: data.message,
      });
      setBackendOnline(true);
      setRecommendation(data.message);
      refreshModel();
    } catch {
      setBackendOnline(false);
      setProposal({
        schedule: generateLocalProposal(tasks),
        summary:
          "Generated with the local fallback heuristic because the Python engine was unreachable. Review and approve to apply it.",
        summarySource: "template",
        unplaced: 0,
        message: "Python engine offline - proposed a plan with the local fallback heuristic.",
      });
      setRecommendation(
        "Python engine not reachable - proposed a plan with the local fallback heuristic instead."
      );
    } finally {
      setGenerating(false);
      setActivePage("Calendar");
    }
  }

  function approveProposal() {
    if (!proposal) return;
    persistCommitted(proposal.schedule);
    setProposal(null);
    setPlanQA(null);
    setRecommendation("Approved. The plan is now on your calendar. You can still drag blocks to adjust it.");
  }

  function rejectProposal() {
    setProposal(null);
    setPlanQA(null);
    setRecommendation("Proposal discarded. Your calendar is unchanged.");
  }

  // --- Direct user edits act on the COMMITTED calendar -----------------
  function moveBlockToSlot(sourceDay, sourceSlot, targetDay, targetSlot) {
    if (!committed) return false;
    if (sourceDay === targetDay && sourceSlot === targetSlot) {
      return true;
    }
    const updated = normalizeSchedule(structuredClone(committed));
    const sourceBlock = updated[sourceDay][sourceSlot];
    if (!sourceBlock) return false;
    if (hasSlotConflict(updated, targetDay, targetSlot, sourceDay === targetDay ? sourceSlot : null)) {
      alert("That time overlaps another schedule. Move or resize to an open time.");
      return false;
    }
    delete updated[sourceDay][sourceSlot];
    updated[targetDay][targetSlot] = {
      ...sourceBlock,
      day: targetDay,
      slot: targetSlot,
      explanation:
        "You moved this block yourself - the assistant keeps your choice (you stay in control).",
    };
    persistCommitted(updated);
    setRecommendation("Moved. Your change is saved to your calendar.");
    return true;
  }

  function startScheduleAdd(day, slot) {
    if (!day || !slot) return;
    setScheduleDraft({ day, slot });
  }

  function closeScheduleDraft() {
    setScheduleDraft(null);
    setCalendarRefreshKey((value) => value + 1);
  }

  function addScheduleBlock({ day, slot, title, course }) {
    if (!day || !slot) return false;
    if (!title?.trim()) return false;
    const updated = normalizeSchedule(structuredClone(committed ?? {}));
    if (hasSlotConflict(updated, day, slot)) {
      alert("That time overlaps another schedule.");
      return false;
    }
    updated[day][slot] = {
      taskId: `manual-${Date.now()}`,
      title: title.trim(),
      course: course?.trim() || "Custom Study",
      difficulty: "Medium",
      priority: "Medium",
      part: 1,
      parts: 1,
      status: "Scheduled",
      day,
      slot,
      explanation: "You added this schedule directly to the calendar.",
      scoreBreakdown: {},
    };
    persistCommitted(updated);
    setScheduleDraft(null);
    setRecommendation("Schedule added. You can drag or stretch it to fine-tune the time.");
    return true;
  }

  async function updateBlockStatus(day, slot, status) {
    if (!committed) return;
    const updated = structuredClone(committed);
    if (updated[day]?.[slot]) updated[day][slot].status = status;
    persistCommitted(updated);

    if (status === "Completed" || status === "Skipped") {
      try {
        const res = await sendFeedback(day, slot, status === "Completed");
        setRecommendation(res.message);
        refreshModel();
        return;
      } catch {
        setBackendOnline(false);
      }
    }
    setRecommendation(
      status === "Completed"
        ? "Logged as done. Your focus profile is updated."
        : "Logged as skipped. The next proposal will avoid this slot for hard tasks."
    );
  }

  // --- Ask the AI assistant (grounded Q&A about the plan) --------------
  async function askWhyBlock(block) {
    const sched = proposal ? proposal.schedule : committed;
    if (!sched) return;
    setBlockExplain({ loading: true });
    const q = `Why is ${block.course} scheduled on ${block.day} at ${block.slot}?`;
    try {
      const res = await explainPlan(sched, q);
      setBlockExplain({ loading: false, text: res.explanation, source: res.source });
    } catch {
      setBlockExplain({
        loading: false,
        text: "Couldn't reach the assistant. The grounded summary above still applies.",
        source: "error",
      });
    }
  }

  async function askAboutPlan(question) {
    const sched = proposal ? proposal.schedule : committed;
    if (!sched || !question.trim()) return;
    setPlanQA({ loading: true, question });
    try {
      const res = await explainPlan(sched, question);
      setPlanQA({ loading: false, question, answer: res.explanation, source: res.source });
    } catch {
      setPlanQA({
        loading: false,
        question,
        answer: "Couldn't reach the assistant right now.",
        source: "error",
      });
    }
  }

  function openBlock(block) {
    setBlockExplain(null);
    setSelectedBlock(block);
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.18),_transparent_26%),radial-gradient(circle_at_bottom_right,_rgba(34,197,94,0.16),_transparent_22%),linear-gradient(180deg,#f8fafc,#eaf5f4)] text-slate-900">
      <div className="flex">
        <aside className="hidden md:flex w-72 min-h-screen bg-gradient-to-br from-slate-950 via-cyan-900 to-emerald-700 text-white flex-col p-6 fixed left-0 top-0">
          <h1 className="text-3xl font-bold mb-1 tracking-tight">StudyPlan</h1>
          <p className="text-sm text-slate-200 mb-4 max-w-[12rem]">
            Smart Study Calendar
          </p>
          <div className="mb-8">
            <StatusBadges online={backendOnline} llmAvailable={llmAvailable} />
          </div>

          <nav className="space-y-3 text-sm">
            {navItems.map((item) => (
              <button
                key={item}
                onClick={() => setActivePage(item)}
                className={`w-full text-left rounded-xl px-4 py-3 transition ${
                  activePage === item ? "bg-white/20 font-semibold" : "hover:bg-white/10"
                }`}
              >
                {item}
                {item === "Calendar" && proposal && (
                  <span className="ml-2 inline-flex rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-slate-950">
                    1 pending
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-auto text-xs text-slate-200 opacity-90">
            Bayesian focus model · optimizer · AI explanations · approve-before-apply
          </div>
        </aside>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 md:px-10 md:ml-72">
          <header className="mb-10">
            <div className="inline-flex items-center rounded-full bg-white/80 px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm ring-1 ring-slate-200">
              Intelligent User Interfaces Project · Group 7
            </div>
            <h2 className="text-3xl md:text-5xl font-bold mt-6 tracking-tight text-slate-950">
              Smart Study Calendar
            </h2>
            <p className="text-slate-600 mt-4 max-w-3xl text-base leading-7">
              Your tasks and habits go in. A learned model and optimizer{" "}
              <span className="font-semibold text-slate-800">propose</span> a weekly plan, an
              AI assistant explains every choice, and nothing reaches your calendar until{" "}
              <span className="font-semibold text-slate-800">you approve it</span>.
            </p>
          </header>

          {activePage === "Dashboard" && (
            <DashboardPage
              tasks={tasks}
              analytics={analytics}
              recommendation={recommendation}
              handlePropose={handlePropose}
              generating={generating}
              setActivePage={setActivePage}
              hasProposal={!!proposal}
              hasCommitted={!!committed}
            />
          )}

          {activePage === "Tasks" && (
            <TasksPage
              form={form}
              setForm={setForm}
              tasks={tasks}
              handleAddTask={handleAddTask}
              handleDeleteTask={handleDeleteTask}
              handlePropose={handlePropose}
              generating={generating}
            />
          )}

          {activePage === "Calendar" && (
            <>
              <CalendarPage
                committed={committed}
                proposal={proposal}
                onApprove={approveProposal}
                onReject={rejectProposal}
                handlePropose={handlePropose}
                generating={generating}
                moveBlockToSlot={moveBlockToSlot}
                onRequestScheduleAdd={startScheduleAdd}
                calendarExpanded={calendarExpanded}
                calendarRefreshKey={calendarRefreshKey}
                setCalendarExpanded={setCalendarExpanded}
                onOpenBlock={openBlock}
                planQA={planQA}
                onAskAboutPlan={askAboutPlan}
                llmAvailable={llmAvailable}
              />
              {selectedBlock && (
                <TaskModal
                  block={selectedBlock}
                  isProposed={!!proposal}
                  explainState={blockExplain}
                  onAskWhy={() => askWhyBlock(selectedBlock)}
                  onClose={() => setSelectedBlock(null)}
                  onStatusChange={(status) => {
                    updateBlockStatus(selectedBlock.day, selectedBlock.slot, status);
                    setSelectedBlock(null);
                  }}
                />
              )}
              {scheduleDraft && (
                <ScheduleModal
                  draft={scheduleDraft}
                  onClose={closeScheduleDraft}
                  onSave={addScheduleBlock}
                />
              )}
            </>
          )}

          {activePage === "Analytics" && (
            <AnalyticsPage
              analytics={analytics}
              tasks={tasks}
              heatmap={heatmap}
              modelEvents={modelEvents}
              backendOnline={backendOnline}
            />
          )}

          {activePage === "Settings" && (
            <SettingsPage
              prefs={prefs}
              setPrefs={setPrefs}
              backendOnline={backendOnline}
              llmAvailable={llmAvailable}
              onResetModel={async () => {
                try {
                  const res = await resetModel();
                  setRecommendation(res.message);
                  refreshModel();
                } catch {
                  setBackendOnline(false);
                }
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

function DashboardPage({
  tasks,
  analytics,
  recommendation,
  handlePropose,
  generating,
  setActivePage,
  hasProposal,
  hasCommitted,
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2 bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.25)] p-6">
        <h3 className="font-bold text-xl mb-4 text-slate-950">Dashboard Overview</h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <StatCard number={analytics.completionRate + "%"} label="Completed" />
          <StatCard number={tasks.length} label="Tasks" />
          <StatCard number={analytics.skipped} label="Skipped Blocks" />
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-3xl p-5 mb-6 shadow-sm">
          <h4 className="font-bold mb-2 text-slate-900">Assistant</h4>
          <p className="text-sm leading-6 text-slate-600">{recommendation}</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => setActivePage("Tasks")}
            className="bg-slate-950 text-white rounded-2xl px-5 py-3 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            Add or Manage Tasks
          </button>

          <button
            onClick={handlePropose}
            disabled={generating}
            className="bg-amber-400 text-slate-950 rounded-2xl px-5 py-3 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60"
          >
            {generating ? "Thinking…" : hasProposal ? "Re-propose a Plan" : "Propose a Plan"}
          </button>

          {(hasProposal || hasCommitted) && (
            <button
              onClick={() => setActivePage("Calendar")}
              className="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              {hasProposal ? "Review proposal →" : "Open calendar →"}
            </button>
          )}
        </div>
      </section>

      <section className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6">
        <h3 className="font-bold text-xl mb-4 text-slate-950">Upcoming Tasks</h3>
        <div className="space-y-3">
          {tasks.slice(0, 5).map((task) => (
            <div key={task.id} className="border rounded-2xl p-4 bg-slate-50">
              <div className="font-semibold">{task.title}</div>
              <div className="text-sm text-slate-600">
                {task.course} · {task.difficulty} · {task.priority}
              </div>
              <div className="text-xs text-slate-500 mt-1">Deadline: {task.deadline}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

function TasksPage({
  form,
  setForm,
  tasks,
  handleAddTask,
  handleDeleteTask,
  handlePropose,
  generating,
}) {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.25)] p-6">
        <h3 className="font-bold text-lg mb-4 text-slate-950">Add Study Task</h3>

        <form onSubmit={handleAddTask} className="space-y-4">
          <div>
            <Label>Task Title</Label>
            <input
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              placeholder="e.g. IUI Presentation Preparation"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>

          <div>
            <Label>Course</Label>
            <input
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              placeholder="e.g. Intelligent User Interfaces"
              value={form.course}
              onChange={(e) => setForm({ ...form, course: e.target.value })}
            />
          </div>

          <div>
            <Label>Deadline</Label>
            <input
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              type="date"
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
          </div>

          <div>
            <Label>Estimated Study Hours</Label>
            <input
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              type="number"
              min="0.5"
              step="0.5"
              value={form.estimatedHours}
              onChange={(e) => setForm({ ...form, estimatedHours: e.target.value })}
            />
          </div>

          <div>
            <Label>Difficulty</Label>
            <select
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={form.difficulty}
              onChange={(e) => setForm({ ...form, difficulty: e.target.value })}
            >
              <option>Easy</option>
              <option>Medium</option>
              <option>Hard</option>
            </select>
          </div>

          <div>
            <Label>Priority</Label>
            <select
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>
          </div>

          <button className="w-full bg-slate-950 text-white rounded-2xl py-2 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
            Add Task
          </button>
        </form>
      </div>

      <div className="lg:col-span-2 bg-white rounded-3xl shadow-sm p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-4">
          <h3 className="font-bold text-lg text-slate-950">Task List</h3>
          <button
            onClick={handlePropose}
            disabled={generating}
            className="bg-amber-400 text-slate-950 rounded-2xl px-5 py-2 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60"
          >
            {generating ? "Thinking…" : "Propose a Plan"}
          </button>
        </div>

        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="border rounded-2xl p-4 bg-slate-50 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
            >
              <div>
                <div className="font-semibold">{task.title}</div>
                <div className="text-sm text-slate-600">
                  {task.course} · {task.difficulty} · {task.priority}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Deadline: {task.deadline} · {task.estimatedHours}h
                </div>
              </div>

              <button
                onClick={() => handleDeleteTask(task.id)}
                className="border border-red-300 text-red-600 rounded-2xl px-4 py-2 text-sm font-semibold transition hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Block detail modal (with on-demand AI explanation)                  */
/* ------------------------------------------------------------------ */

function FactChips({ block }) {
  const sb = block.scoreBreakdown || {};
  const chips = [];
  if (typeof sb.p_complete === "number")
    chips.push(`${Math.round(sb.p_complete * 100)}% predicted completion`);
  if (typeof sb.observations === "number")
    chips.push(`${sb.observations} past observation${sb.observations === 1 ? "" : "s"}`);
  if (typeof sb.days_to_deadline === "number" && sb.days_to_deadline < 90)
    chips.push(`due in ${sb.days_to_deadline} day${sb.days_to_deadline === 1 ? "" : "s"}`);
  if (block.parts > 1) chips.push(`session ${block.part} of ${block.parts}`);
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {chips.map((c) => (
        <span
          key={c}
          className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function ScheduleModal({ draft, onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("Custom Study");

  function handleSubmit(event) {
    event.preventDefault();
    onSave({
      day: draft.day,
      slot: draft.slot,
      title,
      course,
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-[2rem] shadow-2xl p-7 max-w-md w-full mx-4 border border-slate-200"
      >
        <h3 className="text-2xl font-bold text-slate-950 mb-1">Add Schedule</h3>
        <p className="text-sm text-slate-500 mb-5">
          {draft.day} · {draft.slot}
        </p>

        <div className="space-y-4">
          <div>
            <Label>Schedule Title</Label>
            <input
              autoFocus
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              placeholder="e.g. Review lecture notes"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div>
            <Label>Course or Category</Label>
            <input
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={course}
              onChange={(event) => setCourse(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={!title.trim()}
            className="flex-1 bg-slate-950 text-white rounded-2xl px-4 py-3 font-semibold transition hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-2xl px-4 py-3 font-semibold transition hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskModal({ block, isProposed, explainState, onAskWhy, onClose, onStatusChange }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-[2rem] shadow-2xl p-8 max-w-md w-full mx-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
        <h3 className="text-2xl font-bold text-slate-950 mb-1">{block.course}</h3>
        <p className="text-slate-600 text-sm mb-4">
          {block.title}
          <span className="ml-2 text-slate-400">· {block.day} {block.slot}</span>
        </p>

        <FactChips block={block} />

        {block.explanation && (
          <div className="mb-4 rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">
              Why this slot? (from the optimizer)
            </div>
            <p className="text-sm leading-6 text-slate-700">{block.explanation}</p>
          </div>
        )}

        {/* AI assistant explanation, on demand */}
        {explainState?.text ? (
          <div className="mb-5 rounded-[1.5rem] border border-cyan-200 bg-cyan-50 p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-800">
                Assistant
              </span>
              <SourceBadge source={explainState.source} />
            </div>
            <p className="text-sm leading-6 text-cyan-950">{explainState.text}</p>
          </div>
        ) : (
          <button
            onClick={onAskWhy}
            disabled={explainState?.loading}
            className="mb-5 w-full rounded-2xl border border-cyan-300 bg-white px-4 py-2.5 text-sm font-semibold text-cyan-800 transition hover:bg-cyan-50 disabled:opacity-60"
          >
            {explainState?.loading ? "Asking the assistant…" : "Ask the assistant to explain this →"}
          </button>
        )}

        {isProposed ? (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
            This block is part of a <span className="font-semibold">proposed</span> plan. Approve the
            plan to add it to your calendar.
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={() => onStatusChange("Completed")}
              className="flex-1 bg-slate-950 text-white rounded-2xl px-4 py-3 font-semibold transition hover:-translate-y-0.5 hover:shadow-md"
            >
              Mark Done
            </button>
            <button
              onClick={() => onStatusChange("Skipped")}
              className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-2xl px-4 py-3 font-semibold transition hover:bg-slate-50"
            >
              Skip
            </button>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full mt-3 text-slate-600 py-2 text-sm transition hover:text-slate-900"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plan Q&A box                                                        */
/* ------------------------------------------------------------------ */

function AskBox({ planQA, onAsk, llmAvailable }) {
  const [q, setQ] = useState("");
  return (
    <div className="mb-5 rounded-[1.5rem] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onAsk(q);
            }
          }}
          placeholder={
            llmAvailable
              ? "Ask the assistant about this plan… e.g. “Why is Friday so light?”"
              : "Ask about this plan (rule-based answers without an API key)…"
          }
          className="flex-1 rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
        />
        <button
          onClick={() => onAsk(q)}
          disabled={planQA?.loading || !q.trim()}
          className="rounded-2xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-50"
        >
          {planQA?.loading ? "Asking…" : "Ask"}
        </button>
      </div>
      {planQA?.answer && (
        <div className="mt-3 rounded-2xl bg-cyan-50 border border-cyan-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-800">
              Assistant
            </span>
            <SourceBadge source={planQA.source} />
          </div>
          <p className="text-sm leading-6 text-cyan-950">{planQA.answer}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calendar (renders committed, or a proposal under review)            */
/* ------------------------------------------------------------------ */

function ProposedTag({ kind }) {
  if (kind !== "new" && kind !== "changed") return null;
  return (
    <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-950">
      {kind === "new" ? "new" : "moved"}
    </span>
  );
}

function CalendarPage({
  committed,
  proposal,
  onApprove,
  onReject,
  handlePropose,
  generating,
  moveBlockToSlot,
  onRequestScheduleAdd,
  calendarExpanded,
  calendarRefreshKey,
  setCalendarExpanded,
  onOpenBlock,
  planQA,
  onAskAboutPlan,
  llmAvailable,
}) {
  const isProposal = !!proposal;
  const schedule = isProposal ? proposal.schedule : committed;
  const diff = isProposal ? classifyProposal(committed, proposal.schedule) : null;
  const draggable = !isProposal && !!committed;
  const weekStart = useMemo(() => startOfCurrentWeek(), []);
  const initialDate = useMemo(() => toLocalDateString(weekStart), [weekStart]);
  const calendarRef = useRef(null);
  const calendarEvents = useMemo(() => {
    const events = [];
    iterateSchedule(schedule, (day, slot, block) => {
      const { start, end } = datesFromDaySlot(day, slot, weekStart);
      const kind = diff?.map[`${day}|${slot}`];
      const colors = getCalendarEventColors(block);
      events.push({
        id: `${day}|${slot}|${block.taskId ?? block.title}|${block.part ?? 1}`,
        title: `${block.course}: ${block.title}`,
        start,
        end,
        ...colors,
        classNames: [
          "study-event",
          String(block.taskId ?? "").startsWith("manual-") ? "difficulty-manual" : "",
          `difficulty-${(block.difficulty ?? "medium").toLowerCase()}`,
          kind ? `proposal-${kind}` : "",
          block.status === "Completed" ? "is-completed" : "",
          block.status === "Skipped" ? "is-skipped" : "",
        ].filter(Boolean),
        extendedProps: { block: { ...block, day, slot }, day, slot, kind },
      });
    });
    return events;
  }, [schedule, diff, weekStart]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return undefined;
    const id = window.requestAnimationFrame(() => {
      api.unselect();
      api.updateSize();
    });
    return () => window.cancelAnimationFrame(id);
  }, [calendarRefreshKey, calendarExpanded]);

  function handleCalendarChange(info) {
    const { day: sourceDay, slot: sourceSlot } = info.event.extendedProps;
    const targetDay = dayFromDate(info.event.start, weekStart);
    if (!targetDay || !info.event.end) {
      info.revert();
      return;
    }
    const targetSlot = slotFromDates(info.event.start, info.event.end);
    const moved = moveBlockToSlot(sourceDay, sourceSlot, targetDay, targetSlot);
    if (!moved) info.revert();
  }

  function handleSelect(selection) {
    const day = dayFromDate(selection.start, weekStart);
    if (!day) return;
    selection.view.calendar.unselect();
    onRequestScheduleAdd(day, slotFromDates(selection.start, selection.end));
  }

  function handleDateClick(info) {
    const end = new Date(info.date);
    end.setMinutes(end.getMinutes() + 90);
    const day = dayFromDate(info.date, weekStart);
    if (!day) return;
    onRequestScheduleAdd(day, slotFromDates(info.date, end));
  }

  function renderEventContent(info) {
    const { block, kind } = info.event.extendedProps;
    if (info.view.type === "dayGridMonth") {
      return (
        <div className="fc-month-study-content">
          <span className="fc-month-study-title">{block.title}</span>
          <ProposedTag kind={kind} />
        </div>
      );
    }

    return (
      <div className="fc-study-content">
        <div className="fc-study-topline">
          <span>{info.timeText}</span>
          <ProposedTag kind={kind} />
        </div>
        <div className="fc-study-course">{block.course}</div>
        <div className="fc-study-title">{block.title}</div>
        <div className="fc-study-footer">
          <span>
            {block.status === "Completed"
              ? "Done"
              : block.status === "Skipped"
              ? "Skipped"
              : isProposal
              ? "Proposed"
              : "Click for details"}
          </span>
          {block.parts > 1 && <span>{block.part}/{block.parts}</span>}
        </div>
      </div>
    );
  }

  return (
    <section
      className={`bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.25)] p-4 md:p-6 transition-all duration-300 w-full ${
        calendarExpanded ? "fixed inset-3 z-30 overflow-y-auto bg-white" : "relative"
      }`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-5">
        <div>
          <h3 className="font-bold text-xl text-slate-950">Weekly Calendar</h3>
          <p className="text-sm text-slate-500 mt-1">
            {isProposal
              ? "This is a proposal. Review it, then approve to apply — or reject to keep your calendar as is."
              : committed
              ? "Your approved plan. Drag a block to adjust it, or click it to ask the assistant why."
              : "No plan yet. Add tasks and propose a plan to get started."}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end w-full sm:w-auto">
          <button
            onClick={() => setCalendarExpanded((value) => !value)}
            className="bg-slate-950 text-white rounded-2xl px-5 py-2 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            {calendarExpanded ? "Collapse View" : "Expand Calendar"}
          </button>

          <button
            onClick={handlePropose}
            disabled={generating}
            className="bg-amber-400 text-slate-950 rounded-2xl px-5 py-2 font-semibold shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:opacity-60"
          >
            {generating ? "Thinking…" : isProposal ? "Re-propose" : "Propose a Plan"}
          </button>
        </div>
      </div>

      {/* Review bar for a pending proposal */}
      {isProposal && (
        <div className="mb-5 rounded-[1.75rem] border-2 border-amber-300 bg-amber-50 p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-amber-900">
                  Proposed plan — not applied yet
                </span>
                <SourceBadge source={proposal.summarySource} />
              </div>
              <p className="text-sm leading-6 text-amber-950 max-w-3xl">{proposal.summary}</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold text-amber-900">
                <span className="rounded-full bg-white/70 px-2 py-0.5 ring-1 ring-amber-200">
                  {diff.added} new
                </span>
                {diff.changed > 0 && (
                  <span className="rounded-full bg-white/70 px-2 py-0.5 ring-1 ring-amber-200">
                    {diff.changed} moved
                  </span>
                )}
                {diff.removed > 0 && (
                  <span className="rounded-full bg-white/70 px-2 py-0.5 ring-1 ring-amber-200">
                    {diff.removed} removed
                  </span>
                )}
                {proposal.unplaced > 0 && (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700 ring-1 ring-rose-200">
                    {proposal.unplaced} didn’t fit
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-3 shrink-0">
              <button
                onClick={onApprove}
                className="rounded-2xl bg-emerald-600 px-5 py-2.5 font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-md"
              >
                Approve & apply
              </button>
              <button
                onClick={onReject}
                className="rounded-2xl border border-slate-300 bg-white px-5 py-2.5 font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {schedule && <AskBox planQA={planQA} onAsk={onAskAboutPlan} llmAvailable={llmAvailable} />}

      {!schedule ? (
        <div className="text-slate-500 text-center py-16">
          Nothing scheduled yet. Click “Propose a Plan” to let the assistant draft your week.
        </div>
      ) : (
        <div className="study-calendar rounded-[1.75rem] border border-slate-200 bg-white p-3 shadow-sm">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="timeGridWeek"
            initialDate={initialDate}
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "timeGridWeek,dayGridMonth",
            }}
            allDaySlot={false}
            weekends
            nowIndicator
            selectable={!isProposal}
            editable={draggable}
            eventResizableFromStart={draggable}
            eventOverlap={false}
            selectOverlap={false}
            selectMirror
            slotMinTime="07:00:00"
            slotMaxTime="23:00:00"
            slotDuration="00:15:00"
            snapDuration="00:15:00"
            expandRows
            height={calendarExpanded ? "auto" : 760}
            events={calendarEvents}
            eventContent={renderEventContent}
            eventClick={(info) => onOpenBlock(info.event.extendedProps.block)}
            eventDrop={handleCalendarChange}
            eventResize={handleCalendarChange}
            select={handleSelect}
            dateClick={handleDateClick}
          />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Analytics: learned focus profile                                    */
/* ------------------------------------------------------------------ */

function heatColor(p) {
  if (p >= 0.66) return "bg-emerald-400/80";
  if (p >= 0.58) return "bg-emerald-300/70";
  if (p >= 0.5) return "bg-amber-200/80";
  if (p >= 0.42) return "bg-amber-300/80";
  if (p >= 0.34) return "bg-rose-300/80";
  return "bg-rose-400/80";
}

function FocusHeatmap({ heatmap }) {
  const lookup = {};
  (heatmap ?? []).forEach((c) => (lookup[`${c.day}|${c.slot}`] = c));
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-1 min-w-[640px]">
        <thead>
          <tr>
            <th className="text-left text-xs font-semibold text-slate-500 pr-2" />
            {days.map((d) => (
              <th key={d} className="text-xs font-semibold text-slate-500 px-1">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {timeSlots.map((s) => (
            <tr key={s}>
              <td className="text-xs font-medium text-slate-600 pr-2 whitespace-nowrap">{s}</td>
              {days.map((d) => {
                const cell = lookup[`${d}|${s}`];
                const p = cell?.p ?? 0.5;
                const learning = cell?.learning ?? true;
                return (
                  <td key={d}>
                    <div
                      title={
                        cell
                          ? `${d} ${s}: ${Math.round(p * 100)}% expected completion (±${Math.round(
                              (cell.sd ?? 0) * 100
                            )}%, ${cell.n} obs.${learning ? " - still learning, mostly pooled prior" : ""})`
                          : ""
                      }
                      className={`h-10 w-16 rounded-xl ${heatColor(p)} ${
                        learning ? "opacity-45 ring-1 ring-dashed ring-slate-400" : "ring-1 ring-slate-900/5"
                      } flex items-center justify-center text-[11px] font-bold text-slate-800/90`}
                    >
                      {Math.round(p * 100)}%{learning ? "\u00A0?" : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsPage({ analytics, tasks, heatmap, modelEvents, backendOnline }) {
  const hardTasks = tasks.filter((t) => t.difficulty === "Hard").length;
  const highPriorityTasks = tasks.filter((t) => t.priority === "High").length;

  return (
    <div className="space-y-6">
      <section className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between mb-5">
          <div>
            <h3 className="font-bold text-xl text-slate-950">Your Focus Profile (learned)</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-2xl">
              Expected probability that you complete a study block in each slot. A hierarchical
              Beta-Bernoulli model: cells share strength within their time of day, so the plan
              adapts after just a few taps. Faded “?” cells are still learning (&lt;3 observations).
            </p>
          </div>
          <div className="text-xs font-semibold text-slate-500">
            {backendOnline
              ? `${modelEvents} feedback events observed`
              : "Engine offline - showing last known profile"}
          </div>
        </div>
        <FocusHeatmap heatmap={heatmap} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6">
          <h3 className="font-bold text-xl mb-4 text-slate-950">Schedule Performance</h3>
          <StatCard number={analytics.completionRate + "%"} label="Completion Rate" />
          <p className="text-sm text-slate-600 mt-5 leading-6">
            Share of your approved blocks marked as completed. The model uses this signal to keep
            future proposals realistic.
          </p>
        </div>

        <div className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6">
          <h3 className="font-bold text-xl mb-4 text-slate-950">Workload Summary</h3>
          <div className="space-y-3">
            <StatCard number={tasks.length} label="Total Tasks" />
            <StatCard number={hardTasks} label="Hard Tasks" />
            <StatCard number={highPriorityTasks} label="High Priority Tasks" />
          </div>
        </div>

        <div className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6">
          <h3 className="font-bold text-xl mb-4 text-slate-950">How it decides &amp; explains</h3>
          <div className="bg-slate-50 border border-slate-200 rounded-[1.75rem] p-5 text-sm leading-6 text-slate-600">
            A transparent optimizer picks slots using this Beta-Bernoulli model, deadlines and your
            preferences. An <span className="font-semibold text-slate-800">AI assistant</span> then
            explains each choice in plain language, grounded strictly in those numbers — and the
            plan only reaches your calendar once{" "}
            <span className="font-semibold text-slate-800">you approve it</span>.
          </div>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function SettingsPage({ prefs, setPrefs, backendOnline, llmAvailable, onResetModel }) {
  return (
    <section className="bg-white/95 border border-slate-200 rounded-[2rem] shadow-[0_20px_55px_-35px_rgba(15,23,42,0.15)] p-6 max-w-3xl">
      <h3 className="font-bold text-xl mb-2 text-slate-950">Settings &amp; Preferences</h3>
      <p className="text-sm text-slate-500 mb-6">
        These preferences are sent to the optimizer every time you ask for a proposal.
      </p>

      <div className="space-y-5">
        <div className="border border-slate-200 rounded-[1.75rem] p-5 bg-white shadow-sm">
          <h4 className="font-semibold text-slate-950 mb-3">Preferred Focus Window</h4>
          <div className="flex gap-2">
            {["morning", "afternoon", "evening"].map((w) => (
              <button
                key={w}
                onClick={() => setPrefs({ ...prefs, focusWindow: w })}
                className={`rounded-2xl px-4 py-2 text-sm font-semibold capitalize transition ${
                  prefs.focusWindow === w
                    ? "bg-slate-950 text-white shadow-sm"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-3">Hard tasks get a scoring bonus inside this window.</p>
        </div>

        <div className="border border-slate-200 rounded-[1.75rem] p-5 bg-white shadow-sm">
          <h4 className="font-semibold text-slate-950 mb-3">Maximum Study Blocks per Day</h4>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="5"
              value={prefs.maxBlocksPerDay}
              onChange={(e) => setPrefs({ ...prefs, maxBlocksPerDay: Number(e.target.value) })}
              className="w-56 accent-cyan-600"
            />
            <span className="text-lg font-bold text-slate-900">{prefs.maxBlocksPerDay}</span>
          </div>
          <p className="text-xs text-slate-500 mt-3">The optimizer penalizes days that exceed this load.</p>
        </div>

        <div className="border border-slate-200 rounded-[1.75rem] p-5 bg-white shadow-sm">
          <h4 className="font-semibold text-slate-950 mb-2">AI explanations</h4>
          <p className="text-sm text-slate-600">
            {llmAvailable ? (
              <>
                Connected. The assistant uses an LLM to explain the optimizer’s decisions in natural
                language. Explanations are grounded in the model’s actual numbers.
              </>
            ) : (
              <>
                Running in rule-based mode. Set <code className="rounded bg-slate-100 px-1">ANTHROPIC_API_KEY</code>{" "}
                on the backend to enable LLM-written explanations; the app works either way.
              </>
            )}
          </p>
        </div>

        <div className="border border-slate-200 rounded-[1.75rem] p-5 bg-white shadow-sm">
          <h4 className="font-semibold text-slate-950 mb-2">Focus Profile</h4>
          <p className="text-sm text-slate-600 mb-4">Resets the learned Beta-Bernoulli model back to its prior.</p>
          <button
            onClick={onResetModel}
            disabled={!backendOnline}
            className="rounded-2xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          >
            Reset learned profile
          </button>
        </div>
      </div>
    </section>
  );
}
