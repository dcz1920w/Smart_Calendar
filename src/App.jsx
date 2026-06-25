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
  undoFeedback,
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

function isManualBlock(block) {
  return String(block?.taskId ?? "").startsWith("manual-");
}

function isPreviouslyMovedBlock(block) {
  return String(block?.explanation ?? "").includes("You moved this block yourself");
}

function isCompletedBlock(block) {
  return block?.status === "Completed";
}

function isSkippedBlock(block) {
  return block?.status === "Skipped";
}

function isStableLocked(block) {
  if (!block) return false;
  if (block.stableLocked === false) return false;
  if (block.stableLocked === true) return true;
  return isManualBlock(block) || isPreviouslyMovedBlock(block);
}

function getLockReason(block) {
  if (!isStableLocked(block)) return null;
  if (block.lockReason) return block.lockReason;
  if (isManualBlock(block)) return "manual";
  if (isPreviouslyMovedBlock(block)) return "user_moved";
  return "stable";
}

function isReservedForProposal(block) {
  return isStableLocked(block) || isManualBlock(block) || isCompletedBlock(block);
}

function normalizeReservedBlock(block, day, slot) {
  const locked = isStableLocked(block) || isCompletedBlock(block);
  const next = {
    ...block,
    day,
    slot,
    stableLocked: locked,
  };
  if (locked) {
    next.lockReason = getLockReason(block);
  } else {
    delete next.lockReason;
  }
  return next;
}

function taskMapFrom(tasks = []) {
  return new Map(tasks.map((task) => [String(task.id), task]));
}

function reservedBlockFitsProposalWindow(block, day, slot, tasksById = new Map()) {
  if (isManualBlock(block) || isCompletedBlock(block) || isSkippedBlock(block)) return true;
  const task = tasksById.get(String(block?.taskId ?? ""));
  if (!task) return false;
  return generatedBlockFitsWindow({ ...block, deadline: block.deadline ?? task.deadline }, day, slot);
}

function lockedScheduleFrom(schedule, tasks = []) {
  const tasksById = taskMapFrom(tasks);
  const locked = normalizeSchedule(null);
  iterateSchedule(schedule, (day, slot, block) => {
    if (!isReservedForProposal(block)) return;
    if (!reservedBlockFitsProposalWindow(block, day, slot, tasksById)) return;
    locked[day][slot] = normalizeReservedBlock(block, day, slot);
  });
  return locked;
}

function hasLockedConflict(schedule, day, slot, ignoredSlot = null) {
  return Object.entries(schedule?.[day] ?? {}).some(
    ([existingSlot, block]) =>
      block &&
      isReservedForProposal(block) &&
      existingSlot !== ignoredSlot &&
      slotsOverlap(existingSlot, slot)
  );
}

function mergeLockedSchedules(schedule, committed, tasks = []) {
  const tasksById = taskMapFrom(tasks);
  const next = normalizeSchedule(schedule);
  iterateSchedule(committed, (day, slot, block) => {
    if (!isReservedForProposal(block)) return;
    if (!reservedBlockFitsProposalWindow(block, day, slot, tasksById)) return;
    next[day][slot] = normalizeReservedBlock(block, day, slot);
  });
  const reserved = lockedScheduleFrom(committed, tasks);
  iterateSchedule(next, (day, slot, block) => {
    if (isReservedForProposal(block)) {
      if (reservedBlockFitsProposalWindow(block, day, slot, tasksById)) return;
      delete next[day][slot];
      return;
    }
    if (!reservedBlockFitsProposalWindow(block, day, slot, tasksById)) {
      delete next[day][slot];
      return;
    }
    if (!hasLockedConflict(reserved, day, slot)) return;
    delete next[day][slot];
  });
  iterateSchedule(committed, (day, slot, block) => {
    if (!isSkippedBlock(block)) return;
    if (hasSlotConflict(next, day, slot)) return;
    next[day][slot] = { ...block, day, slot };
  });
  return next;
}

function lockedTaskPartsFrom(schedule, tasks = []) {
  const tasksById = taskMapFrom(tasks);
  const locked = {};
  iterateSchedule(schedule, (day, slot, block) => {
    if (
      (!isStableLocked(block) && !isCompletedBlock(block) && !isSkippedBlock(block)) ||
      isManualBlock(block) ||
      block.taskId == null
    ) {
      return;
    }
    if (!tasksById.has(String(block.taskId))) return;
    const part = Number(block.part ?? 1);
    if (!Number.isFinite(part)) return;
    const taskId = String(block.taskId);
    locked[taskId] = locked[taskId] ?? new Set();
    locked[taskId].add(part);
  });
  return locked;
}

