# ArcWriter Agent 智能化优化实施手册

> 状态：现行方案
>
> 审阅日期：2026-07-10
>
> 软件基线：ArcWriter 0.4.0
>
> 代码基线：`af6d778` 及其之前的 `v0.4.0` 发布代码
>
> 方案修订：2026-07-10 第四次实现校准与发布门禁审查
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

### 1.1 ArcWriter 0.4.0 已提交基线定位

ArcWriter 0.4.0 已经不是简单聊天壳。该已提交基线的主链路已经具备：

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

ArcWriter 0.4.0 基线可以定义为：

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

这组结果只代表 0.4.0 代码基线，不代表当前未提交 P0 工作树。当前实现验证状态以 15.0 台账为准；Workbench 草稿类型检查未通过时必须先恢复绿色基线，再继续扩展 P0。

### 1.3 ArcWriter 0.4.0 基线智能化成熟度

| 维度 | 0.4.0 基线水平 | 主要依据 |
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

### 1.4 第三次审查后的冻结决策

第二次审查已经覆盖安全、并发、数据治理和可访问性，但实施前仍有几处会导致 P0 返工的边界没有冻结。本次修订把以下决策设为后续实现基线：

1. 一个用户请求只生成一个权威 `run_id`。同步响应、流式事件、Execution Store、Agent Trace 和会话消息必须引用同一 ID；恢复和步骤重试不得创建第二个 run。
2. Execution Store 固定为项目内 `00_设定集/.agent/agent_runs.sqlite3`，与向量数据库、桌面全局状态库分离；`agent-runtime` 依赖最小 SQLite adapter，不绑定单一驱动。
3. `AgentStepAttempt` 是一级持久实体。步骤上的 `attempts` 只作为汇总，模型调用、Observation、错误、输入摘要和副作用结果必须归属具体 attempt。
4. 崩溃恢复以 runtime instance lease 和 heartbeat 判定，不在启动时无条件暂停所有 `running` run；Windows 休眠、重复启动和旧进程残留必须可区分。
5. SQLite 与项目文件无法组成真正的 ACID 事务。所有文件副作用使用 commit journal、临时文件、原子替换和启动对账，禁止用“逻辑事务”掩盖崩溃窗口。
6. 现有 `JobManager` 与 Agent Run 不形成两个事实源。P0 明确兼容桥：Agent 长任务以 Execution Store 为权威，旧爬取/非 Agent job 暂时保留，映射关系必须可查询。
7. P0 先完成“创建 -> 执行 -> 中断 -> 恢复 -> 完成”的最小垂直闭环，再扩展确认、事件、清理和高级 UI，避免只落 schema 而没有可运行链路。
8. 智能化不等于无条件自治。Goal Builder 必须区分可安全推断的假设与会改变产物/写入目标的阻塞歧义，并按协作模式决定直接执行、先展示计划或请求确认。
9. 版本路线按可发布能力拆分：`0.5.0` 只交付持久执行内核；Model Gateway 和闭环规划进入 `0.6.0`，后续阶段依次发布，不把 P0-P2 压在一个版本中。

除非实施中出现经过测试证明的新约束，上述决策不再在单个任务内临时改变。需要调整时先更新本文和迁移影响，再修改代码。

### 1.5 第四次审查后的实现校准

第三次审查冻结了总体架构，本次审查不推翻 P0-P7，而是根据 P0 实际落地、当前 CI/安装包能力和三路独立审查修正可执行性。以下内容覆盖本文中与之冲突的旧表述：

1. P0 根步骤必须正式支持 `chat` 和 `file_operation`，Artifact 必须支持 `chat_answer`；这些不是 P2 才新增的类型，而是把现有聊天和文件操作接入持久生命周期所需的兼容契约。
2. 协作式暂停不是失败。活动 attempt 在检查点暂停时进入 `interrupted`，不消耗失败重试预算；恢复事务把 step 从 `running` CAS 回 `pending`，run 保持 `paused`。提交日志异常不新增 `recovery_required` run 状态，统一表示为 `paused + RECOVERY_REQUIRED` 稳定错误码。
3. HTTP/NDJSON 连接只是执行结果和事件的订阅通道。renderer reload、页面切换或订阅断开不得隐式 pause/cancel；只有带 `operation_id` 的显式控制 API 能改变 run。
4. 接管 stale run 时必须在同一恢复事务中结算孤儿 attempt、修正当前 step 并记录恢复事件；只把 run 改成 `paused` 而保留 `running` step/attempt 不算可恢复。
5. `settings_snapshot` 不允许保存任意对象。恢复请求使用版本化、字段白名单的 `AgentRecoverableRequest`；每次模型 attempt 另存实际出站数据分类、provider、policy/consent receipt 和脱敏摘要。
6. P0 的安全边界不仅是 Origin。除精确限定的 health endpoint 外，runtime API 必须使用每次进程启动轮换的桌面会话令牌；Host、Origin、IPC sender、Electron 导航、权限请求和高权限 terminal IPC 一并纳入门禁。
7. 当前仓库只有 tag release workflow，尚不能声称 CI、installed-build smoke 或发布阻断已经存在。P0 必须先交付可运行脚本、Windows CI、RC 证据和不可绕过的 release 依赖，再满足 0.5.0 发布条件。
8. 评估从现在开始作为持续工程轨道 G0 建设，P7 只负责统一自动化和发布收口。没有合规 beta channel 和 opt-in 数据时，不使用虚构的 100/500 用户 run 作为发布证据。
9. 0.7.0 内部顺序调整为 `P4a token/语义分块基础 -> P3 时序化 canon 与治理记忆 -> P4b memory-aware 选择`，避免先验收记忆召回、后补上下文预算。
10. P3 增加带叙事时间、有效区间、视角和来源版本的 `CanonClaim`。系统必须区分客观事实、角色认知、计划事实和不同剧情时间段，不能把正常剧情演变误判成冲突。
11. “可持续学习”必须形成 `反馈聚合 -> 偏好候选 -> 用户确认 -> 版本化应用 -> 回归评估 -> 可撤销` 闭环；只记录接受/拒绝标签不能宣称系统已经学习。
12. 每个阶段的完成由退出条件决定，不由参考人日决定。任何标记为“代码已存在”的任务，在类型检查、构建、集成/E2E 和对应故障测试通过前仍属于未验收实现。
13. `project_id` 从 P0 起使用项目 manifest 中的稳定 UUID，不使用 canonical path hash 作为永久身份。项目移动后 run 仍可查询；`project_path` 只是可更新的定位/审计字段。P3 在此基础上增加项目复制身份和 canon scope 交互。

当前 P0 草稿已经证明 schema/store/coordinator 路径可行，但仍存在恢复、暂停、确认、commit journal 接线、认证、Workbench 构建和发布基础设施缺口。因此本次审查结论是：**计划方向完善，P0 尚未完成，也不具备 0.5.0 发布条件。**

## 2. 关键问题与优先级

本节使用 `S0/S1/S2` 表示问题严重级别，避免与后文实施阶段 `P0-P7` 混淆。`S0` 是可靠闭环前置，`S1` 是智能质量核心，`S2` 是产品化与规模化门槛。

### 2.1 S0（阶段 P0）：执行状态不持久

ArcWriter 0.4.0 已提交基线的 `AgentRuntimeService.runSkillPlan()` 在内存中串行执行步骤。任一步失败后直接返回错误结果，没有检查点、恢复位置和幂等控制；当前未提交 P0 草稿进度见 15.0，不用本段判断其完成状态。

`JobManager` 同样使用内存 `Map` 保存任务。软件退出、runtime 重启或系统崩溃后，任务状态和中间结果会丢失。

直接影响：

- 长拆书、批量正文和多技能任务无法可靠续跑；
- 用户无法只重试失败步骤；
- 重试可能重复写入已经完成的产物；
- Trace 能看到发生了什么，但不能恢复执行。

### 2.2 S0（阶段 P1）：模型网关缺少生产级治理

当前模型客户端主要处理流式调用和“不支持流式时退回非流式”。尚未统一支持：

- 429/502/503 指数退避；
- JSON Schema 结构化输出；
- 无效 JSON 修复；
- 模型能力声明；
- token、费用、首字延迟和重试统计；
- 请求幂等键；
- 基于任务类型的主副模型选择。

Planner、保存规划器和技能调度器仍需自行从字符串提取 JSON，导致每个模块重复处理模型不稳定性。

### 2.3 S0（阶段 P2）：规划不是闭环

当前 SmartSkillOrchestrator 只输出最多 4 个技能步骤。步骤没有显式的：

- 前置条件；
- 输入来源；
- 预期产物；
- 验证方法；
- 重试策略；
- 失败后的替代步骤；
- 停止条件。

执行完成后不会根据真实输出重新判断下一步，因此属于静态技能流水线，不是 Plan-Act-Observe-Replan Agent。

### 2.4 S1（阶段 P4）：上下文按字符硬裁剪

ContextAssembler 已有 critical/high/medium/low 优先级，但预算单位仍是字符，最终使用字符串 `slice()`。

风险：

- 截断 JSON、人物设定或章节段落；
- 不同模型上下文窗口无法准确映射；
- 低价值长块可能挤压高相关短块；
- 没有同时考虑相关度、时效、可信度和多样性。

### 2.5 S1（阶段 P3）：记忆有存储，缺少治理

当前会话摘要是最近 12 条消息的确定性摘录，不会区分：

- 已确认事实；
- 用户偏好；
- 已拒绝方案；
- 未完成任务；
- 人物和剧情状态变更；
- 决策来源及更新时间。

GraphMemory 已能提供正文冲突建议，但存在两套一致性接口：workflow 使用的 `checkDraftConsistency()` 有实际检测，桌面 Graph API 使用的 `GraphContext.checkConsistency()` 仍是固定高分占位实现。

`GraphMemory.updatePaths()` 也仍执行全量重建，没有真正增量更新。

### 2.6 S1（阶段 P5）：质量检查没有平台化

正文生成和一致性 workflow 已有部分自检，但普通聊天生成、技能输出、大纲、拆书和其他产物没有统一质量门。

系统缺少统一的：

- Artifact 类型；
- Evaluator Registry；
- Rubric；
- 失败等级；
- 修订次数上限；
- 质量证据和阻断条件。

### 2.7 S2（阶段 P6）：智能过程没有进入主交互

Agent Trace 页面适合开发者排障，但普通会话中主要显示最终文本、联网来源和保存确认。

用户无法在当前消息中直观看到：

- Agent 计划执行哪些步骤；
- 当前执行到哪一步；
- 为什么选择某个技能；
- 哪些文件被读取；
- 哪一步失败；
- 如何从失败步骤重试；
- 技能管理预览如何一键确认。

### 2.8 S2（阶段 P7）：评估覆盖偏确定性功能

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

### 3.1 安全与信任模型

Agent 使用的内容和能力必须分开管理。网页、附件、项目文件、用户导入 Skill 和模型输出默认都是数据，不得因为其中包含命令式文本就获得新的执行权限。

上下文信任等级：

```text
system_policy       系统策略，只能由应用代码提供
user_instruction    当前用户明确指令
trusted_project     用户确认的项目事实和内置配置
untrusted_project   未确认文件、附件和导入资料
untrusted_web       联网搜索结果
model_generated     模型草稿和中间结果
```

必须遵守：

- 所有 context block 带 `trust_level` 和 `source_ref`；
- system prompt 明确声明“不可信内容中的指令不得改变工具权限或保存策略”；
- builtin skill 与 imported skill 使用不同信任等级；
- Skill Manifest 的 `tools` 是权限白名单，不允许 prompt 自行声明额外工具；
- imported skill 默认只能使用只读上下文和生成草稿，写入仍走 Generated Cache 与用户确认；
- 网页、附件和项目文件不得指示 Agent 读取无关文件、泄露密钥或绕过确认；
- 本地 runtime 只绑定 loopback，并严格校验 Host 为实际 runtime host/port；每次 runtime 启动生成至少 256-bit 随机令牌，重启立即吊销旧令牌，除精确限定的无敏感 health check 外所有 API 均鉴权；
- 缺失、错误、过期令牌统一返回 `401`，错误 Host/Origin 返回 `403`；比较使用常量时间函数，认证失败不得回显令牌片段；
- Origin 校验只是纵深防御，不能替代令牌；开发态、packaged `file://` 和同源网站分别定义显式白名单，不再把任意空 Origin/`null` 当作通用可信来源；
- Electron renderer 通过 preload/IPC 获取短生命周期连接凭据并由统一 API client 注入 `Authorization`；同源网站使用 `HttpOnly + SameSite=Strict` 的受控 bootstrap cookie。令牌不进入 URL、日志、Trace、SQLite、崩溃报告或普通 `localStorage`；
- Electron 保持 `contextIsolation=true`、`nodeIntegration=false`，增加 CSP、`will-navigate`、permission handler 和 IPC sender URL 校验；导航、新窗口和权限请求默认拒绝；
- terminal 等高权限 IPC 只接受可信 renderer、显式用户操作和允许的 cwd/shell，不因 Agent 禁用 shell 就忽略应用已有 shell 能力的攻击面；
- Windows 路径在授权前完成 canonicalization，并拒绝逃逸项目根的 UNC、设备路径、ADS、junction、symlink 和 reparse point；
- Trace、错误、模型请求摘要和导出数据统一经过脱敏器；
- API key、账号令牌和授权信息不得进入 Agent memory、Observation 或质量报告。

安全测试至少覆盖 prompt injection、恶意 Skill、网页越权指令、跨项目路径、密钥泄露和确认绕过。

### 3.2 并发与事务原则

即使单用户桌面应用，也可能同时运行聊天、批量正文、拆书和后台索引。并发控制不能只依赖 Planner 提前发现冲突。

所有写入 Action 必须携带：

```text
target_path
base_content_hash
base_document_version
idempotency_key
write_mode
run_id / step_id / attempt
```

执行要求：

