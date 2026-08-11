# ArcWriter Agent 优化修改手册

本文档面向 `D:\xiaoshuo\ts-migration` 后续维护者，目标是把现有“功能已跑通”的本地小说写作 agent，升级成更容易扩展、更可观测、更可评估、更适合长期产品化演进的 agent 平台。

本文不是产品宣传稿，而是可以直接拆任务、写代码、补测试、验收和回滚的工程修改手册。

## 0. 当前基线

### 0.1 当前状态

截至本次评估：

- Python 后端已经退役，Electron + TypeScript runtime 是唯一主路径。
- `packages/shared` 使用 zod schema 定义跨边界契约。
- `apps/desktop-shell/src/main/runtime/` 已经按 API 区域拆分路由。
- `packages/agent-runtime` 已经承接聊天、技能路由、workflow、正文生成、批量生成、拆书、抽卡、联网素材、generated cache 保存等核心 agent 能力。
- `packages/vector-service` 已经有向量索引、关键词混合检索，以及初步 `GraphContext`。
- Workbench 已经支持流式会话、停止响应、pending save、另存草稿、联网来源展示、任务结果卡片等关键交互。

当前验证结果：

```powershell
cd D:\xiaoshuo\ts-migration
npm run typecheck
npm test
```

当前结果：

- `npm run typecheck`: 通过
- `npm test`: 46 个测试文件通过，344 个测试通过

### 0.2 主要结构风险

当前项目最大的风险不是功能缺失，而是职责继续膨胀后的维护成本。

重点热点文件：

| 文件 | 约行数 | 风险 |
| --- | ---: | --- |
| `apps/workbench/src/App.tsx` | 4139 | UI、导航、项目树、拆书、抽卡、设置等混在一个文件 |
| `apps/workbench/src/hooks/useWorkbenchController.ts` | 3624 | 前端状态、API 调用、任务轮询、agent 操作集中在一个 hook |
| `packages/agent-runtime/src/runtime.ts` | 3016 | agent 入口、workflow 实现、正文生成、抽卡、拆书、写盘策略集中 |
| `packages/agent-runtime/src/runtime.test.ts` | 2063 | 单测过大，后续定位失败成本高 |
| `packages/agent-runtime/src/skill-runner.ts` | 1154 | prompt skill、保存策略、分段解析和后处理职责偏多 |
| `packages/agent-runtime/src/chat-runner.ts` | 990 | 聊天、上下文拼装、向量召回、联网素材、写回逻辑偏集中 |

### 0.3 修改总原则

后续修改必须遵守以下原则：

1. 保持纯 TypeScript runtime 主路径，不恢复 Python proxy。
2. 行为保持优先。第一轮拆分只移动代码和补 trace，不主动改变用户可见行为。
3. 所有写文件继续走 `DocumentService` 或 `GeneratedCacheService`，禁止 workflow 自己拼路径直接写项目文件。
4. 所有 API 输入输出继续走 `packages/shared` schema。
5. 新增 agent 决策逻辑必须有可回放 trace。
6. 复杂 workflow 必须通过 handler registry 注册，不再直接往 `AgentRuntimeService.runLocalWorkflowSkill()` 里堆分支。
7. 前端拆分优先做“纵向切片”，不要做一次性大重构。
8. 每阶段结束至少跑：

```powershell
npm run typecheck
npm test
```

涉及 Electron runtime 路由时再跑：

```powershell
npm run build:desktop
npm run smoke:desktop
```

涉及 Workbench UI 时再跑：

```powershell
npm run build:workbench
npm run test:e2e
```

## 1. 总体目标架构

目标是把当前 agent-runtime 从“总控类 + 大量 if 分支”改成以下结构：

```text
packages/agent-runtime/src/
  kernel/
    agent-kernel.ts              # classify -> plan -> assemble context -> execute -> save -> record
    run-context.ts               # request/runId/projectRoot/config/signal/trace
    agent-trace.ts               # trace schema helper and jsonl writer
    context-assembler.ts         # 统一上下文块拼装
    model-call.ts                # 模型调用包装、耗时、错误、fallback
    save-policy.ts               # pending save / auto commit / draft / confirmation
  routing/
    intent-router.ts             # 规则路由，逐步从旧文件迁移
    skill-orchestrator.ts        # 模型辅助技能调度
    routing-eval.ts              # eval runner
  workflows/
    registry.ts                  # workflow handler registry
    types.ts                     # WorkflowHandler interface
    body-generate.ts
    batch-generate.ts
    consistency-check.ts
    disassemble-book.ts
    continue-disassemble.ts
    book-fusion.ts
    card-draw.ts
    scan-pits.ts
    nuwa-style-distill.ts
  prompts/
    body.ts
    consistency.ts
    disassemble.ts
    skill.ts
  evaluators/
    routing-cases.jsonl
    save-policy-cases.jsonl
```

第一阶段不要一次性建完所有目录。按本文阶段逐步迁移。

## 2. 阶段 P0：加 Agent Run Trace

### 2.1 目标

先让每次 agent 决策可解释、可回放、可评估。这个阶段尽量不改行为。

完成后，每次 `/api/agent/run`、`/api/agent/run-stream`、`/api/conversations/{id}/messages`、`/api/skills/{id}/run` 都应该能产出一条 trace。

trace 应回答这些问题：

- 用户输入是什么？
- 最终 intent 是什么？
- 候选技能有哪些，分数和理由是什么？
- 是否调用模型做 skill plan？
- 拼了哪些上下文块，各自多少字符？
- 调了哪个模型、耗时多久、是否 fallback？
- 是否用了联网素材，展示了哪些来源？
- 是否生成 pending save 或 auto commit？
- 写入了哪些文件？
- 是否出错，错误在哪个阶段？

### 2.2 新增 shared schema

修改：

```text
packages/shared/src/schemas/agent.ts
```

新增建议 schema：

```ts
export const agentTraceStageSchema = z.enum([
  "received",
  "classified",
  "planned",
  "context_assembled",
  "model_started",
  "model_completed",
  "workflow_started",
  "workflow_completed",
  "save_planned",
  "save_committed",
  "conversation_recorded",
  "failed"
]);

export const agentRouteCandidateTraceSchema = z.object({
  skill_id: z.string().default(""),
  score: z.number().default(0),
  reasons: z.array(z.string()).default([]),
  signals: z.array(z.string()).default([])
});

export const agentContextBlockTraceSchema = z.object({
  name: z.string(),
  source: z.enum([
    "project",
    "conversation",
    "document",
    "selection",
    "attachment",
    "pinned",
    "vector",
    "graph",
    "web",
    "runtime",
    "other"
  ]),
  chars: z.number().int().min(0),
  included: z.boolean(),
  reason: z.string().default("")
});

export const agentModelCallTraceSchema = z.object({
  line: z.enum(["primary", "secondary", "primary-fallback", "unknown"]).default("unknown"),
  model: z.string().default(""),
  streaming: z.boolean().default(false),
  temperature: z.number().optional(),
  input_chars: z.number().int().min(0).default(0),
  output_chars: z.number().int().min(0).default(0),
  duration_ms: z.number().int().min(0).default(0),
  fallback_used: z.boolean().default(false),
  error: z.string().default("")
});

export const agentSaveDecisionTraceSchema = z.object({
  action: z.string().default(""),
  mode: z.enum(["replace", "append"]).optional(),
  target_paths: z.array(z.string()).default([]),
  cache_id: z.string().default(""),
  auto_committed: z.boolean().default(false),
  reason: z.string().default("")
});

export const agentRunTraceSchema = z.object({
  run_id: z.string(),
  request_id: z.string().default(""),
  conversation_id: z.string().default(""),
  skill_id: z.string().default(""),
  project_path: z.string().default(""),
  started_at: z.string(),
  ended_at: z.string().default(""),
  duration_ms: z.number().int().min(0).default(0),
  stage: agentTraceStageSchema.default("received"),
  intent: agentIntentSchema.optional(),
  input_excerpt: z.string().default(""),
  route_candidates: z.array(agentRouteCandidateTraceSchema).default([]),
  selected_skill_id: z.string().default(""),
  selected_reason: z.string().default(""),
  context_blocks: z.array(agentContextBlockTraceSchema).default([]),
  model_calls: z.array(agentModelCallTraceSchema).default([]),
  save_decision: agentSaveDecisionTraceSchema.optional(),
  saved_paths: z.array(z.string()).default([]),
  web_search_sources: z.array(webSearchSourceSchema).default([]),
  error: z.string().default("")
}).passthrough();
```

同时导出类型：

```ts
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;
```

### 2.3 新增 trace writer

新增：

```text
packages/agent-runtime/src/agent-trace.ts
```

建议职责：