function getCalendarEventColors(block) {
  if (isManualBlock(block)) {
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

function hoursFromSlot(slot) {
  const [start, end] = slot.split("-");
  if (!start || !end) return 1.5;
  let minutes = minutesFromClock(end) - minutesFromClock(start);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

function calendarTaskViewsFromSchedule(schedule) {
  const items = [];
  iterateSchedule(schedule, (day, slot, block) => {
    if (!isManualBlock(block)) return;
    items.push({
      id: block.taskId,
      title: block.title,
      course: block.course || "Custom Study",
      deadline: "",
      estimatedHours: hoursFromSlot(slot),
      difficulty: block.difficulty || "Medium",
      priority: block.priority || "Medium",
      status: block.status || "Scheduled",
      source: "Calendar",
      scheduledDay: day,
      scheduledSlot: slot,
    });
  });
  return items.sort((a, b) => {
    const dayDiff = dayIndexes[a.scheduledDay] - dayIndexes[b.scheduledDay];
    if (dayDiff !== 0) return dayDiff;
    return minutesFromClock(a.scheduledSlot.split("-")[0]) - minutesFromClock(b.scheduledSlot.split("-")[0]);
  });
}

function taskViewsFrom(tasks, schedule) {
  const normalTasks = tasks.map((task) => ({ ...task, source: "Tasks" }));
  return [...normalTasks, ...calendarTaskViewsFromSchedule(schedule)];
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
    difficultyScore[task.difficulty] * 4 +
    priorityScore[task.priority] * 2 +
    10 / daysLeft
  );
}

function analyticsLookupFromHeatmap(heatmap) {
  const lookup = {};
  (heatmap ?? []).forEach((cell) => {
    lookup[`${cell.day}|${cell.slot}`] = typeof cell.p === "number" ? cell.p : 0.5;
  });
  return lookup;
}

function localSlotScore(block, day, slot, analyticsLookup) {
  const difficultyWeight = { Hard: 3.5, Medium: 2, Easy: 1 };
  const priorityWeight = { High: 0.45, Medium: 0.25, Low: 0.1 };
  const p = analyticsLookup[`${day}|${slot}`] ?? 0.5;
  const deadline = deadlineEndDate(block.deadline);
  const { start } = datesFromDaySlot(day, slot);
  const daysLeft = deadline
    ? Math.max(1, Math.ceil((deadline - start) / (24 * 60 * 60 * 1000)))
    : 14;
  return (
    p * (difficultyWeight[block.difficulty] ?? 2) +
    (priorityWeight[block.priority] ?? 0.25) +
    0.8 / daysLeft
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
      "Placed by the local fallback heuristic (Python engine offline): harder tasks are matched to the strongest analytics slots.",
    scoreBreakdown: {},
  }));
}

function generateLocalProposal(tasks, committedSchedule = null, heatmap = null) {
  const analyticsLookup = analyticsLookupFromHeatmap(heatmap);
  const sortedTasks = [...tasks]
    .filter((task) => task.status !== "Completed")
    .sort((a, b) => getPriorityScore(b) - getPriorityScore(a));

  const lockedParts = lockedTaskPartsFrom(committedSchedule, tasks);
  const blocks = sortedTasks.flatMap((task) =>
    splitTaskIntoBlocks(task).filter(
      (block) => !(lockedParts[String(block.taskId)] ?? new Set()).has(block.part)
    )
  );
  const schedule = lockedScheduleFrom(committedSchedule, tasks);
  days.forEach((day) => {
    schedule[day] = schedule[day] ?? {};
    timeSlots.forEach((slot) => {
      schedule[day][slot] = schedule[day][slot] ?? null;
    });
  });

  for (const block of blocks) {
    const best = days
      .flatMap((day) => timeSlots.map((slot) => ({ day, slot })))
      .filter(({ day, slot }) => {
        if (!generatedBlockFitsWindow(block, day, slot)) return false;
        if (hasLockedConflict(schedule, day, slot)) return false;
        return !schedule[day][slot];
      })
      .sort(
        (a, b) =>
          localSlotScore(block, b.day, b.slot, analyticsLookup) -
          localSlotScore(block, a.day, a.slot, analyticsLookup)
      )[0];
    if (best) {
      const p = analyticsLookup[`${best.day}|${best.slot}`] ?? 0.5;
      schedule[best.day][best.slot] = {
        ...block,
        day: best.day,
        slot: best.slot,
        scoreBreakdown: { p_complete: Math.round(p * 100) / 100 },
      };
    }
  }
  return schedule;
}

