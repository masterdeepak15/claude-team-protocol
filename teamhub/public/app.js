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
  usageBy: "developer", // "developer" | "session" — sticky across re-renders of the Usage view
  unreadMessages: [], // messages addressed to owner, read = 0 — powers the notification bell
  boardFilters: { sprint: "", assignee: "", priority: "", search: "" },
  threadMessageCount: 0, // last-rendered count for the open 1:1 thread, to detect "new while scrolled up"
  roomMessageCount: 0, // same, for the chat room feed
};

const THEME_KEY = "teamhub-theme";

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
  wireTheme();
  wireNotifBell();
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
  refreshNotifications();
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
    refreshNotifications();
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

function wireTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const initial = saved || (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(initial);
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeIcon").innerHTML = theme === "light" ? "&#9788;" : "&#9789;";
}

function wireNotifBell() {
  const bell = document.getElementById("notifBell");
  const dropdown = document.getElementById("notifDropdown");
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && e.target !== bell) dropdown.classList.add("hidden");
  });
}

// Refreshes the bell's count/list. Deliberately doesn't mark anything as
// read — a notification appearing is not the same as being read (that only
// happens once the human actually opens the relevant thread; see
// renderMessages/renderChatRoom's markVisibleAsRead calls).
async function refreshNotifications() {
  if (!state.currentProjectId) return;
  try {
    state.unreadMessages = await api.getUnreadMessages(state.currentProjectId);
  } catch {
    return; // stale badge for one cycle is fine; don't throw over a notification refresh
  }
  const badge = document.getElementById("notifBadge");
  const count = state.unreadMessages.length;
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.classList.toggle("hidden", count === 0);

  const list = document.getElementById("notifList");
  list.innerHTML = count
    ? state.unreadMessages
        .map(
          (m) => `
      <button class="notif-item" data-from="${escapeHtml(m.from_handle)}">
        <span class="notif-from">${escapeHtml(m.from_handle)}</span>
        <span class="notif-text">${escapeHtml(m.text)}</span>
        <span class="notif-time">${formatTime(m.ts)}</span>
      </button>`
        )
        .join("")
    : `<p class="empty small">You're all caught up.</p>`;

  list.querySelectorAll(".notif-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("notifDropdown").classList.add("hidden");
      state.selectedMemberHandle = btn.dataset.from;
      document.querySelector('.nav-item[data-view="messages"]').click();
    });
  });
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
    refreshNotifications();
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
  const titles = { dashboard: "Dashboard", board: "Board", sprints: "Sprints", team: "Team", messages: "Messages", chatroom: "Chat Room", usage: "Usage & Cost" };
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
    case "usage":
      return renderUsage();
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
  const f = state.boardFilters;
  content.innerHTML = `
    <div class="board-toolbar">
      <input type="text" id="boardSearch" placeholder="Search by ref or title…" value="${escapeHtml(f.search)}" />
      <select id="boardSprintFilter">
        <option value="">All sprints</option>
        <option value="__none__" ${f.sprint === "__none__" ? "selected" : ""}>No sprint</option>
        ${state.sprints
          .map((s) => `<option value="${s.id}" ${String(f.sprint) === String(s.id) ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
          .join("")}
      </select>
      <select id="boardAssigneeFilter">
        <option value="">All assignees</option>
        <option value="__unassigned__" ${f.assignee === "__unassigned__" ? "selected" : ""}>Unassigned</option>
        ${state.members
          .map((m) => `<option value="${escapeHtml(m.handle)}" ${f.assignee === m.handle ? "selected" : ""}>${escapeHtml(m.handle)}</option>`)
          .join("")}
      </select>
      <select id="boardPriorityFilter">
        <option value="">All priorities</option>
        ${["urgent", "high", "medium", "low"]
          .map((p) => `<option value="${p}" ${f.priority === p ? "selected" : ""}>${p[0].toUpperCase()}${p.slice(1)}</option>`)
          .join("")}
      </select>
      <button type="button" class="btn-link" id="boardClearFilters" ${f.sprint || f.assignee || f.priority || f.search ? "" : "disabled"}>Clear filters</button>
      <span class="board-toolbar-count" id="boardToolbarCount"></span>
    </div>
    <div class="board" id="boardColumns"></div>
  `;

  document.getElementById("boardSearch").addEventListener("input", (e) => {
    state.boardFilters.search = e.target.value;
    renderBoardColumns(); // not a full renderBoard() — would drop input focus mid-keystroke
  });
  document.getElementById("boardSprintFilter").addEventListener("change", (e) => {
    state.boardFilters.sprint = e.target.value;
    renderBoard();
  });
  document.getElementById("boardAssigneeFilter").addEventListener("change", (e) => {
    state.boardFilters.assignee = e.target.value;
    renderBoard();
  });
  document.getElementById("boardPriorityFilter").addEventListener("change", (e) => {
    state.boardFilters.priority = e.target.value;
    renderBoard();
  });
  document.getElementById("boardClearFilters").addEventListener("click", () => {
    state.boardFilters = { sprint: "", assignee: "", priority: "", search: "" };
    renderBoard();
  });

  renderBoardColumns();
}

function sprintNameFor(sprintId) {
  if (sprintId === null || sprintId === undefined) return null;
  return state.sprints.find((s) => s.id === sprintId)?.name ?? `Sprint #${sprintId}`;
}

