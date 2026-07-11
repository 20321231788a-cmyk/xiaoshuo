# ArcWriter Agent 优化审阅后续实施手册

> 制定日期：2026-07-11
>
> 状态：执行中；M0、M1 的实现工作已完成；M2 的主执行门与 M3 的会话计划卡契约均已接入。M3 的真实流、pause/resume/cancel/retry、409 conflict 与 reload E2E 已通过；Desktop IPC 安装态验证仍缺失。M4 已建立 Agent Action 的 deny-by-default 原型门禁；终端用户手势票据的首次接入未通过 source smoke，预算、跨项目和 memory 数据面也尚未完成。M5～M7 尚未开始，不能据此宣称可发布。
>
> 适用范围：ArcWriter 0.5.0～0.9.0
>
> 上位文档：`docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md`
>
> 原则：先恢复可信发布门禁，再完成单 Agent 的生产集成；第 19 节列出的能力在本路线内保持硬禁用。

## 0. 文档目的

本手册把 2026-07-11 代码审阅发现转换为可执行任务。它不重新设计 ArcWriter，也不扩大 Agent 权限，只处理以下七件事：

1. 校准 P0～P7 的真实完成状态；
2. 修复 Desktop smoke 认证回归，恢复发布门禁；
3. 让 Feature Flag 真正控制执行路径和回滚；
4. 修复 P6 会话计划卡的 run/version/step/API 契约；
5. 把第 19 节升级为 Negative Capability Gate；
6. 分阶段接入 P3、P4、P5 的生产链路；
7. 建立达到手册规模的 P7 Eval、Manifest、CI artifact 和 RC 证据。

本文中的“完成”只表示：生产调用路径已接入、关闭和回滚路径有效、要求的测试与证据全部产生。只有类、schema、数据库表、单测或导出存在，不构成阶段完成。

### 0.1 审阅建议到实施顺序

| 审阅建议 | 执行阶段 | 不可跳过的放行条件 |
| --- | --- | --- |
| 撤回“P0～P7 100% 完成、可投产” | M0 | 三份状态文档与实际验证结果一致 |
| 修复 Desktop smoke 的认证调用 | M1 | 受保护请求仅经 preload/IPC；裸 loopback 仍为 401 |
| Feature Flag 真实控制执行与回滚 | M2 | `off/on` 有真实执行差异，`shadow` 未实现比较器时 fail closed |
| 修复 P6 run/version/step/API Client 契约 | M3 | E2E 覆盖 pause/resume/cancel/retry、冲突刷新和 reload |
| 落地第 19 节硬禁用能力 | M4 | 七项直接调用与绕过测试均为零成功 |
| 逐项接入 P3、P4、P5 | M5 | 每项具备生产消费者、回滚和独立验收 |
| 建立 P7 数据集、Manifest、CI artifact 后评估 RC | M6～M7 | 证据可从 release 追溯到同一 commit |

### 0.2 当前执行队列（2026-07-11）

此队列是实施顺序，不是发布承诺。未通过的步骤不得用后续步骤或更多测试数量抵消。

| 优先级 | 工作项 | 当前结论 | 退出条件 |
| --- | --- | --- | --- |
| P0 | M4-T1：终端用户手势票据绑定 | 未通过；无专用启动动作时，既有页面交互可留下可消费票据 | 未点击终端启动控件的 create 被拒绝；点击或键盘激活后只允许一次创建；source smoke 通过 |
| P1 | M4-T2：预算、跨项目、memory 数据面 | 未开始 | 七项禁止能力在真实生产入口与绕过测试中均为零成功 |
| P1 | M3-T1：安装态 Desktop IPC 控制矩阵 | 未开始 | installed Electron 验证计划卡全部控制请求只经 preload/IPC |
| P2 | M2 子 Flag 逐项接线 | 未开始 | 每个子 Flag 具备真实 off/on 分支、回滚和独立证据 |
| P3 | M5：P3、P4、P5 生产集成 | 未开始 | 每项具备生产消费者、持久化/回滚与专属验收 |
| P4 | M6～M7：Eval 与 RC | 未开始 | 数据集、Manifest、CI artifact、安装态与人工校准证据齐全 |

## 1. 审阅基线

### 1.1 初审基线与实时执行状态

