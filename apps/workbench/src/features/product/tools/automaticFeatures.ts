import type { AppConfig, SkillDefinition } from "@xiaoshuo/shared";

export type AutomaticConfigKey = "auto_lore_extract_enabled" | "humanizer_enabled" | "enable_consistency_revision";

export type AutomaticFeature = {
  key: AutomaticConfigKey;
  skillId: string;
  label: string;
  description: string;
};

export const automaticFeatures: AutomaticFeature[] = [
  { key: "auto_lore_extract_enabled", skillId: "lore_extract", label: "自动提取明确设定", description: "从已保存的大纲、细纲与章纲提取明确事实，校验后直接合并到设定库。正文仅保留一句话总结。" },
  { key: "humanizer_enabled", skillId: "humanizer_zh", label: "降低模板化表达", description: "生成后清理模板化措辞，保留情节与人物口吻。" },
  { key: "enable_consistency_revision", skillId: "consistency_check", label: "生成后一致性复查", description: "按设置中的分数阈值复查人物、设定、章纲与风格冲突。" }
];

export async function saveAutomaticFeature(input: {
  feature: AutomaticFeature;
  enabled: boolean;
  skills: SkillDefinition[];
  setSkillEnabled: (skillId: string, enabled: boolean) => Promise<boolean>;
  patchAndSaveConfig: (patch: Partial<AppConfig>, message?: string) => Promise<boolean>;
}): Promise<boolean> {
  const relatedSkill = input.skills.find((skill) => skill.id === input.feature.skillId);
  let restoredSkill = false;
  if (input.enabled && relatedSkill?.disabled) {
    restoredSkill = await input.setSkillEnabled(input.feature.skillId, true);
    if (!restoredSkill) return false;
  }
  const saved = await input.patchAndSaveConfig(
    { [input.feature.key]: input.enabled } as Partial<AppConfig>,
    `${input.feature.label}已${input.enabled ? "开启" : "关闭"}。`
  );
  if (!saved && restoredSkill) await input.setSkillEnabled(input.feature.skillId, false);
  return saved;
}
