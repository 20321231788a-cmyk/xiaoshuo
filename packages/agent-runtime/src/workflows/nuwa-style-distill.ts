import { loadModelConfig } from "@xiaoshuo/config-service";
import {
  deleteProjectStyleDistillation,
  readProjectStyleDistillation,
  writeProjectStyleDistillation
} from "@xiaoshuo/project-session";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import type {
  AgentRunRequest,
  AgentRunResponse,
  ConversationDetail,
  SkillRunRequest,
  SkillRunResponse,
  StyleDistillationProfile
} from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";
import { createGeneratedLibraryDraft } from "../library-draft.js";
import {
  DISASSEMBLE_SOURCE_IMPORT_CHARS,
  listDisassembleBooks,
  readDisassembleBookText,
  sampleWholeBookSource
} from "./disassemble-library.js";

const DISTILLATION_SOURCE_IMPORT_CHARS = DISASSEMBLE_SOURCE_IMPORT_CHARS;

export class NuwaStyleDistillWorkflow implements WorkflowHandler {
  id = "nuwa_style_distill";
  canRunSkillRequest = true;

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const result = await this.runSkill(
      {
        text: request.selection || "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: request.content || "蒸馏当前拆书文风",
        target_path: "",
        conversation_id: request.conversation_id || "",
        source_path: request.current_path || "",
        write_result: true,
        attachment_ids: request.attachment_ids || [],
        ...((request as any).action !== undefined ? { action: (request as any).action } : {}),
        ...((request as any).enabled !== undefined ? { enabled: (request as any).enabled } : {}),
        ...((request as any).book_title !== undefined ? { book_title: (request as any).book_title } : {}),
        ...((request as any).source_book_id !== undefined ? { source_book_id: (request as any).source_book_id } : {})
      } as SkillRunRequest,
      context
    );
    const reply = result.result || (result.data?.profile ? "蒸馏完成。" : "Nuwa 蒸馏档案已更新。");
    return {
      intent: "skill",
      reply,
      conversation: await recordSkillExchange(request, reply, context),
      results: [],
      skill_result: result,
      saved_paths: result.saved_path ? [result.saved_path] : [],
      requires_confirmation: Boolean(result.data?.requires_confirmation)
    };
  }

  async runSkill(payload: SkillRunRequest, context: WorkflowRunContext): Promise<SkillRunResponse> {
    throwIfAborted(context.signal);
    const action = String((payload as any).action || "distill").trim();
    if (action === "status") {
      return {
        status: "done",
        result: "",
        saved_path: "",
        data: {
          skill_id: this.id,
          profile: await readProjectStyleDistillation(context.projectRoot)
        }
      };
    }

    if (action === "delete") {
      await deleteProjectStyleDistillation(context.projectRoot);
      return {
        status: "done",
        result: "已删除当前蒸馏书籍，后续生成将恢复使用普通风格库。",
        saved_path: "",
        data: {
          skill_id: this.id,
          profile: null,
          deleted: true
        }
      };
    }

    if (action === "toggle") {
      const current = await readProjectStyleDistillation(context.projectRoot);
      if (!current) {
        throw new Error("当前项目还没有蒸馏书籍");
      }
      if (current.status !== "active" && Boolean((payload as any).enabled)) {
        throw new Error(current.status === "orphaned" ? "蒸馏原文已丢失，不能重新启用；请重新关联或蒸馏。" : "蒸馏原文已变化，不能重新启用；请重新蒸馏。");
      }
      const enabled = Boolean((payload as any).enabled);
      const profile = await writeProjectStyleDistillation(context.projectRoot, {
        ...current,
        enabled
      });
      return {
        status: "done",
        result: enabled ? "已启用蒸馏文风，生成内容将强制使用该档案。" : "已停用蒸馏文风，生成内容将恢复使用普通风格库。",
        saved_path: "",
        data: {
          skill_id: this.id,
          profile
        }
      };
    }

    const source = await resolveNuwaDistillationSource(payload, context);
    throwIfAborted(context.signal);
    if (!source.text.trim()) {
      throw new Error("蒸馏需要当前文档、附件、拆书原文或已有拆书产物");
    }

    const config = await loadModelConfig(context.config, "primary");
    throwIfAborted(context.signal);
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名，无法执行 Nuwa 蒸馏。");
    }

    const systemPrompt = [
      "你是 Nuwa 小说文风蒸馏器。任务不是模仿具体句子，而是把一本书的写作方式提炼成可复用的创作规则。",
      "你需要蒸馏表达 DNA、叙事心智模型、场景决策启发式、常用描写手法、对白习惯、节奏控制、反模式和诚实边界。",
      "输出必须服务于后续小说生成：清楚、可执行、可约束，不复述剧情，不抄写原文长句。",
      "只输出中文文风档案正文，不要免责声明。"
    ].join("\n");
    const userPrompt = [
      `【书籍名称】${source.bookTitle}`,
      `【来源】${source.sourcePath || "当前输入"}`,
      "",
      "请按以下结构输出：",
      "1. 表达DNA：句长、词性偏好、感官密度、语气温度、叙述视角。",
      "2. 叙事心智模型：如何开场、推进冲突、安排转折、处理信息差。",
      "3. 描写手法：人物、动作、环境、心理、战斗或日常场景的写法。",
      "4. 对白规则：角色说话方式、潜台词、停顿、冲突对白的处理。",
      "5. 节奏启发式：什么时候加速、什么时候留白、章节钩子如何落点。",
      "6. 反模式：后续生成时要避免哪些套话、腔调、过度解释和不属于这本文风的写法。",
      "7. 可操作规则：给后续生成模型的硬性文风指令，必须具体可执行。",
      "",
      "要求：不要输出原文大段摘录；不要泛泛而谈；每条规则都要能直接约束大纲、章纲和正文生成。",
      "",
      `【待蒸馏文本】\n【全书分布采样】\n${sampleWholeBookSource(source.text, 60_000)}`
    ].join("\n");

    const raw = String(
      await context.modelClient.requestCompletion(
        config,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ] satisfies ChatCompletionMessage[],
        Math.max(0.2, Math.min(0.65, config.temperature)),
        { signal: context.signal }
      )
    ).trim();
    throwIfAborted(context.signal);
    if (!raw) {
      throw new Error("模型未返回蒸馏档案");
    }

    const profile: StyleDistillationProfile = await writeProjectStyleDistillation(context.projectRoot, {
      book_title: source.bookTitle,
      source_summary: source.summary,
      source_path: source.sourcePath,
      source_hash: createHash("sha256").update(source.text).digest("hex"),
      source_book_id: source.sourceBookId,
      source_report_path: source.sourceBookId ? `00_设定集/拆书库/${source.sourceBookId}/拆书报告.md` : "",
      evidence_spans: buildEvidenceSpans(source.text),
      evidence_version: 1,
      status: "active",
      distilled_at: new Date().toISOString(),
      enabled: true,
      profile_text: raw
    });
    const draft = await createGeneratedLibraryDraft({
      projectRoot: context.projectRoot,
      cacheId: `nuwa-${profile.source_hash}`,
      skillId: "style_extract",
      result: `## 写作风格\n${profile.book_title}\n\n${raw}`,
      mode: "append",
      source: `nuwa_style_distill:${source.sourceBookId || profile.source_hash}`
    });

    return {
      status: "done",
      result: `已蒸馏：${profile.book_title}`,
      saved_path: "00_设定集/.agent/style_distillation/current.json",
      data: {
        skill_id: this.id,
        profile,
        saved_paths: ["00_设定集/.agent/style_distillation/current.json"],
        library_draft: draft ? {
          draft_id: draft.draft_id,
          domain: draft.domain,
          records: draft.records.length,
          requires_confirmation: true
        } : undefined,
        requires_confirmation: Boolean(draft)
      }
    };
  }
}

