import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("gate module", () => {
  it("hasUnreadMessages is false with an empty inbox, true after a message arrives", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-a", "Gate Project A", "PGA");
    expect(hasUnreadMessages("dev-gate-a")).toBe(false);
    sendMessage("proj-gate-a", "master-1", "dev-gate-a", "hello");
    expect(hasUnreadMessages("dev-gate-a")).toBe(true);
  });

  it("hasUnreadMessages does not consume the message (unlike checkInbox)", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-b", "Gate Project B", "PGB");
    sendMessage("proj-gate-b", "master-1", "dev-gate-b", "hello");
    hasUnreadMessages("dev-gate-b");
    expect(hasUnreadMessages("dev-gate-b")).toBe(true);
  });

  it("hasReadyUnassignedWork ignores backlog-status tasks — backlog means not-yet-ready, not urgent", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { hasReadyUnassignedWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-c", "Gate Project C", "PGC");
    registerMember("dev-gate-c", "proj-gate-c", "developer");
    // createTask defaults to status "backlog" — every new task starts
    // here. This must NOT count as "ready", even with an idle developer
    // sitting right there, or this gate is true almost permanently for
    // any project with a normal backlog.
    createTask("proj-gate-c", "Fix the bug");
    expect(hasReadyUnassignedWork("proj-gate-c")).toBe(false);
  });

  it("hasReadyUnassignedWork is true for an unassigned todo task with an idle developer available", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, updateTaskStatus, assignTask } = await import("../../teamhub/tasks.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { hasReadyUnassignedWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-c2", "Gate Project C2", "PGC2");
    registerMember("dev-gate-c2", "proj-gate-c2", "developer");
    const task = createTask("proj-gate-c2", "Fix the bug");
    updateTaskStatus(task.task_ref, "todo");
    expect(hasReadyUnassignedWork("proj-gate-c2")).toBe(true);
    assignTask(task.task_ref, "dev-gate-c2");
    expect(hasReadyUnassignedWork("proj-gate-c2")).toBe(false);
  });

  it("regression: an unassigned todo task does NOT re-trigger the gate when every developer/tester is already busy", async () => {
    // This is the exact scenario that racked up 17 cycles / ~9M
    // cache-read tokens on a single idle master session in production:
    // one unassigned task sitting around while every developer already
    // has active work — the master correctly has nothing to do, but the
    // old gate fired every single long-poll reconnect regardless.
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, updateTaskStatus, assignTask } = await import("../../teamhub/tasks.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { hasReadyUnassignedWork, hasPendingWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-c3", "Gate Project C3", "PGC3");
    registerMember("dev-gate-c3", "proj-gate-c3", "developer");
    const busy = createTask("proj-gate-c3", "Already assigned, in progress");
    assignTask(busy.task_ref, "dev-gate-c3");
    updateTaskStatus(busy.task_ref, "in_progress");
    const ready = createTask("proj-gate-c3", "Nobody free to take this yet");
    updateTaskStatus(ready.task_ref, "todo");
    expect(hasReadyUnassignedWork("proj-gate-c3")).toBe(false);
    expect(hasPendingWork("master", "master-gate-c3", "proj-gate-c3")).toBe(false);
  });

  it("hasPendingWork ignores unassigned backlog for developer/tester roles", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    const { hasPendingWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-d", "Gate Project D", "PGD");
    createTask("proj-gate-d", "Unassigned task");
    expect(hasPendingWork("developer", "dev-gate-d", "proj-gate-d")).toBe(false);
    // No developer/tester registered on this project at all, so even
    // though the task itself is unassigned, there's no one it could be
    // assigned to — master correctly has nothing to do either.
    expect(hasPendingWork("master", "master-gate-d", "proj-gate-d")).toBe(false);
  });

  it("hasPendingWork is true for any role once a message is unread", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasPendingWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-e", "Gate Project E", "PGE");
    sendMessage("proj-gate-e", "master-1", "tester-gate-e", "please test PROJ-3");
    expect(hasPendingWork("tester", "tester-gate-e", "proj-gate-e")).toBe(true);
  });
});

describe("hasOwnActiveWork", () => {
  it("is true once a task is assigned to the handle and not yet done/blocked", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, assignTask, updateTaskStatus } = await import("../../teamhub/tasks.js");
    const { hasOwnActiveWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-f", "Gate Project F", "PGF");
    expect(hasOwnActiveWork("dev-gate-f")).toBe(false);
    const task = createTask("proj-gate-f", "Assigned task");
    assignTask(task.task_ref, "dev-gate-f");
    expect(hasOwnActiveWork("dev-gate-f")).toBe(true);
    updateTaskStatus(task.task_ref, "done");
    expect(hasOwnActiveWork("dev-gate-f")).toBe(false);
  });

  it("is false while the task is blocked — waiting on someone else, not on the developer", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, assignTask, updateTaskStatus } = await import("../../teamhub/tasks.js");
    const { hasOwnActiveWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-g", "Gate Project G", "PGG");
    const task = createTask("proj-gate-g", "Blocked task");
    assignTask(task.task_ref, "dev-gate-g");
    updateTaskStatus(task.task_ref, "blocked");
    expect(hasOwnActiveWork("dev-gate-g")).toBe(false);
  });
});

