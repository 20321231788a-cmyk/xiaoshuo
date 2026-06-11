import type { DashboardSnapshot } from "./dashboard.js";
import type { WorkbenchTab } from "../hooks/useWorkbenchController.js";

export type WorkbenchNextAction = {
  priority: "high" | "medium" | "low";
  title: string;
  detail: string;
  targetTab: WorkbenchTab;
};

export function pendingGeneratedCachesForCurrentProject(snapshot: DashboardSnapshot) {
  const currentProjectPath = snapshot.currentProject.path;
  return (snapshot.localState?.generated_caches ?? []).filter(
    (cache) => cache.status === "pending" && (!cache.project_path || cache.project_path === currentProjectPath)
  );
}

export function deriveWorkbenchNextActions(snapshot: DashboardSnapshot): WorkbenchNextAction[] {
  const actions: WorkbenchNextAction[] = [];
  const pendingCaches = pendingGeneratedCachesForCurrentProject(snapshot).length;
  const failedJobs = snapshot.jobs.filter((job) => job.status === "failed").length;
  const runningJobs = snapshot.jobs.filter((job) => job.status === "running" || job.status === "queued").length;
  const hasMainModel = Boolean(snapshot.config.api_key.trim() && snapshot.config.base_url.trim() && snapshot.config.model.trim());
  const needsWebSearchConfig = Boolean(
    snapshot.config.web_search_enabled && snapshot.config.web_search_provider === "custom" && !snapshot.config.web_search_base_url?.trim()
  );

  if (!snapshot.currentProject.path) {
    actions.push({
      priority: "high",
      title: "打开或创建小说项目",
      detail: "先进入真实项目目录，编辑器、终端和资料卡才会落到正确位置。",
      targetTab: "project"
    });
  }

  if (!hasMainModel) {
    actions.push({
      priority: "high",
      title: "补齐主线路模型配置",
      detail: "聊天和技能执行需要 API Key、Base URL 和模型名。",
      targetTab: "config"
    });
  }

  if (needsWebSearchConfig) {
    actions.push({
      priority: "medium",
      title: "补齐联网素材搜索配置",
      detail: "已开启自定义联网搜索，但还没有填写 Base URL；补齐后 AI 才能稳定搜索小说素材。",
      targetTab: "config"
    });
  }

  if (!snapshot.license.licensed) {
    actions.push({
      priority: "medium",
      title: "刷新授权状态",
      detail: "保存授权账号 Key 后刷新授权，避免生成链路被授权状态卡住。",
      targetTab: "config"
    });
  }

  if (pendingCaches > 0) {
    actions.push({
      priority: "high",
      title: "处理待写入生成结果",
      detail: `${pendingCaches} 条生成结果还在待确认状态，请先保存或丢弃，避免覆盖新的生成。`,
      targetTab: "overview"
    });
  }

  if (failedJobs > 0) {
    actions.push({
      priority: "medium",
      title: "查看失败任务",
      detail: `${failedJobs} 个后台任务失败，先查看失败原因再继续写作。`,
      targetTab: "operations"
    });
  } else if (runningJobs > 0) {
    actions.push({
      priority: "low",
      title: "检查后台任务进度",
      detail: `${runningJobs} 个任务仍在运行或排队，可到后台任务页查看进度。`,
      targetTab: "operations"
    });
  }

  if (snapshot.currentProject.path && !snapshot.projectChrome.tree.length) {
    actions.push({
      priority: "medium",
      title: "刷新项目结构",
      detail: "当前项目树为空，先刷新项目或扫描文件，方便打开章节和设定。",
      targetTab: "project"
    });
  }

  if (snapshot.currentProject.path && snapshot.projectChrome.tree.length && !snapshot.conversations.length) {
    actions.push({
      priority: "low",
      title: "创建第一条写作会话",
      detail: "建立会话后可以围绕当前章节持续追问、生成和改稿。",
      targetTab: "conversations"
    });
  }

  if (!actions.length) {
    actions.push({
      priority: "low",
      title: "继续编辑当前项目",
      detail: "项目和模型已经就绪，可以打开章节、运行技能或继续会话。",
      targetTab: "editor"
    });
  }

  return actions.slice(0, 4);
}
