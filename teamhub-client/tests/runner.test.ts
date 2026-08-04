import { describe, it, expect, vi } from "vitest";
import {
  parseArgs,
  claudeCommand,
  kickoffPrompt,
  cyclePrompt,
  permissionModeFor,
  redirectPrompt,
  runInterruptibleCycle,
  logStreamEvent,
  usageLimitBackoffMs,
  parseResetDelayMs,
  exitErrorMessage,
} from "../src/runner.js";

describe("parseArgs", () => {
  it("parses master args with defaults", () => {
    const args = parseArgs(["--role", "master", "--project", "proj-x", "--handle", "master-1"]);
    expect(args).toEqual({
      role: "master",
      project: "proj-x",
      handle: "master-1",
      masterHandle: undefined,
      cycle: 60,
      mode: "manual",
      watchdogInterval: 5,
    });
  });

  it("parses developer args with an explicit cycle", () => {
    const args = parseArgs([
      "--role", "developer",
      "--project", "proj-x",
      "--handle", "dev-A",
      "--master-handle", "master-1",
      "--cycle", "45",
    ]);
    expect(args).toEqual({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 45,
      mode: "manual",
      watchdogInterval: 5,
    });
  });

  it("parses tester args", () => {
    const args = parseArgs(["--role", "tester", "--project", "proj-x", "--handle", "tester-1", "--master-handle", "master-1"]);
    expect(args.role).toBe("tester");
  });

  it("parses an explicit --mode and --watchdog-interval", () => {
    const args = parseArgs([
      "--role", "developer",
      "--project", "proj-x",
      "--handle", "dev-A",
      "--master-handle", "master-1",
      "--mode", "auto",
      "--watchdog-interval", "10",
    ]);
    expect(args.mode).toBe("auto");
    expect(args.watchdogInterval).toBe(10);
  });

  it("throws when --mode is invalid", () => {
    expect(() =>
      parseArgs(["--role", "developer", "--project", "p", "--handle", "h", "--mode", "bogus"])
    ).toThrow(/--mode/);
  });

  it("throws when --role is missing or invalid", () => {
    expect(() => parseArgs(["--project", "proj-x", "--handle", "h"])).toThrow(/--role/);
    expect(() => parseArgs(["--role", "bogus", "--project", "p", "--handle", "h"])).toThrow(/--role/);
  });

  it("throws when --project or --handle is missing", () => {
    expect(() => parseArgs(["--role", "master", "--handle", "h"])).toThrow(/--project/);
    expect(() => parseArgs(["--role", "master", "--project", "p"])).toThrow(/--handle/);
  });
});

describe("claudeCommand", () => {
  it("returns the bare command name — cross-spawn resolves the actual file", () => {
    expect(claudeCommand()).toBe("claude");
  });
});

describe("permissionModeFor", () => {
  it("always returns acceptEdits, never bypassPermissions (no auth on TeamHub)", () => {
    expect(
      permissionModeFor({ role: "developer", project: "p", handle: "dev-A", cycle: 30, mode: "auto", watchdogInterval: 5 })
    ).toBe("acceptEdits");
    expect(
      permissionModeFor({ role: "master", project: "p", handle: "master-1", cycle: 60, mode: "auto", watchdogInterval: 5 })
    ).toBe("acceptEdits");
  });
});

describe("prompts", () => {
  it("kickoffPrompt mentions handle, role, and mode", () => {
    const prompt = kickoffPrompt({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 30,
      mode: "auto",
      watchdogInterval: 5,
    });
    expect(prompt).toContain("dev-A");
    expect(prompt).toContain("master-1");
    expect(prompt).toContain('mode="auto"');
  });

  it("cyclePrompt for tester mentions bugs", () => {
    const prompt = cyclePrompt({
      role: "tester",
      project: "proj-x",
      handle: "tester-1",
      masterHandle: "master-1",
      cycle: 30,
      mode: "manual",
      watchdogInterval: 5,
    });
    expect(prompt).toMatch(/bug/i);
  });

  it("redirectPrompt embeds the interrupt text", () => {
    const prompt = redirectPrompt("switch to OAuth");
    expect(prompt).toContain("switch to OAuth");
    expect(prompt).toMatch(/interrupt/i);
  });
});

