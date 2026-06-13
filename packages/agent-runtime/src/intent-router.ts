import type { AgentIntent, SkillDefinition } from "@xiaoshuo/shared";

const GENERATION_VERBS =
  "生成|帮我写|写|创作|起草|创建|建立|扩展|扩写|扩成|展开|细化|转成|拆成|拆为|拆分|规划|整理|完善|补全|制定|输出|生成一下|写一下|做一下|弄一下|来一段|来一版|续写|接着写|继续写";
const BODY_GENERATION_VERBS = "生成|帮我写|写|创作|起草|输出|生成一下|写一下|来一段|来一版|续写|接着写|继续写";
const CHAPTER_OUTLINE_TERMS = "章纲|章节大纲|章节纲要|分章大纲|分章纲要|章节规划|单章大纲";
const DETAIL_OUTLINE_TERMS = "细纲|详纲|详细大纲";
const OUTLINE_TERMS = "大纲|故事梗概|剧情大纲|故事大纲|主线大纲|总纲";
const FILE_OPERATION_WORDS =
  "新建|创建文件|建立文件|写入|保存|保存到|保存为|存到|写进|写到|同步到|追加|插入|替换|改成|改为|覆盖|移动|挪到|归档|重命名|改名|文件名|删除|删掉|移除";
const READ_CONTEXT_WORDS =
  "总结|分析|查看|看看|读取|读一下|读下|看一下|看下|梳理|对比|当前文档|当前文件|这章|这段|选中|选区|人物设定|章纲|细纲|风格库|题材库|整个项目|前文|最近章节|上下文";
const SKILL_ACTION_WORDS = `${GENERATION_VERBS}|拆|提取|抽取|分析|润色|润一下|续写|接着写|继续写|继续来一段|仿写|模仿|检查|扫描|配置|设置|设定|建立|创建|对白|对话|片段|正文`;

const MIN_ROUTE_SCORE = 24;
const STRONG_ROUTE_SCORE = 42;
const MAX_PHRASE_OVERLAP_SCORE = 48;

export type SkillRouteIntent =
  | "outline_planning"
  | "body_writing"
  | "dialogue_or_scene"
  | "style_rewrite"
  | "polish"
  | "extract"
  | "consistency"
  | "read_context"
  | "chat";

export type RankedSkillRoute = {
  skillId: string;
  score: number;
  reasons: string[];
  signals: string[];
  skill?: SkillDefinition;
};

export type RankSkillRouteOptions = {
  manualSkillId?: string;
  currentSkillId?: string;
  limit?: number;
  includeNonRunnable?: boolean;
};

type SkillRoute = {
  skillId: string;
  pattern: RegExp;
};

type RouteSignals = {
  intent: SkillRouteIntent;
  normalized: string;
  lowered: string;
  outlinePlanning: boolean;
  chapterOutline: boolean;
  detailOutline: boolean;
  bodyWriting: boolean;
  dialogueOrScene: boolean;
  styleRewrite: boolean;
  polish: boolean;
  extract: boolean;
  styleExtract: boolean;
  loreExtract: boolean;
  consistency: boolean;
  readContext: boolean;
  fileOperation: boolean;
  continuation: boolean;
  generation: boolean;
  pureReadContext: boolean;
};

const BUILTIN_SKILL_ROUTES: SkillRoute[] = [
  { skillId: "continue_disassemble", pattern: /拆细纲|继续拆|扩展拆书|拆书细纲/ },
  { skillId: "story_deslop", pattern: /story[-_ ]?deslop|去\s*AI\s*味|去味|太\s*AI|AI味/i },
  { skillId: "polish_text", pattern: /润色|润一下|润一润|精修|改写|修文|优化表达|顺一下|打磨|去油/ },
  { skillId: "continue_text", pattern: /续写|接着写|继续写|往下写|续上|补后续|接上文|沿着上文|继续来一段|再来一段/ },
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
    pattern: new RegExp(`(${GENERATION_VERBS}).{0,32}(${OUTLINE_TERMS})|灵感.{0,12}(大纲|扩展|扩写|扩成)|脑洞.{0,12}(大纲|扩展|扩写|扩成)`)
  },
  { skillId: "lore_extract", pattern: /(提取|抽取|同步|自动提取|整理|归纳).{0,24}(设定|人设|人物|世界观|体系|地图|道具)|整理人设|提取人设/ },
  { skillId: "style_extract", pattern: /(提取|抽取|分析|总结|整理).{0,24}(风格|文风|写法|样文风格)|风格提取|文风分析/ },
  { skillId: "consistency_check", pattern: /一致性|冲突|检查冲突|审稿|设定矛盾|前后矛盾|连续性检查/ },
  { skillId: "scan_pits", pattern: /伏笔|坑点|线索|填坑|埋坑/ }
];