- DocumentService 为项目文档维护单调递增版本或等价内容 hash；
- 提交前执行乐观锁检查，版本不一致时进入 `waiting_confirmation` 或重新规划；
- 同一路径写入使用短期 write lease，lease 必须可超时释放；
- 多文件写入先完成全部校验，再按确定顺序提交；
- 部分提交失败时记录已提交路径并生成补偿/人工恢复计划；
- Generated Cache、时间线快照、文档版本和 SQLite 状态通过可恢复 commit journal 协调；不得宣称跨文件系统与 SQLite 的原子事务；
- 禁止两个 run 静默覆盖同一版本文档；
- 云同步或外部编辑造成的文件变化按并发冲突处理。

### 3.3 数据生命周期与本地优先

新增 Agent 数据必须有明确保留、导出和清理策略：

- SQLite 使用 `schema_version` 和顺序 migration registry；
- migration 前创建可恢复备份，失败后自动回到旧 schema；
- run metadata 默认长期保留，模型中间文本和临时 artifact 使用可配置保留期；
- Trace、Observation、Generated Cache 和网页摘录设置磁盘上限与清理优先级；
- 用户可以导出、删除运行记录，并逐条查看、修正或遗忘长期记忆；
- 所有数据库、向量、图谱和记忆按规范化 project root 隔离；
- 默认不向云模型发送未被当前任务选中的项目内容；
- 每次联网或云模型 attempt 在 Trace 中记录 provider、发送数据类型、字段/内容 hash、policy/consent receipt 和脱敏摘要，不记录敏感全文；replan 后新增的出站内容必须重新评估，不能只复用 run 创建时的披露快照；
- 数据库损坏时进入隔离恢复模式；schema 兼容时可只读导出，否则保留原库并使用通用恢复工具，不自动删除 `.agent` 数据。

默认不启用业务遥测。Sentry 或其他崩溃报告必须显式 opt-in，并使用字段白名单；prompt、正文、完整文件路径、用户名、令牌和 API key 永不外发。关闭遥测时不得创建网络请求或离线遥测队列。

### 3.4 可访问性与产品约束

- 正文始终是写作状态下的视觉主角；
- Agent 计划、预算和技术细节默认折叠，按需渐进披露；
- 以 WCAG 2.2 AA 为最低标准；
- 所有 Agent 操作支持键盘、清晰焦点和屏幕阅读器状态播报；
- 状态不能只通过颜色表达；
- 动效可关闭，并尊重系统减少动态效果设置；
- 小屏、缩放和常见 Windows 中文字体环境下不得发生遮挡或溢出。

### 3.5 智能协作与主动性边界

Agent 提供三种协作模式，并把模式快照固化到 run：

```text
assist    单步协助；生成建议或草稿，不展开长计划
plan      先展示可检查计划，用户确认后执行有成本或有副作用的步骤
execute   在权限、预算和确认策略内连续执行；遇到阻塞条件暂停
```

默认使用 `plan`。Skill 可以建议模式，但不能提高用户选定的自治级别。

Goal Builder 对缺失信息分类：

- **阻塞歧义**：不同答案会改变项目、输入来源、产物类型、覆盖路径、隐私边界或显著成本，必须询问；
- **可恢复假设**：可以从当前项目和最近上下文可靠推断，记录假设后继续；
- **偏好缺失**：使用项目默认值，并允许用户在计划卡中修改；
- **不可用能力**：直接说明限制并给出受支持替代，不生成伪计划。

同一轮只询问完成任务所需的最少阻塞问题，不把开放式访谈当作智能。执行前在计划中显示关键假设；用户修改目标时生成新的 goal revision 和 `plan_version`，保留旧版本审计记录。

主动建议只基于用户当前打开的项目和确定性健康信号，例如缺失设定、章节号断档、未处理冲突或失败任务。默认不在后台调用云模型，不自动写文件，也不因为建议被忽略而重复打扰。用户的接受、拒绝、纠正和质量覆盖可记录为本地反馈标签，用于 eval 与 rubric 校准，但不得未经同意用于外部训练。

### 3.6 产品结果与持续评估轨道 G0

“更智能”必须表现为作者完成任务的结果改善，而不只是新增更多 Agent 组件。G0 从 P0 开始并行维护以下端到端基线：

- 任务一次完成率和最终完成率；
- 可用初稿率、直接采用率、编辑后采用率和丢弃率；
- 产物保留比例或归一化编辑距离；
- 每个任务的阻塞提问数、人工介入数、重试/重规划数和完成时间；
- 项目事实/引用正确率、上下文 precision/recall、错误 canon 冲突率；
- 每个成功任务的 token、估算成本和首字/完成延迟；
- 未确认写入、重复副作用、跨项目访问和敏感数据外发次数。

G0 交付物包括版本化任务集、旧版对照结果、判分器、脱敏 Eval Manifest 和关键交互原型。作者私稿默认不进入共享 eval；本地评估无需业务遥测，任何跨设备聚合都必须显式 opt-in、字段白名单、可查看和可删除。

产品指标用于判断新系统是否比 0.4.0 更好，不取代安全硬门禁。安全、恢复和数据隔离必须保持零容忍；主观写作质量使用同题材配对评审或用户真实采用行为，不用模型自评分证明提升。

G0 的最终版本通过规则预先固定：至少 50 个端到端配对任务，配额为写作/修订 20、规划 10、引用/canon 10、严格格式/Skill 5、恢复/控制 5；任务失败计为未完成、首个产物不可用、全部预期引用错误，耗时按预注册 timeout 上限计。相对 0.4.0 的最终完成率非劣界为 `-3` 个百分点；引用正确率以引用/canon 任务中版本化 gold claim 为分母，缺失/错误引用均计错，非劣界为 `-2` 个百分点。

三个改善指标在查看 sealed 结果前全部预注册：可用首个产物率 `+10` 个百分点、每任务人工介入中位数 `-20%`、任务完成时间中位数 `-15%`。人工介入仅统计 fixture schema 中的阻塞回答、手动重试、计划修改和错误恢复操作。对配对差异执行固定 seed 的 10,000 次分层 bootstrap，并对三个改善假设使用 Holm-Bonferroni 控制单侧 family-wise alpha=0.05；完成率/引用正确率 CI 满足非劣界且至少一个经校正改善假设的 CI 达到预设效应量，才允许宣称结果改善。安全/隔离指标仍要求 0 次，不参与非劣判定。样本不足时只报告探索结果，不宣称完成“更智能”目标。

## 4. 目标架构

```text
User Request
  -> Intent Gateway
  -> Goal Builder
  -> Planner
  -> Durable Run Store
  -> Run Coordinator
  -> Agent Loop
       -> Action Registry
       -> Observation
       -> Verifier
       -> Replan or Finish
  -> Quality Gate
  -> Save Policy / Confirmation
  -> Commit Coordinator
  -> Memory Commit
  -> Trace + Metrics
```

建议目标目录：

```text
packages/agent-runtime/src/
  kernel/
    agent-engine.ts
    run-coordinator.ts
    run-recovery.ts
    run-context.ts
    execution-store.ts
    execution-store-port.ts
    execution-state-machine.ts
    commit-journal.ts
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

### 4.1 阶段依赖、最小 UI 与非目标

| 阶段 | 前置/并行轨道 | 本阶段必须可见的最小交互 | 本阶段非目标 | 退出条件摘要 |
| --- | --- | --- | --- | --- |
| P0 | G0 恢复/安全基线 | 持久任务列表、状态、恢复、暂停、取消 | 不做自动重规划或长期记忆 | 同 ID 强杀恢复、幂等写入、认证和安装包门禁通过 |
| P1 | P0 | provider/费用/错误的渐进披露 | 不宣称提升写作质量 | 旧调用行为等价，路由、用量、隐私和降级可审计 |
| P2 | P1、G0 任务集 | 计划草稿、批准、进度和阻塞问题 | 不宣称已具备完整语义质量门或长期记忆 | Plan-Act-Observe-Replan 在预算和权限内闭环 |
| P4a | P1 | 上下文来源、包含/排除原因和预算 | 不做长期事实治理 | tokenizer、语义分块和引用基线通过 |
| P3 | P4a、P2 | 记忆查看、纠正、冲突和遗忘 | 不把模型草稿直接变成 confirmed canon | 时序 canon、override、隔离和重建不复活旧事实 |
| P4b | P3 | memory-aware 选择解释 | 不扩大云发送范围 | 叙事时间过滤、来源配额、去重和大型项目 eval 通过 |
| P5 | P2、P3/P4b | 原稿/修订对比、证据、覆盖和成本 | 不允许主观评分未经授权自动改稿 | 分级质量门、反馈提升闭环和 artifact eval 通过 |
| P6 | 前序阶段最小 UI | UX 汇总、可用性、无障碍和任务收件箱 | 不首次发明前序核心语义 | 核心工作流可用性和 WCAG 2.2 AA 门禁通过 |
| P7 | G0 持续结果、P0-P6 阶段门禁 | Eval/发布报告 | 不补做前序阶段缺失测试 | 自动化、趋势、RC、安装升级/回滚证据完整 |

阶段 UI 采用“语义随能力交付、P6 统一硬化”的原则。计划批准与文件写入确认是两个不同授权：批准计划只授权执行计划中的无副作用/有成本步骤，实际写入仍绑定 action、路径、版本和 hash；UI 可以合并展示，但不得合并安全语义。

## 5. 核心数据契约

### 5.1 Agent Run

在 `packages/shared/src/schemas/agent.ts` 新增兼容 schema：

```ts
type AgentRunState = {
  schema_version: number;
  version: number;
  run_id: string;
  request_id: string;
  conversation_id: string;
  project_id: string;
  project_path: string;
  goal: AgentGoal;
  goal_revision: number;
  plan_version: number;
  plan_status: "draft" | "approved" | "superseded";
  preference_version: string;
  rubric_versions: Record<string, string>;
  router_version: string;
  status:
    | "queued"
    | "planning"
    | "running"
    | "waiting_user_input"
    | "cancelling"
    | "waiting_confirmation"
    | "paused"
    | "failed"
    | "cancelled"
    | "completed";
  current_step_id: string;
  runtime_instance_id: string;
  heartbeat_at: string;
  lease_expires_at: string;
  pause_requested_at: string;
  cancel_requested_at: string;
  recovery_reason: string;
  error_code: string;
  error: string;
  steps: AgentExecutionStep[];
  artifacts: AgentArtifactRef[];
  budget: AgentRunBudget;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
};
```

`AgentGoal` 必须是可恢复输入契约，而不只是聊天文本：

```ts
type AgentGoal = {
  instruction: string;
  autonomy_mode: "assist" | "plan" | "execute";
  requested_outputs: AgentExpectedOutput[];
  success_criteria: string[];
  assumptions: string[];
  blocking_questions: string[];
  request_snapshot: {
    schema_version: number;
    content: string;
    attachment_refs: string[];
    selected_file_refs: string[];
    recoverable_request: AgentRecoverableRequest;
    settings_snapshot: AgentSettingsSnapshot;
    feature_flag_snapshot: AgentFeatureFlagSnapshot;
  };
};

type AgentRecoverableRequest = {
  schema_version: 1;
  conversation_id: string;
  current_path: string;
  selection: string;
  project_context_hint: string;
  skill_id: string;
  reference_paths: string[];
  confirmed_reference_paths: string[];
  disable_auto_references: boolean;
};

type AgentSettingsSnapshot = {
  schema_version: 1;
  model_profile_id: string;
  context_budget_profile: string;
  save_policy: "preview_only" | "confirm_write";
  locale: string;
};

