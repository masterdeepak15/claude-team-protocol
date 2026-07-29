#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
  statSync,
  readSync,
  cpSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as readline from "node:readline";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
// dist/cli/teamhub-cli.js -> package root (two levels up)
const PACKAGE_ROOT = join(__dirname_, "..", "..");

// ---------------------------------------------------------------------------
// Pure / testable helpers
// ---------------------------------------------------------------------------

export function stateDir(): string {
  return join(homedir(), ".teamhub");
}

export function pidFilePath(): string {
  return join(stateDir(), "teamhub.pid");
}

export function logFilePath(): string {
  return join(stateDir(), "teamhub.log");
}

export function metaFilePath(): string {
  return join(stateDir(), "teamhub.meta.json");
}

// Pure parser for the "what was TeamHub last started with" state, so
// `upgrade` can restart with the same port/db without the caller having to
// remember or re-pass them. `raw` is the meta file's content, or undefined
// if it doesn't exist yet (fresh install, never started).
export function parseMeta(raw: string | undefined): { port: number; dbPath?: string } {
  if (!raw) return { port: 8787 };
  try {
    const parsed = JSON.parse(raw);
    const port = Number(parsed.port);
    return {
      port: Number.isFinite(port) ? port : 8787,
      dbPath: typeof parsed.dbPath === "string" ? parsed.dbPath : undefined,
    };
  } catch {
    return { port: 8787 };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tailLines(content: string, n: number): string {
  if (content === "") return "";
  const lines = content.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export function mergeMcpConfig(existing: any, teamhubUrl: string): any {
  const base = existing && typeof existing === "object" ? existing : {};
  const mcpServers = { ...(base.mcpServers ?? {}) };
  mcpServers.teamhub = { type: "http", url: teamhubUrl };
  return { ...base, mcpServers };
}

export function mergeDesktopMcpConfig(existing: any, teamhubUrl: string): any {
  const base = existing && typeof existing === "object" ? existing : {};
  const mcpServers = { ...(base.mcpServers ?? {}) };
  mcpServers.teamhub = { command: "npx", args: ["-y", "mcp-remote", teamhubUrl] };
  return { ...base, mcpServers };
}

const WINDOWS_TASK_NAME = "TeamHub";

export function buildWindowsAutostartArgs(nodePath: string, serverPath: string): string[] {
  return [
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    WINDOWS_TASK_NAME,
    "/TR",
    `"${nodePath}" "${serverPath}"`,
    "/RL",
    "LIMITED",
    "/F",
  ];
}

export function buildWindowsAutostartRemoveArgs(): string[] {
  return ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"];
}

export function buildLaunchdPlist(
  nodePath: string,
  serverPath: string,
  logPath: string,
  port: number,
  dbPath: string | undefined
): string {
  const envEntries = [`<key>TEAMHUB_PORT</key><string>${port}</string>`];
  if (dbPath) envEntries.push(`<key>TEAMHUB_DB</key><string>${dbPath}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.teamhub.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    ${envEntries.join("\n    ")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit(
  nodePath: string,
  serverPath: string,
  port: number,
  dbPath: string | undefined
): string {
  const envLines = [`Environment=TEAMHUB_PORT=${port}`];
  if (dbPath) envLines.push(`Environment=TEAMHUB_DB=${dbPath}`);
  return `[Unit]
Description=TeamHub MCP server

[Service]
ExecStart=${nodePath} ${serverPath}
${envLines.join("\n")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export function helpText(): string {
  return `teamhub — self-hosted TeamHub MCP server CLI

Usage: teamhub <command> [options]

Commands:
  install [--skills] [--mcp] [--desktop] [--autostart] [--port <n>] [--db <path>] [--url <url>]
      Set up TeamHub in the current directory / on this machine. With no
      flags, prompts interactively for each optional step. With any flag
      given, runs non-interactively using only the flags you passed.
        --skills     copy team-lead/team-developer/tester/project-planner into ./.claude/skills
        --mcp        add a teamhub entry to ./.mcp.json
        --desktop    add a teamhub entry to Claude Desktop's config (via mcp-remote)
        --autostart  register TeamHub to start at login/boot (Task Scheduler / launchd / systemd)

  start [--port <n>] [--db <path>]
      Start the TeamHub server in the background.

  stop
      Stop the background TeamHub server.

  status
      Report whether TeamHub is currently running.

  logs [--lines <n>] [--follow]
      Print the TeamHub server's log output (default last 50 lines).

  agent --role <master|developer|tester> --project <id> --handle <name> [--master-handle <name>] [--mode auto|manual] [--cycle <seconds>] [--watchdog-interval <seconds>]
      Run a headless (unattended) Master, Developer, or Tester loop in the
      CURRENT directory — no repo checkout needed. Uses this same directory
      for its session-tracking file and for all the Read/Edit/Bash work the
      loop does, so cd into the actual project you want it working on first.
      Set TEAMHUB_URL if TeamHub runs on a different machine (used by
      --mode auto's interrupt watchdog).

  uninstall-autostart
      Remove the auto-start registration created by \`install --autostart\`.

  upgrade, update [--port <n>] [--db <path>]
      Stop the running TeamHub server (if any), install the latest
      @masterdeepak15/teamhub-cli from npm, then start it back up — with
      whatever port/db it was last running with, unless you override with
      --port/--db. Safe to run even if TeamHub isn't currently running.

  uninstall [--force]
      Stop the running server, remove any auto-start registration, then
      uninstall @masterdeepak15/teamhub-cli via npm. Your data (the SQLite
      database) is kept by default. Pass --force to also delete it —
      including a custom --db path used by \`start\`, if any.

  help, --help
      Show this text.
`;
}

// ---------------------------------------------------------------------------
// Side-effecting commands
// ---------------------------------------------------------------------------

function readPid(): number | undefined {
  if (!existsSync(pidFilePath())) return undefined;
  const raw = readFileSync(pidFilePath(), "utf-8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : undefined;
}

function readMeta(): { port: number; dbPath?: string } {
  return parseMeta(existsSync(metaFilePath()) ? readFileSync(metaFilePath(), "utf-8") : undefined);
}

function writeMeta(port: number, dbPath: string | undefined): void {
  writeFileSync(metaFilePath(), JSON.stringify({ port, dbPath: dbPath ?? null }));
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

function installAutostart(port: number, dbPath: string | undefined): void {
  const nodePath = process.execPath;
  const serverPath = join(PACKAGE_ROOT, "dist", "teamhub", "server.js");
  mkdirSync(stateDir(), { recursive: true });

  if (process.platform === "win32") {
    if (port !== 8787) execFileSync("setx", ["TEAMHUB_PORT", String(port)]);
    if (dbPath) execFileSync("setx", ["TEAMHUB_DB", dbPath]);
    execFileSync("schtasks", buildWindowsAutostartArgs(nodePath, serverPath));
    console.log("Registered TeamHub to start at Windows logon (Task Scheduler).");
  } else if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.teamhub.server.plist");
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, buildLaunchdPlist(nodePath, serverPath, logFilePath(), port, dbPath));
    execFileSync("launchctl", ["load", "-w", plistPath]);
    console.log("Registered TeamHub as a macOS LaunchAgent (starts at login).");
  } else {
    const unitPath = join(homedir(), ".config", "systemd", "user", "teamhub.service");
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, buildSystemdUnit(nodePath, serverPath, port, dbPath));
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", "teamhub.service"]);
    console.log("Registered TeamHub as a systemd --user service (starts at login).");
  }
}

function uninstallAutostart(): void {
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", buildWindowsAutostartRemoveArgs());
    } catch {
      // task may not exist — fine
    }
    console.log("Removed TeamHub's Windows scheduled task (if it existed).");
  } else if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.teamhub.server.plist");
    if (existsSync(plistPath)) {
      try {
        execFileSync("launchctl", ["unload", "-w", plistPath]);
      } catch {
        // ignore
      }
      rmSync(plistPath, { force: true });
    }
    console.log("Removed TeamHub's macOS LaunchAgent (if it existed).");
  } else {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "teamhub.service"]);
    } catch {
      // ignore
    }
    rmSync(join(homedir(), ".config", "systemd", "user", "teamhub.service"), { force: true });
    console.log("Removed TeamHub's systemd --user service (if it existed).");
  }
}

