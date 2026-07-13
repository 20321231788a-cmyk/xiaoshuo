# ArcWriter Agent 优化审阅后续实施手册

> 制定日期：2026-07-11
>
> 最近修订：2026-07-13（最高效率：两批修改、一次集中验收）
>
> 状态：本轮 Batch A、Batch B 已完成，且固定六命令矩阵最终复跑通过。M2～P5 仍为“集成中”，P7 只完成可复现证据机制，M7 RC 尚未开始；本结果仅为代码验收，不能据此宣称可发布。
>
> 适用范围：ArcWriter 0.5.0～0.9.0
>
> 上位文档：`docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md`
>
> 原则：效率优先；先连续完成 Batch A 和 Batch B，再执行一次开发闭环集中验收。安全边界始终 fail closed，第 19 节列出的能力在本路线内保持硬禁用。

## 0. 文档目的

本手册把 2026-07-11 代码审阅发现转换为可执行任务。它不重新设计 ArcWriter，也不扩大 Agent 权限，只处理以下七件事：

1. 校准 P0～P7 的真实完成状态；
2. 修复 Desktop smoke 认证回归，恢复发布门禁；
3. 让 Feature Flag 真正控制执行路径和回滚；
4. 修复 P6 会话计划卡的 run/version/step/API 契约；
5. 把第 19 节升级为 Negative Capability Gate；
6. 冻结已形成代码闭环的 P3，集中补齐 P4、P5 的生产链路；
7. 先建立 P7 Eval Manifest、固定 seed/fixture hash 和 CI failure artifact 机制，再按 RC 门槛扩充数据与发布证据。

本文中的“完成”只表示：生产调用路径已接入、关闭和回滚路径有效，并在 Batch A 与 Batch B 全部修改完成后，由同一代码树一次性产生要求的测试与证据。开发过程中已写但尚未执行的测试只算“待集中验收”；只有类、schema、数据库表、单测或导出存在，不构成阶段完成。

### 0.1 审阅建议到实施顺序

| 审阅建议 | 执行阶段 | 不可跳过的放行条件 |
| --- | --- | --- |
| 撤回“P0～P7 100% 完成、可投产” | M0 | 三份状态文档与实际验证结果一致 |
| 修复 Desktop smoke 的认证调用 | M1 | 受保护请求仅经 preload/IPC；裸 loopback 仍为 401 |
| Feature Flag 真实控制执行与回滚 | M2 | `off/on` 有真实执行差异，`shadow` 未实现比较器时 fail closed |
| 修复 P6 run/version/step/API Client 契约 | M3 | E2E 覆盖 pause/resume/cancel/retry、冲突刷新和 reload |
| 落地第 19 节硬禁用能力 | M4 | 七项直接调用与绕过测试均为零成功 |
| 冻结 P3，批量收口 P4、P5 | M5 / Batch A | 生产消费者、关闭回退和测试用例齐备，统一等待最终矩阵 |
| 建立 P7 Manifest、固定输入与 CI artifact | M6 / Batch B | Manifest 与失败 artifact 可追溯到同一 commit；不因此直接进入 RC |

### 0.2 当前执行队列（2026-07-13）

此队列是实施顺序，不是发布承诺。未通过的步骤不得用后续步骤或更多测试数量抵消。

| 优先级 | 工作项 | 当前结论 | 退出条件 |
| --- | --- | --- | --- |
| P0 | M4-T1：终端用户手势授权 | source-tree 已完成；preload 与 main process 双层单次授权已通过 Electron smoke | 安装态 Workbench 控件 E2E 通过；不向 renderer 暴露授权 token |
| P1 | M4-T2a：canonical 项目写入 scope | 已接入 DocumentService、CommitJournal、runtime registry，并以 OS `dev/ino` identity 跨重启 fail closed | 跨项目写入目前仍由 Negative Capability Gate 直接拒绝；未来若解禁，须另行绑定精确 receipt |
| P1 | M4-T2b：durable 预算准入/恢复门 | 已接入；预算由可信 profile 签发，step/replan/model 调用以原子 reserve/settle 记账 | 继续扩展模型目录与成本精度不得放宽输出上限、checkpoint pause 或恢复时 reconcile |
| P1 | M4-T2c：Action confirmation receipt | 已接入并完成 B1 验收 | 任何 `confirmation_policy=always` Action 仅能消费绑定 run/step/action/project/target 的 approved receipt |
| P0 | Batch A：M2/M3 控制闭环 | 已完成本轮代码验收；E2E 覆盖 reload、pause/resume/cancel/retry、冲突与确认流程 | M7 仍需 installed-build 和发布级证据 |
| P0 | Batch A：P4/P5 生产收口 | 已完成本轮代码验收；调度、legacy 回退、统一 quality gate 与确认 feedback 已接线 | M7 仍需扩展质量数据和人工校准 |
| P1 | Batch B：P7 可复现证据机制 | 已完成本轮代码验收；Manifest、固定 seed、fixture/case hash、失败 artifact 和 CI 上传已接线 | sealed holdout、最低数据规模与 RC 统计协议仍未完成 |
| P1 | 最终集中验收 | 已完成；首次 eval 运行器 Windows spawn 失败已定向修复，六条命令最终复跑通过 | 本结果不是 RC 放行 |
| P2 | M6 数据规模与 M7 RC | 预演中；本地安装/卸载和 0.3.2 → 0.4.0 → 0.3.2 已通过，dirty evidence 被发布验证器拒绝；RC workflow 已强制数据集/holdout declaration | 提供真实 13 类数据集声明并在干净、已签名候选上完成安装、升级/回滚、soak 与人工校准；不得由开发闭环验收替代 |