describe("runInterruptibleCycle", () => {
  it("resolves normally without killing the child when no interrupt arrives", async () => {
    const killSpy = vi.fn();
    const spawn = () => ({
      child: { kill: killSpy },
      result: Promise.resolve({ stdout: JSON.stringify({ result: "done", session_id: "sess-1" }) }),
    });
    const pollInterrupt = vi.fn().mockResolvedValue(undefined);

    const outcome = await runInterruptibleCycle("prompt", "dev-A", "tools", "acceptEdits", pollInterrupt, 5, spawn as any);

    expect(outcome).toEqual({ interrupted: false });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills the child and reports the interrupt text when one arrives", async () => {
    let rejectResult!: (err: Error) => void;
    const resultPromise = new Promise<{ stdout: string }>((_, reject) => {
      rejectResult = reject;
    });
    const killSpy = vi.fn(() => rejectResult(new Error("killed")));
    const spawn = () => ({ child: { kill: killSpy }, result: resultPromise });
    const pollInterrupt = vi.fn().mockResolvedValue("stop now");

    const outcome = await runInterruptibleCycle("prompt", "dev-A", "tools", "acceptEdits", pollInterrupt, 5, spawn as any);

    expect(outcome).toEqual({ interrupted: true, interruptText: "stop now" });
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});

describe("logStreamEvent", () => {
  it("prints assistant text blocks and returns the text", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = logStreamEvent("master-1", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Created task BTS-3." }] },
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Created task BTS-3."));
    expect(result).toBe("Created task BTS-3.");
    spy.mockRestore();
  });

  it("prints tool_use blocks with the tool name and returns undefined (no text block)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = logStreamEvent("dev-A", {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__teamhub__check_inbox", input: { handle: "dev-A" } }] },
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("calling mcp__teamhub__check_inbox"));
    expect(result).toBeUndefined();
    spy.mockRestore();
  });

  it("never throws on an unrecognized or malformed event shape", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => logStreamEvent("h", { type: "something_unexpected" })).not.toThrow();
    expect(() => logStreamEvent("h", null)).not.toThrow();
    spy.mockRestore();
  });
});

describe("parseResetDelayMs", () => {
  it("computes the delay until the next occurrence of a resets time in a named zone", () => {
    const now = new Date("2026-08-03T05:00:00Z");
    const ms = parseResetDelayMs("You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)", now);
    expect(ms).toBe(4 * 60 * 60 * 1000);
  });

  it("rolls over to the next day when the reset time has already passed today", () => {
    const now = new Date("2026-08-03T13:00:00Z");
    const ms = parseResetDelayMs("resets 2:30pm (Asia/Calcutta)", now);
    expect(ms).toBe(20 * 60 * 60 * 1000);
  });

  it("returns undefined when there's no resets/timezone clause to parse", () => {
    expect(parseResetDelayMs("You've hit your weekly limit.")).toBeUndefined();
  });
});

describe("usageLimitBackoffMs", () => {
  it("returns a backoff for Claude's weekly-limit notice, using the parsed reset time", () => {
    const now = new Date("2026-08-03T05:00:00Z");
    const err = new Error("claude exited with code 1: You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)");
    expect(usageLimitBackoffMs(err, now)).toBe(4 * 60 * 60 * 1000);
  });

  it("returns undefined for unrelated errors so they keep propagating as real failures", () => {
    expect(usageLimitBackoffMs(new Error("spawn claude ENOENT"))).toBeUndefined();
    expect(usageLimitBackoffMs(new Error("claude exited with code 1: Not logged in"))).toBeUndefined();
  });
});

describe("exitErrorMessage", () => {
  it("leads with the assistant's last text block, which is where Claude's own limit notice appears", () => {
    const message = exitErrorMessage(1, "You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)", "");
    expect(message).toBe("claude exited with code 1: You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)");
  });

  it("regression: a weekly-limit exit is detected end-to-end by usageLimitBackoffMs", () => {
    const err = new Error(exitErrorMessage(1, "You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)", ""));
    expect(usageLimitBackoffMs(err, new Date("2026-08-03T05:00:00Z"))).toBe(4 * 60 * 60 * 1000);
  });
});
