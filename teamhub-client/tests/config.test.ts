import { describe, it, expect } from "vitest";
import { parseConfig, normalizeServerInput } from "../src/config.js";

describe("parseConfig", () => {
  it("returns undefined when there's no prior config", () => {
    expect(parseConfig(undefined)).toBeUndefined();
  });

  it("parses a valid stored config", () => {
    expect(parseConfig(JSON.stringify({ serverUrl: "http://172.16.10.32:8787" }))).toEqual({
      serverUrl: "http://172.16.10.32:8787",
    });
  });

  it("returns undefined on corrupt JSON rather than throwing", () => {
    expect(parseConfig("{not valid json")).toBeUndefined();
  });

  it("returns undefined when serverUrl is missing or the wrong type", () => {
    expect(parseConfig(JSON.stringify({}))).toBeUndefined();
    expect(parseConfig(JSON.stringify({ serverUrl: 123 }))).toBeUndefined();
  });
});

describe("normalizeServerInput", () => {
  it("adds http:// to a bare host:port", () => {
    expect(normalizeServerInput("172.16.10.32:8787")).toBe("http://172.16.10.32:8787");
  });

  it("leaves an explicit scheme alone", () => {
    expect(normalizeServerInput("https://teamhub.example.com")).toBe("https://teamhub.example.com");
  });

  it("strips a trailing slash", () => {
    expect(normalizeServerInput("http://172.16.10.32:8787/")).toBe("http://172.16.10.32:8787");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeServerInput("  172.16.10.32:8787  ")).toBe("http://172.16.10.32:8787");
  });
});
