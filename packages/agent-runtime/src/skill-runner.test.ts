import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { getContextBudget } from "./kernel/context-assembler.js";
import { PromptSkillRunner } from "./skill-runner.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-skill-runner-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "克制冷静", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "升级流", "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "旧大纲", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("prompt-skill-runner", () => {
  it("runs a local prompt skill and returns pending-save metadata", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "新的大纲结果"
      }
    });

    expect(await runner.canRunSkillLocally("outline_generate")).toBe(true);
    expect(await runner.canRunSkillLocally("lore_extract")).toBe(true);
    expect(await runner.canRunSkillLocally("detail_outline_generate")).toBe(true);
    expect(await runner.canRunSkillLocally("chapter_outline_generate")).toBe(true);
    expect(await runner.canRunSkillLocally("genre_generate")).toBe(true);

    const result = await runner.runSkill("outline_generate", {
      text: "一个少年踏入宗门",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.result).toBe("新的大纲结果");
    expect(result.data).toMatchObject({
      pending_save: true,
      target_path: "01_大纲/大纲.txt",
      default_mode: "replace"
    });
    expect(typeof result.data.cache_id).toBe("string");

    const cacheService = new GeneratedCacheService({ projectRoot: tempDir });
    const content = await cacheService.readContent(String(result.data.cache_id || ""));
    expect(content).toBe("新的大纲结果");
  });

  it("writes the generated result directly when write_result=true", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "可直接写入的大纲"
      }
    });

    const result = await runner.runSkill("outline_generate", {
      text: "直接生成",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    });

    expect(result.saved_path).toBe("01_大纲/大纲.txt");
    expect(result.data.saved_paths).toEqual(["01_大纲/大纲.txt"]);
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("可直接写入的大纲");
  });

  it("defers an otherwise automatic prompt-skill commit without writing its target", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "等待 journal 提交的大纲"
      }
    });

    const result = await runner.runSkill("outline_generate", {
      text: "直接生成",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    }, { deferAutoCommit: true });

    expect(result.saved_path).toBe("");
    expect(result.data).toMatchObject({
      pending_save: true,
      saved_paths: [],
      target_path: "01_大纲/大纲.txt",
      deferred_commit: {
        kind: "prompt_skill_generated_cache",
        skill_id: "outline_generate",
        mode: "replace",
        target_paths: ["01_大纲/大纲.txt"],
        source: "prompt_skill",
        requires_confirmation: false
      }
    });
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("旧大纲");

    const cacheService = new GeneratedCacheService({ projectRoot: tempDir });
    expect(await cacheService.readContent(String(result.data.cache_id || ""))).toBe("等待 journal 提交的大纲");
  });

  it("uses conversation attachments as source input when text is empty", async () => {
    let capturedPrompt = "";
    const conversations = new ConversationService({ projectRoot: tempDir });
    const conversation = await conversations.createConversation({ title: "skill attachment" });
    const attachment = await conversations.addAttachment(
      conversation.id,
      "source.txt",
      "text/plain",
      Buffer.from("附件里的剧情素材", "utf8")
    );

    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedPrompt = messages[1]?.content || "";
          return "附件分析结果";
        }
      }
    });

    const result = await runner.runSkill("style_extract", {
      text: "",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提炼风格",
      target_path: "",
      conversation_id: conversation.id,
      source_path: "",
      write_result: false,
      attachment_ids: [attachment.id]
    });

    expect(result.result).toBe("附件分析结果");
    expect(capturedPrompt).toContain("【source.txt】");
    expect(capturedPrompt).toContain("附件里的剧情素材");
    expect(capturedPrompt).toContain("【风格库调用规则】");
    expect(capturedPrompt).toContain("【题材硬约束】");
  });

  it("uses reference_paths as source input when text and attachments are empty", async () => {
    let capturedPrompt = "";
    await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "这是测试章纲", "utf8");
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedPrompt = messages[1]?.content || "";
          return "参考文件生成结果";
        }
      }
    });

    const result = await runner.runSkill("outline_generate", {
      text: "",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "根据引用文件生成",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: [],
      reference_paths: ["01_大纲/章纲.txt"]
    });

    expect(result.result).toBe("参考文件生成结果");
    expect(capturedPrompt).toContain("【参考文件：01_大纲/章纲.txt】");
    expect(capturedPrompt).toContain("这是测试章纲");
  });

  it("caps prompt-skill context with ContextAssembler while preserving prompt sections", async () => {
    let capturedPrompt = "";
    const longSource = `${"很长的输入文本。".repeat(10_000)}SOURCE_TAIL_SHOULD_BE_TRIMMED`;
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedPrompt = messages[1]?.content || "";
          return "已按长输入生成";
        }
      }
    });

    await runner.runSkill("outline_generate", {
      text: longSource,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "保留关键结构",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(capturedPrompt.length).toBeLessThanOrEqual(getContextBudget("prompt_skill"));
    expect(capturedPrompt).toContain("【Skill】");
    expect(capturedPrompt).toContain("【项目状态】");
    expect(capturedPrompt).toContain("【大纲】");
    expect(capturedPrompt).toContain("【细纲】");
    expect(capturedPrompt).toContain("【章纲】");
    expect(capturedPrompt).toContain("【输入文本】");
    expect(capturedPrompt).toContain("很长的输入文本");
    expect(capturedPrompt).toContain("【额外要求】\n保留关键结构");
    expect(capturedPrompt).not.toContain("SOURCE_TAIL_SHOULD_BE_TRIMMED");
  });

  it("returns multi-target pending-save metadata for style_extract", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【写作风格】\n风格规则\n\n【风格示例】\n示例特征\n\n【参考素材】\n素材摘要"
      }
    });

    const result = await runner.runSkill("style_extract", {
      text: "样文",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提取风格",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.data).toMatchObject({
      pending_save: true,
      target_paths: [
        "00_设定集/风格库/写作风格.txt",
        "00_设定集/风格库/风格示例.txt",
        "00_设定集/风格库/参考素材.txt"
      ]
    });
  });

  it("writes style sections into multiple target files when write_result=true", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【写作风格】\n风格规则\n\n【风格示例】\n示例特征\n\n【参考素材】\n素材摘要"
      }
    });

    const result = await runner.runSkill("style_extract", {
      text: "样文",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提取风格并写入",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    });

    expect(result.data.saved_paths).toEqual([
      "00_设定集/风格库/写作风格.txt",
      "00_设定集/风格库/风格示例.txt",
      "00_设定集/风格库/参考素材.txt"
    ]);
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "utf8")).toBe("风格规则");
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "风格库", "风格示例.txt"), "utf8")).toBe("示例特征");
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "风格库", "参考素材.txt"), "utf8")).toBe("素材摘要");
  });

  it("defers sectioned skill writes while preserving their generated save plan", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【写作风格】\n风格规则\n\n【风格示例】\n示例特征\n\n【参考素材】\n素材摘要"
      }
    });

    const result = await runner.runSkill("style_extract", {
      text: "样文",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提取风格并写入",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    }, { deferAutoCommit: true });

    expect(result.data).toMatchObject({
      pending_save: true,
      saved_paths: [],
      deferred_commit: {
        skill_id: "style_extract",
        target_paths: [
          "00_设定集/风格库/写作风格.txt",
          "00_设定集/风格库/风格示例.txt",
          "00_设定集/风格库/参考素材.txt"
        ]
      }
    });
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "utf8")).toBe("克制冷静");
    await expect(fs.access(path.join(tempDir, "00_设定集", "风格库", "风格示例.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "00_设定集", "风格库", "参考素材.txt"))).rejects.toThrow();
  });

  it("defers auto-commit after a streamed skill result", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "流式延后提交的大纲"
      }
    });
    const events = [];
    for await (const event of runner.streamSkill("outline_generate", {
      text: "流式生成",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    }, { deferAutoCommit: true })) {
      events.push(event);
    }

    const final = events.find((event) => event.type === "final");
    expect(final).toMatchObject({
      type: "final",
      payload: {
        skill_result: {
          data: {
            pending_save: true,
            deferred_commit: expect.objectContaining({ skill_id: "outline_generate" })
          }
        }
      }
    });
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("旧大纲");
  });

  it("reuses a finalized deterministic deferred cache without another model call", async () => {
    let calls = 0;
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => {
          calls += 1;
          return "确定性缓存结果";
        }
      }
    });
    const payload = {
      text: "生成大纲",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    };

    const first = await runner.runSkill("outline_generate", payload, {
      deferAutoCommit: true,
      deterministicCacheId: "11111111111111111111111111111111"
    });
    const replay = await runner.runSkill("outline_generate", payload, {
      deferAutoCommit: true,
      deterministicCacheId: "11111111111111111111111111111111"
    });

    expect(calls).toBe(1);
    expect(replay.result).toBe("确定性缓存结果");
    expect(replay.data).toMatchObject({
      cache_id: first.data.cache_id,
      pending_save: true,
      deferred_commit: expect.objectContaining({ skill_id: "outline_generate" })
    });
  });

  it("restarts an unfinished deterministic stream cache and replays a finalized one", async () => {
    const cache = new GeneratedCacheService({ projectRoot: tempDir });
    await cache.createWithId("22222222222222222222222222222222", {
      source: "skill_stream",
      skill_id: "outline_generate",
      target_paths: ["01_大纲/大纲.txt"],
      mode: "replace"
    });
    await cache.replace("22222222222222222222222222222222", "partial output");

    let calls = 0;
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => {
          calls += 1;
          return "重新开始后的完整结果";
        }
      }
    });
    const payload = {
      text: "流式生成",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    };
    const readFinal = async () => {
      const events = [];
      for await (const event of runner.streamSkill("outline_generate", payload, {
        deferAutoCommit: true,
        deterministicCacheId: "22222222222222222222222222222222"
      })) events.push(event);
      return events.find((event) => event.type === "final");
    };

    const first = await readFinal();
    const replay = await readFinal();

    expect(calls).toBe(1);
    expect(await cache.readContent("22222222222222222222222222222222")).toBe("重新开始后的完整结果");
    expect(first).toMatchObject({ type: "final", payload: { skill_result: { data: { pending_save: true } } } });
    expect(replay).toMatchObject({ type: "final", payload: { skill_result: { result: "重新开始后的完整结果" } } });
  });

  it("runs detail outline skill locally and applies default deslop cleanup", async () => {
    const calls: string[] = [];
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          calls.push(messages[0]?.content || "");
          if (calls.length === 1) {
            return "第一版细纲结果";
          }
          return "【处理后文本】\n细化后的自然细纲";
        }
      }
    });

    const result = await runner.runSkill("detail_outline_generate", {
      text: "",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "扩展成细纲",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.result).toBe("细化后的自然细纲");
    expect(calls).toHaveLength(2);
  });

  it("uses the dedicated story-deslop system prompt for story_deslop", async () => {
    let capturedSystemPrompt = "";
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedSystemPrompt = messages[0]?.content || "";
          return "去AI味后的正文";
        }
      }
    });

    const result = await runner.runSkill("story_deslop", {
      text: "他缓缓抬起头，眼中闪过一丝光。",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "去AI味",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.result).toBe("去AI味后的正文");
    expect(capturedSystemPrompt).toContain("story-deslop 去AI味编辑");
    expect(capturedSystemPrompt).toContain("只改“怎么说”，不改“说什么”");
  });

  it("returns multi-target pending-save metadata for genre_generate", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【题材规则】\n规则内容\n\n【题材素材】\n素材内容\n\n【战斗模板】\n模板内容\n\n【违禁词】\n禁词内容"
      }
    });

    const result = await runner.runSkill("genre_generate", {
      text: "玄幻升级流",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "生成题材库",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.data).toMatchObject({
      pending_save: true,
      target_paths: [
        "00_设定集/题材库/题材规则.txt",
        "00_设定集/题材库/题材素材.txt",
        "00_设定集/题材库/战斗模板.txt",
        "00_设定集/题材库/违禁词.txt"
      ]
    });
  });

  it("writes genre sections into multiple target files when write_result=true", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【题材规则】\n规则内容\n\n【题材素材】\n素材内容\n\n【战斗模板】\n模板内容\n\n【违禁词】\n禁词内容"
      }
    });

    const result = await runner.runSkill("genre_generate", {
      text: "玄幻升级流",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "生成题材库并写入",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    });

    expect(result.data.saved_paths).toEqual([
      "00_设定集/题材库/题材规则.txt",
      "00_设定集/题材库/题材素材.txt",
      "00_设定集/题材库/战斗模板.txt",
      "00_设定集/题材库/违禁词.txt"
    ]);
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "utf8")).toBe("规则内容");
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "题材库", "题材素材.txt"), "utf8")).toBe("素材内容");
  });

  it("returns multi-target pending-save metadata for lore_extract", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【人物设定】\n林默：主角，出身寒门。\n\n【体系设定】\n修炼分九境。"
      }
    });

    const result = await runner.runSkill("lore_extract", {
      text: "林默踏入宗门，开始修炼。",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提取设定",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    expect(result.data).toMatchObject({
      pending_save: true,
      target_paths: [
        "00_设定集/设定集/人物设定.txt",
        "00_设定集/设定集/体系设定.txt",
        "00_设定集/设定集/地图设定.txt",
        "00_设定集/设定集/道具设定.txt"
      ]
    });
  });

  it("merges lore sections into existing files when write_result=true", async () => {
    await fs.mkdir(path.join(tempDir, "00_设定集", "设定集"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "00_设定集", "设定集", "人物设定.txt"), "林默：主角，出身寒门。", "utf8");

    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "【人物设定】\n林默：主角，出身寒门；擅长隐忍。\n\n【体系设定】\n修炼分九境。"
      }
    });

    const result = await runner.runSkill("lore_extract", {
      text: "林默踏入宗门，开始修炼。",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "提取设定并写入",
      target_path: "",
      conversation_id: "",
      source_path: "",
      write_result: true,
      attachment_ids: []
    });

    expect(result.data.saved_paths).toContain("00_设定集/设定集/人物设定.txt");
    expect(result.data.saved_paths).toContain("00_设定集/设定集/体系设定.txt");
    const mergedLore = await fs.readFile(path.join(tempDir, "00_设定集", "设定集", "人物设定.txt"), "utf8");
    expect(mergedLore).toContain("林默：主角，出身寒门；擅长隐忍");
  });

  it("drafts a skill from a URL using AI when configured", async () => {
    let capturedPrompt = "";
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async (_config, messages) => {
          capturedPrompt = messages[1]?.content || "";
          return JSON.stringify({
            id: "drafted_skill",
            name: "起草的技能",
            description: "通过链接起草的外部技能",
            context_requirements: ["project_state"],
            linked_targets: ["01_大纲/大纲.txt"],
            prompt: "这是起草的提示词模板",
            writable: true
          });
        }
      }
    });

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("<html><body><h1>自定义小说大纲生成器</h1><p>这个技能会提取你的设定，帮你生成新的精彩大纲。</p></body></html>").buffer,
      headers: new Headers({ "content-type": "text/html" })
    } as any);

    try {
      const result = await runner.draftSkillFromUrl({
        url: "http://example.com/novel-generator",
        instruction: "帮我配置成 prompt 技能"
      });

      expect(result.skill).toMatchObject({
        id: "drafted_skill",
        name: "起草的技能",
        handler_type: "prompt",
        prompt: "这是起草的提示词模板"
      });
      expect(result.source_url).toBe("http://example.com/novel-generator");
      expect(result.source_name).toBe("web-skill-source.md");
      expect(result.source_text).toContain("自定义小说大纲生成器");
      expect(capturedPrompt).toContain("自定义小说大纲生成器");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to SKILL.md parsing when model is not configured", async () => {
    const runner = new PromptSkillRunner({
      projectRoot: tempDir,
      config: { configPath: path.join(tempDir, "empty_config.json") }
    });
    await fs.writeFile(path.join(tempDir, "empty_config.json"), "{}", "utf8");

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("---\nname: \"SKILL_TEST\"\ndescription: \"Existing metadata\"\n---\nPrompt text template inside raw markdown").buffer,
      headers: new Headers({ "content-type": "text/plain" })
    } as any);

    try {
      const result = await runner.draftSkillFromUrl({
        url: "http://example.com/SKILL.md",
        instruction: ""
      });

      expect(result.skill).toMatchObject({
        id: "skill_test",
        name: "SKILL_TEST",
        prompt: "Prompt text template inside raw markdown"
      });
      expect(result.warnings).toContain("未配置主线路模型，已按已有 SKILL.md 内容解析。");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