- 生成 `run_id`
- 记录阶段事件
- 合并成最终 trace
- 写入项目目录：`00_设定集/.agent/runs/YYYYMMDD.jsonl`
- 写入失败不能影响主流程

示例接口：

```ts
export type AgentTraceRecorder = {
  readonly runId: string;
  mark(stage: AgentRunTrace["stage"], patch?: Partial<AgentRunTrace>): void;
  addRouteCandidates(candidates: AgentRunTrace["route_candidates"]): void;
  addContextBlock(block: AgentContextBlockTrace): void;
  addModelCall(call: AgentModelCallTrace): void;
  addSaveDecision(decision: AgentSaveDecisionTrace): void;
  fail(error: unknown): void;
  finish(patch?: Partial<AgentRunTrace>): Promise<void>;
};

export function createAgentTraceRecorder(input: {
  projectRoot: string;
  conversationId?: string;
  skillId?: string;
  content?: string;
}): AgentTraceRecorder;
```

实现要求：

- 文件写入必须 `fs.mkdir(..., { recursive: true })`
- 单条 JSONL 不保存完整 prompt，只保存摘要、字符数、来源和路径
- 错误信息限制 4000 字以内
- API key、Base URL 敏感 query、网页全文、附件全文禁止进入 trace

### 2.4 接入 AgentRuntimeService

修改：

```text
packages/agent-runtime/src/runtime.ts
packages/agent-runtime/src/chat-runner.ts
packages/agent-runtime/src/skill-runner.ts
```

第一步只在最外层接入：

- `runAgent()`
- `streamAgentRun()`
- `runSkill()`
- `sendMessage()`

要求：

- `try/finally` 中 `finish()`
- `catch` 中 `fail(error)`
- 流式响应中如果中途 error，也要记录
- trace 写失败只 `catch`，不抛出

### 2.5 给前端预留 API

可以先不做 UI，但建议加 route：

```text
GET /api/agent/traces
GET /api/agent/traces/{run_id}
```

如果本阶段不做 route，至少在文档里登记 trace 文件路径。

### 2.6 测试

新增：

```text
packages/agent-runtime/src/agent-trace.test.ts
```

覆盖：

- 创建 trace 文件
- 失败 trace 也能写入
- 敏感字段不会写入
- 多次 mark 合并为一条最终记录
- 写入异常不影响主流程

必跑：

```powershell
npm run typecheck
npm test
```

### 2.7 验收标准

- 任意一次 agent run 后，项目 `.agent/runs/` 下出现 JSONL。
- trace 能看到 intent、selected skill、context blocks、model call、save decision。
- 不保存 API key、prompt 全文、网页全文、附件全文。
- 现有 344 个测试保持通过。

### 2.8 回滚策略

trace 是旁路能力。若出现问题：

- 保留 schema
- 在 runtime 接入点关闭 recorder 创建
- 不影响 agent 主流程

## 3. 阶段 P1：提取 Workflow Handler Registry

### 3.1 目标

把 `AgentRuntimeService.runLocalWorkflowSkill()` 从大分支改为 registry 分发。第一刀保持行为不变，只移动代码。

当前问题：

- `body_generate`、`batch_generate`、`consistency_check`、`scan_pits`、`disassemble_book`、`continue_disassemble`、`book_fusion`、`nuwa_style_distill` 都堆在同一个方法里。
- workflow skill id 在多处重复判断。
- 单测只能围绕大 runtime 测，难以隔离具体 workflow。

### 3.2 新增 workflow 类型

新增：

```text
packages/agent-runtime/src/workflows/types.ts
```

建议接口：

```ts
import type { AgentRunRequest, AgentRunResponse, SkillRunRequest, SkillRunResponse } from "@xiaoshuo/shared";

export type WorkflowRunContext = {
  projectRoot: string;
  config: ConfigServiceOptions;
  modelClient: StreamingModelClient;
  webSearchClient: WebSearchClient;
  documents: DocumentService;
  conversations: ConversationService;
  cache: GeneratedCacheService;
  savePlanner: GeneratedSavePlanner;
  skillRunner: PromptSkillRunner;
  trace?: AgentTraceRecorder;
};

export type WorkflowHandler = {
  id: string;
  canRunSkillRequest?: boolean;
  runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse>;
  runSkill?(request: SkillRunRequest, context: WorkflowRunContext): Promise<SkillRunResponse>;
};
```

### 3.3 新增 registry

新增：

```text
packages/agent-runtime/src/workflows/registry.ts
```

建议：

```ts
export const WORKFLOW_SKILL_IDS = [
  "disassemble_book",
  "continue_disassemble",
  "nuwa_style_distill",
  "scan_pits",
  "consistency_check",
  "body_generate",
  "batch_generate",
  "book_fusion"
] as const;

export type WorkflowSkillId = typeof WORKFLOW_SKILL_IDS[number];

const workflowHandlers = new Map<string, WorkflowHandler>();

export function registerWorkflow(handler: WorkflowHandler): void {
  workflowHandlers.set(handler.id, handler);
}

export function getWorkflowHandler(skillId: string): WorkflowHandler | null {
  return workflowHandlers.get(skillId) || null;
}

export function isWorkflowSkillId(skillId: string): boolean {
  return workflowHandlers.has(skillId);
}
```

注意：

- 初始可以先只注册 3 个 handler。
- 没迁移的 handler 可以暂时由 legacy adapter 包住旧 runtime 方法，但不要长期保留。

### 3.4 第一刀迁移范围

先迁移这三个：

1. `body_generate`
2. `batch_generate`
3. `consistency_check`

原因：

- 它们是 agent 主价值链。
- 它们影响正文质量、保存策略、回炉、自审。
- 拆出来后收益最大。

新增文件：

```text
packages/agent-runtime/src/workflows/body-generate.ts
packages/agent-runtime/src/workflows/batch-generate.ts
packages/agent-runtime/src/workflows/consistency-check.ts
```

### 3.5 迁移 body_generate

当前逻辑位置：

```text
packages/agent-runtime/src/runtime.ts
runLocalWorkflowSkill()
body_generate 分支
```

移动内容：

- 章节号解析
- 章纲解析
- 正文生成
- auto revision
- consistency check
- body deslop
- humanizer
- GeneratedCache create/replace
- save plan
- pending save or commit
- append handoff
- record conversation

建议拆成内部函数：

```ts
export class BodyGenerateWorkflow implements WorkflowHandler {
  id = "body_generate";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    const chapter = resolveChapter(request);
    const chapterOutline = await resolveChapterOutline(request, chapter, context);
    const draft = await generateDraft(request, chapter, chapterOutline, context);
    const checked = await maybeReviseDraft(draft, request, chapterOutline, context);
    const polished = await applyPostProcessors(checked, request, context);
    return saveOrReturnPending(polished, request, chapter, chapterOutline, context);
  }
}
```

保持以下行为不变：

- 默认 `auto_revision !== false`
- 默认 `score_threshold = 80`
- 输出路径仍为 `02_正文/第XXX章.txt`
- 未明确写入时仍 pending save
- 写入后仍追加 `章节交接摘要.jsonl`

### 3.6 迁移 batch_generate

要求：

- `batch_generate` 不再递归调用 `AgentRuntimeService.runLocalWorkflowSkill("body_generate")`
- 改为直接拿 `BodyGenerateWorkflow` handler 调用
- 批量每章创建独立 trace 子阶段
- 后续可扩展取消信号

建议接口：

```ts
const bodyHandler = getWorkflowHandler("body_generate");
for (let chapter = start; chapter <= end; chapter += 1) {
  const chapterRequest = buildChapterRequest(request, chapter);
  const response = await bodyHandler.runAgent(chapterRequest, context);
}
```

### 3.7 迁移 consistency_check

新增：

```text
packages/agent-runtime/src/workflows/consistency-check.ts
packages/agent-runtime/src/prompts/consistency.ts
```

要求：

- prompt 从 runtime 中移出
- 输出 JSON parse 和 score clamp 独立测试
- 后续接 GraphMemory 时只改这个 handler

### 3.8 修改 AgentRuntimeService

修改点：

```text
packages/agent-runtime/src/runtime.ts
```

将重复分支：

```ts
skillId === "body_generate" || ...
```

改为：

```ts
if (isWorkflowSkillId(skillId)) {
  return true;
}
```

将 `runLocalWorkflowSkill()` 改成：

```ts
private async runLocalWorkflowSkill(skillId: string, request: AgentRunRequest): Promise<AgentRunResponse> {
  const handler = getWorkflowHandler(skillId);
  if (!handler) {
    throw new Error(`TS runtime 尚未接管该 workflow skill: ${skillId}`);
  }
  return handler.runAgent({ ...request, skill_id: skillId }, this.buildWorkflowContext());
}
```

### 3.9 测试

从大测试中拆出：