const BUILTIN_ROUTE_IDS = new Set(BUILTIN_SKILL_ROUTES.map((route) => route.skillId));

const BUILTIN_ROUTE_SKILLS: SkillDefinition[] = [
  makeBuiltinSkill("outline_generate", "灵感转大纲", "把灵感或要求扩展成完整小说大纲。", "prompt", ["01_大纲/大纲.txt"]),
  makeBuiltinSkill("detail_outline_generate", "大纲转细纲", "把大纲扩展为更细的剧情细纲。", "prompt", ["01_大纲/细纲.txt"]),
  makeBuiltinSkill("chapter_outline_generate", "细纲转章纲", "把细纲拆成可直接执行的章节章纲。", "prompt", ["01_大纲/章纲.txt"]),
  makeBuiltinSkill("body_generate", "章纲转正文", "依据章纲与项目上下文生成正文。", "job", ["02_正文"]),
  makeBuiltinSkill("batch_generate", "批量正文生成", "连续生成多章正文。", "job", ["02_正文"]),
  makeBuiltinSkill("continue_text", "续写", "沿着上文继续写正文。", "prompt", ["02_正文"]),
  makeBuiltinSkill("polish_text", "正文润色", "在不改剧情事实的前提下优化正文表达。", "prompt", ["02_正文/润色结果.txt"]),
  makeBuiltinSkill("story_deslop", "去AI味", "清除 AI 写作痕迹，让细纲、章纲和正文更自然。", "prompt", ["02_正文/去AI味结果.txt"]),
  makeBuiltinSkill("humanizer_zh", "去AI味", "去除 AI 写作痕迹，让生成文本更自然。", "prompt", ["02_正文/去AI味结果.txt"]),
  makeBuiltinSkill("reverse_outline_extract", "反向细纲提取", "从正文中提取真实发生的剧情推进。", "prompt", ["01_大纲/反向细纲.txt"]),
  makeBuiltinSkill("lore_extract", "设定提取", "从正文或资料中提取人物、地名、组织、能力和世界规则。", "prompt", ["00_设定集/设定集"]),
  makeBuiltinSkill("style_extract", "风格提取", "从样文中提取可复用的写作风格规则、风格示例特征和参考素材摘要。", "prompt", ["00_设定集/风格库"]),
  makeBuiltinSkill("genre_generate", "题材生成", "生成题材规则、题材素材、战斗或冲突模板和违禁词。", "prompt", ["00_设定集/题材库"]),
  makeBuiltinSkill("nuwa_style_distill", "女娲风格蒸馏", "蒸馏文风档案并复用写作风格。", "workflow", ["00_设定集/.agent/style_distillation/current.json"]),
  makeBuiltinSkill("book_fusion", "融梗", "从多本已拆书籍中融合核心设定和剧情骨架。", "workflow", ["00_设定集/融梗方案"]),
  makeBuiltinSkill("disassemble_book", "拆书", "拆解原文、样文或小说。", "workflow", ["00_设定集/拆书库"]),
  makeBuiltinSkill("continue_disassemble", "继续拆书", "继续拆书并扩展拆书细纲。", "workflow", ["01_大纲/拆书细纲.txt"]),
  makeBuiltinSkill("scan_pits", "扫描伏笔", "从正文中提取需要跟踪的伏笔并写入账本。", "job", []),
  makeBuiltinSkill("consistency_check", "一致性检查", "检查正文是否违背设定、章纲、风格和题材约束。", "job", [])
];

const ROUTE_KEYWORDS = [
  "白野式",
  "装逼",
  "对白",
  "对话",
  "片段",
  "场景",
  "正文",
  "章节",
  "成文",
  "续写",
  "风格",
  "文风",
  "仿写",
  "模仿",
  "润色",
  "改写",
  "去AI味",
  "大纲",
  "细纲",
  "章纲",
  "梗概",
  "总纲",
  "设定",
  "人设",
  "世界观",
  "一致性",
  "冲突",
  "矛盾",
  "伏笔",
  "题材"
];

