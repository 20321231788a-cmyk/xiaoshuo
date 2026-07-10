# ArcWriter Agent 智能化优化实施手册

> 状态：现行方案
>
> 审阅日期：2026-07-10
>
> 软件基线：ArcWriter 0.4.0
>
> 代码基线：`af6d778` 及其之前的 `v0.4.0` 发布代码
>
> 替代关系：本文完整覆盖并取代 2026-07-07 版本的《Agent 优化修改手册》

## 0. 文档目的

本文用于指导 ArcWriter 从“可控自动化型写作 Agent”升级为“可恢复、可重规划、可验证、可持续学习的本地写作 Agent 平台”。

本文不是概念清单。每个阶段都包含：

- 明确的工程目标和非目标；
- 需要新增或修改的模块；
- 数据契约和执行边界；
- 测试、验收指标和回滚方式；
- 建议的 Git 提交粒度。

后续开发以本文为唯一 Agent 智能化主方案。历史实施记录仍可从 Git 历史和 `docs/PROJECT_MAINTENANCE_HANDOFF.md` 查询，但不再作为新功能设计依据。

## 1. 审阅结论

### 1.1 当前定位

ArcWriter 0.4.0 已经不是简单聊天壳。当前主链路已经具备：

- 纯 TypeScript/Electron 本地 runtime；
- zod 跨边界 schema；
- 规则路由与模型辅助技能路由；
- 最多 4 步的技能串行编排；
- 项目文件引用解析、候选确认和安全读取；
- 会话摘要、固定上下文、附件、向量召回和初步图谱记忆；
- Generated Cache、保存预览、覆盖/追加确认和时间线回滚；
- Agent Trace、取消信号、联网来源和模型主副线路；
- Skill 导入、草稿、编辑、版本、复制和回滚；
- 单元测试、确定性 eval、Electron smoke 和基础 Playwright E2E。

当前系统可以定义为：

```text
可控自动化型 Agent
= 意图识别 + 技能选择 + 上下文拼装 + 单次/串行执行 + 安全保存
```

它还不是完整自主 Agent，缺少以下闭环：

```text
持久目标
  -> 可检查计划
  -> 分步执行
  -> 结构化观察
  -> 质量验证
  -> 失败重试或重新规划
  -> 持久记忆更新
  -> 可恢复完成
```

### 1.2 当前验证基线

2026-07-10 审阅期间执行：

```powershell
npm run typecheck
npm test
```

结果：

- 全 workspace 类型检查通过；
- 68 个测试文件通过；
- 457 个测试用例通过；
- Git 工作树除用户已有未跟踪文件外无代码变更。

这说明下一阶段可以直接做架构升级，不需要先进行稳定性救火。

### 1.3 智能化成熟度

| 维度 | 当前水平 | 主要依据 |
| --- | ---: | --- |
| 意图与技能路由 | 3.5/5 | 规则与模型混合路由，已有 routing eval |
| 上下文工程 | 3/5 | 有统一优先级预算，但仍按字符裁剪 |
| 任务规划 | 2.5/5 | 能生成技能序列，缺少观察和重规划 |
| 执行可靠性 | 2/5 | 任务和步骤没有持久检查点 |
| 长期记忆 | 2.5/5 | 有向量和图谱，缺少记忆治理与失效机制 |
| 质量控制 | 2.5/5 | 部分 workflow 有检查，尚未平台化 |
| 安全与确认 | 4/5 | 路径校验、缓存、确认、回滚较成熟 |
| 可观测性 | 3.5/5 | Trace 已可用，缺成本、尝试和状态演进 |
| 用户交互 | 3/5 | 引用和保存可确认，执行计划不够透明 |

## 2. 关键问题与优先级

### 2.1 P0：执行状态不持久

`AgentRuntimeService.runSkillPlan()` 当前在内存中串行执行步骤。任一步失败后直接返回错误结果，没有检查点、恢复位置和幂等控制。

`JobManager` 同样使用内存 `Map` 保存任务。软件退出、runtime 重启或系统崩溃后，任务状态和中间结果会丢失。

直接影响：

- 长拆书、批量正文和多技能任务无法可靠续跑；
- 用户无法只重试失败步骤；
- 重试可能重复写入已经完成的产物；
- Trace 能看到发生了什么，但不能恢复执行。

### 2.2 P0：模型网关缺少生产级治理

当前模型客户端主要处理流式调用和“不支持流式时退回非流式”。尚未统一支持：

