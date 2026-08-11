import { loadModelConfig, loadPublicConfig, loadWebSearchConfig, type ConfigServiceOptions, type ModelConfig } from "@xiaoshuo/config-service";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { canRetryWithoutStream, OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import { SkillService } from "@xiaoshuo/skill-service";
import { VectorIndex } from "@xiaoshuo/vector-service";
import {
  agentRunResponseSchema,
  type AgentIntent,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentStreamEvent,
  type ConversationAttachment,
  type ConversationDetail,
  type ConversationMessageRequest,
  type SkillDefinition
} from "@xiaoshuo/shared";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hasSkillAction, isReadContextIntent, rankSkillRoutes, type RankedSkillRoute } from "./intent-router.js";
import {
  DefaultWebSearchClient,
  formatWebSearchContext,
  shouldUseWebSearch,
  summarizeWebSearchSources,
  type WebSearchClient,
  type WebSearchSource
} from "./web-search.js";
import { applyHumanizerIfEnabled } from "./humanizer.js";
import { assembleContext } from "./kernel/context-assembler.js";
import type { AssembledContext, ContextBlock } from "./kernel/context-block.js";
import { ProjectFileResolver } from "./kernel/project-file-resolver.js";
import { buildReferenceContextBlocks } from "./kernel/reference-context.js";
import { buildStyleGenreConstraintBlock } from "./style-genre-context.js";
import { splitVisibleStreamText } from "./stream.js";
import { isCancellationError, throwIfAborted, type AgentRunOptions } from "./cancellation.js";

const MAX_RUNTIME_CONTEXT_CHARS = 8_000;
const MAX_USER_INPUT_CHARS = 16_000;
const MAX_CONTEXT_CHARS = 36_000;
const MAX_COMPACT_CONTEXT_CHARS = 14_000;

type ChatModelClient = Pick<OpenAICompatibleClient, "requestCompletion"> &
  Partial<Pick<OpenAICompatibleClient, "streamCompletion">>;

export type ChatContextAssemblyObserver = (event: { scope: string; context: AssembledContext }) => void;

type ConversationReferencePayload = ConversationMessageRequest & {
  current_path?: string;
  reference_paths?: string[];
  confirmed_reference_paths?: string[];
  disable_auto_references?: boolean;
};

export type AgentChatRunnerOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient?: ChatModelClient;
  webSearchClient?: WebSearchClient;
};

export class AgentChatRunner {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly conversations: ConversationService;
  private readonly modelClient: ChatModelClient;
  private readonly webSearchClient: WebSearchClient;
  private readonly skills: SkillService;
  private readonly fileResolver: ProjectFileResolver;

