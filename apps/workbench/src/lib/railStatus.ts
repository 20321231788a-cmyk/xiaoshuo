import type { JobInfo, SkillRunResponse } from "@xiaoshuo/shared";
import type { PendingGeneratedSave } from "./workflow.js";
import { describeJobKind } from "./workflow.js";

export type RailStatusInput = {
  selectedJobDetail?: JobInfo | null;
  jobs?: JobInfo[];
  operationsBusy?: boolean;
  conversationBusy?: boolean;
  sendingMessage?: boolean;
  operationsMessage?: string;
  conversationMessage?: string;
  latestSkillResult?: SkillRunResponse | null;
  pendingGeneratedSave?: PendingGeneratedSave | null;
  describeSkillId?: (skillId: string) => string;
  statusLabel?: (status: JobInfo["status"]) => string;
};

export type RailStatusSummary = {
  title: string;
  message: string;
  showProgress: boolean;
  indeterminate: boolean;
  progressPercent: number;
  hasPendingSave: boolean;
};

const defaultStatusLabel = (status: JobInfo["status"]) => {
  const labels: Record<JobInfo["status"], string> = {
    queued: "排队中",
    running: "运行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status] || status;
};

export function buildRailStatusSummary(input: RailStatusInput): RailStatusSummary | null {
  const jobs = [input.selectedJobDetail, ...(input.jobs || []).slice().reverse()];
  const activeJob = jobs.find((job) => job && (job.status === "running" || job.status === "queued") && job.kind !== "summarize_conversation") || null;
  const latestJob = jobs.find((job) => job && job.kind !== "summarize_conversation") || null;
  const describeSkill = input.describeSkillId ?? ((skillId: string) => skillId);
  const statusLabel = input.statusLabel ?? defaultStatusLabel;
  const isSkillRunning = Boolean(input.operationsBusy || input.conversationBusy || input.sendingMessage);

  if (activeJob) {
    return {
      title: describeJobKind(activeJob.kind),
      message: compactText(activeJob.message || statusLabel(activeJob.status)),
      showProgress: true,
      indeterminate: false,
      progressPercent: clampPercent((activeJob.progress || 0) * 100),
      hasPendingSave: false
    };
  }

  if (isSkillRunning) {
    const skillId = input.latestSkillResult?.data?.skill_id;
    return {
      title: skillId ? `正在执行: ${describeSkill(String(skillId))}` : "正在执行",
      message: compactText(input.operationsMessage || input.conversationMessage || "正在处理中..."),
      showProgress: true,
      indeterminate: true,
      progressPercent: 0,
      hasPendingSave: false
    };
  }

  if (input.pendingGeneratedSave) {
    const skillId = input.pendingGeneratedSave.skillId;
    return {
      title: skillId ? `${describeSkill(String(skillId))}结果已就绪` : "生成结果已就绪",
      message: compactText(input.operationsMessage || input.conversationMessage || "等待选择写入方式"),
      showProgress: false,
      indeterminate: false,
      progressPercent: 0,
      hasPendingSave: true
    };
  }

  if (input.latestSkillResult) {
    const skillId = input.latestSkillResult.data?.skill_id;
    return {
      title: skillId ? `${describeSkill(String(skillId))}执行完成` : "执行完成",
      message: compactText(input.operationsMessage || "技能执行完成"),
      showProgress: false,
      indeterminate: false,
      progressPercent: 0,
      hasPendingSave: false
    };
  }

  if (latestJob) {
    return {
      title: describeJobKind(latestJob.kind),
      message: compactText(
        latestJob.status === "done"
          ? "任务已完成"
          : latestJob.status === "failed"
            ? `任务失败: ${latestJob.message || latestJob.error || "未知错误"}`
            : statusLabel(latestJob.status)
      ),
      showProgress: false,
      indeterminate: false,
      progressPercent: 0,
      hasPendingSave: false
    };
  }

  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