function startServer(port: number, dbPath: string | undefined): void {
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`TeamHub is already running (pid ${existingPid}).`);
    return;
  }
  mkdirSync(stateDir(), { recursive: true });
  const logFd = openSync(logFilePath(), "a");
  const serverPath = join(PACKAGE_ROOT, "dist", "teamhub", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, TEAMHUB_PORT: String(port), ...(dbPath ? { TEAMHUB_DB: dbPath } : {}) },
  });
  closeSync(logFd);
  writeFileSync(pidFilePath(), String(child.pid));
  writeMeta(port, dbPath);
  child.unref();
  console.log(`TeamHub started in the background (pid ${child.pid}, port ${port}).`);
  console.log(`Logs: teamhub logs   (file: ${logFilePath()})`);
}

function stopServer(): void {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log("TeamHub is not running.");
    return;
  }
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    process.kill(pid, "SIGTERM");
  }
  rmSync(pidFilePath(), { force: true });
  console.log("TeamHub stopped.");
}

function statusServer(): void {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log(`TeamHub is running (pid ${pid}).`);
    console.log(`Log file: ${logFilePath()}`);
  } else {
    console.log("TeamHub is not running.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows can take a moment to fully release a just-killed process's file
// handles (observed as npm install failing with EBUSY renaming dist/ files
// immediately after stopServer() — the OS hadn't finished cleanup yet).
// Wait for the pid to actually disappear, plus a short extra grace period.
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (isProcessAlive(pid) && Date.now() - start < timeoutMs) {
    await sleep(150);
  }
  await sleep(300);
}

async function upgradeTeamhub(explicitPort: number | undefined, explicitDb: string | undefined): Promise<void> {
  const meta = readMeta();
  const port = explicitPort ?? meta.port;
  const dbPath = explicitDb ?? meta.dbPath;

  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log("Stopping the running TeamHub server...");
    stopServer();
    await waitForExit(pid, 5000);
  }

  console.log("Installing the latest @masterdeepak15/teamhub-cli from npm...");
  try {
    // cross-spawn, not execFileSync directly: on Windows, npm resolves to
    // npm.cmd, and Windows can only run .cmd files through cmd.exe —
    // execFileSync/spawnSync fail with EINVAL invoking one directly.
    // cross-spawn resolves and invokes it correctly without needing
    // `shell: true` (which would reopen a shell-injection surface).
    const result = crossSpawn.sync("npm", ["install", "-g", "@masterdeepak15/teamhub-cli@latest"], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw result.error ?? new Error(`npm install exited with code ${result.status}`);
    }
    console.log("Upgrade complete.");
  } catch (err) {
    console.error(
      "npm install failed — starting the server back up with whatever version is currently installed.",
      err
    );
  }

  console.log("Starting TeamHub...");
  startServer(port, dbPath);
}