/* ------------------------------------------------------------------ */
/* Diff between the committed calendar and a proposed plan             */
/* ------------------------------------------------------------------ */

function classifyProposal(committed, proposal) {
  const map = {};
  const added = [];
  const moved = [];
  const resized = [];
  const removed = [];
  const unchanged = [];
  const protectedBlocks = [];
  const committedByKey = new Map();
  const proposalByKey = new Map();

  iterateSchedule(committed, (day, slot, block) => {
    committedByKey.set(blockIdentity(block), { day, slot, block });
  });

  iterateSchedule(proposal, (day, slot, block) => {
    proposalByKey.set(blockIdentity(block), { day, slot, block });
  });

  proposalByKey.forEach((proposed, key) => {
    const current = committedByKey.get(key);
    const display = changeDisplay(proposed.block, proposed.day, proposed.slot);
    const proposedMapKey = `${proposed.day}|${proposed.slot}`;

    if (!current) {
      map[proposedMapKey] = "new";
      added.push(display);
      return;
    }

    if (isReservedForProposal(proposed.block)) {
      map[proposedMapKey] = "protected";
      protectedBlocks.push({
        ...display,
        fromDay: current.day,
        fromSlot: current.slot,
      });
      return;
    }

    if (current.day !== proposed.day) {
      map[proposedMapKey] = "moved";
      moved.push({
        ...display,
        fromDay: current.day,
        fromSlot: current.slot,
      });
      return;
    }

    if (current.slot !== proposed.slot) {
      const sameStart = current.slot.split("-")[0] === proposed.slot.split("-")[0];
      map[proposedMapKey] = sameStart ? "resized" : "moved";
      const entry = {
        ...display,
        fromDay: current.day,
        fromSlot: current.slot,
      };
      if (sameStart) resized.push(entry);
      else moved.push(entry);
      return;
    }

    map[proposedMapKey] = "same";
    unchanged.push(display);
  });

  committedByKey.forEach((current, key) => {
    if (proposalByKey.has(key)) return;
    removed.push(changeDisplay(current.block, current.day, current.slot));
  });

  return {
    map,
    added,
    moved,
    resized,
    removed,
    unchanged,
    protectedBlocks,
    changed: moved.length + resized.length,
  };
}

function blockIdentity(block) {
  const taskId = block?.taskId ?? "taskless";
  const part = block?.part ?? 1;
  const title = block?.title ?? "Untitled";
  const course = block?.course ?? "General";
  return `${taskId}|${part}|${course}|${title}`;
}

