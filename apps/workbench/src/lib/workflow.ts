import type { AgentRunResponse, JobInfo, OperationResult, SkillDefinition, SkillRunResponse } from "@xiaoshuo/shared";

export type PendingGeneratedSave = {
  skillId: string;
  content: string;
  cacheId: string;
  cachePath: string;
  cacheChars: number;
  targetPath: string;
  targetPaths: string[];
  chapter: number;
  defaultMode: "replace" | "append";
  source: "chat" | "skill";
};

export type UnsavedWorkbenchStateInput = {
  dirtyDocumentCount: number;
  hasConversationDraft: boolean;
  hasPendingGeneratedSave: boolean;
};

export type UnsavedWorkbenchState = {
  hasUnsavedState: boolean;
  summary: string;
  detail: string;
};

export type JobResultFile = {
  path: string;
  source: "saved" | "archived" | "target" | "output" | "file";
};

export type JobResultSummary = {
  typeLabel: string;
  primary: string;
  detail: string;
};

export type WebSearchSource = {
  title: string;
  url: string;
};

export function describeActionableError(error: unknown, fallback: string, nextStep = ""): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  const normalizedStep = nextStep.trim() || defaultErrorNextStep(detail);
  if (!normalizedStep || detail.includes(normalizedStep)) {
    return detail;
  }
  const separator = /[。.!?？]$/.test(detail) ? "" : "。";
  return `${detail}${separator}${normalizedStep}`;
}

function defaultErrorNextStep(detail: string): string {
  if (detail.includes("尚未打开项目")) {
    return "请先到项目页打开或创建项目。";
  }
  if (detail.includes("未配置") || detail.includes("API Key") || detail.includes("模型")) {
    return "请先到配置页检查模型和 API Key。";
  }
  if (detail.includes("目录") || detail.includes("路径") || detail.includes("不存在") || detail.includes("ENOENT")) {
    return "请确认路径存在并且当前账号有读写权限。";
  }
  if (detail.includes("权限") || detail.includes("EACCES") || detail.includes("EPERM")) {
    return "请确认当前账号有该目录的读写权限，必要时换一个项目目录。";
  }
  if (detail.includes("向量") || detail.includes("embedding") || detail.includes("Embedding")) {
    return "请先到配置页检查向量和 Embedding 设置，再重试。";
  }
  if (detail.includes("授权") || detail.includes("license") || detail.includes("License")) {
    return "请检查授权状态或稍后重新刷新。";
  }
  return "";
}

export function pendingSaveFromSkill(result?: SkillRunResponse | null, source: PendingGeneratedSave["source"] = "skill"): PendingGeneratedSave | null {
  if (!result?.data?.pending_save) {
    return null;
  }

  const data = result.data;
  const content = String(data.result || result.result || "").trim();
  const cacheId = String(data.cache_id || "");
  const targetPaths = stringList(data.target_paths);
  const targetPath = String(data.target_path || targetPaths[0] || result.saved_path || "");
  if ((!content && !cacheId) || !targetPath) {
    return null;
  }

  return {
    skillId: String(data.skill_id || ""),
    content,
    cacheId,
    cachePath: String(data.cache_path || ""),
    cacheChars: Number(data.cache_chars || content.length || 0),
    targetPath,
    targetPaths: targetPaths.length ? targetPaths : [targetPath],
    chapter: Number(data.chapter || 0),
    defaultMode: data.default_mode === "append" ? "append" : "replace",
    source
  };
}

export function describeUnsavedWorkbenchState(input: UnsavedWorkbenchStateInput): UnsavedWorkbenchState {
  const reasons: string[] = [];

  if (input.dirtyDocumentCount > 0) {
    reasons.push(input.dirtyDocumentCount === 1 ? "1 个文档草稿未保存" : `${input.dirtyDocumentCount} 个文档草稿未保存`);
  }
  if (input.hasConversationDraft) {
    reasons.push("会话输入框里还有草稿");
  }
  if (input.hasPendingGeneratedSave) {
    reasons.push("还有待选择写入方式的生成结果");
  }

  if (!reasons.length) {
    return {
      hasUnsavedState: false,
      summary: "",
      detail: ""
    };
  }

  return {
    hasUnsavedState: true,
    summary: reasons.join("，"),
    detail: `继续切换会丢掉这些未保存状态：${reasons.join("，")}。`
  };
}

