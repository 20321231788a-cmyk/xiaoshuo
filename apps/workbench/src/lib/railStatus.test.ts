import { describe, expect, it } from "vitest";
import type { JobInfo } from "@xiaoshuo/shared";
import { buildRailStatusSummary } from "./railStatus.js";

function job(patch: Partial<JobInfo>): JobInfo {
  return {
    id: "job-1",
    kind: "vector_reindex",
    status: "running",
    progress: 0.42,
    message: "正在嵌入",
    ...patch
  };
}

describe("railStatus", () => {
  it("uses one background job progress when job and skill states overlap", () => {
    const summary = buildRailStatusSummary({
      jobs: [job({})],
      operationsBusy: true,
      latestSkillResult: {
        status: "done",
        result: "长正文不应该出现在右栏摘要",
        saved_path: "",
        data: { skill_id: "body_generate" }
      },
      operationsMessage: "技能也在运行",
      describeSkillId: (id) => `技能 ${id}`
    });

    expect(summary).toMatchObject({
      title: "重建向量索引",
      message: "正在嵌入",
      showProgress: true,
      indeterminate: false,
      progressPercent: 42
    });
  });

  it("falls back to one indeterminate skill progress", () => {
    const summary = buildRailStatusSummary({
      operationsBusy: true,
      conversationBusy: true,
      operationsMessage: "正在生成正文",
      latestSkillResult: {
        status: "done",
        result: "",
        saved_path: "",
        data: { skill_id: "body_generate" }
      },
      describeSkillId: (id) => `技能 ${id}`
    });

    expect(summary).toMatchObject({
      title: "正在执行: 技能 body_generate",
      message: "正在生成正文",
      showProgress: true,
      indeterminate: true
    });
  });

  it("shows compact pending-save summary only when no live work is active", () => {
    const summary = buildRailStatusSummary({
      pendingGeneratedSave: {
        skillId: "body_generate",
        content: "正文内容",
        cacheId: "cache-1",
        cachePath: "",
        cacheChars: 4,
        targetPath: "02_正文/第001章.txt",
        targetPaths: ["02_正文/第001章.txt"],
        chapter: 1,
        defaultMode: "replace",
        source: "skill"
      },
      describeSkillId: (id) => `技能 ${id}`
    });

    expect(summary).toMatchObject({
      title: "技能 body_generate结果已就绪",
      message: "等待选择写入方式",
      showProgress: false,
      hasPendingSave: true
    });
  });
});
