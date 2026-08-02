import { api, subscribeEvents, setUnauthorizedHandler } from "./api.js";

// Reserved handle for the human dashboard operator — never a registered
// agent (the server rejects registering this handle; see
// teamhub/members.ts). Every message composed in this UI is sent as this
// fixed identity, talking to a real member. This is deliberate, not a
// missing feature: letting "from" be any registered handle (as it used to
// be) made it possible to pick the same handle for both "from" and "to"
// and send a message to itself.
const OWNER_HANDLE = "owner";

const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked"];
const STATUS_LABELS = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
};

const state = {
  projects: [],
  currentProjectId: null,
  currentView: "dashboard",
  members: [],
  sprints: [],
  tasks: [],
  selectedMemberHandle: null,
  eventsUnsub: null,
};

const content = document.getElementById("content");
const viewTitle = document.getElementById("viewTitle");
const projectSelect = document.getElementById("projectSelect");
const connDot = document.getElementById("connDot");
const loginScreen = document.getElementById("loginScreen");
const appRoot = document.getElementById("app");
const loginForm = document.getElementById("loginForm");
const loginTokenInput = document.getElementById("loginToken");
const loginError = document.getElementById("loginError");
const logoutBtn = document.getElementById("logoutBtn");

async function init() {
  wireNav();
  wireSidebarToggle();
  setUnauthorizedHandler(showLoginScreen);
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    try {
      await api.login(loginTokenInput.value);
      loginTokenInput.value = "";
      await showApp();
    } catch (err) {
      loginError.textContent = err.message || "Login failed.";
    }
  });
  logoutBtn.addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {
      // Even if the logout request itself fails, still show the login
      // screen locally — staying on the dashboard after clicking "Log out"
      // would be a worse outcome than a stale session on the server side.
    }
    showLoginScreen();
  });

  const { loggedIn } = await api.session();
  if (loggedIn) {
    await showApp();
  } else {
    showLoginScreen();
  }
}

function showLoginScreen() {
  if (state.eventsUnsub) {
    state.eventsUnsub();
    state.eventsUnsub = null;
  }
  appRoot.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginTokenInput.value = "";
  loginError.textContent = "";
  loginTokenInput.focus();
}

async function showApp() {
  loginScreen.classList.add("hidden");
  appRoot.classList.remove("hidden");
  try {
    state.projects = await api.listProjects();
  } catch (err) {
    content.innerHTML = `<p class="empty">Couldn't load projects: ${escapeHtml(String(err.message || err))}</p>`;
    return;
  }
  renderProjectPicker();
  if (state.projects.length) {
    state.currentProjectId = state.projects[0].id;
    projectSelect.value = state.currentProjectId;
    await loadProjectData();
  }
  renderView();
  connectEvents();
}

function renderProjectPicker() {
  projectSelect.innerHTML = state.projects
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");
  projectSelect.onchange = async () => {
    state.currentProjectId = projectSelect.value;
    state.selectedMemberHandle = null;
    await loadProjectData();
    renderView();
    connectEvents();
  };
}

async function loadProjectData() {
  if (!state.currentProjectId) return;
  const [members, sprints, tasks] = await Promise.all([
    api.listMembers(state.currentProjectId),
    api.listSprints(state.currentProjectId),
    api.listTasks(state.currentProjectId),
  ]);
  state.members = members;
  state.sprints = sprints;
  state.tasks = tasks;
}

function wireNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentView = btn.dataset.view;
      closeSidebarOnMobile();
      renderView();
    });
  });
}

function wireSidebarToggle() {
  document.getElementById("hamburger").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
  document.getElementById("sidebarClose").addEventListener("click", closeSidebarOnMobile);
}

function closeSidebarOnMobile() {
  document.getElementById("sidebar").classList.remove("open");
}