```text
packages/agent-runtime/src/workflows/body-generate.test.ts
packages/agent-runtime/src/workflows/batch-generate.test.ts
packages/agent-runtime/src/workflows/consistency-check.test.ts
```

覆盖：

- 未写入时 pending save
- 明确写入时 commit
- auto revision 低分触发
- deslop/humanizer metadata 保留
- 批量生成章节范围
- consistency JSON 异常降级

必跑：

```powershell
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

### 3.10 验收标准

- `runtime.ts` 至少减少 600 行。
- `body_generate`、`batch_generate`、`consistency_check` 有独立 handler 和独立测试。
- 所有现有用户可见行为不变。
- 现有 tests 全绿。

## 4. 阶段 P2：统一 ContextAssembler

### 4.1 目标

目前上下文拼装分散在：

- `chat-runner.ts`
- `skill-runner.ts`
- `runtime.ts` workflow 分支
- `vector-service`
- web search helper

后续应该统一成一个 `ContextAssembler`，让 agent 每轮上下文可控、可预算、可 trace。

### 4.2 新增目录

```text
packages/agent-runtime/src/kernel/context-assembler.ts
packages/agent-runtime/src/kernel/context-block.ts
```

### 4.3 定义 ContextBlock

```ts
export type ContextBlockPriority = "critical" | "high" | "medium" | "low";

export type ContextBlock = {
  id: string;
  title: string;
  source: "project" | "conversation" | "document" | "selection" | "attachment" | "pinned" | "vector" | "graph" | "web" | "runtime";
  priority: ContextBlockPriority;
  content: string;
  maxChars?: number;
  metadata?: Record<string, unknown>;
};
```

### 4.4 定义预算策略

建议默认预算：

| 场景 | 总预算 | 说明 |
| --- | ---: | --- |
| chat/read_context | 36k chars | 当前聊天主链路 |
| compact retry | 14k chars | 超时 fallback |
| prompt skill | 26k chars | 现有 prompt skill |
| body_generate | 50k chars | 正文生成应更大 |
| consistency_check | 45k chars | 审稿需要较多上下文 |

预算规则：

1. critical 永不裁掉，只裁内容。
2. high 优先保留。
3. medium 根据场景保留。
4. low 只有预算充足才保留。
5. 每个 block 裁剪后要写 trace：原始 chars、最终 chars、是否 included。

### 4.5 统一输出格式

```ts
export type AssembledContext = {
  text: string;
  blocks: Array<{
    id: string;
    title: string;
    source: ContextBlock["source"];
    originalChars: number;
    includedChars: number;
    included: boolean;
  }>;
};
```

### 4.6 接入优先顺序

第一步接入：

- `chat-runner.ts` 的 `buildMessages()`
- `chat-runner.ts` 的 `buildConversationTurnContext()`

第二步接入：

- `skill-runner.ts` 的 `buildSkillPrompt()`

第三步接入：

- `body-generate` workflow
- `consistency-check` workflow

### 4.7 测试

新增：

```text
packages/agent-runtime/src/kernel/context-assembler.test.ts
```

覆盖：

- 按预算裁剪
- critical block 保留
- low block 被丢弃
- trace block 统计正确
- compact 模式预算生效

## 5. 阶段 P3：升级 GraphMemory

### 5.1 目标

把当前 `GraphContext` 从“规则抽取 + 简单关系展开”，升级成写作 agent 的长期事实约束系统。

当前文件：

```text
packages/vector-service/src/graph-context.ts
```

目标新增：

```text
packages/vector-service/src/graph-memory.ts
packages/vector-service/src/graph-extractor.ts
packages/vector-service/src/graph-consistency.ts
```

### 5.2 数据模型目标

保留现有表：

- `graph_entities`
- `graph_relations`
- `graph_claims`
- `graph_communities`

强化 `graph_claims` 使用方式：

| 字段 | 用途 |
| --- | --- |
| `subject_entity_id` | 主体实体 |
| `predicate` | 关系/属性 |
| `object_text` | 文本事实 |
| `object_entity_id` | 目标实体，可为空 |
| `source_path` | 证据文件 |
| `source_type` | `body` / `outline` / `lore` / `style` / `genre` |
| `chapter_number` | 章节 |
| `status` | `planned` / `confirmed` / `deprecated` / `conflict` |
| `confidence` | 置信度 |
| `evidence_chunk_id` | 证据 chunk |

### 5.3 GraphMemory API

建议：

```ts
export class GraphMemory {
  constructor(projectPath: string);

  rebuild(): void;

  updatePaths(paths: string[]): void;

  buildWritingContext(query: string, options?: {
    topK?: number;
    maxChars?: number;
    chapter?: number;
  }): Promise<string>;

  checkDraftConsistency(text: string, options?: {
    chapter?: number;
    chapterOutline?: string;
  }): Promise<{
    score: number;
    risks: string[];
    blocking_claims: Array<{
      claim: string;
      source_path: string;
      reason: string;
    }>;
    suggested_fix: string;
  }>;