function changeDisplay(block, day, slot) {
  return {
    id: `${blockIdentity(block)}|${day}|${slot}`,
    title: block?.title ?? "Untitled",
    course: block?.course ?? "General",
    day,
    slot,
  };
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
    maxBlockDuration: 1.5,
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
    let calendarCreated = 0;
    let protectedBlocks = 0;
    if (!committed) {
      return { total: 0, completed: 0, skipped: 0, calendarCreated: 0, protectedBlocks: 0, completionRate: 0 };
    }
    iterateSchedule(committed, (_day, _slot, block) => {
      total++;
      if (block.status === "Completed") completed++;
      if (block.status === "Skipped") skipped++;
      if (isManualBlock(block)) calendarCreated++;
      if (isReservedForProposal(block)) protectedBlocks++;
    });
    return {
      total,
      completed,
      skipped,
      calendarCreated,
      protectedBlocks,
      completionRate: total === 0 ? 0 : Math.round((completed / total) * 100),
    };
  }, [committed]);

  const taskViews = useMemo(() => taskViewsFrom(tasks, committed), [tasks, committed]);

  function persistCommitted(next) {
    setCommitted(next);
    setCalendarRefreshKey((value) => value + 1);
    putCommitted(next).catch(() => {});
  }

  function refreshCalendarView() {
    setCalendarRefreshKey((value) => value + 1);
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
      const data = await proposePlan(tasks, prefs, committed);
      const grid = mergeLockedSchedules(data.proposal, committed, tasks);
      days.forEach((day) => {
        Object.entries(grid[day]).forEach(([slot, block]) => {
          grid[day][slot] = block ? { ...block, day, slot } : null;
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
        schedule: generateLocalProposal(tasks, committed, heatmap),
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
    const shouldLockAfterMove = !isManualBlock(sourceBlock);
    delete updated[sourceDay][sourceSlot];
    updated[targetDay][targetSlot] = {
      ...sourceBlock,
      day: targetDay,
      slot: targetSlot,
      stableLocked: shouldLockAfterMove ? true : sourceBlock.stableLocked,
      lockReason: shouldLockAfterMove ? "user_moved" : sourceBlock.lockReason,
      explanation:
        "You moved this block yourself - the assistant keeps your choice (you stay in control).",
    };
    persistCommitted(updated);
    refreshCalendarView();
    setRecommendation("Moved. Your change is saved to your calendar.");
    return true;
  }

  function startScheduleAdd(day, slot) {
    if (!day || !slot) return;
    setScheduleDraft({ day, slot });
    refreshCalendarView();
  }

  function closeScheduleDraft() {
    setScheduleDraft(null);
    refreshCalendarView();
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
      stableLocked: true,
      lockReason: "manual",
      explanation: "You added this schedule directly to the calendar.",
      scoreBreakdown: {},
    };
    persistCommitted(updated);
    setScheduleDraft(null);
    refreshCalendarView();
    setRecommendation("Schedule added and protected from future proposals.");
    return true;
  }

  function unlockBlock(day, slot) {
    if (!committed) return;
    const updated = normalizeSchedule(structuredClone(committed));
    if (!updated[day]?.[slot]) return;
    updated[day][slot] = {
      ...updated[day][slot],
      stableLocked: false,
    };
    delete updated[day][slot].lockReason;
    persistCommitted(updated);
    setSelectedBlock(null);
    refreshCalendarView();
    setRecommendation("Schedule unlocked for future proposals. You can still drag or stretch it anytime.");
  }

  function lockBlock(day, slot) {
    if (!committed) return;
    const updated = normalizeSchedule(structuredClone(committed));
    if (!updated[day]?.[slot]) return;
    updated[day][slot] = {
      ...updated[day][slot],
      stableLocked: true,
      lockReason: isManualBlock(updated[day][slot]) ? "manual" : "user_moved",
    };
    persistCommitted(updated);
    setSelectedBlock(null);
    refreshCalendarView();
    setRecommendation("Schedule locked against future proposals. You can still drag or stretch it.");
  }

  async function updateBlockStatus(day, slot, status) {
    if (!committed) return;
    const updated = normalizeSchedule(structuredClone(committed));
    if (updated[day]?.[slot]) updated[day][slot].status = status;
    persistCommitted(updated);
    refreshCalendarView();

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

  async function undoBlockStatus(day, slot, previousStatus) {
    if (!committed) return;
    const updated = normalizeSchedule(structuredClone(committed));
    if (!updated[day]?.[slot]) return;
    updated[day][slot].status = "Scheduled";
    persistCommitted(updated);
    setSelectedBlock(null);
    refreshCalendarView();

    if (previousStatus === "Completed" || previousStatus === "Skipped") {
      try {
        const res = await undoFeedback(day, slot, previousStatus === "Completed");
        setRecommendation(res.message);
        refreshModel();
        return;
      } catch {
        setBackendOnline(false);
      }
    }
    setRecommendation("Status restored to scheduled.");
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
              tasks={taskViews}
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
              tasks={taskViews}
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
                  onUndoStatus={() =>
                    undoBlockStatus(selectedBlock.day, selectedBlock.slot, selectedBlock.status)
                  }
                  onUnlock={() => unlockBlock(selectedBlock.day, selectedBlock.slot)}
                  onLock={() => lockBlock(selectedBlock.day, selectedBlock.slot)}
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
              tasks={taskViews}
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
          <StatCard number={analytics.calendarCreated} label="Calendar Items" />
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
              <div className="text-xs text-slate-500 mt-1">
                {task.source === "Calendar"
                  ? `Scheduled: ${task.scheduledDay} ${task.scheduledSlot}`
                  : `Deadline: ${task.deadline}`}
              </div>
                {task.source === "Calendar" && (
                  <div className="mt-2 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800">
                    Calendar
                  </div>
                )}
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
                  {task.source === "Calendar"
                    ? `Scheduled: ${task.scheduledDay} ${task.scheduledSlot} · ${task.estimatedHours}h`
                    : `Deadline: ${task.deadline} · ${task.estimatedHours}h`}
                </div>
                {task.source === "Calendar" && (
                  <div className="mt-2 inline-flex rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800">
                    Calendar-created
                  </div>
                )}
              </div>

              {task.source === "Calendar" ? (
                <span className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-500">
                  Edit on calendar
                </span>
              ) : (
                <button
                  onClick={() => handleDeleteTask(task.id)}
                  className="border border-red-300 text-red-600 rounded-2xl px-4 py-2 text-sm font-semibold transition hover:bg-red-50"
                >
                  Delete
                </button>
              )}
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
  const parsedDraftSlot = parseSlot(draft.slot);
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("Custom Study");
  const [day, setDay] = useState(draft.day);
  const [startTime, setStartTime] = useState(
    `${pad2(parsedDraftSlot.startHour)}:${pad2(parsedDraftSlot.startMinute)}`
  );
  const [endTime, setEndTime] = useState(
    `${pad2(parsedDraftSlot.endHour)}:${pad2(parsedDraftSlot.endMinute)}`
  );

  const validTimeRange = minutesFromClock(startTime) < minutesFromClock(endTime);

  function handleSubmit(event) {
    event.preventDefault();
    if (!validTimeRange) return;
    onSave({
      day,
      slot: `${startTime}-${endTime}`,
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
          {day} · {startTime}-{endTime}
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

          <div>
            <Label>Day</Label>
            <select
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={day}
              onChange={(event) => setDay(event.target.value)}
            >
              {days.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start Time</Label>
              <input
                type="time"
                step="900"
                className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </div>
            <div>
              <Label>End Time</Label>
              <input
                type="time"
                step="900"
                className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-slate-900 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            </div>
          </div>

          {!validTimeRange && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
              End time must be later than start time.
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={!title.trim() || !validTimeRange}
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

function TaskModal({
  block,
  isProposed,
  explainState,
  onAskWhy,
  onClose,
  onStatusChange,
  onUndoStatus,
  onUnlock,
  onLock,
}) {
  const locked = isStableLocked(block);
  const canUndoStatus = block.status === "Completed" || block.status === "Skipped";
  const canLockAgain = !locked && isManualBlock(block);
  const lockText =
    getLockReason(block) === "manual"
      ? "Protected manual schedule"
      : "Protected from future proposals";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-[2rem] shadow-2xl p-8 max-w-md w-full mx-4 border border-slate-200 max-h-[90vh] overflow-y-auto">
        <h3 className="text-2xl font-bold text-slate-950 mb-1">{block.course}</h3>
        <p className="text-slate-600 text-sm mb-4">
          {block.title}
          <span className="ml-2 text-slate-400">· {block.day} {block.slot}</span>
        </p>

        {locked && !isProposed && (
          <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900">
            {lockText}
          </div>
        )}

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
          <div className="space-y-3">
            <div className="flex gap-3">
              <button
                onClick={() => onStatusChange("Completed")}
                disabled={block.status === "Completed"}
                className="flex-1 bg-slate-950 text-white rounded-2xl px-4 py-3 font-semibold transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mark Done
              </button>
              <button
                onClick={() => onStatusChange("Skipped")}
                disabled={block.status === "Skipped"}
                className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-2xl px-4 py-3 font-semibold transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Skip
              </button>
            </div>
            {canUndoStatus && (
              <button
                onClick={onUndoStatus}
                className="w-full rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 font-semibold text-amber-900 transition hover:bg-amber-100"
              >
                Undo {block.status === "Completed" ? "Done" : "Skip"}
              </button>
            )}
            {locked && (
              <button
                onClick={onUnlock}
                className="w-full rounded-2xl border border-sky-300 bg-white px-4 py-3 font-semibold text-sky-800 transition hover:bg-sky-50"
              >
                Allow proposals to change this
              </button>
            )}
            {canLockAgain && (
              <button
                onClick={onLock}
                className="w-full rounded-2xl border border-sky-300 bg-sky-700 px-4 py-3 font-semibold text-white transition hover:bg-sky-800"
              >
                Protect from proposals
              </button>
            )}
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
  const labels = {
    new: "new",
    moved: "moved",
    resized: "resized",
    protected: "protected",
  };
  if (!labels[kind]) return null;
  return (
    <span className={`proposal-tag proposal-tag-${kind}`}>
      {labels[kind]}
    </span>
  );
}

function ProposalChangesPanel({ diff }) {
  if (!diff) return null;
  const groups = [
    ["New", diff.added, "proposal-change-new"],
    ["Moved", diff.moved, "proposal-change-moved"],
    ["Resized", diff.resized, "proposal-change-resized"],
    ["Removed", diff.removed, "proposal-change-removed"],
    ["Protected", diff.protectedBlocks, "proposal-change-protected"],
  ].filter(([, items]) => items.length > 0);

  if (groups.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
        No calendar changes in this proposal.
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white/85 p-4">
      <div className="mb-3 text-sm font-bold text-slate-900">Schedule changes</div>
      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map(([label, items, className]) => (
          <div key={label} className={`proposal-change-group ${className}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-600">
                {label}
              </span>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                {items.length}
              </span>
            </div>
            <div className="space-y-2">
              {items.slice(0, 4).map((item) => (
                <div key={item.id} className="text-sm leading-5 text-slate-800">
                  <span className="font-semibold">{item.title}</span>
                  <span className="text-slate-500"> · {item.course}</span>
                  <div className="text-xs font-semibold text-slate-500">
                    {item.fromDay
                      ? `${item.fromDay} ${item.fromSlot} -> ${item.day} ${item.slot}`
                      : `${item.day} ${item.slot}`}
                  </div>
                </div>
              ))}
              {items.length > 4 && (
                <div className="text-xs font-semibold text-slate-500">
                  +{items.length - 4} more
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
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
  const calendarSchedule = schedule ?? normalizeSchedule(null);
  const diff = isProposal ? classifyProposal(committed, proposal.schedule) : null;
  const draggable = !isProposal && !!committed;
  const weekStart = useMemo(() => startOfCurrentWeek(), []);
  const initialDate = useMemo(() => toLocalDateString(weekStart), [weekStart]);
  const calendarRef = useRef(null);
  const clickTimerRef = useRef(null);
  const lastDateClickRef = useRef(null);
  const calendarEvents = useMemo(() => {
    const events = [];
    iterateSchedule(calendarSchedule, (day, slot, block) => {
      const { start, end } = datesFromDaySlot(day, slot, weekStart);
      const kind = diff?.map[`${day}|${slot}`];
      const colors = getCalendarEventColors(block);
      events.push({
        id: `${day}|${slot}|${block.taskId ?? block.title}|${block.part ?? 1}`,
        title: `${block.course}: ${block.title}`,
        start,
        end,
        ...colors,
        editable: draggable,
        startEditable: draggable,
        durationEditable: draggable,
        classNames: [
          "study-event",
          String(block.taskId ?? "").startsWith("manual-") ? "difficulty-manual" : "",
          `difficulty-${(block.difficulty ?? "medium").toLowerCase()}`,
          isStableLocked(block) ? "is-locked" : "",
          kind ? `proposal-${kind}` : "",
          block.status === "Completed" ? "is-completed" : "",
          block.status === "Skipped" ? "is-skipped" : "",
        ].filter(Boolean),
        extendedProps: {
          block: {
            ...block,
            day,
            slot,
            stableLocked: isStableLocked(block),
            lockReason: getLockReason(block),
          },
          day,
          slot,
          kind,
        },
      });
    });
    return events;
  }, [calendarSchedule, diff, weekStart, draggable]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return undefined;
    const id = window.requestAnimationFrame(() => api.updateSize());
    return () => window.cancelAnimationFrame(id);
  }, [calendarRefreshKey, calendarExpanded]);

  function refreshFullCalendar() {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    window.requestAnimationFrame(() => {
      api.updateSize();
    });
  }

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
    refreshFullCalendar();
  }

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  function selectCalendarSlot(start) {
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 90);
    const api = calendarRef.current?.getApi();
    api?.select(start, end);
    api?.updateSize();
    return end;
  }

  function requestScheduleAddFromDate(date) {
    const end = new Date(date);
    end.setMinutes(end.getMinutes() + 90);
    const day = dayFromDate(date, weekStart);
    if (!day) return;
    const api = calendarRef.current?.getApi();
    api?.unselect();
    api?.updateSize();
    onRequestScheduleAdd(day, slotFromDates(date, end));
    refreshFullCalendar();
  }

  function handleDateClick(info) {
    const now = Date.now();
    const last = lastDateClickRef.current;
    const clickedAt = info.date.getTime();
    const clickedInsideLastSelection =
      last && clickedAt >= last.start.getTime() && clickedAt < last.end.getTime();
    const isDoubleClick =
      info.jsEvent?.detail >= 2 ||
      (last && clickedInsideLastSelection && now - last.time < 500);

    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }

    if (isDoubleClick) {
      const addFrom = last?.start ?? info.date;
      lastDateClickRef.current = null;
      requestScheduleAddFromDate(addFrom);
      return;
    }

    const end = selectCalendarSlot(info.date);
    refreshFullCalendar();
    lastDateClickRef.current = { start: info.date, end, time: now };
    clickTimerRef.current = window.setTimeout(() => {
      lastDateClickRef.current = null;
      clickTimerRef.current = null;
    }, 500);
  }

  function handleCalendarDoubleClick(event) {
    if (isProposal || event.target.closest(".fc-event")) return;
    const last = lastDateClickRef.current;
    if (!last) return;
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    lastDateClickRef.current = null;
    requestScheduleAddFromDate(last.start);
  }

  function renderEventContent(info) {
    const eventBlock = info.event.extendedProps?.block || {};
    const kind = info.event.extendedProps?.kind;
    const course = eventBlock.course || "Study";
    const title = eventBlock.title || "Study block";
    const status = eventBlock.status;
    const parts = eventBlock.parts ?? 1;
    const part = eventBlock.part ?? 1;

    if (info.view.type === "dayGridMonth") {
      return (
        <div className="fc-month-study-content">
          <span className="fc-month-study-title">{title}</span>
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
        <div className="fc-study-course">{course}</div>
        <div className="fc-study-title">{title}</div>
        <div className="fc-study-footer">
          <span>
            {status === "Completed"
              ? "Done"
              : status === "Skipped"
              ? "Skipped"
              : isStableLocked(eventBlock)
              ? "Locked"
              : isProposal
              ? "Proposed"
              : "Click for details"}
          </span>
          {parts > 1 && <span>{part}/{parts}</span>}
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
              : "Your calendar is ready for direct schedule blocks."}
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
                  {diff.added.length} new
                </span>
                {diff.changed > 0 && (
                  <span className="rounded-full bg-white/70 px-2 py-0.5 ring-1 ring-amber-200">
                    {diff.changed} changed
                  </span>
                )}
                {diff.removed.length > 0 && (
                  <span className="rounded-full bg-white/70 px-2 py-0.5 ring-1 ring-amber-200">
                    {diff.removed.length} removed
                  </span>
                )}
                {diff.protectedBlocks.length > 0 && (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-800 ring-1 ring-sky-200">
                    {diff.protectedBlocks.length} protected
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
          <ProposalChangesPanel diff={diff} />
        </div>
      )}

      {schedule && <AskBox planQA={planQA} onAsk={onAskAboutPlan} llmAvailable={llmAvailable} />}

      <div
        className="study-calendar rounded-[1.75rem] border border-slate-200 bg-white p-3 shadow-sm"
        onDoubleClick={handleCalendarDoubleClick}
      >
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
          eventClick={(info) => {
            onOpenBlock(info.event.extendedProps.block);
            refreshFullCalendar();
          }}
          eventDrop={handleCalendarChange}
          eventResize={handleCalendarChange}
          dateClick={handleDateClick}
        />
      </div>
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
            <StatCard number={analytics.calendarCreated} label="Calendar-Created" />
            <StatCard number={analytics.protectedBlocks} label="Protected Blocks" />
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
          <h4 className="font-semibold text-slate-950 mb-3">Maximum Study Block Duration</h4>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.5"
              value={prefs.maxBlockDuration}
              onChange={(e) => setPrefs({ ...prefs, maxBlockDuration: Number(e.target.value) })}
              className="w-56 accent-cyan-600"
            />
            <span className="text-lg font-bold text-slate-900">{prefs.maxBlockDuration}h</span>
          </div>
          <p className="text-xs text-slate-500 mt-3">Tasks will be split into blocks not exceeding this duration.</p>
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
