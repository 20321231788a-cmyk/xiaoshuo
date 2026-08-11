import { describe, expect, it, vi } from "vitest";
import { loadDashboardSnapshot } from "./dashboard.js";
import type { WorkbenchRuntime } from "./runtime.js";

const runtime: WorkbenchRuntime = {
  apiBase: "http://127.0.0.1:18453",
  isDesktopShell: false,
  launchMode: "browser"
};

describe("loadDashboardSnapshot", () => {
  it("loads the migration dashboard snapshot from the typed api client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = resolveJson(url);
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await loadDashboardSnapshot(runtime);
    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.currentProject.name).toBe("xiaoshuo");
    expect(snapshot.projectManifest.files).toBe(11);
    expect(snapshot.vectorIndex.ready).toBe(false);
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.ledger).toHaveLength(1);
    expect(snapshot.projectChrome.tree).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("loads desktop bridge status and shell capabilities in desktop mode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = resolveJson(url);
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const backendStatus = vi.fn(async () => ({ ready: true, url: "http://127.0.0.1:18453", pid: 1234 }));
    const capabilities = vi.fn(async () => ({
      terminal: { available: true, package: "node-pty" as const },
      localDatabase: { available: true, package: "node:sqlite" as const },
      downloads: { available: true, package: "electron-dl" as const },
      contextMenu: { available: true, package: "electron-context-menu" as const },
      monitoring: { available: true, package: "@sentry/electron" as const },
      websocket: { available: true, package: "ws" as const }
    }));
    const getLocalState = vi.fn(async () => ({
      db_path: "D:\\xiaoshuo\\state\\xiaoshuo-local-state.sqlite3",
      driver: "node:sqlite" as const,
      synced_at: "2026-05-30T10:00:00.000Z",
      settings: {
        active_tab: "overview" as const,
        project_path_input: "",
        project_name_input: "",
        updated_at: "2026-05-30T10:00:00.000Z"
      },
      generated_caches: [],
      recent_projects: [
        {
          path: "D:\\xiaoshuo",
          name: "xiaoshuo",
          opened_at: "2026-05-30T10:00:00.000Z",
          conversation_count: 1,
          job_count: 1,
          last_synced_at: "2026-05-30T10:00:00.000Z"
        }
      ]
    }));
    const syncProject = vi.fn(async (request) => ({
      db_path: "D:\\xiaoshuo\\state\\xiaoshuo-local-state.sqlite3",
      driver: "node:sqlite" as const,
      synced_at: "2026-05-30T10:00:01.000Z",
      settings: {
        active_tab: "overview" as const,
        project_path_input: "",
        project_name_input: "",
        updated_at: "2026-05-30T10:00:00.000Z"
      },
      generated_caches: [],
      recent_projects: [
        {
          path: request.project.path,
          name: request.project.name,
          opened_at: request.project.opened_at,
          conversation_count: request.conversations.length,
          job_count: request.jobs.length,
          last_synced_at: "2026-05-30T10:00:01.000Z"
        }
      ]
    }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      xiaoshuoDesktop: {
        versions: vi.fn(async () => ({ electron: "42.3.0" })),
        backendStatus,
        restartBackend: vi.fn(async () => ({ ready: true, url: "http://127.0.0.1:18453" })),
        capabilities,
        localState: {
          get: getLocalState,
          recordProject: vi.fn(),
          syncProject
        },
        terminal: {
          create: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(),
          onExit: vi.fn()
        }
      }
    });

    const snapshot = await loadDashboardSnapshot({
      ...runtime,
      isDesktopShell: true,
      launchMode: "desktop"
    });

    expect(snapshot.desktopBackend?.pid).toBe(1234);
    expect(snapshot.desktopCapabilities?.terminal.available).toBe(true);
    expect(snapshot.localState?.recent_projects[0]?.name).toBe("xiaoshuo");
    expect(snapshot.localState?.recent_projects[0]?.conversation_count).toBe(0);
    expect(backendStatus).toHaveBeenCalledOnce();
    expect(capabilities).toHaveBeenCalledOnce();
    expect(getLocalState).toHaveBeenCalledOnce();
    expect(syncProject).toHaveBeenCalledOnce();
  });
});

function resolveJson(url: string): unknown {
  if (url.endsWith("/api/health")) {
    return { ok: true, version: "5.0.2", machineCode: "device", deviceCode: "device" };
  }
  if (url.endsWith("/api/license/status")) {
    return { licensed: true, status: "ok", message: "active" };
  }
  if (url.endsWith("/api/config")) {
    return {
      api_key: "",
      license_account_key: "",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
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
      embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
      embedding_model: "doubao-embedding-vision-250615",
      embedding_timeout: 60,
      embedding_batch_size: 16,
      vector_top_k: 10,
      vector_context_chars: 9000
    };
  }
  if (url.includes("/api/project/chrome")) {
    return {
      tree: [
        {
          path: "01_大纲",
          name: "01_大纲",
          kind: "directory",
          size: 0,
          updated_at: "2026-05-28T00:00:00",
          children: []
        }
      ],
      libraries: [],
      timeline: [],
      current: { path: "D:\\xiaoshuo", name: "xiaoshuo" },
      version: 1,
      generated_at: "2026-05-28T00:00:00"
    };
  }
  if (url.endsWith("/api/project/manifest/status")) {
    return {
      ready: true,
      files: 11,
      version: 4,
      generated_at: "2026-05-28 21:03:18",
      source: "scan",
      path: "D:\\xiaoshuo\\00_设定集\\.agent\\project_manifest.json"
    };
  }
  if (url.endsWith("/api/vector/status")) {
    return {
      enabled: true,
      configured: true,
      db: "D:\\xiaoshuo\\00_设定集\\.agent\\vector_index.sqlite3",
      chunks: 24,
      embedded_chunks: 12,
      current_embedded_chunks: 12,
      pending_files: 2,
      embedding_model: "doubao:model",
      ready: false,
      updated_at: "2026-05-28 21:06:00"
    };
  }
  if (url.endsWith("/api/skills")) {
    return [
      {
        id: "continuity_check",
        name: "一致性检查",
        description: "check consistency",
        input_mode: "text",
        context_requirements: [],
        handler_type: "prompt",
        linked_targets: [],
        prompt: "",
        imported_from: "",
        writable: false
      }
    ];
  }
  if (url.endsWith("/api/conversations")) {
    return [];
  }
  if (url.endsWith("/api/jobs")) {
    return [];
  }
  if (url.endsWith("/api/ledger")) {
    return [
      {
        id: "ledger_1",
        desc: "埋一个伏笔",
        status: "open",
        created_at: "2026-05-28T00:00:00",
        updated_at: "2026-05-28T00:00:00"
      }
    ];
  }
  if (url.endsWith("/api/revision-log")) {
    return [];
  }
  throw new Error(`Unhandled url: ${url}`);
}
