import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentIntent, SkillDefinition } from "@xiaoshuo/shared";
import { assembleContext, type AssembleContextOptions } from "./kernel/context-assembler.js";
import type { ContextBlock } from "./kernel/context-block.js";
import { classifyAgentIntent, resolveSkillRoute } from "./intent-router.js";
import { shouldUseWebSearch } from "./web-search.js";

type RoutingEvalCase = {
  id: string;
  input: string;
  expected_intent: AgentIntent;
  expected_skill?: string;
  manual_skill_id?: string;
  expected_web_search?: boolean;
};

type ContextEvalCase = {
  id: string;
  blocks: ContextBlock[];
  options?: AssembleContextOptions;
  expected_text?: string;
  expected_included?: string[];
  expected_excluded?: string[];
  expected_truncated?: boolean;
  expected_block_chars?: Record<string, number>;
};

type EvalResult = {
  id: string;
  input: string;
  expected: string;
  actual: string;
};

const ROUTING_THRESHOLD = 0.9;
const SKILL_THRESHOLD = 0.9;

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

const evalSkills: SkillDefinition[] = [
  skill({
    id: "outline_generate",
    name: "灵感转大纲",
    description: "把灵感或要求扩展成完整小说大纲。",
    linked_targets: ["01_大纲/大纲.txt"],
    prompt: "请把用户灵感扩展成完整、可执行的小说大纲。",
    builtin: true
  }),
  skill({
    id: "detail_outline_generate",
    name: "大纲转细纲",
    description: "把大纲扩展为更细的剧情细纲。",
    linked_targets: ["01_大纲/细纲.txt"],
    prompt: "把大纲扩写成细纲。",
    builtin: true
  }),
  skill({
    id: "chapter_outline_generate",
    name: "细纲转章纲",
    description: "把细纲拆成可直接执行的章节章纲。",
    linked_targets: ["01_大纲/章纲.txt"],
    prompt: "把细纲拆分成章纲。",
    builtin: true
  }),
  skill({
    id: "body_generate",
    name: "章纲转正文",
    description: "依据章纲与项目上下文生成正文。",
    handler_type: "job",
    linked_targets: ["02_正文"],
    builtin: true
  }),
  skill({
    id: "batch_generate",
    name: "批量正文生成",
    description: "连续生成多章正文。",
    handler_type: "job",
    linked_targets: ["02_正文"],
    builtin: true
  }),
  skill({
    id: "continue_text",
    name: "续写",
    description: "沿着上文继续写正文、对白和片段。",
    linked_targets: ["02_正文"],
    prompt: "沿着上文继续写。",
    builtin: true
  }),
  skill({
    id: "polish_text",
    name: "正文润色",
    description: "在不改剧情事实的前提下优化正文表达。",
    linked_targets: ["02_正文/润色结果.txt"],
    prompt: "润色正文。",
    builtin: true
  }),
  skill({
    id: "story_deslop",
    name: "去AI味",
    description: "清除 AI 写作痕迹，让细纲、章纲和正文更自然。",
    linked_targets: ["02_正文/去AI味结果.txt"],
    prompt: "去除 AI 味。",
    builtin: true
  }),
  skill({
    id: "reverse_outline_extract",
    name: "反向细纲提取",
    description: "从正文中提取真实发生的剧情推进。",
    linked_targets: ["01_大纲/反向细纲.txt"],
    prompt: "从正文提取细纲。",
    builtin: true
  }),
  skill({
    id: "lore_extract",
    name: "设定提取",
    description: "从正文或资料中提取人物、地名、组织、能力和世界规则。",
    linked_targets: ["00_设定集/设定集"],
    prompt: "提取人物设定、世界观和设定。",
    builtin: true
  }),
  skill({
    id: "style_extract",
    name: "风格提取",
    description: "从样文中提取可复用的写作风格规则、风格示例特征和参考素材摘要。",
    linked_targets: ["00_设定集/风格库"],
    prompt: "提取文风、风格和写法。",
    builtin: true
  }),
  skill({
    id: "genre_generate",
    name: "题材生成",
    description: "生成题材规则、题材素材、战斗或冲突模板和违禁词。",
    linked_targets: ["00_设定集/题材库"],
    prompt: "生成题材库。",
    builtin: true
  }),
  skill({
    id: "consistency_check",
    name: "一致性检查",
    description: "检查正文是否违背设定、章纲、风格和题材约束。",
    handler_type: "job",
    prompt: "检查冲突和前后矛盾。",
    builtin: true
  }),
  skill({
    id: "scan_pits",
    name: "扫描伏笔",
    description: "从正文中提取需要跟踪的伏笔并写入账本。",
    handler_type: "job",
    prompt: "扫描伏笔、坑点和线索。",
    builtin: true
  }),
  skill({
    id: "book_fusion",
    name: "融梗",
    description: "从多本已拆书籍中融合核心设定和剧情骨架。",
    handler_type: "workflow",
    linked_targets: ["00_设定集/融梗方案"],
    prompt: "融合三本书的设定、剧情和核心梗。",
    builtin: true
  }),
  skill({
    id: "disassemble_book",
    name: "拆书",
    description: "拆解原文、样文或小说。",
    handler_type: "workflow",
    linked_targets: ["00_设定集/拆书库"],
    prompt: "拆解样文小说。",
    builtin: true
  }),
  skill({
    id: "continue_disassemble",
    name: "继续拆书",
    description: "继续拆书并扩展拆书细纲。",
    handler_type: "workflow",
    linked_targets: ["01_大纲/拆书细纲.txt"],
    prompt: "继续拆书细纲。",
    builtin: true
  }),
  skill({
    id: "baiye_dialogue",
    name: "白野式风格对白",
    description: "按白野式风格仿写，擅长装逼对白、短片段和场景推进。",
    prompt: "模仿白野式语感，直接输出装逼对白或正文片段。",
    imported_from: "eval-skill.md"
  }),
  skill({
    id: "cold_style_writer",
    name: "赛博冷感风格写作",
    description: "按赛博冷感风格写正文、对白和场景片段。",
    prompt: "按赛博冷感风格直接输出正文或对白。",
    imported_from: "eval-skill.md"
  })
];