### 0.3 效率优先的实施批次

后续不再按“改一个文件、跑一轮测试”或“每批跑一次 L1/L2”的节奏推进。只保留两个连续开发批次；Batch A 完成后直接进入 Batch B，两个批次全部冻结后才执行一次集中验收：

| 批次 | 集中完成的修改 | 退出条件（不执行常规测试） |
| --- | --- | --- |
| 历史基线（不再作为后续批次） | B1 的执行安全边界、B2 子 Flag 消费者和 B3/P3 代码闭环均保留 | 仅复用可追溯的历史定向证据；当前状态仍为“集成中” |
| Batch A：生产闭环 | M2 剩余收口、M3 安装态 IPC 控制矩阵、P4 prompt/skill/save 全路径调度与 legacy 回退、P5 所有保存入口的 pre-save gate、feedback/确认及失败回滚/报告契约 | 代码、迁移、回滚、fixture 和测试用例全部写完；未留计划内修改 |
| Batch B：证据机制 | P7 Eval Manifest schema/version、固定 seed policy、fixture/case hash、命令/commit 追溯、失败 case 摘要、脱敏 Trace、CI `always()` artifact 与文档状态 | 代码、workflow、fixture 清单和文档全部写完；未留计划内修改 |
| 最终集中验收（不是开发批次） | 固定矩阵验证 Batch A + Batch B 的同一代码树 | 六条命令一次执行；失败按第 2.2 节定向修复后，完整矩阵最终复跑一次 |

Batch A 与 Batch B 之间不运行常规测试，可以连续修改多个相关模块和测试文件。只有出现无法继续开发的编译阻断、数据破坏风险或安全 fail-open，才提前执行最小定位命令；不得借机扩大为全量回归。

## 1. 审阅基线

### 1.1 上一验收基线与当前批次状态

| 验证项 | 最近证据 | 当前状态与判断 |
| --- | --- | --- |
| `npm run typecheck` | B1 出口通过（根级） | 统一验证所有 workspace 类型边界 |
| `npm test` | 首次根级运行：99 files、798 passed、4 failed；修复后受影响的 `runtime.test.ts` 91/91 通过，其余 98 files 未受该局部修复影响 | 记录一次根级结果和一次最小回归，不因小改动反复执行全套 |
| 六个 `eval:*` 命令 | 共 33 个用例通过 | 命令存在，但未达到 P7 数据集和证据要求 |
| `npm run build:desktop` | 历史 B1 出口通过 | P3 的 UI/投影消费者现已接入；该历史结果仅作基线，build/安装包证据在 M7 RC 重新生成 |
| `npm run test:e2e` | B1：先通过 4/6，再仅重跑确认的 approve/reject 2/2；合并为 6/6 | 两次失败均为已渲染状态的过严文本选择器，已收紧为精确状态加目标路径断言 |
| `npm run eval:excluded-capabilities` | B1 出口 11 files / 104 tests 通过 | 覆盖 deny-by-default policy、预算账本、确认回执、项目 identity、MemoryGovernor 与 preload/main 双层 terminal 手势拒绝 |
| `npm run smoke:desktop` | B1 出口通过 | Electron 42.3.0、node-pty 和 node:sqlite 运行正常 |
| `git diff --check origin/main...HEAD` | 失败 | 历史提交格式问题仍与本轮变更分开处置；本轮修改必须单独通过 `git diff --check` |

表中结果均为历史基线，不等于当前代码树已完成最终集中验收。它们可帮助定位风险，但不能抵消 Batch A、Batch B 的未完成项，也不等价于 M4、M5 或发布候选完成。

### 1.2 阶段状态校准