- 429/502/503 指数退避；
- JSON Schema 结构化输出；
- 无效 JSON 修复；
- 模型能力声明；
- token、费用、首字延迟和重试统计；
- 请求幂等键；
- 基于任务类型的主副模型选择。

Planner、保存规划器和技能调度器仍需自行从字符串提取 JSON，导致每个模块重复处理模型不稳定性。

### 2.3 P0：规划不是闭环

当前 SmartSkillOrchestrator 只输出最多 4 个技能步骤。步骤没有显式的：

- 前置条件；
- 输入来源；
- 预期产物；
- 验证方法；
- 重试策略；
- 失败后的替代步骤；
- 停止条件。

执行完成后不会根据真实输出重新判断下一步，因此属于静态技能流水线，不是 Plan-Act-Observe-Replan Agent。

### 2.4 P1：上下文按字符硬裁剪

ContextAssembler 已有 critical/high/medium/low 优先级，但预算单位仍是字符，最终使用字符串 `slice()`。

风险：

- 截断 JSON、人物设定或章节段落；
- 不同模型上下文窗口无法准确映射；
- 低价值长块可能挤压高相关短块；
- 没有同时考虑相关度、时效、可信度和多样性。

### 2.5 P1：记忆有存储，缺少治理

当前会话摘要是最近 12 条消息的确定性摘录，不会区分：

- 已确认事实；
- 用户偏好；
- 已拒绝方案；
- 未完成任务；
- 人物和剧情状态变更；
- 决策来源及更新时间。

GraphMemory 已能提供正文冲突建议，但存在两套一致性接口：workflow 使用的 `checkDraftConsistency()` 有实际检测，桌面 Graph API 使用的 `GraphContext.checkConsistency()` 仍是固定高分占位实现。

`GraphMemory.updatePaths()` 也仍执行全量重建，没有真正增量更新。

### 2.6 P1：质量检查没有平台化

正文生成和一致性 workflow 已有部分自检，但普通聊天生成、技能输出、大纲、拆书和其他产物没有统一质量门。

系统缺少统一的：

- Artifact 类型；
- Evaluator Registry；
- Rubric；
- 失败等级；
- 修订次数上限；
- 质量证据和阻断条件。

### 2.7 P2：智能过程没有进入主交互

Agent Trace 页面适合开发者排障，但普通会话中主要显示最终文本、联网来源和保存确认。

用户无法在当前消息中直观看到：

- Agent 计划执行哪些步骤；
- 当前执行到哪一步；
- 为什么选择某个技能；
- 哪些文件被读取；
- 哪一步失败；
- 如何从失败步骤重试；
- 技能管理预览如何一键确认。

### 2.8 P2：评估覆盖偏确定性功能

当前 eval 对规则路由、保存策略和上下文预算有良好覆盖，但尚未系统评估：

- 多步骤计划质量；
- 重规划正确率；
- 长对话事实召回；
- 图谱冲突召回和误报；
- 中断/重启恢复；
- 严格格式产物；
- 实际模型成本和延迟。

## 3. 优化总原则

后续实现必须遵守以下原则：

1. **先可靠，后自主。** 单 Agent 没有持久状态、验证和恢复前，不引入多 Agent 协作。
2. **模型只做不确定判断。** 路径安全、状态机、重试、预算、写入和回滚必须由确定性代码控制。
3. **所有副作用可追踪。** 文件写入、技能修改、联网和模型调用必须归属具体 run/step。
4. **默认不重复副作用。** 重试和恢复必须使用幂等键或产物摘要避免重复写入。
5. **用户保留最终权限。** 删除、覆盖、批量写入、技能变更和高成本任务继续要求明确确认。
6. **每个决策有证据。** 路由、引用、质量判断和保存目标需要记录理由与来源。
7. **记忆必须可失效。** 文件变更后旧事实不能无限期继续参与召回。
8. **预算必须显式。** 每个 run 有步骤、时间、token、费用和重规划上限。
9. **保持旧 API 兼容。** 新执行内核通过 feature flag 渐进启用，旧会话和技能继续可用。
10. **每阶段可独立回滚。** 不进行无法隔离的大爆炸式重构。

## 4. 目标架构

```text
User Request
  -> Intent Gateway
  -> Goal Builder
  -> Planner
  -> Durable Run Store
  -> Agent Loop
       -> Action Registry
       -> Observation
       -> Verifier
       -> Replan or Finish
  -> Quality Gate
  -> Save Policy / Confirmation
  -> Memory Commit
  -> Trace + Metrics
```