| 验证项 | 初审结果 | 当前状态与判断 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | M4 当前改动后的根级静态类型检查曾通过；合并前仍须重跑 |
| `npm test` | 93 files / 741 tests 通过 | M4 当前改动后的根级回归基线；合并前仍须重跑 |
| 六个 `eval:*` 命令 | 共 33 个用例通过 | 命令存在，但未达到 P7 数据集和证据要求 |
| `npm run build:desktop` | 通过 | M1 的 `npm run smoke:desktop` 会重新构建 Desktop，已通过 |
| `npm run test:e2e` | 6/6 通过 | 覆盖 Trace 基础链路，以及会话计划卡的真实流、pause/resume/cancel/retry、409 conflict 和 reload；安装态 Desktop IPC 尚未验证 |
| `npm run eval:excluded-capabilities` | 4 files / 30 tests 通过 | 策略和 preload 票据的单元级负向覆盖存在，但不替代 source smoke |
| `npm run smoke:desktop` | 失败：M4 终端无手势 create 负向断言意外成功 | M1 的认证 IPC 修复仍有效；最新失败说明手势票据没有绑定到专用终端启动动作，发布门禁保持关闭 |
| `git diff --check origin/main...HEAD` | 失败 | 历史提交格式问题仍与本轮变更分开处置；本轮修改必须单独通过 `git diff --check` |

### 1.2 阶段状态校准

| 阶段 | 当前状态 | 允许结论 |
| --- | --- | --- |
| P0 持久执行 | 已有主体实现，待发布验收 | 不得在 Desktop smoke 和回滚门禁通过前声明发布完成 |
| P1 Model Gateway | 已有实现和部分接入，Feature Flag 未控制路径 | 不得声明可灰度/可回滚 |
| P2 Replan | 已有实现和测试，仍需受真实 Flag、预算和负向能力策略约束 | 作为后续集成基础，不单独宣告生产完成 |
| P3 记忆 | 原型/局部图谱改造 | `MemoryGovernor` 未进入生产路径，契约和持久化不完整 |
| P4 上下文 | 原型 | `ContextScheduler` 未进入生产路径，默认 tokenizer 仍是估算器 |
| P5 质量门 | 原型 | `EvaluatorRegistry`/`FeedbackLearner` 未进入保存和反馈链路 |
| P6 交互 | Trace 页基础链路可用；会话内计划卡真实流、pause/resume/cancel/retry、409 conflict 与 reload E2E 已通过 | 完整 Desktop IPC 安装态控制矩阵仍须通过 |
| P7 Eval | 命令壳和少量用例存在 | 数据集、Manifest、统计协议、artifact、RC gate 未完成 |

### 1.3 当前发布阻断项

以下任一项未关闭时，不得创建生产 RC：

- Desktop source smoke 失败；
- Feature Flag 不能真实关闭对应执行路径；
- 会话计划卡的完整 Desktop IPC 安装态控制 E2E 未通过；
- 第 19 节禁止能力只有文档约定，没有 fail-closed 策略和负向测试；
- P3～P5 组件没有生产消费者却被标记为完成；
- P7 没有 Eval Manifest 和失败 case artifact；
- `git diff --check` 不通过。

## 2. 实施纪律

### 2.1 每刀必须满足

每个任务使用独立提交，并包含：

1. 本刀修改范围；
2. 生产调用路径；
3. Feature Flag 开/关行为；
4. 数据迁移与回滚；
5. 定向测试；
6. 根级回归；
7. 手册和 handoff 更新。

禁止把 M4～M7 合成一个“大完成”提交。

### 2.2 阶段状态词

只使用以下状态：

- `未开始`：没有可验证产物；
- `原型完成`：类型/模块/单测存在，未接生产；
- `集成中`：生产路径已接入，但 Flag、E2E、回滚或证据不全；
- `RC 候选`：全部自动门禁通过，等待安装包/人工校准；
- `完成`：Definition of Done 全部满足。

### 2.3 禁止以以下证据宣告完成

- 测试总数增加；
- 新增类或 schema；
- TypeScript 编译通过；
- 单次 mock model 测试通过；
- 组件在 `index.ts` 中导出；
- 文档写了“已完成”；
- Feature Flag 只被保存但未被执行路径读取。

## 3. M0：校准文档与冻结发布声明

### 3.1 目标

建立可信状态基线，撤销“P0～P7 100% 完成、可直接投产”的错误口径。在 M1～M7 完成前保留代码，但停止扩大能力范围。

### 3.2 修改范围

- `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md`
- `docs/PROJECT_MAINTENANCE_HANDOFF.md`
- 本手册

### 3.3 实施步骤

1. 将 P3、P4、P5 标记为“原型完成/集成中”；
2. 将 P6 标记为“Trace 基础可用、inline plan 未完成”；
3. 将 P7 标记为“eval 命令存在、评估平台未完成”；
4. 明确 Desktop smoke 失败为生产发布阻断；
5. 在所有后续记录中同时写“通过项”和“未通过项”。

### 3.4 验收

- 三份文档状态一致；
- 不再出现“百分之百完成”“稳定全绿”“可交付生产”的无条件表述；
- `git diff --check` 对本刀文档修改通过。

### 3.5 建议提交

```text
docs(agent): calibrate post-review implementation status
```

## 4. M1：修复 Desktop smoke 认证链路

### 4.1 目标

让 source-tree Electron smoke 走与真实 Workbench 相同的 preload/IPC/runtime session token 路径，同时继续验证未认证 loopback 请求被拒绝。

