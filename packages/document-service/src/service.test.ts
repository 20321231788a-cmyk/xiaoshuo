import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentSaveConflictError, DocumentService } from "./service.js";

let tempDir = "";
const externalRoots: string[] = [];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-document-service-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", ".agent"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "修正日志"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "第一章", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "说明.md"), "说明内容", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "notes.json"), "{\"bad\":true}", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  await Promise.all(externalRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("document-service", () => {
  it("reads allowed project documents", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    const detail = await service.readDocument("00_设定集/说明.md");

    expect(detail.path).toBe("00_设定集/说明.md");
    expect(detail.content).toBe("说明内容");
    expect(detail.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("maps the legacy settings outline alias to the outline folder", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    const detail = await service.readDocument("00_设定集/大纲.txt");

    expect(detail.path).toBe("01_大纲/大纲.txt");
    expect(detail.content).toBe("第一章");
  });

  it("rejects path traversal", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    await expect(service.readDocument("../secret.txt")).rejects.toThrow("非法项目路径");
  });

  it("rejects absolute paths instead of rewriting them as project-relative", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const outside = await externalRoot();
    const target = path.join(outside, "absolute.txt");

    await expect(service.saveDocument(target, "must not write")).rejects.toThrow("非法项目路径");
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("rejects a file symlink that resolves outside the canonical project root", async (context) => {
    const service = new DocumentService({ projectRoot: tempDir });
    const outside = await externalRoot();
    const outsideFile = path.join(outside, "outside.txt");
    const linkedFile = path.join(tempDir, "01_大纲", "linked.txt");
    await fs.writeFile(outsideFile, "outside-original", "utf8");
    try {
      await fs.symlink(outsideFile, linkedFile, "file");
    } catch (error) {
      if (isLinkPrivilegeError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(service.saveDocument("01_大纲/linked.txt", "escaped-write")).rejects.toMatchObject({
      code: "PROJECT_SCOPE_PATH_ESCAPE"
    });
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
  });

  it("rejects a directory symlink or Windows junction that resolves outside the project", async (context) => {
    const service = new DocumentService({ projectRoot: tempDir });
    const outside = await externalRoot();
    const linkedDirectory = path.join(tempDir, "02_正文");
    try {
      await fs.symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isLinkPrivilegeError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(service.saveDocument("02_正文/第一章.txt", "escaped-write")).rejects.toMatchObject({
      code: "PROJECT_SCOPE_PATH_ESCAPE"
    });
    await expect(fs.access(path.join(outside, "第一章.txt"))).rejects.toThrow();
  });

  it("revalidates physical scope after the atomic temp write and blocks link replacement", async (context) => {
    const service = new DocumentService({ projectRoot: tempDir });
    const outside = await externalRoot();
    const outsideTarget = path.join(outside, "第一章.txt");
    const bodyDirectory = path.join(tempDir, "02_正文");
    const parkedDirectory = path.join(tempDir, "02_正文.parked");
    const target = path.join(bodyDirectory, "第一章.txt");
    const tempPath = path.join(bodyDirectory, ".第一章.agent-test.tmp");
    const backupPath = path.join(bodyDirectory, ".第一章.agent-test.bak");
    await fs.mkdir(bodyDirectory);
    await fs.writeFile(target, "inside-original", "utf8");
    await fs.writeFile(outsideTarget, "outside-original", "utf8");

    let linkCreated = false;
    await expect(service.saveDocument("02_正文/第一章.txt", "new-content", {
      atomicWrite: {
        tempPath,
        backupPath,
        onStage: async (stage) => {
          if (stage !== "temp_written") {
            return;
          }
          await fs.rename(bodyDirectory, parkedDirectory);
          try {
            await fs.symlink(outside, bodyDirectory, process.platform === "win32" ? "junction" : "dir");
            linkCreated = true;
          } catch (error) {
            await fs.rename(parkedDirectory, bodyDirectory);
            if (isLinkPrivilegeError(error)) {
              context.skip();
              return;
            }
            throw error;
          }
        }
      }
    })).rejects.toMatchObject({ code: "PROJECT_SCOPE_PATH_ESCAPE" });

    if (!linkCreated) {
      return;
    }
    expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside-original");
  });

  it("guards internal ledger writes from an external .agent junction", async (context) => {
    const service = new DocumentService({ projectRoot: tempDir });
    const outside = await externalRoot();
    const agentDirectory = path.join(tempDir, "00_设定集", ".agent");
    await fs.rm(agentDirectory, { recursive: true, force: true });
    try {
      await fs.symlink(outside, agentDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (isLinkPrivilegeError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(service.addLedgerItem("伏笔")).rejects.toMatchObject({ code: "PROJECT_SCOPE_PATH_ESCAPE" });
    await expect(fs.access(path.join(outside, "ledger.json"))).rejects.toThrow();
  });

  it("detects replacement of the project directory at the same lexical path", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const parkedRoot = `${tempDir}.parked`;
    await service.canonicalProjectRoot();
    await fs.rename(tempDir, parkedRoot);
    await fs.mkdir(tempDir);
    const replacementTarget = path.join(tempDir, "02_正文", "第一章.txt");

    try {
      await expect(service.saveDocument("02_正文/第一章.txt", "must-not-write")).rejects.toMatchObject({
        code: "PROJECT_SCOPE_ROOT_CHANGED"
      });
      await expect(fs.access(replacementTarget)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rename(parkedRoot, tempDir);
    }
  });

  it("rejects blocked file types", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    await expect(service.readDocument("00_设定集/notes.json")).rejects.toThrow("禁止操作该类型文件: .json");
  });

  it("reports missing files clearly", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    await expect(service.readDocument("01_大纲/缺失.txt")).rejects.toThrow("文件不存在: 01_大纲/缺失.txt");
  });

  it("saves documents and records a timeline entry", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 22:30:00",
      idFactory: () => "timeline-entry-1"
    });

    const saved = await service.saveDocument("01_大纲/大纲.txt", "新的大纲", {
      source: "editor",
      session: {
        id: "session-1",
        startedAt: "2026-06-01 22:00:00"
      }
    });
    const disk = await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8");
    const timeline = await service.listTimeline();

    expect(saved.path).toBe("01_大纲/大纲.txt");
    expect(saved.content).toBe("新的大纲");
    expect(saved.changed).toBe(true);
    expect(disk).toBe("新的大纲");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "timeline-entry-1",
      source: "editor",
      summary: "保存 01_大纲/大纲.txt",
      session_id: "session-1",
      session_started_at: "2026-06-01 22:00:00"
    });
    expect(timeline[0]?.files[0]).toMatchObject({
      path: "01_大纲/大纲.txt",
      before_exists: true,
      before_content: "第一章",
      after_exists: true,
      after_excerpt: "新的大纲"
    });
  });

  it("creates missing files inside the project when saving", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    const saved = await service.saveDocument("02_正文/第一章.txt", "第一章正文");

    expect(saved.path).toBe("02_正文/第一章.txt");
    expect(saved.changed).toBe(true);
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8")).toBe("第一章正文");
  });

  it("skips disk and timeline writes when saving unchanged content", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const target = path.join(tempDir, "01_大纲", "大纲.txt");
    const beforeStats = await fs.stat(target);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = await service.saveDocument("01_大纲/大纲.txt", "第一章");
    const afterStats = await fs.stat(target);
    const timeline = await service.listTimeline();

    expect(saved).toMatchObject({
      path: "01_大纲/大纲.txt",
      content: "第一章",
      changed: false
    });
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
    expect(timeline).toHaveLength(0);
  });

  it("creates a missing empty file even when the requested content is empty", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    const saved = await service.saveDocument("02_正文/空章.txt", "");

    expect(saved.changed).toBe(true);
    expect(await fs.readFile(path.join(tempDir, "02_正文", "空章.txt"), "utf8")).toBe("");
    expect(await service.listTimeline()).toHaveLength(1);
  });

  it("rejects stale editor saves unless overwrite is confirmed", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const opened = await service.readDocument("01_大纲/大纲.txt");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "后台新版", "utf8");

    await expect(
      service.saveDocument("01_大纲/大纲.txt", "本地旧草稿", {
        baseUpdatedAt: opened.updated_at,
        baseUpdatedAtMs: opened.updated_at_ms
      })
    ).rejects.toThrow("磁盘已有新版内容");

    const forced = await service.saveDocument("01_大纲/大纲.txt", "本地旧草稿", {
      baseUpdatedAt: opened.updated_at,
      baseUpdatedAtMs: opened.updated_at_ms,
      force: true
    });

    expect(forced.content).toBe("本地旧草稿");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("本地旧草稿");
  });

  it("does not reject stale editor saves when the disk content is unchanged", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const target = path.join(tempDir, "01_大纲", "大纲.txt");
    const opened = await service.readDocument("01_大纲/大纲.txt");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(target, "第一章", "utf8");

    const saved = await service.saveDocument("01_大纲/大纲.txt", "第一章", {
      baseUpdatedAt: opened.updated_at,
      baseUpdatedAtMs: opened.updated_at_ms
    });

    expect(saved.changed).toBe(false);
    expect(await service.listTimeline()).toHaveLength(0);
  });

  it("still rejects stale editor saves when content differs", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const opened = await service.readDocument("01_大纲/大纲.txt");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "后台新版", "utf8");

    await expect(
      service.saveDocument("01_大纲/大纲.txt", "本地旧草稿", {
        baseUpdatedAt: opened.updated_at,
        baseUpdatedAtMs: opened.updated_at_ms
      })
    ).rejects.toBeInstanceOf(DocumentSaveConflictError);
  });

  it("archives a document into the timestamped trash folder and records timeline", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 23:30:00",
      idFactory: () => "archive-1"
    });

    const archived = await service.archiveDocument("00_设定集/说明.md", {
      session: {
        id: "archive-session",
        startedAt: "2026-06-01 23:25:00"
      }
    });
    const timeline = await service.listTimeline();

    await expect(fs.access(path.join(tempDir, "00_设定集", "说明.md"))).rejects.toThrow();
    expect(await fs.readFile(path.join(tempDir, "99_回收站", "20260601_233000", "00_设定集", "说明.md"), "utf8")).toBe("说明内容");
    expect(archived).toMatchObject({
      path: "00_设定集/说明.md",
      archived_path: "99_回收站/20260601_233000/00_设定集/说明.md"
    });
    expect(timeline[0]).toMatchObject({
      summary: "归档 00_设定集/说明.md"
    });
    expect(timeline[0]?.files[0]).toMatchObject({
      path: "00_设定集/说明.md",
      before_exists: true,
      after_exists: false
    });
  });

  it("executes agent file operations with one batch timeline entry and operation log", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 23:40:00",
      idFactory: (() => {
        let index = 0;
        return () => `exec-${++index}`;
      })()
    });

    const results = await service.executeOperations(
      [
        { action: "create_file", path: "02_正文/新章.txt", text: "开头", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: false },
        { action: "append_text", path: "02_正文/新章.txt", text: "\n续写", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: false },
        { action: "replace_text", path: "01_大纲/大纲.txt", text: "", old_text: "第一章", new_text: "第一章-修订", target_path: "", reason: "", requires_confirmation: false },
        { action: "move_file", path: "02_正文/新章.txt", text: "", old_text: "", new_text: "", target_path: "02_正文/已移动.txt", reason: "", requires_confirmation: false },
        { action: "archive_file", path: "00_设定集/说明.md", text: "", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: true }
      ],
      {
        confirmDelete: true,
        session: {
          id: "exec-session",
          startedAt: "2026-06-01 23:35:00"
        }
      }
    );
    const timeline = await service.listTimeline();
    const operationLog = await fs.readFile(path.join(tempDir, "00_设定集", "文件管家操作日志.jsonl"), "utf8");

    expect(results).toHaveLength(5);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(await fs.readFile(path.join(tempDir, "02_正文", "已移动.txt"), "utf8")).toBe("开头\n续写");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("第一章-修订");
    await expect(fs.access(path.join(tempDir, "00_设定集", "说明.md"))).rejects.toThrow();
    expect(await fs.readFile(path.join(tempDir, "99_回收站", "20260601_234000", "00_设定集", "说明.md"), "utf8")).toBe("说明内容");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      summary: "创建 02_正文/新章.txt 等 5 项"
    });
    expect(timeline[0]?.operations).toHaveLength(5);
    expect(operationLog).toContain("\"action\":\"archive_file\"");
  });

  it("requires confirmation before archive operations execute", async () => {
    const service = new DocumentService({ projectRoot: tempDir });

    await expect(
      service.executeOperations([{ action: "archive_file", path: "00_设定集/说明.md", text: "", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: true }])
    ).rejects.toThrow("删除/归档文件需要用户确认");
  });

  it("reports replace_text errors per operation without aborting the whole batch", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 23:45:00"
    });

    const results = await service.executeOperations([
      { action: "replace_text", path: "01_大纲/大纲.txt", text: "", old_text: "不存在", new_text: "替换", target_path: "", reason: "", requires_confirmation: false },
      { action: "append_text", path: "01_大纲/大纲.txt", text: "\n追加", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: false }
    ]);
    const timeline = await service.listTimeline();

    expect(results).toMatchObject([
      { action: "replace_text", ok: false, message: "未找到要替换的原文" },
      { action: "append_text", ok: true, message: "完成" }
    ]);
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("第一章\n追加");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.operations).toHaveLength(2);
    expect(timeline[0]?.files).toHaveLength(2);
  });

  it("lists newest timeline entries first and ignores broken lines", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 22:40:00",
      idFactory: (() => {
        let index = 0;
        return () => `entry-${++index}`;
      })()
    });

    await service.saveDocument("01_大纲/大纲.txt", "第一版");
    await service.saveDocument("01_大纲/大纲.txt", "第二版");
    await fs.appendFile(path.join(tempDir, "00_设定集", ".agent", "timeline.jsonl"), "{bad json}\n", "utf8");

    const timeline = await service.listTimeline(2);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.summary).toBe("保存 01_大纲/大纲.txt");
    expect(timeline[0]?.files[0]?.after_excerpt).toBe("第二版");
    expect(timeline[1]?.files[0]?.after_excerpt).toBe("第一版");
  });

  it("can fetch and delete a timeline entry", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 22:50:00",
      idFactory: (() => {
        let index = 0;
        return () => `timeline-${++index}`;
      })()
    });

    await service.saveDocument("01_大纲/大纲.txt", "删除前版本", {
      session: {
        id: "timeline-session",
        startedAt: "2026-06-01 22:45:00"
      }
    });
    const created = await service.getTimelineEntry("timeline-1");
    const removed = await service.deleteTimelineEntry("timeline-1");
    const remaining = await service.listTimeline();

    expect(created.summary).toBe("保存 01_大纲/大纲.txt");
    expect(removed).toMatchObject({ ok: true, deleted_id: "timeline-1" });
    expect(remaining).toHaveLength(0);
  });

  it("rolls back a saved document and appends a rollback timeline entry", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: (() => {
        let call = 0;
        return () => (call++ < 2 ? "2026-06-01 23:00:00" : "2026-06-01 23:05:00");
      })(),
      idFactory: (() => {
        let index = 0;
        return () => `rollback-${++index}`;
      })()
    });

    await service.saveDocument("01_大纲/大纲.txt", "覆盖内容", {
      session: {
        id: "session-1",
        startedAt: "2026-06-01 22:58:00"
      }
    });
    const rollback = await service.rollbackTimelineEntry("rollback-1", {
      session: {
        id: "session-2",
        startedAt: "2026-06-01 22:55:00"
      }
    });
    const disk = await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8");
    const timeline = await service.listTimeline();

    expect(rollback.ok).toBe(true);
    expect(rollback.entry?.summary).toBe("回滚：保存 01_大纲/大纲.txt");
    expect(disk).toBe("第一章");
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.summary).toBe("回滚：保存 01_大纲/大纲.txt");
  });

  it("returns confirmation-required rollback result when new files would be deleted", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-01 23:10:00",
      idFactory: (() => {
        let index = 0;
        return () => `new-file-${++index}`;
      })()
    });

    await service.saveDocument("02_正文/新章.txt", "新内容", {
      session: {
        id: "new-file-session",
        startedAt: "2026-06-01 23:08:00"
      }
    });
    const rollback = await service.rollbackTimelineEntry("new-file-1");

    expect(rollback).toMatchObject({
      ok: false,
      requires_confirmation: true,
      message: "该回滚会删除本次操作中新建的文件，请确认后再执行。"
    });
  });

  it("adds and toggles ledger items", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: (() => {
        let call = 0;
        return () => (call++ === 0 ? "2026-06-01 23:20:00" : "2026-06-01 23:25:00");
      })(),
      idFactory: () => "ledger-1"
    });

    const created = await service.addLedgerItem("埋下线索");
    const toggled = await service.toggleLedgerItem("ledger-1");
    const items = await service.getLedger();

    expect(created).toMatchObject({ id: "ledger-1", status: "open", desc: "埋下线索" });
    expect(toggled.status).toBe("closed");
    expect(items[0]).toMatchObject({ id: "ledger-1", status: "closed" });
  });

  it("parses and clears revision logs with confirmation", async () => {
    const service = new DocumentService({ projectRoot: tempDir });
    const revisionPath = path.join(tempDir, "00_设定集", "修正日志", "正文二次修正日志.txt");
    await fs.writeFile(
      revisionPath,
      [
        "==== 二次修正 | 2026-06-01 20:00:00",
        "文件: 02_正文/第一章.txt",
        "评分: 92",
        "- 风险一",
        "- 风险二",
        "",
        "==== 二次修正 | 2026-06-01 21:00:00",
        "文件: 02_正文/第二章.txt",
        "评分: 88",
        "- 风险三"
      ].join("\n"),
      "utf8"
    );

    const entries = await service.listRevisionLogs();
    await service.clearRevisionLogs(true);
    const cleared = await fs.readFile(revisionPath, "utf8");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      timestamp: "2026-06-01 21:00:00",
      path: "02_正文/第二章.txt",
      score: 88
    });
    expect(entries[0]?.risks).toContain("风险三");
    expect(cleared).toBe("");
  });

  it("batch archives multiple documents, deduplicates paths, and records a single timeline entry", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-02 10:00:00",
      idFactory: (() => {
        let index = 0;
        return () => `batch-archive-${++index}`;
      })()
    });

    // Create a second document so we have 2 files to archive
    await fs.writeFile(path.join(tempDir, "01_大纲", "副本.txt"), "副本内容", "utf8");

    const archived = await service.archiveDocuments(
      [
        "00_设定集/说明.md",
        "01_大纲/副本.txt",
        // duplicate — should be ignored
        "00_设定集/说明.md"
      ],
      {
        session: {
          id: "batch-session",
          startedAt: "2026-06-02 09:55:00"
        }
      }
    );
    const timeline = await service.listTimeline();

    // Only 2 unique files archived
    expect(archived).toHaveLength(2);

    // Original files removed
    await expect(fs.access(path.join(tempDir, "00_设定集", "说明.md"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "01_大纲", "副本.txt"))).rejects.toThrow();

    // Files exist in the trash
    expect(await fs.readFile(path.join(tempDir, "99_回收站", "20260602_100000", "00_设定集", "说明.md"), "utf8")).toBe("说明内容");
    expect(await fs.readFile(path.join(tempDir, "99_回收站", "20260602_100000", "01_大纲", "副本.txt"), "utf8")).toBe("副本内容");

    // One merged timeline entry
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      summary: "归档 2 个文件"
    });
    expect(timeline[0]?.files).toHaveLength(2);
  });

  it("executeOperations create_file rejects overwriting an existing file", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-02 11:00:00"
    });

    const results = await service.executeOperations([
      { action: "create_file", path: "01_大纲/大纲.txt", text: "覆盖内容", old_text: "", new_text: "", target_path: "", reason: "", requires_confirmation: false }
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "create_file",
      ok: false,
      message: "文件已存在，拒绝覆盖"
    });
    // Original content unchanged
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("第一章");
  });

  it("executeOperations move_file rejects when target path already exists", async () => {
    const service = new DocumentService({
      projectRoot: tempDir,
      now: () => "2026-06-02 12:00:00"
    });

    const results = await service.executeOperations([
      { action: "move_file", path: "01_大纲/大纲.txt", text: "", old_text: "", new_text: "", target_path: "00_设定集/说明.md", reason: "", requires_confirmation: false }
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "move_file",
      ok: false,
      message: "目标文件已存在"
    });
    // Both original files unchanged
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8")).toBe("第一章");
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "说明.md"), "utf8")).toBe("说明内容");
  });
});

async function externalRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-document-external-"));
  externalRoots.push(root);
  return root;
}

function isLinkPrivilegeError(error: unknown): boolean {
  const code = typeof error === "object" && error ? String((error as NodeJS.ErrnoException).code || "") : "";
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}