建议目标目录：

```text
packages/agent-runtime/src/
  kernel/
    agent-engine.ts
    run-context.ts
    execution-store.ts
    execution-state-machine.ts
    context-assembler.ts
    context-selector.ts
    budget-manager.ts
    observation.ts
  planning/
    goal-builder.ts
    planner.ts
    replanner.ts
    plan-validator.ts
  execution/
    action-registry.ts
    action-executor.ts
    retry-policy.ts
    idempotency.ts
  evaluators/
    registry.ts
    format-evaluator.ts
    graph-evaluator.ts
    model-critic.ts
    artifact-rubrics.ts
  memory/
    working-memory.ts
    episodic-memory.ts
    semantic-memory.ts
    memory-commit.ts
  routing/
    intent-router.ts
    skill-orchestrator.ts
  workflows/
    ...现有 workflow handlers

packages/model-client/src/
  model-gateway.ts
  provider-capabilities.ts
  structured-output.ts
  retry-policy.ts
  usage.ts
```

目录只在对应阶段逐步建立，不一次性搬迁全部代码。

## 5. 核心数据契约

### 5.1 Agent Run

在 `packages/shared/src/schemas/agent.ts` 新增兼容 schema：

```ts
type AgentRunState = {
  run_id: string;
  request_id: string;
  conversation_id: string;
  project_path: string;
  goal: AgentGoal;
  plan_version: number;
  status:
    | "queued"
    | "planning"
    | "running"
    | "waiting_confirmation"
    | "paused"
    | "failed"
    | "cancelled"
    | "completed";
  current_step_id: string;
  steps: AgentExecutionStep[];
  artifacts: AgentArtifactRef[];
  budget: AgentRunBudget;
  created_at: string;
  updated_at: string;
};
```

### 5.2 执行步骤

```ts
type AgentExecutionStep = {
  step_id: string;
  index: number;
  type: "read" | "skill" | "workflow" | "web_search" | "verify" | "save_preview";
  skill_id: string;
  instruction: string;
  input_refs: string[];
  expected_output: AgentExpectedOutput;
  status: "pending" | "running" | "waiting_confirmation" | "done" | "failed" | "skipped";
  attempts: number;
  max_attempts: number;
  retryable: boolean;
  requires_confirmation: boolean;
  observation_id: string;
  error: string;
  started_at: string;
  ended_at: string;
};
```

### 5.3 Observation

```ts
type AgentObservation = {
  observation_id: string;
  run_id: string;
  step_id: string;
  ok: boolean;
  summary: string;
  output_refs: string[];
  saved_paths: string[];
  warnings: string[];
  verification: AgentVerificationResult;
  created_at: string;
};
```

### 5.4 预算

```ts
type AgentRunBudget = {
  max_steps: number;
  max_replans: number;
  max_attempts_per_step: number;
  max_duration_ms: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_cost: number;
  used_steps: number;
  used_replans: number;
  used_input_tokens: number;
  used_output_tokens: number;
  estimated_cost: number;
};
```

默认建议：

- 普通聊天：最多 3 步、1 次重规划；
- 普通工作流：最多 6 步、2 次重规划；
- 长拆书/批量生成：由 job 分段，每个分段独立检查点；
- 单步骤最多重试 2 次；
- 超预算后进入 `paused`，不静默继续消耗。

## 6. 阶段 P0：持久执行状态

### 6.1 目标

让 Agent 任务在错误、取消和应用重启后仍可查询、恢复和安全重试。

### 6.2 新增模块

- `packages/agent-runtime/src/kernel/execution-store.ts`
- `packages/agent-runtime/src/kernel/execution-state-machine.ts`
- `packages/agent-runtime/src/kernel/idempotency.ts`
- shared run/step/observation schema
- desktop run 查询、暂停、恢复和步骤重试 API

### 6.3 存储方案

复用桌面端现有 SQLite 能力，新增：

```text
agent_runs
agent_steps
agent_observations
agent_artifacts
agent_confirmations
```

关键字段必须包含 `run_id`、`step_id`、状态、尝试次数、输入摘要、输出引用、错误、时间和幂等键。

模型长文本和附件全文不直接写数据库；只保存 Generated Cache ID、项目路径或受控 artifact 引用。

### 6.4 状态机规则