### 4.2 根因

`runtimeRequestAccessStatus()` 已要求除 health 外的请求携带 Bearer session token；`smoke-desktop.mjs` 仍使用 Node 侧裸 `fetch(backendStatus.url + path)`，因此第一个受保护探针返回 401。

### 4.3 实际修改范围

- `apps/desktop-shell/scripts/smoke-desktop.mjs`
- `apps/desktop-shell/src/main/renderer-security.ts`
- `apps/desktop-shell/src/main/renderer-security.test.ts`

不向 renderer 暴露 session token。smoke 仅通过已受信的 preload/IPC 请求 runtime。

### 4.4 实施步骤

1. 在页面上下文内通过 `window.xiaoshuoDesktop.runtimeRequest()` 发起受保护 API 请求；
2. 建立 smoke helper，统一 JSON、NDJSON、multipart 和错误响应解析；
3. 保留 Node 裸请求负向断言：health 可访问，受保护 API 必须返回 401；
4. 验证 IPC 仅接受主 frame 和可信 renderer URL；
5. 不允许把 session token 返回给 Workbench 或写入日志。

### 4.5 验收

```powershell
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

必须同时满足：

- Desktop smoke 全流程通过；
- 裸 loopback 请求不能访问受保护路由；
- Trace、日志和 smoke 输出不包含 session token；
- `runtimeRequest` 不能代理到非 ArcWriter origin。

### 4.6 回滚

回滚 smoke helper 不得回滚本地 API 认证。认证失败时应修测试，不得临时把受保护 API 改回匿名访问。

### 4.7 建议提交

```text
test(desktop): route source smoke through authenticated runtime IPC
```

### 4.8 实时实施记录（2026-07-11）

- 状态：`完成`；认证调用修复、定向验收与根级回归均已完成；
- 实现：增加经 `window.xiaoshuoDesktop.runtimeRequest()` 的 authenticated fetch adapter，处理 JSON、NDJSON 与 multipart；仅 health 使用裸请求；
- 负向验证：裸请求受保护 runtime API 必须返回 `401/RUNTIME_SESSION_REQUIRED`；退役的 `/api/agent/execute` 必须返回 `410/AGENT_EXECUTE_RETIRED` 且不得写入文件；
- renderer 信任：仅精确匹配指定 `rendererUrl` 的 file entrypoint 可以调用 runtime IPC，拒绝同目录及其他本地文件；
- 已执行：`npx vitest run apps/desktop-shell/src/main/renderer-security.test.ts`（4/4）、`npm run typecheck`、`npm test`（92 files / 725 tests）、`npm run test:e2e`（3/3）与 `npm run smoke:desktop` 均通过；
- 回滚：只可回滚 smoke adapter；不得回滚 runtime session 认证或放宽 renderer IPC 信任边界。

## 5. M2：让 Feature Flag 成为真实执行门

### 5.1 目标

让 `off | shadow | on` 和各阶段布尔 Flag 决定真实执行路径，而不只是写入 snapshot。

### 5.2 修改范围

- `packages/agent-runtime/src/kernel/feature-flag-registry.ts`
- `packages/agent-runtime/src/kernel/run-coordinator.ts`
- `packages/agent-runtime/src/runtime.ts`
- `apps/desktop-shell/src/main/runtime-server.ts`
- 对应 shared schema、runtime/API 测试

### 5.3 执行语义

#### `agent_execution_v2_mode=off`

- 不创建新的 v2 durable run；
- 不自动恢复 v2 run；
- 使用受支持的旧路径或返回明确的功能关闭错误；
- 仍允许只读导出既有 run。

#### `shadow`

- 当前版本没有 legacy adapter 与可比较的旧路径，因此请求必须 fail closed，返回稳定码 `AGENT_V2_SHADOW_UNAVAILABLE`；
- 不创建 v2 run，不调用模型，不执行 Action，不产生文件、记忆或网络副作用；
- 只有未来另行实现“同输入、零副作用、可审计比较器”并通过专属 eval 后，才能替换为真正 shadow；不得以仅写 snapshot 冒充 shadow。

#### `on`

- 使用 v2 durable 路径；
- run 创建时固化合法 flag snapshot；
- 运行中更改 Flag 不改变既有 run。

### 5.4 子 Flag 要求

每个 Flag 必须至少有一个生产分支消费者：

| Flag | 必须控制的行为 |
| --- | --- |
| `model_gateway_v2` | 新旧模型调用适配器 |
| `agent_replanning_v2` | 是否允许 Observe 后重规划 |
| `context_budget_v2` | 是否使用 token/语义上下文调度 |
| `memory_v2` | 是否读写 governed memory |
| `memory_context_selector_v2` | 是否将 governed memory 注入 P4b |
| `quality_gate_v2` | 是否在保存前运行统一质量门 |
| `agent_event_stream_v2` | 事件流或旧轮询投影 |
| `agent_inline_plan_ui` | 会话内计划卡显示和订阅 |

### 5.5 当前 M2 落地决策

1. `RunCoordinator.beginRun()` 在生成 run ID 或任何副作用前读取 snapshot；`off` 返回 `AGENT_EXECUTION_V2_DISABLED`，`shadow` 返回 `AGENT_V2_SHADOW_UNAVAILABLE`，仅 `on` 可创建 run。
2. `AgentRuntimeService` 的 `runAgent`、`createDurableRun`、`streamAgentRun` 和 `runDurableSkill` 复查该门禁，避免调用方绕过 coordinator。
3. Desktop 使用显式、仅主进程可见的 `--agent-execution-v2=on` 启用 v2；`--safe-agent` 优先级最高，强制关闭新 run 与 stale recovery。不得提供 renderer/IPC 切换入口。
4. `off` 与 `shadow` 将所有 v2 子 Flag 归一为 `false`；既有 run 只读/可导出，运行中的 run 不因运行中改 Flag 改变 snapshot。
5. API 将上述稳定错误映射为 503；写入入口返回 code，流式入口以 NDJSON error event 返回 `error_code`；列表、详情和导出仍可读。

### 5.6 测试矩阵

- 每个 Flag 的 off/on 测试；
- 合法/非法组合测试；
- shadow 拒绝且零副作用测试；
- run snapshot 固化测试；
- `--agent-execution-v2=on` 的 Desktop smoke/E2E 启动测试，以及 `--safe-agent` 覆盖它并强制关闭新 run 和自动恢复的测试；
- 回滚后既有数据只读/可导出测试。

### 5.7 验收

- 仓库搜索能找到每个 Flag 的生产消费者；
- off 状态不会执行对应模块；
- shadow 返回稳定拒绝且模型调用数、文件写入数均为零；
- 非法组合在启动时 fail closed；
- `--safe-agent` 有真实端到端测试。

### 5.8 建议提交

```text
feat(agent): enforce feature flags on production execution paths
```

### 5.9 实时实施记录（2026-07-11）

- 状态：`集成中`；v2 durable execution 的 admission/recovery/API 门禁已完成，不能据此宣称所有子 Flag 已接入；
- 已实现：`RunCoordinator.beginRun()` 在分配 ID、写入 run 或启动 attempt 前读取 snapshot；`off` 返回 `AGENT_EXECUTION_V2_DISABLED`，`shadow` 返回 `AGENT_V2_SHADOW_UNAVAILABLE`；resume/retry 和 stale recovery 同样受门禁保护；
- Desktop：仅 main-process 启动参数 `--agent-execution-v2=on` 可为 smoke/E2E 显式开启 v2；`--safe-agent` 优先级最高并关闭 v2/new run/stale recovery；
- API：`POST /api/agent/runs`、`POST /api/agent/run` 为 gate error 返回 `503 + code`；`run-stream` 返回包含 `error_code` 的 NDJSON error，既有 run 的 list/detail/export 保持只读；
- 已验证：M2 定向测试 5 files / 130 tests、`npm run typecheck`、`npm test`（92 files / 725 tests）、`npm run test:e2e`（3/3）和 `npm run smoke:desktop` 均通过；
- 未完成：`model_gateway_v2`、`agent_replanning_v2`、`context_budget_v2`、`memory_v2`、`memory_context_selector_v2`、`quality_gate_v2`、`agent_event_stream_v2`、`agent_inline_plan_ui` 仍缺少各自的生产分支消费者。它们必须在 M2/M3/M5 逐项补齐 off/on/回滚测试后，M2 才能标为完成。

## 6. M3：修复 P6 会话计划卡

### 6.1 目标

会话计划卡使用 durable run 的真实身份、版本和步骤，且所有控制请求复用现有 API Client 和 Electron runtime bridge。

### 6.2 修改范围

- `packages/agent-runtime/src/runtime.ts`
- `packages/conversation-service/src/service.ts`
- `packages/shared/src/schemas/agent.ts`
- `packages/api-client/src/client.ts`
- `apps/workbench/src/hooks/controllers/useWorkbenchCoreController.ts`
- `apps/workbench/src/App.tsx` 或拆分后的独立组件
- Playwright E2E

### 6.3 消息契约

计划卡 metadata 至少包含：

```ts
type InlinePlanMetadata = {
  run_id: string;
  run_version: number;
  plan_version: number;
  current_step_id: string | null;
  step_ids: string[];
};
```

不得用 `skill_id` 替代 durable `step_id`，不得把 `expected_version` 固定为 1。

### 6.4 实施步骤

1. durable run 创建后把 `run_id/run_version/step_id` 写入 assistant metadata；
2. 计划卡通过 controller 调用 `client.pauseAgentRun()` 等方法；
3. 每次控制前读取或订阅最新 run version；
4. 409 version conflict 时刷新卡片，不自动重放旧操作；
5. 请求失败显示可访问的错误状态，不得只写 `console.error`；
6. 使用稳定 step ID 作为 React key；
7. 增加键盘操作、焦点、`aria-expanded`、非纯颜色状态和 loading 文案。

### 6.5 E2E

- 会话内展示真实计划；
- pause 后状态变为 paused；
- resume 使用新 version；
- cancel 后不继续写入；
- 失败 step 使用真实 step ID 重试；
- renderer reload 后卡片从事件流恢复；
- 旧 version 操作返回冲突并刷新；
- Desktop 模式确认所有请求经过 runtime IPC。

### 6.6 回滚

关闭 `agent_inline_plan_ui` 后隐藏会话卡片，Trace 页继续可用；不得删除或改变 durable run 数据。

### 6.7 建议提交

```text
feat(workbench): bind inline plan controls to durable run contracts
```

### 6.8 实时实施记录（2026-07-11）

- 状态：`集成中`；共享契约、runtime 元数据、Workbench controller 与卡片 UI 已接入，不能据此宣称 P6 或 M3 完成；
- 已实现：共享层新增 `InlinePlanMetadata`；v2 stream 的 `start` 事件及最终 assistant conversation metadata 均写入真实 `run_id`、`run_version`、`plan_version`、`current_step_id` 和 durable `step_ids`；
- 已实现：会话卡通过既有 API Client/controller 先读取最新 run version，再发起 pause/resume/cancel/retry；409 仅刷新并提示冲突，不重放旧操作；retry 使用 durable `step_id`，不再误用 `skill_id`；
- 已实现：在 stream `start` 时持久化带真实 identity 的 pending assistant metadata；renderer transport 断开不再中止 durable run，reload 后卡片从该 metadata 读取 run 并重新订阅；“停止”会显式请求 durable cancel；
- 已实现：项目首次 manifest scan 在进程内按 manifest path 合并，避免并发 UUID 生成触发项目身份门禁误拒绝；E2E 预览前总会重新构建 Workbench，不能再使用过期 `dist`；
- 已验证：shared build、runtime/desktop 定向 Vitest、Workbench 与 Desktop typecheck、`project-manifest` 回归，以及 `npm run test:e2e`（6/6）通过。会话计划卡 E2E 在模型 stream 持续打开时验证真实 `inline_plan`、reload 恢复同一 run、pause/resume/cancel、409 conflict 不重放，以及使用真实 durable `step_id` retry；
- 未完成：Browser E2E 使用 test-only runtime token，完整安装态 Desktop IPC 控制矩阵尚无证据；
- 放行结论：保持 `agent_inline_plan_ui` 默认关闭，M3 与 P6 均不得进入 RC。

## 7. M4：第 19 节 Negative Capability Gate

### 7.1 定位

第 19 节不是“以后再做”的愿望清单，而是 0.5.0～0.9.0 必须持续满足的安全不变量。禁止能力不能通过普通 Feature Flag、环境变量、Prompt、网页、附件、项目文件或导入 Skill 开启。

### 7.2 统一策略契约

建议在 shared 层定义：

```ts
type InvocationActor = "user_ui" | "agent" | "system" | "updater";

