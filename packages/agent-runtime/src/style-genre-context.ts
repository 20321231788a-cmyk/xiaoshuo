export type StyleGenreConstraintOptions = {
  bodyPhase?: boolean;
  compact?: boolean;
  styleLimit?: number;
  genreLimit?: number;
};

export function buildStyleGenreConstraintBlock(
  style: Record<string, unknown> | undefined | null,
  genre: Record<string, unknown> | undefined | null,
  options: StyleGenreConstraintOptions = {}
): string {
  const compact = Boolean(options.compact);
  const styleLimit = options.styleLimit ?? (compact ? 1400 : 10000);
  const genreLimit = options.genreLimit ?? (compact ? 1400 : 10000);
  const parts = [
    `【风格库】\n${clipText(JSON.stringify(style || {}), styleLimit) || "暂无"}`,
    "",
    `【题材库】\n${clipText(JSON.stringify(genre || {}), genreLimit) || "暂无"}`
  ];

  if (hasGenreContent(genre)) {
    parts.push(
      "",
      "【题材占位说明】题材库文档中的 XX 是题材占位符，需由用户手动替换；若用户未替换，则不要自行猜测具体题材设定。",
      "【题材硬约束】题材库中的世界规则、术语体系、素材边界和违禁词优先级高于模型默认发挥；若与通用套路冲突，必须以题材库为准。",
      "【题材执行要求】缺失信息时宁可保持模糊，也不得擅自发明题材库之外的新术语、新力量体系、新科技解释或违和设定。"
    );

    const bannedTerms = extractBannedTerms(genre);
    if (bannedTerms.length) {
      parts.push(`【题材违禁词】以下表达默认禁止出现，除非用户明确要求，否则命中即视为违规并需要改写：\n- ${bannedTerms.join("\n- ")}`);
    }
  }

  if (options.bodyPhase && hasGenreContent(genre)) {
    parts.push("【题材正文规则】正文阶段必须优先沿用题材库和战斗模板中的表现方式，不得写成其他题材的语言、术语、战斗逻辑和氛围质感。");
  }

  if (hasStyleContent(style)) {
    parts.push(
      "",
      "【风格库调用规则】只学习风格节奏、句式习惯、叙述密度、镜头推进与素材组织方式，严禁照抄示例原句，严禁覆盖剧情事实和角色设定。",
      "【风格模仿硬约束】若风格库中出现人称/视角、句子长短偏好、对话密度、叙述节奏、情绪浓度、禁用表达、常用转场或镜头习惯，均视为硬约束，正文必须优先对齐这些风格骨架。",
      "【风格执行顺序】先统一人称与视角，再对齐句长和停顿节奏，再对齐对白密度与情绪浓度，最后才组织具体措辞。若剧情与风格冲突，以剧情事实为先，但表达方式仍要贴合风格库。",
      "【风格执行要求】若当前文字与风格库不贴合，必须重写表达方式，不得只做表面润色；严禁为了省事回到模型默认文风。"
    );
  }

  return parts.join("\n");
}

function hasStyleContent(style: Record<string, unknown> | undefined | null): boolean {
  return Object.values(style || {}).some((value) => String(value || "").trim());
}

function hasGenreContent(genre: Record<string, unknown> | undefined | null): boolean {
  return Object.values(genre || {}).some((value) => String(value || "").trim());
}

function extractBannedTerms(genre: Record<string, unknown> | undefined | null): string[] {
  const raw = String((genre || {})["违禁词"] || "");
  const terms: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const item = line.trim().replace(/^[-*•\s]+/, "").trim();
    if (!item || item === "XX" || item.startsWith("【") || item.includes("当前题材") || item.includes("使用说明")) {
      continue;
    }
    terms.push(item);
  }
  return [...new Set(terms)].slice(0, 20);
}

function clipText(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}\n...（已压缩）`;
}
