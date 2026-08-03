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
} from "../../agents/runner.js";

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
    const args = parseArgs([
      "--role", "tester",
      "--project", "proj-x",
      "--handle", "tester-1",
      "--master-handle", "master-1",
    ]);
    expect(args.role).toBe("tester");
    expect(args.cycle).toBe(30);
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


  it("throws when --master-handle is missing for developer/tester roles", () => {
    expect(() => parseArgs(["--role", "developer", "--project", "p", "--handle", "h"])).toThrow(/--master-handle/);
    expect(() => parseArgs(["--role", "tester", "--project", "p", "--handle", "h"])).toThrow(/--master-handle/);
    expect(() =>
      parseArgs(["--role", "master", "--project", "p", "--handle", "h"])
    ).not.toThrow();
  });

  it("throws when --cycle or --watchdog-interval is not a positive number", () => {
    expect(() =>
      parseArgs(["--role", "master", "--project", "p", "--handle", "h", "--cycle", "abc"])
    ).toThrow(/--cycle/);
    expect(() =>
      parseArgs(["--role", "master", "--project", "p", "--handle", "h", "--cycle", "0"])
    ).toThrow(/--cycle/);
    expect(() =>
      parseArgs([
        "--role", "developer", "--project", "p", "--handle", "h",
        "--master-handle", "m", "--watchdog-interval", "-1",
      ])
    ).toThrow(/--watchdog-interval/);
  });
});

describe("claudeCommand", () => {
  it("returns the bare command name regardless of platform — cross-spawn resolves the actual file", () => {
    expect(claudeCommand()).toBe("claude");
  });
});

describe("permissionModeFor", () => {
  it("returns acceptEdits for a developer in auto mode (never bypassPermissions — no auth on TeamHub)", () => {
    expect(
      permissionModeFor({ role: "developer", project: "p", handle: "dev-A", cycle: 30, mode: "auto", watchdogInterval: 5 })
    ).toBe("acceptEdits");
  });

  it("returns acceptEdits for a developer in manual mode", () => {
    expect(
      permissionModeFor({ role: "developer", project: "p", handle: "dev-A", cycle: 30, mode: "manual", watchdogInterval: 5 })
    ).toBe("acceptEdits");
  });

  it("returns acceptEdits for master regardless of mode", () => {
    expect(
      permissionModeFor({ role: "master", project: "p", handle: "master-1", cycle: 60, mode: "auto", watchdogInterval: 5 })
    ).toBe("acceptEdits");
  });
});