function buildEvidenceSpans(text: string): Array<{ start: number; end: number; purpose: string; hash: string }> {
  const source = String(text || "");
  if (!source) return [];
  const size = Math.min(2400, Math.max(600, Math.floor(source.length / 4)));
  const positions = source.length <= size ? [0] : [0, Math.floor((source.length - size) / 3), Math.floor((source.length - size) * 2 / 3), source.length - size];
  return positions.map((start, index) => {
    const sample = source.slice(start, start + size);
    return { start, end: start + sample.length, purpose: ["开篇", "前期", "中期", "后期"][index] || "原文证据", hash: createHash("sha256").update(sample, "utf8").digest("hex") };
  });
}

async function resolveNuwaDistillationSource(
  payload: SkillRunRequest,
  context: WorkflowRunContext
): Promise<{ text: string; bookTitle: string; sourcePath: string; summary: string; sourceBookId: string }> {
  const explicitTitle = String((payload as any).book_title || "").trim();
  const sourceBookId = String((payload as any).source_book_id || "").trim();
  if (sourceBookId) {
    const book = (await listDisassembleBooks(context, { includeLegacy: false })).find((item) => item.id === sourceBookId);
    if (!book) throw new Error("未找到所选拆书作品");
    if (book.status !== "ready") throw new Error("所选作品尚未完成拆解，不能执行蒸馏");
    const original = await readDisassembleBookText(book, "source", context);
    if (!original.trim()) throw new Error("所选作品缺少已归档原文，已阻止仅凭拆解摘要蒸馏");
    return {
      text: original,
      bookTitle: explicitTitle || book.title,
      sourcePath: book.paths.source || book.source_path,
      summary: book.source_summary || summarizeSource(original),
      sourceBookId: book.id
    };
  }
  const direct = String(payload.text || "").trim();
  if (direct) {
    const sourcePath = String(payload.source_path || "").trim();
    return {
      text: direct,
      bookTitle: explicitTitle || inferBookTitle(sourcePath, "当前文档"),
      sourcePath,
      summary: summarizeSource(direct),
      sourceBookId: ""
    };
  }

  if (payload.conversation_id && (payload.attachment_ids || []).length) {
    const attachments = await context.conversations.getAttachmentTexts(payload.conversation_id, payload.attachment_ids, {
      limit: DISTILLATION_SOURCE_IMPORT_CHARS,
      preserveWhitespace: true
    });
    const parts = attachments
      .map(([attachment, body]) => {
        const content = String(body || "").trim();
        return content ? { name: attachment.name, content } : null;
      })
      .filter((item): item is { name: string; content: string } => Boolean(item));
    if (parts.length) {
      const text = parts.map((item) => `【${item.name}】\n${item.content}`).join("\n\n");
      return {
        text,
        bookTitle: explicitTitle || parts[0]!.name.replace(/\.[^.]+$/, ""),
        sourcePath: parts.map((item) => item.name).join(", "),
        summary: summarizeSource(text),
        sourceBookId: ""
      };
    }
  }

  const sourcePath = String(payload.source_path || "").trim();
  if (sourcePath) {
    try {
      const text = (await context.documents.readRawText(sourcePath, DISTILLATION_SOURCE_IMPORT_CHARS)).trim();
      if (text) {
        return {
          text,
          bookTitle: explicitTitle || inferBookTitle(sourcePath, "当前文档"),
          sourcePath,
          summary: summarizeSource(text),
          sourceBookId: ""
        };
      }
    } catch {}
  }

  const fallbackPaths = ["01_大纲/反向细纲.txt", "00_设定集/设定集/拆书设定提取.txt", "01_大纲/拆书细纲.txt"];
  const fallbackParts: string[] = [];
  for (const relPath of fallbackPaths) {
    try {
      const text = (await context.documents.readRawText(relPath, 30_000)).trim();
      if (text) {
        fallbackParts.push(`【${relPath}】\n${text}`);
      }
    } catch {}
  }
  const text = fallbackParts.join("\n\n").trim();
  return {
    text,
    bookTitle: explicitTitle || "当前拆书书籍",
    sourcePath: fallbackPaths.join(", "),
    summary: summarizeSource(text),
    sourceBookId: ""
  };
}