- 只有 `pending -> running` 可以启动步骤；
- `running -> done/failed/waiting_confirmation/cancelled`；
- 恢复时只允许 `failed/paused -> running`；
- 已完成步骤默认不可重复执行；
- 需要重新执行时生成新 attempt，并保留旧 observation；
- 应用启动时把遗留 `running` 标记为 `paused`，等待用户恢复；
- 不自动重放任何文件写入。

### 6.5 API

```text
POST /api/agent/runs
GET  /api/agent/runs
GET  /api/agent/runs/{run_id}
POST /api/agent/runs/{run_id}/pause
POST /api/agent/runs/{run_id}/resume
POST /api/agent/runs/{run_id}/cancel
POST /api/agent/runs/{run_id}/steps/{step_id}/retry
```

### 6.6 验收

- 关闭并重启软件后仍能看到未完成任务；
- 可从失败步骤恢复，不重复执行已完成步骤；
- 同一个幂等键只能产生一次文件副作用；
- 取消和暂停不会被记录为普通失败；
- 旧 `/api/agent/run` 和会话 API 继续工作。

### 6.7 测试

- SQLite store CRUD 和迁移测试；
- 状态机非法迁移测试；
- 重启恢复测试；
- 已完成写入不重复测试；
- 失败步骤重试测试；
- cancellation 回归测试。

### 6.8 建议提交

```text
feat(agent): persist resumable run state
feat(runtime): add agent run lifecycle routes
feat(workbench): surface resumable agent runs
docs(agent): record P0 durable execution rollout
```

## 7. 阶段 P1：Model Gateway

### 7.1 目标

把供应商差异、重试、结构化输出、usage 和 fallback 从业务模块中移出。

### 7.2 能力接口

```ts
type ModelCapability =
  | "text"
  | "stream"
  | "structured_output"
  | "reasoning"
  | "embedding";

type ModelRequest = {
  purpose: "chat" | "planning" | "routing" | "verification" | "writing";
  messages: ChatCompletionMessage[];
  response_schema?: unknown;
  temperature?: number;
  max_output_tokens?: number;
  idempotency_key?: string;
};
```

### 7.3 重试策略

- 408/429/502/503：指数退避加随机抖动；
- 默认最多 3 次；
- 400/401/403 不自动重试；
- 流式参数不兼容可退回非流式；
- 超时只允许在没有产生副作用的模型调用中重试；
- 用户主动取消立即终止，不 fallback。

### 7.4 结构化输出

优先使用提供商支持的 JSON Schema；不支持时：

1. 使用严格 JSON prompt；
2. zod parse；
3. 失败后执行一次低温 JSON repair；
4. 仍失败则返回 typed error，不使用正则猜测业务字段。

Planner、技能路由、保存规划、质量评估和图谱抽取统一迁移到 `completeStructured()`。

### 7.5 Usage 和 Trace

每次调用记录：

- provider、model 和 purpose；
- input/output token；
- 首字延迟和总耗时；
- retry 次数；
- fallback 来源；
- estimated cost；
- structured parse 是否成功。

禁止记录 API key 和完整敏感 prompt。

### 7.6 验收

- 429/502/503 模拟故障可自动恢复；
- Planner 不再手写 JSON 正则截取；
- 主模型失败时按任务策略切换副模型；
- Trace 能展示 token、重试、费用和 fallback；
- 用户取消不触发后续重试。

### 7.7 建议提交

```text
feat(model): add resilient structured model gateway
refactor(agent): migrate planners to structured output
feat(trace): record model usage and retry metadata
docs(agent): record P1 model gateway rollout
```

## 8. 阶段 P2：Plan-Act-Observe-Replan

### 8.1 目标

将当前静态技能序列升级为受预算约束的 Agent 执行循环。

### 8.2 允许的 Action

第一版只开放受控 Action Registry：

- `read_project_files`
- `resolve_project_references`
- `run_skill`
- `run_workflow`
- `search_project_memory`
- `search_web_material`
- `check_graph_consistency`
- `evaluate_artifact`
- `propose_save`

不向模型开放任意 shell、任意文件系统或任意 HTTP 请求。

### 8.3 执行循环

```text
Goal Builder
  -> Plan Validator
  -> Persist Plan
  -> Execute Step
  -> Persist Observation
  -> Verify Expected Output
     -> pass: next step
     -> retryable: retry
     -> recoverable: replan remaining steps
     -> needs user: wait confirmation
     -> fatal: fail run
  -> Final Quality Gate
  -> Save Preview
  -> Memory Commit
```