| 阶段 | 当前状态 | 允许结论 |
| --- | --- | --- |
| P0 持久执行 | 已有主体实现，待发布验收 | 不得在 Desktop smoke 和回滚门禁通过前声明发布完成 |
| P1 Model Gateway | `model_gateway_v2` 已有真实 on/off 生产分支，待最终集中验收 | 不得在最终矩阵前声明可灰度/可回滚 |
| P2 Replan | 已有实现和测试，仍需受真实 Flag、预算和负向能力策略约束 | 作为后续集成基础，不单独宣告生产完成 |
| P3 记忆 | 代码闭环已具备，仍为集成中 | 权威 store、结构化摘要、来源失效、治理 UI、图谱/向量投影与重建、100 轮重启/项目隔离回放已落地；历史定向证据 9 files / 178 tests，等待最终矩阵 |
| P4 上下文 | Batch A 待收口 | ChatRunner 已有 `ContextScheduler` 初始生产分支；仍需覆盖相关 prompt/skill/save 路径和明确的 legacy assembler 回退 |
| P5 质量门 | Batch A 待收口 | generated cache 副作用前已有 `EvaluatorRegistry` 门；仍需统一所有保存入口、feedback 确认及拒绝回滚/报告契约 |
| P6 交互 | Trace 页基础链路可用；会话内计划卡真实流、pause/resume/cancel/retry、409 conflict 与 reload E2E 已通过 | 完整 Desktop IPC 安装态控制矩阵仍须通过 |
| P7 Eval | Batch B 待实施 | 命令壳和少量用例存在；Manifest、固定 seed/fixture hash、失败 artifact、CI gate 与 RC 数据规模未完成 |

### 1.3 当前发布阻断项

以下任一项未关闭时，不得创建生产 RC：

- M2 子 Flag 已有生产分支，但尚未与 Batch A、Batch B 一起通过最终集中验收；
- 会话计划卡的完整 Desktop IPC 安装态控制 E2E 未通过；
- P3 代码闭环虽已具备，但尚未取得当前整棵代码树的最终集中验收；P4/P5 仍缺 Batch A 的全路径生产收口；
- P7 尚无符合 Batch B 契约的 Eval Manifest、固定 fixture hash 和失败 case artifact；
- 最终六命令矩阵已通过，但它只关闭开发闭环，不能替代 M7 RC 门禁；
- M6 数据集规模、installed-build、签名、升级/回滚、soak 和人工校准仍未完成，因此开发闭环通过后也不得直接创建 RC。

## 2. 实施纪律

### 2.1 批量开发规则

先固定 Batch A 与 Batch B 的 scope，再连续完成代码、schema、迁移、回滚和测试用例。两批之间不跑根级 typecheck、全量单测、build、E2E、Desktop smoke 或 eval；允许在不执行测试的情况下继续修改关联文件，直到两个批次同时冻结。

批次内必须同步准备：

1. 生产调用路径和禁止绕过点；
2. Feature Flag 开/关行为；
3. 数据迁移与回滚；
4. 对应测试用例和 fixture；
5. 影响范围清单；
6. 两批共用的最终集中验收命令。

提交边界按可回滚能力划分，不按单个文件或单个测试划分。Batch A、Batch B 可以分别提交，但提交不是测试触发器；只有两个批次都完成后才进入最终集中验收。

### 2.2 单次集中验收策略

| 层级 | 触发时机 | 执行内容 |
| --- | --- | --- |
| 中途例外检查 | 仅编译阻断、数据破坏风险或安全疑似 fail-open | 只运行受影响 workspace/typecheck、单个用例或最小负向检查；结果不算批次验收 |
| 开发闭环集中验收 | Batch A 与 Batch B 的代码、测试、fixture、workflow、回滚和文档全部完成 | 按下列固定矩阵执行一次 |
| M7 RC 验收 | 开发闭环已通过且 M6 数据规模、安装包与发布材料齐备 | clean install、build、完整 eval、安装/升级/回滚、签名、soak 和人工校准；不并入日常修改循环 |

