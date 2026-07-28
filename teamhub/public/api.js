const BASE = "/api";

async function request(path, options) {
  const res = await fetch(BASE + path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  listProjects: () => request("/projects"),
  getProject: (id) => request(`/projects/${encodeURIComponent(id)}`),
  listMembers: (id) => request(`/projects/${encodeURIComponent(id)}/members`),
  listSprints: (id) => request(`/projects/${encodeURIComponent(id)}/sprints`),
  listTasks: (id, filters = {}) => {
    const params = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""))
    );
    const qs = params.toString();
    return request(`/projects/${encodeURIComponent(id)}/tasks${qs ? "?" + qs : ""}`);
  },
  getTask: (taskRef) => request(`/tasks/${encodeURIComponent(taskRef)}`),
  listMessages: (id, handle) =>
    request(
      `/projects/${encodeURIComponent(id)}/messages${handle ? "?handle=" + encodeURIComponent(handle) : ""}`
    ),
  sendMessage: (project_id, from_handle, to_handle, text) =>
    request("/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id, from_handle, to_handle, text }),
    }),
};

// Returns an unsubscribe function. `onEvent` receives parsed { kind, project_id, ts }
// for every real change; heartbeat/comment lines are ignored automatically.
export function subscribeEvents(projectId, onEvent) {
  const url = `${BASE}/events${projectId ? "?project_id=" + encodeURIComponent(projectId) : ""}`;
  const source = new EventSource(url);
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // heartbeat/comment-only lines aren't JSON — ignore
    }
  };
  return () => source.close();
}
