import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  return join(homedir(), ".teamhub-client");
}

export function configFilePath(): string {
  return join(configDir(), "config.json");
}

export interface ClientConfig {
  serverUrl: string;
}

// Pure parser — takes the config file's raw content (or undefined if it
// doesn't exist yet) and returns the parsed config, or undefined if never
// configured / corrupt, so `agent`/`install` can give a clear "run connect
// first" message instead of a stack trace.
export function parseConfig(raw: string | undefined): ClientConfig | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.serverUrl === "string" ? { serverUrl: parsed.serverUrl } : undefined;
  } catch {
    return undefined;
  }
}

export function readConfig(): ClientConfig | undefined {
  return parseConfig(existsSync(configFilePath()) ? readFileSync(configFilePath(), "utf-8") : undefined);
}

export function writeConfig(config: ClientConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(config, null, 2) + "\n");
}

// Normalizes user input like "172.16.10.32:8787" or "http://172.16.10.32:8787/"
// into a clean base URL: a scheme, no trailing slash.
export function normalizeServerInput(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  return value.replace(/\/+$/, "");
}
