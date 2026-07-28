import { describe, it, expect, vi } from "vitest";
import { emitChange, onChange } from "../../teamhub/events.js";

describe("events bus", () => {
  it("delivers an emitted change to a subscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = onChange(listener);
    emitChange("task", "proj-events-a");
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.kind).toBe("task");
    expect(event.project_id).toBe("proj-events-a");
    expect(typeof event.ts).toBe("string");
    unsubscribe();
  });

  it("stops delivering events after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onChange(listener);
    unsubscribe();
    emitChange("message", "proj-events-b");
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers to multiple independent subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = onChange(a);
    const unsubB = onChange(b);
    emitChange("sprint", "proj-events-c");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });
});
