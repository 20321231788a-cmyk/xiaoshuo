import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "@xiaoshuo/shared";
import { classifyAgentIntent, rankSkillRoutes, resolveSkillRoute } from "./intent-router.js";

function skill(input: Partial<SkillDefinition> & Pick<SkillDefinition, "id" | "name" | "description">): SkillDefinition {
  return {
    input_mode: "text",
    context_requirements: ["project_state"],
    handler_type: "prompt",
    linked_targets: [],
    prompt: "",
    imported_from: "",
    writable: true,
    builtin: false,
    disabled: false,
    ...input
  };
}

const outlineSkill = skill({
  id: "outline_generate",
  name: "灵感转大纲",
  description: "把灵感或要求扩展成完整小说大纲。",
  linked_targets: ["01_大纲/大纲.txt"],
  prompt: "请把用户灵感扩展成完整、可执行的小说大纲。",
  builtin: true
});

const bodySkill = skill({
  id: "body_generate",
  name: "章纲转正文",
  description: "依据章纲与项目上下文生成正文。",
  handler_type: "job",
  linked_targets: ["02_正文"],
  builtin: true
});

describe("intent-router semantic ranking", () => {
  it("prefers an imported style-dialogue skill over generic outline generation", () => {
    const baiyeStyle = skill({
      id: "baiye_dialogue",
      name: "白野式风格对白",
      description: "按白野式风格仿写，擅长装逼对白、短片段和场景推进。",
      prompt: "模仿白野式语感，直接输出装逼对白或正文片段。",
      imported_from: "test-skill.md"
    });

    const ranked = rankSkillRoutes("给我写一个白野式的装逼对话", [outlineSkill, bodySkill, baiyeStyle]);

    expect(ranked[0]?.skillId).toBe("baiye_dialogue");
    expect(resolveSkillRoute("给我写一个白野式的装逼对话", "", [outlineSkill, bodySkill, baiyeStyle])).toBe("baiye_dialogue");
    expect(ranked.find((candidate) => candidate.skillId === "outline_generate")?.score || 0).toBeLessThan(ranked[0]!.score);
  });

  it("keeps explicit outline planning on outline_generate", () => {
    const ranked = rankSkillRoutes("帮我把这个灵感扩成大纲", [outlineSkill, bodySkill]);

    expect(ranked[0]?.skillId).toBe("outline_generate");
    expect(resolveSkillRoute("帮我把这个灵感扩成大纲", "", [outlineSkill, bodySkill])).toBe("outline_generate");
    expect(classifyAgentIntent("帮我把这个灵感扩成大纲", "", [outlineSkill, bodySkill])).toBe("skill");
  });

  it("does not fall back to outline_generate for dialogue, body, or style-writing requests", () => {
    const styleWriter = skill({
      id: "style_writer",
      name: "冷感风格写作",
      description: "按指定风格写正文、对白和片段。",
      prompt: "直接按用户指定文风输出正文或对白。",
      imported_from: "test-skill.md"
    });

    expect(resolveSkillRoute("写一个对话", "", [outlineSkill, bodySkill])).not.toBe("outline_generate");
    expect(resolveSkillRoute("来一段正文", "", [outlineSkill, bodySkill])).toBe("body_generate");
    expect(resolveSkillRoute("按赛博冷感风格写一段", "", [outlineSkill, bodySkill, styleWriter])).toBe("style_writer");
  });

  it("lets an imported replacement win when a default skill is disabled", () => {
    const disabledPolish = skill({
      id: "polish_text",
      name: "正文润色",
      description: "在不改剧情事实的前提下优化正文表达。",
      prompt: "润色正文。",
      builtin: true,
      disabled: true
    });
    const importedPolish = skill({
      id: "custom_polish",
      name: "自定义润色",
      description: "当默认润色禁用时，用于润色、改写和优化表达。",
      prompt: "请润色文本，保持剧情事实不变。",
      imported_from: "test-skill.md"
    });

    const ranked = rankSkillRoutes("请润色当前文档", [disabledPolish, importedPolish]);

    expect(ranked.map((candidate) => candidate.skillId)).not.toContain("polish_text");
    expect(ranked[0]?.skillId).toBe("custom_polish");
    expect(resolveSkillRoute("请润色当前文档", "", [disabledPolish, importedPolish])).toBe("custom_polish");
  });

  it("does not force writing skills for read-context or ordinary chat", () => {
    const styleWriter = skill({
      id: "style_writer",
      name: "风格写作",
      description: "按指定风格写正文、对白和片段。",
      prompt: "直接输出正文。",
      imported_from: "test-skill.md"
    });

    expect(rankSkillRoutes("请总结当前项目", [outlineSkill, bodySkill, styleWriter])).toEqual([]);
    expect(classifyAgentIntent("请总结当前项目", "", [outlineSkill, bodySkill, styleWriter])).toBe("read_context");
    expect(resolveSkillRoute("继续分析这一段剧情", "", [outlineSkill, bodySkill, styleWriter])).toBe("");
    expect(classifyAgentIntent("继续分析这一段剧情", "", [outlineSkill, bodySkill, styleWriter])).toBe("read_context");
    expect(resolveSkillRoute("我们随便聊聊角色名字", "", [outlineSkill, bodySkill, styleWriter])).toBe("");
    expect(classifyAgentIntent("我们随便聊聊角色名字", "", [outlineSkill, bodySkill, styleWriter])).toBe("chat");
  });
});
