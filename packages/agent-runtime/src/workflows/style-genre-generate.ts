import type { AgentRunRequest, AgentRunResponse, ConversationDetail, ProjectLibraryRecord, SkillRunRequest } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import { recordsFromGeneratedSections } from "../library-draft.js";
import { buildSectionedGeneratedSavePlan } from "../sectioned-generated-save.js";
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
 * “创建都市高武的风格与题材库并保存”. The model output is always staged in
 * normal generated caches. “保存” expresses the intended targets and mode,
 * never bypasses the user's cache-review confirmation.
 */
export class StyleGenreGenerateWorkflow implements WorkflowHandler {
  id = "style_genre_generate";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const instruction = String(request.content || (request as any).instruction || "").trim();
    const mode = isReplaceInstruction(instruction) ? "replace" : "merge";

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

    const cacheMode = mode === "replace" ? "replace" : "append";
    const groupId = `style-genre-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const caches = await Promise.all(generated.map(async (item) => {
      const savePlan = buildSectionedGeneratedSavePlan({
        skillId: item.skillId,
        result: item.result,
        mode: cacheMode,
        summaryPrefix: item.domain === "style" ? "写作风格库" : "题材库"
      });
      const meta = await context.cache.create({
        source: "workflow:style_genre_generate",
        skill_id: item.skillId,
        mode: cacheMode,
        target_paths: savePlan.target_paths,
        summary: `风格与题材联合生成（${item.domain === "style" ? "写作风格" : "题材规则"}）`,
        save_plan: savePlan,
        conversation_id: request.conversation_id || ""
      });
      await context.cache.replace(meta.cache_id, item.result);
      const refreshed = await context.cache.get(meta.cache_id);
      return {
        pending_save: true,
        cache_id: refreshed.cache_id,
        cache_path: refreshed.cache_path,
        cache_chars: refreshed.chars,
        skill_id: item.skillId,
        result: item.result,
        target_paths: savePlan.target_paths,
        default_mode: cacheMode,
        save_plan: savePlan,
        group_id: groupId,
        domain: item.domain
      };
    }));
    report(context, "completed", "风格与题材已生成到缓存，等待确认写入（5/5）", 5, 5);
    const reply = `已生成风格与题材缓存：风格 ${generated[0]!.records.length} 条，题材 ${generated[1]!.records.length} 条。尚未写入项目，请在预览卡中确认。`;
    return response(request, reply, context, {
      skill_id: this.id,
      mode,
      batch_group_id: groupId,
      results: caches,
      deferred_generated_caches: caches,
      style_records: generated[0]!.records.length,
      genre_records: generated[1]!.records.length,
      requires_confirmation: true
    });
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

function isReplaceInstruction(value: string): boolean {
  return /(创建|重建|替换|覆盖)/.test(value);
}

function report(context: WorkflowRunContext, stage: string, message: string, completed: number, total: number): void {
  context.reportProgress?.({ stage, message, completed, total });
}

function domainLabel(domain: "style" | "genre"): string {
  return domain === "style" ? "写作风格库" : "题材库";
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
