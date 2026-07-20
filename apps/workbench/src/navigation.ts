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
  UserFeature | DiagnosticFeature | LegacyFeature;

export type UserFeature =
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
  | "settings";

export type SettingsSection = "ai" | "writing" | "backup" | "privacy" | "shortcuts" | "about";

export type ProductRoute =
  | { feature: Exclude<UserFeature, "settings" | "skills"> }
  | { feature: "settings"; section: SettingsSection }
  | { feature: "skills"; skillId?: string; mode?: "view" | "edit" | "versions" }
  | { feature: "skills"; mode: "import"; skillId?: never };

export type ProductCommand = {
  id: string;
  label: string;
  detail: string;
  keywords: string[];
  route: ProductRoute;
};

/** Internal surfaces are intentionally excluded from production navigation. */
export type DiagnosticFeature = "traces" | "vector_test" | "terminal";

/**
 * Compatibility-only route names kept while old modules are removed. They are
 * never registered in navigation or production page routing.
 */
export type LegacyFeature =
  | "timeline"
  | "settings-set"
  | "style-library"
  | "theme-library"
  | "card_draw"
  | "ledger"
  | "revision"
  | "novel_agent"
  | "consistency";

export type NavigationItem = {
  feature: UserFeature;
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
];

export const workbenchFooterNavigation: NavigationItem[] = [
  { feature: "tasks", label: "后台任务", icon: ListChecks },
  { feature: "settings", label: "设置", icon: Settings }
];

const featurePaths: Record<UserFeature, string> = {
  home: "/home",
  editor: "/editor",
  conversations: "/assistant",
  outline: "/outline",
  clues: "/clues",
  sources: "/sources",
  style: "/style",
  studio: "/studio",
  review: "/review",
  memory: "/memory",
  crawl: "/disassembly",
  batch: "/batch",
  transfer: "/transfer",
  skills: "/tools",
  tasks: "/tasks",
  settings: "/settings/ai"
};

const pathFeatures = new Map(Object.entries(featurePaths).map(([feature, path]) => [path, feature as UserFeature]));

export function defaultProductRoute(feature: UserFeature): ProductRoute {
  if (feature === "settings") return { feature, section: "ai" };
  if (feature === "skills") return { feature };
  return { feature } as ProductRoute;
}

export function productRoutePath(route: ProductRoute): string {
  if (route.feature === "settings") return `/settings/${route.section}`;
  if (route.feature === "skills" && route.mode === "import") return "/tools/import";
  if (route.feature === "skills" && route.skillId) {
    const suffix = route.mode && route.mode !== "view" ? `/${route.mode}` : "";
    return `/tools/skills/${encodeURIComponent(route.skillId)}${suffix}`;
  }
  return featurePaths[route.feature];
}

export function parseProductRoute(pathname: string): ProductRoute | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const settings = /^\/settings\/(ai|writing|backup|privacy|shortcuts|about)$/.exec(normalized);
  if (settings) return { feature: "settings", section: settings[1] as SettingsSection };
  if (normalized === "/tools/import") return { feature: "skills", mode: "import" };
  const skill = /^\/tools\/skills\/([^/]+)(?:\/(edit|versions))?$/.exec(normalized);
  if (skill) {
    return {
      feature: "skills",
      skillId: decodeURIComponent(skill[1]!),
      mode: (skill[2] as "edit" | "versions" | undefined) || "view"
    };
  }
  const feature = pathFeatures.get(normalized);
  return feature ? defaultProductRoute(feature) : null;
}

export const productCommands: ProductCommand[] = [
  ...workbenchNavigation.flatMap((group) => group.items.map((item) => ({
    id: `open-${item.feature}`,
    label: item.label,
    detail: `打开${group.label}页面`,
    keywords: [group.label, item.label],
    route: defaultProductRoute(item.feature)
  }))),
  ...workbenchFooterNavigation.map((item) => ({
    id: `open-${item.feature}`,
    label: item.label,
    detail: item.feature === "settings" ? "打开 AI 配置与应用设置" : "查看生成与审阅任务",
    keywords: [item.label],
    route: defaultProductRoute(item.feature)
  }))
];

export function navigationLabel(feature: CenterFeature): string {
  for (const group of workbenchNavigation) {
    const item = group.items.find((candidate) => candidate.feature === feature);
    if (item) return item.label;
  }
  const diagnostics: Partial<Record<DiagnosticFeature | LegacyFeature, string>> = {
    traces: "Agent 运行",
    vector_test: "连接与检索测试",
    terminal: "终端",
    timeline: "故事时间线",
    "settings-set": "设定资料",
    "style-library": "风格库",
    "theme-library": "题材库",
    card_draw: "抽卡",
    ledger: "伏笔台账",
    revision: "版本历史",
    novel_agent: "小说编辑室",
    consistency: "全文审阅"
  };
  return diagnostics[feature as DiagnosticFeature | LegacyFeature] || "ArcWriter";
}
