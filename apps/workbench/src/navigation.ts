import {
  ArrowLeftRight,
  BookCheck,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Home,
  Library,
  ListChecks,
  Network,
  PenLine,
  Pin,
  Settings,
  Tags,
  Users,
  WandSparkles
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type CenterFeature =
  | "home"
  | "editor"
  | "conversations"
  | "outline"
  | "clues"
  | "sources"
  | "style"
  | "studio"
  | "review"
  | "memory"
  | "crawl"
  | "batch"
  | "transfer"
  | "skills"
  | "tasks"
  | "settings"
  | "timeline"
  | "settings-set"
  | "style-library"
  | "theme-library"
  | "card_draw"
  | "ledger"
  | "revision"
  | "traces"
  | "novel_agent"
  | "vector_test"
  | "consistency"
  | "terminal";

export type NavigationItem = {
  feature: CenterFeature;
  label: string;
  icon: LucideIcon;
};

export const workbenchNavigation: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "写作",
    items: [
      { feature: "home", label: "项目首页", icon: Home },
      { feature: "editor", label: "正文编辑", icon: PenLine },
      { feature: "conversations", label: "AI 助手", icon: Bot }
    ]
  },
  {
    label: "规划",
    items: [
      { feature: "outline", label: "故事大纲", icon: Network },
      { feature: "clues", label: "伏笔与时间线", icon: Pin }
    ]
  },
  {
    label: "资料",
    items: [
      { feature: "sources", label: "设定资料", icon: Library },
      { feature: "style", label: "风格与题材", icon: Tags }
    ]
  },
  {
    label: "审阅",
    items: [
      { feature: "studio", label: "小说编辑室", icon: Users },
      { feature: "review", label: "全文审阅", icon: BookCheck },
      { feature: "memory", label: "项目记忆", icon: Brain }
    ]
  },
  {
    label: "工具",
    items: [
      { feature: "crawl", label: "拆书工作台", icon: BookOpen },
      { feature: "batch", label: "批量章节生成", icon: WandSparkles },
      { feature: "transfer", label: "素材迁移", icon: ArrowLeftRight },
      { feature: "skills", label: "创作工具", icon: Boxes }
    ]
  },
  {
    label: "全局",
    items: [
      { feature: "tasks", label: "后台任务", icon: ListChecks },
      { feature: "settings", label: "设置", icon: Settings }
    ]
  }
];

export function navigationLabel(feature: CenterFeature): string {
  for (const group of workbenchNavigation) {
    const item = group.items.find((candidate) => candidate.feature === feature);
    if (item) return item.label;
  }
  const diagnostics: Partial<Record<CenterFeature, string>> = {
    traces: "Agent 运行",
    vector_test: "连接与检索测试",
    terminal: "终端",
    revision: "修订日志",
    ledger: "伏笔台账",
    timeline: "时间线",
    consistency: "一致性检查",
    novel_agent: "小说编辑室"
  };
  return diagnostics[feature] || "ArcWriter";
}
