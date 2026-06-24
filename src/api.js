// Client for the Smart Study Calendar engine.
// The AI never changes the calendar on its own: it proposes, the user commits.

const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

export async function checkHealth() {
  try {
    return await request("/health");
  } catch {
    return null;
  }
}

export function proposePlan(tasks, preferences) {
  return request("/schedule/propose", {
    method: "POST",
    body: JSON.stringify({ tasks, preferences }),
  });
}

export function getCommitted() {
  return request("/schedule/committed");
}

export function putCommitted(schedule) {
  return request("/schedule/committed", {
    method: "PUT",
    body: JSON.stringify({ schedule }),
  });
}

export function explainPlan(schedule, question = null) {
  return request("/explain", {
    method: "POST",
    body: JSON.stringify({ schedule, question }),
  });
}

export function sendFeedback(day, slot, completed) {
  return request("/feedback", {
    method: "POST",
    body: JSON.stringify({ day, slot, completed }),
  });
}

export function fetchModel() {
  return request("/model");
}

export function resetModel() {
  return request("/model/reset", { method: "POST" });
}

export function fetchTasks() {
  return request("/tasks");
}

export function saveTasks(tasks) {
  return request("/tasks", { method: "PUT", body: JSON.stringify({ tasks }) });
}
