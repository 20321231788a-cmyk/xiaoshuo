import { ProjectLibraryService } from "@xiaoshuo/document-service";
import type { AgentRunRequest, AgentRunResponse, ConversationDetail, ProjectLibraryDomain, ProjectLibraryRecord, SkillRunRequest } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import { createGeneratedLibraryDraft, recordsFromGeneratedSections } from "../library-draft.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";

type LibraryGeneration = {
  domain: "style" | "genre";
  skillId: "style_extract" | "genre_generate";
  result: string;
  records: ProjectLibraryRecord[];
};

/**
 * A compound, all-or-nothing route for requests such as
 * “创建都市高武的风格与题材库并保存”.  Prompt skills are deliberately run
 * without their normal draft side effect so both domains can be validated
 * before a single atomic document transaction commits them.
 */
export class StyleGenreGenerateWorkflow implements WorkflowHandler {
  id = "style_genre_generate";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const instruction = String(request.content || (request as any).instruction || "").trim();
    const directSave = hasExplicitSaveInstruction(instruction);
    const mode = isReplaceInstruction(instruction) ? "replace" : "merge";
    const libraries = new ProjectLibraryService({ projectRoot: context.projectRoot });

    report(context, "classifying", "已识别为风格与题材联合任务，正在读取项目上下文（1/5）", 1, 5);
    const basePayload: SkillRunRequest = {
      text: String(request.selection || ""),
      chapter: 0,
      end_chapter: 0,
      target_words: 0,
      conversation_id: request.conversation_id || "",
      source_path: request.current_path || "",
      target_path: "",
      instruction,
      write_result: false,
      attachment_ids: request.attachment_ids || [],
      reference_paths: request.reference_paths || [],
      confirmed_reference_paths: request.confirmed_reference_paths || [],
      disable_auto_references: Boolean(request.disable_auto_references)
    };

    report(context, "style", "正在生成写作风格库（2/5）", 2, 5);
    const styleText = await context.skillRunner.generateRawSkill("style_extract", {
      ...basePayload,
      instruction: `${instruction}\n\n这是“风格与题材联合创建”步骤。只输出写作风格库，且必须完整包含【写作风格】【风格示例】【参考素材】三个标题。`
    }, { signal: context.signal });
    throwIfAborted(context.signal);

    report(context, "genre", "正在生成题材规则库（3/5）", 3, 5);
    const genreText = await context.skillRunner.generateRawSkill("genre_generate", {
      ...basePayload,
      instruction: `${instruction}\n\n这是“风格与题材联合创建”步骤。只输出题材库，且必须完整包含【题材规则】【题材素材】【战斗模板】【违禁词】四个标题。`
    }, { signal: context.signal });
    throwIfAborted(context.signal);

    const generated: LibraryGeneration[] = [
      validateGeneration("style", "style_extract", styleText),
      validateGeneration("genre", "genre_generate", genreText)
    ];
    report(context, "validating", "已完成两套资料生成，正在校验结构（4/5）", 4, 5);

    if (!directSave) {
      const [currentStyle, currentGenre] = await Promise.all([libraries.get("style"), libraries.get("genre")]);
      const currentByDomain = { style: currentStyle, genre: currentGenre } as const;
      const groupId = `style-genre-${randomUUID().replace(/-/g, "")}`;
      const cacheId = `compound-${groupId}`;
      const drafts = [] as Array<{ draft_id: string; domain: ProjectLibraryDomain; records: number }>;
      try {
        for (const item of generated) {
          const current = currentByDomain[item.domain];
          const draft = await createGeneratedLibraryDraft({
            projectRoot: context.projectRoot,
            cacheId,
            skillId: item.skillId,
            result: item.result,
            mode: mode === "replace" ? "replace" : "append",
            source: "workflow:style_genre_generate",
            groupId,
            commitMode: mode,
            baseRevision: current.revision,
            targetPaths: current.projection_paths,
            conversationId: request.conversation_id || ""
          });
          if (!draft) throw new Error(`${domainLabel(item.domain)}没有生成可确认的资料条目。`);
          drafts.push({ draft_id: draft.draft_id, domain: draft.domain, records: draft.records.length });
        }
      } catch (error) {
        for (const draft of drafts) await libraries.discardDraft(draft.draft_id).catch(() => undefined);
        throw error;
      }
      report(context, "completed", "风格与题材草稿已生成，等待确认写入（5/5）", 5, 5);
      const reply = `已生成风格与题材草稿：风格 ${generated[0]!.records.length} 条，题材 ${generated[1]!.records.length} 条。确认前不会修改项目文件。`;
      return response(request, reply, context, {
        skill_id: this.id,
        library_draft_group: {
          group_id: groupId,
          mode,
          domains: ["style", "genre"],
          draft_ids: drafts.map((draft) => draft.draft_id),
          source: "workflow:style_genre_generate",
          conversation_id: request.conversation_id || "",
          created_at: new Date().toISOString()
        },
        style_draft: drafts.find((item) => item.domain === "style"),
        genre_draft: drafts.find((item) => item.domain === "genre"),
        requires_confirmation: true
      });
    }

