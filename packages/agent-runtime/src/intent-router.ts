import type { AgentIntent, SkillDefinition } from "@xiaoshuo/shared";

const GENERATION_VERBS =
  "生成|帮我写|写|创作|起草|创建|建立|扩展|扩写|扩成|展开|细化|转成|拆成|拆为|拆分|规划|整理|完善|补全|制定|输出|生成一下|写一下|做一下|弄一下";
const BODY_GENERATION_VERBS = "生成|帮我写|写|创作|起草|输出|生成一下|写一下";
const CHAPTER_OUTLINE_TERMS = "章纲|章节大纲|章节纲要|分章大纲|分章纲要|章节规划|单章大纲";
const DETAIL_OUTLINE_TERMS = "细纲|详纲|详细大纲";
const OUTLINE_TERMS = "大纲|故事梗概|剧情大纲|故事大纲|主线大纲|总纲";
const FILE_OPERATION_WORDS =
  "新建|创建文件|建立文件|写入|保存|保存到|保存为|存到|写进|写到|同步到|追加|插入|替换|改成|改为|覆盖|移动|挪到|归档|重命名|改名|文件名|删除|删掉|移除";
const READ_CONTEXT_WORDS =
  "总结|分析|查看|看看|读取|读一下|读下|看一下|看下|梳理|对比|当前文档|当前文件|这章|这段|选中|选区|人物设定|章纲|细纲|风格库|题材库|整个项目|前文|最近章节|上下文";
const SKILL_ACTION_WORDS = `${GENERATION_VERBS}|拆|提取|抽取|分析|润色|润一下|续写|接着写|检查|扫描|配置|设置|设定|建立|创建`;

type SkillRoute = {
  skillId: string;
  pattern: RegExp;
};

const BUILTIN_SKILL_ROUTES: SkillRoute[] = [
  { skillId: "continue_disassemble", pattern: /拆细纲|继续拆|扩展拆书|拆书细纲/ },
  { skillId: "story_deslop", pattern: /story[-_ ]?deslop|去\s*AI\s*味|去味|太\s*AI|AI味/i },
  { skillId: "polish_text", pattern: /润色|润一下|润一润|精修|改写|修文|优化表达|顺一下|打磨|去油/ },
  { skillId: "continue_text", pattern: /续写|接着写|继续写|往下写|续上|补后续|接上文|沿着上文/ },
  {
    skillId: "batch_generate",
    pattern:
      /(批量|连续|连写|多章|一口气).{0,24}(生成|写|续写|创作).{0,24}(正文|章节|第\s*\d{1,4}\s*章)|(生成|写|续写|创作).{0,24}第\s*\d{1,4}\s*(?:章)?\s*(?:到|至|[-~－—])\s*(?:第\s*)?\d{1,4}\s*章.{0,12}(正文|章节)?/
  },
  {
    skillId: "body_generate",
    pattern: new RegExp(
      `(${BODY_GENERATION_VERBS}).{0,24}(正文|章节正文|第\\s*\\d{1,4}\\s*章)|(${CHAPTER_OUTLINE_TERMS}).{0,24}(正文|成文|正文稿)`
    )
  },
  { skillId: "reverse_outline_extract", pattern: /反向细纲|倒推细纲|逆向细纲|提取细纲|从正文.{0,24}细纲|正文.{0,24}倒推/ },
  { skillId: "nuwa_style_distill", pattern: /nuwa|女娲|蒸馏|文风档案|风格档案|拆书.{0,12}文风|文风.{0,12}复用/ },
  { skillId: "book_fusion", pattern: /融梗|融合.{0,12}(设定|剧情|核心|书籍|题材)|三本.{0,24}(融合|参考|融梗)|多本.{0,24}(融合|参考|融梗)/ },
  { skillId: "disassemble_book", pattern: /拆书|拆解原文|拆解样文|拆解小说|一键拆/ },
  {
    skillId: "chapter_outline_generate",
    pattern: new RegExp(`(${GENERATION_VERBS}).{0,48}(${CHAPTER_OUTLINE_TERMS})|(${CHAPTER_OUTLINE_TERMS}).{0,28}(${GENERATION_VERBS}|拆|规划|拆分)`)
  },
  {
    skillId: "detail_outline_generate",
    pattern: new RegExp(`(${GENERATION_VERBS}).{0,40}(${DETAIL_OUTLINE_TERMS})|(${DETAIL_OUTLINE_TERMS}).{0,24}(生成|扩写|扩成|展开|细化|完善|补全|整理|规划)`)
  },
  {
    skillId: "genre_generate",
    pattern: /(生成|创建|建立|配置|设置|设定|补全|完善|写).{0,24}(题材库|题材规则|题材素材|战斗模板|违禁词)|题材库.{0,24}(生成|创建|建立|配置|设置|设定|补全|完善|配置好)/
  },
  {
    skillId: "outline_generate",
    pattern: new RegExp(`(${GENERATION_VERBS}).{0,32}(${OUTLINE_TERMS})|灵感.{0,12}(大纲|扩展|扩写)|脑洞.{0,12}(大纲|扩展|扩写)`)
  },
  { skillId: "lore_extract", pattern: /(提取|抽取|同步|自动提取|整理|归纳).{0,24}(设定|人设|人物|世界观|体系|地图|道具)|整理人设|提取人设/ },
  { skillId: "style_extract", pattern: /(提取|抽取|分析|总结|整理).{0,24}(风格|文风|写法|样文风格)|风格提取|文风分析/ },
  { skillId: "consistency_check", pattern: /一致性|冲突|检查冲突|审稿|设定矛盾|前后矛盾|连续性检查/ },
  { skillId: "scan_pits", pattern: /伏笔|坑点|线索|填坑|埋坑/ }
];