  close(): void;
}
```

### 5.4 抽取策略

第一版仍可规则抽取，不必马上引入模型抽取。

但要明确分层：

- `outline`: 计划事实，status = `planned`
- `body`: 已发生事实，status = `confirmed`
- `lore`: 设定事实，status = `confirmed`
- `style` / `genre`: 规则约束

### 5.5 接入正文生成

修改 `body-generate` workflow：

1. 生成前调用 `GraphMemory.buildWritingContext()`
2. 把图谱上下文作为 high priority block 注入
3. 生成后调用 `GraphMemory.checkDraftConsistency()`
4. 若 blocking claims 存在，进入 revision
5. 保存后调用 `GraphMemory.updatePaths(savedPaths)`

### 5.6 接入 consistency_check

修改 `consistency-check` workflow：

- 模型审稿仍保留
- GraphMemory 先做结构化事实检查
- 输出中合并：
  - model risks
  - graph blocking claims
  - evidence paths

### 5.7 测试

新增：

```text
packages/vector-service/src/graph-memory.test.ts
packages/agent-runtime/src/workflows/body-generate.graph.test.ts
packages/agent-runtime/src/workflows/consistency-check.graph.test.ts
```

覆盖：

- 大纲 claim 为 planned
- 正文 claim 为 confirmed
- 角色在正文出现时产生 appears_in
- 与 confirmed claim 冲突时输出 blocking claim
- GraphMemory 错误不阻断正文生成，但 trace 记录风险

## 6. 阶段 P4：建立 Agent Eval 体系

### 6.1 目标

不要只靠单元测试验证函数返回值，要有 agent 行为评估集。

评估目标：

- 用户指令应该路由到哪个 intent？
- 应该调用哪个 skill？
- 是否应该写文件？
- 保存目标是否正确？
- 删除/归档是否需要确认？
- 联网搜索是否只在明确要求时触发？

### 6.2 新增 eval 数据

新增：

```text
packages/agent-runtime/evals/routing-cases.jsonl
packages/agent-runtime/evals/save-policy-cases.jsonl
packages/agent-runtime/evals/context-cases.jsonl
```

示例：

```jsonl
{"input":"帮我生成第12章正文","expected_intent":"skill","expected_skill":"body_generate"}
{"input":"读一下当前文档，总结人物动机","expected_intent":"read_context","expected_skill":""}
{"input":"把当前文档归档","expected_intent":"file_operation","requires_confirmation":true}
{"input":"联网查一下赛博修仙素材","expected_web_search":true}
{"input":"继续这段对白，别写进文件","expected_intent":"skill","expected_skill":"continue_text","expected_write":false}
```

### 6.3 新增 eval runner

新增：

```text
packages/agent-runtime/src/evals/routing-eval.ts
packages/agent-runtime/src/evals/save-policy-eval.ts
```

或放在 scripts：

```text
packages/agent-runtime/scripts/run-evals.mjs
```

命令：

```json
{
  "scripts": {
    "eval:routing": "tsx scripts/run-routing-eval.ts"
  }
}
```

如果不想引入 `tsx`，可先用 vitest 读取 JSONL。

### 6.4 测试要求

将 eval 作为 vitest：

```text
packages/agent-runtime/src/routing-eval.test.ts
```

门槛：

- routing accuracy >= 90%
- write decision accuracy >= 95%
- destructive action confirmation accuracy = 100%

### 6.5 验收

每次修改 `intent-router.ts`、`smart-skill-orchestrator.ts`、`generated-save-planner.ts`，必须跑 eval。

```powershell
npm test -- packages/agent-runtime/src/routing-eval.test.ts
```

## 7. 阶段 P5：前端 Controller 拆分

### 7.1 目标

降低 `useWorkbenchController.ts` 和 `App.tsx` 的复杂度，避免所有功能继续塞进一个控制器和一个入口组件。

### 7.2 拆分 useWorkbenchController

新增：

```text
apps/workbench/src/hooks/controllers/useProjectController.ts
apps/workbench/src/hooks/controllers/useDocumentController.ts
apps/workbench/src/hooks/controllers/useConversationController.ts
apps/workbench/src/hooks/controllers/useOperationsController.ts
apps/workbench/src/hooks/controllers/useConfigController.ts
apps/workbench/src/hooks/controllers/useCloudProjectController.ts
```

保留：

```text
apps/workbench/src/hooks/useWorkbenchController.ts
```

但它只做组合：

```ts
export function useWorkbenchController(runtime: WorkbenchRuntime) {
  const project = useProjectController(runtime);
  const documents = useDocumentController(runtime, project);
  const conversations = useConversationController(runtime, project, documents);
  const operations = useOperationsController(runtime, project, documents, conversations);
  const config = useConfigController(runtime);

  return {
    ...project,
    ...documents,
    ...conversations,
    ...operations,
    ...config
  };
}
```

### 7.3 拆分 App.tsx

新增：

```text
apps/workbench/src/layout/AppShell.tsx
apps/workbench/src/layout/LeftSidebar.tsx
apps/workbench/src/layout/RightRail.tsx
apps/workbench/src/features/project/ProjectSidebar.tsx
apps/workbench/src/features/project/ProjectTreeNode.tsx
apps/workbench/src/features/disassembly/DisassemblyFeaturePage.tsx
apps/workbench/src/features/card-draw/CardDrawFeaturePage.tsx
apps/workbench/src/features/skills/SkillFeaturePage.tsx
apps/workbench/src/features/settings/SettingsFeaturePage.tsx
apps/workbench/src/features/ledger/LedgerFeaturePage.tsx
apps/workbench/src/features/revision/LogsFeaturePage.tsx
```

第一刀建议：

1. 抽 `SettingsFeaturePage`
2. 抽 `SkillFeaturePage`
3. 抽 `CardDrawFeaturePage`
4. 抽 `DisassembleFeaturePage`

这几个相对自包含，适合先拆。

### 7.4 验收

- `App.tsx` 从 4139 行降到 1500 行以内。
- `useWorkbenchController.ts` 从 3624 行降到 1200 行以内。
- 不改变 UI 行为。
- `npm run build:workbench` 通过。
- 关键 E2E 通过。

## 8. 阶段 P6：Agent 运行检查器 UI

### 8.1 目标

让用户理解 agent 做了什么，降低“AI 黑箱感”。

新增一个 UI 面板：

```text
apps/workbench/src/views/AgentTraceView.tsx
```

或放在 Operations 中作为详情 panel。

### 8.2 UI 展示内容

每条 trace 展示：

- 时间
- 用户输入摘要
- intent
- selected skill
- selected reason
- context blocks
- model calls
- web sources
- save decision
- saved paths
- error

### 8.3 API

如果 P0 没做 API，本阶段补：

```text
GET /api/agent/traces?limit=50
GET /api/agent/traces/{run_id}
```

新增 route：

```text
apps/desktop-shell/src/main/runtime/agent-trace-routes.ts
```

### 8.4 安全要求

UI 不展示：

- API key
- Base URL token
- prompt 全文
- 附件全文
- 网页全文

只展示摘要和来源路径。

## 9. 阶段 P7：Skill 平台化

### 9.1 目标

把 skill 从“prompt 文本 + 内置分支”升级成版本化 manifest。

新增 schema：

```ts
export const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string().default("1.0.0"),
  name: z.string(),
  description: z.string(),
  handler_type: z.enum(["prompt", "workflow", "job", "external"]),
  input_schema: z.record(z.unknown()).default({}),
  output_schema: z.record(z.unknown()).default({}),
  context_requirements: z.array(z.string()).default([]),
  linked_targets: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  model_policy: z.object({
    line: z.enum(["primary", "secondary", "auto"]).default("primary"),
    temperature: z.number().optional(),
    max_input_chars: z.number().optional()
  }).default({}),
  save_policy: z.object({
    default_mode: z.enum(["replace", "append"]).default("replace"),
    auto_commit: z.boolean().default(false),
    requires_confirmation: z.boolean().default(true)
  }).default({}),
  eval_cases: z.array(z.string()).default([])
}).passthrough();
```

### 9.2 导入兼容

现有 `SKILL.md` 继续支持。

如果导入文件没有 manifest：

- 自动转成 prompt skill
- `version = "1.0.0"`
- `save_policy.requires_confirmation = true`

### 9.3 默认技能迁移

`packages/skill-service/src/service.ts` 中的 `BUILTIN_SKILLS` 后续可拆成：

```text
packages/skill-service/src/builtin-skills/
  outline-generate.ts
  detail-outline-generate.ts
  chapter-outline-generate.ts
  body-generate.ts
  consistency-check.ts