const STOP_PHRASES = new Set([
  "用户",
  "请求",
  "技能",
  "项目",
  "上下文",
  "文本",
  "内容",
  "输出",
  "直接",
  "不要",
  "根据",
  "当前",
  "小说",
  "生成",
  "完整",
  "进行",
  "一个",
  "这个",
  "那个",
  "可以",
  "用于",
  "已有",
  "保留",
  "核心",
  "以及",
  "必须",
  "能力",
  "要求",
  "用户输入"
]);

export function normalizeRouteText(text: string): string {
  return String(text || "").replace(/\s+/g, "");
}

export function classifySkillRouteIntent(text: string): SkillRouteIntent {
  return detectRouteSignals(text).intent;
}

export function rankSkillRoutes(
  text: string,
  skills: SkillDefinition[] = [],
  options: RankSkillRouteOptions = {}
): RankedSkillRoute[] {
  const manualSkillId = String(options.manualSkillId || "").trim();
  if (manualSkillId) {
    const manualSkill = skills.find((skill) => skill.id === manualSkillId);
    return [
      {
        skillId: manualSkillId,
        score: 10000,
        reasons: ["用户明确指定技能。"],
        signals: ["manual_skill_id"],
        ...(manualSkill ? { skill: manualSkill } : {})
      }
    ];
  }

  const normalized = normalizeRouteText(text);
  if (!normalized) {
    return [];
  }

  const routeSignals = detectRouteSignals(text);
  if (routeSignals.pureReadContext) {
    return [];
  }

  const candidates = skills
    .filter((skill) => !skill.disabled)
    .filter((skill) => options.includeNonRunnable || isRunnableByRoute(skill));
  const ranked = candidates
    .map((skill) => scoreSkillRoute(text, skill, routeSignals, options.currentSkillId || ""))
    .filter((candidate): candidate is RankedSkillRoute => Boolean(candidate && candidate.score >= MIN_ROUTE_SCORE))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.skillId.localeCompare(right.skillId, "zh-CN");
    });

  return ranked.slice(0, Math.max(1, options.limit || ranked.length));
}

export function routeBuiltinSkill(text: string, disabledSkillIds: Set<string> = new Set()): string {
  const builtins = BUILTIN_ROUTE_SKILLS.filter((skill) => !disabledSkillIds.has(skill.id));
  const ranked = rankSkillRoutes(text, builtins, { includeNonRunnable: true, limit: 8 });
  return ranked.find((candidate) => BUILTIN_ROUTE_IDS.has(candidate.skillId))?.skillId || "";
}

export function routeNamedSkill(text: string, skills: SkillDefinition[]): string {
  const ranked = rankSkillRoutes(text, skills, { limit: 12 });
  const named = ranked.find(
    (candidate) =>
      candidate.skill &&
      !isBuiltinSkill(candidate.skill) &&
      ["prompt", "external"].includes(candidate.skill.handler_type) &&
      candidate.signals.some((signal) => signal === "explicit_name" || signal === "explicit_id" || signal === "description_match" || signal === "phrase_overlap")
  );
  return named?.skillId || "";
}

