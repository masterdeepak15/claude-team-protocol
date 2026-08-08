#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as readline from "node:readline";
import { readConfig, writeConfig, normalizeServerInput } from "./config.js";
import { mergeMcpConfig, mergeDesktopMcpConfig } from "./mcpConfig.js";
import { main as runAgent } from "./runner.js";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
// dist/cli.js -> package root (one level up)
const PACKAGE_ROOT = join(__dirname_, "..");

export function helpText(): string {
  return `teamhub-client — connect to a remote TeamHub server and run Claude Code team sessions

Usage: teamhub-client <command> [options]

Commands:
  connect <host:port|url>
      Save the TeamHub server to connect to (e.g. 172.16.10.32:8787).
      Verifies reachability via GET /health and reports the result — saves
      either way, so you can retry \`status\` later if the network wasn't
      ready yet.

  status
      Show the configured server and whether it's currently reachable.

  install [--skills] [--mcp] [--desktop]
      Set up the CURRENT directory / this machine to use the connected
      server. Requires \`connect\` to have been run first.
        --skills     copy team-lead/team-developer/tester/analyst/project-planner into ./.claude/skills
        --mcp        add a teamhub entry to ./.mcp.json, pointing at the connected server
        --desktop    add a teamhub entry to Claude Desktop's config (via mcp-remote)
      With no flags, prompts interactively for each step. With any flag
      given, runs non-interactively — only what you passed happens.

  agent --role <master|developer|tester|analyst> --project <id> --handle <name> [--master-handle <name>] [--mode auto|manual] [--cycle <seconds>] [--watchdog-interval <seconds>]
      Run a headless, unattended Claude Code session for one of the three
      roles, talking to the connected server (or TEAMHUB_URL, if set,
      which takes precedence). Run this FROM the project directory you
      want worked on — that's where the session-tracking file lives, and
      where the spawned claude -p process does its actual Read/Edit/Bash
      work.

  help, --help
      Show this text.
`;
}

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(rest: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function checkHealth(serverUrl: string): Promise<string> {
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return `reachable: ${JSON.stringify(await res.json())}`;
    return `reached the server but got HTTP ${res.status}`;
  } catch (err) {
    return `not reachable right now (${String((err as Error).message || err)})`;
  }
}

async function connectCommand(input: string | undefined, token: string | undefined): Promise<void> {
  if (!input || !token) {
    console.error("Usage: teamhub-client connect <host:port|url> <token>");
    console.error("The token is printed by `teamhub token` on the machine running the TeamHub server.");
    process.exitCode = 1;
    return;
  }
  const serverUrl = normalizeServerInput(input);
  console.log(`Checking ${serverUrl}/health ...`);
  console.log(await checkHealth(serverUrl));
  writeConfig({ serverUrl, token });
  console.log(`Connected. Server saved: ${serverUrl}`);
}

async function statusCommand(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.log("Not connected. Run `teamhub-client connect <host:port>` first.");
    return;
  }
  console.log(`Configured server: ${config.serverUrl}`);
  console.log(await checkHealth(config.serverUrl));
}

function copySkills(targetDir: string): string[] {
  const skillNames = ["team-lead", "team-developer", "tester", "analyst", "project-planner"];
  const copied: string[] = [];
  for (const name of skillNames) {
    const src = join(PACKAGE_ROOT, "skills", name);
    const dest = join(targetDir, ".claude", "skills", name);
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      copied.push(name);
    }
  }
  return copied;
}

function desktopConfigPath(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

function readJsonFileOrEmpty(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Couldn't parse existing JSON at ${path} — fix or remove it, then retry. (${(err as Error).message})`
    );
  }
}

function updateMcpJsonFile(targetDir: string, teamhubUrl: string, token: string): string {
  const mcpPath = join(targetDir, ".mcp.json");
  const existing = readJsonFileOrEmpty(mcpPath);
  writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(existing, teamhubUrl, token), null, 2) + "\n");
  return mcpPath;
}