async function recordSkillExchange(
  request: AgentRunRequest,
  reply: string,
  context: WorkflowRunContext,
  assistantMetadata: Record<string, unknown> = {}
): Promise<ConversationDetail | undefined> {
  if ((request as any).suppress_conversation_record === true) {
    return request.conversation_id ? await context.conversations.getConversation(request.conversation_id).catch(() => undefined) : undefined;
  }
  const userText = String(request.content || "").trim();
  if (!userText) {
    return undefined;
  }

  let detail = request.conversation_id ? await context.conversations.getConversation(request.conversation_id).catch(() => null) : null;

  if (!detail) {
    detail = await context.conversations.createConversation({
      title: userText.slice(0, 24) || "新对话",
      skill_id: request.skill_id || "",
      agent_name: ""
    });
  }

  const createdAt = new Date().toISOString();
  const userMetadata = { intent: "skill" as const };
  const replyMetadata = { intent: "skill" as const, ...assistantMetadata };
  const recentMessages = detail.messages.slice(-3);
  const shouldAppendUser = !recentMessages.some((item) => item.role === "user" && item.content === userText);

  const nextMessages = [...detail.messages];
  if (shouldAppendUser) {
    nextMessages.push({
      id: randomUUID().replace(/-/g, ""),
      role: "user",
      content: userText,
      created_at: createdAt,
      metadata: userMetadata
    });
  }
  if (String(reply || "").trim()) {
    nextMessages.push({
      id: randomUUID().replace(/-/g, ""),
      role: "assistant",
      content: String(reply || "").trim(),
      created_at: createdAt,
      metadata: replyMetadata
    });
  }

  let nextDetail: ConversationDetail = {
    ...detail,
    title: detail.title === "新对话" ? userText.slice(0, 24) || detail.title : detail.title,
    current_skill: request.skill_id || detail.current_skill || "",
    updated_at: createdAt,
    messages: nextMessages,
    message_count: nextMessages.length
  };

  await context.conversations.saveConversation(nextDetail);
  if ((nextDetail.messages.length >= 10 && !nextDetail.summary) || nextDetail.messages.length % 6 === 0) {
    nextDetail = await context.conversations.summarizeConversation(nextDetail.id);
  }
  return nextDetail;
}

function inferBookTitle(sourcePath: string, fallback: string): string {
  const normalized = String(sourcePath || "").replace(/\\/g, "/").trim();
  const filename = normalized.split("/").filter(Boolean).at(-1) || "";
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem || fallback;
}

function summarizeSource(text: string): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length <= 240 ? compact : `${compact.slice(0, 240).trimEnd()}...`;
}