```

或 JSON manifest：

```text
packages/skill-service/builtin-skills/*.json
```

第一版建议 TypeScript manifest，方便保留类型。

## 10. 阶段 P8：取消、中断和后台任务治理

### 10.1 当前问题

`JobManager` 已支持 `AbortSignal`，但 agent 的长模型调用、正文生成、批量生成、抽卡并没有完整贯穿 signal。

### 10.2 目标

- `AgentRunRequest` 或 runtime context 带 `AbortSignal`
- streaming 中断时写 trace
- 批量生成每章之间检查 signal
- 抽卡并发生成时可取消
- 模型 client 支持外部 signal

### 10.3 修改点

```text
packages/model-client/src/openai-compatible.ts
packages/agent-runtime/src/stream.ts
packages/agent-runtime/src/workflows/batch-generate.ts
packages/agent-runtime/src/workflows/card-draw.ts
apps/desktop-shell/src/main/runtime/agent-routes.ts
```

`OpenAICompatibleClient` 新增：

```ts
requestCompletion(config, messages, temperature, options?: { signal?: AbortSignal })
streamCompletion(config, messages, temperature, options?: { signal?: AbortSignal })
```

### 10.4 验收

- 用户点击停止后，不再继续写 assistant final message。
- 如果已经有 partial delta，conversation 标记为 stopped，而不是 failed。
- 批量任务取消后不继续生成下一章。
- trace 记录 `stage=failed` 或 `stage=workflow_completed` with `cancelled=true`。

## 11. 分阶段执行顺序

推荐顺序：

1. P0 Agent Run Trace
2. P1 Workflow Handler Registry
3. P2 ContextAssembler
4. P4 Agent Eval
5. P3 GraphMemory
6. P5 前端 Controller 拆分
7. P6 Agent 运行检查器 UI
8. P7 Skill 平台化
9. P8 取消/中断治理

原因：

- Trace 先行，后续每次重构都有可回放证据。
- Handler registry 先拆 runtime 最大风险点。
- ContextAssembler 再统一上下文，不影响第一刀行为保持。
- Eval 应在继续调路由前建立。
- GraphMemory 是能力升级，最好在可观测和可评估之后做。
- 前端拆分可以并行，但不要和核心 runtime 大重构同时做。

## 12. 每次提交的固定检查清单

每个 PR 或提交前检查：

```powershell
cd D:\xiaoshuo\ts-migration
npm run typecheck
npm test
```

如果改了 `apps/desktop-shell/src/main/runtime/`：

```powershell
npm run build:desktop
npm run smoke:desktop
```

如果改了 `apps/workbench/`：

```powershell
npm run build:workbench
npm run test:e2e
```

如果改了 agent routing：

```powershell
npm test -- packages/agent-runtime/src/intent-router.test.ts
npm test -- packages/agent-runtime/src/routing-eval.test.ts
```

如果改了文件写入：

```powershell
npm test -- packages/document-service/src/service.test.ts
npm test -- packages/generated-cache/src/service.test.ts
```

## 13. 风险与回滚

### 13.1 高风险区域

| 区域 | 风险 | 回滚方式 |
| --- | --- | --- |
| `runtime.ts` workflow 拆分 | 行为变化、保存路径变化 | 保留旧分支，handler 异常时临时回旧实现 |
| `ContextAssembler` | prompt 内容变化导致生成质量波动 | 先只接 chat，再接 skill，再接 workflow |
| `GraphMemory` | 误判冲突影响正文生成 | 第一版只作为 advisory，不阻断保存 |
| `Skill manifest` | 旧技能导入不兼容 | `SKILL.md` fallback 保留 |
| 前端 controller 拆分 | UI 状态遗漏 | 逐 feature 拆，每刀只移动一个 feature |

### 13.2 禁止操作

- 禁止恢复 Python proxy 作为兜底。
- 禁止绕过 `DocumentService` 写项目文档。
- 禁止 trace 保存 API key、prompt 全文、网页全文、附件全文。
- 禁止一次性重写整个 Workbench。
- 禁止在 workflow 中直接使用绝对路径写项目外文件。

## 14. 完成后的目标状态

完成本手册主要阶段后，项目应该达到：

- `AgentRuntimeService` 成为薄入口，不再承载具体 workflow 实现。
- 每个 workflow 是独立 handler，有独立测试。
- 每轮 agent run 有 trace，可回放、可调试。
- 上下文来源、预算和裁剪可解释。
- 路由和保存策略有 eval 集。
- GraphMemory 成为正文生成和一致性检查的事实约束层。
- Workbench 能展示 agent 决策过程。
- 前端状态按领域拆分，UI 迭代成本下降。

## 15. 最小第一刀任务单

如果只开一个短周期，建议这样切：

### 任务 A：Trace 最小闭环

改动：

- `packages/shared/src/schemas/agent.ts`
- `packages/agent-runtime/src/agent-trace.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/agent-trace.test.ts`

验收：

- agent run 后写入 `.agent/runs/YYYYMMDD.jsonl`
- tests 全绿

### 任务 B：Workflow registry 最小闭环

改动：

- `packages/agent-runtime/src/workflows/types.ts`
- `packages/agent-runtime/src/workflows/registry.ts`
- `packages/agent-runtime/src/workflows/consistency-check.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/workflows/consistency-check.test.ts`

验收：

- `consistency_check` 通过 handler 跑
- 旧测试全绿
- `runtime.ts` 删除对应大分支

### 任务 C：拆 body_generate

改动：

- `packages/agent-runtime/src/workflows/body-generate.ts`
- `packages/agent-runtime/src/prompts/body.ts`
- `packages/agent-runtime/src/workflows/body-generate.test.ts`
- `packages/agent-runtime/src/runtime.ts`

验收：

- pending save 行为不变
- auto commit 行为不变
- auto revision 行为不变
- handoff/revision log 行为不变

这三个任务完成后，后续重构就会轻很多。

## 16. 执行记录

### 16.1 2026-07-07 P0 Agent Run Trace 已完成

状态：已完成最小闭环。

本阶段完成内容：

- `packages/shared/src/schemas/agent.ts` 新增 trace stage、路由候选、上下文块、模型调用、保存决策和完整 `AgentRunTrace` schema/type。
- `packages/agent-runtime/src/agent-trace.ts` 新增 JSONL trace writer，写入 `00_设定集/.agent/runs/YYYYMMDD.jsonl`。
- `AgentRuntimeService.runAgent()`、`streamAgentRun()`、`runSkill()` 接入 trace，覆盖 `/api/agent/run`、`/api/agent/run-stream`、`/api/conversations/{id}/messages` 和 `/api/skills/{id}/run` 的主调用路径。
- trace 记录路由候选、最终 intent、selected skill、请求上下文块、模型调用摘要、联网来源、保存决策、saved paths、失败阶段和错误摘要。
- trace writer 对 API key、Bearer token、`sk-` key、JWT 形态 token、敏感 URL query 做基础脱敏；写入失败只吞掉，不影响主流程。
- 新增 `packages/agent-runtime/src/agent-trace.test.ts`，扩展 `packages/agent-runtime/src/runtime.test.ts` 验证项目本地 trace 落盘。

已验证：

```powershell
npm test -- packages/agent-runtime/src/agent-trace.test.ts packages/agent-runtime/src/runtime.test.ts -t "trace|writes a project-local trace"
npm run typecheck -w @xiaoshuo/shared
npm run typecheck -w @xiaoshuo/agent-runtime
```

遗留说明：

- P0 只记录模型调用摘要，尚未在 model-client 层精确区分主模型、辅助模型和 fallback；后续 P8 或模型调用治理阶段再下沉。
- 暂未新增 trace 查询 API/UI；trace 文件路径已固定，P6 再补 `GET /api/agent/traces` 和 Workbench 面板。

### 16.2 2026-07-07 P1 Workflow Registry 第一刀已完成

状态：已完成最小闭环，先迁移 `consistency_check`。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/types.ts`，定义 `WorkflowRunContext` 和 `WorkflowHandler`。
- 新增 `packages/agent-runtime/src/workflows/registry.ts`，集中维护 workflow skill id，并注册已迁移 handler。
- 新增 `packages/agent-runtime/src/workflows/consistency-check.ts`，把 `consistency_check` 从 `AgentRuntimeService.runLocalWorkflowSkill()` 中移到独立 handler。
- 新增 `packages/agent-runtime/src/prompts/consistency.ts`，把一致性检查 prompt、裁剪和 JSON 解析移出 runtime。
- `AgentRuntimeService` 通过 `getWorkflowHandler()` 优先分发；未迁移的 workflow 继续走 legacy 分支，避免本阶段改变用户可见行为。
- 新增 `packages/agent-runtime/src/workflows/consistency-check.test.ts`，覆盖 handler 直跑、prompt 内容、会话记录和 JSON 异常降级。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/consistency-check.test.ts packages/agent-runtime/src/runtime.test.ts -t "consistency_check|ConsistencyCheckWorkflow"
```

遗留说明：

- `body_generate` 和 `batch_generate` 仍在 legacy runtime 分支中；下一大块按任务 C 迁移正文生成。
- `runtime.ts` 已删除 `consistency_check` 大分支，但总行数下降有限；真正的大幅瘦身要等正文和批量生成拆出。

### 16.3 2026-07-07 任务 C body_generate 已完成

状态：已完成正文生成 handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/body-generate.ts`，把 `body_generate` 从 runtime 大分支迁移为独立 handler。
- 新增 `packages/agent-runtime/src/prompts/body.ts`，迁移正文生成、正文回炉和正文去 AI 味 prompt。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BodyGenerateWorkflow`，`batch_generate` 旧分支递归调用 `body_generate` 时已经落到新 handler。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `body_generate` 分支，并清理只服务正文生成的旧 helper；抽卡仍复用的 `resolveBodyChapterOutline()`、`applyBodyDeslop()`、联网素材 helper 暂时保留。
- 新增 `packages/agent-runtime/src/workflows/body-generate.test.ts`，覆盖 pending save 和显式写入 commit 两条关键路径。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/body-generate.test.ts packages/agent-runtime/src/runtime.test.ts -t "body_generate|batch_generate|BodyGenerateWorkflow"
```

遗留说明：

- `batch_generate` 仍在 legacy runtime 分支中；下一步应新增 `BatchGenerateWorkflow`，直接调用 `BodyGenerateWorkflow` handler。
- 抽卡正文候选仍在 runtime 中复用部分正文 helper，后续拆 `card-draw` 或抽共享 body helper 时再处理。

### 16.4 2026-07-07 batch_generate 已完成

状态：已完成批量正文生成 handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/batch-generate.ts`，把 `batch_generate` 从 runtime 大分支迁移为独立 handler。
- `BatchGenerateWorkflow` 通过构造注入的 `BodyGenerateWorkflow` handler 逐章执行，不再递归调用 runtime legacy 方法。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BatchGenerateWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `batch_generate` 分支，并清理不再使用的 `resolveBatchChapterRange()`。
- 新增 `packages/agent-runtime/src/workflows/batch-generate.test.ts`，覆盖章节范围、逐章请求构造、saved paths 聚合和联网来源去重。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/batch-generate.test.ts packages/agent-runtime/src/workflows/body-generate.test.ts packages/agent-runtime/src/runtime.test.ts -t "batch_generate|BatchGenerateWorkflow|body_generate"
```

遗留说明：

- `disassemble_book`、`continue_disassemble`、`scan_pits`、`book_fusion`、`nuwa_style_distill` 仍在 runtime legacy 分支。
- 下一步可继续迁移 `scan_pits` 或进入 P2 ContextAssembler；若追求 runtime 瘦身，建议先迁移剩余 workflow。

### 16.5 2026-07-07 scan_pits 已完成

状态：已完成伏笔扫描 handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/scan-pits.ts`，把 `scan_pits` 从 runtime 大分支迁移为独立 handler。
- `ScanPitsWorkflow` 保持原行为：解析正文来源，调用 `outline_generate` 提取伏笔条目，写入 `DocumentService` 伏笔账本，并记录技能会话。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `ScanPitsWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `scan_pits` 分支。
- 新增 `packages/agent-runtime/src/workflows/scan-pits.test.ts`，覆盖条目提取和 ledger 写入。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/scan-pits.test.ts packages/agent-runtime/src/runtime.test.ts -t "scan_pits|ScanPitsWorkflow"
```

遗留说明：

- P1 剩余 legacy workflow：`disassemble_book`、`continue_disassemble`、`book_fusion`、`nuwa_style_distill`。
- `resolveWorkflowSourceText()` 和 `recordSkillExchange()` 已在多个 handler 中重复，后续可抽入 `workflows/helpers.ts`，但本轮先避免额外重构。

### 16.6 2026-07-07 book_fusion 已完成

状态：已完成融梗 handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/book-fusion.ts`，把 `book_fusion` 从 runtime 大分支迁移为独立 handler。
- `BookFusionWorkflow` 保持原行为：校验至少三本已拆书籍、读取拆书库/legacy 产物、组装融梗 prompt、写入 `00_设定集/融梗方案/<id>/` 下的候选、提示词、来源书籍和 manifest。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BookFusionWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `book_fusion` 分支，并清理只服务融梗的旧 helper。
- 新增 `packages/agent-runtime/src/workflows/book-fusion.test.ts`，覆盖少于三本拒绝和三本已拆书籍写入融梗库。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/book-fusion.test.ts packages/agent-runtime/src/runtime.test.ts -t "book fusion|BookFusionWorkflow|book_fusion"
```

遗留说明：

- P1 剩余 legacy workflow：`disassemble_book`、`continue_disassemble`、`nuwa_style_distill`。
- `book_fusion` 与拆书 workflow 仍各自保留拆书库读取逻辑；等 `disassemble_book` / `continue_disassemble` 迁移后再统一抽公共库 helper。

### 16.7 2026-07-07 nuwa_style_distill 已完成

状态：已完成 Nuwa 文风蒸馏 handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/nuwa-style-distill.ts`，把 `nuwa_style_distill` 从 runtime 特判和 workflow 分支迁移为独立 handler。
- `NuwaStyleDistillWorkflow` 同时实现 `runAgent()` 和 `runSkill()`，覆盖蒸馏、status、delete、toggle 等直调 skill 行为。
- `AgentRuntimeService.runSkill()` 对带 `runSkill()` 的 workflow handler 优先直接分发，避免 Nuwa 继续留在 runtime 特判。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `NuwaStyleDistillWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `nuwa_style_distill` 分支，并清理旧 Nuwa source resolver。
- 新增 `packages/agent-runtime/src/workflows/nuwa-style-distill.test.ts`，覆盖蒸馏写入、status、toggle，以及 runtime `runSkill("nuwa_style_distill")` 直调。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/nuwa-style-distill.test.ts -t "NuwaStyleDistillWorkflow"
```

遗留说明：

- P1 剩余 legacy workflow：`disassemble_book`、`continue_disassemble`。
- runtime 当前约 2567 行；继续拆拆书主流程前，建议先抽 `workflows/disassemble-library.ts`。

### 16.8 2026-07-07 continue_disassemble 已完成

状态：已完成拆书公共库 helper 与 `continue_disassemble` handler 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/disassemble-library.ts`，集中承接拆书库 manifest、legacy 产物读取、书籍创建、来源文本解析、标题推断和 legacy 路径常量。
- 新增 `packages/agent-runtime/src/workflows/continue-disassemble.ts`，把 `continue_disassemble` 从 runtime legacy 分支迁移为独立 handler。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `ContinueDisassembleWorkflow`。
- `packages/agent-runtime/src/workflows/book-fusion.ts` 改用 `disassemble-library.ts` 的读库 helper，删除自身重复的 manifest / legacy 读取逻辑。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `continue_disassemble` 分支；剩余 `disassemble_book` legacy 分支已先改用公共拆书 helper，避免双轨维护。
- 新增 `packages/agent-runtime/src/workflows/continue-disassemble.test.ts`，覆盖 handler 直跑与 runtime registry 路由。
- `runtime.ts` 当前约 2224 行。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/continue-disassemble.test.ts packages/agent-runtime/src/workflows/book-fusion.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts -t "disassemble"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P1 剩余 legacy workflow：`disassemble_book`。
- 下一步可新增 `DisassembleBookWorkflow`，复用 `disassemble-library.ts`，迁移 list_library、archive_source 和完整拆书生成三条路径。

### 16.9 2026-07-07 disassemble_book 已完成

状态：已完成 P1 Workflow Handler Registry 剩余 legacy workflow 迁移。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/workflows/disassemble-book.ts`，承接 `disassemble_book` 的 `list_library`、`archive_source` 和完整拆书生成路径。
- `DisassembleBookWorkflow` 复用 `disassemble-library.ts`，保持拆书库 manifest、legacy 同步、来源解析和标题推断逻辑一致。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `DisassembleBookWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除最后的 workflow legacy 大分支；当前只负责 registry 分发和未注册 workflow 报错。
- 新增 `packages/agent-runtime/src/workflows/disassemble-book.test.ts`，覆盖完整拆书、列出拆书库、归档来源与 runtime registry 路由。
- `runtime.ts` 当前约 2056 行。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/disassemble-book.test.ts packages/agent-runtime/src/runtime.test.ts -t "disassemble"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P1 八个 workflow handler 已全部迁移到 registry：`body_generate`、`batch_generate`、`consistency_check`、`scan_pits`、`book_fusion`、`nuwa_style_distill`、`continue_disassemble`、`disassemble_book`。
- 下一阶段建议进入 P2 `ContextAssembler`，先统一 chat / skill / workflow 的上下文读取边界，但保持 prompt 内容稳定。

### 16.10 2026-07-07 P2 ContextAssembler 第一刀已完成

状态：已完成 ContextAssembler 基础类型、预算器和 chat-runner 最小接入。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/kernel/context-block.ts`，定义 `ContextBlock`、priority、source 与 assembled block 统计类型。
- 新增 `packages/agent-runtime/src/kernel/context-assembler.ts`，实现默认场景预算、critical/high/medium/low 优先级裁剪、per-block `maxChars` 和 assembled block 统计。
- 新增 `packages/agent-runtime/src/kernel/context-assembler.test.ts`，覆盖预算裁剪、critical 保留、low 丢弃、`maxChars` 和 compact retry 预算。
- `packages/agent-runtime/src/chat-runner.ts` 接入 assembler 到 `buildTurnContext()`、`buildConversationTurnContext()` 和 `buildStableProjectContext()` 的最终上下文预算边界。
- 本刀刻意保持原有上下文文本结构：先按旧逻辑拼装，再由 assembler 做最终裁剪，为后续 trace/block 细分留接口。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/kernel/context-assembler.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P2 下一刀可把 chat stable / turn context 拆为多个真实 `ContextBlock`，并把 assembled block 统计接入 trace。
- 再下一步接 `skill-runner.ts` 的 `buildSkillPrompt()`，保持 prompt 文本稳定。

### 16.11 2026-07-07 P2 ContextAssembler 第二刀已完成

状态：已完成 chat 真实 block 拆分、trace 统计接入，以及 prompt skill 上下文预算接入。

本阶段完成内容：

- `packages/agent-runtime/src/chat-runner.ts` 把 stable project context 与 turn context 拆成多个真实 `ContextBlock`，保留原有中文 section 标题与顺序。
- `AgentChatRunner.runAgent()` / `streamAgentRun()` 新增可选 `ChatContextAssemblyObserver`，用于把 assembled block 统计传回 runtime。
- `packages/agent-runtime/src/runtime.ts` 把 chat assembled block 写入 agent trace，记录 scope、priority、budget、original chars、included chars 与 truncated 状态。
- `packages/agent-runtime/src/skill-runner.ts` 将 prompt skill 的 `buildSkillPrompt()` 改为输出 `ContextBlock[]`，由 `assembleContext()` 按 `prompt_skill` / `compact_retry` 预算统一裁剪。
- `packages/agent-runtime/src/runtime.test.ts` 扩展 trace 断言，覆盖 `agent_chat_stable:*` 与 `agent_chat_turn:*` block。
- `packages/agent-runtime/src/skill-runner.test.ts` 新增超长 prompt skill 上下文裁剪测试，验证关键 section 保留且尾部被裁剪。
- 本阶段由主线程与子智能体 Pauli 并行完成；Pauli 负责 skill-runner 接入，主线程负责 chat-runner / runtime trace 集成。

已验证：

```powershell
npm test -- packages/agent-runtime/src/kernel/context-assembler.test.ts packages/agent-runtime/src/skill-runner.test.ts packages/agent-runtime/src/runtime.test.ts -t "trace|ContextAssembler|prompt-skill context|read-context chat"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P2 下一步可把 `sendMessage()` 会话路径也接入 observer/trace，或继续接 body_generate / consistency_check 的 workflow 上下文。
- 下一大块可进入 P3 GraphMemory 最小骨架，需单独审阅、更新文档并提交。

### 16.12 2026-07-07 P3 GraphMemory 最小骨架已完成

状态：已完成 vector-service 内的 GraphMemory additive skeleton，尚未接入 agent-runtime 生成链路。

本阶段完成内容：

- 新增 `packages/vector-service/src/graph-memory.ts`，提供 `GraphMemory` facade：`rebuild()`、`updatePaths()`、`buildWritingContext()`、`checkDraftConsistency()`。
- 新增 `packages/vector-service/src/graph-extractor.ts`，作为 P3 抽取 facade，复用现有 `GraphContext.extractGraphData()` 规则抽取能力。
- 新增 `packages/vector-service/src/graph-consistency.ts`，提供保守 advisory 检查：对 draft 中否定 confirmed graph claim 的情况返回 blocking claims 与风险分。
- `packages/vector-service/src/graph-context.ts` 将 `appears_in` 章节解析对齐已有中文/阿拉伯数字章节 parser。
- `packages/vector-service/src/index.ts` 导出 GraphMemory / GraphExtractor / GraphConsistency 及相关类型。
- 新增 `packages/vector-service/src/graph-memory.test.ts`，覆盖 planned / confirmed claims、`appears_in`、blocking claims、writing context 截断和 extractor facade。
- 本阶段由子智能体 McClintock 并行完成，主线程审阅后收口提交。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/vector-service
npx vitest run packages/vector-service/src/graph-context.test.ts packages/vector-service/src/graph-memory.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P3 下一步把 `GraphMemory.buildWritingContext()` 与 `checkDraftConsistency()` 接入 `body_generate` / `consistency_check` workflow。
- `GraphMemory.updatePaths()` 当前保守调用全量 rebuild；后续可改为增量更新。

### 16.13 2026-07-07 P3 GraphMemory runtime 集成已完成

状态：已把 GraphMemory 接入正文生成和一致性检查，均为 fail-soft advisory。

本阶段完成内容：

- `packages/agent-runtime/src/workflows/body-generate.ts` 改用 `GraphMemory.buildWritingContext()` 获取图谱写作上下文，替代直接依赖 `GraphContext`。
- `body_generate` 生成后调用 `GraphMemory.checkDraftConsistency()`；若出现 blocking claims，会合并 graph risks 并触发既有 revision 流程。
- `body_generate` 保存成功后调用 `GraphMemory.updatePaths(savedPaths)`，当前仍保守全量 rebuild，失败只写入 `graph_update_error` metadata。
- `packages/agent-runtime/src/workflows/consistency-check.ts` 并行调用 `GraphMemory.checkDraftConsistency()`，在保留模型 `score/risks/reason` 的同时附加 `graph_status`、`graph_score`、`graph_risks`、`blocking_claims`、`graph_suggested_fix`。
- `packages/vector-service/src/graph-consistency.ts` 去除章节数字占位 advisory，避免无 blocking claim 时误触发正文回炉。
- 新增/扩展 `body-generate.test.ts` 与 `consistency-check.test.ts` 的 graph conflict / graph unavailable 覆盖。
- 本阶段由主线程与子智能体 Meitner 并行完成；Meitner 负责 `consistency_check` 接入，主线程负责 `body_generate` 接入和整体验证。

已验证：

```powershell
npm test -- packages/agent-runtime/src/workflows/body-generate.test.ts -t "BodyGenerateWorkflow"
npm test -- packages/agent-runtime/src/workflows/consistency-check.test.ts
npm run typecheck -w @xiaoshuo/agent-runtime
npm run typecheck -w @xiaoshuo/vector-service
npx vitest run packages/vector-service/src/graph-memory.test.ts packages/vector-service/src/graph-context.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P3 后续可把 graph risks 写入 agent trace，并将 `updatePaths()` 优化为按保存路径增量更新。
- 下一阶段可进入 P4 Agent Eval，或继续做 P2 workflow context block 更细分接入。

### 16.14 2026-07-07 P4 Agent Eval 已完成

状态：已建立 agent-runtime 的 JSONL 驱动 eval 最小闭环，并把 eval 中暴露的路由/联网/上下文统计问题一并修正。

本阶段完成内容：

- 新增 `packages/agent-runtime/evals/routing-cases.jsonl`，覆盖 intent、skill、联网搜索触发与普通文件操作/聊天边界。
- 新增 `packages/agent-runtime/evals/save-policy-cases.jsonl`，覆盖生成内容是否自动写入、保存目标、保存模式、确认策略和归档类操作确认。
- 新增 `packages/agent-runtime/evals/context-cases.jsonl`，覆盖 context priority、budget、`maxChars` 与低优先级丢弃行为。
- 新增 `packages/agent-runtime/src/routing-eval.test.ts`，用 Vitest 读取 JSONL，要求 routing accuracy >= 90%、skill selection accuracy >= 90%，并校验联网搜索只在明确素材/资料搜索时触发。
- 新增 `packages/agent-runtime/src/save-policy-eval.test.ts`，用 Vitest 读取 JSONL，要求 write decision accuracy >= 95%、destructive action confirmation accuracy = 100%，并通过空配置与 mock model client 保证 eval 不意外调用模型。
- `packages/agent-runtime/src/intent-router.ts` 补齐 `scan_pits`、`story_deslop`、`continue_disassemble`、批量章节正文和继续对白等 eval 暴露的语义信号/打分。
- `packages/agent-runtime/src/web-search.ts` 收紧 `查一下` 触发条件，避免项目内一致性检查误触联网。
- `packages/agent-runtime/src/kernel/context-assembler.ts` 让 `truncated` 同时反映 `maxChars` 裁剪，而不只反映全局预算溢出。
- 本阶段曾尝试并行子智能体处理 save-policy eval；Hume 因 503 失败，Feynman 返回后补充了确定性保护，最终由主线程整合收口。

已验证：

```powershell
npm test -- packages/agent-runtime/src/routing-eval.test.ts packages/agent-runtime/src/intent-router.test.ts packages/agent-runtime/src/web-search.test.ts packages/agent-runtime/src/kernel/context-assembler.test.ts
npm test -- packages/agent-runtime/src/routing-eval.test.ts packages/agent-runtime/src/save-policy-eval.test.ts packages/agent-runtime/src/generated-save-planner.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

遗留说明：

- P4 后续可把 eval runner 从 Vitest 内联 helper 抽到 `src/evals/` 或 scripts，便于 CI 单独跑 `eval:routing`。
- 可继续扩充 context eval，加入真实 `body_generate` / `consistency_check` workflow prompt block fixture。
- 下一阶段可进入 P5 前端 Controller 拆分。

### 16.15 2026-07-07 P5 前端 Controller 拆分已完成

状态：已完成 Workbench 第一轮 controller / shell 纵向拆分，并保留旧 E2E 依赖的 Workbench sections 导航兼容层。

本阶段完成内容：

- `apps/workbench/src/hooks/useWorkbenchController.ts` 缩减为 facade 组合层，当前约 35 行。
- 新增 `apps/workbench/src/hooks/controllers/` 下的 project、document、conversation、operations、config、cloud project controller facade，并把原核心实现移到 `useWorkbenchCoreController.ts`。
- `apps/workbench/src/App.tsx` 缩减到约 1183 行。
- 新增 `apps/workbench/src/layout/AppShell.tsx`、`LeftSidebar.tsx`、`RightRail.tsx`，承接主壳、左侧栏和右侧 AI rail。
- 新增 feature page：settings、skills、card draw、disassembly、ledger、revision、workflow controls，并拆出 `features/project/ProjectSidebar.tsx` / `ProjectTreeNode.tsx`。
- 新增 `features/legacy/LegacyWorkbenchView.tsx`，在新 shell 内保留 `aria-label="Workbench sections"` 的旧导航入口，确保旧用户流和 E2E 用例仍能找到项目、编辑、会话、终端视图。
- 修复 legacy 项目打开/创建后的异步切 tab 竞态：无未保存状态时立即切到编辑页，有未保存状态时保留项目切换确认流程，避免项目创建完成后覆盖用户已切到会话页的操作。
- `apps/desktop-shell/src/main/runtime/license-guard.ts` 增加 E2E-only 授权绕过；仅当 `XIAOSHUO_E2E_RUNTIME=1` 且 `XIAOSHUO_E2E_BYPASS_LICENSE=1` 同时存在时生效。`tests/e2e/start-runtime.mjs` 只在 E2E runtime 启动时注入这两个变量。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
npx playwright test tests/e2e/project-entry.spec.ts --workers=1 --reporter=list
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

验收结果：

- `App.tsx` 已低于 1500 行。
- `useWorkbenchController.ts` 已低于 1200 行。
- 关键 E2E `project-entry.spec.ts` 6/6 通过。
- 完整测试集 59 个文件、384 个用例通过。

遗留说明：

- P5 当前是保守 facade / shell 拆分，后续可逐步把 `useWorkbenchCoreController.ts` 继续按真实状态所有权拆小。
- `App.tsx` 仍保留部分 workflow UI glue；下一步可继续迁移到 feature page 或专用 hooks。
- 下一阶段可进入 P6 Agent 运行检查器 UI，或先继续瘦身 Workbench core controller。

### 16.16 2026-07-07 P6 Agent 运行检查器 UI 已完成

状态：已补齐 trace 查询 API、api-client 方法和 Workbench Agent 运行检查器 UI。

本阶段完成内容：

- `packages/agent-runtime/src/agent-trace.ts` 新增 `getAgentTraceDirPath()`，让 trace writer 和 reader 共用目录解析。
- `packages/shared/src/api.ts` 新增 `agentTraces` / `agentTrace` API contract，响应沿用 `agentRunTraceSchema`。
- `packages/api-client/src/client.ts` 新增 `getAgentTraces(limit)` 与 `getAgentTrace(runId)`。
- 新增 `apps/desktop-shell/src/main/runtime/agent-trace-routes.ts`，实现：
  - `GET /api/agent/traces?limit=50`
  - `GET /api/agent/traces/{run_id}`
- trace route 只读取项目内 `00_设定集/.agent/runs/*.jsonl`，坏 JSONL 行会被忽略，未打开项目返回 400，找不到单条 trace 返回 404。
- 新增 `apps/workbench/src/views/AgentTraceView.tsx`，展示运行时间、输入摘要、intent、selected skill、selected reason、context blocks、model calls、web sources、save decision、saved paths 和 error。
- `apps/workbench/src/layout/RightRail.tsx` 新增“运行”入口，中心区域新增 `traces` feature。
- `apps/workbench/src/styles.css` 新增 trace inspector 两栏布局和响应式样式，长 run id、路径、URL 均可换行。
- 新增 `apps/desktop-shell/src/main/runtime/agent-trace-routes.test.ts`，扩展 `packages/api-client/src/client.test.ts`。

已验证：

```powershell
npm test -- apps/desktop-shell/src/main/runtime/agent-trace-routes.test.ts packages/agent-runtime/src/agent-trace.test.ts packages/api-client/src/client.test.ts
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npx playwright test tests/e2e/project-entry.spec.ts --workers=1 --reporter=list
```

验收结果：

- P6 要求的 trace list/detail API 已可用。
- Workbench 已有 Agent 运行检查器页面。
- UI 只展示 trace 中已经 sanitizied 的摘要、路径、来源和结构化统计，不读取 prompt 全文、附件全文或网页全文。
- 完整测试集当前为 60 个文件、389 个用例通过。
- 关键 E2E `project-entry.spec.ts` 6/6 通过。

遗留说明：

- P6 目前只读项目本地 JSONL；后续可加时间范围、失败运行筛选和 trace 搜索。
- 后续可把运行检查器和具体会话消息互相跳转，但应继续避免展示 prompt / 附件 / 网页全文。
- 下一阶段可进入 P7 Skill 平台化。

### 16.17 2026-07-07 P7 Skill 平台化第一刀已完成

状态：已完成版本化 skill manifest schema、导入兼容层和 Workbench 基础展示/导出，不改变现有 prompt / workflow / job 执行路径。

本阶段完成内容：

- `packages/shared/src/schemas/skill.ts` 新增 `skillManifestSchema`、`skillModelPolicySchema`、`skillSavePolicySchema` 以及对应类型导出。
- `skillDefinitionSchema` 保留旧字段，同时允许 `version`、`input_schema`、`output_schema`、`tools`、`model_policy`、`save_policy`、`eval_cases`、`manifest` 等 manifest 兼容字段。
- `packages/skill-service/src/service.ts` 增加 `withManifest()` 归一化层；内置技能和导入技能在 list / save 时都会带 top-level 字段与 nested `manifest` 镜像。
- 外部 `SKILL.md` / markdown / zip 导入继续兼容旧 frontmatter；无 manifest 的导入默认 `version = "1.0.0"`，`save_policy.requires_confirmation = true`，并继续强制为 prompt skill。
- `SKILL.md` frontmatter 现在可解析 `version`、schema、`tools`、`model_policy`、`save_policy`、`eval_cases` 等简单 manifest 元数据。
- Workbench 技能卡片展示版本号，技能导出的 `SKILL.md` 会写出 version、tools、schema、model/save policy 和 eval cases，便于再次导入时 round-trip。
- 新增 shared schema 测试和 skill-service 导入测试，覆盖 manifest 默认值、旧 `SKILL.md` 兼容和带 manifest 元数据的导入。

已验证：

```powershell
npm run typecheck -w @xiaoshuo/skill-service
npm run typecheck -w @xiaoshuo/workbench
npm test -- packages/shared/src/schemas.test.ts packages/skill-service/src/service.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
npm run build -w @xiaoshuo/workbench
```

验收结果：

- `skillManifestSchema` 已作为跨边界契约进入 `@xiaoshuo/shared`。
- 旧 `SKILL.md` 仍可导入，默认版本和保存确认策略符合 P7 要求。
- 完整测试集当前为 60 个文件、391 个用例通过。

遗留说明：

- 本阶段只做 manifest 存储、导入和展示兼容；`model_policy`、`save_policy`、`tools`、`input_schema`、`output_schema` 尚未被 runtime 执行。
- 外部导入仍保守强制为 prompt skill，尚不允许导入真正的 workflow / job / external handler。
- frontmatter 解析仍是浅解析，复杂嵌套建议继续使用 JSON 单行字段。
- 后续 P7 可继续把内置技能拆成独立 manifest 文件，并逐步让 runtime 消费 `model_policy` 与 `save_policy`。

### 16.18 2026-07-07 P8 取消/中断治理已完成

状态：已完成 request abort -> runtime signal -> model/workflow/card draw 的主链路贯穿，并补齐停止响应的 trace 与会话语义。

本阶段完成内容：

- 新增 `packages/agent-runtime/src/cancellation.ts`，统一 `AgentRunOptions`、取消错误识别与 `throwIfAborted()`。
- `packages/model-client/src/openai-compatible.ts` 为 `requestCompletion()` / `streamCompletion()` 增加外部 `AbortSignal`，组合内部超时与调用方取消；流式读取期间 abort 会 cancel reader，且不会 fallback 到非流式请求。
- `AgentRuntimeService`、`AgentChatRunner`、`PromptSkillRunner`、planner、save planner、smart skill orchestrator、humanizer 和 `streamModelText()` 均支持传入 `options.signal`。
- 流式聊天已输出 partial delta 后被取消时，不再写 normal assistant final message；会话会保存 partial assistant，metadata 标记 `stopped: true`、`cancelled: true`。
- agent trace schema 新增 `cancelled` 字段；取消时 trace 以 `workflow_completed` + `cancelled=true` 收尾。
- `WorkflowRunContext` 增加 `signal`，`body_generate`、`batch_generate`、`consistency_check`、`book_fusion`、`nuwa_style_distill`、拆书、扫伏笔等 workflow 在长 await / 写盘前检查取消，并把 signal 传入内部模型或 prompt skill 调用。
- `batch_generate` 每章前后检查 signal，取消后不再进入下一章。
- 抽卡并发生成支持取消：候选开始、模型返回、候选写盘、manifest 写盘前均检查 signal；预取消不会启动模型或写候选目录。
- 桌面 runtime 新增 `createRequestAbortSignal()`，将 HTTP request abort、request close 和 response 提前 close 转成 `AbortSignal`；agent / conversation / card draw 路由已传入 runtime，断连后不再继续写响应。
- 新增/扩展 cancellation 测试，覆盖 model-client abort、流式 stopped 会话、batch 章间取消、抽卡预取消和桌面 request abort helper。

已验证：

```powershell
npx vitest run packages/model-client/src/openai-compatible.test.ts packages/agent-runtime/src/workflows/batch-generate.test.ts packages/agent-runtime/src/runtime.test.ts apps/desktop-shell/src/main/runtime/runtime-utils.test.ts apps/desktop-shell/src/main/runtime/conversation-routes.test.ts apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

验收结果：

- 用户点击停止后，后端 cancellation 不再触发普通 final 事件，也不会把半截回复当完整 assistant final 写入。
- 已有 partial delta 的流式会话会保存为 stopped/cancelled，而不是 failed。
- 批量生成取消后不会继续生成下一章。
- 抽卡预取消不会启动候选模型调用或写 manifest。
- trace 可记录 `cancelled=true`，完整测试集当前为 60 个文件、402 个用例通过。

遗留说明：

- P8 当前聚焦 HTTP request 级取消；后台 `JobManager` 已有 signal，但部分 job route 若未来新增长 agent job，仍需显式把 job worker 的 signal 传入 runtime。
- GraphMemory / web search 第三方 I/O 当前只能在调用前后检查取消，具体底层中断能力取决于各服务自身 API。
- 后续可在 Workbench Agent 运行检查器里增加 cancelled/stopped 筛选。