### 8.4 重规划条件

仅在以下情况重规划：

- 引用文件不存在或版本变化；
- 选中技能不可用；
- 输出类型不符合预期；
- 上一步产生的新事实改变后续条件；
- 可恢复网络或模型错误超过步骤重试次数；
- 用户修改目标。

重规划只修改尚未完成的步骤，不能改写已完成事实和已经确认的用户目标。

### 8.5 计划验证

Plan Validator 必须拒绝：

- 超过预算的计划；
- 未注册 action；
- 不存在或禁用的 skill；
- 没有确认策略的覆盖/删除操作；
- 循环依赖；
- 没有预期产物的写入步骤；
- 同一路径互相冲突的并行写入。

### 8.6 验收

- 两步任务第二步失败后可重试第二步；
- 输入缺失时可补充读取并重新规划；
- 达到重规划或费用上限时明确暂停；
- 计划和每步观察均可在 Trace 中回放；
- 不允许模型绕过 DocumentService 和 Generated Cache 写文件。

### 8.7 建议提交

```text
feat(agent): add plan act observe replan loop
feat(agent): add typed action registry and plan validator
feat(workbench): show live agent plan progress
docs(agent): record P2 execution loop rollout
```

## 9. 阶段 P3：分层记忆与增量图谱

### 9.1 目标

让 Agent 记住“事实和决策”，而不是只截取最近聊天文本。

### 9.2 三层记忆

#### 工作记忆

- 当前用户目标；
- 当前计划和步骤；
- 当前文档、选区和附件；
- 最近相关消息；
- 当前质量问题。

生命周期只覆盖当前 run。

#### 情节记忆

- 已完成任务摘要；
- 用户采纳或拒绝的方案；
- 失败原因和恢复方式；
- 重要写作决策；
- 未完成待办。

按会话和项目持久化，支持来源追踪。

#### 语义记忆

- 人物、地点、组织、能力和关系；
- 已确认剧情事实；
- 大纲计划与正文事实的状态区别；
- 风格、题材和禁用规则；
- 用户长期写作偏好。

由文件和已确认操作派生，必须保存 source path、版本摘要和更新时间。

### 9.3 结构化会话摘要

替换“最近 12 条拼接”为：

```ts
type ConversationMemory = {
  confirmed_facts: MemoryFact[];
  decisions: MemoryDecision[];
  rejected_options: MemoryDecision[];
  user_preferences: MemoryFact[];
  open_tasks: MemoryTask[];
  current_goal: string;
  source_message_ids: string[];
  updated_at: string;
};
```

摘要采用增量更新，不每 6 条消息重做全部历史。

### 9.4 图谱统一

- 删除 `GraphContext.checkConsistency()` 的固定高分占位语义；
- 路由层和 workflow 统一调用 `GraphMemory.checkDraftConsistency()`；
- 返回 `blocking_claims`、source_path、reason 和 suggested_fix；
- `updatePaths(paths)` 只删除并重建相关路径的 entities/claims/relations；
- 文件内容 hash 变化时旧 claim 标记为 `superseded`，不直接静默覆盖；
- planned、confirmed、deprecated、superseded 状态严格区分。

### 9.5 记忆提交边界

只有以下内容进入长期记忆：

- 用户明确确认的事实；
- 已保存到项目的产物；
- 已完成并通过质量门的 workflow 输出；
- 用户明确表达的稳定偏好。

模型草稿、失败输出和未确认推测不得直接进入 confirmed memory。

### 9.6 验收

- 100 轮会话后仍能召回关键决策；
- 修改人物设定文件后旧 claim 不再作为当前事实；
- 增量更新只处理变更路径；
- 图谱 API 和一致性 workflow 对同一文本给出一致结果；
- 每条事实可回溯到消息或文件来源。

### 9.7 建议提交

```text
feat(memory): add structured episodic memory
feat(graph): unify consistency checks and incremental updates
feat(context): consume governed project memories
docs(agent): record P3 memory rollout
```

## 10. 阶段 P4：Token 级上下文调度

### 10.1 目标

在固定模型预算内优先提供最相关、可信、完整且多样的上下文。

### 10.2 预算结构

```text
model_context_window
  - reserved_output_tokens
  - system_tokens
  - tool_schema_tokens
  - safety_margin
  = available_context_tokens
```

预算由 Model Gateway 提供，不再由业务模块写死字符常量。