最终集中验收矩阵固定为：

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run smoke:desktop
npm run eval:excluded-capabilities
git diff --check
```

执行约束：

- 第一次矩阵执行中若有失败，只定向重跑失败文件或失败命令进行定位，不重复已经通过的昂贵命令；
- 修复所有失败项并取得定向绿色结果后，完整六命令矩阵再执行一次，作为唯一最终通过证据；
- 同一受测代码树、同一输入和同一构建产物的绿色证据可以复用；文档-only commit 不使二进制证据失效，RC 时再生成与候选 commit 对齐的最终证据；
- 文档-only 修改只运行链接/格式/一致性检查，不运行产品 test、build、E2E 或 smoke；
- E2E、Desktop smoke、安装态验证和大规模 eval 不在日常开发循环中运行；安装态 IPC 用例虽在 Batch A 编写，仍随最终矩阵的 E2E/smoke 一起执行；
- 安全、身份、预算、确认、迁移代码若疑似 fail-open，立即停止该批次并运行最小负向用例，确认 fail closed 后继续；
- “补测试”表示把用例纳入批次集合，不表示每写一个用例就执行一次。

### 2.3 开发闭环出口判定

进入集中验收前必须同时满足：Batch A 与 Batch B scope 内不再有计划中的代码修改，测试 fixture、workflow、迁移/回滚和文档均已齐，已知未完成项已列明。Batch A 完成编码后直接进入 Batch B，不单独验收；最终矩阵未全绿时，相关里程碑继续标记为“集成中”。

Batch A 与 Batch B 共用一份最终验收记录，包含 commit、影响范围、六条实际命令、失败定向重跑、最终复跑和复用证据。禁止为单个文件、单个小改动或两个开发批次分别追加“全量全绿”记录。

### 2.4 阶段状态词

只使用以下状态：

- `未开始`：没有可验证产物；
- `原型完成`：类型/模块/单测存在，未接生产；
- `集成中`：生产路径已接入，但 Flag、E2E、回滚或证据不全；
- `RC 候选`：全部自动门禁通过，等待安装包/人工校准；
- `完成`：Definition of Done 全部满足。

### 2.5 禁止以以下证据宣告完成

- 测试总数增加；
- 新增类或 schema；
- TypeScript 编译通过；
- 单次 mock model 测试通过；
- 组件在 `index.ts` 中导出；
- 文档写了“已完成”；
- Feature Flag 只被保存但未被执行路径读取。

## 3. M0：校准文档与冻结发布声明（历史完成）

### 3.1 历史目标

M0 当时用于建立可信状态基线，撤销“P0～P7 100% 完成、可直接投产”的错误口径。M0 已完成，不进入当前 Batch A/Batch B scope；当前状态以第 0.2、1.2 节为准。

### 3.2 修改范围

- `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md`
- `docs/PROJECT_MAINTENANCE_HANDOFF.md`
- 本手册

### 3.3 历史实施步骤（已完成）

1. 当时将 P3、P4、P5 从错误的“完成”口径校准为“原型完成/集成中”；后续进展见第 1.2、8 节；
2. 当时将 P6 校准为“Trace 基础可用、inline plan 未完成”；inline plan 后续已接入，安装态 IPC 仍归 Batch A；
3. 将 P7 标记为“eval 命令存在、评估平台未完成”；当前剩余机制归 Batch B；
4. 当时将 Desktop smoke 失败列为生产发布阻断；该认证回归已由 M1 修复，安装态 RC 证据仍后置；
5. 在所有后续记录中同时写“通过项”和“未通过项”。

### 3.4 历史验收结果

- 当时三份文档状态已完成校准；
- 当前继续禁止“百分之百完成”“稳定全绿”“可交付生产”的无条件表述；
- M0 的历史文档检查不替代 Batch A + Batch B 的最终集中验收。

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

### 4.5 历史批次验收

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

### 5.6 最终验收覆盖

以下用例随实现一起补齐，但不在 M2 单独执行，统一纳入 Batch A + Batch B 的最终集中验收：
- 每个 Flag 的 off/on 测试；
- 合法/非法组合测试；
- shadow 拒绝且零副作用测试；
- run snapshot 固化测试；
- `--agent-execution-v2=on` 的 Desktop smoke/E2E 启动测试，以及 `--safe-agent` 覆盖它并强制关闭新 run 和自动恢复的测试；
- 回滚后既有数据只读/可导出测试。

### 5.7 最终验收判定

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
- 状态更新：`model_gateway_v2`、`agent_replanning_v2`、`context_budget_v2`、`memory_v2`、`memory_context_selector_v2`、`quality_gate_v2`、`agent_event_stream_v2` 与 `agent_inline_plan_ui` 均已有生产消费者和关闭路径；M2 仍为“集成中”，等待 Batch A 的安装态控制闭环与 Batch A + Batch B 最终集中验收。

### 5.10 子 Flag 生产接线基线（并入 Batch A，2026-07-13）

- 状态：`集成中`。子 Flag 的 runtime/route 消费者已补齐；后续不再为 M2 单开验收批次，剩余安装态 Electron IPC 控制矩阵并入 Batch A，所有证据随 Batch A + Batch B 的最终矩阵统一生成；
- `model_gateway_v2=on` 构造并注入 `ModelGateway`；关闭时所有 planner/chat/skill 调用复用原始 OpenAI-compatible adapter。两条路径都经 durable 预算包装；Gateway 的熔断、限流、重试与结构化修复不会在关闭时暗中继续生效；
- `agent_replanning_v2` 直接控制失败步骤后的动态重规划；`context_budget_v2` 在 ChatRunner 组装前启用 `ContextScheduler` token 选择，关闭时保持旧 `ContextAssembler` 字符预算路径；
- `memory_context_selector_v2` 仅在开启时把项目内 `confirmed` CanonClaim 注入模型上下文。它不影响 `memory_v2` 的受控写入、确认、来源失效和投影，且不会注入 draft/proposed；
- `quality_gate_v2` 在 generated cache 准备完毕、任何 journal/文件副作用开始前运行统一 `EvaluatorRegistry`。失败返回 `QUALITY_GATE_REJECTED`，不创建 durable commit run；
- `agent_event_stream_v2` 控制 durable `/events/stream`：关闭时返回稳定 `AGENT_EVENT_STREAM_V2_DISABLED` 并要求调用既有 `/events` 轮询投影，不关闭用户的 `run-stream` 生成输出；`agent_inline_plan_ui` 继续控制会话计划卡 metadata；
- 历史定向证据：agent-runtime 与 desktop-shell typecheck 通过；runtime 与 Desktop agent route 定向集此前通过 `2 files / 117 tests`。被主动停止的重型上下文 fixture 不计为绿色证据；不再追加 M2 独立 L1/L2，根级 test/E2E/smoke 与安装态矩阵统一留到最终集中验收。

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

### 6.5 最终验收 E2E 覆盖

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
- 未完成：Browser E2E 使用 test-only runtime token，完整安装态 Desktop IPC 控制矩阵尚无证据；该项是 Batch A 的最高优先级，不单独触发一轮全量测试；
- 放行结论：保持 `agent_inline_plan_ui` 默认关闭，M3 与 P6 均不得进入 RC。

## 7. M4：第 19 节 Negative Capability Gate

### 7.1 定位

第 19 节不是“以后再做”的愿望清单，而是 0.5.0～0.9.0 必须持续满足的安全不变量。禁止能力不能通过任何 Feature Flag、环境变量、Prompt、网页、附件、项目文件或导入 Skill 开启。

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

### 7.4 最终集中验收的负向覆盖

以下集合是最终六命令矩阵中的强制项；Batch A、Batch B 开发过程中不逐项反复执行：

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

### 7.5 最终验收判定

- 七项禁止能力的直接和绕过测试全部为零成功；
- 手动终端仍能由真实用户在 UI 中使用；
- 不存在能开启禁止能力的任何 Flag；
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

- 状态：`集成中`；共享 `CapabilityRequest`/canonical `BudgetEnvelope` 契约、runtime `NegativeCapabilityPolicy`、Terminal main-process authorization、canonical 项目 scope 与 durable budget admission/recovery 已接入生产路径；
- 已拒绝：Agent 发起的多 Agent spawn/delegate、依赖安装、shell/terminal、运行内核修改/发布、无预算后台自治、跨项目写入和直接 `memory.confirm`。用户手动 terminal 与用户二次确认记忆走相互隔离的受控通道；未知 actor/capability 同样 fail closed，任何 Feature Flag 都不参与该策略；
- T1/T1b：`TerminalView` 不再自动创建 terminal。preload 只在专用控件的可信 pointer/keyboard event 发出内部 authorize IPC；main process 以 `webContentsId + BrowserWindow.id + renderer URL` 保存 1500ms 单次授权，并在 `terminal.create` 前原子消费。授权 token 不暴露给 renderer，导航与窗口关闭会撤销授权；
- T2a：`DocumentService` 的普通/内部读写、原子替换、move/archive/rollback 均复验 canonical realpath；`CommitJournal` 在 prepared、replace、recovery 时绑定 run UUID、strict manifest UUID 与 canonical root；runtime registry、身份注册表和路由对损坏、缺失或冲突 identity 均 fail closed，`PROJECT_SCOPE_*`/`PROJECT_IDENTITY_*` 返回 `409 + code`。项目 identity v2 将 OS `dev/ino` 持久化；v1/冲突/替换记录必须经显式项目打开后的 reconfirm，不能静默复用；
- T2b：每个新 durable run 在分配 ID/写库前由受信 profile 签发预算；request replay 比较 profile/limit/TTL fingerprint；legacy unbudgeted、过期或余额已尽的 run 不能 resume/retry/stale recover。step/replan 在同一事务内消费预算；每个物理模型请求均先 reserve、出网时标记 dispatched、按 provider usage settle，usage 缺失或出错时全额保守结算；恢复前 reconcile 未关闭 reservation。陈旧 `expected_version` 会先返回 `VERSION_CONFLICT`，不会因预算检查污染状态；
- 历史验证基线：根级 `npm run typecheck`、根级 `npm test` 的 99-file 首轮结果及受影响 `runtime.test.ts` 91/91 最小回归、`npm run test:e2e`（4/6 加确认用例 2/2，合并 6/6）、`npm run smoke:desktop`、`npm run eval:excluded-capabilities`（11 files / 104 tests）与 `git diff --check` 曾通过；这些结果不替代当前代码树的最终矩阵；
- 代码闭环：T2c Action confirmation receipt、活动期预算 reserve/settle/输出硬上限、跨重启 OS file identity，以及 draft/proposed/confirmed 持久化状态机、二次确认、治理 UI、投影/重建和 100 轮重启/项目隔离回放均已具备。P3 历史定向证据为 9 files / 178 tests；跨项目写入继续由 Negative Capability Gate 直接拒绝。M4 在最终集中验收前仍标记为“集成中”，不得进入 RC。

### 7.9 M4-T1：终端用户手势票据收口

#### 目标

保留用户手动终端，但使它与 Agent、模型内容、普通页面交互和历史手势彻底隔离。此任务只收紧已存在 terminal，不给 Agent 增加 shell 或代码执行能力。

#### 实施步骤

1. 已完成：`TerminalView` 不在 mount 时自动创建 terminal，改为专用“连接终端/重启终端”命令。
2. 已完成：该命令带稳定 `data-terminal-user-gesture`；仅当可信 pointer/keyboard event 的 `composedPath()` 命中标识，preload 才可发起内部授权。
3. 已完成：preload 本地票据和 main authorization 均为 1500ms、单次消费；main 绑定 window/webContents/renderer URL，导航和窗口关闭撤销。
4. 已完成：`terminal.create` 的主进程入口在 PTY 创建前原子消费授权；任何失败返回 `TERMINAL_USER_GESTURE_REQUIRED`，不创建 session、不执行命令。
5. 持续约束：Agent Action Registry、runtime HTTP 路由、模型 tool schema 和 Skill manifest 不暴露 `terminal.*`。

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

- 本项历史证据可以复用；若 Batch A/B 触及 terminal/preload/IPC/main authorization，仍不提前扩大测试，只在疑似 fail-open 时运行最小负向检查，正式证据统一由最终矩阵中的 `eval:excluded-capabilities`、Desktop smoke 和 `git diff --check` 生成；
- 若该门禁导致已有手动终端不可用，只能回滚到仍需要专用用户启动动作的上一实现；不得恢复 mount 自动启动、最近任意手势或 Agent shell。

### 7.10 M4-T2a：Canonical Project Write Scope

- 状态：`B1 已完成，M4 集成中`；物理路径、项目身份与确认回执已在真实文档/Journal 写入数据面生效；跨重启 identity 使用持久化 OS `dev/ino`，v1 或不一致记录需要显式 reconfirm；
- 已完成：最近存在祖先的 realpath 校验拒绝 `..`、绝对路径、file symlink、directory symlink/junction 和 atomic replace 后的链接替换；timeline、ledger、revision log、operation log 的读写同样受 guard 保护；
- 已完成：同一进程内 guard 同时固定 canonical path 与 OS `dev/ino`，项目根在相同 lexical path 被替换会返回 `PROJECT_SCOPE_ROOT_CHANGED` 且不写入；
- 已完成：identity registry 逐条严格解析、重复 UUID/canonical path 或损坏记录 fail closed；缺失 registry 不创建可写 runtime；v2 已持久化 OS `dev/ino` identity，v1/冲突/替换记录必须在显式项目打开后 reconfirm；
- 未完成：若未来解禁跨项目写入，仍须设计独立的确认 fingerprint 和用户授权交互，不能复用当前的普通 action receipt。

### 7.11 M4-T2b/T2c：预算与确认回执

- T2b 状态：已完成 B1。`ExecutionStore` v3 提供模型预算 reservation ledger；step/replan 与 budget 消费同事务，模型 stream/retry/fallback 的每个物理请求均走 reserve → dispatched → settle。可信 provider usage 用于精确结算，usage 缺失或异常时全额保守结算；输出上限按剩余 token budget 下调，恢复/重启前会 reconcile 未关闭 reservation；
- T2c 状态：已完成 B1。`ActionDescriptor.confirmation_policy=always` 在 handler 前消费持久化 receipt；批准后的文件操作复用已封存计划，不允许重新规划出不同副作用；E2E 同时断言确认状态和目标路径；
- T2c 使用单次 `approved -> consumed` CAS receipt，绑定 kind、run/step/attempt/action、project UUID/canonical root、target path、base version/hash、proposed hash、normalized input hash、scope fingerprint 与过期时间；receipt ID 只由 coordinator 注入可信 execution scope，不从 renderer/model args 读取；
- `cross_project_write` 与 `memory_confirmation` 可复用 receipt 存储和 CAS，但 verifier 必须按 kind 隔离，二者不得替代 generic action receipt。

## 8. M5：冻结 P3，批量收口 P4、P5

P3 的代码闭环作为当前实现基线冻结，不再拆出独立开发/验收轮次。Batch A 连续完成 P4a/P4b 与 P5 的所有生产路径、关闭回退和测试用例；可以按可回滚能力分提交，但提交之间不运行常规测试。P4a 不得假装消费 governed memory，P4b 不得绕过 P3 的 project/revision/confirmed 约束。

### 8.1 M5-P3 Governed Memory

#### 已形成的代码闭环

- `governed_memory.sqlite3` 持久化 claims、memory revision、confirmation receipts、overrides、outbox 与 projection status；确认回执绑定 project/claim/source revision/content hash，`approved -> consumed` CAS 只允许一次 `draft/proposed/planned -> confirmed`；`memory_v2=off` 时 runtime fail closed，不创建记忆写入；durable run 固化 `base_memory_revision`，任何记忆变更会 abort/pause 旧 revision 运行并拒绝其 resume；
- 当前历史定向证据覆盖 governed store、MemoryGovernor 兼容、runtime flag/restart、来源失效、anchor 重基准、结构化摘要、ChatRunner 消费、主进程 memory route、Workbench 治理、投影/重建及 100 轮重启/项目隔离回放，共 9 files / 178 tests。该结果只作基线，P3 在最终矩阵前仍为“集成中”。

- 使用手册 9.3 的完整 `NarrativeCoordinate/CanonClaim` 契约；
- 持久化 claims、overrides、memory revision、outbox 和 projection status；
- 结构化会话摘要替代最近消息拼接；已完成 project/conversation/revision/source-message 绑定的持久化数据面，并在 `memory_v2=on` 时由 ChatRunner 作为 `ContextBlock` 经 ContextAssembler 的统一预算/Trace 路径消费；聊天和技能型会话的新增记录都会确定性增量同步该投影，`off` 时零写入；
- 用户查看、纠正、遗忘、导出和重建入口；
- 项目 UUID 隔离、来源 revision 失效、旧 run revision 暂停；
- G19-7 的 proposed/confirmed 状态机。

当前进度：legacy chapter 坐标与稳定 `timelineId/anchorId/ordinal/timelineRevision/phase` 坐标已被严格区分；同一 timeline revision 内可比较 phase，跨 timeline 或 revision 会 fail closed。项目本地 anchor registry 可按稳定 anchor 原子重基准 story time/有效区间，缺失 target anchor 时整体拒绝。项目文档保存、归档与时间线回滚会失效同路径旧来源 claim。Workbench 已提供查看、二次确认、纠正、遗忘、导出和投影重建；`canon_markdown` 与 `vector_graph` 仅在同一 memory revision 重建成功后进入 `ready`，失败可见且不会作为当前投影消费。

#### 生产接线

- `memory_v2=on` 时 runtime 真实读写 governed memory；已完成 claims、确认、遗忘、纠正/撤销 override、导出 API，项目 ID 仅从 manifest 推导；
- `off` 时不创建新 governed memory 写入；
- 生产 runtime 不使用进程内 `MemoryGovernor` Map；保留它只作旧契约兼容与纯内存单测；
- 图谱、向量和会话摘要已经绑定同一 revision。`governed_memory_projection_status` 将 `canon_markdown` 与 `vector_graph` 绑定到 memory revision；revision 推进会使投影变为 `pending`，显式重建成功后才标记 `ready`。

#### 最终集中验收覆盖

- 100 轮会话回放；
- 重启、纠正、撤销、重建不复活旧值；
- 同名人物跨项目零召回；
- 时间区间和 perspective fixture；
- draft 未二次确认不能进入 confirmed。

### 8.2 M5-P4 Token Context

#### Batch A 必须补齐

- tokenizer 由 Model Gateway 按实际模型提供；
- `ContextBlock` 统一使用 shared schema；
- 所有相关 chat prompt、skill prompt 和 save/revision prompt 在生产 ContextAssembler 前统一调用 `ContextScheduler`，不得只覆盖 ChatRunner 的单一路径；
- P4b 消费 canon、perspective、story time 和 memory revision；
- Trace 记录 included/excluded reason、estimated/used token 和 selector version；
- untrusted source 的 `allow_instruction=false` 由应用设置，调用者不能伪造。

#### 最终集中验收覆盖

- 不同模型得到不同预算；
- JSON/Markdown/正文裁剪不破坏语义边界；
- context precision/recall、引用正确率、遗漏率和截断伤害率有版本化报告；
- `context_budget_v2=off` 明确回退旧 ContextAssembler；`memory_context_selector_v2=off` 只关闭 P4b governed-memory 选择，不影响 P3 数据或 P4a token 预算。

### 8.3 M5-P5 Quality Gate

#### Batch A 必须补齐

- Evaluator 输出完全符合 shared `QualityReport`；
- 所有 project document、skill 和生成产物保存入口统一在 journal/file 副作用前执行 artifact policy，不得只覆盖 generated cache；
- hard gate 与 subjective issue 分离；
- 文风、节奏和措辞默认只建议，不自动 revise；
- evidence 为空的模型问题不能阻断；
- feedback 只能生成候选，用户确认后才形成 preference/rubric 版本；draft feedback 不得直接固化；
- apply/revert 与 eval manifest 绑定。
- hard gate 拒绝必须返回稳定 code 和可追溯 `QualityReport`，且不创建 journal、commit run 或文件副作用；
- `quality_gate_v2=off` 明确回退旧保存检查路径，不删除既有报告或改变 P3 memory 状态。

#### 最终集中验收覆盖

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

## 9. M6：Batch B 建立 P7 可复现证据机制

### 9.1 目标

先把 `eval:*` 从单测别名升级为可复现、可比较、可审计的证据机制。Batch B 负责 Manifest、固定输入与 CI artifact，不以赶进度为由伪造样本或降低 RC 数据门槛。

### 9.2 数据集最低规模

以下规模沿用上位手册 13.1，是进入 M7 RC 前必须达到的门槛，不要求为完成 Batch B 的机制接线而临时制造数据：

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
manifest_schema_version
dataset_version / dataset_hash
fixture_hashes / case_id / case_hash
code_commit
command / runner / operating_system
model_provider / model_id / capabilities
prompt_hash / skill_versions / rubric_versions
temperature / top_p / seed / seed_policy
started_at / duration
token_usage / estimated_cost
pass_rate / failure_cases
```

