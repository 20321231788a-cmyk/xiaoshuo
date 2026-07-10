import type { GeneratedSavePlan } from "@xiaoshuo/shared";
import path from "node:path";

export type SectionedGeneratedSkillId = "style_extract" | "genre_generate" | "lore_extract";

export type PreparedSectionedGeneratedSave = {
  title: string;
  target_path: string;
  content: string;
  mode: "replace" | "append";
  action_key: string;
  write_source: string;
  summary: string;
};

export const STYLE_SECTION_TARGETS: Readonly<Record<string, string>> = {
  写作风格: "00_设定集/风格库/写作风格.txt",
  风格示例: "00_设定集/风格库/风格示例.txt",
  参考素材: "00_设定集/风格库/参考素材.txt"
};

export const GENRE_SECTION_TARGETS: Readonly<Record<string, string>> = {
  题材规则: "00_设定集/题材库/题材规则.txt",
  题材素材: "00_设定集/题材库/题材素材.txt",
  战斗模板: "00_设定集/题材库/战斗模板.txt",
  违禁词: "00_设定集/题材库/违禁词.txt"
};

export const LORE_SECTION_TARGETS: Readonly<Record<string, string>> = {
  人物设定: "00_设定集/设定集/人物设定.txt",
  体系设定: "00_设定集/设定集/体系设定.txt",
  地图设定: "00_设定集/设定集/地图设定.txt",
  道具设定: "00_设定集/设定集/道具设定.txt"
};

export function isSectionedGeneratedSkillId(value: string): value is SectionedGeneratedSkillId {
  return value === "style_extract" || value === "genre_generate" || value === "lore_extract";
}

export function sectionedGeneratedTargetPaths(skillId: SectionedGeneratedSkillId): string[] {
  return Object.values(sectionTargets(skillId));
}

export function prepareSectionedGeneratedSave(input: {
  skillId: SectionedGeneratedSkillId;
  result: string;
  mode: "replace" | "append";
  summaryPrefix: string;
}): PreparedSectionedGeneratedSave[] {
  const { skillId, mode, summaryPrefix } = input;
  let sections = splitSections(skillId, input.result);

  if (!Object.keys(sections).length && skillId !== "lore_extract") {
    const fallback = String(input.result || "").trim();
    if (!fallback) {
      return [];
    }
    sections = skillId === "style_extract"
      ? { 写作风格: fallback }
      : { 题材规则: fallback };
  }

  const prepared: PreparedSectionedGeneratedSave[] = [];
  for (const [title, targetPath] of Object.entries(sectionTargets(skillId))) {
    const content = String(sections[title] || "").trim();
    if (!content || (skillId === "lore_extract" && isEmptyLoreBody(content))) {
      continue;
    }
    prepared.push({
      title,
      target_path: targetPath,
      content,
      mode,
      action_key: `section:${skillId}:${targetPath}`,
      write_source: skillId === "lore_extract" && mode === "replace" ? "skill" : "agent_generated_save",
      summary: `${summaryPrefix}：${title}`
    });
  }
  return prepared;
}

export function buildSectionedGeneratedSavePlan(input: {
  skillId: SectionedGeneratedSkillId;
  result: string;
  mode: "replace" | "append";
  summaryPrefix: string;
}): GeneratedSavePlan {
  const prepared = prepareSectionedGeneratedSave(input);
  return {
    action: prepared.length ? "split_and_save" : "no_save",
    mode: input.mode,
    target_paths: prepared.map((item) => item.target_path),
    segments: prepared.map((item) => ({
      target_path: item.target_path,
      content: item.content,
      mode: item.mode,
      reason: item.summary
    })),
    reason: input.summaryPrefix,
    confidence: 1,
    requires_confirmation: false,
    should_auto_commit: prepared.length > 0,
    source: "skill",
    skill_id: input.skillId
  };
}

export function isEmptyLoreBody(text: string): boolean {
  const cleaned = String(text || "").trim().replace(/^[\s\-*]+/, "").replace(/[ 。.；;]+$/g, "");
  return !cleaned || ["无", "暂无", "未提取", "未发现", "没有内容"].includes(cleaned);
}

function sectionTargets(skillId: SectionedGeneratedSkillId): Readonly<Record<string, string>> {
  if (skillId === "style_extract") {
    return STYLE_SECTION_TARGETS;
  }
  if (skillId === "genre_generate") {
    return GENRE_SECTION_TARGETS;
  }
  return LORE_SECTION_TARGETS;
}

function splitSections(skillId: SectionedGeneratedSkillId, result: string): Record<string, string> {
  if (skillId === "style_extract") {
    return splitStyleSections(result);
  }
  if (skillId === "genre_generate") {
    return splitGenreSections(result);
  }
  return splitLoreSections(result);
}

function splitStyleSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    写作风格: [],
    风格示例: [],
    参考素材: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    写作风格: "写作风格",
    写作风格规则: "写作风格",
    文风规则: "写作风格",
    文风: "写作风格",
    风格示例: "风格示例",
    风格示例特征: "风格示例",
    参考素材: "参考素材",
    参考素材摘要: "参考素材"
  };

  const heading =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(写作风格规则|写作风格|文风规则|文风|风格示例特征|风格示例|参考素材摘要|参考素材)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return compactSections(sections);
  }

  const fenced = /\*\*(00_设定集\/风格库\/([^*\n]+?\.txt))\*\*\s*```(?:\w+)?\s*(.*?)```/gs;
  for (const match of text.matchAll(fenced)) {
    const filename = match[2] || "";
    const body = String(match[3] || "").trim();
    for (const [title, relPath] of Object.entries(STYLE_SECTION_TARGETS)) {
      if (path.posix.basename(relPath) === filename && body) {
        sections[title]!.push(body);
      }
    }
  }

  return compactSections(sections);
}

function splitGenreSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    题材规则: [],
    题材素材: [],
    战斗模板: [],
    违禁词: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    题材规则: "题材规则",
    规则: "题材规则",
    世界规则: "题材规则",
    题材素材: "题材素材",
    素材: "题材素材",
    灵感素材: "题材素材",
    脑洞素材: "题材素材",
    战斗模板: "战斗模板",
    冲突模板: "战斗模板",
    冲突场景模板: "战斗模板",
    场景模板: "战斗模板",
    违禁词: "违禁词",
    禁忌词: "违禁词",
    禁用词: "违禁词"
  };

  const heading =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(题材规则|规则|世界规则|题材素材|素材|灵感素材|脑洞素材|战斗模板|冲突模板|冲突场景模板|场景模板|违禁词|禁忌词|禁用词)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return compactSections(sections);
  }

  const fenced = /\*\*(00_设定集\/题材库\/([^*\n]+?\.txt))\*\*\s*```(?:\w+)?\s*(.*?)```/gs;
  for (const match of text.matchAll(fenced)) {
    const filename = match[2] || "";
    const body = String(match[3] || "").trim();
    for (const [title, relPath] of Object.entries(GENRE_SECTION_TARGETS)) {
      if (path.posix.basename(relPath) === filename && body) {
        sections[title]!.push(body);
      }
    }
  }

  return compactSections(sections);
}

function compactSections(sections: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sections)
      .map(([title, parts]) => [title, parts.join("\n\n").trim()])
      .filter(([, body]) => Boolean(body))
  );
}

function splitLoreSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    人物设定: [],
    体系设定: [],
    地图设定: [],
    道具设定: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    人物: "人物设定",
    人物设定: "人物设定",
    角色: "人物设定",
    角色设定: "人物设定",
    体系: "体系设定",
    体系设定: "体系设定",
    世界观: "体系设定",
    世界设定: "体系设定",
    规则设定: "体系设定",
    能力体系: "体系设定",
    势力组织: "体系设定",
    地图: "地图设定",
    地图设定: "地图设定",
    地点: "地图设定",
    地点设定: "地图设定",
    地理设定: "地图设定",
    道具: "道具设定",
    道具设定: "道具设定",
    物品: "道具设定",
    物品设定: "道具设定",
    法宝设定: "道具设定",
    装备设定: "道具设定"
  };

  const heading =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(人物设定|人物|角色设定|角色|体系设定|体系|世界观|世界设定|规则设定|能力体系|势力组织|地图设定|地图|地点设定|地点|地理设定|道具设定|道具|物品设定|物品|法宝设定|装备设定)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return compactSections(sections);
  }

  for (const block of text.split(/\n{2,}/)) {
    const clean = block.trim();
    if (!clean) {
      continue;
    }
    sections[classifyLoreBlock(clean)]!.push(clean);
  }
  return compactSections(sections);
}

function classifyLoreBlock(text: string): keyof typeof LORE_SECTION_TARGETS {
  if (/道具|物品|法宝|武器|装备|丹药|符箓|灵器|宝物|剑|刀|枪|弓/.test(text)) {
    return "道具设定";
  }
  if (/地图|地点|地名|地理|地域|城|镇|村|山|海|河|谷|洞府|秘境|遗迹|宫|殿/.test(text)) {
    return "地图设定";
  }
  if (/人物|角色|主角|配角|姓名|身份|性格|动机|关系|师父|弟子|父|母|兄|姐|妹|男|女/.test(text)) {
    return "人物设定";
  }
  if (/世界|规则|体系|组织|势力|宗门|家族|能力|功法|境界|修为|血脉|种族|法则|等级/.test(text)) {
    return "体系设定";
  }
  return "体系设定";
}
