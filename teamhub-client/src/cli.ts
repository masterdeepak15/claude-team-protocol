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
        --skills     copy team-lead/team-developer/tester/project-planner into ./.claude/skills
        --mcp        add a teamhub entry to ./.mcp.json, pointing at the connected server
        --desktop    add a teamhub entry to Claude Desktop's config (via mcp-remote)
      With no flags, prompts interactively for each step. With any flag
      given, runs non-interactively — only what you passed happens.

  agent --role <master|developer|tester> --project <id> --handle <name> [--master-handle <name>] [--mode auto|manual] [--cycle <seconds>] [--watchdog-interval <seconds>]
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

async function connectCommand(input: string | undefined): Promise<void> {
  if (!input) {
    console.error("Usage: teamhub-client connect <host:port|url>");
    process.exitCode = 1;
    return;
  }
  const serverUrl = normalizeServerInput(input);
  console.log(`Checking ${serverUrl}/health ...`);
  console.log(await checkHealth(serverUrl));
  writeConfig({ serverUrl });
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
  const skillNames = ["team-lead", "team-developer", "tester", "project-planner"];
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

function updateMcpJsonFile(targetDir: string, teamhubUrl: string): string {
  const mcpPath = join(targetDir, ".mcp.json");
  const existing = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf-8")) : {};
  writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(existing, teamhubUrl), null, 2) + "\n");
  return mcpPath;
}

function updateDesktopConfigFile(teamhubUrl: string): string {
  const path = desktopConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  writeFileSync(path, JSON.stringify(mergeDesktopMcpConfig(existing, teamhubUrl), null, 2) + "\n");
  return path;
}

async function installCommand(flags: Flags): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.error("Not connected. Run `teamhub-client connect <host:port>` first.");
    process.exitCode = 1;
    return;
  }
  const teamhubUrl = `${config.serverUrl}/mcp`;
  const targetDir = process.cwd();
  const explicit = "skills" in flags || "mcp" in flags || "desktop" in flags;

  const wantSkills = explicit
    ? flags.skills === true
    : await promptYesNo("Install team-lead/team-developer/tester/project-planner skills into ./.claude/skills?");
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
    console.log(`Added teamhub to ${updateMcpJsonFile(targetDir, teamhubUrl)}`);
  }
  if (wantDesktop) {
    console.log(`Added teamhub to Claude Desktop's config: ${updateDesktopConfigFile(teamhubUrl)}`);
  }
  console.log(
    "\nDone. Open `claude` here interactively, or run `teamhub-client agent --role ... --project ... --handle ...` for a headless session."
  );
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "connect":
      await connectCommand(rest[0]);
      break;
    case "status":
      await statusCommand();
      break;
    case "install":
      await installCommand(flags);
      break;
    case "agent":
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