type AgentFeatureFlagSnapshot = {
  schema_version: 1;
  agent_execution_v2_mode: "off" | "shadow" | "on";
  model_gateway_v2: boolean;
  agent_replanning_v2: boolean;
  context_budget_v2: boolean;
  memory_v2: boolean;
  memory_context_selector_v2: boolean;
  quality_gate_v2: boolean;
  agent_event_stream_v2: boolean;
  agent_inline_plan_ui: boolean;
};
```

上述三种 snapshot 都是 shared 中的严格 zod schema，使用 `.strict()` 而不是 `.passthrough()`。P0 就声明完整路线中的已知 flag，尚未交付的能力固定为 `false`；新增 flag 必须提升 snapshot schema version 并提供 `vN -> vN+1` migration/default，不能依赖读取进程的当前默认值。`content` 最大 256 KiB，`selection` 最大 120 KiB，hint 最大 8 KiB，单条路径最大 1,024 字符，每个引用数组最多 100 项，整个序列化 snapshot 最大 512 KiB；超限内容先进入受控 artifact/cache，再保存引用。读取旧 schema 通过显式 migration registry，未知版本拒绝自动恢复并进入 `paused + REQUEST_SNAPSHOT_UNSUPPORTED`。禁止把任意 `AgentRunRequest`、API key、Authorization、供应商 secret 或完整附件塞进 `Record<string, unknown>` 后依靠字段名正则脱敏。

`project_id` 是项目 manifest 创建并持久化的稳定 UUID；首次打开旧项目时生成一次并原子保存。`project_path` 记录 run 创建/最近恢复时的规范化路径，但不参与永久身份或跨库主键。项目移动后通过 UUID 重新关联；检测到两个路径共享同一 UUID 时先按“同一项目副本”隔离写入并提示用户，P3 再提供复制为新项目的完整身份迁移。

`preference_version/rubric_versions/router_version` 在对应能力未启用时使用明确的内置基线版本（例如 `builtin:0.4.0`），不能留空后读取“当前最新版”。P5 运行时固化实际版本，恢复/replay 继续使用原版本或显式生成新 goal/plan revision。

Intent Gateway 还需产出可审计的解析结果：

```ts
type IntentResolution = {
  intent: string;
  confidence: number;
  explicit_constraints: string[];
  ambiguities: Array<{
    code: string;
    impact: "safe_assumption" | "blocking";
    question: string;
  }>;
  allowed_effects: Array<"suggest" | "read" | "draft" | "network" | "write">;
  proactive_level: "off" | "quiet" | "normal";
};
```

存在 blocking ambiguity 时 run 进入 `waiting_user_input`，不得启动有成本或有副作用的步骤。用户回答后增加 goal revision；安全假设直接写入 `assumptions`，不额外打断。

`request_snapshot` 只保存恢复所需的文本和受控引用，不复制附件全文、API key 或不相关项目内容。写入前执行 schema allowlist 和大小上限校验，读取时按 schema version 迁移。run 恢复时使用原始 snapshot 和同一个 `run_id`；只有用户明确修改目标才增加 `goal_revision` 和 `plan_version`。

### 5.2 执行步骤

```ts
type AgentExecutionStep = {
  step_id: string;
  version: number;
  index: number;
  type: "read" | "skill" | "workflow" | "web_search" | "verify" | "save_preview" | "chat" | "file_operation";
  action_id: string;
  skill_id: string;
  instruction: string;
  necessity: "required" | "optional";
  input_refs: string[];
  required_permissions: string[];
  base_document_versions: Record<string, number>;
  base_content_hashes: Record<string, string>;
  idempotency_key: string;
  expected_output: AgentExpectedOutput;
  status: "pending" | "running" | "waiting_confirmation" | "done" | "failed" | "skipped" | "cancelled";
  attempts: number;
  failed_attempts: number;
  max_failed_attempts: number;
  max_total_attempts: number;
  retryable: boolean;
  requires_confirmation: boolean;
  observation_id: string;
  error_code: string;
  error: string;
  started_at: string;
  ended_at: string;
};
```

步骤重试不能覆盖旧执行记录：

```ts
type AgentStepAttempt = {
  attempt_id: string;
  run_id: string;
  step_id: string;
  attempt: number;
  status: "running" | "done" | "failed" | "interrupted" | "cancelled";
  input_digest: string;
  observation_id: string;
  idempotency_key: string;
  model_call_refs: string[];
  error_code: string;
  error: string;
  started_at: string;
  ended_at: string;
};
```

`UNIQUE(run_id, step_id, attempt)` 保证 attempt 单调递增。Observation、模型 usage、artifact 和副作用结果均引用 `attempt_id`。`attempts` 汇总所有实际启动，`failed_attempts` 只汇总 `failed`；默认 `max_failed_attempts=2`、`max_total_attempts=10`，后者防止用户反复暂停造成无限 attempt，但 `interrupted` 不消耗失败重试预算。

`interrupted` 表示协作式暂停、runtime 退出或 lease 接管导致本次实际执行未完成。唯一允许的 `running -> pending` step 回退由 `interruptStepAttempt()` 恢复事务执行：按 attempt、step、run 的 expected version 做 CAS，先确认没有 `prepared/temp_written/file_replaced` 的未对账副作用，再把 attempt 置为 `interrupted`、step 置为 `pending`、run 置为 `paused`，并在同一 SQLite transaction 中追加下一个 sequence 的事件。普通 executor 不得直接执行该反向迁移；CAS 任一步失败则重读，不创建新 attempt。

P0 同时定义最小出站审计，不等待 P1 Model Gateway：

```ts
type AgentOutboundDisclosure = {
  disclosure_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  provider_id: string;
  purpose: string;
  data_classes: Array<"instruction" | "selection" | "project_excerpt" | "attachment_excerpt" | "memory" | "web_material">;
  content_digest: string;
  redacted_summary: string;
  policy_version: string;
  consent_receipt_id: string;
  created_at: string;
};
```

P0 在每次真实 provider HTTP 请求前持久化一条 disclosure；同一 step attempt 内的 retry/fallback 各有新 disclosure。`content_digest` 只用于证明出站内容集合，不保存全文。P1 的每个 `model_attempt_id` 必须通过唯一 `disclosure_id` 一一对应实际 provider 请求；P1 迁移只给新 model attempt 建立引用，不重写 P0 审计历史。run 只固化 disclosure policy/consent 的版本快照，不能复用某次旧 disclosure 代表后续 replan、retry 或 fallback 的实际出站内容。

Plan 生命周期为 `draft -> approved -> superseded`。批量、长任务、高成本、联网或写入型计划必须先持久化为 draft；用户可在执行前修改范围、步骤说明、顺序、保存目标、成功标准和检查点。修改产生新 `plan_version`，旧确认和旧页面操作返回版本冲突。明确的单步只读/草稿请求可由策略自动批准，避免每次都增加一次确认。

### 5.3 Observation

```ts
type AgentObservation = {
  observation_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
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
  max_failed_attempts_per_step: number;
  max_total_attempts_per_step: number;
  max_duration_ms: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_cost: number;
  cost_currency: "USD";
  pricing_snapshot_id: string;
  used_steps: number;
  used_replans: number;
  used_attempts: number;
  used_failed_attempts: number;
  used_input_tokens: number;
  used_output_tokens: number;
  estimated_cost: number;
};
```

默认建议：

- 普通聊天：最多 3 步、1 次重规划；
- 普通工作流：最多 6 步、2 次重规划；
- 长拆书/批量生成：由 job 分段，每个分段独立检查点；
- 单步骤失败最多重试 2 次，总 attempt 默认最多 10 次；`interrupted` 只占总 attempt 上限，不占失败重试上限；
- 超预算后进入 `paused`，不静默继续消耗。

### 5.5 Artifact 与验证结果

```ts
type AgentArtifactRef = {
  artifact_id: string;
  kind: "chat_answer" | "generated_cache" | "project_document" | "quality_report" | "memory_patch" | "web_material";
  path: string;
  cache_id: string;
  content_hash: string;
  document_version: number;
  chars: number;
  created_by_step_id: string;
  created_by_attempt_id: string;
};

type AgentVerificationResult = {
  passed: boolean;
  severity: "none" | "advice" | "minor" | "major" | "blocking";
  checks: Array<{
    code: string;
    passed: boolean;
    message: string;
    evidence_ref: string;
  }>;
};
```

`AgentExpectedOutput` 至少声明 artifact kind、是否允许空输出、格式 schema、目标路径模式和最低验证项。Planner 不能只写自然语言“生成正文”。

### 5.6 Confirmation

```ts
type AgentConfirmation = {
  confirmation_id: string;
  version: number;
  run_id: string;
  step_id: string;
  action: string;
  risk_level: "low" | "medium" | "high" | "critical";
  summary: string;
  target_paths: string[];
  expected_versions: Record<string, number>;
  expected_hashes: Record<string, string>;
  proposed_artifact_refs: string[];
  status: "pending" | "approved" | "rejected" | "expired" | "superseded";
  expires_at: string;
  resolved_at?: string;
  resolved_by?: "user" | "policy";
};
```

确认规则：

- 确认记录必须持久化，页面刷新后仍可处理；
- 同一个确认只能成功处理一次；
- 到期、目标版本变化或计划被替换时自动失效；
- approved 只授权确认快照中的 action、路径和版本，不授权其他副作用；
- rejected 后步骤进入 `skipped` 或 run 进入 `paused`，由计划策略决定；
- critical 操作不允许 policy 自动批准。

### 5.7 Run Event

```ts
type AgentRunEvent = {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  step_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};
```

`sequence` 在单个 run 内严格递增，用于前端断线重连、去重和状态回放。Event 是状态变化通知，SQLite Run State 才是最终事实来源。

### 5.8 标识、版本与错误契约

- `request_id` 用于创建 run 的 API 幂等；相同 request_id 重放必须返回原 run；
- `run_id` 是跨 API、stream、Trace、会话和存储的唯一任务标识；
- `step_id` 在一个 plan version 内稳定，重规划的新步骤使用新 ID；
- `attempt_id` 每次实际执行唯一，重试只增加 attempt，不复制 run；
- `operation_id` 用于 pause/resume/cancel/approve/reject/retry 命令幂等；
- run、step、confirmation 均带单调 `version` 或等价 CAS 字段，所有控制 API 校验 expected version；
- 错误使用稳定 `error_code`、可读 message、retryable 和 detail，UI 不依赖中文错误文本判断流程。

所有 ID 在后端生成并校验格式；客户端临时 ID 不直接成为存储主键。时钟只用于展示、TTL 和租约，不用于决定 step 顺序，顺序由数据库版本和 sequence 决定。

## 6. 阶段 P0：持久执行状态

### 6.1 目标

让 Agent 任务在错误、取消和应用重启后仍可查询、恢复和安全重试。

### 6.2 新增模块

- `packages/agent-runtime/src/kernel/execution-store.ts`
- `packages/agent-runtime/src/kernel/run-coordinator.ts`
- `packages/agent-runtime/src/kernel/run-recovery.ts`
- `packages/agent-runtime/src/kernel/commit-journal.ts`
- `packages/agent-runtime/src/kernel/execution-state-machine.ts`
- `packages/agent-runtime/src/kernel/idempotency.ts`
- shared run/step/observation schema
- desktop run 查询、暂停、恢复和步骤重试 API

### 6.3 存储方案

复用桌面端现有 SQLite 能力，新增：

```text
agent_runs
agent_steps
agent_step_attempts
agent_outbound_disclosures
agent_observations
agent_artifacts
agent_confirmations
agent_run_events
agent_write_leases
agent_control_operations
agent_commit_journal
agent_runtime_instances
agent_schema_migrations
```

数据库固定放在 `{projectRoot}/00_设定集/.agent/agent_runs.sqlite3`，不得与 `vector_index.sqlite3` 或桌面 `xiaoshuo-local-state.sqlite3` 共库。`agent-runtime` 定义最小 `ExecutionDatabase` adapter；desktop-shell 复用现有驱动探测，在 `better-sqlite3` 与 `node:sqlite` 中选择可用实现。业务 store 不直接依赖 Electron，也不把某一个 SQLite 驱动泄漏到 shared 契约；生产 `ExecutionStore` 直接 import `node:sqlite` 只能作为待替换的 P0 草稿，不能视为 adapter 交付完成。

关键字段必须包含 `run_id`、`step_id`、状态、尝试次数、输入摘要、输出引用、错误、时间和幂等键。

模型长文本和附件全文不直接写数据库；只保存 Generated Cache ID、项目路径或受控 artifact 引用。

数据库要求：

- 所有 migration 有唯一版本、校验和、执行时间、`min_reader_version`、`min_writer_version` 和回滚说明；
- migration 在事务内执行，执行前优先使用 SQLite backup API 生成一致快照；不得只在 `wal_checkpoint` 后复制主库文件并假定 WAL 已完整合并；
- migration 获取项目级独占锁；当前二进制遇到未知更高 schema 时隔离原库、拒绝写入并提供原始备份/通用导出，除非存在经过测试的稳定兼容视图，否则不承诺旧代码能查询任意新 schema；
- 迁移前校验备份可读和剩余磁盘空间，至少保留 `2 * (db + wal) + 64 MiB`；
- 开启 WAL，`busy_timeout` 初始值 5000ms；单进程内写入经有界队列串行，禁止在数据库事务或 write lease 持有期间等待模型/网络调用；
- 定期执行被动 WAL checkpoint，并在正常退出和备份前完成受控 checkpoint；
- 写入使用参数化 SQL；
- 数据库打开失败时切换隔离恢复模式并提示备份位置；只读查询仅限 schema 兼容且通过测试的版本；
- 提供按项目的存储用量统计和安全清理入口。

备份与恢复目标：

- 普通进程崩溃和 migration 执行失败：Agent metadata `RPO=0`，自动对账 `RTO <= 60s`；
- 数据库页损坏：保留原损坏文件，进入只读导出/从最近校验通过的备份恢复，metadata `RPO <= 24h`、人工恢复 `RTO <= 10min`；
- 每个支持的源 schema 都有 migration fixture，至少包含 0.4.0 空库、新库和中断库；
- 恢复完成后执行 `PRAGMA quick_check`、关键表计数/hash、WAL 数据完整性校验和 commit journal 对账；checkpoint/backup API 返回值必须验证，锁竞争不能被当作备份成功。

### 6.4 状态机规则

- Run 状态：`queued -> planning -> waiting_user_input/running -> waiting_confirmation/paused/cancelling/failed/cancelled/completed`；
- Step 状态：`pending -> running -> waiting_confirmation/done/failed/skipped/cancelled`；
- 只有 `pending -> running` 可以启动步骤；
- `running -> pending` 仅允许 `interruptStepAttempt()` 在暂停/lease 接管恢复事务中执行，并同时生成 `interrupted` attempt；其他反向迁移一律非法；
- 必须审阅的 plan 只有 `draft -> approved` 后才能启动步骤；plan 被修改后旧版本进入 `superseded`；
- 恢复 run 时复用原 `run_id` 和 request snapshot；先通过 `interruptStepAttempt()` 把 lease 过期的 `running` attempt 结算为 `interrupted`、当前 step CAS 回 `pending`，再将 `failed/paused` run 通过 CAS 转为 `running` 并创建新 attempt；
- 已完成步骤默认不可重复执行；
- 需要重新执行时生成新 attempt，并保留旧 observation；
- pause 是协作式检查点：设置 `pause_requested_at`，当前不可中断的文件提交完成后通过恢复事务把 attempt 结算为 `interrupted`、step CAS 回 `pending`，run 再进入 `paused`；pause 不消耗失败重试预算，存在 pause 请求时不得直接把 run 标为 `completed`；
- cancel 先进入 `cancelling` 并触发进程内 AbortController，活动 step 结束为 `cancelled` 后 run 才进入 `cancelled`；
- runtime 每 10 秒续租，instance lease 默认 30 秒；应用启动只接管 lease 已过期的 `running/cancelling` run，并记录 `recovery_reason`；
- renderer reload、页面切换和事件订阅断开不改变 run，也不复用 HTTP abort 作为 pause；正常应用退出和自动更新重启先停止接收新 run，在明确的 10 秒排空期限内写入检查点，超时任务转为 `paused`；
- Windows 休眠恢复后先续租和对账，不因墙上时钟跳变重复执行步骤；第二实例通过 single-instance lock 不得启动第二个 scheduler；
- 不自动重放任何文件写入；`recovery_required` 不进入 run status enum，提交日志无法自动对账时统一使用 `paused`、`error_code=RECOVERY_REQUIRED` 和人工恢复详情。

状态迁移必须以数据库条件更新实现，例如 `UPDATE ... WHERE status = expected_status`。更新行数为 0 代表发生并发竞争，调用方必须重新读取状态，不能继续执行。

### 6.5 并发、幂等和确认

- 每次副作用生成 `idempotency_key = hash(run_id, step_id, attempt, action, target, base_version)`；
- 对目标路径申请 write lease，lease 包含 owner、获得时间、过期时间和单调 fencing token；所有实际写入再次校验 token，过期 owner 的迟到提交必须失败；
- DocumentService 提交时检查 expected version/hash；
- 版本不一致时生成新的 Confirmation，不自动覆盖；
- Confirmation approved 后仍需在同一事务边界重新检查版本；
- 同一幂等键重复请求返回第一次结果；
- 多文件提交记录每个路径状态，失败后禁止把 run 标为 completed。
- `requires_confirmation=true` 的 step 在开始副作用前必须先持久化 Confirmation，并与 run 原子进入 `waiting_confirmation`；只有重新校验 action、路径、plan version、document version/hash 后才能继续。
- 计划批准不等于写入批准。计划批准授权执行范围和成本，Confirmation 只授权其快照中的具体副作用；UI 可以一次展示，但必须保存两种独立审计语义。

### 6.6 崩溃一致性与提交日志

文件写入不能只靠 SQLite transaction。每个写入 action 使用以下协议：

```text
prepared
  -> temp_written
  -> file_replaced
  -> db_committed
  -> finalized