function connectEvents() {
  if (state.eventsUnsub) state.eventsUnsub();
  if (state.presenceInterval) clearInterval(state.presenceInterval);
  connDot.classList.remove("connected");
  if (!state.currentProjectId) return;
  state.eventsUnsub = subscribeEvents(state.currentProjectId, async () => {
    connDot.classList.add("connected");
    await loadProjectData();
    renderView();
  });
  setTimeout(() => connDot.classList.add("connected"), 300);

  // "Went offline" has no event to push — it's the absence of one, not an
  // occurrence — so presence needs a periodic re-check independent of the
  // SSE stream above. Members refresh on every real change already; this
  // only exists to catch a handle going quiet with nothing else happening.
  state.presenceInterval = setInterval(async () => {
    if (!state.currentProjectId) return;
    try {
      state.members = await api.listMembers(state.currentProjectId);
      if (["dashboard", "team", "messages"].includes(state.currentView)) renderView();
    } catch {
      // A transient failure here just means presence is stale for one
      // cycle — not worth surfacing as an error to the user.
    }
  }, 20000);
}

function renderView() {
  const titles = { dashboard: "Dashboard", board: "Board", sprints: "Sprints", team: "Team", messages: "Messages", chatroom: "Chat Room" };
  viewTitle.textContent = titles[state.currentView] || "TeamHub";

  if (!state.currentProjectId) {
    content.innerHTML = `<p class="empty">No projects yet. Create one from any TeamHub session (call create_project), then refresh.</p>`;
    return;
  }

  switch (state.currentView) {
    case "dashboard":
      return renderDashboard();
    case "board":
      return renderBoard();
    case "sprints":
      return renderSprints();
    case "team":
      return renderTeam();
    case "messages":
      return renderMessages();
    case "chatroom":
      return renderChatRoom();
    default:
      return renderDashboard();
  }
}

function renderDashboard() {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, state.tasks.filter((t) => t.status === s).length]));
  const activeSprint = state.sprints.find((s) => s.status === "active");

  content.innerHTML = `
    <div class="stat-grid">
      ${TASK_STATUSES.map(
        (s) => `
        <div class="stat-card">
          <div class="stat-value">${counts[s]}</div>
          <div class="stat-label">${STATUS_LABELS[s]}</div>
        </div>`
      ).join("")}
    </div>
    <div class="panel">
      <h2>Active sprint</h2>
      ${
        activeSprint
          ? `<p>${escapeHtml(activeSprint.name)}${
              activeSprint.start_date ? ` — ${escapeHtml(activeSprint.start_date)} to ${escapeHtml(activeSprint.end_date || "?")}` : ""
            }</p>`
          : `<p class="empty">No active sprint.</p>`
      }
    </div>
    <div class="panel">
      <h2>Team roster</h2>
      ${renderMemberTable(state.members)}
    </div>
  `;
}

