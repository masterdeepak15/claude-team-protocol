import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("sprints module", () => {
  it("creates a sprint and retrieves it by id", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createSprint, getSprint } = await import("../../teamhub/sprints.js");
    createProject("proj-sprint-a", "Sprint Project A", "PSA");
    const sprint = createSprint("proj-sprint-a", "Sprint 1", "2026-08-01", "2026-08-14");
    expect(sprint.name).toBe("Sprint 1");
    expect(getSprint(sprint.id)?.project_id).toBe("proj-sprint-a");
  });

  it("lists sprints scoped to a project, newest first", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createSprint, listSprints } = await import("../../teamhub/sprints.js");
    createProject("proj-sprint-b", "Sprint Project B", "PSB");
    createProject("proj-sprint-c", "Sprint Project C", "PSC");
    createSprint("proj-sprint-b", "Sprint 1");
    createSprint("proj-sprint-b", "Sprint 2");
    createSprint("proj-sprint-c", "Other project sprint");
    const sprints = listSprints("proj-sprint-b");
    expect(sprints).toHaveLength(2);
    expect(sprints[0].name).toBe("Sprint 2");
  });
});