export function summarizeOperationResults(results: OperationResult[]): string {
  if (!results.length) {
    return "没有执行文件改动。";
  }

  return results
    .map((result) => `${result.ok ? "完成" : "失败"}：${result.action} ${result.path}${result.message ? `，${result.message}` : ""}`)
    .join("\n");
}

export function extractPathsFromUnknownResult(value: unknown): string[] {
  return extractJobResultFiles(value).map((file) => file.path);
}

export function extractJobResultFiles(value: unknown): JobResultFile[] {
  const files: JobResultFile[] = [];
  const seen = new Set<string>();

  function add(path: unknown, source: JobResultFile["source"]) {
    if (typeof path !== "string") {
      return;
    }
    const normalized = path.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    files.push({ path: normalized, source });
  }

  function walk(node: unknown, depth: number) {
    if (!node || depth > 4) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 100)) {
        walk(item, depth + 1);
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }

    const data = node as Record<string, unknown>;
    for (const item of stringList(data.saved_paths)) {
      add(item, "saved");
    }
    add(data.saved_path, "saved");
    for (const item of stringList(data.archived_paths)) {
      add(item, "archived");
    }
    add(data.archived_path, "archived");
    for (const item of stringList(data.target_paths)) {
      add(item, "target");
    }
    add(data.target_path, "target");
    add(data.output_path, "output");
    add(data.file_path, "file");
    add(data.path, "file");

    for (const [key, nested] of Object.entries(data)) {
      if (key.endsWith("_path") || key.endsWith("_paths") || key === "path" || key === "paths") {
        continue;
      }
      walk(nested, depth + 1);
    }
  }

  walk(value, 0);
  return files;
}

export function summarizeJobResult(value: unknown, files: JobResultFile[] = extractJobResultFiles(value)): JobResultSummary {
  const fileSummary = files.length ? `识别到 ${files.length} 个相关文件` : "未识别到可直接打开的文件";

  if (Array.isArray(value)) {
    return {
      typeLabel: "数组结果",
      primary: `${value.length} 项`,
      detail: fileSummary
    };
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    const savedCount = files.filter((file) => file.source === "saved").length;
    const archivedCount = files.filter((file) => file.source === "archived").length;
    const fileParts = [
      savedCount ? `${savedCount} 个写入文件` : "",
      archivedCount ? `${archivedCount} 个归档文件` : "",
      !savedCount && !archivedCount ? fileSummary : ""
    ].filter(Boolean);
    return {
      typeLabel: "结构化结果",
      primary: keys.length ? `${keys.length} 个字段` : "空对象",
      detail: fileParts.join("，") || fileSummary
    };
  }

  if (typeof value === "string") {
    return {
      typeLabel: "文本结果",
      primary: value.trim() ? `${value.length} 字符` : "空文本",
      detail: fileSummary
    };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return {
      typeLabel: "基础结果",
      primary: String(value),
      detail: fileSummary
    };
  }

  return {
    typeLabel: "无结果",
    primary: "未返回",
    detail: "任务没有提供额外结果数据"
  };
}

export function sanitizeWebSearchSources(value: unknown, limit = 5): WebSearchSource[] {
  if (!Array.isArray(value) || limit <= 0) {
    return [];
  }

  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const data = item as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title.trim() : "";
    const rawUrl = typeof data.url === "string" ? data.url.trim() : "";
    if (!title || !rawUrl) {
      continue;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      continue;
    }
    if (hasSensitiveSearchParam(url.searchParams)) {
      continue;
    }

    url.hash = "";
    const normalizedUrl = url.toString();
    if (seen.has(normalizedUrl)) {
      continue;
    }
    seen.add(normalizedUrl);
    sources.push({ title, url: normalizedUrl });
    if (sources.length >= limit) {
      break;
    }
  }
  return sources;
}

function hasSensitiveSearchParam(params: URLSearchParams): boolean {
  const sensitive = /(^|_|-)(api[-_]?key|access[-_]?token|token|secret|signature|sign|auth|authorization|password|passwd|pwd)($|_|-)/i;
  for (const key of params.keys()) {
    if (sensitive.test(key)) {
      return true;
    }
  }
  return false;
}

export function shouldPollJob(job: JobInfo | null): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

export function messageRequiresActiveDocument(content: string): boolean {
  return /(当前文档|这篇|这一篇|这章|这一章|本章|继续写|续写|改写|润色|扩写|缩写|读一下|分析这|修改这)/.test(content);
}