function renderMemberTable(members) {
  if (!members.length) return `<p class="empty">No one registered on this project yet.</p>`;
  return `
    <div class="table-scroll">
      <table class="table">
        <thead><tr><th></th><th>Handle</th><th>Role</th><th>Mode</th><th>Status</th><th>Last seen</th></tr></thead>
        <tbody>
          ${members
            .map(
              (m) => `
            <tr>
              <td><span class="presence-dot ${m.online ? "online" : "offline"}" title="${m.online ? "Online" : "Offline"}"></span></td>
              <td>${escapeHtml(m.handle)}</td>
              <td><span class="badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span></td>
              <td><span class="badge mode-${escapeHtml(m.mode)}">${escapeHtml(m.mode)}</span></td>
              <td>${escapeHtml(m.status || "—")}</td>
              <td>${formatTime(m.last_seen)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderBoard() {
  content.innerHTML = `
    <div class="board">
      ${TASK_STATUSES.map((s) => {
        const columnTasks = state.tasks.filter((t) => t.status === s);
        return `
          <div class="board-column">
            <div class="board-column-header">${STATUS_LABELS[s]} <span class="count">${columnTasks.length}</span></div>
            <div class="board-column-body">
              ${columnTasks.map(taskCard).join("") || `<p class="empty small">No tasks</p>`}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function taskCard(t) {
  return `
    <div class="task-card">
      <div class="task-ref">${escapeHtml(t.task_ref)}</div>
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        ${t.assignee_handle ? `<span class="badge">${escapeHtml(t.assignee_handle)}</span>` : `<span class="badge unassigned">unassigned</span>`}
        <span class="badge priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>
      </div>
    </div>
  `;
}

function renderSprints() {
  if (!state.sprints.length) {
    content.innerHTML = `<p class="empty">No sprints yet.</p>`;
    return;
  }
  content.innerHTML = `
    <div class="panel-list">
      ${state.sprints
        .map((s) => {
          const sprintTasks = state.tasks.filter((t) => t.sprint_id === s.id);
          return `
          <div class="panel">
            <h2>${escapeHtml(s.name)} <span class="badge status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></h2>
            <p class="muted">${escapeHtml(s.start_date || "no start date")} – ${escapeHtml(s.end_date || "no end date")}</p>
            <div class="table-scroll">
              <table class="table">
                <thead><tr><th>Task</th><th>Title</th><th>Status</th><th>Assignee</th></tr></thead>
                <tbody>
                  ${
                    sprintTasks
                      .map(
                        (t) => `
                    <tr>
                      <td>${escapeHtml(t.task_ref)}</td>
                      <td>${escapeHtml(t.title)}</td>
                      <td><span class="badge status-${escapeHtml(t.status)}">${STATUS_LABELS[t.status]}</span></td>
                      <td>${escapeHtml(t.assignee_handle || "—")}</td>
                    </tr>`
                      )
                      .join("") || `<tr><td colspan="4" class="empty">No tasks in this sprint</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

function renderTeam() {
  if (!state.members.length) {
    content.innerHTML = `<p class="empty">No one registered on this project yet.</p>`;
    return;
  }
  content.innerHTML = `
    <div class="card-grid">
      ${state.members
        .map(
          (m) => `
        <div class="member-card">
          <div class="member-handle">
            <span class="presence-dot ${m.online ? "online" : "offline"}" title="${m.online ? "Online" : "Offline"}"></span>
            ${escapeHtml(m.handle)}
            <span class="presence-label">${m.online ? "online" : "offline"}</span>
          </div>
          <div class="member-badges">
            <span class="badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
            <span class="badge mode-${escapeHtml(m.mode)}">${escapeHtml(m.mode)}</span>
          </div>
          <div class="member-status">${escapeHtml(m.status || "no status reported")}</div>
          <button class="btn-link" data-message-handle="${escapeHtml(m.handle)}">Message</button>
        </div>`
        )
        .join("")}
    </div>
  `;
  content.querySelectorAll("[data-message-handle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedMemberHandle = btn.dataset.messageHandle;
      document.querySelector('.nav-item[data-view="messages"]').click();
    });
  });
}

async function renderMessages() {
  if (!state.selectedMemberHandle && state.members.length) {
    state.selectedMemberHandle = state.members[0].handle;
  }

  content.innerHTML = `
    <div class="messages-layout">
      <div class="member-list">
        ${
          state.members
            .map(
              (m) => `
          <button class="member-list-item ${m.handle === state.selectedMemberHandle ? "active" : ""}" data-handle="${escapeHtml(m.handle)}">
            <span class="presence-dot ${m.online ? "online" : "offline"}" title="${m.online ? "Online" : "Offline"}"></span>
            <span>${escapeHtml(m.handle)}</span>
            <span class="badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
          </button>`
            )
            .join("") || `<p class="empty small">No members yet.</p>`
        }
      </div>
      <div class="thread">
        <div class="thread-messages" id="threadMessages"></div>
        <form class="composer" id="composer">
          <span class="composer-from">Owner →</span>
          <input type="text" id="composerText" placeholder="Type a reply…" autocomplete="off" />
          <button type="submit">Send</button>
        </form>
      </div>
    </div>
  `;

  content.querySelectorAll(".member-list-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedMemberHandle = btn.dataset.handle;
      renderMessages();
    });
  });

  const threadEl = document.getElementById("threadMessages");
  if (state.selectedMemberHandle) {
    try {
      const messages = await api.listMessages(state.currentProjectId, state.selectedMemberHandle);
      threadEl.innerHTML = messages.length
        ? messages.map((m) => messageBubble(m, OWNER_HANDLE)).join("")
        : `<p class="empty small">No messages yet with ${escapeHtml(state.selectedMemberHandle)}.</p>`;
      threadEl.scrollTop = threadEl.scrollHeight;
    } catch (err) {
      threadEl.innerHTML = `<p class="empty small">Couldn't load messages: ${escapeHtml(String(err.message || err))}</p>`;
    }
  }

  document.getElementById("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const textInput = document.getElementById("composerText");
    const text = textInput.value.trim();
    if (!text || !state.selectedMemberHandle) return;
    await api.sendMessage(state.currentProjectId, OWNER_HANDLE, state.selectedMemberHandle, text);
    textInput.value = "";
    await renderMessages();
  });
}

// Combined project-wide timeline — every message between every pair of
// members, in one feed, each sender color-coded consistently. Unlike
// renderMessages (a 1:1 thread you pick), this is the "whole room at once"
// view. Real-time comes for free: connectEvents() already re-renders
// whatever view is active on any "message" change over the existing SSE
// stream, so no extra wiring is needed here for live updates.
async function renderChatRoom() {
  content.innerHTML = `
    <div class="chatroom-layout">
      <div class="chatroom-messages" id="chatroomMessages"></div>
      <form class="composer" id="chatroomComposer">
        <span class="composer-from">Owner →</span>
        <select id="chatroomTo" aria-label="Send to"></select>
        <input type="text" id="chatroomText" placeholder="Type a message…" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </div>
  `;

  const toSelect = document.getElementById("chatroomTo");
  toSelect.innerHTML = state.members
    .map((m) => `<option value="${escapeHtml(m.handle)}">${escapeHtml(m.handle)}</option>`)
    .join("");

  const feedEl = document.getElementById("chatroomMessages");
  try {
    const messages = await api.listMessages(state.currentProjectId);
    feedEl.innerHTML = messages.length
      ? messages.map((m) => roomBubble(m)).join("")
      : `<p class="empty small">No messages yet on this project.</p>`;
    feedEl.scrollTop = feedEl.scrollHeight;
  } catch (err) {
    feedEl.innerHTML = `<p class="empty small">Couldn't load messages: ${escapeHtml(String(err.message || err))}</p>`;
  }

  document.getElementById("chatroomComposer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const to = toSelect.value;
    const textInput = document.getElementById("chatroomText");
    const text = textInput.value.trim();
    if (!text || !to) return;
    await api.sendMessage(state.currentProjectId, OWNER_HANDLE, to, text);
    textInput.value = "";
    await renderChatRoom();
  });
}