### 10.3 Context Block 扩展

```ts
type ContextBlock = {
  id: string;
  source: string;
  content: string;
  priority: "critical" | "high" | "medium" | "low";
  estimated_tokens: number;
  relevance: number;
  freshness: number;
  trust: number;
  novelty: number;
  semantic_boundary: "document" | "section" | "paragraph" | "json";
  source_ref: string;
};
```

### 10.4 选择策略

建议初始评分：

```text
score =
  relevance * 0.35
  + priority * 0.25
  + trust * 0.15
  + freshness * 0.15
  + novelty * 0.10
```

critical block 保留，但仍需设置合理上限；同一路径最多选择两个高度相似片段。使用 MMR 或等价方式抑制重复召回。

### 10.5 语义裁剪

- JSON 按完整对象或字段裁剪；
- Markdown 按标题 section；
- 正文按段落或场景；
- 设定按独立条目；
- 章纲按章节块；
- 任何裁剪都附加明确 truncated metadata。

### 10.6 验收

- 不再从 UTF-16 字符中间或 JSON 对象中间截断；
- 不同模型使用不同 token 预算；
- Trace 展示 estimated/used token；
- 相同查询下重复片段比例显著下降；
- context eval 增加真实大纲、正文、设定和 JSON fixture。

### 10.7 建议提交

```text
feat(context): add token aware semantic context selection
feat(trace): explain context inclusion and exclusion
test(agent): expand context retrieval evals
docs(agent): record P4 context rollout
```

## 11. 阶段 P5：统一质量门

### 11.1 目标

把“生成后是否可用”从各 workflow 的零散判断升级为统一 Evaluator Pipeline。

### 11.2 Artifact 类型

```text
chat_answer
outline
detail_outline
chapter_outline
body_chapter
disassembly_report
skill_draft
skill_patch
lore_update
style_profile
genre_profile
```

### 11.3 Evaluator Registry

- `format_evaluator`：格式、章节覆盖、字段完整性；
- `length_evaluator`：目标字数和分段；
- `graph_evaluator`：人物/设定/事件冲突；
- `outline_alignment_evaluator`：章纲执行情况；
- `style_evaluator`：风格规则和禁用词；
- `safety_evaluator`：路径、指令和副作用风险；
- `model_critic`：需要语义判断的质量项。

### 11.4 质量报告

```ts
type QualityReport = {
  artifact_type: string;
  score: number;
  passed: boolean;
  issues: Array<{
    code: string;
    severity: "blocking" | "major" | "minor" | "advice";
    message: string;
    evidence: string;
    source_ref: string;
    suggested_fix: string;
  }>;
  evaluator_versions: Record<string, string>;
};
```

### 11.5 修订循环

```text
Draft
  -> deterministic evaluators
  -> graph evaluator
  -> model critic when necessary
  -> blocking/major issues?
       yes -> revise once -> evaluate again
       still failing -> present report and stop
       no -> save preview
```

默认最多修订 2 次，禁止无限自我反思。

### 11.6 产物要求

#### 正文

- 章纲符合度；
- 人物和设定一致性；
- 风格约束；
- 重复句和禁用词；
- 目标字数；
- 章节标题和文件路径。

#### 拆书

- 严格文件格式；
- 章节覆盖范围；
- 目标总字数；
- 每个结构段完整；
- 不得只输出概括性短报告。

#### Skill

- 输入输出 schema；
- 格式约束；
- 保存策略；
- 危险工具声明；
- 至少一个 eval case；
- prompt 中不允许隐式绕过用户确认。

### 11.7 验收

- 所有生成产物返回结构化质量报告；
- blocking issue 不进入自动保存；
- 用户可看到问题证据，而不是只看到分数；
- 修订次数和新增模型成本进入 Trace；
- 格式型任务在 eval 中通过率达到 98%。

### 11.8 建议提交

```text
feat(agent): add artifact evaluator registry
feat(workflow): gate generated artifacts by quality report
feat(workbench): display quality evidence and revision status
docs(agent): record P5 quality gate rollout
```

## 12. 阶段 P6：Agent 交互升级

### 12.1 目标

让用户在会话主流程里理解、控制和恢复 Agent，而不是跳到开发者 Trace 页面。

### 12.2 会话计划卡

消息内展示：

- 总目标；
- 计划步骤；
- 当前步骤和进度；
- 每步技能、理由和预期产物；
- 已读取文件；
- 保存目标；
- 预算使用；
- 失败、重试和重新规划状态。