async function readJsonl<T>(filename: string): Promise<T[]> {
  const raw = await fs.readFile(new URL(`../evals/${filename}`, import.meta.url), "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${filename}:${index + 1} is not valid JSONL: ${message}`);
      }
    });
}

function formatFailures(failures: EvalResult[]): string {
  return failures.map((failure) => `${failure.id}: expected ${failure.expected}, got ${failure.actual}; input=${failure.input}`).join("\n");
}

describe("P4 agent routing eval", () => {
  it("keeps routing accuracy above the eval threshold", async () => {
    const cases = await readJsonl<RoutingEvalCase>("routing-cases.jsonl");
    const results = cases.map((testCase) => ({
      id: testCase.id,
      input: testCase.input,
      expected: testCase.expected_intent,
      actual: classifyAgentIntent(testCase.input, testCase.manual_skill_id || "", evalSkills)
    }));
    const failures = results.filter((result) => result.actual !== result.expected);
    const accuracy = (results.length - failures.length) / results.length;

    expect(accuracy, formatFailures(failures)).toBeGreaterThanOrEqual(ROUTING_THRESHOLD);
  });

  it("keeps skill selection accuracy above the eval threshold", async () => {
    const cases = (await readJsonl<RoutingEvalCase>("routing-cases.jsonl")).filter((testCase) =>
      Object.hasOwn(testCase, "expected_skill")
    );
    const results = cases.map((testCase) => ({
      id: testCase.id,
      input: testCase.input,
      expected: testCase.expected_skill || "",
      actual: resolveSkillRoute(testCase.input, testCase.manual_skill_id || "", evalSkills)
    }));
    const failures = results.filter((result) => result.actual !== result.expected);
    const accuracy = (results.length - failures.length) / results.length;

    expect(accuracy, formatFailures(failures)).toBeGreaterThanOrEqual(SKILL_THRESHOLD);
  });

  it("only enables web search for explicit material-search requests", async () => {
    const cases = (await readJsonl<RoutingEvalCase>("routing-cases.jsonl")).filter((testCase) =>
      Object.hasOwn(testCase, "expected_web_search")
    );
    const failures = cases
      .map((testCase) => ({
        id: testCase.id,
        input: testCase.input,
        expected: String(Boolean(testCase.expected_web_search)),
        actual: String(shouldUseWebSearch(testCase.input))
      }))
      .filter((result) => result.actual !== result.expected);

    expect(failures, formatFailures(failures)).toEqual([]);
  });
});

describe("P4 context assembly eval", () => {
  it("matches context fixture expectations", async () => {
    const cases = await readJsonl<ContextEvalCase>("context-cases.jsonl");

    for (const testCase of cases) {
      const result = assembleContext(testCase.blocks, testCase.options || {});
      if (typeof testCase.expected_text === "string") {
        expect(result.text, testCase.id).toBe(testCase.expected_text);
      }
      if (typeof testCase.expected_truncated === "boolean") {
        expect(result.truncated, testCase.id).toBe(testCase.expected_truncated);
      }
      for (const blockId of testCase.expected_included || []) {
        expect(result.blocks.find((block) => block.id === blockId), testCase.id).toMatchObject({ included: true });
      }
      for (const blockId of testCase.expected_excluded || []) {
        expect(result.blocks.find((block) => block.id === blockId), testCase.id).toMatchObject({ included: false });
      }
      for (const [blockId, includedChars] of Object.entries(testCase.expected_block_chars || {})) {
        expect(result.blocks.find((block) => block.id === blockId), testCase.id).toMatchObject({ includedChars });
      }
    }
  });
});
