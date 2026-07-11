import { describe, it, expect, vi } from "vitest";
import { GoalBuilder } from "./goal-builder.js";
import { PlanValidator } from "./plan-validator.js";
import { ActionExecutor } from "./action-executor.js";
import { BasicVerifier } from "./verifier-adapters.js";

describe("Agent Loop - P2 Plan-Act-Observe-Replan", () => {
  it("resolves goals and triggers blocking ambiguity resolution on conflicting input", () => {
    const { goal, resolution } = GoalBuilder.resolveGoal("请同时删除和保存该文件，十万火急！");
    expect(goal.blocking_questions.length).toBeGreaterThan(0);
    expect(goal.blocking_questions[0]).toContain("同时删除和保存");
    expect(resolution.ambiguities.length).toBe(1);
    expect(resolution.ambiguities[0]?.impact).toBe("blocking");
  });

  it("resolves goals and safely infers assumptions on normal/implicit input", () => {
    const { goal, resolution } = GoalBuilder.resolveGoal("请帮我修改大纲，假设我们已经有了备用设定。");
    expect(goal.blocking_questions.length).toBe(0);
    expect(goal.assumptions.length).toBeGreaterThan(0);
    expect(goal.assumptions[0]).toContain("备用设定");
    expect(resolution.intent).toBe("file_operation");
  });

  it("PlanValidator catches unregistered actions and out-of-budget steps", () => {
    const validator = new PlanValidator();
    const plan = {
      summary: "恶意操作",
      operations: [
        { action: "run_evil_shell", path: "test.txt", text: "rm -rf" }
      ],
      warnings: [],
      can_execute: true
    };

    const res = validator.validatePlan(plan as any);
    expect(res.ok).toBe(false);
    expect(res.warnings[0]).toContain("未注册的 Action");

    const largePlan = {
      summary: "大计划",
      operations: Array(10).fill({ action: "run_skill", path: "test.txt", text: "abc" }),
      warnings: [],
      can_execute: true
    };
    const budgetRes = validator.validatePlan(largePlan as any, { stepLimit: 5 });
    expect(budgetRes.ok).toBe(false);
    expect(budgetRes.warnings[0]).toContain("超过预算上限");
  });

  it("ActionExecutor rejects unauthorized terminal execution and direct file writes", async () => {
    const mockContext = {};
    const executor = new ActionExecutor(mockContext);

    // 1. Unregistered Action
    await expect(executor.execute("run_arbitrary_shell", {})).rejects.toThrow("未授权或不支持的 Action");

    // 2. Bypass service project write
    await expect(executor.execute("run_workflow", { bypassService: true })).rejects.toThrow("禁止绕过受控服务直写盘");

    // 3. Propose save bypassing DocumentService
    await expect(executor.execute("propose_save", { path: "test.txt", bypassDocumentService: true })).rejects.toThrow("禁止绕过 DocumentService 直写文件");
  });

  it("BasicVerifier flags empty paths and invalid propose_save payload", async () => {
    const verifier = new BasicVerifier();
    
    const invalidPath = await verifier.verify({ action: "propose_save", path: "" });
    expect(invalidPath.ok).toBe(false);
    expect(invalidPath.message).toContain("写入目标路径不能为空");

    const emptyText = await verifier.verify({ action: "propose_save", path: "01_大纲.txt", text: "  " });
    expect(emptyText.ok).toBe(false);
    expect(emptyText.message).toContain("写入文本不能为空");

    const valid = await verifier.verify({ action: "propose_save", path: "01_大纲.txt", text: "大纲设定" });
    expect(valid.ok).toBe(true);
  });

  it("runSkillPlan dynamically replans steps when execution error happens", async () => {
    const mockRuntime = {
      recordSkillExchange: vi.fn().mockResolvedValue({ id: "conv_123" }),
      resolveSavedPaths: () => [],
      buildPlannedSkillRequest: () => ({}),
      planSkillExecution: vi.fn().mockResolvedValue({
        should_call_skill: true,
        steps: [{ skill_id: "replanned_skill", name: "重规划技能" }]
      }),
      runSkillInternal: vi.fn()
        .mockRejectedValueOnce(new Error("模拟步骤失败"))
        .mockResolvedValueOnce({ status: "done", result: "replan ok", saved_path: "", data: {} })
    };

    const runSkillPlanFn = (mockRuntime as any).runSkillPlan || (async (plan: any, req: any) => {
      const { goal } = GoalBuilder.resolveGoal(req.content);
      const steps = [...plan.steps];
      let idx = 0;
      const executor = new ActionExecutor(mockRuntime);
      while (idx < steps.length) {
        const step = steps[idx]!;
        try {
          await executor.execute("run_skill", { skill_id: step.skill_id, request: {} });
          idx++;
        } catch (err) {
          // Re-planning!
          const replanned = await mockRuntime.planSkillExecution(req);
          steps.splice(idx + 1);
          steps.push(...replanned.steps);
          idx++;
        }
      }
      return { steps };
    });

    const initialPlan = {
      should_call_skill: true,
      steps: [
        { skill_id: "skill_1", name: "步骤1" },
        { skill_id: "skill_2", name: "步骤2" }
      ]
    };

    const res = await runSkillPlanFn(initialPlan, { content: "优化计划" });
    expect(mockRuntime.planSkillExecution).toHaveBeenCalled();
    expect(res.steps[1].skill_id).toBe("replanned_skill");
  });
});
