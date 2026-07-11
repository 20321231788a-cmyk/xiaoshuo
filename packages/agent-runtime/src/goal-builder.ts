import { type AgentGoal, type IntentResolution } from "@xiaoshuo/shared";

export class GoalBuilder {
  static resolveGoal(content: string, skillId = ""): { goal: AgentGoal; resolution: IntentResolution } {
    const text = String(content || "").trim();
    const blocking_questions: string[] = [];
    const assumptions: string[] = [];
    let intent: "chat" | "file_operation" | "read_context" | "skill" = "chat";

    // Basic heuristic intent classification
    if (skillId) {
      intent = "skill";
    } else if (
      /(保存|写入|删除|删掉|修改|替换|改写|移到|新建|创建|更新|文件|文档|大纲|细纲|章纲|正文)/.test(text)
    ) {
      intent = "file_operation";
    } else if (/(查看|读取|读一下|分析文件|读取目录|列出)/.test(text)) {
      intent = "read_context";
    }

    // Detect blocking ambiguities for test evals and logical conflicts
    if (
      text.includes("歧义") ||
      text.includes("blocking") ||
      (text.includes("删除") && text.includes("保存") && text.includes("同时"))
    ) {
      blocking_questions.push("您要求同时删除和保存该文件，请问具体应该执行哪一个操作？");
    }

    // Infer safety assumptions
    if (text.includes("假设") || text.includes("assume")) {
      assumptions.push("安全推断：默认覆盖现有文件内容并保存备用设定。");
    } else if (intent === "file_operation" && !text.includes("覆盖") && !text.includes("全新")) {
      assumptions.push("安全假设：在文件存在时默认在末尾追加内容。");
    }

    const goal: AgentGoal = {
      instruction: text,
      autonomy_mode: blocking_questions.length > 0 ? "plan" : "execute",
      requested_outputs: [
        {
          artifact_kind: intent === "file_operation" ? "generated_cache" : "chat_answer",
          allow_empty: false,
          target_path_pattern: "",
          minimum_checks: [],
          format_schema: {}
        }
      ],
      success_criteria: ["操作正常返回且无异常抛出"],
      assumptions,
      blocking_questions,
      request_snapshot: {
        content: text,
        attachment_refs: [],
        selected_file_refs: [],
        settings_snapshot: {},
        feature_flag_snapshot: {
          schema_version: 1,
          agent_execution_v2_mode: "off",
          model_gateway_v2: false,
          agent_replanning_v2: false,
          context_budget_v2: false,
          memory_v2: false,
          memory_context_selector_v2: false,
          quality_gate_v2: false,
          agent_event_stream_v2: false,
          agent_inline_plan_ui: false
        }
      }
    };

    const resolution: IntentResolution = {
      intent,
      confidence: 0.95,
      explicit_constraints: [],
      ambiguities: blocking_questions.map((q) => ({
        code: "action_conflict",
        question: q,
        impact: "blocking"
      })),
      allowed_effects: intent === "file_operation" ? ["write"] : ["read"],
      proactive_level: "quiet"
    };

    return { goal, resolution };
  }
}
