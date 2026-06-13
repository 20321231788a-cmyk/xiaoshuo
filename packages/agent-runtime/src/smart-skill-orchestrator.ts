import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import type { AgentRunRequest, SkillDefinition, SkillPlan, SkillPlanStep } from "@xiaoshuo/shared";
import type { ChatCompletionMessage, OpenAICompatibleClient } from "@xiaoshuo/model-client";
import { hasSkillAction, rankSkillRoutes, type RankedSkillRoute } from "./intent-router.js";

const MAX_PLAN_STEPS = 4;
const MAX_CANDIDATES = 8;
const MODEL_PLAN_CONFIDENCE = 0.62;
const DIRECT_ROUTE_CONFIDENCE = 0.78;

type ModelClient = Pick<OpenAICompatibleClient, "requestCompletion">;

export type SmartSkillOrchestratorOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient: ModelClient;
};

export class SmartSkillOrchestrator {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly modelClient: ModelClient;

  constructor(options: SmartSkillOrchestratorOptions) {
    this.projectRoot = options.projectRoot;
    this.config = options.config ?? {};
    this.modelClient = options.modelClient;
  }

  async plan(request: AgentRunRequest, skills: SkillDefinition[]): Promise<SkillPlan> {
    const enabledSkills = skills.filter((skill) => !skill.disabled);
    const explicitSkillId = String(request.skill_id || "").trim();
    if (explicitSkillId) {
      const skill = enabledSkills.find((item) => item.id === explicitSkillId);
      if (!skill) {
        return emptyPlan("指定技能不可用或已禁用。");
      }
      return normalizePlan(
        {
          should_call_skill: true,
          confidence: 1,
          selected_reason: "用户明确指定技能。",
          steps: [makeStep(skill, request.content || skill.description, "用户明确指定技能。", 1)]
        },
        enabledSkills
      );
    }

    const content = String(request.content || "").trim();
    if (!content) {
      return emptyPlan();
    }

    const candidateRoutes = this.pickCandidateRoutes(content, enabledSkills, String((request as any).current_skill || ""));
    const candidates = candidateRoutes.map((candidate) => candidate.skill).filter((skill): skill is SkillDefinition => Boolean(skill));
    const routedCandidate = candidateRoutes[0];
    const routedSkillId = routedCandidate?.skillId || "";
    if (!candidates.length && !routedSkillId) {
      return emptyPlan();
    }

    const modelPlan = await this.planWithModel(request, candidates).catch(() => null);
    if (modelPlan && modelPlan.should_call_skill && modelPlan.confidence >= MODEL_PLAN_CONFIDENCE) {
      const normalized = normalizePlan(modelPlan, enabledSkills);
      if (normalized.should_call_skill && normalized.steps.length) {
        return normalized;
      }
    }

    if (routedSkillId && routedCandidate && this.shouldUseDirectRoute(content, routedCandidate)) {
      const skill = enabledSkills.find((item) => item.id === routedSkillId);
      if (skill) {
        return normalizePlan(
          {
            should_call_skill: true,
            confidence: DIRECT_ROUTE_CONFIDENCE,
            selected_reason: routedCandidate.reasons.join("；") || "规则路由命中明确技能。",
            steps: [makeStep(skill, content, routedCandidate.reasons.join("；") || "规则路由命中明确技能。", DIRECT_ROUTE_CONFIDENCE)]
          },
          enabledSkills
        );
      }
    }

    return emptyPlan(modelPlan?.selected_reason || "");
  }

  private pickCandidateRoutes(text: string, skills: SkillDefinition[], currentSkillId = ""): RankedSkillRoute[] {
    const ranked = rankSkillRoutes(text, skills.filter((skill) => isRunnableByAgent(skill)), { currentSkillId, limit: 24 });
    const selected: RankedSkillRoute[] = [];
    const add = (candidate: RankedSkillRoute | undefined) => {
      if (!candidate || selected.some((item) => item.skillId === candidate.skillId)) {
        return;
      }
      selected.push(candidate);
    };

    for (const candidate of ranked.slice(0, 4)) {
      add(candidate);
    }
    add(ranked.find((candidate) => candidate.skill?.builtin));
    add(ranked.find((candidate) => candidate.skill && !candidate.skill.builtin));
    add(ranked.find((candidate) => candidate.signals.some((signal) => signal === "explicit_name" || signal === "explicit_id")));
    add(ranked.find((candidate) => candidate.signals.includes("current_skill")));
    for (const candidate of ranked) {
      add(candidate);
      if (selected.length >= MAX_CANDIDATES) {
        break;
      }
    }
    return selected.slice(0, MAX_CANDIDATES);
  }

  private shouldUseDirectRoute(text: string, candidate: RankedSkillRoute): boolean {
    if (!hasSkillAction(text)) {
      return false;
    }
    if (candidate.signals.includes("intent:chat") || candidate.signals.includes("intent:read_context")) {
      return false;
    }
    return candidate.score >= 42;
  }

  private async planWithModel(request: AgentRunRequest, candidates: SkillDefinition[]): Promise<SkillPlan> {
    if (!candidates.length) {
      return emptyPlan();
    }
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      return emptyPlan();
    }
    const continuity = await buildProjectContinuityContext(this.projectRoot).catch(() => null);
    const prompt = buildPlannerPrompt(request, candidates, continuity);
    const raw = await this.modelClient.requestCompletion(
      { ...config, temperature: Math.min(config.temperature, 0.2) },
      [
        {
          role: "system",
          content:
            "你是 ArcWriter 的技能调度器。只能输出严格 JSON，不要 markdown，不要解释。目标是决定是否自动调用技能，以及调用顺序。"
        },
        { role: "user", content: prompt }
      ] satisfies ChatCompletionMessage[],
      0.1
    );
    return normalizePlan(readJsonPlan(raw), candidates);
  }
}

