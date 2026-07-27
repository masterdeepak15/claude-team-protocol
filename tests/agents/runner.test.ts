import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, claudeCommand, kickoffPrompt, cyclePrompt } from "../../agents/runner.js";

describe("parseArgs", () => {
  it("parses master args with defaults", () => {
    const args = parseArgs(["--role", "master", "--project", "proj-x", "--handle", "master-1"]);
    expect(args).toEqual({ role: "master", project: "proj-x", handle: "master-1", masterHandle: undefined, cycle: 60 });
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
    });
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

describe("prompts", () => {
  it("kickoffPrompt mentions the handle and role for master", () => {
    const prompt = kickoffPrompt({ role: "master", project: "proj-x", handle: "master-1", cycle: 60 });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("proj-x");
    expect(prompt).toContain("role=\"master\"");
  });

  it("cyclePrompt for developer references the master handle", () => {
    const prompt = cyclePrompt({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 30,
    });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("dev-A");
  });
});
