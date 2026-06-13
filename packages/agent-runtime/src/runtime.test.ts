import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelConfig } from "@xiaoshuo/config-service";
import { ConversationService } from "@xiaoshuo/conversation-service";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import type { AgentStreamEvent } from "@xiaoshuo/shared";
import { AgentRuntimeService } from "./runtime.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-agent-runtime-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "这是测试大纲", "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "细纲.txt"), "这是测试细纲", "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "这是测试章纲", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "克制冷静", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "升级流", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("agent-runtime chat flow", () => {
  it("runs read-context chat locally and persists the conversation", async () => {
    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "本地聊天回复";
        }
      }
    });

    const request = {
      conversation_id: "",
      content: "请总结当前项目",
      current_path: "01_大纲/大纲.txt",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    expect(
      await runtime.canRunAgentLocally({
        ...request,
        content: "生成大纲"
      })
    ).toBe(true);

    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("read_context");
    expect(result.reply).toBe("本地聊天回复");
    expect(result.conversation?.messages).toHaveLength(2);
    expect(result.conversation?.messages[0]?.role).toBe("user");
    expect(result.conversation?.messages[1]?.role).toBe("assistant");
    expect(capturedMessages[1]?.content).toContain("【大纲】");
    expect(capturedMessages.at(-1)?.content).toContain("【用户输入】");

    const conversations = new ConversationService({ projectRoot: tempDir });
    const persisted = await conversations.getConversation(result.conversation!.id);
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages[1]?.content).toBe("本地聊天回复");
  });

  it("humanizes chat replies when the global switch is enabled", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", humanizer_enabled: true }), "utf8");
    const calls: string[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          calls.push(messages[0]?.content || "");
          return calls.length === 1 ? "此外，这一刻标志着命运的关键转折。" : "这一刻，事情拐了个弯。";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "写一段剧情",
      current_path: "01_大纲/大纲.txt",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    });

    expect(result.reply).toBe("这一刻，事情拐了个弯。");
    expect(result.conversation?.messages.at(-1)?.content).toBe("这一刻，事情拐了个弯。");
    expect(result.conversation?.messages.at(-1)?.metadata.humanized).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Humanizer-zh");
  });

  it("runs file operations locally and persists the agent exchange", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "文件操作" });
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () =>
          JSON.stringify({
            summary: "追加正文",
            operations: [
              {
                action: "append_text",
                path: "02_正文/正文.txt",
                text: "\n新增一段正文",
                old_text: "",
                new_text: "",
                target_path: "",
                reason: "根据用户要求追加正文"
              }
            ]
          })
      }
    });

    const request = {
      conversation_id: conversation.id,
      content: "请保存到正文文件",
      current_path: "",
      selection: "这是一段待保存的正文内容。",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("file_operation");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ ok: true, action: "create_file", path: "02_正文/正文.txt" });
    expect(result.reply).toContain("完成：create_file 02_正文/正文.txt");
    expect(result.conversation?.messages.at(-2)?.role).toBe("user");
    expect(result.conversation?.messages.at(-1)?.role).toBe("assistant");

    const body = await fs.readFile(path.join(tempDir, "02_正文", "正文.txt"), "utf8");
    expect(body).toContain("这是一段待保存的正文内容。");

    const persisted = await conversations.getConversation(conversation.id);
    expect(persisted.messages.at(-2)?.content).toBe("请保存到正文文件");
    expect(persisted.messages.at(-1)?.content).toContain("完成：create_file 02_正文/正文.txt");
  });

  it("streams file operations locally", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () =>
          JSON.stringify({
            summary: "归档大纲",
            operations: [
              {
                action: "archive_file",
                path: "01_大纲/大纲.txt",
                text: "",
                old_text: "",
                new_text: "",
                target_path: "",
                reason: "用户要求删除"
              }
            ]
          })
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamAgentRun({
      conversation_id: "",
      content: "删除大纲文件",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "final"]);
    expect(events[0]).toMatchObject({ type: "start", intent: "file_operation" });
    expect(events[1]).toMatchObject({
      type: "final",
      payload: {
        intent: "file_operation",
        requires_confirmation: true
      }
    });
  });

  it("streams chat locally with attachment-backed context", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "stream test" });
    const attachment = await conversations.addAttachment(
      conversation.id,
      "source.txt",
      "text/plain",
      Buffer.from("附件里的剧情素材", "utf8")
    );

    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "fallback",
        async *streamCompletion(_config: ModelConfig, messages: ChatCompletionMessage[]) {
          capturedMessages = messages;
          yield "第一句";
          yield "第二句";
        }
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamAgentRun({
      conversation_id: conversation.id,
      content: "我们继续聊这个项目",
      current_path: "",
      selection: "",
      project_context_hint: "当前文档：01_大纲/大纲.txt\n\n上下文片段",
      skill_id: "",
      attachment_ids: [attachment.id]
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "delta", "final"]);
    expect(events[0]).toMatchObject({
      type: "start",
      intent: "chat",
      conversation_id: conversation.id
    });
    expect(events[1]).toMatchObject({ type: "delta", text: "第一句" });
    expect(events[2]).toMatchObject({ type: "delta", text: "第二句" });
    expect(events[3]).toMatchObject({
      type: "final",
      payload: {
        intent: "chat",
        reply: "第一句第二句"
      }
    });

    expect(capturedMessages[1]?.content).toContain("【source.txt】");
    expect(capturedMessages.at(-1)?.content).toContain("当前文档：01_大纲/大纲.txt");

    const updated = await conversations.getConversation(conversation.id);
    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[1]?.content).toBe("第一句第二句");
  });

  it("streams web search sources in the final chat payload", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "stream web search" });
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => [
          {
            title: "宋代市井参考",
            url: "https://example.test/song-market",
            snippet: "不应进入来源摘要"
          }
        ]
      },
      modelClient: {
        requestCompletion: async () => "fallback",
        async *streamCompletion() {
          yield "结合资料后的回复";
        }
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamAgentRun({
      conversation_id: conversation.id,
      content: "联网搜索宋代市井资料，帮我找小说素材",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    })) {
      events.push(event);
    }

    const final = events.find((event) => event.type === "final");
    expect(final?.type).toBe("final");
    if (final?.type === "final") {
      expect(final.payload.web_search_sources).toEqual([{ title: "宋代市井参考", url: "https://example.test/song-market" }]);
      expect(JSON.stringify(final.payload.web_search_sources)).not.toContain("不应进入来源摘要");
      expect(final.payload.conversation?.messages.at(-1)?.metadata.web_search_sources).toEqual([
        { title: "宋代市井参考", url: "https://example.test/song-market" }
      ]);
    }
  });

  it("runs batch replace locally across project documents", async () => {
    await fs.writeFile(path.join(tempDir, "01_大纲", "人物设定.txt"), "主角林默来到城里。林默开始修炼。", "utf8");
    await fs.writeFile(path.join(tempDir, "02_正文", "第一章.txt"), "林默推开门，林默看见天光。", "utf8");

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "unused"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "把所有林默改为杨瑞",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    });

    expect(result.intent).toBe("file_operation");
    expect(result.results).toHaveLength(2);
    expect(result.reply).toContain("完成：批量替换 2 个文件，共 4 处。");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "人物设定.txt"), "utf8")).toContain("杨瑞");
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8")).not.toContain("林默");
  });

  it("limits batch replace to current document scope when requested", async () => {
    await fs.writeFile(path.join(tempDir, "01_大纲", "人物设定.txt"), "林默出现在设定里。", "utf8");
    await fs.writeFile(path.join(tempDir, "02_正文", "第一章.txt"), "林默只在正文里出现一次。", "utf8");

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "unused"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "把当前文档里的林默替换为杨瑞",
      current_path: "02_正文/第一章.txt",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    });

    expect(result.intent).toBe("file_operation");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ path: "02_正文/第一章.txt", ok: true });
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8")).toContain("杨瑞");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "人物设定.txt"), "utf8")).toContain("林默");
  });

  it("infers the main character name for batch replace when the user omits the old name", async () => {
    await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "主角：林默\n林默会进入宗门。", "utf8");
    await fs.writeFile(path.join(tempDir, "02_正文", "第一章.txt"), "林默站在山门前。", "utf8");

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "unused"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "把主角改为杨瑞",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    });

    expect(result.intent).toBe("file_operation");
    expect(result.results).toHaveLength(2);
    expect(result.reply).toContain("完成：批量替换 2 个文件，共 3 处。");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toContain("杨瑞");
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8")).toContain("杨瑞");
  });

  it("falls back to normal completion when stream returns no deltas", async () => {
    let requestCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => {
          requestCalls += 1;
          return "普通补偿回复";
        },
        async *streamCompletion(_config: ModelConfig, _messages: ChatCompletionMessage[]) {
          // 模拟某些 OpenAI-compatible 服务端忽略 stream=true，直接返回普通 JSON。
        }
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamAgentRun({
      conversation_id: "",
      content: "我们继续聊这个项目",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    })) {
      events.push(event);
    }

    expect(requestCalls).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "final"]);
    expect(events[1]).toMatchObject({
      type: "delta",
      text: "普通补偿回复"
    });
    expect(events[2]).toMatchObject({
      type: "final",
      payload: {
        intent: "chat",
        reply: "普通补偿回复"
      }
    });
  });

  it("sendMessage appends user message, generates assistant reply, and handles write_target", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "新对话" });

    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "助理回复内容";
        }
      }
    });

    const payload = {
      content: "测试发送消息",
      skill_id: "",
      agent_name: "test-agent",
      write_target: "02_正文/第一章.txt",
      insert_mode: "replace" as const,
      runtime_context: "前端上下文",
      attachment_ids: []
    };

    const result = await runtime.sendMessage(conversation.id, payload);

    expect(result.reply).toBe("助理回复内容");
    expect(result.saved_path).toBe("02_正文/第一章.txt");
    expect(result.conversation.messages).toHaveLength(3); // user + assistant + system (已写回)
    expect(result.conversation.messages[0]?.role).toBe("user");
    expect(result.conversation.messages[0]?.content).toBe("测试发送消息");
    expect(result.conversation.messages[1]?.role).toBe("assistant");
    expect(result.conversation.messages[1]?.content).toBe("助理回复内容");
    expect(result.conversation.messages[2]?.role).toBe("system");
    expect(result.conversation.messages[2]?.content).toContain("已写回 02_正文/第一章.txt");

    // Check file content
    const fileContent = await fs.readFile(path.join(tempDir, "02_正文/第一章.txt"), "utf8");
    expect(fileContent).toBe("助理回复内容");
  });

  it("does not call web search when the feature is disabled", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "联网测试" });
    let searchCalls = 0;
    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          searchCalls += 1;
          return [];
        }
      },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "普通回复";
        }
      }
    });

    const result = await runtime.sendMessage(conversation.id, {
      content: "请联网搜索一些古代县城素材",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none" as const,
      runtime_context: "",
      attachment_ids: []
    });

    expect(searchCalls).toBe(0);
    expect(capturedMessages.at(-1)?.content).toContain("【联网搜索小说素材】\nNone");
  });

  it("does not call web search when enabled but the user does not ask for outside material", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "联网测试" });
    let searchCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          searchCalls += 1;
          return [];
        }
      },
      modelClient: {
        requestCompletion: async () => "普通回复"
      }
    });

    await runtime.sendMessage(conversation.id, {
      content: "帮我润色当前这段人物对白",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none" as const,
      runtime_context: "",
      attachment_ids: []
    });

    expect(searchCalls).toBe(0);
  });

  it("injects web search material into the chat prompt without leaking the API key", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        api_key: "demo-key",
        model: "demo-model",
        web_search_enabled: true,
        web_search_provider: "custom",
        web_search_api_key: "secret-search-key",
        web_search_base_url: "https://search.example.test/api",
        web_search_max_results: 2,
        web_search_context_chars: 1200
      }),
      "utf8"
    );
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "联网测试" });
    let capturedQuery = "";
    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async (query) => {
          capturedQuery = query;
          return [
            {
              title: "唐代县城生活",
              url: "https://example.test/tang-town",
              snippet: "市集、坊巷和县衙日常可作为场景参考。"
            }
          ];
        }
      },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "已结合素材";
        }
      }
    });

    const result = await runtime.sendMessage(conversation.id, {
      content: "请联网搜索唐代县城生活资料，给我小说素材",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none" as const,
      runtime_context: "",
      attachment_ids: []
    });

    const prompt = capturedMessages.at(-1)?.content || "";
    expect(capturedQuery).toContain("唐代县城");
    expect(prompt).toContain("【联网搜索小说素材】");
    expect(prompt).toContain("唐代县城生活");
    expect(prompt).toContain("https://example.test/tang-town");
    expect(prompt).not.toContain("secret-search-key");
    expect(result.web_search_sources).toEqual([{ title: "唐代县城生活", url: "https://example.test/tang-town" }]);
    expect(result.conversation.messages.at(-1)?.metadata.web_search_sources).toEqual([{ title: "唐代县城生活", url: "https://example.test/tang-town" }]);
    expect(JSON.stringify(result.web_search_sources)).not.toContain("市集、坊巷");
  });

  it("continues the chat when web search fails", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "联网测试" });
    let completionCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          throw new Error("search outage");
        }
      },
      modelClient: {
        requestCompletion: async () => {
          completionCalls += 1;
          return "搜索失败但继续回复";
        }
      }
    });

    const result = await runtime.sendMessage(conversation.id, {
      content: "联网搜索一些赛博朋克城市素材",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none" as const,
      runtime_context: "",
      attachment_ids: []
    });

    expect(completionCalls).toBe(1);
    expect(result.reply).toBe("搜索失败但继续回复");
    expect(result.conversation.messages.at(-1)?.content).toBe("搜索失败但继续回复");
  });

  it("rejects write_target when insert_mode is none", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "新对话" });
    const targetPath = path.join(tempDir, "02_正文/第一章.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "原文", "utf8");

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "不应写入"
      }
    });

    await expect(
      runtime.sendMessage(conversation.id, {
        content: "测试发送消息",
        skill_id: "",
        agent_name: "test-agent",
        write_target: "02_正文/第一章.txt",
        insert_mode: "none" as const,
        runtime_context: "",
        attachment_ids: []
      })
    ).rejects.toThrow("写回目标已设置");

    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("原文");
  });

  it("requires confirm_write before replacing an existing document", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "新对话" });
    const targetPath = path.join(tempDir, "02_正文/第一章.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "原文", "utf8");

    let completionCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => {
          completionCalls += 1;
          return "确认后写入";
        }
      }
    });

    const payload = {
      content: "测试发送消息",
      skill_id: "",
      agent_name: "test-agent",
      write_target: "02_正文/第一章.txt",
      insert_mode: "replace" as const,
      runtime_context: "",
      attachment_ids: []
    };

    await expect(runtime.sendMessage(conversation.id, payload)).rejects.toThrow("覆盖写入已有文档需要");
    expect(completionCalls).toBe(0);
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("原文");

    const confirmed = await runtime.sendMessage(conversation.id, { ...payload, confirm_write: true });
    expect(completionCalls).toBe(1);
    expect(confirmed.saved_path).toBe("02_正文/第一章.txt");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("确认后写入");
  });

  it("auto-saves streamed conversation saves that explicitly request writing over existing files", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "保存测试" });
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          if (messages[0]?.content.includes("生成结果保存规划器")) {
            return JSON.stringify({
              action: "replace_existing",
              mode: "replace",
              target_paths: ["01_大纲/大纲.txt"],
              reason: "用户要求保存到大纲。",
              confidence: 0.91,
              requires_confirmation: false,
              should_auto_commit: true
            });
          }
          return "新的大纲内容";
        }
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamMessage(conversation.id, {
      content: "生成新版大纲并保存到大纲",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none",
      runtime_context: "",
      attachment_ids: []
    })) {
      events.push(event);
    }

    const final = events.find((event) => event.type === "final");
    expect(final?.type).toBe("final");
    if (final?.type !== "final") {
      throw new Error("missing final event");
    }
    expect(final.payload.skill_result?.data).toMatchObject({
      saved_paths: ["01_大纲/大纲.txt"]
    });
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("新的大纲内容");
  });

  it("runs local prompt skill intent via manual skill id", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "生成的大纲内容"
      }
    });

    const request = {
      conversation_id: "",
      content: "请生成大纲",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.reply).toBe("生成的大纲内容");
    expect(result.skill_result?.result).toBe("生成的大纲内容");
    expect(result.saved_paths).toEqual([]);
  });

  it("directly saves local prompt skill overwrite when the instruction asks to write", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "新的大纲内容"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "请生成大纲并写入文件",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.saved_paths).toEqual(["01_大纲/大纲.txt"]);
    expect(result.skill_result?.data).toMatchObject({
      saved_paths: ["01_大纲/大纲.txt"]
    });
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("新的大纲内容");
  });

  it("streams local prompt skill intent with start/final events", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "技能流式最终结果"
      }
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of runtime.streamAgentRun({
      conversation_id: "",
      content: "请生成大纲",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "final"]);
    expect(events[0]).toMatchObject({ type: "start", intent: "skill" });
    expect(events[1]).toMatchObject({
      type: "delta",
      text: "技能流式最终结果",
      skill_id: "outline_generate"
    });
    const delta = events[1];
    expect(delta?.type).toBe("delta");
    if (delta?.type !== "delta") {
      throw new Error("missing delta event");
    }
    expect(delta.cache_id).toBeTruthy();
    expect(events[2]).toMatchObject({
      type: "final",
      payload: {
        intent: "skill",
        reply: "技能流式最终结果"
      }
    });
  });

  it("passes target_words into local outline skill requests", async () => {
    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "正文生成结果";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "请生成大纲，约3200字",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.result).toBe("正文生成结果");
    expect(capturedMessages.at(-1)?.content).toContain("约3200字");
  });

  it("uses current path as skill source when the user mentions the current document", async () => {
    let capturedMessages: ChatCompletionMessage[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "润色完成";
        }
      }
    });

    await fs.writeFile(path.join(tempDir, "02_正文", "第一章.txt"), "这是当前正文内容。", "utf8");
    const result = await runtime.runAgent({
      conversation_id: "",
      content: "请润色当前文档",
      current_path: "02_正文/第一章.txt",
      selection: "",
      project_context_hint: "",
      skill_id: "polish_text",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.result).toBe("润色完成");
    expect(capturedMessages.at(-1)?.content).toContain("这是当前正文内容。");
  });

  it("persists local skill intent exchange into an existing conversation", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "技能会话" });
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "技能回复内容"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: conversation.id,
      content: "请生成大纲",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.conversation?.id).toBe(conversation.id);
    expect(result.conversation?.messages.at(-2)?.role).toBe("user");
    expect(result.conversation?.messages.at(-2)?.content).toBe("请生成大纲");
    expect(result.conversation?.messages.at(-1)?.role).toBe("assistant");
    expect(result.conversation?.messages.at(-1)?.content).toBe("技能回复内容");

    const persisted = await conversations.getConversation(conversation.id);
    expect(persisted.messages.at(-2)?.content).toBe("请生成大纲");
    expect(persisted.messages.at(-1)?.content).toBe("技能回复内容");
  });

  it("creates a conversation for local skill intent when no conversation id is provided", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "自动建会话的技能回复"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "请生成大纲",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "outline_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.conversation?.id).toBeTruthy();
    expect(result.conversation?.messages).toHaveLength(2);
    expect(result.conversation?.messages[0]?.role).toBe("user");
    expect(result.conversation?.messages[1]?.role).toBe("assistant");
    expect(result.conversation?.messages[1]?.content).toBe("自动建会话的技能回复");
  });

  it("orchestrates multiple skills from a complex chat request", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "编排会话" });
    const calls: string[] = [];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          const system = messages[0]?.content || "";
          if (system.includes("技能调度器")) {
            return JSON.stringify({
              should_call_skill: true,
              confidence: 0.91,
              selected_reason: "用户要求先提取设定再做一致性检查。",
              steps: [
                { skill_id: "lore_extract", instruction: "提取当前内容中的设定", reason: "先结构化设定", confidence: 0.9 },
                { skill_id: "consistency_check", instruction: "基于提取结果检查一致性", reason: "再检查冲突", confidence: 0.88 }
              ]
            });
          }
          calls.push(system);
          if (system.includes("连续性审稿人")) {
            return JSON.stringify({ score: 95, risks: [], reason: "一致" });
          }
          return "【人物设定】\n主角：林舟";
        }
      }
    });

    const result = await runtime.sendMessage(conversation.id, {
      content: "请提取这段设定，然后检查一致性",
      skill_id: "",
      agent_name: "",
      write_target: "",
      insert_mode: "none" as const,
      runtime_context: "林舟得到一枚古玉。",
      attachment_ids: []
    });

    expect(result.skill_result?.data?.skill_steps).toHaveLength(2);
    expect(result.skill_result?.data?.skill_steps).toMatchObject([
      { skill_id: "lore_extract", status: "done" },
      { skill_id: "consistency_check", status: "done" }
    ]);
    expect(result.conversation.current_skill).toBe("consistency_check");
    expect(result.conversation.messages.at(-1)?.metadata.skill_plan).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((item) => item.includes("连续性审稿人"))).toBe(true);
  });

  it("uses an imported replacement skill when a builtin is disabled", async () => {
    const agentSkillDir = path.join(tempDir, "00_设定集", ".agent", "skills");
    await fs.mkdir(agentSkillDir, { recursive: true });
    await fs.writeFile(path.join(agentSkillDir, "disabled-builtins.json"), JSON.stringify(["polish_text"]), "utf8");
    await fs.writeFile(
      path.join(agentSkillDir, "imported.json"),
      JSON.stringify([
        {
          id: "custom_polish",
          name: "自定义润色",
          description: "当默认润色禁用时，用于润色、改写和优化表达。",
          input_mode: "text",
          context_requirements: ["project_state", "style"],
          handler_type: "prompt",
          linked_targets: ["02_正文/润色结果.txt"],
          prompt: "请润色文本，保持剧情事实不变。",
          imported_from: "test",
          writable: true
        }
      ]),
      "utf8"
    );

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          const system = messages[0]?.content || "";
          if (system.includes("技能调度器")) {
            return JSON.stringify({
              should_call_skill: true,
              confidence: 0.83,
              selected_reason: "默认润色不可用，选择导入润色技能。",
              steps: [{ skill_id: "custom_polish", instruction: "润色当前文档", reason: "相近导入技能", confidence: 0.83 }]
            });
          }
          return "导入技能润色结果";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "请润色当前文档",
      current_path: "",
      selection: "原始句子",
      project_context_hint: "",
      skill_id: "",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.data?.skill_steps).toMatchObject([{ skill_id: "custom_polish", status: "done" }]);
    expect(result.reply).toBe("导入技能润色结果");
  });

  it("routes genre_generate skill intent locally with multi-target pending-save metadata", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【题材规则】\n规则内容\n\n【题材素材】\n素材内容\n\n【战斗模板】\n模板内容\n\n【违禁词】\n禁词内容"
      }
    });

    const request = {
      conversation_id: "",
      content: "请生成题材规则、题材素材、战斗模板和违禁词",
      current_path: "",
      selection: "玄幻升级流",
      project_context_hint: "",
      skill_id: "genre_generate",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.data).toMatchObject({
      pending_save: true,
      target_paths: [
        "00_设定集/题材库/题材规则.txt",
        "00_设定集/题材库/题材素材.txt",
        "00_设定集/题材库/战斗模板.txt",
        "00_设定集/题材库/违禁词.txt"
      ]
    });
  });

  it("routes style_extract skill intent locally with multi-target pending-save metadata", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【写作风格】\n风格规则\n\n【风格示例】\n示例特征\n\n【参考素材】\n素材摘要"
      }
    });

    const request = {
      conversation_id: "",
      content: "请提取写作风格、风格示例和参考素材",
      current_path: "",
      selection: "样文内容",
      project_context_hint: "",
      skill_id: "style_extract",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.data).toMatchObject({
      pending_save: true,
      target_paths: [
        "00_设定集/风格库/写作风格.txt",
        "00_设定集/风格库/风格示例.txt",
        "00_设定集/风格库/参考素材.txt"
      ]
    });
  });

  it("routes lore_extract skill intent locally with multi-target pending-save metadata", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【人物设定】\n林默：主角，出身寒门。\n\n【体系设定】\n修炼分九境。"
      }
    });

    const request = {
      conversation_id: "",
      content: "请提取人物设定、体系设定和世界规则",
      current_path: "",
      selection: "林默踏入宗门，开始修炼。",
      project_context_hint: "",
      skill_id: "lore_extract",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.data).toMatchObject({
      saved_paths: [
        "00_设定集/设定集/人物设定.txt",
        "00_设定集/设定集/体系设定.txt"
      ]
    });
  });

  it("runs disassemble_book locally and writes lore plus reverse outline files into a new book directory", async () => {
    const responses = ["【人物设定】\n林默：主角，出身寒门。", "第一章：林默入宗门。"];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    const request = {
      conversation_id: "",
      content: "请拆书",
      current_path: "",
      selection: "林默从寒门少年一路成长为宗门天骄。",
      project_context_hint: "",
      skill_id: "disassemble_book",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);
    const book = result.skill_result?.data?.book as { dir?: string; paths?: { lore?: string; reverse_outline?: string } } | undefined;

    expect(result.intent).toBe("skill");
    expect(book?.dir).toContain("00_设定集/拆书库/");
    expect(result.saved_paths?.[0]).toContain("00_设定集/拆书库/");
    expect(result.saved_paths).toEqual([
      `${book?.dir}/拆书设定提取.txt`,
      `${book?.dir}/反向细纲.txt`
    ]);
    expect(book?.paths?.lore).toBe(`${book?.dir}/拆书设定提取.txt`);
    expect(book?.paths?.reverse_outline).toBe(`${book?.dir}/反向细纲.txt`);
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "设定集", "拆书设定提取.txt"), "utf8")).toContain("林默");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "反向细纲.txt"), "utf8")).toContain("第一章");
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "拆书设定提取.txt"), "utf8")).toContain("林默");
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "反向细纲.txt"), "utf8")).toContain("第一章");
  });

  it("runs continue_disassemble locally and writes 拆书细纲 into a fresh book directory", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "第001章：宗门初见\n- 林默初入宗门，感受等级压迫。"
      }
    });

    const request = {
      conversation_id: "",
      content: "继续拆细纲",
      current_path: "",
      selection: "第一章：林默入宗门。\n第二章：外门立足。",
      project_context_hint: "",
      skill_id: "continue_disassemble",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);
    const book = result.skill_result?.data?.book as { dir?: string } | undefined;

    expect(result.intent).toBe("skill");
    expect(book?.dir).toContain("00_设定集/拆书库/");
    expect(result.saved_paths).toEqual([`${book?.dir}/拆书细纲.txt`]);
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "拆书细纲.txt"), "utf8")).toContain("第001章");
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "拆书细纲.txt"), "utf8")).toContain("第001章");
  });

  it("lists disassemble books from the book library", async () => {
    const bookDir = path.join(tempDir, "00_设定集", "拆书库", "书A-20260609120000-abcd1234");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "manifest.jsonl"),
      JSON.stringify({
        id: "书A-20260609120000-abcd1234",
        title: "书A",
        dir: "00_设定集/拆书库/书A-20260609120000-abcd1234",
        created_at: "2026-06-09T12:00:00.000Z",
        updated_at: "2026-06-09T12:00:00.000Z",
        origin: "document",
        source_path: "01_大纲/大纲.txt",
        source_summary: "测试书A",
        chars: 12,
        paths: { source: "00_设定集/拆书库/书A-20260609120000-abcd1234/原文.txt" }
      }) + "\n",
      "utf8"
    );
    await fs.writeFile(path.join(bookDir, "原文.txt"), "测试原文A", "utf8");

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: { requestCompletion: async () => "unused" }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "disassemble_book",
      attachment_ids: [],
      action: "list_library"
    } as any);

    expect(result.skill_result?.data?.books).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "书A-20260609120000-abcd1234",
          title: "书A",
          dir: "00_设定集/拆书库/书A-20260609120000-abcd1234"
        })
      ])
    );
  });

  it("archives uploaded text into a fresh disassemble book directory", async () => {
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "归档测试" });
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: { requestCompletion: async () => "unused" }
    });

    const attachment = await conversations.addAttachment(
      conversation.id,
      "book.txt",
      "text/plain",
      Buffer.from("上传的拆书原文", "utf8")
    );

    const result = await runtime.runAgent({
      conversation_id: conversation.id,
      content: "归档上传文件",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "disassemble_book",
      attachment_ids: [attachment.id],
      action: "archive_source",
      book_title: "上传书籍"
    } as any);

    const book = result.skill_result?.data?.book as { dir?: string; title?: string } | undefined;
    expect(book?.title).toBe("上传书籍");
    expect(book?.dir).toContain("00_设定集/拆书库/");
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "原文.txt"), "utf8")).toContain("上传的拆书原文");
  });

  it("rejects book fusion with fewer than three books", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: { requestCompletion: async () => "unused" }
    });

    await expect(
      runtime.runAgent({
        conversation_id: "",
        content: "融梗",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "book_fusion",
        attachment_ids: [],
        source_book_ids: ["a", "b"]
      } as any)
    ).rejects.toThrow("融梗至少需要选择三本已拆书籍");
  });

  it("writes fusion candidates into the fusion library when three books are selected", async () => {
    for (const index of [1, 2, 3]) {
      const bookDir = path.join(tempDir, "00_设定集", "拆书库", `书${index}-2026060912000${index}-abcd123${index}`);
      await fs.mkdir(bookDir, { recursive: true });
      await fs.writeFile(
        path.join(bookDir, "manifest.jsonl"),
        JSON.stringify({
          id: `书${index}-2026060912000${index}-abcd123${index}`,
          title: `书${index}`,
          dir: `00_设定集/拆书库/书${index}-2026060912000${index}-abcd123${index}`,
          created_at: `2026-06-09T12:00:0${index}.000Z`,
          updated_at: `2026-06-09T12:00:0${index}.000Z`,
          origin: "document",
          source_path: `00_设定集/拆书库/书${index}/原文.txt`,
          source_summary: `测试书${index}`,
          chars: 12,
          paths: {
            source: `00_设定集/拆书库/书${index}-2026060912000${index}-abcd123${index}/原文.txt`,
            lore: `00_设定集/拆书库/书${index}-2026060912000${index}-abcd123${index}/拆书设定提取.txt`,
            reverse_outline: `00_设定集/拆书库/书${index}-2026060912000${index}-abcd123${index}/反向细纲.txt`,
            detail_outline: `00_设定集/拆书库/书${index}-2026060912000${index}-abcd123${index}/拆书细纲.txt`
          }
        }) + "\n",
        "utf8"
      );
      await fs.writeFile(path.join(bookDir, "原文.txt"), `原文${index}`, "utf8");
      await fs.writeFile(path.join(bookDir, "拆书设定提取.txt"), `设定${index}`, "utf8");
      await fs.writeFile(path.join(bookDir, "反向细纲.txt"), `反向细纲${index}`, "utf8");
      await fs.writeFile(path.join(bookDir, "拆书细纲.txt"), `拆书细纲${index}`, "utf8");
    }

    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          expect(messages.at(-1)?.content).toContain("【待融合书籍资料】");
          expect(messages.at(-1)?.content).toContain("当前题材库");
          return "融合候选方案";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "book_fusion",
      attachment_ids: [],
      source_book_ids: [
        "书1-20260609120001-abcd1231",
        "书2-20260609120002-abcd1232",
        "书3-20260609120003-abcd1233"
      ],
      custom_prompt: "保留升级节奏",
      genre_hint: "东方玄幻",
      output_mode: "candidate"
    } as any);

    const saved = result.skill_result?.data?.saved_paths as string[] | undefined;
    expect(result.intent).toBe("skill");
    expect(saved?.[0]).toMatch(/^00_设定集\/融梗方案\/.+\/融梗候选\.txt$/);
    expect(saved?.[1]).toMatch(/^00_设定集\/融梗方案\/.+\/融梗提示词\.txt$/);
    expect(saved?.[2]).toMatch(/^00_设定集\/融梗方案\/.+\/来源书籍\.jsonl$/);
    expect(saved?.[3]).toMatch(/^00_设定集\/融梗方案\/.+\/manifest\.jsonl$/);
    expect(await fs.readFile(path.join(tempDir, saved?.[0] || ""), "utf8")).toContain("融合候选方案");
    expect(await fs.readFile(path.join(tempDir, saved?.[1] || ""), "utf8")).toContain("保留升级节奏");
  });

  it("runs scan_pits locally and writes ledger items", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "- 林默答应三个月后回宗门复命\n- 黑石戒来源成谜"
      }
    });

    const request = {
      conversation_id: "",
      content: "扫描伏笔",
      current_path: "",
      selection: "林默留下黑石戒的线索，并与宗门约定三月后归来。",
      project_context_hint: "",
      skill_id: "scan_pits",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.reply).toBe("伏笔账本已更新");
    const ledgerPath = path.join(tempDir, "00_设定集", ".agent", "ledger.json");
    const ledgerRaw = await fs.readFile(ledgerPath, "utf8");
    expect(ledgerRaw).toContain("林默答应三个月后回宗门复命");
    expect(ledgerRaw).toContain("黑石戒来源成谜");
  });

  it("runs consistency_check locally and returns score risks reason json", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => JSON.stringify({ score: 82, risks: ["人物动机略弱", "章纲钩子不够清晰"], reason: "整体连续性基本成立" })
      }
    });

    const request = {
      conversation_id: "",
      content: "做一次一致性检查",
      current_path: "",
      selection: "林默在宗门大比前突然改变了原定策略。",
      project_context_hint: "第001章：宗门大比前夜",
      skill_id: "consistency_check",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.skill_result?.data).toMatchObject({
      score: 82,
      risks: ["人物动机略弱", "章纲钩子不够清晰"],
      reason: "整体连续性基本成立",
      model_line: "primary-fallback"
    });
    expect(result.reply).toContain('"score": 82');
  });

  it("runs body_generate locally and returns pending-save metadata by default", async () => {
    const responses = [
      "林默推开山门，晨雾顺着石阶往下淌。",
      JSON.stringify({ score: 78, risks: ["承接略弱"], reason: "需要加强上一章过渡" }),
      "【修正后正文】\n林默推开山门，晨雾顺着石阶往下淌，他深深吸了一口气。\n【修正原因日志】\n增强了上一章的过渡",
      "林默推开山门，晨雾顺着石阶往下淌，肩上的旧包裹被山风掀起一角。"
    ];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    const request = {
      conversation_id: "",
      content: "生成第1章正文，约2500字",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "body_generate",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.saved_paths).toEqual([]);
    expect(result.skill_result?.data).toMatchObject({
      skill_id: "body_generate",
      chapter: 1,
      target_path: "02_正文/第001章.txt",
      pending_save: true,
      score: 78,
      risks: ["承接略弱"],
      revised: true,
      deslopped: true
    });
  });

  it("injects web search material into body_generate prompts when explicitly requested", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        api_key: "demo-key",
        model: "demo-model",
        web_search_enabled: true,
        web_search_api_key: "workflow-secret"
      }),
      "utf8"
    );
    const responses = ["林默走进县城，市声扑面而来。", JSON.stringify({ score: 90, risks: [], reason: "通过" }), "林默走进县城，市声扑面而来。"];
    let firstPrompt = "";
    let searchCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async (query) => {
          searchCalls += 1;
          expect(query).toContain("唐代县城");
          return [
            {
              title: "唐代县城与市集",
              url: "https://example.test/tang-market",
              snippet: "县城坊巷、市集和县衙日常可作为场景素材。"
            }
          ];
        }
      },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          if (!firstPrompt) {
            firstPrompt = messages.at(-1)?.content || "";
          }
          return responses.shift() || "";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "生成第1章正文，联网搜索唐代县城生活资料作为素材",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "body_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(searchCalls).toBe(1);
    expect(firstPrompt).toContain("【联网搜索小说素材】");
    expect(firstPrompt).toContain("唐代县城与市集");
    expect(firstPrompt).toContain("https://example.test/tang-market");
    expect(firstPrompt).toContain("【题材正文规则】");
    expect(firstPrompt).toContain("【风格库调用规则】");
    expect(firstPrompt).not.toContain("workflow-secret");
    expect(result.web_search_sources).toEqual([{ title: "唐代县城与市集", url: "https://example.test/tang-market" }]);
    expect(result.skill_result?.data?.web_search_sources).toEqual([{ title: "唐代县城与市集", url: "https://example.test/tang-market" }]);
    expect(result.conversation?.messages.at(-1)?.metadata.web_search_sources).toEqual([{ title: "唐代县城与市集", url: "https://example.test/tang-market" }]);
    expect(JSON.stringify(result.web_search_sources)).not.toContain("县城坊巷");
  });

  it("does not search during body_generate without explicit online-material intent", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const responses = ["林默推开山门。", JSON.stringify({ score: 90, risks: [], reason: "通过" }), "林默推开山门。"];
    let searchCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          searchCalls += 1;
          return [];
        }
      },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    await runtime.runAgent({
      conversation_id: "",
      content: "生成第1章正文，约2500字",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "body_generate",
      attachment_ids: []
    });

    expect(searchCalls).toBe(0);
  });

  it("continues body_generate when workflow web search fails", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const responses = ["林默走进赛博城市。", JSON.stringify({ score: 90, risks: [], reason: "通过" }), "林默走进赛博城市。"];
    let completionCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          throw new Error("search failed");
        }
      },
      modelClient: {
        requestCompletion: async () => {
          completionCalls += 1;
          return responses.shift() || "";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "生成第1章正文，联网搜索赛博朋克城市素材",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "body_generate",
      attachment_ids: []
    });

    expect(completionCalls).toBeGreaterThan(0);
    expect(result.skill_result?.data).toMatchObject({ pending_save: true, chapter: 1 });
  });

  it("writes body_generate output to chapter file when the user asks to save", async () => {
    const responses = [
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡。",
      JSON.stringify({ score: 85, risks: [], reason: "整体稳定" }),
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡，指尖不自觉攥紧了衣角。"
    ];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "生成第1章正文并写入文件",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "body_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(result.saved_paths).toEqual(["02_正文/第001章.txt"]);
    expect(result.skill_result?.data).toMatchObject({
      score: 85,
      risks: [],
      deslopped: true
    });
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第001章.txt"), "utf8")).toContain("林默沿着石阶一步步向上");
  });

  it("runs batch_generate locally and writes multiple chapter files", async () => {
    const responses = [
      "第001章正文：林默初入宗门。",
      JSON.stringify({ score: 80, risks: [], reason: "通过" }),
      "第001章正文：林默初入宗门，山门晨钟正响。",
      "第002章正文：外门试炼开启。"
      ,
      JSON.stringify({ score: 81, risks: [], reason: "通过" }),
      "第002章正文：外门试炼开启，山道上尘土飞扬。"
    ];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    const request = {
      conversation_id: "",
      content: "生成第1章到第2章正文并写入文件",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "batch_generate",
      attachment_ids: []
    };

    expect(await runtime.canRunAgentLocally(request)).toBe(true);
    const result = await runtime.runAgent(request);

    expect(result.intent).toBe("skill");
    expect(result.saved_paths).toEqual(["02_正文/第001章.txt", "02_正文/第002章.txt"]);
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第001章.txt"), "utf8")).toContain("第001章正文");
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第002章.txt"), "utf8")).toContain("第002章正文");
  });

  it("uses the body web search path for each batch_generate chapter", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    const responses = [
      "第001章正文：林默进入县城。",
      JSON.stringify({ score: 90, risks: [], reason: "通过" }),
      "第001章正文：林默进入县城。",
      "第002章正文：林默夜探市集。",
      JSON.stringify({ score: 91, risks: [], reason: "通过" }),
      "第002章正文：林默夜探市集。"
    ];
    const bodyPrompts: string[] = [];
    let searchCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          searchCalls += 1;
          return [
            {
              title: "古代县城市集资料",
              url: "https://example.test/market",
              snippet: "夜市、坊巷和县衙可作为章节场景参考。"
            }
          ];
        }
      },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          const prompt = messages.at(-1)?.content || "";
          if (prompt.includes("请生成第") && prompt.includes("【联网搜索小说素材】")) {
            bodyPrompts.push(prompt);
          }
          return responses.shift() || "";
        }
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "生成第1章到第2章正文并写入文件，联网搜索古代县城市集资料",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "batch_generate",
      attachment_ids: []
    });

    expect(result.intent).toBe("skill");
    expect(searchCalls).toBe(2);
    expect(bodyPrompts).toHaveLength(2);
    expect(bodyPrompts.every((prompt) => prompt.includes("古代县城市集资料"))).toBe(true);
    expect(result.web_search_sources).toEqual([{ title: "古代县城市集资料", url: "https://example.test/market" }]);
    expect(result.skill_result?.data?.web_search_sources).toEqual([{ title: "古代县城市集资料", url: "https://example.test/market" }]);
    expect((result.skill_result?.data?.results as any[]).every((item) => item.web_search_sources?.[0]?.url === "https://example.test/market")).toBe(true);
    expect(result.conversation?.messages.at(-1)?.metadata.web_search_sources).toEqual([{ title: "古代县城市集资料", url: "https://example.test/market" }]);
    expect(result.saved_paths).toEqual(["02_正文/第001章.txt", "02_正文/第002章.txt"]);
  });

  it("can run body_generate workflow skill directly via runSkill", async () => {
    const responses = [
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡。",
      JSON.stringify({ score: 88, risks: [], reason: "完美" }),
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡，指尖不自觉攥紧了衣角。"
    ];
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => responses.shift() || ""
      }
    });

    const request = {
      text: "",
      chapter: 1,
      end_chapter: 0,
      target_words: 3000,
      instruction: "生成正文并保存",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    };

    expect(await runtime.canRunSkillLocally("body_generate")).toBe(true);
    const result = await runtime.runSkill("body_generate", request);

    expect(result.status).toBe("done");
    expect(result.saved_path).toBe("02_正文/第001章.txt");
    expect(result.data).toMatchObject({
      chapter: 1,
      score: 88
    });
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第001章.txt"), "utf8")).toContain("林默沿着石阶一步步向上");
  });

  it("generates card draw candidates and writes manifest successfully", async () => {
    let callCount = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => {
          callCount += 1;
          return `抽卡正文候选内容_${callCount}`;
        }
      }
    });

    const request = {
      mode: "body" as const,
      instruction: "生成三个不同的开头",
      chapter: 1,
      start_chapter: 1,
      chapter_count: 1,
      section_words: 300,
      target_words: 500,
      target_path: "",
      source_path: "",
      text: "",
      candidate_count: 3
    };

    const progressCalls: Array<{ v: number; m: string }> = [];
    const result = await runtime.generateCardDraw(request, (v, m) => {
      progressCalls.push({ v, m });
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.mode).toBe("body");
    expect(result.target_path).toBe("02_正文/第001章.txt");
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls.at(-1)?.v).toBe(1.0);

    const candidatePath = path.join(tempDir, "00_设定集", "抽卡候选", result.draw_id, "候选01.txt");
    expect(await fs.readFile(candidatePath, "utf8")).toContain("抽卡正文候选内容");

    const manifestPath = path.join(tempDir, "00_设定集", ".agent", "card_draw", `${result.draw_id}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(manifest.draw_id).toBe(result.draw_id);
    expect(manifest.candidates).toHaveLength(3);
  });

  it("injects web search material into body card draw candidates when requested", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model", web_search_enabled: true }), "utf8");
    let firstPrompt = "";
    let searchCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      webSearchClient: {
        search: async () => {
          searchCalls += 1;
          return [
            {
              title: "地下城生态参考",
              url: "https://example.test/dungeon",
              snippet: "潮湿通道、补给点和怪物巢穴可作为场景参考。"
            }
          ];
        }
      },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          if (!firstPrompt) {
            firstPrompt = messages.at(-1)?.content || "";
          }
          return firstPrompt ? "候选正文去味" : "候选正文";
        }
      }
    });

    const progressCalls: Array<{ v: number; m: string }> = [];
    const result = await runtime.generateCardDraw(
      {
        mode: "body" as const,
        instruction: "联网搜索地下城生态资料，生成一个更真实的开头",
        chapter: 1,
        start_chapter: 1,
        chapter_count: 1,
        section_words: 300,
        target_words: 500,
        target_path: "",
        source_path: "",
        text: "",
        candidate_count: 1
      },
      (v, m) => progressCalls.push({ v, m })
    );

    expect(searchCalls).toBe(1);
    expect(firstPrompt).toContain("【联网搜索小说素材】");
    expect(firstPrompt).toContain("地下城生态参考");
    expect(result.candidates).toHaveLength(1);
    expect((result as any).web_search_sources).toEqual([{ title: "地下城生态参考", url: "https://example.test/dungeon" }]);
    const candidateText = await fs.readFile(path.join(tempDir, result.candidates[0]!.path), "utf8");
    expect(candidateText).not.toContain("地下城生态参考");
    expect(candidateText).not.toContain("https://example.test/dungeon");
    const manifestPath = path.join(tempDir, "00_设定集", ".agent", "card_draw", `${result.draw_id}.json`);
    const manifestRaw = await fs.readFile(manifestPath, "utf8");
    expect(manifestRaw).not.toContain("web_search_sources");
    expect(manifestRaw).not.toContain("潮湿通道");
    expect(progressCalls.at(-1)?.v).toBe(1.0);
  });

  it("selects a card draw candidate, writes it to target and archives others", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath }
    });

    const drawId = "abcd1234";
    const drawDir = path.join(tempDir, "00_设定集", "抽卡候选", drawId);
    await fs.mkdir(drawDir, { recursive: true });
    await fs.writeFile(path.join(drawDir, "候选01.txt"), "选中了候选一的内容", "utf8");
    await fs.writeFile(path.join(drawDir, "候选02.txt"), "这是落选的候选二内容", "utf8");

    const manifest = {
      draw_id: drawId,
      mode: "body",
      target_path: "02_正文/第001章.txt",
      candidates: [
        { id: "candidate_01", path: `00_设定集/抽卡候选/${drawId}/候选01.txt`, chars: 10, excerpt: "选中了候选一" },
        { id: "candidate_02", path: `00_设定集/抽卡候选/${drawId}/候选02.txt`, chars: 10, excerpt: "落选的候选二" }
      ]
    };
    const manifestPath = path.join(tempDir, "00_设定集", ".agent", "card_draw", `${drawId}.json`);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const selectResult = await runtime.selectCardDraw(drawId, {
      candidate_id: "candidate_01",
      target_path: ""
    }) as any;

    expect(selectResult.ok).toBe(true);
    expect(selectResult.selected_id).toBe("candidate_01");
    expect(selectResult.target_path).toBe("02_正文/第001章.txt");

    expect(await fs.readFile(path.join(tempDir, "02_正文", "第001章.txt"), "utf8")).toBe("选中了候选一的内容");

    const trashDir = path.join(tempDir, "99_回收站");
    const trashFiles = await fs.readdir(trashDir);
    expect(trashFiles.length).toBeGreaterThan(0);

    const updatedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(updatedManifest.selected_id).toBe("candidate_01");
    expect(updatedManifest.archived_paths.length).toBe(1);
  });
});