describe("prompts", () => {
  it("kickoffPrompt mentions the handle, role, and mode for a developer", () => {
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

  it("kickoffPrompt mentions the handle and role for master", () => {
    const prompt = kickoffPrompt({
      role: "master",
      project: "proj-x",
      handle: "master-1",
      cycle: 60,
      mode: "manual",
      watchdogInterval: 5,
    });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("proj-x");
    expect(prompt).toContain('role="master"');
  });

  it("cyclePrompt for developer references the master handle", () => {
    const prompt = cyclePrompt({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 30,
      mode: "manual",
      watchdogInterval: 5,
    });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("dev-A");
    expect(prompt).toMatch(/MUST reply/);
  });

  it("cyclePrompt requires replying to every message sender, including owner, for all three roles", () => {
    const base = { project: "proj-x", cycle: 30, mode: "manual" as const, watchdogInterval: 5 };
    const master = cyclePrompt({ ...base, role: "master", handle: "master-1", cycle: 60 });
    const developer = cyclePrompt({ ...base, role: "developer", handle: "dev-A", masterHandle: "master-1" });
    const tester = cyclePrompt({ ...base, role: "tester", handle: "tester-1", masterHandle: "master-1" });
    for (const prompt of [master, developer, tester]) {
      expect(prompt).toMatch(/MUST/);
      expect(prompt).toMatch(/owner/i);
      expect(prompt).toMatch(/read-but-unanswered|before (you finish|finishing) this turn/i);
    }
  });

  it("kickoffPrompt and cyclePrompt for tester mention testing/bugs, not just coding", () => {
    const kickoff = kickoffPrompt({
      role: "tester",
      project: "proj-x",
      handle: "tester-1",
      masterHandle: "master-1",
      cycle: 30,
      mode: "manual",
      watchdogInterval: 5,
    });
    expect(kickoff).toContain('role="tester"');
    expect(kickoff).toContain("tester-1");

    const cycle = cyclePrompt({
      role: "tester",
      project: "proj-x",
      handle: "tester-1",
      masterHandle: "master-1",
      cycle: 30,
      mode: "manual",
      watchdogInterval: 5,
    });
    expect(cycle).toMatch(/bug/i);
    expect(cycle).toContain("master-1");
  });

  it("redirectPrompt embeds the interrupt text and reads as an interruption", () => {
    const prompt = redirectPrompt("switch to OAuth instead of API keys");
    expect(prompt).toContain("switch to OAuth instead of API keys");
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

    const outcome = await runInterruptibleCycle(
      "prompt",
      "dev-A",
      "tools",
      "acceptEdits",
      pollInterrupt,
      5,
      spawn as any
    );

    expect(outcome).toEqual({ interrupted: false });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills the child and reports the interrupt text when one arrives before the process finishes", async () => {
    let rejectResult!: (err: Error) => void;
    const resultPromise = new Promise<{ stdout: string }>((_, reject) => {
      rejectResult = reject;
    });
    const killSpy = vi.fn(() => rejectResult(new Error("killed")));
    const spawn = () => ({ child: { kill: killSpy }, result: resultPromise });
    const pollInterrupt = vi.fn().mockResolvedValue("stop now, requirements changed");

    const outcome = await runInterruptibleCycle(
      "prompt",
      "dev-A",
      "tools",
      "acceptEdits",
      pollInterrupt,
      5,
      spawn as any
    );

    expect(outcome).toEqual({ interrupted: true, interruptText: "stop now, requirements changed" });
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through transient pollInterrupt failures without throwing", async () => {
    // Deterministic by construction: the result only resolves once pollInterrupt
    // has been called at least 3 times, so there's no wall-clock race between
    // the result timer and the watchdog's poll interval (which would make this
    // test flaky under system load).
    const killSpy = vi.fn();
    let resolveResult!: (value: { stdout: string }) => void;
    const resultPromise = new Promise<{ stdout: string }>((resolve) => {
      resolveResult = resolve;
    });
    const spawn = () => ({ child: { kill: killSpy }, result: resultPromise });

    let calls = 0;
    const pollInterrupt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
      if (calls >= 3) resolveResult({ stdout: JSON.stringify({ result: "ok" }) });
      return undefined;
    });

    const outcome = await runInterruptibleCycle(
      "prompt",
      "dev-A",
      "tools",
      "acceptEdits",
      pollInterrupt,
      5,
      spawn as any
    );

    expect(outcome).toEqual({ interrupted: false });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe("parseResetDelayMs", () => {
  it("computes the delay until the next occurrence of a resets time in a named zone", () => {
    // 2026-08-03T05:00:00Z is 10:30am in Asia/Calcutta (UTC+5:30); a
    // "resets 2:30pm" notice should land 4 hours later the same day.
    const now = new Date("2026-08-03T05:00:00Z");
    const ms = parseResetDelayMs("You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)", now);
    expect(ms).toBe(4 * 60 * 60 * 1000);
  });

  it("rolls over to the next day when the reset time has already passed today", () => {
    // 2026-08-03T13:00:00Z is 6:30pm in Asia/Calcutta — after 2:30pm, so
    // the next reset is tomorrow at 2:30pm local, 20h away.
    const now = new Date("2026-08-03T13:00:00Z");
    const ms = parseResetDelayMs("resets 2:30pm (Asia/Calcutta)", now);
    expect(ms).toBe(20 * 60 * 60 * 1000);
  });

  it("returns undefined when there's no resets/timezone clause to parse", () => {
    expect(parseResetDelayMs("You've hit your weekly limit.")).toBeUndefined();
  });

  it("returns undefined for an unrecognized timezone name", () => {
    expect(parseResetDelayMs("resets 2:30pm (Not/AZone)")).toBeUndefined();
  });
});

describe("usageLimitBackoffMs", () => {
  it("returns a backoff for Claude's weekly-limit notice, using the parsed reset time", () => {
    const now = new Date("2026-08-03T05:00:00Z");
    const err = new Error("claude exited with code 1: You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)");
    expect(usageLimitBackoffMs(err, now)).toBe(4 * 60 * 60 * 1000);
  });

  it("falls back to a default backoff when no reset time is present", () => {
    const err = new Error("You've hit your usage limit for this session.");
    const ms = usageLimitBackoffMs(err);
    expect(ms).toBeGreaterThan(0);
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

  it("includes stderr too when both are present", () => {
    const message = exitErrorMessage(1, "some assistant text", "some stderr");
    expect(message).toBe("claude exited with code 1: some assistant text — some stderr");
  });

  it("falls back to a placeholder when there's no output captured at all", () => {
    expect(exitErrorMessage(1, "", "")).toBe("claude exited with code 1: (no output captured)");
  });

  it("regression: a weekly-limit exit is detected end-to-end by usageLimitBackoffMs", () => {
    // This is exactly the real-world failure mode: Claude Code's limit
    // notice arrives as a stdout assistant text block, not stderr — if
    // exitErrorMessage ever stops including lastAssistantText, this stops
    // matching and the runner goes back to crashing instead of backing off.
    const err = new Error(
      exitErrorMessage(1, "You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)", "")
    );
    expect(usageLimitBackoffMs(err, new Date("2026-08-03T05:00:00Z"))).toBe(4 * 60 * 60 * 1000);
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
    expect(() => logStreamEvent("h", { type: "assistant", message: {} })).not.toThrow();
    spy.mockRestore();
  });
});