function filteredBoardTasks() {
  const f = state.boardFilters;
  const needle = f.search.trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (f.sprint === "__none__" && (t.sprint_id !== null && t.sprint_id !== undefined)) return false;
    if (f.sprint && f.sprint !== "__none__" && String(t.sprint_id) !== String(f.sprint)) return false;
    if (f.assignee === "__unassigned__" && t.assignee_handle) return false;
    if (f.assignee && f.assignee !== "__unassigned__" && t.assignee_handle !== f.assignee) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (needle && !t.task_ref.toLowerCase().includes(needle) && !t.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function renderBoardColumns() {
  const filtered = filteredBoardTasks();
  const countEl = document.getElementById("boardToolbarCount");
  if (countEl) countEl.textContent = `${filtered.length} of ${state.tasks.length} tasks`;

  document.getElementById("boardColumns").innerHTML = TASK_STATUSES.map((s) => {
    const columnTasks = filtered.filter((t) => t.status === s);
    return `
      <div class="board-column">
        <div class="board-column-header">${STATUS_LABELS[s]} <span class="count">${columnTasks.length}</span></div>
        <div class="board-column-body">
          ${columnTasks.map(taskCard).join("") || `<p class="empty small">No tasks</p>`}
        </div>
      </div>
    `;
  }).join("");

  wireTaskCardActions();
}

function taskCard(t) {
  const sprintName = sprintNameFor(t.sprint_id);
  return `
    <div class="task-card">
      <div class="task-ref">${escapeHtml(t.task_ref)}</div>
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        <span class="badge priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>
        ${
          sprintName
            ? `<span class="badge sprint-badge">${escapeHtml(sprintName)}</span>`
            : `<span class="badge sprint-badge sprint-badge-none" title="Not assigned to any sprint">No sprint</span>`
        }
      </div>
      <div class="task-actions">
        <select class="task-status-select" data-task-ref="${escapeHtml(t.task_ref)}" aria-label="Change status for ${escapeHtml(t.task_ref)}">
          ${TASK_STATUSES.map((s) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
        </select>
        <select class="task-assignee-select" data-task-ref="${escapeHtml(t.task_ref)}" aria-label="Reassign ${escapeHtml(t.task_ref)}">
          <option value="" ${!t.assignee_handle ? "selected" : ""} disabled>Unassigned</option>
          ${state.members
            .map((m) => `<option value="${escapeHtml(m.handle)}" ${t.assignee_handle === m.handle ? "selected" : ""}>${escapeHtml(m.handle)}</option>`)
            .join("")}
        </select>
      </div>
    </div>
  `;
}

function wireTaskCardActions() {
  document.querySelectorAll(".task-status-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const taskRef = sel.dataset.taskRef;
      try {
        await api.updateTask(taskRef, { status: sel.value });
        await loadProjectData();
        renderBoardColumns();
        showToast(`${taskRef} moved to ${STATUS_LABELS[sel.value]}.`);
      } catch (err) {
        showToast(`Couldn't update ${taskRef}: ${err.message || err}`, true);
        renderBoardColumns(); // revert the select back to the real status
      }
    });
  });
  document.querySelectorAll(".task-assignee-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const taskRef = sel.dataset.taskRef;
      // "Unassigned" is a disabled placeholder — assignTask has no concept
      // of clearing an assignee, so there's nothing meaningful to send yet.
      if (!sel.value) return;
      try {
        await api.updateTask(taskRef, { assignee_handle: sel.value });
        await loadProjectData();
        renderBoardColumns();
        showToast(`${taskRef} reassigned to ${sel.value}.`);
      } catch (err) {
        showToast(`Couldn't reassign ${taskRef}: ${err.message || err}`, true);
        renderBoardColumns();
      }
    });
  });
}