async function uninstallTeamhub(force: boolean): Promise<void> {
  const meta = readMeta();

  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log("Stopping the running TeamHub server...");
    stopServer();
    await waitForExit(pid, 5000);
  }

  uninstallAutostart();

  if (force) {
    console.log("Removing TeamHub's data (--force)...");
    // A custom --db path (if one was ever used) lives outside the package
    // directory, so it survives `npm uninstall` unless removed explicitly.
    if (meta.dbPath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(meta.dbPath + suffix, { force: true });
      }
    }
    // pid/log/meta.json, and the default database if it was ever created
    // at the default location under ~/.teamhub.
    rmSync(stateDir(), { recursive: true, force: true });
  } else {
    console.log(
      `Keeping TeamHub's data. Database: ${meta.dbPath ?? "(default — inside the installed package, removed along with it)"}`
    );
    console.log("Pass --force to also remove it.");
  }

  console.log("Uninstalling @masterdeepak15/teamhub-cli via npm...");
  // Detached and not awaited on purpose: this CLI process is itself a file
  // inside the package npm is about to remove. Waiting for npm inline here
  // (like upgrade does) risks the same Windows file-lock problem fixed
  // there, except worse — it'd be this process's *own* running script file,
  // not a separate spawned server. Firing it detached and letting this
  // process exit first (nothing else keeps the event loop alive once main()
  // returns) avoids that entirely.
  const child = crossSpawn("npm", ["uninstall", "-g", "@masterdeepak15/teamhub-cli"], {
    detached: true,
    stdio: "inherit",
  });
  child.unref();
  console.log("TeamHub will finish uninstalling in the background momentarily.");
}