function updateDesktopConfigFile(teamhubUrl: string, token: string): string {
  const path = desktopConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = readJsonFileOrEmpty(path);
  writeFileSync(path, JSON.stringify(mergeDesktopMcpConfig(existing, teamhubUrl, token), null, 2) + "\n");
  return path;
}

async function installCommand(flags: Flags): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.error("Not connected. Run `teamhub-client connect <host:port> <token>` first.");
    process.exitCode = 1;
    return;
  }
  if (!config.token) {
    console.error(
      "Connected, but no token was saved (an older `connect` run?). Re-run " +
        "`teamhub-client connect <host:port> <token>` with the token from `teamhub token` " +
        "on the server machine."
    );
    process.exitCode = 1;
    return;
  }
  const teamhubUrl = `${config.serverUrl}/mcp`;
  const targetDir = process.cwd();
  const explicit = "skills" in flags || "mcp" in flags || "desktop" in flags;

  const wantSkills = explicit
    ? flags.skills === true
    : await promptYesNo("Install team-lead/team-developer/tester/analyst/project-planner skills into ./.claude/skills?");
  const wantMcp = explicit
    ? flags.mcp === true
    : await promptYesNo(`Add a teamhub entry to ./.mcp.json (${teamhubUrl})?`);
  const wantDesktop = explicit
    ? flags.desktop === true
    : await promptYesNo("Also wire up Claude Desktop (via mcp-remote)?");

  if (wantSkills) {
    const copied = copySkills(targetDir);
    console.log(`Installed skills: ${copied.join(", ") || "(none found in this package)"}`);
  }
  if (wantMcp) {
    console.log(`Added teamhub to ${updateMcpJsonFile(targetDir, teamhubUrl, config.token)}`);
  }
  if (wantDesktop) {
    console.log(`Added teamhub to Claude Desktop's config: ${updateDesktopConfigFile(teamhubUrl, config.token)}`);
  }
  console.log(
    `\n\`teamhub-client agent ...\` will use this token automatically (no need to export ` +
      `TEAMHUB_TOKEN yourself, unless you want to override it).`
  );
  console.log(
    "\nDone. Open `claude` here interactively, or run `teamhub-client agent --role ... --project ... --handle ...` for a headless session."
  );
}

export function installedVersion(): string {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Same numeric x.y.z comparison as the server package's copy — see
// cli/teamhub-cli.ts (the server package) for the full rationale.
export function isNewerVersion(current: string, latest: string): boolean {
  const a = current.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

async function fetchLatestVersion(packageName: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version;
  } catch {
    return undefined;
  }
}

// teamhub-client has no `upgrade` subcommand of its own (unlike the server
// package, it isn't managing a running process to stop/restart) — so the
// update instruction here is the plain npm command directly, not a
// wrapper. Same fire-and-forget contract as the server package's copy:
// never blocks or fails `agent` over a version check.
export async function warnIfUpdateAvailable(packageName: string): Promise<void> {
  const current = installedVersion();
  const latest = await fetchLatestVersion(packageName);
  if (!latest || !isNewerVersion(current, latest)) return;
  console.log("");
  console.log(`⚠ A newer version of ${packageName} is available: ${current} → ${latest}`);
  console.log(`  Run \`npm install -g ${packageName}@latest\` to update.`);
  console.log("");
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "connect":
      await connectCommand(rest[0], rest[1]);
      break;
    case "status":
      await statusCommand();
      break;
    case "install":
      await installCommand(flags);
      break;
    case "agent":
      await warnIfUpdateAvailable("@masterdeepak15/teamhub-client");
      if (!process.env.TEAMHUB_TOKEN) {
        const config = readConfig();
        if (config?.token) process.env.TEAMHUB_TOKEN = config.token;
      }
      await runAgent(rest);
      break;
    case "help":
    case "--help":
    case undefined:
      console.log(helpText());
      break;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(helpText());
      process.exitCode = 1;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const invoked = process.argv[1].replace(/\\/g, "/");
  const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return invoked.endsWith(thisFile) || thisFile.endsWith(invoked);
}

if (isMain()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