// Deterministic handle -> color, so the same member always gets the same
// avatar color across renders/sessions (no stored color assignment needed).
function hashColor(handle) {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash << 5) - hash + handle.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

function initials(handle) {
  const parts = handle.split(/[-_\s]/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || handle.slice(0, 2).toUpperCase();
}

function colorFor(handle) {
  if (handle === OWNER_HANDLE) return "var(--accent)";
  return hashColor(handle);
}

function roomBubble(m) {
  const color = colorFor(m.from_handle);
  const label = m.from_handle === OWNER_HANDLE ? "Owner" : m.from_handle;
  return `
    <div class="room-bubble">
      <div class="room-avatar" style="background:${color}">${escapeHtml(initials(label))}</div>
      <div class="room-body">
        <div class="room-meta">
          <span class="room-sender" style="color:${color}">${escapeHtml(label)}</span>
          → ${escapeHtml(m.to_handle)} · ${formatTime(m.ts)} · ${escapeHtml(m.type)}
        </div>
        <div class="room-text">${escapeHtml(m.text)}</div>
      </div>
    </div>
  `;
}

function messageBubble(m, viewerHandle) {
  const mine = m.from_handle === viewerHandle;
  return `
    <div class="bubble ${mine ? "mine" : "theirs"}">
      <div class="bubble-meta">${escapeHtml(m.from_handle)} → ${escapeHtml(m.to_handle)} · ${formatTime(m.ts)} · ${escapeHtml(m.type)}</div>
      <div class="bubble-text">${escapeHtml(m.text)}</div>
    </div>
  `;
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

init();
