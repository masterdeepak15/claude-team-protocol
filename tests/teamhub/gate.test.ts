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

  it("hasReadyUnassignedWork is false when backlog is empty or fully assigned", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, assignTask } = await import("../../teamhub/tasks.js");
    const { hasReadyUnassignedWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-c", "Gate Project C", "PGC");
    expect(hasReadyUnassignedWork("proj-gate-c")).toBe(false);
    const task = createTask("proj-gate-c", "Fix the bug");
    expect(hasReadyUnassignedWork("proj-gate-c")).toBe(true);
    assignTask(task.task_ref, "dev-gate-c");
    expect(hasReadyUnassignedWork("proj-gate-c")).toBe(false);
  });

  it("hasPendingWork ignores unassigned backlog for developer/tester roles", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    const { hasPendingWork } = await import("../../teamhub/gate.js");
    createProject("proj-gate-d", "Gate Project D", "PGD");
    createTask("proj-gate-d", "Unassigned task");
    expect(hasPendingWork("developer", "dev-gate-d", "proj-gate-d")).toBe(false);
    expect(hasPendingWork("master", "master-gate-d", "proj-gate-d")).toBe(true);
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
