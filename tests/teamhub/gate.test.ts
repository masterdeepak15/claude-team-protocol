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
