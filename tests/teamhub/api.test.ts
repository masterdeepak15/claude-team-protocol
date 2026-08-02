import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TEAMHUB_DB = ":memory:";
process.env.TEAMHUB_TOKEN = "test-shared-token";
process.env.TEAMHUB_STATE_DIR = mkdtempSync(join(tmpdir(), "teamhub-api-test-"));

async function startTestServer(): Promise<{ port: number; server: Server }> {
  const { buildApiRouter } = await import("../../teamhub/api.js");
  const app = express();
  app.use(express.json());
  app.use("/api", buildApiRouter());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  return { port, server };
}

// Logs in with the known test token and returns the Cookie header value to
// attach to subsequent requests, since every dashboard-facing route now
// requires a valid session.
async function loginCookie(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "test-shared-token" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0];
}

describe("teamhub API router", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  describe("auth", () => {
    it("rejects dashboard routes with no session", async () => {
      const started = await startTestServer();
      server = started.server;
      const res = await fetch(`http://127.0.0.1:${started.port}/api/projects`);
      expect(res.status).toBe(401);
    });

    it("rejects login with the wrong token", async () => {
      const started = await startTestServer();
      server = started.server;
      const res = await fetch(`http://127.0.0.1:${started.port}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      });
      expect(res.status).toBe(401);
    });

    it("accepts the correct token and grants access to dashboard routes afterward", async () => {
      const started = await startTestServer();
      server = started.server;
      const cookie = await loginCookie(started.port);
      const res = await fetch(`http://127.0.0.1:${started.port}/api/projects`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
    });

    it("GET /api/session reflects logged-in state", async () => {
      const started = await startTestServer();
      server = started.server;
      const before = await (await fetch(`http://127.0.0.1:${started.port}/api/session`)).json();
      expect(before.loggedIn).toBe(false);
      const cookie = await loginCookie(started.port);
      const after = await (
        await fetch(`http://127.0.0.1:${started.port}/api/session`, { headers: { Cookie: cookie } })
      ).json();
      expect(after.loggedIn).toBe(true);
    });

    it("logout clears the session", async () => {
      const started = await startTestServer();
      server = started.server;
      const cookie = await loginCookie(started.port);
      await fetch(`http://127.0.0.1:${started.port}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
      const res = await fetch(`http://127.0.0.1:${started.port}/api/projects`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(401);
    });
  });

  it("GET /api/projects lists created projects", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    createProject("proj-api-a", "API Project A", "APA");
    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);

    const res = await fetch(`http://127.0.0.1:${started.port}/api/projects`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((p: any) => p.id === "proj-api-a")).toBe(true);
  });

  it("GET /api/projects/:id returns 404 for an unknown project", async () => {
    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);
    const res = await fetch(`http://127.0.0.1:${started.port}/api/projects/does-not-exist`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/projects/:id/members, /sprints, /tasks scope to that project", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { createSprint } = await import("../../teamhub/sprints.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-api-b", "API Project B", "APB");
    registerMember("dev-api-b", "proj-api-b", "developer");
    createSprint("proj-api-b", "Sprint 1");
    createTask("proj-api-b", "Some task");

    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);
    const opts = { headers: { Cookie: cookie } };

    const members = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/members`, opts)
    ).json();
    expect(members).toHaveLength(1);
    expect(members[0].handle).toBe("dev-api-b");

    const sprintsRes = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/sprints`, opts)
    ).json();
    expect(sprintsRes).toHaveLength(1);

    const tasksRes = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/tasks`, opts)
    ).json();
    expect(tasksRes).toHaveLength(1);
    expect(tasksRes[0].task_ref).toBe("APB-1");
  });

  it("GET /api/tasks/:taskRef includes comments, and 404s for an unknown ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, addComment } = await import("../../teamhub/tasks.js");
    createProject("proj-api-c", "API Project C", "APC");
    const task = createTask("proj-api-c", "Commented task");
    addComment(task.task_ref, "dev-api-c", "a note");

    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);
    const opts = { headers: { Cookie: cookie } };

    const res = await fetch(`http://127.0.0.1:${started.port}/api/tasks/${task.task_ref}`, opts);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toBe("a note");

    const missing = await fetch(`http://127.0.0.1:${started.port}/api/tasks/NOPE-1`, opts);
    expect(missing.status).toBe(404);
  });

  it("GET /api/projects/:id/messages returns the full history, optionally filtered by handle", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    createProject("proj-api-d", "API Project D", "APD");
    sendMessage("proj-api-d", "master-1", "dev-api-d", "hi dev-api-d");
    sendMessage("proj-api-d", "master-1", "dev-api-e", "hi dev-api-e");

    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);
    const opts = { headers: { Cookie: cookie } };

    const all = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-d/messages`, opts)
    ).json();
    expect(all).toHaveLength(2);

    const filtered = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-d/messages?handle=dev-api-d`, opts)
    ).json();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].to_handle).toBe("dev-api-d");
  });

  it("POST /api/messages sends a message and 400s when a field is missing", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    createProject("proj-api-e", "API Project E", "APE");
    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);
    const headers = { "Content-Type": "application/json", Cookie: cookie };

    const res = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        project_id: "proj-api-e",
        from_handle: "master-1",
        to_handle: "dev-api-f",
        text: "hello from the UI",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.text).toBe("hello from the UI");

    const badRes = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: "proj-api-e", from_handle: "master-1" }),
    });
    expect(badRes.status).toBe(400);

    const selfRes = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        project_id: "proj-api-e",
        from_handle: "master-1",
        to_handle: "master-1",
        text: "talking to myself",
      }),
    });
    expect(selfRes.status).toBe(400);
  });

  it("GET /api/events streams a change as an SSE data line", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    createProject("proj-api-f", "API Project F", "APF");

    const started = await startTestServer();
    server = started.server;
    const cookie = await loginCookie(started.port);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${started.port}/api/events?project_id=proj-api-f`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Trigger a change after the stream is open.
    setTimeout(() => sendMessage("proj-api-f", "master-1", "dev-api-g", "trigger"), 50);

    let received = "";
    const deadline = Date.now() + 3000;
    while (!received.includes('"kind":"message"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(received).toContain('"kind":"message"');
    expect(received).toContain("proj-api-f");
  });

  describe("GET /api/wait-for-work", () => {
    it("requires a Bearer token, not a dashboard session", async () => {
      const started = await startTestServer();
      server = started.server;
      const res = await fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=developer&handle=dev-wait&project_id=proj-wait-a`
      );
      expect(res.status).toBe(401);
    });

    it("returns immediately when already pending", async () => {
      const { createProject } = await import("../../teamhub/projects.js");
      const { sendMessage } = await import("../../teamhub/messaging.js");
      createProject("proj-wait-b", "Wait Project B", "PWB");
      sendMessage("proj-wait-b", "master-1", "dev-wait-b", "hello");

      const started = await startTestServer();
      server = started.server;
      const res = await fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=developer&handle=dev-wait-b&project_id=proj-wait-b`,
        { headers: { Authorization: "Bearer test-shared-token" } }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pending: true });
    });

    it("touches presence (last_seen) on every check-in, including the fast path", async () => {
      const { createProject } = await import("../../teamhub/projects.js");
      const { registerMember, listTeam } = await import("../../teamhub/members.js");
      const { db } = await import("../../teamhub/db.js");
      createProject("proj-wait-presence", "Wait Presence Project", "PWP");
      registerMember("dev-wait-presence", "proj-wait-presence", "developer");
      const staleTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      db.prepare(`UPDATE members SET last_seen = ? WHERE handle = ?`).run(staleTs, "dev-wait-presence");
      expect(listTeam("proj-wait-presence").find((m) => m.handle === "dev-wait-presence")?.online).toBe(false);

      const started = await startTestServer();
      server = started.server;
      await fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=developer&handle=dev-wait-presence&project_id=proj-wait-presence&timeoutMs=1000`,
        { headers: { Authorization: "Bearer test-shared-token" } }
      );

      expect(listTeam("proj-wait-presence").find((m) => m.handle === "dev-wait-presence")?.online).toBe(true);
    });

    it("wakes up as soon as a relevant message arrives, well under the timeout", async () => {
      const { createProject } = await import("../../teamhub/projects.js");
      const { sendMessage } = await import("../../teamhub/messaging.js");
      createProject("proj-wait-c", "Wait Project C", "PWC");

      const started = await startTestServer();
      server = started.server;

      const waitPromise = fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=developer&handle=dev-wait-c&project_id=proj-wait-c&timeoutMs=5000`,
        { headers: { Authorization: "Bearer test-shared-token" } }
      );

      setTimeout(() => sendMessage("proj-wait-c", "master-1", "dev-wait-c", "new work"), 100);

      const started_at = Date.now();
      const res = await waitPromise;
      const elapsed = Date.now() - started_at;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pending: true });
      expect(elapsed).toBeLessThan(4000); // woke on the event, not the 5s timeout
    });

    it("times out with pending: false when nothing ever arrives", async () => {
      const { createProject } = await import("../../teamhub/projects.js");
      createProject("proj-wait-d", "Wait Project D", "PWD");
      const started = await startTestServer();
      server = started.server;

      const res = await fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=developer&handle=dev-wait-d&project_id=proj-wait-d&timeoutMs=1000`,
        { headers: { Authorization: "Bearer test-shared-token" } }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pending: false });
    });

    it("400s on a missing param or invalid role", async () => {
      const started = await startTestServer();
      server = started.server;
      const auth = { headers: { Authorization: "Bearer test-shared-token" } };
      const missing = await fetch(`http://127.0.0.1:${started.port}/api/wait-for-work?role=developer`, auth);
      expect(missing.status).toBe(400);
      const badRole = await fetch(
        `http://127.0.0.1:${started.port}/api/wait-for-work?role=bogus&handle=h&project_id=p`,
        auth
      );
      expect(badRole.status).toBe(400);
    });
  });
});
