import type { AgentStreamEvent } from "@xiaoshuo/shared";

export function encodeNdjsonEvent(event: AgentStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}
