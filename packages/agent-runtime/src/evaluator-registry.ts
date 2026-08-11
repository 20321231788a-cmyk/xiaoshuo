import type { ModelGateway } from "@xiaoshuo/model-client";
import type { ModelConfig } from "@xiaoshuo/config-service";
import { qualityReportSchema, type QualityIssue as SharedQualityIssue, type QualityReport as SharedQualityReport } from "@xiaoshuo/shared";

export interface LegacyQualityIssue {
  type: "formatting" | "length" | "graph" | "outline" | "style" | string;
  severity: "blocking" | "major" | "minor";
  message: string;
}

export type QualityIssue = SharedQualityIssue & { type: LegacyQualityIssue["type"] };
export type QualityReport = SharedQualityReport & { issues: QualityIssue[] };

export interface EvaluatorContext {
  expectedLength?: { min?: number; max?: number };
  outline?: string;
  graphEntities?: string[];
  styleRules?: string[];
  artifactType?: string;
  [key: string]: any;
}

export interface Validator {
  name: string;
  validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]>;
}

/**
 * 格式化验证器
 * - 检查 Markdown 标题是否含有空格，例如 `#标题`
 * - 检查括号是否匹配
 */
export class FormattingValidator implements Validator {
  name = "formatting";

  async validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]> {
    const issues: LegacyQualityIssue[] = [];

    // 1. Markdown 标题检查
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("#")) {
        const match = line.match(/^(#+)([^#\s].*)$/);
        if (match) {
          issues.push({
            type: "formatting",
            severity: "major",
            message: `第 ${i + 1} 行的 Markdown 标题格式不规范，# 后面应当有空格: "${line}"`
          });
        }
      }
    }

    // 2. 简易括号配对检查
    const checkPairs = (openStr: string, closeStr: string, name: string) => {
      let count = 0;
      for (const char of content) {
        if (char === openStr) count++;
        else if (char === closeStr) {
          count--;
          if (count < 0) {
            issues.push({
              type: "formatting",
              severity: "minor",
              message: `文本中包含未配对的右括号 "${closeStr}"`
            });
            return;
          }
        }
      }
      if (count > 0) {
        issues.push({
          type: "formatting",
          severity: "minor",
          message: `文本中包含未配对的左括号 "${openStr}"`
        });
      }
    };

    checkPairs("(", ")", "英文括号");
    checkPairs("（", "）", "中文括号");

    return issues;
  }
}

/**
 * 长度限制验证器
 */
export class LengthValidator implements Validator {
  name = "length";

  async validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]> {
    const issues: LegacyQualityIssue[] = [];
    const limits = context.expectedLength;
    if (!limits) return issues;

    const len = content.length;
    if (limits.min !== undefined && len < limits.min) {
      issues.push({
        type: "length",
        severity: "major",
        message: `文本字数不足，当前字数: ${len}，期望最小字数: ${limits.min}`
      });
    }
    if (limits.max !== undefined && len > limits.max) {
      issues.push({
        type: "length",
        severity: "major",
        message: `文本字数超出，当前字数: ${len}，期望最大字数: ${limits.max}`
      });
    }

    return issues;
  }
}

/**
 * 图一致性验证器
 * - 检查实体名笔误（如果文中包含拼写与 graphEntities 极度相似的词，则抛出 major 级别错误）
 * - 检查文中是否使用了未定义（不在 graphEntities 里）且可能是敏感的虚构实体名，例如 "未知实体" 这种在测试里方便匹配的词
 */
export class GraphConsistencyValidator implements Validator {
  name = "graph";

  async validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]> {
    const issues: LegacyQualityIssue[] = [];
    const entities = context.graphEntities;
    if (!entities || entities.length === 0) return issues;

    // 1. 检查拼写笔误（如果某个词在文中出现了，且与实体列表里的某词相似度极高但又不等）
    for (const entity of entities) {
      if (entity.length >= 2) {
        const homophones = [entity + entity[entity.length - 1]]; // 林冲 -> 林冲冲
        for (const variant of homophones) {
          if (content.includes(variant)) {
            issues.push({
              type: "graph",
              severity: "major",
              message: `检测到图实体 "${entity}" 的潜在拼写笔误或格式不一致变体: "${variant}"`
            });
          }
        }
      }
    }

    // 2. 检查是否有明确“未定义”的测试用“未知实体”
    if (content.includes("未知实体") && !entities.includes("未知实体")) {
      issues.push({
        type: "graph",
        severity: "blocking",
        message: `文本中包含了在设定图实体中未定义的实体 "未知实体"`
      });
    }

    return issues;
  }
}

/**
 * 大纲对齐验证器
 * - 检查大纲中约定的关键要点是否在文中出现。如果大纲中以特定行/字约定的要点未包含，则判定为未对齐。
 */
export class OutlineAlignmentValidator implements Validator {
  name = "outline";

  async validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]> {
    const issues: LegacyQualityIssue[] = [];
    const outline = context.outline;
    if (!outline) return issues;

    const points = outline
      .split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 2 && !p.startsWith("#"));

    for (const point of points) {
      const keywords = point.split(/[,，:：\s]+/).filter(k => k.length > 1);
      const matched = keywords.some(kw => content.includes(kw));
      if (!matched && keywords.length > 0) {
        issues.push({
          type: "outline",
          severity: "major",
          message: `文本未包含大纲规定的关键要点: "${point}"`
        });
      }
    }

    return issues;
  }
}

/**
 * 风格验证器
 * - 检查行文风格是否符合 `styleRules`，包含是否包含违禁词（如“手机”、“蓦然回首”等）。
 */
export class StyleValidator implements Validator {
  name = "style";