```

要求：

- `prepared` 在 SQLite 中记录目标、base/new hash、临时路径、备份路径、document version、timeline ref、idempotency key 和 fencing token；
- 内容先写同卷临时文件并校验 hash，再执行可替换操作；Windows 文件占用导致替换失败时保持 prepared，不覆盖源文件；
- 文件替换后提交 document version、artifact、timeline 和 step outcome，再标记 `db_committed`；
- 启动时逐条对账未 finalized journal，按实际 hash 完成提交或恢复旧版本；不凭状态字符串猜测；
- 多文件 action 使用确定顺序和 manifest，任何部分提交必须进入 `paused` 并记录 `RECOVERY_REQUIRED`，不得显示 completed；
- journal 清理晚于 run/event/trace 引用清理，且只清理已 finalized 记录。

这里的 `recovery_required` 是 `error_code`/恢复分类，不是额外 run status。生产中的 v2 文件写入必须全部经统一 `CommitJournalService -> DocumentService` 路径；只建 journal 表和 CRUD、但 `/api/agent/execute`、Skill 或 workflow 仍可直接写文件时，`agent_execution_v2_mode=on` 不得发布。

在每个状态边界执行故障注入；CI 覆盖确定性边界用例，发布候选执行累计至少 1000 次强杀/恢复 soak。结果只能是完整旧版本或完整新版本，禁止出现文件 hash、document version、timeline 与 run 状态互相矛盾。

### 6.7 API

```text
POST /api/agent/runs
GET  /api/agent/runs
GET  /api/agent/runs/{run_id}
GET  /api/agent/runs/{run_id}/events?after={sequence}&limit={limit}
GET  /api/agent/runs/{run_id}/events/stream?after={sequence}
POST /api/agent/runs/{run_id}/pause                  operation_id + expected_version
POST /api/agent/runs/{run_id}/resume                 operation_id + expected_version
POST /api/agent/runs/{run_id}/cancel                 operation_id + expected_version
POST /api/agent/runs/{run_id}/steps/{step_id}/retry  operation_id + expected_version
POST /api/agent/confirmations/{confirmation_id}/approve  operation_id + expected_version
POST /api/agent/confirmations/{confirmation_id}/reject   operation_id + expected_version
```

`POST /runs` 使用 `request_id` 幂等创建；list/detail 支持 project、status、cursor 和 limit，不能一次加载全部历史。除 health check 外所有 API 都校验桌面会话令牌；写接口额外校验 Origin、run 当前状态、expected version 和 operation_id。approve/reject 必须幂等。

首次创建返回 `201`；相同 `request_id` 和相同规范化请求重放返回 `200` 与原 run，不抛普通冲突。相同 `request_id` 携带不同请求摘要返回 `409 REQUEST_ID_REUSED`。控制操作重放返回第一次结果；不能只返回“当前看起来相同”的状态而丢失原操作结果。

流式事件使用现有可携带 Authorization header 的 fetch + NDJSON 通道；若采用 SSE，也必须通过受控 header/cookie 完成认证。禁止把会话令牌放在 EventSource query string。

两个事件端点语义固定：

- `/events` 是有限 JSON replay，返回 `{ events, next_sequence, has_more, earliest_available_sequence, gap_detected }`；`limit` 默认 200、最大 1000；
- `/events/stream` 是长连接 NDJSON，先从 `after` 补历史，再发送实时 event；每 15 秒发不增加 run sequence 的 transport heartbeat；客户端关闭只结束订阅；
- 请求的 `after` 早于最早保留 sequence 时，replay 返回 `gap_detected=true`；stream 先发送 `replay_required` transport frame 后关闭。客户端必须重新读取 run detail，记录其 `last_event_sequence` 后再连接；
- NDJSON transport frame 使用 `kind=event|heartbeat|replay_required|stream_end`，只有 `kind=event` 携带持久 `AgentRunEvent.sequence`；正常服务排空发送 `stream_end`，异常断连由客户端按最后已确认 sequence 重连。

### 6.8 事件与重连

- 状态变化和 AgentRunEvent outbox row 在同一个 SQLite transaction 中提交；publisher 只负责通知，启动时扫描未发布 outbox；
- Workbench 使用认证后的现有流式通道订阅；
- 客户端保存最后 `sequence`，重连时从 `after` 继续；
- 执行控制和事件订阅解耦；NDJSON/HTTP 连接关闭只结束订阅，不向执行器传播 pause/cancel；
- 重复 event 按 `event_id` 去重；
- 事件缺口、服务重启或 SSE 不可用时回退到 run detail 轮询；
- UI 永远以重新读取的 Run State 校正本地状态。
- Task E 只有在 Workbench typecheck/build、任务列表/详情/控制 E2E、sequence 补流和缺口回读全部通过后才可标记完成；存在未定义组件或仅能手动刷新 JSON 时仍为实现中。

### 6.9 JobManager 兼容边界

- Agent 聊天、Skill 编排、批量正文和拆书一旦进入 P0 新内核，以 Execution Store 为唯一状态源；
- 旧 crawler/网站任务暂留 `JobManager`，通过 `legacy_job_id <-> run_id` 映射向统一任务页展示，但不得双向复制状态；
- 映射 run 只读取旧 job 进度，不获得 Agent resume/retry 语义；迁移到 Agent 内核后删除对应兼容 adapter；
- `runAgent()` 与 `streamAgentRun()` 在执行前创建 durable run，并把同一 `run_id` 传入 Trace、stream start/final event 和 AgentRunResponse；
- `sendMessage()`/`streamMessage()` 复用上述入口，不再额外生成 Trace ID；
- 应用退出后不承诺隐藏后台继续运行。0.5.0 关闭主进程时将长任务安全暂停，下次启动恢复。

### 6.10 数据保留

- pending/running/paused run 不自动清理；
- completed/cancelled run 的 metadata 默认保留，临时 artifact 采用可配置 TTL；
- Trace、网页摘录和模型中间输出达到磁盘上限时优先清理最旧且未被引用的数据；
- 清理操作先检查 artifact reference count；
- 用户可导出 run 摘要、质量报告和 Trace，也可删除历史记录；
- 删除 run 不得删除已提交项目文档和时间线快照。

默认 TTL 在 0.5.0 设置为：模型中间输出 7 天、网页摘录 30 天、Trace/事件 30 天、completed/cancelled metadata 90 天；用户可以改长或选择保留。删除采用 tombstone 级联到活动数据库、WAL、artifact、向量/图谱派生引用和后续备份轮换，导出文件携带 schema version。任何删除都不得越过 project id。

### 6.11 验收

- 关闭并重启软件后仍能看到未完成任务；
- 可从失败步骤恢复，不重复执行已完成步骤；
- 同一个幂等键只能产生一次文件副作用；
- 两个 run 同时修改同一路径时只能一个按原版本成功提交；
- 目标文件在确认期间变化后，旧确认不能继续写入；
- 断开并恢复前端连接后，步骤进度与数据库一致；
- migration 失败能够恢复旧数据库；
- 取消和暂停不会被记录为普通失败；
- 旧 `/api/agent/run` 和会话 API 继续工作。
- response、stream、Trace、Run Store 和会话中的 `run_id` 完全一致；
- renderer reload、main/runtime crash、休眠恢复、正常退出、自动更新重启和第二实例均不重复步骤；
- 10,000 个历史 run 的启动对账在参考 Windows 设备上 P95 <= 3s；
- commit journal 在故障边界恢复后文件、版本、时间线和 run 状态一致；
- Agent 长任务与 legacy job 不出现两个相互覆盖的状态源。
- stale run 接管会结算孤儿 attempt；真实子进程强杀后可用同一 `run_id` 完成恢复，已完成 step 不重复；
- pause attempt 记录为 `interrupted` 且不消耗失败重试预算；renderer reload/订阅断开不改变 run；
- `requires_confirmation` step 不会在未创建/批准 Confirmation 时进入副作用或 `completed`；
- `agent_execution_v2_mode=off|shadow|on` 行为可验证，run 固化非空的实际 flag snapshot；
- 除 health 外，缺失/错误/旧令牌请求 100% 返回 401，错误 Host/Origin 返回 403，令牌进入 URL/日志/Trace/SQLite/崩溃报告的次数为 0；
- 根级 typecheck、单测、Workbench/Desktop build、恢复 E2E 和 packaged installed-build smoke 全部通过。
- 移动项目目录后，稳定 project UUID 仍能关联原 run；两个路径共享 UUID 时不会在未确认身份前并发写入。

### 6.12 测试

- SQLite store CRUD 和迁移测试；
- 状态机非法迁移测试；
- 重启恢复测试；
- 已完成写入不重复测试；
- 失败步骤重试测试；
- 并发写同一路径和 lease 过期测试；
- expected version/hash 冲突测试；
- Confirmation 过期、重复批准和版本变化测试；
- SSE 断线、事件去重和缺口回放测试；
- 数据库 migration 失败、schema 兼容只读导出和未知 schema 隔离恢复测试；
- artifact TTL 与引用保护测试；
- cancellation 回归测试。
- run_id/Trace/stream 关联和 request snapshot 恢复测试；
- attempt 历史、operation id 和 expected version CAS 测试；
- runtime instance heartbeat、fencing token 和第二实例测试；
- renderer reload、main crash、自动更新、休眠和正常退出矩阵；
- commit journal 每个崩溃边界和 Windows 文件占用测试；
- JobManager 映射与唯一事实源测试；
- 认证 NDJSON 重连、token 不进入 URL/日志测试。
- stale attempt 结算后 resume、pause completion race、renderer disconnect 不暂停测试；
- plan approval 与 write Confirmation 分离、未确认 step 不完成测试；
- request_id 同请求重放/异请求冲突和 operation replay 原结果测试；
- `off|shadow|on`、flag snapshot 和旧路径回滚测试；
- Windows clean install、packaged app 打开项目、确认写入、关闭、升级、重启和卸载 smoke。
- 旧项目首次生成 UUID、项目移动、重复 UUID 路径隔离和 run 重新关联测试。

### 6.13 建议提交

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
  deadline_at?: string;
  data_classification?: "public" | "project" | "private_local";
};
```

Gateway 为每次真实 provider 请求创建 `model_attempt_id`，记录 capability snapshot、routing reason、prompt/template version 和 pricing snapshot。业务层只看到统一结果或 typed error，不依赖供应商错误文案。

### 7.3 重试策略

- 408/429/502/503：指数退避加随机抖动；
- 默认最多 3 次；
- 400/401/403 不自动重试；
- 流式参数不兼容可退回非流式；
- 超时只允许在没有产生副作用的模型调用中重试；
- 用户主动取消立即终止，不 fallback。

模型 API 的 idempotency key 不能被当作 exactly-once 保证。非流式调用可缓存已验证结果；流式调用一旦向 UI 发布正文 token，不得在同一个 attempt 中静默从头重试并拼接重复文本。断流后保留 partial artifact，创建新 attempt，并由任务策略选择续写、整段重生成或交给用户决定。

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

### 7.6 流量治理与隐私

每个 provider/model 维护独立运行状态：

- 并发上限和请求队列；
- Rate Limiter，使用 token bucket 或等价速率限制；
- 连续失败阈值和 Circuit Breaker；
- breaker 的 closed/open/half-open 状态；
- 能力探测结果及过期时间；
- 最近错误类别和建议恢复时间。

治理规则：

- 排队中的请求可取消；
- 429 尊重 `Retry-After`；
- breaker open 时不继续轰击同一 provider；
- fallback 前重新检查剩余预算和数据发送策略；
- planning/routing 可选择低成本模型，正文生成和质量判断按能力选择；
- 未配置云模型时保持本地功能可用，不静默上传数据；
- 请求前生成 Data Disclosure，记录将发送的数据类型、字符/token 量和 provider；
- 用户标记为本地私密的文件不得发送到云 provider；
- base URL 必须是合法 HTTPS，显式本地地址除外；重定向不得把 Authorization 发送到其他 origin。
- `private_local` 内容只能发送到显式声明为本地的 provider；fallback 不得降低数据隐私等级；
- run 固化 disclosure policy/consent、capability 和 pricing 的版本快照；每个真实 provider 请求仍创建独立 Data Disclosure，并与 `model_attempt_id` 一一对应。运行中修改模型设置不改变已开始的 attempt，也不能让后续 retry/fallback 复用旧 disclosure；
- Metrics 默认只写本地 Trace；远程崩溃报告遵守 3.3 的显式 opt-in 和字段白名单。

### 7.7 验收

- 429/502/503 模拟故障可自动恢复；
- Planner 不再手写 JSON 正则截取；
- 主模型失败时按任务策略切换副模型；
- Trace 能展示 token、重试、费用和 fallback；
- 并发请求不会超过 provider 配置上限；
- Circuit Breaker 打开后请求可快速失败或选择允许的 fallback；
- 云模型调用能说明发送的数据类型；
- 本地私密内容不会进入云请求；
- 用户取消不触发后续重试。

