import { describe, it, expect } from "vitest";
import { helpText } from "../src/cli.js";

describe("helpText", () => {
  it("mentions every command", () => {
    const text = helpText();
    for (const cmd of ["connect", "status", "install", "agent", "help"]) {
      expect(text).toContain(cmd);
    }
  });
});
