import { describe, it, expect, beforeEach } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("projects module", () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory DB by re-requiring is not trivial in ESM,
    // so tests exercise the module's own exported functions directly against
    // the shared singleton and use unique ids per test to avoid collisions.
  });

  it("creates and retrieves a project", async () => {
    const { createProject, getProject } = await import("../../teamhub/projects.js");
    const project = createProject("proj-a", "Project A", "PROJA");
    expect(project.id).toBe("proj-a");
    expect(project.key_prefix).toBe("PROJA");
    expect(getProject("proj-a")).toEqual(project);
  });

  it("lists all created projects", async () => {
    const { createProject, listProjects } = await import("../../teamhub/projects.js");
    createProject("proj-b", "Project B", "PROJB");
    const all = listProjects();
    expect(all.some((p) => p.id === "proj-b")).toBe(true);
  });

  it("returns undefined for an unknown project", async () => {
    const { getProject } = await import("../../teamhub/projects.js");
    expect(getProject("does-not-exist")).toBeUndefined();
  });
});
