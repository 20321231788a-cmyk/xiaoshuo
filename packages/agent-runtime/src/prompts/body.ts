import { clipForConsistency } from "./consistency.js";

export function buildBodyChapterSystemPrompt(input: { lowerWords: number; upperWords: number }): string {
  return (
    "你是长篇网文正文写作智能体。文章连续性是最高优先级，必须严格服从设定、章纲和上一章结尾。\n" +
    "不得擅自新增主线、境界、科技词、人物关系或与题材不符的概念。\n" +
    "输出只能是正文，不要解释、不要分点、不要免责声明。\n" +
    `字数强约束：正文有效字数必须落在 ${input.lowerWords}-${input.upperWords} 字附近，不能用水话凑字。`
  );
}

export function buildBodyChapterUserPrompt(input: {
  chapter: number;
  instruction: string;
  chapterOutline: string;
  graphContext: string;
  loreContext: string;
  styleGenreBlock: string;
  webSearchContext: string;
  openLedger: string;
  stateSummary: string;
  recentChapters: string;
}): string {
  return [
    `请生成第 ${input.chapter} 章正文。`,
    `用户补充指令：${input.instruction || "无"}`,
    "",
    `【本章章纲】\n${clipForConsistency(input.chapterOutline, 8000)}`,
    "",
    `【图谱写作约束】\n${input.graphContext}\n` +
      "- 已确认事实必须遵守\n" +
      "- planned 内容是当前计划，不得当作已经发生\n" +
      "- draft 内容只作参考\n" +
      "- contradicted 内容需要避开或提示\n" +
      "- 空白大纲/章纲不得自行补成事实",
    "",
    `【四层设定集】\n${clipForConsistency(input.loreContext, 12000)}`,
    "",
    input.styleGenreBlock,
    "",
    `【联网搜索小说素材】\n${input.webSearchContext}`,
    "",
    `【伏笔账本】\n${input.openLedger || "无开放伏笔"}`,
    "如果用户补充指令明确要求填坑、回收伏笔或兑现线索，必须优先自然完成；否则这里只作为连续性约束，避免生硬堆入正文。",
    "",
    `【项目状态摘要】\n${clipForConsistency(input.stateSummary, 8000)}`,
    "",
    `【最近两章正文】\n${clipForConsistency(input.recentChapters, 9000)}`,
    "",
    "请从上一章结尾自然承接，严格完成本章章纲。"
  ].join("\n");
}

export function buildBodyRevisionSystemPrompt(): string {
  return (
    "你是严厉的正文回炉修正智能体。必须修复连续性、设定、章纲、字数和AI味问题。\n" +
    "输出格式必须为：\n【修正后正文】\n...\n【修正原因日志】\n..."
  );
}

export function buildBodyRevisionUserPrompt(input: {
  chapter: number;
  text: string;
  chapterOutline: string;
  targetWords: number;
  checkResult: { score: number; risks: string[]; reason: string };
  contextSummary: string;
}): string {
  return [
    `第 ${input.chapter} 章未通过审查，必须回炉。`,
    `审查结果：${JSON.stringify(input.checkResult)}`,
    `目标字数：${input.targetWords}`,
    "",
    `【章纲】\n${clipForConsistency(input.chapterOutline, 6000)}`,
    "",
    `【项目状态摘要】\n${clipForConsistency(input.contextSummary, 7000)}`,
    "",
    `【原正文】\n${clipForConsistency(input.text, 22000)}`
  ].join("\n");
}

export function buildBodyDeslopUserPrompt(input: { chapter: number; text: string }): string {
  return [
    "【处理模式】正文去AI味",
    `【上下文提示】第 ${input.chapter} 章正文自动后处理`,
    "",
    "请对下面文本执行 story-deslop 去AI味。只输出处理后的文本本体。",
    "",
    `【待处理文本】\n${input.text.slice(0, 30000)}`
  ].join("\n");
}
