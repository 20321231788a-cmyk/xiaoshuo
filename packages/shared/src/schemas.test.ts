import { describe, expect, it } from "vitest";
import {
  desktopShellCapabilitiesSchema,
  conversationMessageRequestSchema,
  documentInfoSchema,
  healthSchema,
  jobInfoSchema,
  localStateRecordProjectRequestSchema,
  localStateSnapshotSchema,
  projectChromeSnapshotSchema,
  projectOpenRequestSchema,
  projectRenameRequestSchema,
  terminalCreateRequestSchema
} from "./index.js";

describe("shared schemas", () => {
  it("accepts the current health payload shape", () => {
    expect(
      healthSchema.parse({
        ok: true,
        version: "5.0.2",
        machineCode: "device",
        deviceCode: "device"
      })
    ).toMatchObject({ ok: true, version: "5.0.2" });
  });

  it("accepts job status payloads", () => {
    expect(
      jobInfoSchema.parse({
        id: "job_1",
        kind: "chapter",
        status: "running",
        progress: 0.5,
        message: "writing"
      })
    ).toMatchObject({ status: "running" });
  });

  it("rejects conversation write targets without an explicit write mode", () => {
    expect(() =>
      conversationMessageRequestSchema.parse({
        content: "写回",
        write_target: "02_正文/第001章.txt",
        insert_mode: "none"
      })
    ).toThrow("write_target requires insert_mode");

    expect(
      conversationMessageRequestSchema.parse({
        content: "写回",
        write_target: "02_正文/第001章.txt",
        insert_mode: "append",
        confirm_write: true
      })
    ).toMatchObject({ insert_mode: "append", confirm_write: true });
  });

  it("accepts a minimal project chrome snapshot", () => {
    const snapshot = projectChromeSnapshotSchema.parse({
      tree: [],
      libraries: [],
      timeline: [],
      current: { path: "D:\\xiaoshuo", name: "xiaoshuo" },
      version: 1,
      generated_at: "2026-05-28T00:00:00"
    });

    expect(snapshot.current.name).toBe("xiaoshuo");
  });

  it("accepts document info payloads", () => {
    const document = documentInfoSchema.parse({
      path: "01_大纲/大纲.txt",
      name: "大纲",
      group: "大纲",
      size: 128,
      updated_at: "2026-06-01 10:00"
    });

    expect(document.group).toBe("大纲");
  });

  it("normalizes project open and rename requests", () => {
    const openRequest = projectOpenRequestSchema.parse({
      path: "D:\\xiaoshuo\\ts-migration\\sandbox-projects",
      project_name: "demo"
    });
    const renameRequest = projectRenameRequestSchema.parse({
      name: "  新项目名  "
    });

    expect(openRequest.create_in_parent).toBe(false);
    expect(renameRequest.name).toBe("新项目名");
  });

  it("accepts desktop shell capability probes", () => {
    const capabilities = desktopShellCapabilitiesSchema.parse({
      terminal: { available: true, package: "node-pty" },
      localDatabase: { available: true, package: "node:sqlite" },
      downloads: { available: true, package: "electron-dl" },
      contextMenu: { available: true, package: "electron-context-menu" },
      monitoring: { available: true, package: "@sentry/electron" },
      websocket: { available: false, package: "ws", reason: "optional dependency not installed" }
    });

    expect(capabilities.terminal.available).toBe(true);
    expect(capabilities.websocket.reason).toContain("optional");
  });

  it("normalizes terminal create requests", () => {
    const request = terminalCreateRequestSchema.parse({ cwd: "D:\\xiaoshuo" });

    expect(request.cols).toBe(100);
    expect(request.rows).toBe(30);
  });

  it("accepts desktop local state snapshots", () => {
    const snapshot = localStateSnapshotSchema.parse({
      db_path: "D:\\xiaoshuo\\state\\xiaoshuo-local-state.sqlite3",
      driver: "node:sqlite",
      synced_at: "2026-05-30T10:00:00.000Z",
      settings: {
        active_tab: "project",
        project_path_input: "D:\\xiaoshuo",
        project_name_input: "xiaoshuo",
        updated_at: "2026-05-30T10:00:00.000Z"
      },
      generated_caches: [
        {
          cache_id: "cache_1",
          project_path: "D:\\xiaoshuo",
          skill_id: "draft",
          source: "skill",
          target_path: "02_正文/正文.txt",
          target_paths: ["02_正文/正文.txt"],
          status: "pending",
          mode: "append",
          cache_path: "00_设定集/.agent/generated/cache_1.json",
          cache_chars: 1200,
          created_at: "2026-05-30T10:00:00.000Z",
          updated_at: "2026-05-30T10:00:00.000Z"
        }
      ],
      recent_projects: [
        {
          path: "D:\\xiaoshuo",
          name: "xiaoshuo",
          opened_at: "2026-05-30T10:00:00.000Z",
          conversation_count: 3,
          job_count: 2,
          last_synced_at: "2026-05-30T10:00:00.000Z"
        }
      ]
    });
    const recordRequest = localStateRecordProjectRequestSchema.parse({
      path: snapshot.recent_projects[0]?.path,
      name: snapshot.recent_projects[0]?.name
    });

    expect(snapshot.recent_projects).toHaveLength(1);
    expect(recordRequest.opened_at).toBeUndefined();
  });
});