type CapabilityRequest = {
  actor: InvocationActor;
  capability: string;
  project_id: string;
  run_id: string | null;
  budget_id: string | null;
  confirmation_id: string | null;
};
```

在 agent-runtime 增加单一 `NegativeCapabilityPolicy`，所有 Action 在 dispatch 前检查；Electron 专属能力在 main process 再检查一次。未知 actor、未知 capability、缺失 scope 一律拒绝。

### 7.3 七项硬门禁

#### G19-1 单 Agent

- 一个 run 只能有一个 executor identity；
- Action Registry 不注册 spawn/delegate/child-agent；
- schema 拒绝 `agent_count > 1`、子 run 编排和并行 Agent 图；
- 普通 workflow 内部的确定性并发不得被描述成多 Agent。

#### G19-2 禁止自行安装工具/库

- Agent Action 不暴露 package manager、软件下载或依赖修改；
- 导入 Skill 只能落为受控数据/声明，不能执行安装脚本；
- 禁止写 `package.json`、lockfile、应用安装目录和可执行搜索路径；
- 用户主动升级依赖属于开发者操作，不属于 Agent 能力。

#### G19-3 禁止 Agent 自动 Shell

- `terminal.*` 不进入 Agent Action Registry、runtime API 或模型 tool schema；
- 手动终端使用独立 `user_terminal` capability；
- main process 签发短 TTL、单次、绑定窗口和项目的用户手势票据；
- 可信 renderer 只是必要条件，不等于用户确认；
- 任意模型文本、Skill 或网页内容不能创建或写入 terminal session。

#### G19-4 禁止自修改和自发布

- Agent 禁止写应用安装目录、运行内核、`.git`、`.github/workflows` 和发布配置；
- 更新只允许签名 updater 以 `actor=updater` 执行；
- 发布必须由 CI 和受保护环境完成；
- Agent 可以生成代码建议或 patch preview，但不能自行应用到运行内核并发布。

#### G19-5 禁止无预算后台自治

每个可执行 run 强制携带：

```ts
type BudgetEnvelope = {
  max_steps: number;
  max_replans: number;
  max_model_calls: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_estimated_cost: number;
  deadline_at: string;
};
```

缺少预算不得启动；达到任一上限进入 paused；应用退出后只允许持久化检查点，不承诺隐藏后台继续运行。

#### G19-6 禁止未经确认的跨项目写入

- scope 同时校验稳定 project UUID 和 canonical realpath；
- confirmation 绑定源/目标 project ID、路径、hash、version 和 action fingerprint；
- symlink/junction、目录移动、项目切换后重新校验；
- 同一确认不能授权新增路径或另一个项目；
- 跨项目只读引用也必须由用户显式选择，默认不进入长期记忆。

#### G19-7 禁止 draft 直入 Confirmed Memory

状态机固定为：

```text
draft -> proposed -> confirmed
          |             |
          v             v
       rejected      superseded
