import { describe, it, expect, vi, afterEach } from "vitest";
import { helpText, isNewerVersion, warnIfUpdateAvailable, installedVersion } from "../src/cli.js";

describe("helpText", () => {
  it("mentions every command", () => {
    const text = helpText();
    for (const cmd of ["connect", "status", "install", "agent", "help"]) {
      expect(text).toContain(cmd);
    }
  });
});

describe("isNewerVersion", () => {
  it("is true only when strictly greater", () => {
    expect(isNewerVersion("2.1.5", "2.1.6")).toBe(true);
    expect(isNewerVersion("2.1.6", "2.1.6")).toBe(false);
    expect(isNewerVersion("2.1.6", "2.1.5")).toBe(false);
  });
});

describe("warnIfUpdateAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints the plain npm install command (no `upgrade` subcommand exists on this package)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "99.0.0" }) })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await warnIfUpdateAvailable("@masterdeepak15/teamhub-client");
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("99.0.0");
    expect(output).toContain("npm install -g @masterdeepak15/teamhub-client@latest");
    logSpy.mockRestore();
  });

  it("prints nothing when already current, and never throws when the registry is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: installedVersion() }) })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await warnIfUpdateAvailable("@masterdeepak15/teamhub-client");
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(warnIfUpdateAvailable("@masterdeepak15/teamhub-client")).resolves.toBeUndefined();
  });
});
