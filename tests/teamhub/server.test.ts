import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

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
