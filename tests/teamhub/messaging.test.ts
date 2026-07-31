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

  it("interruptDeveloper creates an interrupt-type message", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { interruptDeveloper, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-d", "Messaging Project D", "PMSD");
    interruptDeveloper("proj-msg-d", "master-1", "dev-D", "Stop — requirements changed, switch to OAuth instead of API keys");
    const inbox = checkInbox("dev-D");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("interrupt");
    expect(inbox[0].text).toContain("OAuth");
  });

  it("peekInterrupt returns and consumes only the interrupt message, leaving other messages unread", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { interruptDeveloper, sendMessage, peekInterrupt, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-e", "Messaging Project E", "PMSE");
    sendMessage("proj-msg-e", "master-1", "dev-E", "unrelated normal message");
    interruptDeveloper("proj-msg-e", "master-1", "dev-E", "stop now");

    const interrupt = peekInterrupt("dev-E");
    expect(interrupt?.type).toBe("interrupt");
    expect(interrupt?.text).toBe("stop now");

    // Calling peekInterrupt again finds nothing new.
    expect(peekInterrupt("dev-E")).toBeUndefined();

    // The normal message is still unread and shows up via check_inbox.
    const inbox = checkInbox("dev-E");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("message");
  });

  it("peekInterrupt returns undefined when there's no interrupt for that handle", async () => {
    const { peekInterrupt } = await import("../../teamhub/messaging.js");
    expect(peekInterrupt("dev-nobody")).toBeUndefined();
  });

  it("listMessages returns the full project history without marking anything read (for the UI)", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage, notifyAssignment, listMessages, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-f", "Messaging Project F", "PMSF");
    sendMessage("proj-msg-f", "master-1", "dev-F", "hello dev-F");
    notifyAssignment("proj-msg-f", "master-1", "dev-G", "PMSF-1", "do the thing");

    const all = listMessages("proj-msg-f");
    expect(all).toHaveLength(2);

    // Unaffected by listMessages having been called — still unread via checkInbox.
    const inbox = checkInbox("dev-F");
    expect(inbox).toHaveLength(1);
  });

  it("listMessages filters to only messages to/from a given handle", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage, listMessages } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-g", "Messaging Project G", "PMSG");
    sendMessage("proj-msg-g", "master-1", "dev-H", "to dev-H");
    sendMessage("proj-msg-g", "master-1", "dev-I", "to dev-I");
    sendMessage("proj-msg-g", "dev-H", "master-1", "reply from dev-H");

    const forDevH = listMessages("proj-msg-g", "dev-H");
    expect(forDevH).toHaveLength(2);
    expect(forDevH.every((m) => m.from_handle === "dev-H" || m.to_handle === "dev-H")).toBe(true);
  });
});

describe("self-message guard", () => {
  it("rejects sendMessage when from_handle equals to_handle", async () => {
    const { sendMessage } = await import("../../teamhub/messaging.js");
    expect(() => sendMessage("proj-msg-self", "master-1", "master-1", "talking to myself")).toThrow();
  });
});

describe("checkInbox atomicity", () => {
  it("only returns and consumes messages that existed at call time, in chronological order", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage, checkInbox } = await import("../../teamhub/messaging.js");
    createProject("proj-msg-atomic", "Atomic Project", "PMA");
    sendMessage("proj-msg-atomic", "master-1", "dev-atomic", "first");
    sendMessage("proj-msg-atomic", "master-1", "dev-atomic", "second");
    const inbox = checkInbox("dev-atomic");
    expect(inbox.map((m) => m.text)).toEqual(["first", "second"]);
    expect(inbox.every((m) => m.read)).toBe(true);
    expect(checkInbox("dev-atomic")).toHaveLength(0);
  });
});

describe("reportStatus requires a registered master", () => {
  it("throws instead of silently addressing a nonexistent master handle", async () => {
    const { reportStatus } = await import("../../teamhub/messaging.js");
    expect(() =>
      reportStatus("proj-msg-no-master", "dev-A", "PROJ-1", "done", "finished it")
    ).toThrow(/no master/i);
  });
});
