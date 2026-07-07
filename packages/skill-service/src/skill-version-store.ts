import fs from "node:fs/promises";
import path from "node:path";
import type { SkillDefinition, SkillVersionEntry } from "@xiaoshuo/shared";

export class SkillVersionStore {
  constructor(
    private readonly projectRoot: string,
    private readonly agentDir: string,
    private readonly now: () => string
  ) {}

  async append(skillId: string, snapshot: SkillDefinition, changeReason = ""): Promise<SkillVersionEntry> {
    const versions = await this.list(skillId);
    const createdAt = this.now();
    const entry: SkillVersionEntry = {
      version_id: buildVersionId(createdAt, versions.length + 1),
      skill_id: skillId,
      created_at: createdAt,
      change_reason: String(changeReason || "").trim(),
      author: "agent",
      snapshot
    };
    const filePath = await this.versionFilePath(skillId);
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async list(skillId: string): Promise<SkillVersionEntry[]> {
    const filePath = await this.versionFilePath(skillId);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return [];
    }
    const entries: SkillVersionEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as SkillVersionEntry;
        if (parsed.skill_id === skillId && parsed.version_id && parsed.snapshot) {
          entries.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return entries;
  }

  private async versionFilePath(skillId: string): Promise<string> {
    const safeId = safeSkillId(skillId);
    const filePath = path.join(this.projectRoot, this.agentDir, "skills", "versions", `${safeId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }
}

function buildVersionId(createdAt: string, sequence: number): string {
  const timestamp = createdAt
    .trim()
    .replace(/[^0-9a-zA-Z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `v${sequence}_${timestamp || "snapshot"}`;
}

function safeSkillId(skillId: string): string {
  return String(skillId || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "skill";
}
