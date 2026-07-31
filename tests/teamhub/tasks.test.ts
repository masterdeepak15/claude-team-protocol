import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("tasks module", () => {
  it("creates a task with a project-prefixed task_ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-task-a", "Task Project A", "PTA");
    const task = createTask("proj-task-a", "Fix login bug");
    expect(task.task_ref).toBe("PTA-1");
    expect(task.status).toBe("backlog");
  });

  it("second task in the same project increments the ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-task-b", "Task Project B", "PTB");
    createTask("proj-task-b", "First task");
    const second = createTask("proj-task-b", "Second task");
    expect(second.task_ref).toBe("PTB-2");
  });

  it("updateTaskStatus moves status and optionally sets assignee", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, updateTaskStatus, getTaskByRef } = await import("../../teamhub/tasks.js");
    createProject("proj-task-c", "Task Project C", "PTC");
    const task = createTask("proj-task-c", "Some task");
    updateTaskStatus(task.task_ref, "in_progress", "dev-A");
    const updated = getTaskByRef(task.task_ref);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.assignee_handle).toBe("dev-A");
  });

  it("addComment and listComments round-trip", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, addComment, listComments } = await import("../../teamhub/tasks.js");
    createProject("proj-task-d", "Task Project D", "PTD");
    const task = createTask("proj-task-d", "Commented task");
    addComment(task.task_ref, "dev-A", "Started working on this");
    const comments = listComments(task.task_ref);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("Started working on this");
  });
});

describe("task_ref uniqueness under rapid creation", () => {
  it("never produces a duplicate task_ref, even across many rapid creates", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-task-race", "Task Race Project", "PTR");
    const refs = Array.from({ length: 25 }, () => createTask("proj-task-race", "Task").task_ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs[0]).toBe("PTR-1");
    expect(refs[24]).toBe("PTR-25");
  });
});