  constructor(options: AgentChatRunnerOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: this.projectRoot });
    this.conversations = new ConversationService({ projectRoot: this.projectRoot });
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
    this.webSearchClient = options.webSearchClient ?? new DefaultWebSearchClient();
    this.skills = new SkillService({ projectRoot: this.projectRoot });
    this.fileResolver = new ProjectFileResolver({ projectRoot: this.projectRoot, documents: this.documents });
  }

  async runAgent(
    payload: AgentRunRequest,
    intent: Extract<AgentIntent, "chat" | "read_context">,
    contextObserver?: ChatContextAssemblyObserver,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    const state = await this.prepareConversationState(payload);
    const config = await this.requireModelConfig();
    const webSearchSources: WebSearchSource[] = [];
    const messages = await this.buildMessages(state.detail, payload, config.thinking_enabled, false, webSearchSources, contextObserver);
    throwIfAborted(options.signal);

    try {
      const reply = String(await this.modelClient.requestCompletion(config, messages, config.temperature, { signal: options.signal })).trim();
      throwIfAborted(options.signal);
      const humanized = await this.humanizeConversationText(state.detail, reply, options);
      throwIfAborted(options.signal);
      const conversation = await this.persistAssistantReply(state.detail.id, humanized.text, webSearchSources, humanized);
      return this.buildResponse(intent, humanized.text, conversation, webSearchSources);
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      if (!looksGatewayTimeout(error)) {
        throw error;
      }
      const compactMessages = await this.buildMessages(state.detail, payload, config.thinking_enabled, true, undefined, contextObserver);
      throwIfAborted(options.signal);
      const reply = String(await this.modelClient.requestCompletion(config, compactMessages, config.temperature, { signal: options.signal })).trim();
      throwIfAborted(options.signal);
      const humanized = await this.humanizeConversationText(state.detail, reply, options);
      throwIfAborted(options.signal);
      const conversation = await this.persistAssistantReply(state.detail.id, humanized.text, webSearchSources, humanized);
      return this.buildResponse(intent, humanized.text, conversation, webSearchSources);
    }
  }

  async *streamAgentRun(
    payload: AgentRunRequest,
    intent: Extract<AgentIntent, "chat" | "read_context">,
    contextObserver?: ChatContextAssemblyObserver,
    options: AgentRunOptions = {}
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    const state = await this.prepareConversationState(payload);
    yield {
      type: "start",
      intent,
      conversation_id: state.detail.id,
      skill_id: ""
    };

    const config = await this.requireModelConfig();
    const webSearchSources: WebSearchSource[] = [];
    const baseMessages = await this.buildMessages(state.detail, payload, config.thinking_enabled, false, webSearchSources, contextObserver);
    const compactMessages = await this.buildMessages(state.detail, payload, config.thinking_enabled, true, undefined, contextObserver);
    const streamCompletion = this.modelClient.streamCompletion?.bind(this.modelClient);
    const replyParts: string[] = [];
    let stoppedPersisted = false;
    const persistStoppedReply = async () => {
      if (stoppedPersisted) {
        return;
      }
      const partial = replyParts.join("").trim();
      if (!partial) {
        return;
      }
      stoppedPersisted = true;
      await this.persistStoppedAssistantReply(state.detail.id, partial, webSearchSources).catch(() => {});
    };

    if (streamCompletion) {
      try {
        for await (const chunk of streamCompletion(config, baseMessages, config.temperature, { signal: options.signal })) {
          throwIfAborted(options.signal);
          if (!chunk) {
            continue;
          }
          replyParts.push(chunk);
          for (const visibleChunk of splitVisibleStreamText(chunk)) {
            yield {
              type: "delta",
              text: visibleChunk
            };
          }
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (replyParts.length) {
          yield {
            type: "error",
            message
          };
          return;
        }
        try {
          const fallbackReply = looksGatewayTimeout(error)
            ? await this.completeOnce(config, compactMessages, options)
            : canRetryWithoutStream(message)
              ? await this.completeOnce(config, baseMessages, options)
              : "";
          if (!fallbackReply && !looksGatewayTimeout(error) && !canRetryWithoutStream(message)) {
            throw error;
          }
          if (fallbackReply) {
            replyParts.push(fallbackReply);
            for (const visibleChunk of splitVisibleStreamText(fallbackReply)) {
              yield {
                type: "delta",
                text: visibleChunk
              };
            }
          }
        } catch (fallbackError) {
          if (isCancellationError(fallbackError, options.signal)) {
            await persistStoppedReply();
            throw fallbackError;
          }
          yield {
            type: "error",
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          };
          return;
        }
      }
    } else {
      try {
        const reply = await this.completeOnce(config, baseMessages, options);
        if (reply) {
          replyParts.push(reply);
          for (const visibleChunk of splitVisibleStreamText(reply)) {
            yield {
              type: "delta",
              text: visibleChunk
            };
          }
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        try {
          if (!looksGatewayTimeout(error)) {
            throw error;
          }
          const reply = await this.completeOnce(config, compactMessages, options);
          if (reply) {
            replyParts.push(reply);
            for (const visibleChunk of splitVisibleStreamText(reply)) {
              yield {
                type: "delta",
                text: visibleChunk
              };
            }
          }
        } catch (fallbackError) {
          if (isCancellationError(fallbackError, options.signal)) {
            await persistStoppedReply();
            throw fallbackError;
          }
          yield {
            type: "error",
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          };
          return;
        }
      }
    }

    if (!replyParts.length) {
      try {
        const reply = await this.completeOnce(config, baseMessages, options);
        if (reply) {
          replyParts.push(reply);
          for (const visibleChunk of splitVisibleStreamText(reply)) {
            yield {
              type: "delta",
              text: visibleChunk
            };
          }
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        yield {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        };
        return;
      }
    }

    const reply = replyParts.join("").trim();
    try {
      throwIfAborted(options.signal);
      if (await this.shouldRunConversationHumanizer(state.detail, reply)) {
        yield {
          type: "delta",
          text: "",
          stage: "humanizer_start"
        };
      }
      const humanized = await this.humanizeConversationText(state.detail, reply, options);
      throwIfAborted(options.signal);
      const conversation = await this.persistAssistantReply(state.detail.id, humanized.text, webSearchSources, humanized);
      yield {
        type: "final",
        payload: this.buildResponse(intent, humanized.text, conversation, webSearchSources)
      };
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        await persistStoppedReply();
      }
      throw error;
    }
  }

  private async completeOnce(config: ModelConfig, messages: ChatCompletionMessage[], options: AgentRunOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    const reply = String(await this.modelClient.requestCompletion(config, messages, config.temperature, { signal: options.signal })).trim();
    throwIfAborted(options.signal);
    return reply;
  }

  private async prepareConversationState(payload: AgentRunRequest): Promise<{ detail: ConversationDetail }> {
    const userText = String(payload.content || "").trim();
    if (!userText) {
      throw new Error("消息内容不能为空");
    }

    const title = summarizeTitle(userText);
    let detail = payload.conversation_id
      ? await this.conversations.getConversation(payload.conversation_id)
      : await this.conversations.createConversation({
          title,
          skill_id: payload.skill_id,
          agent_name: ""
        });

    if (detail.title === "新对话" && title) {
      detail = await this.conversations.renameConversation(detail.id, title);
    }

    const resolvedSkillId = await this.resolveSkillId(payload.skill_id || "", userText, detail);
    if (detail.current_skill !== resolvedSkillId) {
      detail = await this.conversations.saveConversation({
        ...detail,
        current_skill: resolvedSkillId
      });
    }

    detail = await this.conversations.appendMessage(detail.id, {
      role: "user",
      content: userText,
      metadata: {
        intent_hint: resolvedSkillId ? "skill" : "chat",
        skill_id: resolvedSkillId,
        current_path: payload.current_path || "",
        attachment_ids: payload.attachment_ids || []
      }
    });

    return { detail };
  }

  private async humanizeConversationText(detail: ConversationDetail, reply: string, options: AgentRunOptions = {}) {
    return applyHumanizerIfEnabled({
      text: reply,
      config: this.config,
      modelClient: this.modelClient,
      mode: detail.current_skill ? `会话技能 ${detail.current_skill} 回复` : "会话回复",
      skip: detail.current_skill === "humanizer_zh",
      signal: options.signal
    });
  }

  private async shouldRunConversationHumanizer(detail: ConversationDetail, reply: string): Promise<boolean> {
    if (!String(reply || "").trim() || detail.current_skill === "humanizer_zh") {
      return false;
    }
    try {
      const publicConfig = await loadPublicConfig(this.config);
      return Boolean(publicConfig.humanizer_enabled);
    } catch {
      return false;
    }
  }

  private async persistAssistantReply(
    conversationId: string,
    reply: string,
    webSearchSources: WebSearchSource[] = [],
    humanizer?: { applied: boolean; error?: string }
  ): Promise<ConversationDetail> {
    let detail = await this.conversations.appendMessage(conversationId, {
      role: "assistant",
      content: String(reply || "").trim() || "已完成。",
      metadata: {
        ...(humanizer?.applied ? { humanized: true, humanizer_skill_id: "humanizer_zh" } : {}),
        ...(humanizer?.error ? { humanizer_error: humanizer.error } : {}),
        ...(webSearchSources.length ? { web_search_sources: webSearchSources } : {})
      }
    });

    if ((detail.messages.length >= 10 && !detail.summary) || detail.messages.length % 6 === 0) {
      detail = await this.conversations.summarizeConversation(conversationId);
    }

    return detail;
  }

  private async persistStoppedAssistantReply(
    conversationId: string,
    partialReply: string,
    webSearchSources: WebSearchSource[] = []
  ): Promise<ConversationDetail> {
    return this.conversations.appendMessage(conversationId, {
      role: "assistant",
      content: String(partialReply || "").trim() || "已停止。",
      metadata: {
        stopped: true,
        cancelled: true,
        ...(webSearchSources.length ? { web_search_sources: webSearchSources } : {})
      }
    });
  }

  private async requireModelConfig(): Promise<ModelConfig> {
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名。");
    }
    return config;
  }

  private async buildMessages(
    detail: ConversationDetail,
    payload: AgentRunRequest,
    thinkingEnabled: boolean,
    compact: boolean,
    webSearchSources?: WebSearchSource[],
    contextObserver?: ChatContextAssemblyObserver
  ): Promise<ChatCompletionMessage[]> {
    const continuity = await buildProjectContinuityContext(this.projectRoot);
    const attachments = await this.resolveAttachmentTexts(detail, payload.attachment_ids);
    const recentMessages = detail.messages
      .slice(compact ? -5 : -7, -1)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: clipText(message.content, compact ? 900 : 1_800)
      })) as ChatCompletionMessage[];

    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(thinkingEnabled)
      },
      {
        role: "system",
        content: buildStableProjectContext(detail, continuity, attachments, compact, contextObserver, compact ? "agent_chat_stable_compact" : "agent_chat_stable")
      }
    ];

    if (detail.summary) {
      messages.push({
        role: "system",
        content: `会话摘要：\n${clipText(detail.summary, compact ? 1_200 : 2_400)}`
      });
    }

    messages.push(...recentMessages);
    messages.push({
      role: "user",
      content: await this.buildTurnContext(payload, compact, webSearchSources, contextObserver)
    });

    return messages;
  }

  private async buildTurnContext(
    payload: AgentRunRequest,
    compact: boolean,
    webSearchSources?: WebSearchSource[],
    contextObserver?: ChatContextAssemblyObserver
  ): Promise<string> {
    const runtimeContext = await this.resolveRuntimeContext(payload, compact);
    const referenceBlocks = await this.resolveReferenceBlocks(payload, compact);
    const limit = compact ? 3_000 : 5_000;
    const webSearchContext = await this.buildWebSearchContext(payload.content || "", runtimeContext, compact, webSearchSources);
    const assembled = assembleContext(
      [
        {
          id: "turn_instructions",
          title: "本轮动态上下文说明",
          source: "runtime",
          priority: "critical",
          content: ["【本轮动态上下文】", "这些内容只用于当前这一轮的回答，优先级低于项目稳定上下文。"].join("\n")
        },
        {
          id: "runtime_context",
          title: "当前文档/选区/前端读取上下文",
          source: "runtime",
          priority: "high",
          content: `【当前文档/选区/前端读取上下文】\n${clipText(runtimeContext, limit) || "暂无"}`
        },
        ...referenceBlocks,
        {
          id: "web_search_context",
          title: "联网搜索小说素材",
          source: "web",
          priority: "medium",
          content: `【联网搜索小说素材】\n${webSearchContext}`
        },
        {
          id: "user_input",
          title: "用户输入",
          source: "conversation",
          priority: "critical",
          content: `【用户输入】\n${clipText(payload.content || "", compact ? 8_000 : MAX_USER_INPUT_CHARS)}`
        }
      ],
      { budget: compact ? MAX_COMPACT_CONTEXT_CHARS : MAX_CONTEXT_CHARS }
    );
    return observeContextAssembly(compact ? "agent_chat_turn_compact" : "agent_chat_turn", assembled, contextObserver);
  }

  private async resolveRuntimeContext(payload: AgentRunRequest, compact: boolean): Promise<string> {
    const parts: string[] = [];
    const currentPath = String(payload.current_path || "").trim();
    const selection = String(payload.selection || "").trim();
    const projectContextHint = String(payload.project_context_hint || "").trim();

    if (projectContextHint) {
      parts.push(projectContextHint);
    } else if (currentPath) {
      try {
        const fileText = await this.documents.readRawText(currentPath, compact ? 3_000 : 5_000);
        parts.push(`当前文档：${currentPath}\n\n${fileText}`);
      } catch {
        parts.push(`当前文档：${currentPath}`);
      }
    }

    if (selection) {
      parts.push(`当前选区：\n${selection}`);
    }

    return parts.join("\n\n").slice(0, MAX_RUNTIME_CONTEXT_CHARS);
  }

  private async resolveReferenceBlocks(payload: AgentRunRequest, compact: boolean): Promise<ContextBlock[]> {
    try {
      const resolution = await this.fileResolver.resolve({
        text: payload.content || "",
        currentPath: payload.current_path || "",
        selection: payload.selection || "",
        attachmentIds: payload.attachment_ids || [],
        explicitPaths: payload.reference_paths || [],
        confirmedPaths: payload.confirmed_reference_paths || [],
        disableAutoReferences: payload.disable_auto_references,
        maxCandidates: 8
      });
      return buildReferenceContextBlocks({
        documents: this.documents,
        references: resolution.references,
        maxCharsPerFile: compact ? 4000 : 12000
      });
    } catch {
      return [];
    }
  }

  private async resolveAttachmentTexts(detail: ConversationDetail, attachmentIds: string[]): Promise<Array<[ConversationAttachment, string]>> {
    if (!Array.isArray(attachmentIds) || !attachmentIds.length) {
      return [];
    }

    try {
      return await this.conversations.getAttachmentTexts(detail.id, attachmentIds);
    } catch {
      return [];
    }
  }

  private buildResponse(
    intent: Extract<AgentIntent, "chat" | "read_context">,
    reply: string,
    conversation: ConversationDetail,
    webSearchSources: WebSearchSource[] = []
  ): AgentRunResponse {
    return agentRunResponseSchema.parse({
      intent,
      reply: String(reply || "").trim(),
      conversation,
      results: [],
      saved_paths: [],
      requires_confirmation: false,
      web_search_sources: webSearchSources
    });
  }

  async sendMessage(
    conversationId: string,
    payload: ConversationMessageRequest,
    options: AgentRunOptions = {}
  ): Promise<{ conversation: ConversationDetail; reply: string; saved_path: string; web_search_sources?: WebSearchSource[] }> {
    throwIfAborted(options.signal);
    const userText = (payload.content || "").trim();
    if (!userText) {
      throw new Error("消息内容不能为空");
    }

    let detail = await this.conversations.getConversation(conversationId);
    const resolvedSkillId = await this.resolveSkillId(payload.skill_id, userText, detail);
    const writeMode = resolveWriteBackMode(payload);
    await this.preflightWriteBack(payload, writeMode);

    const userMessage = {
      id: randomUUID().replaceAll("-", ""),
      role: "user" as const,
      content: userText,
      created_at: getNowString(),
      metadata: {
        skill_id: resolvedSkillId,
        agent_name: payload.agent_name || ""
      }
    };

    detail.messages.push(userMessage);
    detail.current_skill = resolvedSkillId;
    detail.current_agent = payload.agent_name || detail.current_agent;
    detail.updated_at = getNowString();
    if (detail.title === "新对话" && userText) {
      detail.title = userText.slice(0, 24);
    }

    const generated = await this.generateConversationReply(detail, payload, options);
    throwIfAborted(options.signal);
    const humanized = await applyHumanizerIfEnabled({
      text: generated.reply,
      config: this.config,
      modelClient: this.modelClient,
      mode: detail.current_skill ? `会话技能 ${detail.current_skill} 回复` : "会话回复",
      skip: detail.current_skill === "humanizer_zh",
      signal: options.signal
    });
    throwIfAborted(options.signal);
    const reply = humanized.text;
    const assistantMessage = {
      id: randomUUID().replaceAll("-", ""),
      role: "assistant" as const,
      content: reply,
      created_at: getNowString(),
      metadata: {
        skill_id: detail.current_skill,
        agent_name: detail.current_agent,
        ...(humanized.applied ? { humanized: true, humanizer_skill_id: "humanizer_zh" } : {}),
        ...(humanized.error ? { humanizer_error: humanized.error } : {}),
        ...(generated.webSearchSources.length ? { web_search_sources: generated.webSearchSources } : {})
      }
    };
    detail.messages.push(assistantMessage);

    if (detail.messages.length >= 10 && !detail.summary) {
      detail = await this.conversations.summarizeConversation(conversationId);
    } else if (detail.messages.length % 6 === 0) {
      detail = await this.conversations.summarizeConversation(conversationId);
    }

    let savedPath = "";
    if (payload.write_target && payload.write_target.trim()) {
      throwIfAborted(options.signal);
      const target = payload.write_target.trim();
      savedPath = await this.writeBack(target, reply, writeMode, Boolean(payload.confirm_write));
      detail.messages.push({
        id: randomUUID().replaceAll("-", ""),
        role: "system" as const,
        content: `已写回 ${savedPath}`,
        created_at: getNowString(),
        metadata: {
          write_target: savedPath,
          insert_mode: writeMode
        }
      });
    }

    detail.updated_at = getNowString();
    detail = await this.conversations.saveConversation(detail);

    return { conversation: detail, reply, saved_path: savedPath, web_search_sources: generated.webSearchSources };
  }

  async *streamMessage(
    conversationId: string,
    payload: ConversationMessageRequest,
    options: AgentRunOptions = {}
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    const userText = (payload.content || "").trim();
    if (!userText) {
      throw new Error("消息内容不能为空");
    }

    let detail = await this.conversations.getConversation(conversationId);
    const resolvedSkillId = await this.resolveSkillId(payload.skill_id, userText, detail);
    const writeMode = resolveWriteBackMode(payload);
    await this.preflightWriteBack(payload, writeMode);

    const userMessage = {
      id: randomUUID().replaceAll("-", ""),
      role: "user" as const,
      content: userText,
      created_at: getNowString(),
      metadata: {
        skill_id: resolvedSkillId,
        agent_name: payload.agent_name || ""
      }
    };
    detail.messages.push(userMessage);
    detail.current_skill = resolvedSkillId;
    detail.current_agent = payload.agent_name || detail.current_agent;
    detail.updated_at = getNowString();
    if (detail.title === "新对话" && userText) {
      detail.title = userText.slice(0, 24);
    }
    await this.conversations.saveConversation(detail);

    yield {
      type: "start",
      intent: "chat",
      conversation_id: conversationId,
      skill_id: resolvedSkillId
    };

    const config = await this.requireModelConfig();
    const skill = resolvedSkillId ? await this.skills.getSkill(resolvedSkillId).catch(() => null) : null;
    const webSearchSources: WebSearchSource[] = [];
    const baseMessages = await this.buildConversationMessages(detail, payload, skill, config.thinking_enabled, false, webSearchSources);
    const compactMessages = await this.buildConversationMessages(detail, payload, skill, config.thinking_enabled, true);
    const streamCompletion = this.modelClient.streamCompletion?.bind(this.modelClient);
    const replyParts: string[] = [];
    let stoppedPersisted = false;
    const persistStoppedReply = async () => {
      if (stoppedPersisted) {
        return;
      }
      const partial = replyParts.join("").trim();
      if (!partial) {
        return;
      }
      stoppedPersisted = true;
      await this.conversations
        .appendMessage(conversationId, {
          role: "assistant",
          content: partial,
          metadata: {
            skill_id: detail.current_skill,
            agent_name: detail.current_agent,
            stopped: true,
            cancelled: true,
            ...(webSearchSources.length ? { web_search_sources: webSearchSources } : {})
          }
        })
        .catch(() => {});
    };

    if (streamCompletion) {
      try {
        for await (const chunk of streamCompletion(config, baseMessages, config.temperature, { signal: options.signal })) {
          throwIfAborted(options.signal);
          if (!chunk) {
            continue;
          }
          replyParts.push(chunk);
          yield {
            type: "delta",
            text: chunk
          };
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (replyParts.length) {
          yield {
            type: "error",
            message
          };
          return;
        }
        try {
          const fallbackReply = looksGatewayTimeout(error)
            ? await this.completeOnce(config, compactMessages, options)
            : canRetryWithoutStream(message)
              ? await this.completeOnce(config, baseMessages, options)
              : "";
          if (!fallbackReply && !looksGatewayTimeout(error) && !canRetryWithoutStream(message)) {
            throw error;
          }
          if (fallbackReply) {
            replyParts.push(fallbackReply);
            yield {
              type: "delta",
              text: fallbackReply
            };
          }
        } catch (fallbackError) {
          if (isCancellationError(fallbackError, options.signal)) {
            await persistStoppedReply();
            throw fallbackError;
          }
          yield {
            type: "error",
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          };
          return;
        }
      }
    } else {
      try {
        const reply = await this.completeOnce(config, baseMessages, options);
        if (reply) {
          replyParts.push(reply);
          yield {
            type: "delta",
            text: reply
          };
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        try {
          if (!looksGatewayTimeout(error)) {
            throw error;
          }
          const reply = await this.completeOnce(config, compactMessages, options);
          if (reply) {
            replyParts.push(reply);
            yield {
              type: "delta",
              text: reply
            };
          }
        } catch (fallbackError) {
          if (isCancellationError(fallbackError, options.signal)) {
            await persistStoppedReply();
            throw fallbackError;
          }
          yield {
            type: "error",
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          };
          return;
        }
      }
    }

    if (!replyParts.length) {
      try {
        const reply = await this.completeOnce(config, baseMessages, options);
        if (reply) {
          replyParts.push(reply);
          yield {
            type: "delta",
            text: reply
          };
        }
      } catch (error) {
        if (isCancellationError(error, options.signal)) {
          await persistStoppedReply();
          throw error;
        }
        yield {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        };
        return;
      }
    }

    let reply = "";
    let humanized: { text: string; applied: boolean; error?: string };
    try {
      throwIfAborted(options.signal);
      const rawReply = replyParts.join("").trim();
      humanized = await applyHumanizerIfEnabled({
        text: rawReply,
        config: this.config,
        modelClient: this.modelClient,
        mode: detail.current_skill ? `会话技能 ${detail.current_skill} 回复` : "会话回复",
        skip: detail.current_skill === "humanizer_zh",
        signal: options.signal
      });
      throwIfAborted(options.signal);
      reply = humanized.text;
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        await persistStoppedReply();
      }
      throw error;
    }
    const assistantMessage = {
      id: randomUUID().replaceAll("-", ""),
      role: "assistant" as const,
      content: reply || "已完成。",
      created_at: getNowString(),
      metadata: {
        skill_id: detail.current_skill,
        agent_name: detail.current_agent,
        ...(humanized.applied ? { humanized: true, humanizer_skill_id: "humanizer_zh" } : {}),
        ...(humanized.error ? { humanizer_error: humanized.error } : {}),
        ...(webSearchSources.length ? { web_search_sources: webSearchSources } : {})
      }
    };
    detail.messages.push(assistantMessage);

    if (detail.messages.length >= 10 && !detail.summary) {
      detail = await this.conversations.summarizeConversation(conversationId);
    } else if (detail.messages.length % 6 === 0) {
      detail = await this.conversations.summarizeConversation(conversationId);
    }

    let savedPath = "";
    if (payload.write_target && payload.write_target.trim()) {
      throwIfAborted(options.signal);
      const target = payload.write_target.trim();
      savedPath = await this.writeBack(target, reply, writeMode, Boolean(payload.confirm_write));
      detail.messages.push({
        id: randomUUID().replaceAll("-", ""),
        role: "system" as const,
        content: `已写回 ${savedPath}`,
        created_at: getNowString(),
        metadata: {
          write_target: savedPath,
          insert_mode: writeMode
        }
      });
    }

    detail.updated_at = getNowString();
    detail = await this.conversations.saveConversation(detail);

    yield {
      type: "final",
      payload: {
        intent: "chat",
        reply,
        conversation: detail,
        results: [],
        saved_paths: savedPath ? [savedPath] : [],
        requires_confirmation: false,
        web_search_sources: webSearchSources
      }
    };
  }

  private async generateConversationReply(
    detail: ConversationDetail,
    payload: ConversationMessageRequest,
    options: AgentRunOptions = {}
  ): Promise<{ reply: string; webSearchSources: WebSearchSource[] }> {
    throwIfAborted(options.signal);
    const skill = detail.current_skill ? await this.skills.getSkill(detail.current_skill).catch(() => null) : null;
    const config = await this.requireModelConfig();
    const webSearchSources: WebSearchSource[] = [];
    const messages = await this.buildConversationMessages(detail, payload, skill, config.thinking_enabled, false, webSearchSources);
    try {
      const reply = (await this.modelClient.requestCompletion(config, messages, config.temperature, { signal: options.signal })).trim();
      throwIfAborted(options.signal);
      return { reply, webSearchSources };
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      if (!looksGatewayTimeout(error)) {
        throw error;
      }
      const retryMessages = await this.buildConversationMessages(detail, payload, skill, config.thinking_enabled, true);
      const reply = (await this.modelClient.requestCompletion(config, retryMessages, config.temperature, { signal: options.signal })).trim();
      throwIfAborted(options.signal);
      return { reply, webSearchSources };
    }
  }

  private async buildConversationMessages(
    detail: ConversationDetail,
    payload: ConversationMessageRequest,
    skill: SkillDefinition | null,
    thinkingEnabled: boolean,
    compact: boolean,
    webSearchSources?: WebSearchSource[]
  ): Promise<ChatCompletionMessage[]> {
    const continuity = await buildProjectContinuityContext(this.projectRoot);
    const attachments = await this.resolveAttachmentTexts(detail, payload.attachment_ids ?? []);
    const recentMessages = detail.messages
      .slice(compact ? -4 : -7, -1)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role,
        content: clipText(message.content, compact ? 900 : 1800)
      })) as ChatCompletionMessage[];

    const systemPrompt = this.buildConversationSystemPrompt(skill, detail.current_agent, thinkingEnabled);
    const stableContext = buildStableProjectContext(detail, continuity, attachments, compact);
    const taskInstruction = this.buildTaskInstruction(detail, skill);

    const messages: ChatCompletionMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: stableContext },
      { role: "system", content: taskInstruction }
    ];

    if (detail.summary) {
      messages.push({
        role: "system",
        content: `会话摘要：\n${clipText(detail.summary, compact ? 1200 : 2400)}`
      });
    }

    messages.push(...recentMessages);
    messages.push({
      role: "user",
      content: await this.buildConversationTurnContext(detail, payload, compact, webSearchSources)
    });

    return messages;
  }

  private buildConversationSystemPrompt(skill: SkillDefinition | null, agentName: string, thinkingEnabled: boolean): string {
    let base =
      "你是 ArcWriter 的本地项目助手。优先遵守项目状态、大纲、设定、风格库和题材库。" +
      "回答要直接可用，少解释，不要脱离现有项目乱扩设定。" +
      "你可以自主判断用户真实意图；本地文件、技能、索引和上下文由系统指路提供，不要被固定关键词束缚。";
    if (thinkingEnabled) {
      base += "\n思考模式已开启：先在内部判断任务类型、可用上下文、是否需要本地能力，再给出结果；不要输出思考过程，只输出可交付内容。";
    }
    if (agentName) {
      base += `\n当前代理：${agentName}。`;
    }
    if (skill && skill.prompt?.trim()) {
      base += `\n当前 skill 说明：\n${skill.prompt.trim()}`;
    } else if (skill) {
      base += `\n当前 skill：${skill.name}。${skill.description}`;
    }
    return base;
  }

  private buildTaskInstruction(detail: ConversationDetail, skill: SkillDefinition | null): string {
    const skillHint = skill ? `${skill.name}：${skill.description}` : (detail.current_agent || "通用项目助手");
    if (skill && skill.prompt?.trim()) {
      return `【当前任务】\n${skillHint}\n\n【当前 skill 说明】\n${skill.prompt.trim()}`;
    }
    return `【当前任务】\n${skillHint}`;
  }

  private async buildConversationTurnContext(
    detail: ConversationDetail,
    payload: ConversationMessageRequest,
    compact: boolean,
    webSearchSources?: WebSearchSource[]
  ): Promise<string> {
    const userText = payload.content || "";
    const runtimeContext = payload.runtime_context || "";
    const text = (userText || "").trim();
    const rtContext = (runtimeContext || "").trim();
    const runtimeLimit = compact ? 2500 : 5000;
    const vectorLimit = compact ? 1800 : 4000;
    const userLimit = compact ? 8000 : 16000;
    const referenceBlocks = await this.resolveConversationReferenceBlocks(payload, compact);

    let vectorContext = "None";
    const vectorIndex = new VectorIndex(this.projectRoot);
    try {
      const status = await vectorIndex.status();
      if (status.enabled && status.ready) {
        const vectorQuery = [text, rtContext].filter(Boolean).join("\n\n");
        vectorContext = await vectorIndex.buildContext(vectorQuery || text, {
          topK: compact ? 8 : 12,
          maxChars: vectorLimit
        });
      }
    } catch {
      vectorContext = "None";
    } finally {
      vectorIndex.close();
    }
    const webSearchContext = await this.buildWebSearchContext(text, rtContext, compact, webSearchSources);

    const assembled = assembleContext(
      [
        {
          id: "turn_instructions",
          title: "会话本轮动态上下文说明",
          source: "runtime",
          priority: "critical",
          content: ["【本轮动态上下文】", "这些内容每轮可能变化，优先级低于前置项目稳定上下文；只在与用户目标相关时使用。"].join("\n")
        },
        {
          id: "runtime_context",
          title: "当前文档/选区/前端读取上下文",
          source: "runtime",
          priority: "high",
          content: `【当前文档/选区/前端读取上下文】\n${clipText(rtContext, runtimeLimit) || "暂无"}`
        },
        ...referenceBlocks,
        {
          id: "vector_context",
          title: "长期记忆召回",
          source: "vector",
          priority: "medium",
          content: `【长期记忆召回】\n${clipText(vectorContext, vectorLimit)}`
        },
        {
          id: "web_search_context",
          title: "联网搜索小说素材",
          source: "web",
          priority: "medium",
          content: `【联网搜索小说素材】\n${webSearchContext}`
        },
        {
          id: "user_input",
          title: "用户输入",
          source: "conversation",
          priority: "critical",
          content: `【用户输入】\n${clipText(text, userLimit)}`
        }
      ],
      { budget: compact ? MAX_COMPACT_CONTEXT_CHARS : MAX_CONTEXT_CHARS }
    );
    return assembled.text;
  }

  private async resolveConversationReferenceBlocks(payload: ConversationMessageRequest, compact: boolean): Promise<ContextBlock[]> {
    const referencePayload = payload as ConversationReferencePayload;
    try {
      const resolution = await this.fileResolver.resolve({
        text: payload.content || "",
        currentPath: referencePayload.current_path || "",
        attachmentIds: payload.attachment_ids || [],
        explicitPaths: referencePayload.reference_paths || [],
        confirmedPaths: referencePayload.confirmed_reference_paths || [],
        disableAutoReferences: referencePayload.disable_auto_references,
        maxCandidates: 8
      });
      return buildReferenceContextBlocks({
        documents: this.documents,
        references: resolution.references,
        maxCharsPerFile: compact ? 4000 : 12000
      });
    } catch {
      return [];
    }
  }

  private async buildWebSearchContext(userText: string, runtimeContext: string, compact: boolean, webSearchSources?: WebSearchSource[]): Promise<string> {
    const config = await loadWebSearchConfig(this.config);
    if (!config.enabled || !shouldUseWebSearch(`${userText}\n${runtimeContext}`)) {
      return "None";
    }

    try {
      const query = buildWebSearchQuery(userText, runtimeContext);
      if (!query) {
        return "None";
      }
      const results = await this.webSearchClient.search(query, config);
      webSearchSources?.push(...summarizeWebSearchSources(results));
      return formatWebSearchContext(results, compact ? Math.min(config.context_chars, 1600) : config.context_chars);
    } catch {
      return "None";
    }
  }

  private async resolveSkillId(requestedSkillId: string, userText: string, detail: ConversationDetail): Promise<string> {
    const explicit = (requestedSkillId || "").trim();
    if (explicit) {
      return explicit;
    }
    return this.inferSkillId(userText, detail);
  }

  private async inferSkillId(userText: string, detail: ConversationDetail): Promise<string> {
    const text = (userText || "").trim();
    if (!text) {
      return "";
    }
    const skillsList = await this.skills.listSkills().catch(() => []);
    if (isReadContextIntent(text)) {
      const readRanked = rankSkillRoutes(text, skillsList, { currentSkillId: detail.current_skill, limit: 1 });
      if (!readRanked.length) {
        return "";
      }
    }
    const ranked = rankSkillRoutes(text, skillsList, { currentSkillId: detail.current_skill, limit: 8 });
    const top = ranked[0];
    if (top && shouldBindConversationSkill(top, text)) {
      return top.skillId;
    }
    return "";
  }

  private async writeBack(targetPath: string, reply: string, insertMode: "append" | "replace", confirmWrite: boolean): Promise<string> {
    let existing = "";
    let exists = false;
    try {
      const doc = await this.documents.readDocument(targetPath);
      existing = doc.content || "";
      exists = true;
    } catch {
      existing = "";
    }
    if (insertMode === "replace" && exists && existing.trim() && !confirmWrite) {
      throw new Error("覆盖写入已有文档需要 confirm_write=true。");
    }
    let content = "";
    if (insertMode === "append" && existing.trim()) {
      content = existing.trimEnd() + "\n\n" + reply.trim();
    } else {
      content = reply.trim();
    }
    await this.documents.saveDocument(targetPath, content, {
      source: "agent"
    });
    return targetPath;
  }

  private async preflightWriteBack(payload: ConversationMessageRequest, insertMode: "append" | "replace"): Promise<void> {
    const targetPath = payload.write_target?.trim();
    if (!targetPath || insertMode !== "replace" || payload.confirm_write === true) {
      return;
    }

    try {
      const doc = await this.documents.readDocument(targetPath);
      if ((doc.content || "").trim()) {
        throw new Error("覆盖写入已有文档需要 confirm_write=true。");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("文件不存在:")) {
        return;
      }
      throw error;
    }
  }
}

