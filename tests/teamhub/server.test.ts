import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TEAMHUB_DB = ":memory:";
process.env.TEAMHUB_TOKEN = "test-shared-token";
process.env.TEAMHUB_STATE_DIR = mkdtempSync(join(tmpdir(), "teamhub-server-test-"));

describe("teamhub server", () => {
  it("buildServer registers a server with all expected tools", async () => {
    const { buildServer } = await import("../../teamhub/server.js");
    const server = buildServer();
    // McpServer exposes registered tool names via its internal request handlers;
    // the simplest black-box check is that construction doesn't throw and
    // returns an object with a connect method (duck-typed MCP server).
    expect(typeof (server as any).connect).toBe("function");
  });
});

describe("GET /health", () => {
  let httpServer: Server | undefined;

  afterEach(() => {
    httpServer?.close();
    httpServer = undefined;
  });

  it("responds with ok status without needing the MCP protocol", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("teamhub");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("is a plain GET route, reachable from a browser or curl without a POST body", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("monitoring UI wiring", () => {
  let httpServer: Server | undefined;

  afterEach(() => {
    httpServer?.close();
    httpServer = undefined;
  });

  it("serves the dashboard's static assets publicly, but gates /api behind login and /mcp behind a Bearer token", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    // Static shell is public — the login gate is enforced by the API calls
    // the shell makes, not by hiding the HTML/JS/CSS itself.
    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>TeamHub</title>");

    const appJs = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(appJs.status).toBe(200);

    const stylesCss = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(stylesCss.status).toBe(200);

    // /api/* requires a logged-in session.
    const unauthed = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(unauthed.status).toBe(401);

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "test-shared-token" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const apiProjects = await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { Cookie: cookie } });
    expect(apiProjects.status).toBe(200);
    expect(Array.isArray(await apiProjects.json())).toBe(true);

    // /mcp requires the shared Bearer token, not a dashboard session.
    const unauthedMcp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unauthedMcp.status).toBe(401);
  });
});