export function resolveSkillRoute(text: string, manualSkillId = "", skills: SkillDefinition[] = []): string {
  const explicit = String(manualSkillId || "").trim();
  if (explicit) {
    return explicit;
  }
  return rankSkillRoutes(text, skills, { limit: 1 })[0]?.skillId || "";
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
  const routeSignals = detectRouteSignals(normalizedText);
  const ranked = rankSkillRoutes(normalizedText, skills, { limit: 1 });
  const top = ranked[0];

  if (top && shouldAutoCallSkill(top, routeSignals, normalizedText)) {
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
  if (top && top.score >= STRONG_ROUTE_SCORE && !routeSignals.pureReadContext && hasSkillAction(normalizedText)) {
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

function scoreSkillRoute(text: string, skill: SkillDefinition, routeSignals: RouteSignals, currentSkillId: string): RankedSkillRoute | null {
  const normalizedText = routeSignals.normalized;
  const lowered = routeSignals.lowered;
  const haystack = skillHaystack(skill);
  const reasons: string[] = [];
  const signals: string[] = [`intent:${routeSignals.intent}`];
  let score = 0;

  for (const route of BUILTIN_SKILL_ROUTES) {
    if (route.skillId === skill.id && route.pattern.test(normalizedText)) {
      score += 72;
      reasons.push("内置规则命中。");
      signals.push("builtin_rule");
      break;
    }
  }

  const idText = normalizeRouteText(skill.id).toLowerCase();
  const idSpaced = String(skill.id || "").toLowerCase().replaceAll("_", " ");
  if (idText && (normalizedText.toLowerCase().includes(idText) || lowered.includes(idSpaced))) {
    score += 130;
    reasons.push("用户输入包含 skill id。");
    signals.push("explicit_id");
  }

  const nameText = normalizeRouteText(skill.name || "").toLowerCase();
  if (nameText && nameText.length >= 2 && normalizedText.toLowerCase().includes(nameText)) {
    score += 130;
    reasons.push("用户输入包含 skill 名称。");
    signals.push("explicit_name");
  }

  if (skillDescriptionMatches(text, skill.description || "")) {
    score += 34;
    reasons.push("技能描述与用户请求相近。");
    signals.push("description_match");
  }

  const phraseScore = scorePhraseOverlap(normalizedText, skill);
  if (phraseScore > 0) {
    score += phraseScore;
    reasons.push("技能文本与用户请求存在关键词重合。");
    signals.push("phrase_overlap");
  }

  score += scoreProductFit(skill, haystack, routeSignals, reasons, signals);

  if (currentSkillId && skill.id === currentSkillId) {
    if (isCurrentSkillCompatible(skill, haystack, routeSignals)) {
      score += routeSignals.continuation ? 124 : 72;
      reasons.push("当前会话技能与本轮语义兼容。");
      signals.push("current_skill");
    } else {
      score -= 48;
      signals.push("current_skill_incompatible");
    }
  }

  if (skill.id === "outline_generate" && !routeSignals.outlinePlanning && (routeSignals.bodyWriting || routeSignals.dialogueOrScene || routeSignals.styleRewrite)) {
    score -= 90;
    reasons.push("用户要的是正文/对白/风格写作，不是大纲。");
    signals.push("outline_downranked_for_writing");
  }

  if (score < MIN_ROUTE_SCORE) {
    return null;
  }
  return {
    skillId: skill.id,
    score: Math.round(score),
    reasons: uniqueStrings(reasons).slice(0, 8),
    signals: uniqueStrings(signals).slice(0, 16),
    skill
  };
}

function scoreProductFit(
  skill: SkillDefinition,
  haystack: string,
  routeSignals: RouteSignals,
  reasons: string[],
  signals: string[]
): number {
  const id = skill.id;
  const importedPrompt = !isBuiltinSkill(skill) && ["prompt", "external"].includes(skill.handler_type);
  let score = 0;

  if (routeSignals.outlinePlanning) {
    if (routeSignals.chapterOutline && id === "chapter_outline_generate") {
      score += 94;
      reasons.push("用户明确要求章节规划/章纲。");
      signals.push("product:chapter_outline");
    } else if (routeSignals.detailOutline && id === "detail_outline_generate") {
      score += 94;
      reasons.push("用户明确要求细纲/详纲。");
      signals.push("product:detail_outline");
    } else if (id === "outline_generate") {
      score += 94;
      reasons.push("用户明确要求大纲/梗概。");
      signals.push("product:outline");
    } else if (/大纲|细纲|章纲|outline/.test(haystack)) {
      score += 34;
      signals.push("product:outline_related");
    }
  }

  if (routeSignals.bodyWriting) {
    if (id === "body_generate") {
      score += 82;
      reasons.push("用户明确要求正文。");
      signals.push("product:body");
    } else if (id === "batch_generate") {
      score += 48;
      signals.push("product:body_batch");
    } else if (/正文|章节正文|成文|body|chapter|写作|续写/.test(haystack)) {
      score += importedPrompt ? 54 : 38;
      signals.push("product:body_related");
    }
  }

  if (routeSignals.dialogueOrScene) {
    if (/对白|对话|dialogue|台词|片段|场景|桥段|scene|短篇|段落|装逼/.test(haystack)) {
      score += importedPrompt ? 72 : 42;
      reasons.push("用户要求对白/片段/场景，技能语义匹配。");
      signals.push("product:dialogue_scene");
    } else if (id === "body_generate") {
      score += 18;
      signals.push("product:dialogue_as_body");
    }
  }

  if (routeSignals.styleRewrite) {
    if (/风格|文风|仿写|模仿|style|rewrite|语感|口吻|式/.test(haystack)) {
      score += importedPrompt ? 76 : 44;
      reasons.push("用户要求风格写作/仿写，技能语义匹配。");
      signals.push("product:style_rewrite");
    }
    if (id === "style_extract" && !routeSignals.extract) {
      score -= 52;
      signals.push("style_extract_downranked_for_writing");
    }
  }

  if (routeSignals.polish) {
    if (id === "polish_text" || id === "story_deslop" || id === "humanizer_zh") {
      score += 88;
      reasons.push("用户明确要求润色/去AI味。");
      signals.push("product:polish");
    } else if (/润色|改写|优化|polish|humanizer|deslop|去ai味|去味/.test(haystack)) {
      score += importedPrompt ? 68 : 42;
      signals.push("product:polish_related");
    }
  }

  if (routeSignals.extract) {
    if (routeSignals.loreExtract && id === "lore_extract") {
      score += 92;
      reasons.push("用户明确要求提取设定。");
      signals.push("product:lore_extract");
    } else if (routeSignals.styleExtract && id === "style_extract") {
      score += 92;
      reasons.push("用户明确要求提取风格。");
      signals.push("product:style_extract");
    } else if (/提取|抽取|extract|设定|人设|世界观|风格|文风|细纲/.test(haystack)) {
      score += 42;
      signals.push("product:extract_related");
    }
  }

  if (routeSignals.consistency) {
    if (id === "consistency_check") {
      score += 96;
      reasons.push("用户明确要求一致性/冲突检查。");
      signals.push("product:consistency");
    } else if (/一致性|冲突|矛盾|检查|审稿|consistency/.test(haystack)) {
      score += 46;
      signals.push("product:consistency_related");
    }
  }

  if (routeSignals.continuation) {
    if (id === "continue_text") {
      score += 66;
      reasons.push("用户要求续写/继续。");
      signals.push("product:continue");
    } else if (importedPrompt && /写作|风格|文风|对白|对话|正文|片段|续写/.test(haystack)) {
      score += 34;
      signals.push("product:continue_with_prompt_skill");
    }
  }

  return score;
}

function detectRouteSignals(text: string): RouteSignals {
  const normalized = normalizeRouteText(text);
  const lowered = String(text || "").toLowerCase();
  const generation = new RegExp(GENERATION_VERBS).test(normalized);
  const fileOperation = isFileOperationIntent(normalized);
  const chapterOutline = new RegExp(CHAPTER_OUTLINE_TERMS).test(normalized);
  const detailOutline = new RegExp(DETAIL_OUTLINE_TERMS).test(normalized);
  const outlineMention = new RegExp(OUTLINE_TERMS).test(normalized) || chapterOutline || detailOutline;
  const outlinePlanning =
    (outlineMention && /(生成|写|扩展|扩写|扩成|展开|细化|规划|拆分|制定|整理|完善|补全|转成)/.test(normalized)) ||
    /(灵感|脑洞).{0,16}(大纲|梗概|总纲|扩成|扩展|扩写)/.test(normalized);
  const bodyWriting =
    /(来一段正文|一段正文|写成文|写一章)/.test(normalized) ||
    (/(正文|章节正文|正文稿|成文)/.test(normalized) && /(生成|帮我写|写一段|写正文|创作|起草|输出|续写|接着写|继续写|来一段|来一版)/.test(normalized)) ||
    /(生成|帮我写|写|创作|续写|接着写|继续写|来一段|来一版).{0,24}(第\s*\d{1,4}\s*章|章节)/.test(normalized);
  const dialogueOrScene =
    /(对白|对话|台词|片段|场景|桥段|来一段|来一版|装逼|爽点|短段|短篇|一幕)/.test(normalized) &&
    !outlinePlanning;
  const styleRewrite =
    /(仿写|模仿|风格仿|按.{0,16}(风格|文风|语气|口吻).{0,12}(写|来|改|输出)|[A-Za-z0-9_\u4e00-\u9fff]{1,24}式.{0,16}(写|对白|对话|正文|片段|风格|装逼))/.test(
      normalized
    ) && !outlinePlanning;
  const polish = /(润色|润一下|润一润|精修|修文|优化表达|打磨|去\s*AI\s*味|去AI味|去味|太AI|改写)/i.test(normalized);
  const styleExtract = /(提取|抽取|分析|总结|整理).{0,24}(风格|文风|写法|样文风格)|风格提取|文风分析/.test(normalized);
  const loreExtract = /(提取|抽取|同步|自动提取|整理|归纳).{0,24}(设定|人设|人物|世界观|体系|地图|道具)|整理人设|提取人设/.test(normalized);
  const extract = styleExtract || loreExtract || /提取|抽取|extract/i.test(normalized);
  const consistency = /一致性|冲突|检查冲突|审稿|设定矛盾|前后矛盾|连续性检查|矛盾检查/.test(normalized);
  const readContext = isReadContextIntent(normalized);
  const continuation = /续写|接着写|继续写|往下写|续上|补后续|接上文|沿着上文|继续来一段|再来一段/.test(normalized);
  const actionableProduct = outlinePlanning || bodyWriting || dialogueOrScene || styleRewrite || polish || extract || consistency || continuation;
  const pureReadContext = readContext && !actionableProduct && !generation && !fileOperation;
  const intent = resolveRouteIntent({
    outlinePlanning,
    bodyWriting,
    dialogueOrScene,
    styleRewrite,
    polish,
    extract,
    consistency,
    readContext,
    pureReadContext
  });

  return {
    intent,
    normalized,
    lowered,
    outlinePlanning,
    chapterOutline,
    detailOutline,
    bodyWriting,
    dialogueOrScene,
    styleRewrite,
    polish,
    extract,
    styleExtract,
    loreExtract,
    consistency,
    readContext,
    fileOperation,
    continuation,
    generation,
    pureReadContext
  };
}

function resolveRouteIntent(input: {
  outlinePlanning: boolean;
  bodyWriting: boolean;
  dialogueOrScene: boolean;
  styleRewrite: boolean;
  polish: boolean;
  extract: boolean;
  consistency: boolean;
  readContext: boolean;
  pureReadContext: boolean;
}): SkillRouteIntent {
  if (input.consistency) {
    return "consistency";
  }
  if (input.extract) {
    return "extract";
  }
  if (input.polish) {
    return "polish";
  }
  if (input.styleRewrite) {
    return "style_rewrite";
  }
  if (input.dialogueOrScene) {
    return "dialogue_or_scene";
  }
  if (input.bodyWriting) {
    return "body_writing";
  }
  if (input.outlinePlanning) {
    return "outline_planning";
  }
  if (input.pureReadContext || input.readContext) {
    return "read_context";
  }
  return "chat";
}

function shouldAutoCallSkill(candidate: RankedSkillRoute, routeSignals: RouteSignals, text: string): boolean {
  if (routeSignals.pureReadContext || routeSignals.intent === "chat") {
    return false;
  }
  if (candidate.signals.includes("manual_skill_id")) {
    return true;
  }
  if (routeSignals.extract || routeSignals.consistency || routeSignals.polish || routeSignals.outlinePlanning || routeSignals.bodyWriting) {
    return candidate.score >= MIN_ROUTE_SCORE && hasSkillAction(text);
  }
  if (routeSignals.dialogueOrScene || routeSignals.styleRewrite || routeSignals.continuation) {
    return candidate.score >= STRONG_ROUTE_SCORE && hasSkillAction(text);
  }
  return candidate.score >= STRONG_ROUTE_SCORE && hasSkillAction(text);
}

function isCurrentSkillCompatible(skill: SkillDefinition, haystack: string, routeSignals: RouteSignals): boolean {
  if (routeSignals.pureReadContext || routeSignals.fileOperation) {
    return false;
  }
  if (routeSignals.outlinePlanning) {
    return /大纲|细纲|章纲|outline/.test(haystack);
  }
  if (skill.id === "outline_generate" || skill.id === "detail_outline_generate" || skill.id === "chapter_outline_generate") {
    return false;
  }
  if (routeSignals.bodyWriting || routeSignals.dialogueOrScene || routeSignals.styleRewrite || routeSignals.continuation) {
    return /写作|风格|文风|正文|对白|对话|片段|场景|续写|body|dialogue|style/.test(haystack);
  }
  if (routeSignals.polish) {
    return /润色|改写|优化|去ai味|polish|deslop|humanizer/.test(haystack);
  }
  if (routeSignals.extract) {
    return /提取|抽取|设定|风格|文风|extract/.test(haystack);
  }
  if (routeSignals.consistency) {
    return /一致性|冲突|矛盾|检查|consistency/.test(haystack);
  }
  return false;
}

function skillDescriptionMatches(text: string, description: string): boolean {
  const normalizedText = normalizeRouteText(text).toLowerCase();
  const normalizedDescription = normalizeRouteText(description).toLowerCase();
  if (normalizedDescription.length >= 6 && normalizedText.includes(normalizedDescription.slice(0, 80))) {
    return true;
  }
  const tokens = description
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 4 && !["skill", "prompt", "project", "conversation"].includes(token))
    .slice(0, 12);
  if (!tokens.length) {
    return false;
  }
  const matches = tokens.filter((token) => normalizedText.includes(normalizeRouteText(token)));
  return matches.some((token) => token.length >= 8) || matches.length >= 2;
}

function scorePhraseOverlap(normalizedText: string, skill: SkillDefinition): number {
  let score = 0;
  for (const phrase of skillMatchPhrases(skill)) {
    if (!phrase || !normalizedText.includes(phrase)) {
      continue;
    }
    score += phrase.length >= 4 ? 12 : 7;
    if (score >= MAX_PHRASE_OVERLAP_SCORE) {
      return MAX_PHRASE_OVERLAP_SCORE;
    }
  }
  return score;
}

function skillMatchPhrases(skill: SkillDefinition): string[] {
  const source = [
    skill.id.replaceAll("_", " "),
    skill.name,
    skill.description,
    String(skill.prompt || "").slice(0, 800),
    ...(skill.linked_targets || []),
    ...(skill.context_requirements || [])
  ].join(" ");
  const phrases = new Set<string>();
  for (const keyword of ROUTE_KEYWORDS) {
    if (source.includes(keyword)) {
      phrases.add(normalizeRouteText(keyword).toLowerCase());
    }
  }
  for (const token of source.split(/[^\p{L}\p{N}_]+/u)) {
    const normalized = normalizeRouteText(token).toLowerCase();
    if (normalized.length >= 2 && normalized.length <= 24 && !STOP_PHRASES.has(normalized)) {
      phrases.add(normalized);
    }
  }
  for (const run of source.match(/[\u4e00-\u9fff]{2,28}/g) || []) {
    if (run.length <= 6 && !STOP_PHRASES.has(run)) {
      phrases.add(run);
    }
    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const phrase = run.slice(index, index + size);
        if (!STOP_PHRASES.has(phrase)) {
          phrases.add(phrase);
        }
        if (phrases.size >= 120) {
          return [...phrases];
        }
      }
    }
  }
  return [...phrases].slice(0, 120);
}

function skillHaystack(skill: SkillDefinition): string {
  return normalizeRouteText(
    [
      skill.id,
      skill.name,
      skill.description,
      skill.prompt,
      ...(skill.linked_targets || []),
      ...(skill.context_requirements || [])
    ].join(" ")
  ).toLowerCase();
}

function isRunnableByRoute(skill: SkillDefinition): boolean {
  return ["prompt", "workflow", "job", "external"].includes(skill.handler_type);
}

function isBuiltinSkill(skill: SkillDefinition): boolean {
  return Boolean(skill.builtin) || (BUILTIN_ROUTE_IDS.has(skill.id) && !skill.imported_from);
}

function makeBuiltinSkill(
  id: string,
  name: string,
  description: string,
  handlerType: SkillDefinition["handler_type"],
  linkedTargets: string[]
): SkillDefinition {
  return {
    id,
    name,
    description,
    input_mode: "text",
    context_requirements: ["project_state"],
    handler_type: handlerType,
    linked_targets: linkedTargets,
    prompt: description,
    imported_from: "",
    writable: true,
    builtin: true,
    disabled: false
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