Manifest 必须保存 case 级结果，不能只有总通过率。无法固定模型随机种子时，必须记录 provider 限制并用固定输入、fixture hash、重复次数和统计协议约束波动，禁止伪报 deterministic。

### 9.4 CI 接线

以下 workflow 显式运行六个现有 eval 和 `eval:excluded-capabilities`：

- `.github/workflows/windows-pr-ci.yml`
- `.github/workflows/desktop-rc.yml`
- `.github/workflows/release.yml`

workflow 使用 `if: always()`（或等价的不可跳过条件）上传以下内容，即使 eval 失败也必须产出诊断 artifact：

- Eval Manifest；
- 失败 case 摘要；
- 脱敏 Trace；
- 性能基线；
- 安全/恢复累计次数；
- 人工校准结果引用。

Batch B 先登记现有 fixture 的完整清单和 hash；达到第 9.2 节最低规模、sealed holdout 与人工校准仍是后续 RC 门槛，不得在文档中提前勾选。

### 9.5 Batch B Definition of Ready

- Manifest schema/version、固定 seed policy、case/fixture hash、command 与 commit 字段已接入；
- CI 在成功和失败路径都上传 case 级摘要、脱敏 Trace 与 Manifest；
- 安全、恢复、跨项目隔离退化能阻断 workflow，artifact 上传步骤仍执行；
- 失败 case 不泄露 API key、私有稿件或完整敏感 prompt；
- 代码、workflow、fixture 清单、回滚和文档全部完成后直接进入最终集中验收，不单独运行 Batch B 测试。