function buildPlannerPrompt(request: AgentRunRequest, candidates: SkillDefinition[], continuity: Awaited<ReturnType<typeof buildProjectContinuityContext>> | null): string {
  const skillCatalog = candidates
    .map((skill) =>
      [
        `id: ${skill.id}`,
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        `handler_type: ${skill.handler_type}`,
        `input_mode: ${skill.input_mode}`,
        `targets: ${(skill.linked_targets || []).join(", ") || "无"}`,
        `requirements: ${(skill.context_requirements || []).join(", ") || "无"}`
      ].join("\n")
    )
    .join("\n\n");
  const contextSummary = continuity
    ? JSON.stringify(
        {
          has_outline: Boolean(stringifyCompact(continuity.outline).trim()),
          has_detail_outline: Boolean(stringifyCompact(continuity.detail_outline).trim()),
          has_chapter_outline: Boolean(stringifyCompact(continuity.chapter_outline).trim()),
          state_summary: String(continuity.state_summary || "").slice(0, 1200),
          style: stringifyCompact(continuity.style).slice(0, 800),
          genre: stringifyCompact(continuity.genre).slice(0, 800)
        },
        null,
        2
      )
    : "{}";

  return [
    "请根据用户请求决定是否调用技能。复杂任务可以规划多个技能，最多 4 步。",
    "按用户想要的产物类型选择技能：大纲/细纲/章纲选规划类；正文、对白、片段、风格仿写优先选对应写作类或导入风格类技能。",
    "风格型导入技能可以优先于泛用大纲技能；不要因为出现“写、扩展、灵感”等宽泛词就默认选择 outline_generate。",
    "只有用户真的需要生成、提取、检查、拆书、抽卡、伏笔、润色、去AI味等能力时才调用技能；普通聊天、解释、答疑、读取上下文应返回 should_call_skill=false。",
    "如果默认技能已禁用，它不会出现在候选里；请从候选中选择相近技能。",
    "后一步可使用前一步输出，所以可以规划类似：先提取设定，再一致性检查。",
    "",
    "输出 JSON 格式：",
    '{"should_call_skill":true|false,"confidence":0-1,"selected_reason":"短理由","steps":[{"skill_id":"...","instruction":"给这个技能的具体指令","text":"","reason":"短理由","confidence":0-1}]}',
    "",
    `【用户请求】\n${String(request.content || "").slice(0, 8000)}`,
    "",
    `【当前文档路径】\n${request.current_path || "无"}`,
    "",
    `【选区】\n${String(request.selection || "").slice(0, 4000) || "无"}`,
    "",
    `【项目摘要】\n${contextSummary}`,
    "",
    `【可用候选技能】\n${skillCatalog}`
  ].join("\n");
}

function isRunnableByAgent(skill: SkillDefinition): boolean {
  return !skill.disabled && ["prompt", "workflow", "job", "external"].includes(skill.handler_type);
}

function makeStep(skill: SkillDefinition, instruction: string, reason: string, confidence: number): SkillPlanStep {
  return {
    skill_id: skill.id,
    name: skill.name || skill.id,
    instruction,
    text: "",
    reason,
    confidence
  };
}

function normalizePlan(plan: Partial<SkillPlan>, skills: SkillDefinition[]): SkillPlan {
  const byId = new Map(skills.filter((skill) => !skill.disabled).map((skill) => [skill.id, skill]));
  const seen = new Set<string>();
  const steps = (Array.isArray(plan.steps) ? plan.steps : [])
    .map((step) => normalizeStep(step, byId))
    .filter((step): step is SkillPlanStep => Boolean(step))
    .filter((step) => {
      const key = `${step.skill_id}:${step.instruction}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PLAN_STEPS);
  const confidence = clamp01(Number(plan.confidence || (steps.length ? Math.max(...steps.map((step) => step.confidence || 0)) : 0)));
  return {
    should_call_skill: Boolean(plan.should_call_skill && steps.length),
    steps,
    selected_reason: String(plan.selected_reason || "").slice(0, 500),
    confidence
  };
}

function normalizeStep(step: unknown, byId: Map<string, SkillDefinition>): SkillPlanStep | null {
  if (!step || typeof step !== "object") {
    return null;
  }
  const raw = step as Partial<SkillPlanStep>;
  const skillId = String(raw.skill_id || "").trim();
  const skill = byId.get(skillId);
  if (!skill) {
    return null;
  }
  return {
    skill_id: skill.id,
    name: skill.name || skill.id,
    instruction: String(raw.instruction || "").trim().slice(0, 4000),
    text: String(raw.text || "").trim().slice(0, 12000),
    reason: String(raw.reason || "").trim().slice(0, 500),
    confidence: clamp01(Number(raw.confidence || 0))
  };
}

function readJsonPlan(raw: string): Partial<SkillPlan> {
  const text = String(raw || "").trim();
  if (!text) {
    return emptyPlan();
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return emptyPlan();
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Partial<SkillPlan>;
  } catch {
    return emptyPlan();
  }
}

function emptyPlan(reason = ""): SkillPlan {
  return {
    should_call_skill: false,
    steps: [],
    selected_reason: reason,
    confidence: 0
  };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function stringifyCompact(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
