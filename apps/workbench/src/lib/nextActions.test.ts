import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "./dashboard.js";
import { deriveWorkbenchNextActions, pendingGeneratedCachesForCurrentProject } from "./nextActions.js";

describe("deriveWorkbenchNextActions", () => {
  it("prioritizes opening a project and configuring the main model", () => {
    const actions = deriveWorkbenchNextActions(makeSnapshot());

    expect(actions[0]).toMatchObject({ title: "打开或创建小说项目", targetTab: "project", priority: "high" });
    expect(actions.some((action) => action.title === "补齐主线路模型配置")).toBe(true);
  });

  it("surfaces pending generated caches and failed jobs", () => {
    const actions = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model" },
        generatedCacheCount: 2,
        failedJobCount: 1
      })
    );

    expect(actions.map((action) => action.title)).toContain("处理待写入生成结果");
    expect(actions.find((action) => action.title === "处理待写入生成结果")?.targetTab).toBe("overview");
    expect(actions.map((action) => action.title)).toContain("查看失败任务");
  });

  it("counts only current-project pending generated caches for next actions", () => {
    const snapshot = makeSnapshot({
      currentProject: { path: "D:\\novel-a", name: "novel-a" },
      config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model" },
      generatedCacheCount: 0,
      generatedCaches: [
        makeGeneratedCache("cache-a", "D:\\novel-a"),
        makeGeneratedCache("cache-b", "D:\\novel-b"),
        makeGeneratedCache("cache-legacy", "")
      ]
    });

    const pendingCaches = pendingGeneratedCachesForCurrentProject(snapshot);
    const actions = deriveWorkbenchNextActions(snapshot);

    expect(pendingCaches.map((cache) => cache.cache_id)).toEqual(["cache-a", "cache-legacy"]);
    expect(actions.find((action) => action.title === "处理待写入生成结果")?.detail).toContain("2 条");
  });

  it("does not surface other-project pending generated caches", () => {
    const actions = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel-a", name: "novel-a" },
        config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model" },
        licensed: true,
        hasTree: true,
        hasConversation: true,
        generatedCacheCount: 0,
        generatedCaches: [makeGeneratedCache("cache-b", "D:\\novel-b")]
      })
    );

    expect(actions.map((action) => action.title)).not.toContain("处理待写入生成结果");
  });

  it("suggests continuing the editor when everything is ready", () => {
    const actions = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model" },
        licensed: true,
        hasTree: true,
        hasConversation: true
      })
    );

    expect(actions).toEqual([
      {
        priority: "low",
        title: "继续编辑当前项目",
        detail: "项目和模型已经就绪，可以打开章节、运行技能或继续会话。",
        targetTab: "editor"
      }
    ]);
  });

  it("surfaces incomplete custom web search configuration", () => {
    const actions = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: {
          api_key: "key",
          base_url: "https://api.example.test/v1",
          model: "model",
          web_search_enabled: true,
          web_search_provider: "custom",
          web_search_base_url: ""
        },
        licensed: true,
        hasTree: true,
        hasConversation: true
      })
    );

    expect(actions[0]).toMatchObject({
      title: "补齐联网素材搜索配置",
      targetTab: "config",
      priority: "medium"
    });
  });

  it("does not surface web search configuration when it is closed or ready", () => {
    const closed = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model", web_search_enabled: false },
        licensed: true,
        hasTree: true,
        hasConversation: true
      })
    );
    const duckDuckGo = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: { api_key: "key", base_url: "https://api.example.test/v1", model: "model", web_search_enabled: true, web_search_provider: "duckduckgo" },
        licensed: true,
        hasTree: true,
        hasConversation: true
      })
    );
    const customReady = deriveWorkbenchNextActions(
      makeSnapshot({
        currentProject: { path: "D:\\novel", name: "novel" },
        config: {
          api_key: "key",
          base_url: "https://api.example.test/v1",
          model: "model",
          web_search_enabled: true,
          web_search_provider: "custom",
          web_search_base_url: "https://search.example.test/api"
        },
        licensed: true,
        hasTree: true,
        hasConversation: true
      })
    );

    for (const actions of [closed, duckDuckGo, customReady]) {
      expect(actions.map((action) => action.title)).not.toContain("补齐联网素材搜索配置");
    }
  });
});