### 9.6 建议提交

```text
test(agent): build reproducible eval manifests and release gates
```

## 10. M7：RC 与生产候选验收

第 2.2 节的六命令矩阵只关闭本轮开发闭环，不等于 M7 RC。即使矩阵全绿，缺少第 9.2 节数据规模、clean install/build、installed-build、签名、升级/回滚、soak 或人工校准时，状态仍不得提升为 `RC 候选` 或“可投产”。

### 10.1 前置条件

只有 M0～M6 全部完成，才能进入 M7。

### 10.2 RC 一次性自动门禁

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
- [x] M4-T1 的 terminal ticket 只可由专用、一次性的用户启动动作签发，且 source smoke 负向与正向路径均通过。
- [x] 所有 `confirmation_policy=always` Action 在副作用前原子消费精确 scope receipt；批准后不重新规划出不同副作用。
- [x] 每个活动 run 对 step/replan/model 调用执行原子预算 reserve/settle，耗尽后可恢复地 paused；provider usage 缺失时保守全额结算。
- [x] 项目 identity 在跨桌面重启后仍能识别同路径替换，旧 v1 registry 需要显式重新确认。

## 12. 实施记录模板

Batch A 与 Batch B 全部完成并结束最终集中验收后，才在 `docs/PROJECT_MAINTENANCE_HANDOFF.md` 追加一条合并记录；两个开发批次不分别追加验收记录：

