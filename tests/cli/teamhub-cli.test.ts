import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isProcessAlive,
  tailLines,
  mergeMcpConfig,
  mergeDesktopMcpConfig,
  buildWindowsAutostartArgs,
  buildWindowsAutostartRemoveArgs,
  buildLaunchdPlist,
  buildSystemdUnit,
  parseMeta,
  helpText,
  isNewerVersion,
  warnIfUpdateAvailable,
} from "../../cli/teamhub-cli.js";

describe("isProcessAlive", () => {
  it("returns true for the current process's own pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a pid that almost certainly doesn't exist", () => {
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

describe("tailLines", () => {
  it("returns the last N lines of the content", () => {
    const content = ["a", "b", "c", "d", "e"].join("\n");
    expect(tailLines(content, 2)).toBe("d\ne");
  });

  it("returns the whole content when N exceeds the number of lines", () => {
    const content = ["a", "b"].join("\n");
    expect(tailLines(content, 10)).toBe("a\nb");
  });

  it("handles empty content", () => {
    expect(tailLines("", 5)).toBe("");
  });
});

describe("mergeMcpConfig", () => {
  it("adds a teamhub entry to an empty config, including the auth header", () => {
    const merged = mergeMcpConfig(undefined, "http://192.168.1.20:8787/mcp", "shh-token");
    expect(merged).toEqual({
      mcpServers: {
        teamhub: { type: "http", url: "http://192.168.1.20:8787/mcp", headers: { Authorization: "Bearer shh-token" } },
      },
    });
  });

  it("preserves existing mcpServers entries", () => {
    const existing = { mcpServers: { github: { type: "http", url: "http://example.com/mcp" } } };
    const merged = mergeMcpConfig(existing, "http://192.168.1.20:8787/mcp", "shh-token");
    expect(merged.mcpServers.github).toEqual({ type: "http", url: "http://example.com/mcp" });
    expect(merged.mcpServers.teamhub.url).toBe("http://192.168.1.20:8787/mcp");
    expect(merged.mcpServers.teamhub.headers.Authorization).toBe("Bearer shh-token");
  });

  it("overwrites a pre-existing teamhub entry", () => {
    const existing = { mcpServers: { teamhub: { type: "http", url: "http://old-host:8787/mcp" } } };
    const merged = mergeMcpConfig(existing, "http://new-host:8787/mcp", "shh-token");
    expect(merged.mcpServers.teamhub.url).toBe("http://new-host:8787/mcp");
  });
});

describe("mergeDesktopMcpConfig", () => {
  it("adds a command-based teamhub entry using mcp-remote with the auth header", () => {
    const merged = mergeDesktopMcpConfig(undefined, "http://192.168.1.20:8787/mcp", "shh-token");
    expect(merged.mcpServers.teamhub).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "http://192.168.1.20:8787/mcp", "--header", "Authorization: Bearer shh-token"],
    });
  });

  it("preserves other existing entries", () => {
    const existing = { mcpServers: { other: { command: "node", args: ["x.js"] } } };
    const merged = mergeDesktopMcpConfig(existing, "http://192.168.1.20:8787/mcp", "shh-token");
    expect(merged.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
  });
});

describe("buildWindowsAutostartArgs", () => {
  it("builds a schtasks /Create command referencing node and the server path", () => {
    const args = buildWindowsAutostartArgs("C:\\node.exe", "C:\\pkg\\dist\\teamhub\\server.js");
    expect(args).toContain("/Create");
    expect(args).toContain("/SC");
    expect(args).toContain("ONLOGON");
    const trArg = args[args.indexOf("/TR") + 1];
    expect(trArg).toContain("node.exe");
    expect(trArg).toContain("server.js");
  });
});

describe("buildWindowsAutostartRemoveArgs", () => {
  it("builds a schtasks /Delete command for the same task name", () => {
    const createArgs = buildWindowsAutostartArgs("C:\\node.exe", "C:\\srv.js");
    const taskName = createArgs[createArgs.indexOf("/TN") + 1];
    const removeArgs = buildWindowsAutostartRemoveArgs();
    expect(removeArgs).toContain("/Delete");
    expect(removeArgs).toContain(taskName);
  });
});

describe("buildLaunchdPlist", () => {
  it("embeds the node path, server path, log path, and RunAtLoad", () => {
    const plist = buildLaunchdPlist("/usr/local/bin/node", "/pkg/dist/teamhub/server.js", "/home/x/.teamhub/teamhub.log", 8787, undefined);
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain("/pkg/dist/teamhub/server.js");
    expect(plist).toContain("/home/x/.teamhub/teamhub.log");
    expect(plist).toContain("RunAtLoad");
  });

  it("includes a TEAMHUB_DB environment entry when dbPath is given", () => {
    const plist = buildLaunchdPlist("/node", "/srv.js", "/log", 8787, "/home/x/.teamhub/teamhub.db.sqlite");
    expect(plist).toContain("TEAMHUB_DB");
    expect(plist).toContain("/home/x/.teamhub/teamhub.db.sqlite");
  });
});

describe("buildSystemdUnit", () => {
  it("embeds an ExecStart line with node and the server path", () => {
    const unit = buildSystemdUnit("/usr/bin/node", "/pkg/dist/teamhub/server.js", 8787, undefined);
    expect(unit).toContain("ExecStart=/usr/bin/node /pkg/dist/teamhub/server.js");
    expect(unit).toContain("Environment=TEAMHUB_PORT=8787");
  });

  it("includes a TEAMHUB_DB environment line when dbPath is given", () => {
    const unit = buildSystemdUnit("/usr/bin/node", "/srv.js", 8787, "/home/x/.teamhub/teamhub.db.sqlite");
    expect(unit).toContain("Environment=TEAMHUB_DB=/home/x/.teamhub/teamhub.db.sqlite");
  });
});

describe("parseMeta", () => {
  it("defaults to port 8787 with no dbPath when there's no prior state", () => {
    expect(parseMeta(undefined)).toEqual({ port: 8787 });
  });

  it("parses a previously recorded port and dbPath", () => {
    const raw = JSON.stringify({ port: 9000, dbPath: "/home/x/.teamhub/teamhub.db.sqlite" });
    expect(parseMeta(raw)).toEqual({ port: 9000, dbPath: "/home/x/.teamhub/teamhub.db.sqlite" });
  });

  it("falls back to the default port when dbPath was never set", () => {
    const raw = JSON.stringify({ port: 9000 });
    expect(parseMeta(raw)).toEqual({ port: 9000, dbPath: undefined });
  });

  it("falls back to defaults on corrupt/invalid JSON rather than throwing", () => {
    expect(parseMeta("{not valid json")).toEqual({ port: 8787 });
  });
});

describe("helpText", () => {
  it("mentions every command", () => {
    const text = helpText();
    for (const cmd of ["install", "start", "stop", "status", "logs", "agent", "token", "upgrade", "uninstall", "help"]) {
      expect(text).toContain(cmd);
    }
  });
});

describe("isNewerVersion", () => {
  it("is true when the latest version is strictly greater", () => {
    expect(isNewerVersion("2.1.5", "2.1.6")).toBe(true);
    expect(isNewerVersion("2.1.9", "2.2.0")).toBe(true);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(true);
  });

  it("is false when equal or the 'latest' is actually older/same (never warn to downgrade)", () => {
    expect(isNewerVersion("2.1.6", "2.1.6")).toBe(false);
    expect(isNewerVersion("2.1.6", "2.1.5")).toBe(false);
    expect(isNewerVersion("2.2.0", "2.1.9")).toBe(false);
  });

  it("handles differing segment counts without throwing", () => {
    expect(isNewerVersion("2.1", "2.1.1")).toBe(true);
    expect(isNewerVersion("2.1.0", "2.1")).toBe(false);
  });
});

describe("warnIfUpdateAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints a warning with both versions and the update command when a newer version exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "99.0.0" }) })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await warnIfUpdateAvailable("@masterdeepak15/teamhub-cli");
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/newer version/i);
    expect(output).toContain("99.0.0");
    expect(output).toMatch(/teamhub upgrade/);
    logSpy.mockRestore();
  });

  it("prints nothing when already on the latest version", async () => {
    // Simulate "already up to date" by having the registry report the
    // exact same version this test process is running as installed.
    const { installedVersion } = await import("../../cli/teamhub-cli.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: installedVersion() }) })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await warnIfUpdateAvailable("@masterdeepak15/teamhub-cli");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("fails silently — prints nothing and never throws — when the registry is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(warnIfUpdateAvailable("@masterdeepak15/teamhub-cli")).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("fails silently on a non-ok HTTP response too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await warnIfUpdateAvailable("@masterdeepak15/teamhub-cli");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