function makeSnapshot(options: {
  currentProject?: { path: string; name: string };
  config?: Partial<DashboardSnapshot["config"]> & { api_key?: string; base_url?: string; model?: string };
  licensed?: boolean;
  generatedCacheCount?: number;
  failedJobCount?: number;
  hasTree?: boolean;
  hasConversation?: boolean;
  generatedCaches?: NonNullable<DashboardSnapshot["localState"]>["generated_caches"];
} = {}): DashboardSnapshot {
  const generatedCacheCount = options.generatedCacheCount ?? 0;
  const failedJobCount = options.failedJobCount ?? 0;

  return {
    fetchedAt: "2026-06-07T00:00:00.000Z",
    health: { ok: true, version: "test", machineCode: "device", deviceCode: "device" },
    license: { licensed: options.licensed ?? false, status: "test", message: "" },
    config: {
      ai_config_mode: "manual",
      api_key: options.config?.api_key ?? "",
      license_account_key: "",
      base_url: options.config?.base_url ?? "",
      model: options.config?.model ?? "",
      temp: 0.7,
      secondary_api_key: "",
      secondary_base_url: "",
      secondary_model: "",
      secondary_temp: 0.5,
      model_thinking_enabled: false,
      enable_consistency_revision: true,
      consistency_revision_score: 80,
      context_limit_chars: 262144,
      embedding_enabled: false,
      embedding_api_key: "",
      embedding_base_url: "",
      embedding_model: "",
      embedding_timeout: 60,
      embedding_batch_size: 16,
      vector_top_k: 10,
      vector_context_chars: 9000,
      web_search_enabled: false,
      web_search_provider: "duckduckgo",
      web_search_api_key: "",
      web_search_base_url: "",
      web_search_max_results: 3,
      web_search_timeout: 10,
      web_search_context_chars: 3000,
      ...options.config
    },
    currentProject: options.currentProject ?? { path: "", name: "" },
    projectChrome: {
      current: options.currentProject ?? { path: "", name: "" },
      tree: options.hasTree ? [{ path: "02_正文", name: "02_正文", kind: "directory", size: 0, updated_at: "", children: [] }] : [],
      libraries: [],
      timeline: [],
      version: 1,
      generated_at: ""
    },
    projectManifest: { ready: false, files: 0, version: 0, generated_at: "", source: "empty", path: "" },
    vectorIndex: {
      enabled: false,
      configured: false,
      db: "",
      chunks: 0,
      embedded_chunks: 0,
      current_embedded_chunks: 0,
      pending_files: 0,
      embedding_model: "",
      ready: false,
      updated_at: ""
    },
    skills: [],
    conversations: options.hasConversation
      ? [{ id: "conv", title: "会话", created_at: "", updated_at: "", current_skill: "", current_agent: "", message_count: 1, attachment_count: 0 }]
      : [],
    jobs: Array.from({ length: failedJobCount }, (_, index) => ({
      id: `job-${index}`,
      kind: "scan_project",
      status: "failed" as const,
      progress: 1,
      message: "",
      error: "failed"
    })),
    ledger: [],
    timeline: [],
    revisionLog: [],
    desktopBackend: null,
    desktopCapabilities: null,
    localState: {
      db_path: "",
      driver: "better-sqlite3",
      synced_at: "",
      settings: { active_tab: "overview", project_path_input: "", project_name_input: "", updated_at: "" },
      generated_caches: options.generatedCaches ?? Array.from({ length: generatedCacheCount }, (_, index) => makeGeneratedCache(`cache-${index}`, "D:\\novel")),
      recent_projects: []
    }
  };
}

function makeGeneratedCache(cacheId: string, projectPath: string): NonNullable<DashboardSnapshot["localState"]>["generated_caches"][number] {
  return {
    cache_id: cacheId,
    status: "pending",
    source: "skill",
    skill_id: "body_generate",
    target_path: "02_正文/第001章.txt",
    target_paths: ["02_正文/第001章.txt"],
    project_path: projectPath,
    cache_path: "",
    cache_chars: 100,
    created_at: "",
    updated_at: ""
  };
}