describe("hasPendingWork considers a developer's own in-progress task, not just messages", () => {
  it("is true for a developer with an assigned in-progress task even with an empty inbox", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, assignTask, updateTaskStatus } = await import("../../teamhub/tasks.js");
    const { hasPendingWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-h", "Gate Project H", "PGH");
    const task = createTask("proj-gate-h", "In progress task");
    assignTask(task.task_ref, "dev-gate-h");
    updateTaskStatus(task.task_ref, "in_progress");
    // No message was ever sent to dev-gate-h — only the assigned task
    // makes this true. Before the fix, this returned false forever once
    // the assignment message itself had been read.
    expect(hasPendingWork("developer", "dev-gate-h", "proj-gate-h")).toBe(true);
  });
});

describe("a blocked, idle handle isn't woken by ack-only chatter", () => {
  it("hasUnreadMessages is false for a blocked-and-idle handle when the only unread message is a plain 'message'", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberStatus } = await import("../../teamhub/members.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-i", "Gate Project I", "PGI");
    registerMember("dev-gate-i", "proj-gate-i", "developer");
    setMemberStatus("dev-gate-i", "blocked");
    // This is the exact production scenario: an ack-only reply arrives
    // while the recipient is blocked and has nothing to work — it must
    // not be enough to spawn a new paid cycle on its own.
    sendMessage("proj-gate-i", "master-1", "dev-gate-i", "Confirmed, thanks.");
    expect(hasUnreadMessages("dev-gate-i")).toBe(false);
  });

  it("hasUnreadMessages is still true for a blocked-and-idle handle when a real task_assignment arrives", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberStatus } = await import("../../teamhub/members.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    const { notifyAssignment } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-j", "Gate Project J", "PGJ");
    registerMember("dev-gate-j", "proj-gate-j", "developer");
    setMemberStatus("dev-gate-j", "blocked");
    const task = createTask("proj-gate-j", "New work while previously blocked");
    notifyAssignment("proj-gate-j", "master-1", "dev-gate-j", task.task_ref, "pick this up");
    expect(hasUnreadMessages("dev-gate-j")).toBe(true);
  });

  it("hasUnreadMessages is still true for a blocked-and-idle handle when an interrupt arrives", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberStatus } = await import("../../teamhub/members.js");
    const { db } = await import("../../teamhub/db.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-k", "Gate Project K", "PGK");
    registerMember("dev-gate-k", "proj-gate-k", "developer");
    setMemberStatus("dev-gate-k", "blocked");
    db.prepare(
      `INSERT INTO messages (id, project_id, from_handle, to_handle, text, type, ts, read)
       VALUES ('m-interrupt-1', 'proj-gate-k', 'master-1', 'dev-gate-k', 'redirect', 'interrupt', datetime('now'), 0)`
    ).run();
    expect(hasUnreadMessages("dev-gate-k")).toBe(true);
  });

  it("a blocked handle WITH an active task still wakes for ordinary messages (the gate only relaxes when idle too)", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberStatus } = await import("../../teamhub/members.js");
    const { createTask, assignTask, updateTaskStatus } = await import("../../teamhub/tasks.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-l", "Gate Project L", "PGL");
    registerMember("dev-gate-l", "proj-gate-l", "developer");
    setMemberStatus("dev-gate-l", "blocked");
    const task = createTask("proj-gate-l", "Still has an active task");
    assignTask(task.task_ref, "dev-gate-l");
    updateTaskStatus(task.task_ref, "in_progress");
    sendMessage("proj-gate-l", "master-1", "dev-gate-l", "any note");
    expect(hasUnreadMessages("dev-gate-l")).toBe(true);
  });

  it("a non-blocked handle wakes for ordinary messages as before (no behavior change for the common case)", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    const { hasUnreadMessages } = await import("../../teamhub/gate.js");
    createProject("proj-gate-m", "Gate Project M", "PGM");
    registerMember("dev-gate-m", "proj-gate-m", "developer");
    sendMessage("proj-gate-m", "master-1", "dev-gate-m", "any note");
    expect(hasUnreadMessages("dev-gate-m")).toBe(true);
  });
});