### 7.8 测试

- 429 `Retry-After`、502/503 退避和抖动测试；
- 队列取消、并发上限和 breaker 状态测试；
- structured output 能力支持/不支持矩阵；
- fallback 预算与隐私策略测试；
- redirect origin 与 Authorization 防泄露测试；
- usage 缺失和供应商字段差异测试。

### 7.9 建议提交

```text
feat(model): add resilient structured model gateway
refactor(agent): migrate planners to structured output
feat(trace): record model usage and retry metadata
docs(agent): record P1 model gateway rollout
```

## 8. 阶段 P2：Plan-Act-Observe-Replan

### 8.1 目标

将当前静态技能序列升级为受预算约束的 Agent 执行循环。

### 8.2 目标解析与计划协商

Goal Builder 先运行确定性约束提取，再在必要时调用结构化模型。它必须输出 5.1 的 `IntentResolution` 和 `AgentGoal`，不得仅凭路由分数直接执行技能。

规则：

- 阻塞歧义未解决时进入 `waiting_user_input`，重大歧义解决前副作用保持为 0；
- 可安全推断的请求显示假设后继续，不反复追问；
- `assist` 模式不自动扩展为多步长任务，`plan` 模式先审阅计划，`execute` 也不能绕过确认和预算；
- required/optional step、成功标准、保存目标和检查点均可在 plan draft 中修改；
- 用户批准时固化 `plan_version`，执行过程中只允许重新规划未完成步骤；
- 用户选择“不再提示”的主动建议写入本地冷却策略，不在同一上下文重复出现。

### 8.3 允许的 Action

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

每个 Action Descriptor 必须声明：输入 schema、输出 schema、所需权限、是否有副作用、是否可重试、默认超时、确认策略和允许的 context trust level。Action Executor 根据注册表授权，不能信任模型返回的权限字段。

### 8.4 跨阶段接口

P2 可以依赖接口，但不能等待 P3/P5 的完整实现：

```ts
interface VerifierPort {
  verify(input: AgentVerificationInput): Promise<AgentVerificationResult>;
}

interface MemoryCommitPort {
  prepare(input: AgentMemoryCommitInput): Promise<AgentArtifactRef | null>;
  commit(artifact: AgentArtifactRef, confirmation?: AgentConfirmation): Promise<void>;
}
```

P2 使用 runtime 强制注入、Planner 不能删除或跳过的最小确定性 `BasicVerifier`，只验证 schema、空输出、目标路径和副作用安全；使用 `NoopMemoryCommit` 或仅写现有会话摘要的兼容 adapter。P3 和 P5 分别替换 MemoryCommit 与 Verifier 实现，不改变 Agent Loop 状态机。P2 的结果称为 **structural verification**，不得对外宣称已经通过 P5 的 semantic quality gate。

### 8.5 执行循环

```text
Goal Builder
  -> Plan Validator
  -> Persist Draft Plan
  -> Approve or Auto-approve by Policy
  -> Execute Step
  -> Persist Observation
  -> Verify Expected Output
     -> pass: next step
     -> retryable: retry
     -> recoverable: replan remaining steps
     -> needs user: wait confirmation
     -> fatal: fail run
  -> Structural Final Verification
  -> Save Preview
  -> Memory Commit
```

P5 启用后才在 Structural Final Verification 与 Save Preview 之间插入 Semantic Quality Gate。P3 在此之前只接收已保存、用户确认且通过结构验证的产物，不以“质量门已通过”描述兼容 adapter。

### 8.6 重规划条件

仅在以下情况重规划：

- 引用文件不存在或版本变化；
- 选中技能不可用；
- 输出类型不符合预期；
- 上一步产生的新事实改变后续条件；
- 可恢复网络或模型错误超过步骤重试次数；
- 用户修改目标。

重规划只修改尚未完成的步骤，不能改写已完成事实和已经确认的用户目标。

### 8.7 计划验证

Plan Validator 必须拒绝：

- 超过预算的计划；
- 未注册 action；
- 不存在或禁用的 skill；
- 没有确认策略的覆盖/删除操作；
- Action 请求的工具权限超过 Skill Manifest 白名单；
- untrusted context 试图修改 system policy、预算或确认策略；
- 循环依赖；
- 没有预期产物的写入步骤；
- 同一路径互相冲突的并行写入。

Planner 必须生成 deterministic plan fingerprint。Plan Validator 同时校验 goal revision、feature flag snapshot、memory revision、Action/Skill 版本和 expected output；任何版本变化都显式产生新 plan，而不是就地篡改旧记录。

### 8.8 验收

- 两步任务第二步失败后可重试第二步；
- 输入缺失时可补充读取并重新规划；
- 达到重规划或费用上限时明确暂停；
- 计划和每步观察均可在 Trace 中回放；
- 恶意网页、附件或 imported skill 不能扩大 Action 权限；
- P2 在未启用 P3/P5 时仍能使用兼容 adapter 完成任务；
- 不允许模型绕过 DocumentService 和 Generated Cache 写文件。
- 阻塞歧义解决前不执行有成本/有副作用步骤，可安全假设不会造成过度追问；
- 写入、长任务和高成本计划可在执行前修改并批准，旧 plan version 操作被拒绝；
- assist/plan/execute 三种模式不会互相越权。

### 8.9 测试

- Action schema 与权限拒绝测试；
- Prompt Injection fixture；
- BasicVerifier/NoopMemoryCommit adapter 测试；
- 重规划只修改未完成步骤测试；
- 达到步骤、重规划、token、费用和时间预算测试；
- untrusted observation 不能改变用户目标测试。
- 至少 60 个歧义、假设和主动性 eval；
- plan draft 修改、批准、supersede 和旧版本冲突 E2E；
- 协作模式权限矩阵和建议冷却测试。

### 8.10 建议提交

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

### 9.3 时序化 CanonClaim

小说事实不是永远有效的扁平键值。P3 以稳定 project UUID 和版本化 `CanonClaim` 表达剧情时间、视角和来源：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type NarrativeCoordinate = {
  schema_version: 1;
  timeline_id: string;
  anchor_id: string;
  ordinal: number;
  timeline_revision: number;
  phase: "before" | "at" | "after";
};

type CanonClaim = {
  claim_id: string;
  project_id: string;
  subject: string;
  predicate: string;
  value: JsonValue;
  canon_status: "planned" | "confirmed" | "deprecated" | "superseded";
  perspective: "objective" | "narrator" | "character" | "rumor";
  perspective_entity_id: string | null;
  story_time: NarrativeCoordinate | null;
  valid_from: NarrativeCoordinate | null;
  valid_to: NarrativeCoordinate | null;
  source_ref: string;
  source_revision: string;
  evidence_refs: string[];
  confidence: number;
  supersedes_claim_id: string | null;
  created_at: string;
};
```

规则：

- `NarrativeCoordinate` 在同一 `timeline_id + timeline_revision` 内按 `ordinal + phase` 确定性排序，`anchor_id` 指向稳定章节/场景/事件节点；时间线重排生成新 revision 并通过 anchor registry 重基准，不直接比较不同 revision 的 ordinal；
- `story_time` 表示事件/认知发生位置，`valid_from/valid_to` 使用半开区间 `[from, to)` 表示事实有效期；`null` 表示开放边界或未知，不能用空字符串伪造章节号；
- `value` 只允许 JSON 可持久化值，禁止 class instance、函数、循环对象和未版本化二进制；
- objective fact、角色认知、传闻和大纲 planned fact 分开检索与冲突检测；
- “第 20 章存活、第 21 章死亡”是有效区间变化，不是互斥数据损坏；
- 闪回、预言、梦境和非可靠叙述必须保留 perspective/evidence，不直接升级为 objective confirmed；
- project ID 使用项目创建时生成的稳定 UUID。移动目录保持 UUID；复制项目首次打开时提示“作为同一项目副本”或“生成新项目 ID”，禁止仅以 canonical path 充当永久身份；
- 用户偏好声明 `global` 或 `project` scope，小说 canon 永远默认 project scope。

### 9.4 结构化会话摘要

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

### 9.5 图谱统一

- 删除 `GraphContext.checkConsistency()` 的固定高分占位语义；
- 路由层和 workflow 统一调用 `GraphMemory.checkDraftConsistency()`；
- 返回 `blocking_claims`、source_path、reason 和 suggested_fix；
- `updatePaths(paths)` 只删除并重建相关路径的 entities/claims/relations；
- 文件内容 hash 变化时旧 claim 标记为 `superseded`，不直接静默覆盖；
- planned、confirmed、deprecated、superseded 状态严格区分。
- 图谱查询按叙事时间和 perspective 过滤；一致性检查只比较有效区间重叠、scope 相同且语义可比的 claim。

### 9.6 记忆提交边界

只有以下内容进入长期记忆：

- 用户明确确认的事实；
- 已保存到项目的产物；
- 已完成、通过 P2 结构验证并由用户保存的 workflow 输出；P5 启用后再额外要求对应 artifact policy 的语义质量门；
- 用户明确表达的稳定偏好。

模型草稿、失败输出和未确认推测不得直接进入 confirmed memory。

### 9.7 用户治理与冲突处理

Workbench 提供“项目记忆”管理入口，支持：

- 查看记忆内容、状态、来源和更新时间；
- 把 planned fact 确认为 confirmed；
- 纠正事实并保留 superseded 历史；
- 遗忘单条记忆或某一来源的派生记忆；
- 禁止指定文件进入长期记忆；
- 导出项目记忆；
- 重建向量/图谱前预览影响范围。

冲突优先级：

```text
用户本次明确纠正
  > 用户确认的项目文件
  > 当前版本正文事实
  > 当前版本设定
  > 大纲 planned fact
  > 历史会话推测
```

同级来源冲突时不得自动选择，必须保留双方证据并请求用户确认。

项目隔离要求：

- memory key 必须包含 canonical project id，而不只使用文件名；
- 检索、删除、导出和重建都校验当前 project id；
- 跨项目引用只能由用户显式选择，默认禁止；
- 云模型请求只包含当前 run 已选中的 memory block；
- 删除项目记录时不得误删同路径历史备份中的其他项目。

### 9.8 纠正传播与运行时版本

用户纠正不是对某个向量结果做临时 patch，而是独立、可撤销的 `user_override`：

- 每条 override 保存旧值、新值、理由、来源 lineage、作用域、创建时间和撤销状态；
- 项目维护单调 `memory_revision`，会话摘要、向量索引、图谱和上下文缓存都是该 revision 的派生投影；
- 纠正提交先写权威记录，再通过 outbox 更新各投影；投影未追平时查询必须合并 override，不能继续把旧事实作为当前事实；
- 全量重建保留 override，不允许从原始文件重新导入已被 superseded 的值；
- Agent step 记录 `base_memory_revision`，关键事实相关 revision 变化时暂停、重新读取并重规划；
- “把纠正同步回来源文件”只生成保存预览，继续走版本检查和用户确认，不静默改文件；
- 撤销 override 产生新 revision，并完整恢复可追踪的前一事实状态。

### 9.9 验收

- 100 轮会话后仍能召回关键决策；
- 修改人物设定文件后旧 claim 不再作为当前事实；
- 增量更新只处理变更路径；
- 图谱 API 和一致性 workflow 对同一文本给出一致结果；
- 用户可以查看、纠正和遗忘一条记忆；
- 两个项目存在同名人物时不会互相召回；
- 同级事实冲突会显示证据并等待确认；
- 每条事实可回溯到消息或文件来源。
- 纠正后所有检索入口立即只把新值作为当前事实，重启和全量重建不会复活旧值；
- 使用旧 memory revision 的运行会暂停或重规划，撤销纠正可以恢复前一状态。
- 同一角色在不同剧情时间或不同认知视角的 claim 不会被误报为当前客观冲突；
- 项目移动保持 project UUID，复制项目的身份选择可审计且不会造成跨项目召回。

### 9.10 测试

- 100 轮结构化摘要回放；
- memory source 版本失效；
- planned/confirmed/superseded 状态迁移；
- 纠正、遗忘、导出和重建；
- 同名人物跨项目隔离；
- 同级冲突等待确认；
- 云请求只包含已选 memory blocks。
- user_override 的提交、撤销、重启、全量重建和投影延迟测试；
- 运行中 memory revision 变化与来源文件同步预览测试。
- 角色状态时间区间、角色认知/客观事实、闪回/预言和非可靠叙述 fixture；
- NarrativeCoordinate 排序、开放边界、半开区间、timeline revision 重基准和 JSON value schema 测试；
- 项目移动、复制为新项目、同一项目副本和 global/project preference scope 测试。

### 9.11 建议提交

```text
feat(memory): add structured episodic memory
feat(graph): unify consistency checks and incremental updates
feat(context): consume governed project memories
docs(agent): record P3 memory rollout
```

## 10. 阶段 P4：Token 级上下文调度

### 10.1 目标

在固定模型预算内优先提供最相关、可信、完整且多样的上下文。

P4 分两段交付：

- **P4a（P3 前）**：tokenizer、语义分块、预算、来源引用和 0.4.0 检索基线；
- **P4b（P3 后）**：消费 `CanonClaim`/memory revision，增加叙事时间过滤、perspective、来源配额和 memory-aware 去重。

P4a 不依赖 governed memory，P4b 不允许绕过 P3 的 project scope、override 和删除语义。

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
  trust_level: "system_policy" | "user_instruction" | "trusted_project" | "untrusted_project" | "untrusted_web" | "model_generated";
  allow_instruction: boolean;
  source_ref: string;
};
```

### 10.4 选择策略

以下评分只是需要通过 G0/context eval 校准的初始实验假设，不是固定产品真理：

```text
score =
  relevance * 0.35
  + priority * 0.25
  + trust * 0.15
  + freshness * 0.15
  + novelty * 0.10
```

critical block 保留，但仍需设置合理上限；同一路径最多选择两个高度相似片段。使用 MMR 或等价方式抑制重复召回。

P4b 在上述特征之外加入 story time compatibility、perspective compatibility、memory revision 和 source quota；任何新增权重都必须保存 selector version，并与上一版本做配对回放，不能直接覆盖线上解释。