function showLogs(lines: number, follow: boolean): void {
  if (!existsSync(logFilePath())) {
    console.log("No log file yet — TeamHub hasn't been started with `teamhub start`.");
    return;
  }
  console.log(tailLines(readFileSync(logFilePath(), "utf-8"), lines));
  if (follow) {
    let lastSize = statSync(logFilePath()).size;
    setInterval(() => {
      const size = statSync(logFilePath()).size;
      if (size > lastSize) {
        const fd = openSync(logFilePath(), "r");
        const buf = Buffer.alloc(size - lastSize);
        readSync(fd, buf, 0, buf.length, lastSize);
        closeSync(fd);
        process.stdout.write(buf.toString("utf-8"));
        lastSize = size;
      }
    }, 1000);
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
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

async function runInstall(flags: Flags): Promise<void> {
  const targetDir = process.cwd();
  const port = Number(flags.port ?? 8787);
  const teamhubUrl = typeof flags.url === "string" ? flags.url : `http://localhost:${port}/mcp`;
  const dbPath = typeof flags.db === "string" ? flags.db : undefined;

  const explicit = "skills" in flags || "mcp" in flags || "desktop" in flags || "autostart" in flags;

  const wantSkills = explicit ? flags.skills === true : await promptYesNo("Install team-lead/team-developer/tester/project-planner skills into ./.claude/skills?");
  const wantMcp = explicit ? flags.mcp === true : await promptYesNo("Add a teamhub entry to ./.mcp.json?");
  const wantDesktop = explicit ? flags.desktop === true : await promptYesNo("Also wire up Claude Desktop (via mcp-remote)?");
  const wantAutostart = explicit ? flags.autostart === true : await promptYesNo("Start TeamHub automatically on login/startup?");

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
  if (wantAutostart) {
    installAutostart(port, dbPath);
  }
  console.log("\nRun `teamhub start` to start the server now.");
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case "install":
      await runInstall(flags);
      break;
    case "start":
      startServer(Number(flags.port ?? 8787), typeof flags.db === "string" ? flags.db : undefined);
      break;
    case "stop":
      stopServer();
      break;
    case "status":
      statusServer();
      break;
    case "logs":
      showLogs(Number(flags.lines ?? 50), flags.follow === true);
      break;
    case "uninstall-autostart":
      uninstallAutostart();
      break;
    case "upgrade":
    case "update":
      await upgradeTeamhub(
        flags.port !== undefined ? Number(flags.port) : undefined,
        typeof flags.db === "string" ? flags.db : undefined
      );
      break;
    case "agent": {
      const runnerPath = join(PACKAGE_ROOT, "dist", "agents", "runner.js");
      const { main: runAgent } = await import(pathToFileURL(runnerPath).href);
      await runAgent(rest);
      break;
    }
    case "uninstall":
      await uninstallTeamhub(flags.force === true);
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