function resolveWriteBackMode(payload: ConversationMessageRequest): "append" | "replace" {
  if (!payload.write_target?.trim()) {
    return "replace";
  }
  if (payload.insert_mode !== "append" && payload.insert_mode !== "replace") {
    throw new Error("写回目标已设置，但写入方式必须明确为 append 或 replace。");
  }
  return payload.insert_mode;
}

function getNowString(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildSystemPrompt(thinkingEnabled: boolean): string {
  const base =
    "你是 ArcWriter 的本地项目助手。优先遵守项目状态、大纲、设定、风格库和题材库。" +
    "回答要直接可用，少解释，不要脱离现有项目乱扩设定。" +
    "你可以主动综合当前项目上下文、固定上下文、附件摘录和当前文档内容来回答。";
  if (!thinkingEnabled) {
    return base;
  }
  return `${base}\n思考模式已开启：先在内部判断最相关上下文，再输出结果；不要展示思考过程。`;
}

function buildStableProjectContext(
  detail: ConversationDetail,
  continuity: Awaited<ReturnType<typeof buildProjectContinuityContext>>,
  attachments: Array<[ConversationAttachment, string]>,
  compact: boolean,
  contextObserver?: ChatContextAssemblyObserver,
  scope = compact ? "stable_project_context_compact" : "stable_project_context"
): string {
  const pinned = detail.pinned_context
    .slice(compact ? -2 : -6)
    .map((item) => `【${item.label}】\n${clipText(item.content_excerpt, compact ? 500 : 1_500)}`)
    .join("\n\n") || "暂无";
  const attachmentText = attachments
    .slice(compact ? -1 : -4)
    .map(([attachment, text]) => `【${attachment.name}】\n${clipText(text, compact ? 700 : 1_400)}`)
    .join("\n\n") || "暂无";
  const previous = continuity.previous_chapters
    .slice(compact ? -1 : -2)
    .map((item) => `【${item.path}】\n${clipText(item.content, compact ? 800 : 1_200)}`)
    .join("\n\n") || "暂无";

  const outlineLimit = compact ? 1_600 : 2_200;
  const libraryLimit = compact ? 1_800 : 4_000;
  const blocks: ContextBlock[] = [
    compact
      ? {
          id: "compact_notice",
          title: "自动压缩提示",
          source: "runtime",
          priority: "critical",
          content: "【自动压缩】已压缩项目上下文以避免超时，请优先完成用户当前目标。"
        }
      : null,
    {
      id: "project_state_summary",
      title: "项目状态摘要",
      source: "project",
      priority: "critical",
      content: `【项目状态摘要】\n${clipText(continuity.state_summary || "暂无", compact ? 2_500 : 4_000)}`
    },
    {
      id: "outline",
      title: "大纲",
      source: "project",
      priority: "high",
      content: `【大纲】\n${clipText(continuity.outline, outlineLimit)}`
    },
    {
      id: "detailed_outline",
      title: "细纲",
      source: "project",
      priority: "high",
      content: `【细纲】\n${clipText(continuity.detailed_outline, outlineLimit)}`
    },
    {
      id: "chapter_outline",
      title: "章纲",
      source: "project",
      priority: "high",
      content: `【章纲】\n${clipText(continuity.chapter_outline, outlineLimit)}`
    },
    {
      id: "style_genre_constraints",
      title: "风格与题材约束",
      source: "project",
      priority: "high",
      content: buildStyleGenreConstraintBlock(continuity.style, continuity.genre, {
        compact,
        styleLimit: libraryLimit,
        genreLimit: libraryLimit
      })
    },
    {
      id: "recent_chapters",
      title: "最近正文",
      source: "document",
      priority: "medium",
      content: `【最近正文】\n${previous}`
    },
    {
      id: "attachment_excerpts",
      title: "上传附件摘录",
      source: "attachment",
      priority: "medium",
      content: `【上传附件摘录】\n${attachmentText}`
    },
    {
      id: "pinned_context",
      title: "固定上下文",
      source: "pinned",
      priority: "high",
      content: `【固定上下文】\n${pinned}`
    }
  ].filter((block): block is ContextBlock => Boolean(block));
  const assembled = assembleContext(blocks, { budget: compact ? MAX_COMPACT_CONTEXT_CHARS : MAX_CONTEXT_CHARS });
  return observeContextAssembly(scope, assembled, contextObserver);
}

function observeContextAssembly(scope: string, context: AssembledContext, observer?: ChatContextAssemblyObserver): string {
  observer?.({ scope, context });
  return context.text;
}

function clipText(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}\n...（已压缩）`;
}

function summarizeTitle(text: string): string {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  return normalized.slice(0, 24);
}

function buildWebSearchQuery(userText: string, runtimeContext: string): string {
  const text = String(userText || "").replace(/\s+/g, " ").trim();
  const context = String(runtimeContext || "").replace(/\s+/g, " ").trim();
  const base = text || context;
  if (!base) {
    return "";
  }
  if (/小说|网文|素材|设定|大纲|剧情|人物|世界观|资料/.test(base)) {
    return clipText(base, 120);
  }
  return clipText(`${base} 小说素材`, 120);
}

function looksGatewayTimeout(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return message.includes("504") || message.includes("gateway") || message.includes("超时") || message.includes("timed out");
}

function shouldBindConversationSkill(candidate: RankedSkillRoute, text: string): boolean {
  if (candidate.signals.includes("intent:chat") || candidate.signals.includes("intent:read_context")) {
    return false;
  }
  if (candidate.signals.includes("current_skill") && candidate.score >= 38) {
    return true;
  }
  return candidate.score >= 42 && hasSkillAction(text);
}