`allow_instruction` 只能由应用根据来源设置。网页、附件、普通项目文件和模型生成内容均为 `false`；它们可以提供事实和素材，但不能改变工具权限、预算、保存策略或 system policy。

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
- Trace 展示 trust level，且不可信块不会被当作控制指令；
- 相同查询下重复片段比例显著下降；
- context eval 增加真实大纲、正文、设定和 JSON fixture。
- 在版本化 benchmark 上报告 context precision/recall、答案引用正确率、关键块遗漏率和截断伤害率，并与 0.4.0 同任务基线比较；
- P4b 对当前剧情时间选择有效 canon，不把角色未知信息注入其受限视角写作请求；
- Trace 能解释候选块因预算、重复、时间、perspective、信任或来源配额被包含/排除的原因。

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
    category: "hard_gate" | "subjective";
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

自动修订必须区分硬门禁和作者偏好：格式损坏、路径安全、明确的 confirmed fact 冲突和用户声明的必须条件可以阻断；文风、节奏、对白、措辞和“AI 味”默认只给建议。只有用户或项目配置明确开启对应自动修订时，subjective issue 才进入 revise loop。

### 11.6 评分校准与用户覆盖

- deterministic evaluator 先于 model critic，阻断项不能被模型高分覆盖；
- model critic 尽量使用与生成模型不同的模型或独立 prompt，减少自评偏差；
- 每个 rubric 固定版本、阈值和权重，修改后必须重跑对应 eval；
- 质量总分不能掩盖 blocking issue；
- evidence 为空的模型问题默认降为 advice，不得阻止保存；
- 用户可以选择“保留原稿并忽略本次建议”，该决定写入 Trace，但不得篡改原始 QualityReport；
- 作者对产物的直接采用、编辑后采用、重生成或丢弃形成 artifact feedback；重复反馈只能提议为项目偏好，必须由用户确认后才进入长期记忆；
- 高成本 critic 仅在 deterministic/graph 检查无法决定时调用；
- 修订后必须针对原 issue code 复检，不能只重新给一个总分。

### 11.7 Artifact Policy Matrix

不同产物不能共享同一成本和阻断策略：

| Artifact | 默认检查 | 模型 critic | 自动修订 | 保存要求 |
| --- | --- | --- | --- | --- |
| `chat_answer` | schema、安全、引用存在性 | 默认关闭，用户要求审查时开启 | 默认禁止 | 不写项目文件 |
| `generated_cache` | schema、空输出、格式、目标范围 | 风险/质量信号触发 | 最多 1 次，保留原稿 | 进入预览，不直接提交 |
| `project_document` | 全部 deterministic、canon、用户硬约束 | 按 rubric/风险触发 | 按用户授权，最多 2 次 | 版本/hash/Confirmation/commit journal |
| `quality_report` | evidence、rubric version、可重放 metadata | 不递归自评 | 禁止 | 与原 artifact 绑定 |
| `memory_patch` | source、scope、revision、confirmed policy | 仅处理歧义 | 禁止静默修订 canon | 用户确认或已保存事实派生 |
| `web_material` | 来源、信任、引用和 prompt injection | 默认关闭 | 禁止 | 仅作为不可信上下文 |

### 11.8 本地反馈提升闭环

反馈只有经过以下流程才构成“学习”：

```text
artifact feedback
  -> 按任务/题材/rubric 聚合
  -> 生成 PreferenceCandidate（含证据、支持/反例和作用域）
  -> 用户确认或拒绝
  -> 版本化 Preference/Rubric/Router 配置
  -> 重跑正反例与 sealed holdout
  -> 灰度应用
  -> 可撤销到前一版本
```

```ts
type ArtifactFeedback = {
  feedback_id: string;
  run_id: string;
  artifact_id: string;
  action: "accepted" | "accepted_after_edit" | "regenerated" | "discarded" | "quality_override";
  task_type: string;
  diff_digest: string;
  evidence_refs: string[];
  rubric_versions: Record<string, string>;
  created_at: string;
};

type PreferenceCandidate = {
  candidate_id: string;
  project_id: string;
  scope: "project" | "global";
  target: "preference" | "rubric" | "router";
  key: string;
  proposed_value: JsonValue;
  evidence_feedback_ids: string[];
  counterexample_feedback_ids: string[];
  status: "pending" | "approved" | "rejected" | "superseded";
  version: number;
  resolved_by: "user" | null;
  resolved_at: string | null;
  created_at: string;
};

type PreferenceVersion = {
  preference_version: string;
  parent_version: string | null;
  scope: "project" | "global";
  applied_candidate_ids: string[];
  rubric_versions: Record<string, string>;
  router_version: string;
  eval_manifest_ref: string;
  status: "active" | "reverted" | "superseded";
  created_at: string;
};
```

单次编辑、沉默或丢弃不能自动变成稳定偏好；候选至少包含多个独立证据或用户明确陈述。每次应用记录来源 artifact、作用域、版本、受影响能力和回归结果。回归退化或用户撤销时恢复上一版本，不能删除原始反馈来制造提升。

存储归属：`ArtifactFeedback` 写入 Execution Store 的 `agent_artifact_feedback`，被候选引用时不随 run TTL 清理；project scope 的 candidate/version 写入 P3 governed memory store，global scope 写入 desktop userData 的同 schema PreferenceStore。批准 candidate、创建 PreferenceVersion 和投影 outbox 在各自权威 store 中事务提交；跨 store 只通过幂等 outbox 同步引用，不伪装跨库 ACID。每个 run 固化实际 `preference_version/rubric_versions/router_version`。

### 11.9 产物要求

#### 正文

- Goal 必须包含章节意图、场景转折、POV/时态、必须保留项和禁改项；
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

- 使用 `SkillSpec` 描述目标、适用/不适用场景、输入输出 schema 与样例、格式约束、上下文来源、权限和保存策略；
- 每个 Skill 至少提供 3 个触发正例和 3 个反例；
- 导入前执行权限 lint、与现有技能的路由碰撞检测和只写 Generated Cache 的 dry-run；
- 自然语言修改 Skill 时重跑原有正反例和输出契约；
- prompt 中不允许隐式绕过用户确认，明显路由冲突必须阻止导入或要求用户明确选择。

### 11.10 验收

- 所有生成产物返回结构化质量报告；
- blocking issue 不进入自动保存；
- 用户可看到问题证据，而不是只看到分数；
- 修订次数和新增模型成本进入 Trace；
- 同一 rubric 版本的分数可重放，模型型评分保留原始判定 metadata；
- 用户覆盖不会删除原始问题证据；
- 格式型任务在 eval 中通过率达到 98%。
- 仅有 subjective issue 时不会未经授权改写；作者的直接采用、编辑后采用、重生成和丢弃反馈可追溯到 artifact/rubric；
- 用户可在聊天内完成 Skill 描述、必要澄清、dry-run、确认和立即使用，dry-run 文件副作用为 0。
- 不同 artifact 按 policy matrix 使用不同成本、阻断和保存策略；聊天回答不会默认触发昂贵 critic；
- 反馈偏好必须经过候选、用户确认、版本化应用和回归评估，撤销后恢复前一行为。

### 11.11 测试

- blocking issue 不被高总分覆盖；
- 无证据 critic issue 不阻断；
- rubric 版本和阈值回归；
- 两次修订上限；
- 用户保留原稿的审计记录；
- 生成模型与 critic 组合矩阵；
- 拆书严格格式和 20 万字目标边界测试。
- hard_gate/subjective 分类和作者自动修订授权测试；
- Skill 正反例、路由碰撞、权限 lint、dry-run 和修改后回归测试。
- artifact policy matrix 权限/成本组合测试；
- PreferenceCandidate 聚合、确认、拒绝、作用域、回归失败不应用和撤销测试。
- feedback/candidate/version schema、引用保留、outbox 幂等、run 版本快照和旧版本 replay 测试。

### 11.12 建议提交

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
- 协作模式、关键假设和待澄清问题；
- plan draft/approved/superseded 状态；
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
- 执行前修改步骤说明、required/optional、顺序、范围、成功标准和保存目标；
- 批准 plan draft，或撤回尚未开始的计划；
- 对主动建议执行“稍后提醒”或“不再提示”。

长任务进度优先显示“已完成单位/总单位、当前章节或分段、最近耗时区间、检查点和累计成本”，不伪造线性百分比。任务切到后台只表示不占据当前编辑视图；ArcWriter 0.5.0 不承诺退出主进程后继续运行，关闭应用时明确显示将安全暂停的任务数量。

### 12.4 Skill 管理闭环

聊天返回 `skill_management` payload 后，直接显示：

- 草稿预览和导入；
- patch diff 和保存；
- builtin clone 建议和确认；
- 版本列表和回滚确认；
- 禁用/恢复确认。

Skill 草稿同时展示 SkillSpec 的适用/不适用场景、正反例、权限 lint、路由碰撞和 dry-run 结果；“立即使用”只在导入成功且版本号匹配后可用。

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

### 12.6 实时状态与重连

- 会话计划卡订阅 P0 的 AgentRunEvent；
- 客户端持久保存每个 run 的最后 sequence；
- 页面刷新、休眠恢复和网络重连后先补事件，再读取 run detail 校准；
- 收到重复事件不重复弹提示或执行 UI action；
- 收到事件缺口时停止本地推演，显示“正在同步状态”；
- approve/reject/retry 按钮使用 operation id，重复点击只执行一次；
- run 在其他页面完成时，会话和 Agent 运行页同时更新。

Agent 运行页同时承担持久任务收件箱：按“需要处理/运行中/已暂停/已完成”筛选，显示最近检查点、恢复原因和待确认动作。主动项目健康建议放在该入口和当前会话内，不新增抢占正文的常驻大面板。

### 12.7 可访问性与信息密度

- 正文编辑区保持最高视觉优先级，计划卡默认折叠；
- 用户可关闭自动展开和进度动效；
- 所有操作可通过键盘完成，弹层关闭后焦点回到触发控件；
- 状态使用图标、文字和颜色共同表达；
- `aria-live` 只播报关键状态变化，token delta 不逐字播报；
- 200% 缩放、窄窗口和常见 Windows 中文字体下无水平溢出；
- prefers-reduced-motion 下关闭非必要动画；
- 长路径、长技能名和长中文词组可换行或安全截断，并保留 tooltip。

### 12.8 验收

- 用户无需进入技能页即可确认一次自然语言 Skill 创建；
- 写入、长任务和高成本计划可在执行前协商并批准，明确单步任务不会被额外确认打断；
- 多步骤任务有实时进度；
- 失败消息提供可执行的重试按钮；
- 恢复任务后 UI 继续关联原会话；
- 刷新页面或断线重连后不会重复确认或丢失步骤；
- 键盘、焦点、非纯颜色状态和屏幕阅读器播报满足 WCAG 2.2 AA 基线；
- 计划卡折叠时不会挤压正文编辑区；
- 长任务切回编辑器后继续运行，退出应用时安全暂停并可在下次启动恢复；
- 小屏和桌面布局不出现按钮或文本重叠。

### 12.9 测试

- AgentRunEvent 重连、去重和缺口恢复；
- approve/reject/retry 双击幂等；
- 页面刷新后恢复计划卡；
- 键盘导航和焦点恢复；
- axe 或等价自动无障碍检查；
- 200% 缩放、窄窗口和 reduced motion 截图回归。
- plan draft 编辑/批准、任务收件箱筛选、检查点进度和退出暂停 E2E；
- 主动建议冷却、“不再提示”和默认无后台云调用测试。

### 12.10 建议提交

```text
feat(workbench): add inline agent plan controls
feat(workbench): confirm skill management from chat
feat(workbench): add retry resume and replan actions
docs(agent): record P6 agent interaction rollout
```

## 13. 阶段 P7：Eval 与发布门禁

P7 是评估平台的收口阶段，不代表前六个阶段可以等到最后才建立门禁。每个阶段在对应版本发布前必须先交付该阶段的 deterministic、故障、安全和 E2E gate；P7 再统一数据集、统计协议、趋势看板和发布自动化。

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
| 端到端作者任务 | 50 | 完成率非劣界 -3pp，且初稿 +10pp / 介入 -20% / 时间 -15% 至少一项通过 |
| 上下文引用 | 80 | 引用正确率 >= 95%，关键事实遗漏率持续低于基线 |
| Canon 时序/视角 | 60 | 有效区间/视角冲突判定准确率 >= 95% |

### 13.2 指标定义与统计协议

- 每个指标先固定标签定义、判分脚本、失败分类和人工仲裁规则，再收集结果；
- 数据集至少 20% 为 sealed holdout，开发过程中不得按 holdout case 调 prompt；
- 路由同时报告 accuracy、重大误路由率和 abstain/澄清率，不能靠过度澄清抬高准确率；
- 在线随机模型每个 case 至少运行 3 次时只报告探索性均值和最差轮次；只有预先定义统计单位且独立样本量足够（默认 `n >= 30`）时才报告 95% CI，不用三个重复样本制造虚假精度；
- 安全、恢复、幂等和 migration 使用确定性故障注入，发布候选累计至少 1000 次关键边界执行且危险写入、重复副作用、跨项目访问为 0；
- 人工质量集按题材和任务分层，至少两名匿名评审，一致率目标 >= 80%，Cohen's kappa 目标 >= 0.70；
- 数据集、rubric 或判分器变更必须同时报告新旧版本结果，不允许通过删除难例制造提升。
- 端到端指标必须与 0.4.0 或上一稳定版本做同任务配对比较，报告可用初稿率、采用/丢弃、编辑保留、人工介入、完成时间和每成功任务成本；
- 私有稿件只有明确授权后才能进入共享数据集；授权撤回后从后续数据集和可识别 artifact 中删除，并保留不含内容的审计 tombstone；
- train/dev/holdout 按来源作品或项目分组拆分，禁止同一小说相邻章节泄漏到不同集合。

### 13.3 Eval 类型

- 纯函数 deterministic eval；
- mock model contract eval；
- 录制响应 replay eval；
- 可选在线模型 benchmark；
- API integration；
- Playwright E2E；
- Electron smoke。

