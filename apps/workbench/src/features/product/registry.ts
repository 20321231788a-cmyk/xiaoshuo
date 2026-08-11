import type { UserFeature } from "../../navigation.js";

export interface PageDefinition {
  feature: UserFeature;
  title: string;
  detail: string;
}

export const registeredPages: PageDefinition[] = [
  { feature: "home", title: "项目首页", detail: "继续最近工作" },
  { feature: "editor", title: "正文编辑", detail: "当前文档" },
  { feature: "conversations", title: "AI 写作助手", detail: "当前会话" },
  { feature: "outline", title: "故事大纲", detail: "主线与章节结构" },
  { feature: "clues", title: "伏笔与时间线", detail: "全书规划" },
  { feature: "sources", title: "设定资料", detail: "人物、地点与世界规则" },
  { feature: "style", title: "风格与题材", detail: "项目写作规则" },
  { feature: "studio", title: "小说编辑室", detail: "多角色审稿" },
  { feature: "review", title: "全文审阅", detail: "质量检查" },
  { feature: "memory", title: "项目记忆", detail: "待确认内容" },
  { feature: "crawl", title: "拆书工作台", detail: "参考书库" },
  { feature: "batch", title: "批量章节生成", detail: "生成计划" },
  { feature: "transfer", title: "素材迁移", detail: "跨项目复制设定与素材" },
  { feature: "skills", title: "创作工具", detail: "项目可用能力" },
  { feature: "tasks", title: "后台任务", detail: "可暂停、可恢复" },
  { feature: "settings", title: "设置", detail: "模型、写作与应用" }
];
