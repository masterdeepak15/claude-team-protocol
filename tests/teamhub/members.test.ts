import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("members module", () => {
  it("registers a member and retrieves it", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-a", "Members Project A", "PMA");
    const member = registerMember("dev-x", "proj-members-a", "developer");
    expect(member.handle).toBe("dev-x");
    expect(member.role).toBe("developer");
    expect(getMember("dev-x")?.project_id).toBe("proj-members-a");
  });

  it("re-registering the same handle updates its project/role", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-a2", "Members Project A2", "PMA2");
    createProject("proj-members-b", "Members Project B", "PMB");
    registerMember("dev-y", "proj-members-a2", "developer");
    registerMember("dev-y", "proj-members-b", "master");
    const member = getMember("dev-y");
    expect(member?.project_id).toBe("proj-members-b");
    expect(member?.role).toBe("master");
  });

  it("lists only members of the given project", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, listTeam } = await import("../../teamhub/members.js");
    createProject("proj-members-c", "Members Project C", "PMC");
    createProject("proj-members-d", "Members Project D", "PMD");
    registerMember("dev-z1", "proj-members-c", "developer");
    registerMember("dev-z2", "proj-members-d", "developer");
    const team = listTeam("proj-members-c");
    expect(team.map((m) => m.handle)).toContain("dev-z1");
    expect(team.map((m) => m.handle)).not.toContain("dev-z2");
  });

  it("setMemberStatus updates status", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberStatus, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-e", "Members Project E", "PME");
    registerMember("dev-z3", "proj-members-e", "developer");
    setMemberStatus("dev-z3", "blocked");
    expect(getMember("dev-z3")?.status).toBe("blocked");
  });
});