在线 benchmark 不作为普通单测硬依赖，但发布候选必须保存结果摘要。

G0 从 P0 起交付各阶段最小数据和判分脚本；P7 不负责第一次补齐前序版本缺失的测试，只统一 manifest、趋势、RC 调度和 release policy。

### 13.4 可复现 Eval Manifest

每次 eval 输出：

```text
eval_name
dataset_version
dataset_hash
code_commit
model_provider / model_id
model_capabilities
prompt_hash
skill_versions
rubric_versions
temperature / top_p
run_seed（供应商支持时）
started_at / duration
token_usage / estimated_cost
pass_rate / failure_cases
```

规则：

- deterministic/replay eval 必须在相同 commit 上可重复；
- 在线模型 benchmark 与离线门禁分开报告；
- 数据集修改必须升版本并记录新增、删除和修订原因；
- 失败案例保留输入、期望、脱敏输出和 Trace reference；
- 不允许只保存总通过率而丢失 case 结果。

小说质量增加人工校准集：采用匿名成对比较或固定 rubric，至少两名评审；记录一致率和分歧案例。模型 critic 指标必须与人工结果定期对齐，不能只用模型自评证明质量提升。

### 13.5 E2E 必补流程

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
- plan draft 修改/批准和阻塞歧义澄清；
- commit journal 在文件替换边界恢复；
- renderer reload、runtime crash、休眠恢复、自动更新重启和第二实例；
- SkillSpec dry-run、路由碰撞和立即使用；
- 记忆纠正、重建不复活旧值和旧 revision 运行暂停。

### 13.6 故障、安全和性能测试

- 模型 429/5xx、超时、断流和非法 JSON 故障注入；
- SQLite busy、migration 失败、数据库损坏和磁盘已满；
- Electron 进程退出、Windows 休眠恢复和网络切换；
- 两个 run 并发写同一路径；
- Prompt Injection、恶意网页、恶意 imported skill 和本地 API 越权；
- 100 轮会话、10 万级图谱 claim 和大型项目索引性能；
- 批量生成/拆书 2 小时 soak test；
- Trace、run event 和 artifact 清理后的引用完整性。

性能基线至少记录 P50/P95：首字延迟、步骤耗时、恢复耗时、上下文构建、向量检索、图谱增量更新、数据库写入和 Workbench 渲染。

参考设备和固定 fixture 上的初始发布预算：

| 指标 | 目标 |
| --- | ---: |
| 10,000 run 启动对账 P95 | <= 3s |
| 无竞争 SQLite 状态事务 P95 | <= 100ms |
| 后端事件提交到 Workbench 状态更新 P95 | <= 250ms |
| 普通 run 自动恢复 RTO | <= 60s |
| 相比上一稳定版同场景 P95 退化 | <= 15% |
| 相比上一稳定版同任务估算成本退化 | <= 10% |

不同硬件的绝对值单独记录，CI 主要比较同一 runner 的相对退化；绝对门槛在 Windows 安装包 RC 设备上验证。

### 13.7 CI 门禁

