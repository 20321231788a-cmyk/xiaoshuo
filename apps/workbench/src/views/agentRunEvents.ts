import type { AgentRunEvent, AgentRunEventReplayResponse } from "@xiaoshuo/shared";

export type AgentRunEventReplay = {
  events: AgentRunEvent[];
  nextSequence: number;
  gapDetected: boolean;
};

export type LoadAgentRunEventPage = (after: number) => Promise<AgentRunEventReplayResponse>;

/** Replays every available page without allowing a malformed cursor to loop forever. */
export async function replayAgentRunEvents(
  loadPage: LoadAgentRunEventPage,
  after = 0
): Promise<AgentRunEventReplay> {
  let cursor = after;
  let gapDetected = false;
  let events: AgentRunEvent[] = [];

  while (true) {
    const page = await loadPage(cursor);
    events = mergeAgentRunEvents(events, page.events);
    gapDetected ||= page.gap_detected;

    const nextSequence = Math.max(page.next_sequence, page.next_after, lastSequence(page.events), cursor);
    if (!page.has_more) {
      return { events, nextSequence, gapDetected };
    }
    if (nextSequence <= cursor) {
      throw new Error("Agent 事件补流未推进 sequence");
    }
    cursor = nextSequence;
  }
}

export function mergeAgentRunEvents(existing: readonly AgentRunEvent[], incoming: readonly AgentRunEvent[]): AgentRunEvent[] {
  const byEventId = new Map<string, AgentRunEvent>();
  for (const event of existing) {
    byEventId.set(event.event_id, event);
  }
  for (const event of incoming) {
    byEventId.set(event.event_id, event);
  }
  return [...byEventId.values()].sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
}

function lastSequence(events: readonly AgentRunEvent[]): number {
  return events.reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
}
