import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernedMemoryStore } from "./governed-memory-store.js";

const roots: string[] = [];
const stores: GovernedMemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(root: string) {
  const store = new GovernedMemoryStore(root);
  stores.push(store);
  return store;
}

describe("governed memory replay", () => {
  it("replays 100 conversation summaries across restart without cross-project recall or canon promotion", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "xiaoshuo-memory-replay-"));
    roots.push(root);
    const store = open(root);
    for (let turn = 1; turn <= 100; turn += 1) {
      store.upsertConversationMemory("project-alpha", {
        conversationId: `conversation-${turn}`,
        confirmedFacts: [`陆尘在 alpha 的第 ${turn} 轮设定`],
        decisions: [`alpha-${turn}`],
        rejectedOptions: [],
        userPreferences: ["克制叙事"],
        openTasks: [`alpha-task-${turn}`],
        currentGoal: `alpha goal ${turn}`,
        sourceMessageIds: [`alpha-message-${turn}`]
      });
      store.upsertConversationMemory("project-beta", {
        conversationId: `conversation-${turn}`,
        confirmedFacts: [`陆尘在 beta 的第 ${turn} 轮设定`],
        decisions: [`beta-${turn}`],
        rejectedOptions: [],
        userPreferences: ["快节奏"],
        openTasks: [`beta-task-${turn}`],
        currentGoal: `beta goal ${turn}`,
        sourceMessageIds: [`beta-message-${turn}`]
      });
    }
    expect(store.listClaims("project-alpha")).toEqual([]);
    expect(store.getConversationMemory("project-alpha", "conversation-100")).toMatchObject({
      confirmedFacts: ["陆尘在 alpha 的第 100 轮设定"],
      userPreferences: ["克制叙事"]
    });
    const reopened = open(root);
    const alpha = reopened.getConversationMemory("project-alpha", "conversation-100");
    const beta = reopened.getConversationMemory("project-beta", "conversation-100");
    expect(alpha?.confirmedFacts.join(" ")).toContain("alpha");
    expect(alpha?.confirmedFacts.join(" ")).not.toContain("beta");
    expect(beta?.confirmedFacts.join(" ")).toContain("beta");
    expect(beta?.confirmedFacts.join(" ")).not.toContain("alpha");
    expect(reopened.listClaims("project-beta")).toEqual([]);
  });
});