当前基线只有 `.github/workflows/release.yml`，且尚未执行单测、E2E、smoke、恢复/安全 eval 或安装后验证。以下命令是待交付接口，不是现状声明；每条命令必须先在根 `package.json` 中真实存在、Windows clean checkout 可运行且有明确 artifact 输出。

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
```

各阶段新增并在对应版本发布前必跑：

```powershell
npm run eval:routing
npm run eval:planning
npm run eval:memory
npm run eval:quality
npm run eval:recovery
npm run eval:security
```

CI 必须保存 Eval Manifest、失败 case 摘要、性能基线和脱敏 Trace artifact。任何安全门禁退化、格式通过率下降、并发写入测试失败、恢复测试失败或跨项目隔离失败都阻止发布。安装包 release 还必须执行 Electron installed-build smoke，而不能只验证 dev server。

发布基础设施要求：

- 新增 Windows PR/merge CI，至少运行 typecheck、单测、Workbench/Desktop build 和确定性恢复/安全测试；禁止 retry/quarantine 掩盖失败；
- nightly/RC 执行完整 E2E、每个 journal 边界至少 100 次故障注入、RC 累计至少 1000 次、2 小时长任务 soak 和固定设备性能基线；普通提交不重复承担完整 soak；
- tag release 只能消费同一 commit 已通过的不可变 RC 证据，并通过受保护 environment approval；不能在标签触发后跳过门禁直接打包上传；
- installed-build smoke 在干净 Windows 用户环境中完成静默安装、启动 packaged app、加载 SQLite/node-pty、打开 fixture 项目、确认写入、关闭、升级、重启和卸载；
- EXE 与卸载器 Authenticode 必须为 `Valid`，证书主体/指纹和可信时间戳符合发布配置；tag、package version、EXE version 和 `latest.yml` 完全一致；
- 固定 RC 设备规格、OS/build、10k-run fixture hash、冷/热启动协议、故障点分布、随机种子、计时起点和报告路径。性能至少重复 10 次并报告 P50/P95，与同一设备的上一稳定版比较。

## 14. 版本实施顺序

### 14.1 0.5.0：持久执行内核

范围：P0。

交付结果：

- 唯一 run/step/attempt 标识和项目内 Execution Store；
- Agent 主链路持久化、失败步骤重试和重启恢复；
- runtime owner lease、协作式暂停/取消和 Windows 生命周期对账；
- commit journal、并发写入保护、确认生命周期和断线事件恢复；
- 持久任务列表、检查点、恢复和取消基础 UI；
- legacy JobManager 明确映射，不形成第二事实源。

排期采用 Task A-H 退出条件，不以固定人日替代验收。首次估算必须在 Task D 真实强杀恢复和 Task F commit journal 垂直链路完成后重算。

发布门禁：P0 schema/migration、状态机、幂等、commit journal、并发、会话令牌、Electron/terminal 安全、生命周期、恢复 E2E、签名和 installed-build smoke 全部通过；RC 关键故障注入累计至少 1000 次，未确认写入、重复副作用、跨项目访问和 token 泄漏保持为 0；release workflow 不得绕过已通过的同 commit RC 证据。

### 14.2 0.6.0：可靠模型与闭环规划

范围：P1、P2。

交付结果：

- Model Gateway、结构化输出、重试/fallback 和成本治理；
- IntentResolution、协作模式、计划草稿与批准；
- Plan-Act-Observe-Replan；
- Action 信任、权限和预算校验；
- 基础会话计划进度。

排期在 P1 behavior-equivalence 基线完成后拆分；P1 与 P2 分别满足退出条件，不能用同一版本号掩盖其中一个未完成。

### 14.3 0.7.0：记忆与上下文

范围：P4a、P3、P4b，按此顺序交付。

交付结果：

- token/语义分块基础与 0.4.0 检索基线；
- 结构化会话记忆、时序化 CanonClaim、user override 和 memory revision；
- 增量向量和图谱更新；
- 一致性接口统一；
- memory-aware 语义块选择、叙事时间/视角过滤和去重。

排期在 P4a 大型项目基线和 CanonClaim 迁移 fixture 完成后重算；P3 不能在 P4a 前独立宣称召回验收完成。

### 14.4 0.8.0：质量与 Agent 交互

范围：P5、P6。

交付结果：

- 统一质量门和作者反馈闭环；
- 会话内完整 Agent 控制和持久任务收件箱；
- SkillSpec 自然语言创建、dry-run 和回归；
- 主动建议、冷却和默认无后台云调用。

排期按 P5 质量平台与 P6 UX 硬化分别估算；前序阶段最小 UI 不延期到 P6。

### 14.5 0.9.0：评估与发布硬化

范围：P7，以及前序阶段门禁的统一自动化。

交付结果：

- sealed holdout、统计协议和人工质量校准；
- 故障、安全、性能和 soak test；
- Eval Manifest、趋势对比和安装包发布门禁；
- 支持版本的升级/回滚演练和恢复 runbook。

排期取决于 G0 已积累的数据和前序自动化覆盖；若 P7 仍需首次建设 CI、签名或 installed smoke，则不得按收口阶段估算。

每个版本由可复现退出证据驱动。只有建立脚本、fixture 和基线后才给出人日预测，预测不构成降低门禁的理由。

## 15. 第一批实施任务

下一轮只启动 P0，不同时修改记忆和质量系统。由于当前 A-E 已交叉产生草稿，恢复顺序统一为：`E0 恢复 Workbench 绿色编译（不代表完成 E） -> 完成 A-C 契约前置 -> 完成 D 真实恢复链路 -> 完成 E API/事件/UI -> F -> G -> H`。不能长期停在“只有 schema/store、真实请求仍不持久”的中间态。

### 15.0 2026-07-10 P0 实施台账

状态只使用 `未开始 / 实现中 / 已验收`。代码和 focused test 已存在不等于已验收；P0 只有 A-H 全部通过且形成一次独立阶段提交后才完成。

| Task | 当前状态 | 已有证据 | 仍缺退出条件 |
| --- | --- | --- | --- |
| A Run Schema | 实现中 | shared schema、`interrupted` attempt、manifest 稳定 UUID/move migration、durable run 注入 UUID；`AgentRecoverableRequest` 白名单和 desktop 持久 UUID/path 冲突隔离已通过根级验证 | `chat/file_operation/chat_answer` 文档/代码一致性，以及项目复制/移动的端到端回归 |
| B Execution Store | 实现中 | SQLite 表、CRUD、WAL、CAS、outbox/lease/journal；最小 adapter/filesystem seam、只读高 schema 隔离、原子备份发布和损坏/磁盘/锁故障 fixture 已通过根级验证 | 迁移后逻辑校验、真实跨进程锁和运行期磁盘故障场景 |
| C 状态机与幂等 | 实现中 | 状态机、idempotency、heartbeat/lease；feature flag registry/snapshot；main-process allowlist 持久覆盖和 `--safe-agent` 强制 off/禁用自动恢复已通过 | shadow 对照报告和更广泛的真实副作用幂等 |
| D 最小恢复链路 | 实现中 | run/stream/Trace 同 ID、runtime registry、HTTP 订阅断连解耦；真实子进程强杀后同 ID 仅恢复第二步、第一步保持唯一完成 attempt 的 E2E，以及旧 `streamAgentRun` durable 回归已通过 | 实际 renderer 长连接订阅和完整旧入口矩阵回归 |
| E API 与 UI | 实现中 | 查询/控制、分页/实时 replay、认证 NDJSON、Workbench trace 实时订阅；Confirmation 列表/批准/拒绝与批准后显式恢复 UI/API；隔离项目/run 的 Agent Trace 列表、详情、pause 控制和 Confirmation 批准后恢复/拒绝失败浏览器 E2E 已通过 | 端到端异常/恢复矩阵扩展 |
| F 崩溃/并发/确认 | 实现中 | journal/lease/confirmation；durable direct-save/batch-replace、拆书所有持久输出及正文生成的正文/修正日志/交接摘要已走 journal/hash；Confirmation UI/API 及批准后显式恢复、拒绝失败浏览器 E2E 已通过；旧 `/api/agent/execute` 已安全退役，不再允许原始操作绕过 durable/journal 协议 | 普通文件操作计划与剩余 Skill/workflow/聊天/延后缓存写入覆盖 |
| G Job/长任务 | 实现中 | batch/disassemble SQLite checkpoint、batch 子进程 SIGKILL 后同 run 恢复 N+1 且无重复副作用、legacy JobManager 只读映射 API 已通过 | legacy 映射 UI/回归 |
| H 安全/发布 | 实现中 | runtime token/IPC、CI/RC gate、terminal/permission hardening；项目作用域的 run audit 导出与终态受控删除 API 已通过 | GitHub environment/证书配置后的真实 RC、发布报告 |

E0 已修复当前 `AgentTraceView` 未定义符号并恢复根级绿色基线，不代表 E 已完成。A-C 的 `interrupted`、stable project UUID、状态迁移、stale attempt/resume、pause/断连语义和真实强杀集成测试已有实现与验证；仍须补 snapshot 白名单、adapter/迁移故障契约、两步恢复 fixture 和 E 的创建/补流/E2E，随后才能进入 F 真实写入链路。不得因为表结构和定向单测通过就跳到 P1。

### 15.1 Task A：Run Schema

修改：

- `packages/shared/src/schemas/agent.ts`
- `packages/shared/src/schemas/job.ts`
- `packages/project-manifest/src/service.ts`
- `packages/project-manifest/src/service.test.ts`
- 新增 `packages/project-manifest/src/project-identity.ts` 与测试
- 新增 `apps/desktop-shell/src/main/project-identity-registry.ts` 与测试，用 userData 记录已见 UUID/path，检测复制冲突
- shared schema tests

交付：

- IntentResolution、AgentGoal、AgentRecoverableRequest、AgentFeatureFlagSnapshot、AgentRunState、AgentExecutionStep、AgentStepAttempt、AgentOutboundDisclosure、AgentObservation、AgentConfirmation、AgentRunEvent；
- `chat/file_operation` step、`chat_answer` artifact 和 `interrupted` attempt；
- 项目 manifest 稳定 UUID；`project_path` 不再作为永久身份；
- 旧 manifest 首次打开的原子 UUID migration、移动重关联和重复 UUID 写隔离；
- run/step/confirmation version 和稳定 error code；
- 默认预算；
- 旧 AgentRunResponse 兼容。

### 15.2 Task B：SQLite Adapter 与 Execution Store

新增：

- `packages/agent-runtime/src/kernel/execution-store.ts`
- `packages/agent-runtime/src/kernel/execution-store.test.ts`
- `packages/agent-runtime/src/kernel/execution-store-port.ts`

交付：

- 项目内 `agent_runs.sqlite3`；
- run/step/attempt/outbound-disclosure/observation/artifact/confirmation/event CRUD；
- desktop-shell 的 `better-sqlite3`/`node:sqlite` adapter；
- WAL、busy timeout、transactional outbox、schema migration 和备份校验；
- 未知高版本 schema 隔离拒绝写入，并提供原始备份/兼容导出；只有存在稳定兼容视图时才开放只读查询。

### 15.3 Task C：状态机和幂等

新增：

- `execution-state-machine.ts`
- `idempotency.ts`

交付：

- 合法状态迁移；
- runtime instance、heartbeat、owner lease、attempt 记录；
- stale orphan attempt 结算和 pause `interrupted` 语义；
- 文件写入幂等键；
- operation id、CAS version 和非法重复执行拒绝。

### 15.4 Task D：最小可恢复垂直链路

新增 `run-coordinator.ts` 和 `run-recovery.ts`，先打通：

- `runAgent()` / `streamAgentRun()` 创建 durable run；
- 同一个 run_id 贯通 response、stream、Trace 和 conversation；
- 原始 request snapshot 可在进程重启后恢复；
- 两步无副作用 fixture 可从第二步失败处恢复；
- pause/cancel 请求和旧 API 兼容；
- renderer/HTTP 断连只结束订阅，不改变 run；显式 pause/cancel 在检查点收口；
- stale run 接管原子结算 orphan attempt，再允许创建新 attempt。

这一切片不追求完整 P2 规划，只把现有执行路径包进可靠生命周期。完成标准是首次出现真实子进程“执行一半 -> 强杀 -> 新进程接管孤儿 attempt -> 同 ID 恢复 -> 完成”的集成测试；只模拟 `close()` 或只断言 run 变成 paused 不算通过。

### 15.5 Task E：查询 API 与基础恢复 UI

交付：

- cursor 化 run list、run detail、event replay 和 Trace 关联；
- pause/resume/cancel/retry 控制 API；
- Workbench 持久任务列表、状态详情、检查点和恢复/取消按钮；
- renderer reload 后从 sequence 补事件并以 run detail 校准；
- `POST /api/agent/runs` 首次创建/同请求重放/异请求冲突语义；
- Workbench typecheck/build、任务列表/详情/控制 E2E 全部通过。

### 15.6 Task F：崩溃一致性、并发与确认

新增：

- `commit-journal.ts` 和每个状态边界恢复；
- DocumentService expected version/hash 检查；
- write lease、fencing token 与幂等结果表；
- Confirmation approve/reject；
- AgentRunEvent transactional outbox；
- 所有 v2 写入统一经 CommitJournalService，旧 `/api/agent/execute`、Skill 和 workflow 不得绕过；
- plan approval 与 write Confirmation 分离，未批准的 `requires_confirmation` step 不得完成。

交付：

- 两个 run 不会静默覆盖同一文档；
- 旧确认在文档变化后自动失效；
- 前端断线后能从 sequence 恢复；
- 重复批准和重复事件不会产生第二次副作用。

### 15.7 Task G：JobManager 与长任务检查点

交付：

- Agent 批量正文和拆书迁入 Execution Store；
- 章节/分段检查点、部分产物预览和恢复范围；
- legacy crawler/index job 显式映射，状态只读且不冒充可恢复 Agent run；
- 第 N 单元后强杀，重启从 N+1 继续，前 N 单元不重复。

### 15.8 Task H：P0 安全、治理和发布门禁

交付：

- loopback、Origin、桌面会话令牌和 Electron/Windows 路径基线；
- SQLite migration 备份、兼容只读导出与未知 schema 隔离恢复；
- artifact TTL、磁盘上限和安全清理；
- prompt injection 与跨项目隔离测试；
- 运行记录导出和删除的底层 API；
- 生命周期矩阵、commit journal soak、installed-build smoke 和 0.5.0 发布报告；
- Windows PR CI、nightly/RC workflow、tag release 的门禁依赖和 environment approval；
- Authenticode 签名/时间戳验证、版本一致性和真实安装/升级/卸载 smoke；
- CSP、导航/权限默认拒绝、IPC sender 校验和 terminal 用户手势/来源约束；
- 固定 RC 设备、fixture/hash、故障分布/seed、计时协议和报告路径。

## 16. 风险与回滚

### 16.1 Feature Flags

新增配置：

```text
agent_execution_v2_mode = off | shadow | on
model_gateway_v2
agent_replanning_v2
memory_v2
context_budget_v2
memory_context_selector_v2
quality_gate_v2
agent_event_stream_v2
agent_inline_plan_ui
```

`shadow` 只允许旧路径真实执行，新内核记录和比对生命周期，绝不双执行 Action 或副作用。每个 run 在创建时固化 flag snapshot；运行中切换 flag 不改变已开始 run。Flag registry 必须记录 owner、默认值、引入版本、依赖、计划移除版本和生产可见性。

P0 必须实现可执行 registry，而不是只在本文列变量名：默认值在代码中版本控制，用户覆盖写入 desktop userData 下的安全配置；`--safe-agent`/等价受控启动参数强制 `agent_execution_v2_mode=off` 并禁用自动恢复新 run。Workbench 只能修改允许暴露的产品 flag，认证、路径和脱敏开关不进入普通设置。`shadow` 必须有对照报告证明只记录生命周期，不能调用模型两次或执行第二份副作用。

新功能默认按版本逐步开启。旧路径至少保留一个小版本周期。loopback、认证、路径 canonicalization、密钥脱敏等安全修复不作为普通用户可关闭的 feature flag，生产构建 fail closed。

### 16.2 高风险区域

- 批量正文和拆书的长任务恢复；
- 自动保存和重复写入；
- SQLite schema migration；
- 旧会话 metadata 兼容；
- 模型供应商结构化输出差异；
- 图谱旧 claim 的失效处理。
- 本地 API 会话令牌升级导致旧页面失联；
- 长任务产生的 Trace、event 和 artifact 磁盘增长；
- 并发 lease 未释放造成文档暂时不可写。

### 16.3 回滚策略

- P0：停止接收新 v2 run，等待 active run 到检查点或安全暂停，再把 `agent_execution_v2_mode` 切到 `off`；保留新表不删除；
- P1：关闭 `model_gateway_v2`，保留旧 OpenAICompatibleClient；
- P2：关闭 `agent_replanning_v2`，回到旧 SmartSkillOrchestrator 串行计划；
- P3：关闭 `memory_v2`，继续使用旧 summary/vector context；
- P4a：关闭 `context_budget_v2`，回到旧 ContextAssembler；
- P4b：关闭 `memory_context_selector_v2`，保留 P4a token 预算但不消费 governed memory 特征；
- P5：关闭 `quality_gate_v2`，workflow 回到旧检查逻辑；
- Event：关闭 `agent_event_stream_v2`，前端回退到轮询 run detail；
- UI：关闭 `agent_inline_plan_ui`，继续使用 Trace 页面。

禁止通过删除用户项目 `.agent` 数据完成回滚。

回滚分成三个独立动作并分别演练：

1. **功能回滚**：在当前新二进制中关 flag，停止创建新 v2 run，保留新库与导出能力；
2. **二进制回滚**：安装上一受支持版本，只读取其兼容 schema；不兼容时使用兼容读取器导出，不强行启动写入；
3. **数据恢复**：只在数据库损坏或 migration 失败时从已校验 backup 恢复，项目文档依据 commit journal/hash 对账，不能把正常功能回滚等同于恢复旧数据。

代码回滚与数据回滚分开：

- 成功迁移后的数据库不假定旧二进制可写；`min_reader_version/min_writer_version` 不兼容时，旧版本只能只读导出或拒绝启动 Agent；
- 发布前用真实 Windows 安装包执行升级和回滚演练，校验签名、数据库 quick_check、项目文件 hash 和未完成 run；
- 自动更新前先排空/暂停 active run、checkpoint WAL 并创建已校验备份；
- 回滚不复用未知高版本表做写入，不自动 down-migrate 用户数据；需要时安装兼容读取器导出；
- 回滚 runbook 记录恢复包、备份位置、支持 schema 范围和目标 RTO，目标为 30 分钟内恢复可读或旧兼容路径。

### 16.4 灰度与兼容矩阵

| 执行内核 | Gateway | Replan | Context Budget P4a | Memory | Memory Selector P4b | Quality | 允许状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| off/shadow | off | off | off | off | off | off | 旧兼容路径或只记录不双执行 |
| on | off | off | off | off | off | off | P0 持久执行 |
| on | on | off | off | off | off | off | P1 模型网关 |
| on | on | on | off | off | off | off | P2 + BasicVerifier/NoopMemoryCommit |
| on | on | off/on | on | off | off | off | P4a token/语义分块基础；不依赖 Replan |
| on | on | on | on | on | off | off | P3 governed memory/canon |
| on | on | on | on | on | on | off | P4b memory-aware 选择 |
| on | on | on | on | on | on | on | 完整目标路径 |

不允许 `agent_replanning_v2=on` 且 `agent_execution_v2_mode=off`。启动时检测非法组合并回退到最近合法配置。

`context_budget_v2` 在 P4a 独立开启，不依赖 `memory_v2`；关闭时回退旧 ContextAssembler。`memory_context_selector_v2` 必须同时依赖 `context_budget_v2=on` 和 `memory_v2=on`；关闭 P4b 时仍保留 P4a token 预算，不能回到无预算拼接。

每个阶段先通过版本化 fixture、shadow 对照和至少 48 小时 internal RC；建立合规 beta channel 后，才使用显式 opt-in 的真实运行证据决定是否成为默认。没有 beta channel、cohort 和隐私合规采集时，不虚构 100/500 用户 run 门槛，以 deterministic/replay、RC soak 和人工配对任务作为证据；样本不足时不因日历到期自动晋级。出现以下任一情况立即停止放量：

- 未确认写入；
- 重复副作用；
- 数据库 migration 无法回滚；
- 跨项目召回；
- API key 或敏感内容进入 Trace；
- 恢复成功率低于阶段门槛；
- P95 延迟或费用超过基线约定上限。

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
- 在 G0 至少 50 个固定配额配对任务中满足完成率 -3pp、引用正确率 -2pp 的非劣界，并让可用首个产物率 +10pp、人工介入 -20% 或完成时间 -15% 至少一项按预注册分层 bootstrap + Holm-Bonferroni 规则通过；不能只用组件数量证明“更智能”；
- Agent 只询问阻塞歧义，可安全假设透明可改，协作模式不会越权；
- plan draft 可在执行前协商，旧 plan version 和旧确认不能继续提交；
- 每个步骤有输入、产物、观察和验证；
- 失败后能重试或重规划，不必整条重做；
- 软件重启后能恢复任务；
- response、stream、Trace、conversation 和 Execution Store 使用同一 run_id，attempt 历史完整；
- 所有副作用可追踪且默认幂等；
- 并发任务不会静默覆盖同一文档；
- 确认只授权固定 action、路径和文档版本；
- 页面刷新和断线重连不会丢失或重复步骤事件；
- 不可信网页、附件、文件和 Skill 不能扩大 Agent 权限；
- 长对话记忆事实和决策，而不是只保留最近文本；
- 文件变化会使旧记忆失效；
- 用户可以查看、纠正、导出和遗忘长期记忆；
- 项目记忆、图谱和运行数据严格隔离；
- 上下文按模型 token 和语义边界选择；
- 生成产物通过统一质量门后才进入保存流程；
- 用户能在会话中查看和控制 Agent；
- Agent 交互满足键盘、焦点、非纯颜色状态和 WCAG 2.2 AA 基线；
- SQLite migration、备份、保留期和磁盘清理策略可验证；
- commit journal 能在文件系统/SQLite 任一崩溃边界恢复一致状态；
- 记忆纠正能传播到所有检索投影，重建不会复活旧事实；
- CanonClaim 能正确表达剧情时间、有效区间、客观/角色视角和项目身份，正常剧情演变不会被误判为静态冲突；
- 主观质量建议未经授权不会自动改稿，Skill 创建包含正反例、dry-run 和路由碰撞检查；
- 反馈只有经过候选聚合、用户确认、版本化应用、回归评估和可撤销流程才改变长期偏好；
- 发布由量化 eval 门禁约束；
- Eval 结果包含可复现 manifest，并经过人工质量集校准；
- 未确认危险写入保持为 0。
- Windows CI、RC、签名、installed-build smoke、升级和回滚证据不能被 tag release 绕过。

## 19. 暂不实施事项

以下能力不进入 0.5.0：

- 多 Agent 并行协作；
- Agent 自行安装任意工具；
- Agent 自动或模型驱动的任意 shell 执行；现有用户手动 terminal 保留，但必须通过 P0 Electron/IPC 安全门禁；
- 自动修改和发布自身代码；
- 无预算的后台自治任务；
- 未经确认的跨项目写入；
- 把模型草稿直接写入 confirmed memory。

原因：这些能力会放大当前在状态恢复、成本控制和质量验证上的缺口。先完成单 Agent 可靠闭环，再评估多 Agent 的真实收益。

## 20. 下一步

按 15.0 台账从当前 P0 草稿继续，不重新开始，也不提前进入 P1：

1. 先以 E0 修复 `AgentTraceView` 未定义符号，完成 Workbench typecheck/build 和已有 run control 测试，只恢复可验证工作树，不把 Task E 标为完成；
2. 完成 A-C 前置：校准 `interrupted` attempt、白名单 `AgentRecoverableRequest`、稳定 project UUID、`chat/file_operation/chat_answer`、adapter 和 migration/兼容测试；
3. 修复 stale run 接管、pause completion race 和 renderer disconnect 语义，用真实子进程强杀证明“孤儿 attempt 结算 -> 同 ID resume -> 完成”；
4. 完成 `POST /api/agent/runs` 幂等创建、认证 NDJSON 补流、sequence 去重/缺口回读和 Confirmation 生命周期；
5. 把 CommitJournalService、write lease、fencing token 和 DocumentService 接入一条真实文件写入，确保任何 v2 路径无法绕过；
6. 再迁移批量正文/拆书检查点和 legacy job 映射，最后交付 session token、Electron/terminal hardening、CI/RC/签名/installed smoke 与 0.5.0 发布报告。

每完成一项都更新 15.0 状态和维护文档，但只在 A-H 全部满足退出条件后提交 `feat(agent): complete P0 durable execution` 阶段提交。中间如需保存可审阅进度，使用范围明确的实现提交，不把“focused tests 通过”写成 P0 已完成。

实现中发现契约与本文冲突时，先记录原因并更新计划，不在 runtime、shared 和 UI 中分别发明三套兼容语义。
