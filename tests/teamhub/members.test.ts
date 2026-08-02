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

  it("defaults mode to 'manual' when not specified", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-f", "Members Project F", "PMF");
    registerMember("dev-z4", "proj-members-f", "developer");
    expect(getMember("dev-z4")?.mode).toBe("manual");
  });

  it("registerMember accepts an explicit mode", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-g", "Members Project G", "PMG");
    registerMember("dev-z5", "proj-members-g", "developer", "auto");
    expect(getMember("dev-z5")?.mode).toBe("auto");
  });

  it("setMemberMode changes mode in between, without touching other fields", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, setMemberMode, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-h", "Members Project H", "PMH");
    registerMember("dev-z6", "proj-members-h", "developer", "manual");
    setMemberMode("dev-z6", "auto");
    const member = getMember("dev-z6");
    expect(member?.mode).toBe("auto");
    expect(member?.project_id).toBe("proj-members-h");
    expect(member?.role).toBe("developer");
  });

  it("re-registering without a mode preserves the previously set mode", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-i", "Members Project I", "PMI");
    registerMember("dev-z7", "proj-members-i", "developer", "auto");
    registerMember("dev-z7", "proj-members-i", "developer");
    expect(getMember("dev-z7")?.mode).toBe("auto");
  });

  it("registers a tester role", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    createProject("proj-members-j", "Members Project J", "PMJ");
    const member = registerMember("tester-1", "proj-members-j", "tester");
    expect(member.role).toBe("tester");
    expect(getMember("tester-1")?.role).toBe("tester");
  });
});

describe("reserved owner handle", () => {
  it("rejects registering the reserved OWNER_HANDLE, case-insensitively", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember } = await import("../../teamhub/members.js");
    createProject("proj-members-owner", "Members Project Owner", "PMO");
    expect(() => registerMember("owner", "proj-members-owner", "developer")).toThrow();
    expect(() => registerMember("Owner", "proj-members-owner", "developer")).toThrow();
    expect(() => registerMember("OWNER", "proj-members-owner", "master")).toThrow();
  });
});

describe("presence (online/offline)", () => {
  it("listTeam reports online: true for a just-registered/touched member, false once stale", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember, touchMember, listTeam } = await import("../../teamhub/members.js");
    createProject("proj-members-presence", "Members Presence Project", "PMP");
    registerMember("dev-presence-a", "proj-members-presence", "developer");

    const fresh = listTeam("proj-members-presence").find((m) => m.handle === "dev-presence-a");
    expect(fresh?.online).toBe(true);

    // Simulate a stale last_seen well past the online threshold, the same
    // way a killed/crashed runner that stopped checking in would look.
    const { db } = await import("../../teamhub/db.js");
    const staleTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare(`UPDATE members SET last_seen = ? WHERE handle = ?`).run(staleTs, "dev-presence-a");

    const stale = listTeam("proj-members-presence").find((m) => m.handle === "dev-presence-a");
    expect(stale?.online).toBe(false);

    touchMember("dev-presence-a");
    const touched = listTeam("proj-members-presence").find((m) => m.handle === "dev-presence-a");
    expect(touched?.online).toBe(true);
  });
});