默认折叠详细技术信息，避免挤占写作空间。

### 12.3 用户操作

- 停止；
- 暂停；
- 恢复；
- 从失败步骤重试；
- 跳过可选步骤；
- 重新规划剩余步骤；
- 修改保存目标；
- 确认危险操作。

### 12.4 Skill 管理闭环

聊天返回 `skill_management` payload 后，直接显示：

- 草稿预览和导入；
- patch diff 和保存；
- builtin clone 建议和确认；
- 版本列表和回滚确认；
- 禁用/恢复确认。

技能页继续作为完整管理页面，聊天负责自然语言入口和最后确认。

### 12.5 Trace 分层

普通用户视图：

- 做了什么；
- 为什么；
- 使用了哪些资料；
- 写到了哪里；
- 如何恢复。

开发者 Trace：

- 原有 route/context/model/save 信息；
- run/step/attempt；
- token 和费用；
- retry/fallback；
- observation 和 quality report；
- replanning history。

### 12.6 验收

- 用户无需进入技能页即可确认一次自然语言 Skill 创建；
- 多步骤任务有实时进度；
- 失败消息提供可执行的重试按钮；
- 恢复任务后 UI 继续关联原会话；
- 小屏和桌面布局不出现按钮或文本重叠。

### 12.7 建议提交

```text
feat(workbench): add inline agent plan controls
feat(workbench): confirm skill management from chat
feat(workbench): add retry resume and replan actions
docs(agent): record P6 agent interaction rollout
```

## 13. 阶段 P7：Eval 与发布门禁

### 13.1 数据集

最低规模：

| Eval | 最低用例数 | 目标 |
| --- | ---: | ---: |
| 意图路由 | 150 | 准确率 >= 95% |
| 技能选择 | 120 | 准确率 >= 93% |
| 文件引用 | 100 | 准确率 >= 95% |
| 多步规划 | 80 | 可执行率 >= 92% |
| 重规划 | 50 | 恢复成功率 >= 90% |
| 长期记忆 | 60 | 关键事实召回 >= 90% |
| 图谱冲突 | 60 | 召回 >= 90%，误报 <= 8% |
| 保存安全 | 60 | 未确认危险写入 = 0 |
| 严格格式 | 50 | 通过率 >= 98% |
| 重启恢复 | 30 | 恢复成功率 = 100% |

### 13.2 Eval 类型

- 纯函数 deterministic eval；
- mock model contract eval；
- 录制响应 replay eval；
- 可选在线模型 benchmark；
- API integration；
- Playwright E2E；
- Electron smoke。

在线 benchmark 不作为普通单测硬依赖，但发布候选必须保存结果摘要。

### 13.3 E2E 必补流程

- 文件引用候选确认；
- 自然语言 Skill 草稿导入；
- Skill patch diff 确认；
- 两步 Agent 计划进度；
- 第二步失败后重试；
- 应用重启后恢复；
- 质量门修订；
- 用户取消后不继续写入；
- 保存覆盖确认；
- Trace 与会话互相定位。

