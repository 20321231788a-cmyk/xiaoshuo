import { describe, expect, it } from "vitest";
import {
  describeActionableError,
  describeGeneratedSaveAction,
  describeGeneratedSaveReason,
  describeGeneratedWriteIntent,
  describeJobKind,
  describeJobStarted,
  describeSavedGeneratedResult,
  describePendingGeneratedTarget,
  describeStoppedConversationResponse,
  describeUnsavedWorkbenchState,
  extractJobResultFiles,
  extractPathsFromUnknownResult,
  messageRequiresActiveDocument,
  pendingSaveFromSkill,
  pendingGeneratedTargetPaths,
  resolveAssistantReply,
  sanitizeWebSearchSources,
  skillRequiresActiveDocument,
  summarizeJobResult,
  summarizeOperationResults
} from "./workflow.js";

describe("workflow helpers", () => {
  it("describes actionable errors with next steps", () => {
    expect(describeActionableError(new Error("模型未配置"), "发送失败", "请先到配置页补齐模型设置")).toBe(
      "模型未配置。请先到配置页补齐模型设置"
    );
    expect(describeActionableError("bad", "启动任务失败", "请刷新任务列表后重试")).toBe("启动任务失败。请刷新任务列表后重试");
    expect(describeActionableError(new Error("保存失败。请检查目标文档"), "保存失败", "请检查目标文档")).toBe("保存失败。请检查目标文档");
    expect(describeActionableError(new Error("尚未打开项目"), "打开文档失败")).toBe("尚未打开项目。请先到项目页打开或创建项目。");
    expect(describeActionableError(new Error("未配置主线路 API Key 或模型名。"), "发送失败")).toBe(
      "未配置主线路 API Key 或模型名。请先到配置页检查模型和 API Key。"
    );
    expect(describeActionableError(new Error("ENOENT: 项目目录不存在"), "打开项目失败")).toBe(
      "ENOENT: 项目目录不存在。请确认路径存在并且当前账号有读写权限。"
    );
    expect(describeActionableError(new Error("EACCES: permission denied"), "保存失败")).toBe(
      "EACCES: permission denied。请确认当前账号有该目录的读写权限，必要时换一个项目目录。"
    );
    expect(describeActionableError(new Error("Embedding provider failed"), "重建向量索引失败")).toBe(
      "Embedding provider failed。请先到配置页检查向量和 Embedding 设置，再重试。"
    );
    expect(describeActionableError(new Error("License request failed"), "授权刷新失败")).toBe(
      "License request failed。请检查授权状态或稍后重新刷新。"
    );
  });

  it("extracts pending generated saves from skill responses", () => {
    const pending = pendingSaveFromSkill({
      status: "done",
      result: "内容",
      saved_path: "",
      data: {
        pending_save: true,
        skill_id: "lore_extract",
        cache_id: "cache_1",
        target_path: "03_设定/人物设定.txt"
      }
    });

    expect(pending?.targetPath).toBe("03_设定/人物设定.txt");
    expect(pending?.cacheId).toBe("cache_1");
  });

  it("preserves AI save plan metadata on pending generated saves", () => {
    const pending = pendingSaveFromSkill({
      status: "done",
      result: "正文",
      saved_path: "",
      data: {
        pending_save: true,
        skill_id: "body_generate",
        cache_id: "cache_2",
        target_path: "02_正文/第001章.txt",
        save_plan: {
          action: "replace_existing",
          mode: "replace",
          target_paths: ["02_正文/第001章.txt"],
          reason: "AI 判断这是第 1 章正文。",
          confidence: 0.8,
          requires_confirmation: true,
          should_auto_commit: false
        }
      }
    });

    expect(pending?.savePlan?.target_paths).toEqual(["02_正文/第001章.txt"]);
    expect(describeGeneratedSaveReason(pending!)).toBe("AI 判断这是第 1 章正文。 · 置信度 80%");
  });

  it("summarizes operation results in plain language", () => {
    expect(
      summarizeOperationResults([
        { action: "replace_text", path: "01_大纲/章纲.txt", ok: true, message: "替换 1 处" }
      ])
    ).toContain("完成");
  });

  it("extracts changed paths from job results", () => {
    expect(
      extractPathsFromUnknownResult({
        saved_paths: ["02_正文/第001章.txt"],
        target_path: "ignored"
      })
    ).toContain("02_正文/第001章.txt");
  });

  it("extracts nested job result files with source labels", () => {
    expect(
      extractJobResultFiles({
        result: {
          files: [
            { path: "02_正文/第001章.txt" },
            { saved_path: "02_正文/第002章.txt" }
          ],
          nested: {
            archived_paths: ["00_归档/旧章.txt"],
            output_path: "00_设定集/报告.txt"
          }
        },
        saved_paths: ["02_正文/第001章.txt"]
      })
    ).toEqual([
      { path: "02_正文/第001章.txt", source: "saved" },
      { path: "02_正文/第002章.txt", source: "saved" },
      { path: "00_归档/旧章.txt", source: "archived" },
      { path: "00_设定集/报告.txt", source: "output" }
    ]);
  });

  it("summarizes structured and falsey job results", () => {
    expect(
      summarizeJobResult({
        saved_paths: ["02_正文/第001章.txt"],
        archived_paths: ["00_归档/旧章.txt"],
        count: 2
      })
    ).toEqual({
      typeLabel: "结构化结果",
      primary: "3 个字段",
      detail: "1 个写入文件，1 个归档文件"
    });

    expect(summarizeJobResult(false)).toEqual({
      typeLabel: "基础结果",
      primary: "false",
      detail: "未识别到可直接打开的文件"
    });

    expect(summarizeJobResult("")).toEqual({
      typeLabel: "文本结果",
      primary: "空文本",
      detail: "未识别到可直接打开的文件"
    });

    expect(summarizeJobResult(0)).toEqual({
      typeLabel: "基础结果",
      primary: "0",
      detail: "未识别到可直接打开的文件"
    });

    expect(summarizeJobResult([])).toEqual({
      typeLabel: "数组结果",
      primary: "0 项",
      detail: "未识别到可直接打开的文件"
    });
  });

  it("sanitizes web search sources for display", () => {
    const sources = sanitizeWebSearchSources([
      {
        title: " 宋代市井参考 ",
        url: "https://example.test/song-market#section",
        snippet: "不应该展示",
        api_key: "secret"
      },
      { title: "无效协议", url: "ftp://example.test/file" },
      { title: "畸形 URL", url: "not a url" },
      { title: "", url: "https://example.test/empty-title" },
      { title: "敏感 query", url: "https://example.test/page?api_key=secret" },
      { title: "用户信息", url: "https://user:pass@example.test/private" },
      { title: "唐代县城", url: "http://example.test/tang-town?from=search" },
      { title: "重复", url: "http://example.test/tang-town?from=search" }
    ]);

    expect(sources).toEqual([
      { title: "宋代市井参考", url: "https://example.test/song-market" },
      { title: "唐代县城", url: "http://example.test/tang-town?from=search" }
    ]);
    expect(JSON.stringify(sources)).not.toContain("snippet");
    expect(JSON.stringify(sources)).not.toContain("secret");
  });

  it("limits web search sources", () => {
    const sources = sanitizeWebSearchSources(
      Array.from({ length: 8 }, (_, index) => ({
        title: `来源 ${index}`,
        url: `https://example.test/${index}`
      }))
    );

    expect(sources).toHaveLength(5);
    expect(sources.at(-1)?.url).toBe("https://example.test/4");
    expect(sanitizeWebSearchSources("bad")).toEqual([]);
  });

  it("describes job kinds in user-facing language", () => {
    expect(describeJobKind("scan_project")).toBe("扫描项目文件");
    expect(describeJobKind("build_continuity_context")).toBe("构建连续上下文");
    expect(describeJobKind("custom_kind")).toBe("custom_kind");
    expect(describeJobStarted("scan_project")).toBe("已启动任务：扫描项目文件");
  });

  it("detects skills that need an active document", () => {
    expect(
      skillRequiresActiveDocument({
        input_mode: "text",
        handler_type: "prompt",
        context_requirements: []
      })
    ).toBe(true);
    expect(skillRequiresActiveDocument(null)).toBe(false);
    expect(
      skillRequiresActiveDocument({
        input_mode: "none",
        handler_type: "job",
        context_requirements: ["project_state"]
      })
    ).toBe(false);
  });

  it("detects chat messages that likely need the active document", () => {
    expect(messageRequiresActiveDocument("继续写这一章")).toBe(true);
    expect(messageRequiresActiveDocument("帮我润色当前文档")).toBe(true);
    expect(messageRequiresActiveDocument("聊聊主角动机")).toBe(false);
  });

  it("prefers final skill text when stream text differs", () => {
    expect(
      resolveAssistantReply(
        {
          intent: "skill",
          reply: "",
          results: [],
          saved_paths: [],
          requires_confirmation: false,
          skill_result: {
            status: "done",
            result: "最终答案",
            saved_path: "",
            data: {}
          }
        },
        "流式片段"
      )
    ).toBe("最终答案");
  });

  it("describes stopped conversation responses by whether partial text exists", () => {
    expect(describeStoppedConversationResponse("流式片段")).toContain("保留的是未完成回复");
    expect(describeStoppedConversationResponse("")).toContain("尚未收到可保留的回复");
  });

  it("describes generated write-back results with target paths", () => {
    expect(
      describeSavedGeneratedResult(
        { skillId: "body_generate", targetPath: "02_正文/第001章.txt" },
        "append",
        ["02_正文/第001章.txt"]
      )
    ).toBe("已追加保存到 02_正文/第001章.txt，目标文档已刷新。");

    expect(
      describeSavedGeneratedResult(
        { skillId: "lore_extract", targetPath: "03_设定/人物设定.txt" },
        "replace",
        ["03_设定/人物设定.txt", "03_设定/世界观.txt"]
      )
    ).toBe("已整合保存到 03_设定/人物设定.txt 等 2 个文件，目标文档已刷新。");

    expect(describeSavedGeneratedResult({ skillId: "body_generate", targetPath: "" }, "replace", [])).toContain("请在项目树中确认目标文件");
  });

  it("marks the default generated save action as recommended", () => {
    expect(describeGeneratedSaveAction("append", "append")).toBe("追加保存（推荐）");
    expect(describeGeneratedSaveAction("replace", "append")).toBe("覆盖保存");
    expect(describeGeneratedSaveAction("replace", "replace")).toBe("覆盖保存（推荐）");
    expect(describeGeneratedSaveAction("replace", "replace", 3)).toBe("覆盖保存 3 个文件（推荐）");
    expect(describeGeneratedSaveAction("replace", "replace", 2, "lore_extract")).toBe("整合写入设定 2 个文件（推荐）");
    expect(describeGeneratedSaveAction("replace", "replace", 1, "genre_generate")).toBe("写入题材资料（推荐）");
  });

  it("describes generated write intent before saving", () => {
    expect(
      describeGeneratedWriteIntent({
        skillId: "lore_extract",
        targetPath: "03_设定/人物设定.txt",
        targetPaths: ["03_设定/人物设定.txt", "03_设定/世界观.txt"]
      })
    ).toContain("按设定段落整合写入");
    expect(
      describeGeneratedWriteIntent({
        skillId: "body_generate",
        targetPath: "02_正文/第001章.txt",
        targetPaths: ["02_正文/第001章.txt", "02_正文/第002章.txt"]
      })
    ).toContain("同一份生成内容写入 2 个目标文件");
    expect(
      describeGeneratedWriteIntent({
        skillId: "genre_generate",
        targetPath: "",
        targetPaths: []
      })
    ).toContain("当前预览内容写入目标文件");
  });

  it("describes pending generated targets including multi-file writes", () => {
    expect(describePendingGeneratedTarget({ targetPath: "03_设定/人物设定.txt", targetPaths: [] })).toBe("03_设定/人物设定.txt");
    expect(
      describePendingGeneratedTarget({
        targetPath: "03_设定/人物设定.txt",
        targetPaths: ["03_设定/人物设定.txt", "03_设定/世界观.txt"]
      })
    ).toBe("03_设定/人物设定.txt 等 2 个文件");
    expect(
      pendingGeneratedTargetPaths({
        targetPath: "ignored.txt",
        targetPaths: ["03_设定/人物设定.txt", " ", "03_设定/人物设定.txt", "03_设定/世界观.txt"]
      })
    ).toEqual(["03_设定/人物设定.txt", "03_设定/世界观.txt"]);
  });

  it("describes unsaved workbench state for project switch guards", () => {
    const state = describeUnsavedWorkbenchState({
      dirtyDocumentCount: 2,
      hasConversationDraft: true,
      hasPendingGeneratedSave: true
    });

    expect(state.hasUnsavedState).toBe(true);
    expect(state.summary).toContain("2 个文档草稿未保存");
    expect(state.summary).toContain("会话输入框里还有草稿");
    expect(state.summary).toContain("待选择写入方式的生成结果");
  });
});
