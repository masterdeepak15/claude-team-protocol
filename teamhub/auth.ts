import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";

// One shared secret gates everything — the dashboard login "password" and
// the Bearer token every agent's .mcp.json presents to /mcp are the exact
// same value. This is deliberately not a multi-user system: TeamHub is
// meant for one team behind one office LAN, with "Owner" as the single
// human identity already established elsewhere (see teamhub/members.ts).
// A shared token matches that model instead of building real user accounts
// for something this scoped.

function stateDir(): string {
  const dir = process.env.TEAMHUB_STATE_DIR || join(homedir(), ".teamhub");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tokenPath(): string {
  return join(stateDir(), "teamhub.token");
}

function revokedBeforePath(): string {
  return join(stateDir(), "session-revoked-before");
}

// Stateless signed cookies (below) can't be individually revoked — there's
// no server-side session store to delete a row from. But logout still has
// to actually mean something, not just "the one browser that clicked
// logout stops sending its cookie while the same cookie value would still
// validate if replayed." Since this is a single shared Owner identity (not
// per-user accounts), one global "anything issued before this moment is no
// longer valid" timestamp is exactly the right amount of state: logout
// invalidates every previously-issued session everywhere, which is the
// correct behavior for a shared identity, and persisting it means a server
// restart doesn't accidentally un-revoke something Owner explicitly logged
// out of.
function getRevokedBeforeMs(): number {
  const path = revokedBeforePath();
  if (!existsSync(path)) return 0;
  const raw = Number(readFileSync(path, "utf-8").trim());
  return Number.isFinite(raw) ? raw : 0;
}

export function revokeAllSessions(): void {
  writeFileSync(revokedBeforePath(), String(Date.now()));
}

let cachedToken: string | undefined;

export function getOrCreateToken(): string {
  if (cachedToken) return cachedToken;
  if (process.env.TEAMHUB_TOKEN) {
    cachedToken = process.env.TEAMHUB_TOKEN;
    return cachedToken;
  }
  const path = tokenPath();
  if (existsSync(path)) {
    cachedToken = readFileSync(path, "utf-8").trim();
    return cachedToken;
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(path, token + "\n");
  try {
    chmodSync(path, 0o600); // best-effort; no-op on platforms that don't support unix perms
  } catch {
    // ignore — not fatal, just belt-and-suspenders on POSIX systems
  }
  cachedToken = token;
  return token;
}

// Non-creating variant for other processes (e.g. the headless agent
// runner) that may be talking to a TeamHub server on a different machine.
// getOrCreateToken() would happily fabricate a brand-new local token if
// none exists yet — fine for the server itself, but wrong here: on a
// remote developer/tester PC that "new" token just silently doesn't match
// the server's, turning a clear "you forgot to set TEAMHUB_TOKEN" error
// into a confusing 401 further downstream. This only ever returns a token
// that's known to already exist — the env var, or a state file previously
// written by getOrCreateToken() (true when the agent runs on the same
// machine as the server) — and undefined otherwise.
export function readLocalToken(): string | undefined {
  if (process.env.TEAMHUB_TOKEN) return process.env.TEAMHUB_TOKEN;
  const path = tokenPath();
  if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  return undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const SESSION_COOKIE = "teamhub_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signSession(issuedAtMs: number, secret: string): string {
  return createHmac("sha256", secret).update(String(issuedAtMs)).digest("hex");
}

export function createSessionCookieValue(): string {
  const issuedAtMs = Date.now();
  const sig = signSession(issuedAtMs, getOrCreateToken());
  return `${issuedAtMs}.${sig}`;
}

function isValidSessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const [issuedAtRaw, sig] = value.split(".");
  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAtMs) || !sig) return false;
  if (Date.now() - issuedAtMs > SESSION_MAX_AGE_MS) return false;
  if (issuedAtMs < getRevokedBeforeMs()) return false;
  const expected = signSession(issuedAtMs, getOrCreateToken());
  return timingSafeStringEqual(sig, expected);
}

// Very small hand-rolled cookie parse/set so this doesn't need the
// cookie-parser dependency just for one cookie.
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: Response): void {
  const value = createSessionCookieValue();
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; SameSite=Strict`
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`);
}

export function verifyLoginToken(candidate: unknown): boolean {
  return typeof candidate === "string" && candidate.length > 0 && timingSafeStringEqual(candidate, getOrCreateToken());
}

// Guards /mcp: every agent's .mcp.json must present the same shared token
// as `headers: { Authorization: "Bearer <token>" }`.
export function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!presented || !timingSafeStringEqual(presented, getOrCreateToken())) {
    res.status(401).json({ error: "Missing or invalid Authorization: Bearer <token> header." });
    return;
  }
  next();
}

// Guards the dashboard's /api/* routes: a signed session cookie set by
// POST /api/login, not the raw token on every request.
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!isValidSessionCookie(readCookie(req, SESSION_COOKIE))) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  next();
}

export function isLoggedIn(req: Request): boolean {
  return isValidSessionCookie(readCookie(req, SESSION_COOKIE));
}