    const [currentStyle, currentGenre] = await Promise.all([libraries.get("style"), libraries.get("genre")]);
    const recordsFor = (current: typeof currentStyle, incoming: ProjectLibraryRecord[]) =>
      mode === "replace" ? incoming : mergeRecords(current.status === "migration_required" ? current.migration_preview?.records || [] : current.records, incoming);
    report(context, "saving", `正在${mode === "replace" ? "替换" : "合并"}风格与题材库（5/5）`, 5, 5);
    const saved = await libraries.saveMany([
      {
        domain: "style",
        baseRevision: currentStyle.revision,
        records: recordsFor(currentStyle, generated[0]!.records),
        source: "workflow:style_genre_generate",
        summary: `${mode === "replace" ? "替换" : "合并"}AI生成写作风格库`,
        allowProjectionDrift: mode === "replace"
      },
      {
        domain: "genre",
        baseRevision: currentGenre.revision,
        records: recordsFor(currentGenre, generated[1]!.records),
        source: "workflow:style_genre_generate",
        summary: `${mode === "replace" ? "替换" : "合并"}AI生成题材库`,
        allowProjectionDrift: mode === "replace"
      }
    ]);
    const savedPaths = saved.flatMap((item) => item.projection_paths);
    report(context, "completed", `风格与题材库已${mode === "replace" ? "替换" : "保存"}（5/5）`, 5, 5);
    const reply = `已${mode === "replace" ? "替换" : "合并保存"}风格库与题材库，共写入 ${savedPaths.length} 个资料文件。`;
    return response(request, reply, context, {
      skill_id: this.id,
      mode,
      saved_paths: savedPaths,
      style_records: generated[0]!.records.length,
      genre_records: generated[1]!.records.length
    }, savedPaths);
  }
}

function validateGeneration(
  domain: "style" | "genre",
  skillId: LibraryGeneration["skillId"],
  result: string
): LibraryGeneration {
  const text = String(result || "").trim();
  const required = domain === "style"
    ? ["写作风格", "风格示例", "参考素材"]
    : ["题材规则", "题材素材", "战斗模板", "违禁词"];
  const missing = required.filter((label) => !new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s*)?[【[]?\\s*${label}\\s*[】\\]]?\\s*[:：]?\\s*(?:$|\\n)`, "m").test(text));
  if (missing.length) {
    throw new Error(`${domainLabel(domain)}结构不完整，缺少：${missing.join("、")}。未写入任何资料文件。`);
  }
  const records = recordsFromGeneratedSections(skillId, text, "replace");
  if (!records.length) throw new Error(`${domainLabel(domain)}没有可保存的有效条目。`);
  return { domain, skillId, result: text, records };
}

function mergeRecords(existing: ProjectLibraryRecord[], incoming: ProjectLibraryRecord[]): ProjectLibraryRecord[] {
  const merged = [...existing.filter((item) => item.status === "active")];
  const seen = new Set(merged.map(recordKey));
  for (const record of incoming) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...record, order: merged.length });
  }
  return merged;
}

function recordKey(record: ProjectLibraryRecord): string {
  return `${record.kind}:${record.name.replace(/\s+/g, "").toLowerCase()}`;
}

function hasExplicitSaveInstruction(value: string): boolean {
  return /(保存|保存到|写入|写进|写到|落盘|落到|同步到)/.test(value);
}

function isReplaceInstruction(value: string): boolean {
  return /(创建|重建|替换|覆盖)/.test(value);
}

function report(context: WorkflowRunContext, stage: string, message: string, completed: number, total: number): void {
  context.reportProgress?.({ stage, message, completed, total });
}

function domainLabel(domain: ProjectLibraryDomain): string {
  return domain === "style" ? "写作风格库" : domain === "genre" ? "题材库" : "设定资料库";
}

async function response(
  request: AgentRunRequest,
  reply: string,
  context: WorkflowRunContext,
  data: Record<string, unknown>,
  savedPaths: string[] = []
): Promise<AgentRunResponse> {
  const conversation = await recordExchange(request, reply, context);
  return {
    intent: "skill",
    reply,
    conversation,
    results: [],
    skill_result: {
      status: "done",
      result: "",
      saved_path: savedPaths[0] || "",
      data
    },
    saved_paths: savedPaths,
    requires_confirmation: Boolean(data.requires_confirmation)
  };
}

async function recordExchange(request: AgentRunRequest, reply: string, context: WorkflowRunContext): Promise<ConversationDetail | undefined> {
  if ((request as any).suppress_conversation_record === true || !request.conversation_id) return undefined;
  const detail = await context.conversations.getConversation(request.conversation_id).catch(() => null);
  if (!detail) return undefined;
  const now = new Date().toISOString();
  const userText = String(request.content || "").trim();
  const messages = [...detail.messages];
  if (userText && !messages.slice(-3).some((item) => item.role === "user" && item.content === userText)) {
    messages.push({ id: randomUUID().replace(/-/g, ""), role: "user", content: userText, created_at: now, metadata: { intent: "skill" } });
  }
  messages.push({ id: randomUUID().replace(/-/g, ""), role: "assistant", content: reply, created_at: now, metadata: { intent: "skill" } });
  const next = { ...detail, updated_at: now, messages, message_count: messages.length };
  await context.conversations.saveConversation(next);
  return next;
}
