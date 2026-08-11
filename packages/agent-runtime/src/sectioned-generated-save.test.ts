import { describe, expect, it } from "vitest";
import {
  buildSectionedGeneratedSavePlan,
  mergeLoreSectionText,
  prepareSectionedGeneratedSave,
  sectionedGeneratedTargetPaths
} from "./sectioned-generated-save.js";

describe("sectioned generated save planning", () => {
  it("splits style headings in stable target order with per-section summaries", () => {
    const plan = buildSectionedGeneratedSavePlan({
      skillId: "style_extract",
      result: [
        "## 写作风格",
        "短句，克制。",
        "## 风格示例",
        "雨落在旧城。",
        "## 参考素材",
        "民国报刊。"
      ].join("\n"),
      mode: "replace",
      summaryPrefix: "风格库保存"
    });

    expect(plan.target_paths).toEqual(sectionedGeneratedTargetPaths("style_extract"));
    expect(plan.segments).toEqual([
      expect.objectContaining({
        target_path: "00_设定集/风格库/写作风格.txt",
        content: "短句，克制。",
        reason: "风格库保存：写作风格"
      }),
      expect.objectContaining({
        target_path: "00_设定集/风格库/风格示例.txt",
        content: "雨落在旧城。"
      }),
      expect.objectContaining({
        target_path: "00_设定集/风格库/参考素材.txt",
        content: "民国报刊。"
      })
    ]);
  });

  it("falls back unsectioned style and genre text to their primary files", () => {
    expect(prepareSectionedGeneratedSave({
      skillId: "style_extract",
      result: "保持冷峻叙事",
      mode: "append",
      summaryPrefix: "风格库保存"
    })).toEqual([
      expect.objectContaining({
        title: "写作风格",
        target_path: "00_设定集/风格库/写作风格.txt",
        content: "保持冷峻叙事",
        mode: "append"
      })
    ]);

    expect(prepareSectionedGeneratedSave({
      skillId: "genre_generate",
      result: "升级必须付出代价",
      mode: "replace",
      summaryPrefix: "题材库保存"
    })).toEqual([
      expect.objectContaining({
        title: "题材规则",
        target_path: "00_设定集/题材库/题材规则.txt",
        content: "升级必须付出代价"
      })
    ]);
  });

  it("recognizes the legacy fenced genre file format", () => {
    const prepared = prepareSectionedGeneratedSave({
      skillId: "genre_generate",
      result: [
        "**00_设定集/题材库/题材素材.txt**",
        "```text",
        "宗门大比与秘境试炼",
        "```",
        "**00_设定集/题材库/违禁词.txt**",
        "```text",
        "现代枪械",
        "```"
      ].join("\n"),
      mode: "replace",
      summaryPrefix: "题材库保存"
    });

    expect(prepared.map((item) => item.title)).toEqual(["题材素材", "违禁词"]);
    expect(prepared.map((item) => item.content)).toEqual(["宗门大比与秘境试炼", "现代枪械"]);
  });

  it("classifies lore blocks and filters empty placeholder sections", () => {
    const prepared = prepareSectionedGeneratedSave({
      skillId: "lore_extract",
      result: [
        "人物设定",
        "林烬：流亡剑修。",
        "",
        "体系设定",
        "暂无。",
        "",
        "地图设定",
        "青崖城：边境城池。",
        "",
        "道具设定",
        "照夜剑：封存旧誓。"
      ].join("\n"),
      mode: "replace",
      summaryPrefix: "设定提取保存"
    });

    expect(prepared.map((item) => item.title)).toEqual(["人物设定", "地图设定", "道具设定"]);
    expect(prepared[0]).toMatchObject({ write_source: "skill" });
    expect(prepared.map((item) => item.target_path)).toEqual([
      "00_设定集/设定集/人物设定.txt",
      "00_设定集/设定集/地图设定.txt",
      "00_设定集/设定集/道具设定.txt"
    ]);
  });

  it("keeps an empty lore result pending with a no-save plan", () => {
    expect(buildSectionedGeneratedSavePlan({
      skillId: "lore_extract",
      result: "人物设定\n暂无。",
      mode: "replace",
      summaryPrefix: "设定提取保存"
    })).toMatchObject({
      action: "no_save",
      target_paths: [],
      segments: [],
      should_auto_commit: false
    });
  });

  it("merges lore replacements without duplicating known item details", () => {
    expect(mergeLoreSectionText(
      "人物设定",
      "林烬：流亡剑修；佩剑旧缺\n\n顾霜：边军斥候",
      "林烬：佩剑旧缺；师承不明\n\n沈河：药师"
    )).toBe("林烬：流亡剑修；佩剑旧缺；师承不明\n\n顾霜：边军斥候\n\n沈河：药师");
  });
});
