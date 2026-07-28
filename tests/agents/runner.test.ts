import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseArgs,
  claudeCommand,
  kickoffPrompt,
  cyclePrompt,
  permissionModeFor,
  redirectPrompt,
  runInterruptibleCycle,
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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses claude.cmd on win32", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(claudeCommand()).toBe("claude.cmd");
  });

  it("uses claude on other platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(claudeCommand()).toBe("claude");
  });
});

describe("permissionModeFor", () => {
  it("returns bypassPermissions for a developer in auto mode", () => {
    expect(
      permissionModeFor({ role: "developer", project: "p", handle: "dev-A", cycle: 30, mode: "auto", watchdogInterval: 5 })
    ).toBe("bypassPermissions");
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
      "bypassPermissions",
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
      "bypassPermissions",
      pollInterrupt,
      5,
      spawn as any
    );

    expect(outcome).toEqual({ interrupted: true, interruptText: "stop now, requirements changed" });
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through transient pollInterrupt failures without throwing", async () => {
    const killSpy = vi.fn();
    const spawn = () => ({
      child: { kill: killSpy },
      result: new Promise<{ stdout: string }>((resolve) =>
        setTimeout(() => resolve({ stdout: JSON.stringify({ result: "ok" }) }), 25)
      ),
    });
    let calls = 0;
    const pollInterrupt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
      return undefined;
    });

    const outcome = await runInterruptibleCycle(
      "prompt",
      "dev-A",
      "tools",
      "bypassPermissions",
      pollInterrupt,
      5,
      spawn as any
    );

    expect(outcome).toEqual({ interrupted: false });
    expect(calls).toBeGreaterThan(1);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