function showToast(message, isError = false) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${isError ? "toast-error" : ""} show`;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove("show"), 3200);
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

function isNearBottom(el, threshold = 96) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

// The dashboard fully replaces these containers' innerHTML on every
// re-render (including ones triggered by someone else's message arriving
// over SSE) — a plain "scroll to bottom" on every render was yanking the
// human back down mid-read. This restores the exact scroll offset when
// they weren't already at the bottom, and surfaces a small pill instead of
// silently doing nothing.
function applyScrollBehavior(el, wasAtBottom, prevScrollTop, grew, jumpBtnId) {
  const jumpBtn = document.getElementById(jumpBtnId);
  if (wasAtBottom) {
    el.scrollTop = el.scrollHeight;
    jumpBtn?.classList.add("hidden");
  } else {
    el.scrollTop = prevScrollTop;
    if (grew) jumpBtn?.classList.remove("hidden");
  }
}

// Called only once messages have actually been rendered into view — never
// just because a notification badge appeared. Only ever touches rows
// addressed to owner (see markOwnerMessagesRead server-side for why that
// matters).
async function markVisibleAsRead(messages) {
  const unreadIds = messages.filter((m) => m.to_handle === OWNER_HANDLE && !m.read).map((m) => m.id);
  if (!unreadIds.length) return;
  try {
    await api.markMessagesRead(state.currentProjectId, unreadIds);
  } catch {
    return; // best-effort — worst case the badge stays slightly stale
  }
  await refreshNotifications();
}

async function renderMessages() {
  if (!state.selectedMemberHandle && state.members.length) {
    state.selectedMemberHandle = state.members[0].handle;
  }

  const prevThreadEl = document.getElementById("threadMessages");
  const wasAtBottom = isNearBottom(prevThreadEl);
  const prevScrollTop = prevThreadEl ? prevThreadEl.scrollTop : 0;
  const prevCount = state.threadMessageCount;

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
        <div class="thread-messages-wrap">
          <div class="thread-messages" id="threadMessages"></div>
          <button class="jump-pill hidden" id="threadJumpBtn" type="button">&darr; New messages</button>
        </div>
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
  const jumpBtn = document.getElementById("threadJumpBtn");
  jumpBtn.addEventListener("click", () => {
    threadEl.scrollTop = threadEl.scrollHeight;
    jumpBtn.classList.add("hidden");
  });

  if (state.selectedMemberHandle) {
    try {
      const messages = await api.listMessages(state.currentProjectId, state.selectedMemberHandle);
      threadEl.innerHTML = messages.length
        ? messages.map((m) => messageBubble(m, OWNER_HANDLE)).join("")
        : `<p class="empty small">No messages yet with ${escapeHtml(state.selectedMemberHandle)}.</p>`;
      applyScrollBehavior(threadEl, wasAtBottom, prevScrollTop, messages.length > prevCount, "threadJumpBtn");
      state.threadMessageCount = messages.length;
      await markVisibleAsRead(messages);
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
  const prevFeedEl = document.getElementById("chatroomMessages");
  const wasAtBottom = isNearBottom(prevFeedEl);
  const prevScrollTop = prevFeedEl ? prevFeedEl.scrollTop : 0;
  const prevCount = state.roomMessageCount;

  content.innerHTML = `
    <div class="chatroom-layout">
      <div class="chatroom-messages-wrap">
        <div class="chatroom-messages" id="chatroomMessages"></div>
        <button class="jump-pill hidden" id="roomJumpBtn" type="button">&darr; New messages</button>
      </div>
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
  const jumpBtn = document.getElementById("roomJumpBtn");
  jumpBtn.addEventListener("click", () => {
    feedEl.scrollTop = feedEl.scrollHeight;
    jumpBtn.classList.add("hidden");
  });

  try {
    const messages = await api.listMessages(state.currentProjectId);
    feedEl.innerHTML = messages.length
      ? messages.map((m) => roomBubble(m)).join("")
      : `<p class="empty small">No messages yet on this project.</p>`;
    applyScrollBehavior(feedEl, wasAtBottom, prevScrollTop, messages.length > prevCount, "roomJumpBtn");
    state.roomMessageCount = messages.length;
    await markVisibleAsRead(messages);
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

// Cost/token usage, reported by agents/runner.ts (and its teamhub-client
// mirror) after every headless cycle — see teamhub/usage.ts. Fetched on
// its own, independent of loadProjectData(), same pattern as
// renderMessages/renderChatRoom: it's not part of the SSE change types
// (message/task/sprint), so nothing else keeps it fresh automatically.
async function renderUsage() {
  content.innerHTML = `
    <div class="seg-toggle" id="usageToggle">
      <button data-by="developer" class="${state.usageBy === "developer" ? "active" : ""}">By developer</button>
      <button data-by="session" class="${state.usageBy === "session" ? "active" : ""}">By session</button>
    </div>
    <div id="usageBody"><p class="empty small">Loading…</p></div>
  `;

  content.querySelectorAll("#usageToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.usageBy = btn.dataset.by;
      renderUsage();
    });
  });

  const bodyEl = document.getElementById("usageBody");
  let rows;
  try {
    rows = await api.getUsage(state.currentProjectId, state.usageBy);
  } catch (err) {
    bodyEl.innerHTML = `<p class="empty">Couldn't load usage: ${escapeHtml(String(err.message || err))}</p>`;
    return;
  }

  if (!rows.length) {
    bodyEl.innerHTML = `<p class="empty">No usage reported yet for this project. This fills in once a headless developer/tester/lead cycle finishes via agents/runner.ts — nothing to show for interactive sessions run straight from Claude Code.</p>`;
    return;
  }

  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const totalCycles = rows.reduce((sum, r) => sum + (r.cycles || 0), 0);
  const totalInput = rows.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
  const totalOutput = rows.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
  const totalCacheRead = rows.reduce((sum, r) => sum + (r.cache_read_tokens || 0), 0);

  bodyEl.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${formatCost(totalCost)}</div><div class="stat-label">Total cost</div></div>
      <div class="stat-card"><div class="stat-value">${formatNumber(totalCycles)}</div><div class="stat-label">Cycles</div></div>
      <div class="stat-card"><div class="stat-value">${formatNumber(totalInput + totalOutput)}</div><div class="stat-label">Input + output tokens</div></div>
      <div class="stat-card"><div class="stat-value">${formatNumber(totalCacheRead)}</div><div class="stat-label">Cache read tokens</div></div>
    </div>
    <div class="panel">
      <h2>${state.usageBy === "developer" ? "Cost by developer" : "Cost by session"}</h2>
      ${state.usageBy === "developer" ? developerUsageTable(rows) : sessionUsageTable(rows)}
    </div>
  `;
}

function developerUsageTable(rows) {
  const sorted = [...rows].sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  return `
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr><th>Handle</th><th>Cost</th><th>Cycles</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr>
        </thead>
        <tbody>
          ${sorted
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.handle)}</td>
              <td>${formatCost(r.cost_usd)}</td>
              <td>${formatNumber(r.cycles)}</td>
              <td>${formatNumber(r.sessions)}</td>
              <td>${formatNumber(r.input_tokens)}</td>
              <td>${formatNumber(r.output_tokens)}</td>
              <td>${formatNumber(r.cache_read_tokens)}</td>
              <td>${formatNumber(r.cache_write_tokens)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function sessionUsageTable(rows) {
  const sorted = [...rows].sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));
  return `
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr><th>Session</th><th>Handle</th><th>Cost</th><th>Cycles</th><th>Input</th><th>Output</th><th>First</th><th>Last</th></tr>
        </thead>
        <tbody>
          ${sorted
            .map(
              (r) => `
            <tr>
              <td title="${escapeHtml(r.session_id)}">${escapeHtml((r.session_id || "").slice(0, 8))}…</td>
              <td>${escapeHtml(r.handle)}</td>
              <td>${formatCost(r.cost_usd)}</td>
              <td>${formatNumber(r.cycles)}</td>
              <td>${formatNumber(r.input_tokens)}</td>
              <td>${formatNumber(r.output_tokens)}</td>
              <td>${formatTime(r.first_ts)}</td>
              <td>${formatTime(r.last_ts)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function formatCost(n) {
  const v = Number(n) || 0;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
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