### 13.4 CI 门禁

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
```

新增建议：

```powershell
npm run eval:routing
npm run eval:planning
npm run eval:memory
npm run eval:quality
```

任何安全门禁退化、格式通过率下降或恢复测试失败都阻止发布。

## 14. 版本实施顺序

### 14.1 0.5.0：可靠 Agent 内核

范围：P0、P1、P2。

交付结果：

- 持久任务状态；
- 失败步骤重试和重启恢复；
- Model Gateway；
- 结构化输出；
- Plan-Act-Observe-Replan；
- 基础计划进度 UI。

单人参考工作量：12-18 个有效开发日。

### 14.2 0.6.0：记忆与上下文

范围：P3、P4。

交付结果：

- 结构化会话记忆；
- 增量向量和图谱更新；
- 一致性接口统一；
- token 预算；
- 语义块选择和去重。

单人参考工作量：8-12 个有效开发日。

### 14.3 0.7.0：质量和产品闭环

范围：P5、P6、P7。

交付结果：

- 统一质量门；
- 会话内完整 Agent 控制；
- Skill 管理自然语言闭环；
- Agent eval 和发布门禁。

单人参考工作量：10-15 个有效开发日。

工作量仅用于拆阶段，不代表日历承诺。每个阶段应根据测试和回归结果独立验收。

## 15. 第一批实施任务

下一轮建议只启动 P0 第一批，不同时修改记忆和质量系统。

### 15.1 Task A：Run Schema

修改：

- `packages/shared/src/schemas/agent.ts`
- `packages/shared/src/schemas/job.ts`
- shared schema tests

交付：

- AgentRunState、AgentExecutionStep、AgentObservation；
- 默认预算；
- 旧 AgentRunResponse 兼容。

### 15.2 Task B：Execution Store

新增：

- `packages/agent-runtime/src/kernel/execution-store.ts`
- `packages/agent-runtime/src/kernel/execution-store.test.ts`

交付：

- SQLite 持久化；
- run/step/observation CRUD；
- 应用启动恢复扫描；
- schema migration。

### 15.3 Task C：状态机和幂等

新增：

- `execution-state-machine.ts`
- `idempotency.ts`

交付：

- 合法状态迁移；
- attempt 记录；
- 文件写入幂等键；
- 非法重复执行拒绝。

### 15.4 Task D：只读查询 API

第一刀只接入：

- run list；
- run detail；
- Trace 关联。

确认数据结构稳定后再接 resume/retry，避免 UI 和状态机同时大改。

## 16. 风险与回滚

### 16.1 Feature Flags

新增配置：

```text
agent_execution_v2
model_gateway_v2
memory_v2
quality_gate_v2
agent_inline_plan_ui
```

新功能默认可按版本逐步开启。旧路径至少保留一个小版本周期。

### 16.2 高风险区域

- 批量正文和拆书的长任务恢复；
- 自动保存和重复写入；
- SQLite schema migration；
- 旧会话 metadata 兼容；
- 模型供应商结构化输出差异；
- 图谱旧 claim 的失效处理。

### 16.3 回滚策略

- P0：关闭 `agent_execution_v2`，回到旧即时执行；保留新表不删除；
- P1：关闭 `model_gateway_v2`，保留旧 OpenAICompatibleClient；
- P3：关闭 `memory_v2`，继续使用旧 summary/vector context；
- P5：关闭 `quality_gate_v2`，workflow 回到旧检查逻辑；
- UI：关闭 `agent_inline_plan_ui`，继续使用 Trace 页面。

禁止通过删除用户项目 `.agent` 数据完成回滚。

## 17. Git、文档与验收规则

每个大阶段完成时必须：

1. 更新本文对应阶段的实施记录；
2. 更新 `docs/PROJECT_MAINTENANCE_HANDOFF.md`；
3. 运行阶段要求的测试；
4. 单独提交 Git；
5. 在提交记录中写明迁移和回滚方式。

提交不得混入无关 UI、格式化或用户已有文件。

建议阶段提交：

```text
feat(agent): complete P0 durable execution
feat(model): complete P1 model gateway
feat(agent): complete P2 replanning loop
feat(memory): complete P3 governed memory
feat(context): complete P4 token context selection
feat(agent): complete P5 quality gate
feat(workbench): complete P6 agent interaction
test(agent): complete P7 release eval gates
```

## 18. 完成定义

本方案全部完成时，ArcWriter 必须满足：

- 复杂任务能生成可读、可检查的计划；
- 每个步骤有输入、产物、观察和验证；
- 失败后能重试或重规划，不必整条重做；
- 软件重启后能恢复任务；
- 所有副作用可追踪且默认幂等；
- 长对话记忆事实和决策，而不是只保留最近文本；
- 文件变化会使旧记忆失效；
- 上下文按模型 token 和语义边界选择；
- 生成产物通过统一质量门后才进入保存流程；
- 用户能在会话中查看和控制 Agent；
- 发布由量化 eval 门禁约束；
- 未确认危险写入保持为 0。

## 19. 暂不实施事项

以下能力不进入 0.5.0：

- 多 Agent 并行协作；
- Agent 自行安装任意工具；
- 任意 shell 执行；
- 自动修改和发布自身代码；
- 无预算的后台自治任务；
- 未经确认的跨项目写入；
- 把模型草稿直接写入 confirmed memory。

原因：这些能力会放大当前在状态恢复、成本控制和质量验证上的缺口。先完成单 Agent 可靠闭环，再评估多 Agent 的真实收益。

## 20. 下一步

从 P0 Task A 开始：先补 Agent Run/Step/Observation schema 和测试，再实现 SQLite Execution Store。此顺序对现有用户行为影响最小，同时为后续恢复、重规划、质量门和 UI 提供统一数据基础。