```markdown
### YYYY-MM-DD Batch A + Batch B 集中验收

- 状态：未开始 / 原型完成 / 集成中 / RC 候选 / 完成
- 生产路径：
- 修改文件：
- Flag 开启行为：
- Flag 关闭行为：
- 数据迁移：
- 回滚方法：
- Batch A 影响范围：
- Batch B 影响范围：
- 中途例外检查（没有则写“无”）：
- 首次集中矩阵：
- 失败项与定向重跑（没有则写“无”）：
- 修复后的完整矩阵最终复跑：
- RC 未完成项：
- 复用的同 commit 证据：
- 未完成项：
- Git commit：
```

记录必须明确未完成项。禁止只写“全绿”“圆满完成”而不列出实际命令、范围和发布证据；禁止为同一批次的每个小改动重复记录根级测试。

## 13. 2026-07-13 集中验收结果

Batch A 与 Batch B 已完成。首次最终矩阵的 `eval:excluded-capabilities` 因 Windows 上以 `shell: false` 启动 `npx.cmd` 发生 `spawn EINVAL`；运行器改为由当前 Node 启动锁定的 Vitest 入口并捕获同步 spawn 异常，定向 eval 通过后完整矩阵复跑。

- `npm run typecheck`：通过；
- `npm test`：103 files / 836 tests 通过；
- `npm run test:e2e`：6/6 通过；
- `npm run smoke:desktop`：通过（Electron 42.3.0、node-pty、node:sqlite）；
- `npm run eval:excluded-capabilities`：110/110 通过，manifest 的 pass rate 为 1；
- `git diff --check`：通过，只有 CRLF 转换预警。

本记录只关闭本轮开发闭环。M7 的数据集规模、sealed holdout、clean install/build、installed-build、签名、升级/回滚、soak、人工校准和发布证据均未完成，状态不得升级为 RC 候选或完成。
