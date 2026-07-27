import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("messaging module", () => {
  it("notifyAssignment lands in the recipient's inbox as task_assignment", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { notifyAssignment, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-a", "Messaging Project A", "PMSA");
    notifyAssignment("proj-msg-a", "master-1", "dev-A", "PROJ-1", "Fix the bug");
    const inbox = checkInbox("dev-A");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("task_assignment");
    expect(inbox[0].task_ref).toBe("PROJ-1");
  });

  it("checkInbox only returns unread messages, and marks them read", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-b", "Messaging Project B", "PMSB");
    sendMessage("proj-msg-b", "master-1", "dev-B", "hello");
    const first = checkInbox("dev-B");
    expect(first).toHaveLength(1);
    const second = checkInbox("dev-B");
    expect(second).toHaveLength(0);
  });

  it("reportStatus routes to the project's registered master", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { reportStatus, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-c", "Messaging Project C", "PMSC");
    registerMember("master-2", "proj-msg-c", "master");
    reportStatus("proj-msg-c", "dev-C", "PROJ-2", "blocked", "waiting on API keys");
    const inbox = checkInbox("master-2");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("status_update");
    expect(inbox[0].text).toBe("[blocked] waiting on API keys");
  });
});