```

- 模型、workflow 和 critic 最多创建 `draft/proposed`；
- `confirmed` 迁移必须有第二次用户确认事件；
- 事件保存 confirmation ID、actor、source revision、content hash 和时间；
- 已保存产物可以作为 proposed 的来源证据，但不能自动等同于 confirmed；
- 失败输出、未保存草稿、模型推测永远不能进入 confirmed。

### 7.4 负向测试

新增：

```powershell
npm run eval:excluded-capabilities
```

必须覆盖直接调用和绕过方式：

- Prompt Injection 请求 shell、安装依赖或扩大预算；
- Skill manifest 伪造工具权限；
- 模型生成内容伪装 system/user actor；
- 环境变量和 Feature Flag 尝试解锁禁止能力；
- 路径穿越、symlink/junction、项目切换竞态；
- confirmation 重放、扩权和过期版本；
- 无预算恢复、退出后继续执行；
- draft、失败产物和未确认记忆升级；
- renderer 脚本在没有用户手势票据时调用 terminal。
- 与终端无关的旧 `pointerdown`/`keydown`、另一个窗口、另一个项目、过期票据和已消费票据不得创建 terminal session。

### 7.5 验收

- 七项禁止能力的直接和绕过测试全部为零成功；
- 手动终端仍能由真实用户在 UI 中使用；
- 不存在能开启禁止能力的普通 Flag；
- RC 累计至少 1000 次关键安全边界执行，越权写入和重复副作用为 0；
- 每次拒绝产生脱敏、可追踪的 policy decision event。

### 7.6 解禁规则

0.5.0～0.9.0 不解禁。未来必须另立 ADR、威胁模型、产品收益基线、独立预算/隔离/恢复设计、专属 eval 和人工安全审查；不得用配置热开关偷渡。

### 7.7 建议提交

```text
feat(agent): enforce negative capability policy
test(agent): gate excluded capabilities
```

### 7.8 实时实施记录（2026-07-11）

- 状态：`原型完成`；共享 `CapabilityRequest`/`BudgetEnvelope` 契约和 runtime `NegativeCapabilityPolicy` 已建立，`ActionExecutor` 的每次 Agent Action 分发均先经过 deny-by-default gate；
- 已拒绝：多 Agent spawn/delegate、依赖安装、shell/terminal、运行内核修改/发布、无预算后台自治、跨项目写入和 `memory.confirm`。未知 actor/capability 同样 fail closed；普通 Feature Flag 不参与该策略；
- 已接入但未验收：preload 已尝试签发单次用户手势票据，`user_ui/user_terminal` 仍是唯一可能使用手动 terminal 的 actor/capability；Agent 永远不能使用该 capability；
- 已验证：新增 `npm run eval:excluded-capabilities`，当前 `NegativeCapabilityPolicy`、`ActionExecutor` 与 preload ticket 的负向测试共 4 files / 30 tests 通过；`npm run typecheck`、`npm test`（93 files / 741 tests）和 `npm run test:e2e`（6/6）也曾通过；
- 未通过：最新 `npm run smoke:desktop` 中，无专用终端启动操作的 `terminal.create()` 意外成功。现有票据按“最近任意可信事件”签发，早前的 Playwright 交互可残留可消费票据；这不能证明真实用户确认了启动终端；
- 未完成：所有 run 的强制 `BudgetEnvelope`、canonical realpath + 二次确认的跨项目写入、以及 draft/proposed/confirmed 的持久化状态机尚未接入真实数据面。M4 不得标记完成或进入 RC。

### 7.9 M4-T1：终端用户手势票据收口

#### 目标

保留用户手动终端，但使它与 Agent、模型内容、普通页面交互和历史手势彻底隔离。此任务只收紧已存在 terminal，不给 Agent 增加 shell 或代码执行能力。

#### 实施步骤

1. `TerminalView` 不得在 mount 时自动创建 terminal；改为用户可见的“连接终端”命令。
2. 该命令必须带稳定的 `data-terminal-user-gesture` 标识；仅当可信 `pointerdown` 或键盘激活事件的 `composedPath()` 命中该标识，preload 才可签发票据。
3. 票据必须是单次、短 TTL，并绑定 window/webContents、renderer origin、canonical project identity 和 terminal-create action；不得由任意“最近手势”复用。
4. `terminal.create` 的主进程入口再次校验票据、绑定和消费状态；任何失败返回稳定拒绝码，不创建 session、不执行命令。
5. Agent Action Registry、runtime HTTP 路由、模型 tool schema 和 Skill manifest 继续不暴露 `terminal.*`。

#### 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| 无终端启动手势调用 `terminal.create` | 拒绝；无 session |
| 点击专用控件后首次 create | 创建一个用户 terminal session |
| 同一票据重放或过期后 create | 拒绝；无第二个 session |
| 其他控件的 click/keydown、其他窗口或项目 | 拒绝 |
| 键盘激活专用控件 | 与点击等价，但只签发一次 |
| Agent/prompt/Skill 请求 `terminal.*` | 策略拒绝，不能到达 IPC |
| 手动 terminal 正常 echo 与关闭 | 仅经 Electron preload/IPC/main process，source smoke 通过 |

#### 放行与回滚

- 放行前必须重新运行 `npm run eval:excluded-capabilities`、`npm test`、`npm run smoke:desktop` 和 `git diff --check`；
- 若该门禁导致已有手动终端不可用，只能回滚到仍需要专用用户启动动作的上一实现；不得恢复 mount 自动启动、最近任意手势或 Agent shell。

## 8. M5：分阶段接入 P3、P4、P5

M5 必须拆成三组提交，顺序为 P3 -> P4b -> P5；P4a tokenizer/语义裁剪可先独立接入，但不得假装消费了 governed memory。

### 8.1 M5-P3 Governed Memory

#### 必须补齐

- 使用手册 9.3 的完整 `NarrativeCoordinate/CanonClaim` 契约；
- 持久化 claims、overrides、memory revision、outbox 和 projection status；
- 结构化会话摘要替代最近消息拼接；
- 用户查看、纠正、遗忘、导出和重建入口；
- 项目 UUID 隔离、来源 revision 失效、旧 run revision 暂停；
- G19-7 的 proposed/confirmed 状态机。

#### 生产接线

- `memory_v2=on` 时 runtime 真实读写 governed memory；
- `off` 时不创建新 governed memory 写入；
- `MemoryGovernor` 不能继续只使用进程内 Map；
- 图谱、向量和会话摘要必须成为同一 revision 的投影。

#### 验收

- 100 轮会话回放；
- 重启、纠正、撤销、重建不复活旧值；
- 同名人物跨项目零召回；
- 时间区间和 perspective fixture；
- draft 未二次确认不能进入 confirmed。

### 8.2 M5-P4 Token Context

#### 必须补齐

- tokenizer 由 Model Gateway 按实际模型提供；
- `ContextBlock` 统一使用 shared schema；
- 生产 ContextAssembler 调用 `ContextScheduler`；
- P4b 消费 canon、perspective、story time 和 memory revision；
- Trace 记录 included/excluded reason、estimated/used token 和 selector version；
- untrusted source 的 `allow_instruction=false` 由应用设置，调用者不能伪造。

#### 验收

- 不同模型得到不同预算；
- JSON/Markdown/正文裁剪不破坏语义边界；
- context precision/recall、引用正确率、遗漏率和截断伤害率有版本化报告；
- 关闭 Flag 后回退旧 ContextAssembler，不影响 P3 数据。

### 8.3 M5-P5 Quality Gate

#### 必须补齐

- Evaluator 输出完全符合 shared `QualityReport`；
- 保存入口统一执行 artifact policy；
- hard gate 与 subjective issue 分离；
- 文风、节奏和措辞默认只建议，不自动 revise；
- evidence 为空的模型问题不能阻断；
- feedback 只能生成候选，用户确认后才形成版本；
- apply/revert 与 eval manifest 绑定。

#### 验收

- 所有 project document 保存路径经过统一质量门或明确关闭路径；
- subjective issue 默认不会改稿；
- 最多两次修订且复检原 issue code；
- 原稿、修订稿、报告和用户 override 均可追溯；
- `quality_gate_v2=off` 可回退，不删除已有报告。

### 8.4 建议提交

```text
feat(memory): integrate durable governed memory
feat(context): integrate model-aware context scheduling
feat(agent): integrate artifact quality gate
```

## 9. M6：建立真实 P7 Eval 平台

### 9.1 目标

把 `eval:*` 从单测别名升级为可复现、可比较、可审计的发布证据。

### 9.2 数据集最低规模

沿用上位手册 13.1，不得降低：

- 路由 150；
- 技能选择 120；
- 文件引用 100；
- 多步规划 80；
- 重规划 50；
- 长期记忆 60；
- 图谱冲突 60；
- 保存安全 60；
- 严格格式 50；
- 重启恢复 30；
- 端到端作者任务 50；
- 上下文引用 80；
- Canon 时序/视角 60。

至少 20% 为 sealed holdout，并按作品/项目分组，禁止相邻章节泄漏。

### 9.3 Eval Manifest

每次命令生成机器可读 JSON，至少包含：

```text
eval_name
dataset_version / dataset_hash
code_commit
model_provider / model_id / capabilities
prompt_hash / skill_versions / rubric_versions
temperature / top_p / seed
started_at / duration
token_usage / estimated_cost
pass_rate / failure_cases
```

Manifest 必须保存 case 级结果，不能只有总通过率。

### 9.4 CI 接线

以下 workflow 显式运行六个现有 eval 和 `eval:excluded-capabilities`：

- `.github/workflows/windows-pr-ci.yml`
- `.github/workflows/desktop-rc.yml`
- `.github/workflows/release.yml`

上传：

- Eval Manifest；
- 失败 case 摘要；
- 脱敏 Trace；
- 性能基线；
- 安全/恢复累计次数；
- 人工校准结果引用。

### 9.5 验收

- clean checkout 的 Windows Node 22 可运行；
- 数据集数量和 hash 可核验；
- 同 commit deterministic eval 可重复；
- 安全、恢复、跨项目隔离退化立即阻断；
- CI artifact 能从 release evidence 追溯到同一 commit；
- 失败 case 不泄露 API key、私有稿件或完整敏感 prompt。

### 9.6 建议提交

```text
test(agent): build reproducible eval manifests and release gates
```

## 10. M7：RC 与生产候选验收

### 10.1 前置条件

只有 M0～M6 全部完成，才能进入 M7。

### 10.2 自动门禁

```powershell
npm ci
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run test:e2e
npm run smoke:desktop
npm run eval:routing
npm run eval:planning
npm run eval:memory
npm run eval:quality
npm run eval:recovery
npm run eval:security
npm run eval:excluded-capabilities
```

### 10.3 RC 证据

- Authenticode 签名和时间戳；
- installed-build smoke；
- 同 commit release evidence；
- migration/backup/rollback 演练；
- 2 小时长任务 soak；
- 每个 journal 边界故障注入；
- 参考设备 P50/P95；
- G0 配对作者任务与人工质量校准。

### 10.4 放行原则

- 自动门禁全绿只是 RC 候选，不自动等同生产发布；
- 缺少签名、安装后验证、回滚证据或人工校准时不得发布；
- 样本不足不因日期到期自动晋级；
- 任一未确认危险写入、跨项目访问、重复副作用或第 19 节能力绕过立即停止放量。

## 11. 全局 Definition of Done

在以下清单全部满足前，P0～P7 不得整体标记为完成：

- [ ] Desktop source smoke 和 installed-build smoke 均通过；
- [ ] 每个 Feature Flag 有生产消费者、off/on 测试和回滚证据；
- [ ] `--safe-agent` 能真实阻断新执行和自动恢复；
- [ ] 会话计划卡使用真实 run ID、step ID 和最新 version；
- [ ] 第 19 节七项能力由代码硬门禁保护；
- [ ] `eval:excluded-capabilities` 在 CI/RC/release 中必跑；
- [ ] P3 记忆持久化、可治理、按项目和 revision 隔离；
- [ ] P4 使用模型 tokenizer 并进入生产上下文链路；
- [ ] P5 进入真实保存链路，主观问题默认不自动改稿；
- [ ] P7 达到最低数据集规模并生成 Manifest；
- [ ] Windows CI 保存失败 case、Trace、性能和安全证据；
- [ ] G0 与上一稳定版完成配对比较；
- [ ] `git diff --check`、typecheck、单测、E2E、build、smoke 全部通过；
- [ ] 文档、handoff、版本号和 release evidence 状态一致。
- [ ] M4-T1 的 terminal ticket 只可由专用、一次性的用户启动动作签发，且 source smoke 负向与正向路径均通过。

## 12. 实施记录模板

每完成一刀，在 `docs/PROJECT_MAINTENANCE_HANDOFF.md` 追加：

```markdown
### YYYY-MM-DD Mx 任务名称

- 状态：未开始 / 原型完成 / 集成中 / RC 候选 / 完成
- 生产路径：
- 修改文件：
- Flag 开启行为：
- Flag 关闭行为：
- 数据迁移：
- 回滚方法：
- 定向测试：
- 根级验证：
- 未完成项：
- Git commit：
```

记录必须明确未完成项。禁止只写“全绿”“圆满完成”而不列出实际命令、范围和发布证据。
