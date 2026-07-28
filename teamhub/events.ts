import { EventEmitter } from "node:events";

// One in-process event bus shared by every teamhub/*.ts mutation and the
// UI's SSE endpoint (teamhub/api.ts). Deliberately simple — no persistence,
// no cross-process delivery (a single teamhub process is the whole point of
// this project) — just "something changed, go re-fetch" for the browser.
export type ChangeKind = "project" | "member" | "message" | "sprint" | "task";

export interface ChangeEvent {
  kind: ChangeKind;
  project_id: string;
  ts: string;
}

const bus = new EventEmitter();
// Each connected browser tab holds one SSE listener open indefinitely;
// raise the default cap (10) so a handful of dashboards open at once
// doesn't print Node's MaxListenersExceededWarning.
bus.setMaxListeners(100);

export function emitChange(kind: ChangeKind, project_id: string): void {
  const event: ChangeEvent = { kind, project_id, ts: new Date().toISOString() };
  bus.emit("change", event);
}

export function onChange(listener: (event: ChangeEvent) => void): () => void {
  bus.on("change", listener);
  return () => bus.off("change", listener);
}