export function skillRequiresActiveDocument(skill: Pick<SkillDefinition, "input_mode" | "handler_type" | "context_requirements"> | null): boolean {
  if (!skill) {
    return false;
  }

  const inputMode = skill.input_mode.toLowerCase();
  const requirements = skill.context_requirements.map((item) => item.toLowerCase());
  return (
    inputMode.includes("text") ||
    inputMode.includes("document") ||
    requirements.includes("chapter_outline") ||
    requirements.includes("detailed_outline") ||
    requirements.includes("lore") ||
    skill.handler_type === "workflow"
  );
}

export function describeJobKind(kind: string): string {
  const labels: Record<string, string> = {
    scan_project: "扫描项目文件",
    build_continuity_context: "构建连续上下文",
    summarize_conversation: "压缩会话摘要",
    reindex: "重建项目索引",
    vector_reindex: "重建向量索引",
    vector_incremental: "处理待嵌入文件",
    writing: "写作生成任务",
    crawl_disassemble: "抓取并拆书",
    novel_crawl: "联网爬取拆书",
    card_draw_generate: "生成抽卡候选"
  };
  return labels[kind] || kind || "未知任务";
}

export function describeJobStarted(kind: string): string {
  return `已启动任务：${describeJobKind(kind)}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function resolveAssistantReply(payload: AgentRunResponse, streamedText: string): string {
  const finalSkillText = payload.skill_result?.result || "";
  if (streamedText.trim() && finalSkillText.trim() && finalSkillText.trim() !== streamedText.trim()) {
    return finalSkillText;
  }
  return streamedText || payload.reply || "已完成。";
}

export function describeStoppedConversationResponse(streamedText: string): string {
  if (streamedText.trim()) {
    return "已停止本次响应；屏幕上保留的是未完成回复，本次不会自动写入文件。";
  }
  return "已停止本次响应；尚未收到可保留的回复，本次不会写入文件。";
}

export function describeSavedGeneratedResult(
  pendingSave: Pick<PendingGeneratedSave, "skillId" | "targetPath">,
  mode: "replace" | "append",
  savedPaths: string[]
): string {
  const action = mode === "append" ? "追加保存" : pendingSave.skillId === "lore_extract" ? "整合保存" : "覆盖保存";
  const paths = savedPaths.length ? savedPaths : [pendingSave.targetPath].filter(Boolean);

  if (!paths.length) {
    return `已${action}，但后端没有返回写入路径；请在项目树中确认目标文件。`;
  }

  const suffix = paths.length > 1 ? ` 等 ${paths.length} 个文件` : "";
  return `已${action}到 ${paths[0]}${suffix}，目标文档已刷新。`;
}

export function describeGeneratedSaveAction(mode: "replace" | "append", defaultMode: "replace" | "append", targetCount = 1, skillId = ""): string {
  const countSuffix = targetCount > 1 ? ` ${targetCount} 个文件` : "";
  const action =
    mode === "append"
      ? "追加保存"
      : skillId === "lore_extract"
        ? "整合写入设定"
        : skillId === "genre_generate"
          ? "写入题材资料"
          : "覆盖保存";
  const label = `${action}${countSuffix}`;
  return mode === defaultMode ? `${label}（推荐）` : label;
}

export function describeGeneratedWriteIntent(pendingSave: Pick<PendingGeneratedSave, "skillId" | "targetPath" | "targetPaths">): string {
  const paths = pendingGeneratedTargetPaths(pendingSave);
  if (pendingSave.skillId === "lore_extract") {
    return paths.length > 1 ? "会按设定段落整合写入下列目标文件。" : "会把抽取出的设定整合写入目标文件。";
  }
  if (paths.length > 1) {
    return `会把同一份生成内容写入 ${paths.length} 个目标文件，请先确认目标列表。`;
  }
  return "会把当前预览内容写入目标文件，请先确认内容和写入方式。";
}

export function describePendingGeneratedTarget(pendingSave: Pick<PendingGeneratedSave, "targetPath" | "targetPaths">): string {
  const paths = pendingGeneratedTargetPaths(pendingSave);
  if (paths.length <= 1) {
    return paths[0] || "尚未指定目标文件";
  }
  return `${paths[0]} 等 ${paths.length} 个文件`;
}

export function pendingGeneratedTargetPaths(pendingSave: Pick<PendingGeneratedSave, "targetPath" | "targetPaths">): string[] {
  const paths = pendingSave.targetPaths.length ? pendingSave.targetPaths : [pendingSave.targetPath];
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}