export function normalizeRouteText(text: string): string {
  return String(text || "").replace(/\s+/g, "");
}

export function routeBuiltinSkill(text: string, disabledSkillIds: Set<string> = new Set()): string {
  const normalized = normalizeRouteText(text);
  if (!normalized) {
    return "";
  }
  for (const route of BUILTIN_SKILL_ROUTES) {
    if (disabledSkillIds.has(route.skillId)) {
      continue;
    }
    if (route.pattern.test(normalized)) {
      return route.skillId;
    }
  }
  return "";
}

export function routeNamedSkill(text: string, skills: SkillDefinition[]): string {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) {
    return "";
  }
  for (const skill of skills) {
    if (skill.disabled) {
      continue;
    }
    if (!["prompt", "external"].includes(skill.handler_type)) {
      continue;
    }
    const skillName = String(skill.name || "").toLowerCase();
    const skillIdText = String(skill.id || "").toLowerCase().replaceAll("_", " ");
    if ((skillName && normalized.includes(skillName)) || (skillIdText && normalized.includes(skillIdText))) {
      return skill.id;
    }
  }
  return "";
}

export function resolveSkillRoute(text: string, manualSkillId = "", skills: SkillDefinition[] = []): string {
  const explicit = String(manualSkillId || "").trim();
  if (explicit) {
    return explicit;
  }
  const disabledSkillIds = new Set(skills.filter((skill) => skill.disabled).map((skill) => skill.id));
  return routeBuiltinSkill(text, disabledSkillIds) || routeNamedSkill(text, skills);
}

export function hasSkillAction(text: string): boolean {
  return new RegExp(SKILL_ACTION_WORDS).test(normalizeRouteText(text));
}

export function isFileOperationIntent(text: string): boolean {
  return new RegExp(FILE_OPERATION_WORDS).test(normalizeRouteText(text));
}

export function isReadContextIntent(text: string): boolean {
  return new RegExp(READ_CONTEXT_WORDS, "i").test(normalizeRouteText(text));
}

export function classifyAgentIntent(text: string, manualSkillId = "", skills: SkillDefinition[] = []): AgentIntent {
  if (String(manualSkillId || "").trim()) {
    return "skill";
  }

  const normalizedText = String(text || "");
  const lowered = normalizedText.toLowerCase();
  const skillId = resolveSkillRoute(normalizedText, "", skills);

  if (skillId && hasSkillAction(normalizedText)) {
    return "skill";
  }

  const writingTargetIntent =
    /(补充|补全|完善|补齐|填充|整理完整|扩写|扩充|丰富|修订|更新)/.test(normalizedText) &&
    /(设定集|人物设定|体系设定|地图设定|道具设定|风格库|题材库|大纲|章纲|细纲|正文|文档|文件)/.test(normalizedText);
  const destructiveFileIntent =
    /(删除|删掉|移除|清除|归档|丢进回收站|移到回收站)/.test(normalizedText) &&
    /(文件|文档|当前文档|这篇|这章|第\s*\d+\s*章|\.txt|\.md|设定|大纲|细纲|正文|章节|项目树)/.test(normalizedText);

  if (writingTargetIntent || destructiveFileIntent || isFileOperationIntent(normalizedText)) {
    return "file_operation";
  }
  if (skillId) {
    return "skill";
  }
  if (isReadContextIntent(normalizedText)) {
    return "read_context";
  }
  if (/\b(read|context|outline|polish|continue|rename|delete|move)\b/.test(lowered)) {
    return /\b(read|context)\b/.test(lowered) ? "read_context" : "chat";
  }
  return "chat";
}