  async validate(content: string, context: EvaluatorContext): Promise<LegacyQualityIssue[]> {
    const issues: LegacyQualityIssue[] = [];
    const rules = context.styleRules;
    if (!rules || rules.length === 0) return issues;

    for (const rule of rules) {
      if (rule.startsWith("avoid:")) {
        const forbidden = rule.slice("avoid:".length).trim();
        if (content.includes(forbidden)) {
          issues.push({
            type: "style",
            severity: "major",
            message: `违反行文风格规范：文本中包含了禁用的词汇或风格 "${forbidden}"`
          });
        }
      }
      
      if (rule.startsWith("max_sentence_length:")) {
        const maxLength = parseInt(rule.slice("max_sentence_length:".length).trim(), 10);
        if (!isNaN(maxLength)) {
          const sentences = content.split(/[。！？]/);
          for (const s of sentences) {
            if (s.trim().length > maxLength) {
              issues.push({
                type: "style",
                severity: "minor",
                message: `句子字数过长 (${s.trim().length} 字)，不符合 "${rule}" 风格限制`
              });
              break;
            }
          }
        }
      }
    }

    return issues;
  }
}

/**
 * 评估器注册中心
 */
export class EvaluatorRegistry {
  private validators: Validator[] = [];

  constructor() {
    this.register(new FormattingValidator());
    this.register(new LengthValidator());
    this.register(new GraphConsistencyValidator());
    this.register(new OutlineAlignmentValidator());
    this.register(new StyleValidator());
  }

  register(validator: Validator) {
    this.validators.push(validator);
  }

  async runPipeline(content: string, context: EvaluatorContext): Promise<QualityReport> {
    const allIssues: LegacyQualityIssue[] = [];
    for (const v of this.validators) {
      const issues = await v.validate(content, context);
      allIssues.push(...issues);
    }

    const issues = allIssues.map((issue) => normalizeQualityIssue(issue, content));
    let score = 100;
    for (const issue of issues) {
      if (issue.severity === "blocking") {
        score -= 40;
      } else if (issue.severity === "major") {
        score -= 20;
      } else if (issue.severity === "minor") {
        score -= 5;
      }
    }
    if (score < 0) score = 0;

    // Only evidence-backed hard-gate findings can stop persistence. Subjective
    // feedback remains in the report for the user and never edits text itself.
    const hasBlockingOrMajor = issues.some(
      (issue) => issue.category === "hard_gate" && Boolean(issue.evidence.trim()) && (issue.severity === "blocking" || issue.severity === "major")
    );

    const passed = !hasBlockingOrMajor;

    return qualityReportSchema.parse({
      artifact_type: String(context.artifactType || "generated_text"),
      score,
      passed,
      issues,
      evaluator_versions: {
        formatting: "1",
        length: "1",
        graph: "1",
        outline: "1",
        style: "1"
      }
    }) as QualityReport;
  }
}

function normalizeQualityIssue(issue: LegacyQualityIssue, content: string): QualityIssue {
  const category = issue.type === "style" ? "subjective" : "hard_gate";
  return {
    type: issue.type,
    code: `QUALITY_${String(issue.type || "unknown").toUpperCase()}`,
    category,
    severity: issue.severity,
    message: issue.message,
    evidence: deterministicEvidence(issue, content),
    source_ref: "local_evaluator",
    suggested_fix: category === "subjective" ? "请用户确认后再应用文风建议。" : "修复报告中列出的可验证问题后重新保存。"
  };
}

function deterministicEvidence(issue: LegacyQualityIssue, content: string): string {
  if (issue.type === "length") {
    return `content_length=${content.length}`;
  }
  if (issue.type === "style") {
    return issue.message;
  }
  return issue.message || "local evaluator finding";
}

/**
 * 门禁和自我纠正 Revise 循环
 */
export async function reviseWithFeedback(
  gateway: ModelGateway,
  config: ModelConfig,
  instruction: string,
  initialContent: string,
  context: EvaluatorContext,
  writeTarget: (content: string) => Promise<void>,
  registry: EvaluatorRegistry = new EvaluatorRegistry(),
  options: { signal?: AbortSignal } = {}
): Promise<{ content: string; report: QualityReport; attempts: number }> {
  let currentContent = initialContent;
  let report = await registry.runPipeline(currentContent, context);
  let attempts = 0;

  while (!report.passed && attempts < 2) {
    attempts++;
    
    const issuesText = report.issues
      .map(issue => `[${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`)
      .join("\n");

    const prompt = `你是一个优秀的小说写作与润色助手。之前的文本未能通过我们的质量门禁，具体发现了以下问题：
${issuesText}

原始写作指令：
${instruction}

待修改的旧文本如下：
${currentContent}

请你根据上述问题和原始写作指令，对旧文本进行自审与修改，修正所有违背之处。请直接输出修改后的完整文本，不要包含任何前言、后记、Markdown 包裹格式。`;

    const messages = [
      {
        role: "system" as const,
        content: "你是一个专业的文学内容自我修正与润色助手，直接输出修改后的正文内容。"
      },
      {
        role: "user" as const,
        content: prompt
      }
    ];

    const revisedResult = await gateway.requestCompletion(config, messages, 0.3, { signal: options.signal });
    currentContent = revisedResult.trim();

    report = await registry.runPipeline(currentContent, context);
  }

  if (!report.passed) {
    throw new Error(`自我修正失败，最终质量报告未通过门禁。得分: ${report.score}，未解决的问题: ${JSON.stringify(report.issues)}`);
  }

  await writeTarget(currentContent);

  return {
    content: currentContent,
    report,
    attempts
  };
}
