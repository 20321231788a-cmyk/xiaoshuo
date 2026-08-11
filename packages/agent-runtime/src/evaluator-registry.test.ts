import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelGateway } from "@xiaoshuo/model-client";
import { ExecutionStore } from "./kernel/execution-store.js";
import {
  EvaluatorRegistry,
  FormattingValidator,
  LengthValidator,
  GraphConsistencyValidator,
  OutlineAlignmentValidator,
  StyleValidator,
  reviseWithFeedback
} from "./evaluator-registry.js";
import { FeedbackLearner } from "./feedback-learner.js";

// Helper to create a temporary project directory for ExecutionStore
function createTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "feedback-learner-test-"));
}

function makeRun(projectRoot: string, overrides: any = {}): any {
  return {
    schema_version: 2,
    version: 1,
    run_id: "run_test",
    request_id: "request-1",
    conversation_id: "conversation-1",
    project_id: "project-1",
    project_path: projectRoot,
    goal: {
      instruction: "Write a chapter",
      autonomy_mode: "execute",
      requested_outputs: [],
      success_criteria: ["chapter exists"],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: {
        content: "Write a chapter",
        attachment_refs: [],
        selected_file_refs: [],
        settings_snapshot: {},
        feature_flag_snapshot: {}
      }
    },
    goal_revision: 1,
    plan_version: 1,
    plan_status: "draft",
    status: "queued",
    current_step_id: "",
    runtime_instance_id: "",
    heartbeat_at: "",
    lease_expires_at: "",
    pause_requested_at: "",
    cancel_requested_at: "",
    recovery_reason: "",
    error_code: "",
    error: "",
    budget: {
      tokens: 100000,
      cost_usd_limit: 1.0,
      time_limit_seconds: 300,
      cost_usd_accumulated: 0
    },
    last_event_sequence: 0,
    state: {
      status: "queued",
      current_step_id: "",
      steps: [],
      artifacts: [],
      confirmations: [],
      next_action_id: 1,
      run_events: [],
      write_leases: [],
      control_operations: [],
      runtime_instances: [],
      outbound_disclosures: []
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

// Mock ModelGateway to simulate LLM responses for the revise loop
class MockModelGateway extends ModelGateway {
  public calls: { messages: any[] }[] = [];
  public responses: string[] = [];
  private responseIndex = 0;

  constructor(responses: string[]) {
    super(null as any);
    this.responses = responses;
  }

  override async requestCompletion(
    config: any,
    messages: any[],
    temperature?: number,
    options: any = {}
  ): Promise<string> {
    this.calls.push({ messages });
    const resp = this.responses[this.responseIndex++];
    if (resp === undefined) {
      return "默认的合格文本。这里有设定图实体林冲和大纲陆谦。字数足够。";
    }
    return resp;
  }
}

describe("EvaluatorRegistry and Validators (Formatting Quality Reports)", () => {
  const registry = new EvaluatorRegistry();

  it("FormattingValidator should report markdown headers without space and mismatched brackets", async () => {
    const validator = new FormattingValidator();
    const content = "#错误标题\n这是一个测试(带有未闭合的括号。\n这里还有个中文括号（也是未闭合的。";
    const issues = await validator.validate(content, {});
    
    expect(issues.some(i => i.type === "formatting" && i.severity === "major" && i.message.includes("#错误标题"))).toBe(true);
    expect(issues.some(i => i.type === "formatting" && i.severity === "minor" && i.message.includes("未配对的左括号"))).toBe(true);
  });

  it("LengthValidator should report violations of expectedLength constraints", async () => {
    const validator = new LengthValidator();
    const content = "太短";
    const issues = await validator.validate(content, { expectedLength: { min: 10, max: 100 } });
    
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("major");
    expect(issues[0]?.message).includes("文本字数不足");

    const contentLong = "a".repeat(101);
    const issuesLong = await validator.validate(contentLong, { expectedLength: { min: 10, max: 100 } });
    expect(issuesLong).toHaveLength(1);
    expect(issuesLong[0]?.severity).toBe("major");
    expect(issuesLong[0]?.message).includes("文本字数超出");
  });

  it("GraphConsistencyValidator should check undefined entities and spelling typos", async () => {
    const validator = new GraphConsistencyValidator();
    const context = { graphEntities: ["林冲", "鲁智深"] };

    // Typos (duplicate character at the end as typo rule test: 林冲 -> 林冲冲)
    const issuesTypo = await validator.validate("林冲冲走在路上", context);
    expect(issuesTypo.some(i => i.type === "graph" && i.severity === "major" && i.message.includes("潜在拼写笔误"))).toBe(true);

    // Undefined "未知实体"
    const issuesUndefined = await validator.validate("文中有个未知实体在活动", context);
    expect(issuesUndefined.some(i => i.type === "graph" && i.severity === "blocking")).toBe(true);
  });

  it("OutlineAlignmentValidator should check alignment with outline key points", async () => {
    const validator = new OutlineAlignmentValidator();
    const context = { outline: "大纲要点:\n- 陆谦密谋\n- 柴进借书" };

    const issues = await validator.validate("文中只提到了柴进借书，没有其他内容。", context);
    expect(issues.some(i => i.type === "outline" && i.severity === "major" && i.message.includes("陆谦密谋"))).toBe(true);
    expect(issues.some(i => i.type === "outline" && i.message.includes("柴进借书"))).toBe(false);
  });

  it("StyleValidator should report style issues like avoid rules", async () => {
    const validator = new StyleValidator();
    const context = { styleRules: ["avoid: 手机", "max_sentence_length: 10"] };

    const issuesAvoid = await validator.validate("他从兜里掏出了手机。", context);
    expect(issuesAvoid.some(i => i.type === "style" && i.severity === "major" && i.message.includes("禁用的词汇或风格 \"手机\""))).toBe(true);

    const issuesLength = await validator.validate("这是一句非常非常非常非常非常非常长的句子。", context);
    expect(issuesLength.some(i => i.type === "style" && i.severity === "minor" && i.message.includes("句子字数过长"))).toBe(true);
  });

  it("runPipeline should aggregate scores and evaluate passed status", async () => {
    const context = {
      expectedLength: { min: 20 },
      outline: "大纲: 陆谦",
      graphEntities: ["林冲"],
      styleRules: ["avoid: 手机"]
    };

    // Passed text
    const goodReport = await registry.runPipeline("林冲在草料场。陆谦也在。字数很多足够长。", context);
    expect(goodReport.passed).toBe(true);
    expect(goodReport.score).toBe(100);

    // Failed text with major issues
    const badReport = await registry.runPipeline("林冲带了手机。", context);
    // Contains style avoid major, and outline major, and length major.
    expect(badReport.passed).toBe(false);
    expect(badReport.score).toBeLessThan(60);
  });
});

describe("Self-Correction Revise Loop (2-attempt revision limits)", () => {
  const registry = new EvaluatorRegistry();
  const context = {
    outline: "大纲要点: 陆谦",
    graphEntities: ["林冲"],
    expectedLength: { min: 15 }
  };
  const mockConfig = { configured: true, model: "gpt-4o", base_url: "mock" };

  it("should succeed in 1 revision attempt when first LLM output passes", async () => {
    // Initial text has no outline point '陆谦'
    const initialText = "林冲风雪草料场，字数足够长。";
    const revisedText = "林冲风雪草料场，陆谦阴谋害他，字数足够长。";
    
    const gateway = new MockModelGateway([revisedText]);
    let writtenContent = "";
    const writeTarget = async (content: string) => {
      writtenContent = content;
    };

    const res = await reviseWithFeedback(
      gateway,
      mockConfig as any,
      "写一章林冲的故事",
      initialText,
      context,
      writeTarget,
      registry
    );

    expect(res.attempts).toBe(1);
    expect(res.content).toBe(revisedText);
    expect(writtenContent).toBe(revisedText);
    expect(res.report.passed).toBe(true);
  });

  it("should fail and block writing if it exceeds the 2-attempt limit and still fails", async () => {
    const initialText = "林冲风雪草料场，字数足够长。";
    const badResponse1 = "依然没有陆谦的修改本1。";
    const badResponse2 = "依然没有陆谦的修改本2。";

    const gateway = new MockModelGateway([badResponse1, badResponse2]);
    let written = false;
    const writeTarget = async (content: string) => {
      written = true;
    };

    await expect(
      reviseWithFeedback(
        gateway,
        mockConfig as any,
        "写一章林冲的故事",
        initialText,
        context,
        writeTarget,
        registry
      )
    ).rejects.toThrow("自我修正失败，最终质量报告未通过门禁");

    expect(written).toBe(false); // blocked
    expect(gateway.calls).toHaveLength(2); // exactly 2 attempts
  });

  it("should succeed in the 2nd attempt if the second revision passes", async () => {
    const initialText = "林冲风雪草料场，字数足够长。";
    const badResponse1 = "依然没有陆谦的修改本1。";
    const goodResponse2 = "林冲风雪草料场，陆谦终于出现了！字数够了。";

    const gateway = new MockModelGateway([badResponse1, goodResponse2]);
    let writtenContent = "";
    const writeTarget = async (content: string) => {
      writtenContent = content;
    };

    const res = await reviseWithFeedback(
      gateway,
      mockConfig as any,
      "写一章林冲的故事",
      initialText,
      context,
      writeTarget,
      registry
    );

    expect(res.attempts).toBe(2);
    expect(res.content).toBe(goodResponse2);
    expect(writtenContent).toBe(goodResponse2);
    expect(res.report.passed).toBe(true);
  });
});

describe("FeedbackLearner (Preference Agg Triggers & Reversion Paths)", () => {
  let projectRoot: string;
  let store: ExecutionStore;
  let learner: FeedbackLearner;

  beforeEach(() => {
    projectRoot = createTempProject();
    store = ExecutionStore.open(projectRoot, {
      backupBeforeMigration: false,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    store.createRun(makeRun(projectRoot));
    learner = new FeedbackLearner(store);
  });

  afterEach(() => {
    store.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("should store feedback in database and trigger pending preference candidate upon 3 discard signals", async () => {
    // 1. Add first discard feedback
    await learner.addFeedback({
      feedback_id: "fb_1",
      run_id: "run_test",
      artifact_id: "art_1",
      action: "discard",
      task_type: "poetry"
    });

    let candidates = await learner.getPreferenceCandidates();
    expect(candidates).toHaveLength(0); // Only 1 discard feedback, not aggregated yet

    // 2. Add second discard feedback
    await learner.addFeedback({
      feedback_id: "fb_2",
      run_id: "run_test",
      artifact_id: "art_2",
      action: "discard",
      task_type: "poetry"
    });

    candidates = await learner.getPreferenceCandidates();
    expect(candidates).toHaveLength(0); // 2 discards, not aggregated yet

    // 3. Add third discard feedback -> triggers aggregation
    await learner.addFeedback({
      feedback_id: "fb_3",
      run_id: "run_test",
      artifact_id: "art_3",
      action: "discard",
      task_type: "poetry"
    });

    candidates = await learner.getPreferenceCandidates();
    expect(candidates).toHaveLength(1); // Triggers candidate creation!
    
    const cand = candidates[0]!;
    expect(cand.status).toBe("pending");
    expect(cand.scope).toBe("project");
    expect(cand.target).toBe("poetry");
    expect(cand.key).toBe("poetry_style_preference");
    expect(cand.proposed_value).toBe("avoid_poetry_failures");
    expect(cand.evidence_feedback_ids).toContain("fb_1");
    expect(cand.evidence_feedback_ids).toContain("fb_2");
    expect(cand.evidence_feedback_ids).toContain("fb_3");
  });

  it("should support reverting PreferenceVersion (reversion paths)", async () => {
    // Create version v1 (active)
    await learner.createPreferenceVersion({
      preference_version: "v1",
      parent_version: null,
      scope: "project",
      status: "active"
    });

    // Create version v2 (parent is v1, active)
    await learner.createPreferenceVersion({
      preference_version: "v2",
      parent_version: "v1",
      scope: "project",
      status: "active"
    });

    // Verify initial states
    let v1 = await learner.getPreferenceVersion("v1");
    let v2 = await learner.getPreferenceVersion("v2");
    expect(v1?.status).toBe("active");
    expect(v2?.status).toBe("active");

    // Perform rollback on v2
    const rolledBackTo = await learner.rollbackVersion("v2");
    expect(rolledBackTo).toBe("v1");

    // Verify states after rollback
    v1 = await learner.getPreferenceVersion("v1");
    v2 = await learner.getPreferenceVersion("v2");
    expect(v2?.status).toBe("rolled_back");
    expect(v1?.status).toBe("active"); // parent is restored to active
  });

  it("keeps feedback as a pending candidate until an explicit user confirmation binds an eval manifest", async () => {
    for (const feedbackId of ["fb_confirm_1", "fb_confirm_2", "fb_confirm_3"]) {
      await learner.addFeedback({
        feedback_id: feedbackId,
        run_id: "run_test",
        artifact_id: `artifact_${feedbackId}`,
        action: "discard",
        task_type: "chapter"
      });
    }
    const candidate = (await learner.getPreferenceCandidates()).find((item) => item.target === "chapter");
    expect(candidate?.status).toBe("pending");
    await expect(learner.approveCandidate(candidate!.candidate_id, "", "manifest.json")).rejects.toMatchObject({
      code: "PREFERENCE_CONFIRMATION_REQUIRED"
    });

    const version = await learner.approveCandidate(candidate!.candidate_id, "user-1", "output/evals/quality/manifest.json");
    expect(version.status).toBe("active");
    expect(version.eval_manifest_ref).toBe("output/evals/quality/manifest.json");
    expect(version.applied_candidate_ids).toEqual([candidate!.candidate_id]);
    expect((await learner.getPreferenceCandidates()).find((item) => item.candidate_id === candidate!.candidate_id)?.status).toBe("approved");
  });
});
