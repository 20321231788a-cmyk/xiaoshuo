import type { AgentRunEvent, AgentRunEventReplayResponse } from "@xiaoshuo/shared";
import { describe, expect, it } from "vitest";
import { mergeAgentRunEvents, replayAgentRunEvents } from "./agentRunEvents.js";

function event(eventId: string, sequence: number): AgentRunEvent {
  return {
    event_id: eventId,
    run_id: "run-one",
    sequence,
    event_type: "run.status_changed",
    step_id: "",
    payload: {},
    created_at: "2026-07-10T08:00:00.000Z"
  };
}

function page(overrides: Partial<AgentRunEventReplayResponse> = {}): AgentRunEventReplayResponse {
  return {
    events: [],
    next_after: 0,
    next_sequence: 0,
    has_more: false,
    earliest_available_sequence: 1,
    gap_detected: false,
    ...overrides
  };
}

describe("agent run event replay", () => {
  it("replays each page from next_sequence and keeps the resulting order", async () => {
    const afterValues: number[] = [];
    const replay = await replayAgentRunEvents(async (after) => {
      afterValues.push(after);
      return after === 0
        ? page({ events: [event("event-1", 1), event("event-2", 2)], next_after: 2, next_sequence: 2, has_more: true })
        : page({ events: [event("event-3", 3)], next_after: 3, next_sequence: 3 });
    });

    expect(afterValues).toEqual([0, 2]);
    expect(replay.events.map((item) => item.event_id)).toEqual(["event-1", "event-2", "event-3"]);
    expect(replay.nextSequence).toBe(3);
  });

  it("deduplicates replayed events by event_id", () => {
    const merged = mergeAgentRunEvents([event("event-2", 2), event("event-1", 1)], [event("event-2", 2), event("event-3", 3)]);

    expect(merged.map((item) => item.event_id)).toEqual(["event-1", "event-2", "event-3"]);
  });

  it("retains a replay gap so the caller can reload the authoritative run detail", async () => {
    const replay = await replayAgentRunEvents(async () => page({
      events: [event("event-8", 8)],
      next_after: 8,
      next_sequence: 8,
      earliest_available_sequence: 8,
      gap_detected: true
    }), 3);

    expect(replay.gapDetected).toBe(true);
    expect(replay.nextSequence).toBe(8);
  });

  it("rejects a paged replay response that cannot advance its cursor", async () => {
    await expect(replayAgentRunEvents(async () => page({ has_more: true }))).rejects.toThrow("未推进 sequence");
  });
});
