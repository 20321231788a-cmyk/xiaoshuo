# ArcWriter 小说创作 Agent 统一修改方案

> 制定日期：2026-07-14
>
> 产品定位：免费、小范围使用、本地优先的 AI 小说创作软件
>
> 实施方式：七项能力一次性完成修改，全部结束后只执行一次集中验收
>
> 当前状态：七项受控能力已完成代码、UI 和测试接入，唯一集中验收已通过

## 1. 目标

本轮只增强小说创作能力，不把 ArcWriter 改造成通用编程 Agent、系统运维 Agent 或无人监管的自治平台。

Agent 的核心任务固定为：选题与立意、大纲、细纲、章纲、正文续写、人物弧光、世界观、伏笔、节奏、文风、一致性检查、修订建议、素材整理和小说项目记忆。任何新增能力都必须能说明它怎样改善上述流程，否则不进入本轮。

七项内容统一进入一个修改批次。下文的编号只表示依赖顺序，不形成七轮开发、七轮提交或七轮验收。

## 2. 总体约束

1. **小说域优先。** 所有可执行任务必须归类为 `novel_creation`，并绑定当前小说项目。
2. **主 Agent 负责最终决策。** 子 Agent、工具和后台任务只能提交结构化建议或草稿，不能直接提交文件副作用。
3. **系统权限不交给模型。** 模型不能获得原始 shell、包管理器、Electron 主进程对象或更新发布凭据。
4. **所有副作用可预览、可确认、可追踪、可回滚。**
5. **预算永不省略。** 每个 run 必须有 step、model call、token、费用、时间和 deadline 上限。
6. **项目边界默认关闭。** 跨项目读取或写入只能通过专用迁移工作流和双项目确认。
7. **记忆仍需二次确认。** 批量确认可以提高效率，但每条内容、来源 revision 和 hash 必须可见并被确认。
8. **当前硬门禁持续生效。** 受控替代能力通过验收不等于解锁原始高风险入口，现有 `NegativeCapabilityPolicy` 继续拒绝七项未受控能力。

## 3. 七项能力的受控形态

| 原始方向 | 本轮目标 | 仍然禁止 |
| --- | --- | --- |
| 多 Agent 并行协作 | 固定小说编辑室角色并行分析，由主 Agent 合并 | 任意生成 Agent、子 Agent 直接写文件、角色无限递归委派 |
| Agent 安装工具/库 | Agent 提交小说工具安装申请，用户从内置白名单确认 | `npm/pip` 任意包、远程脚本、模型决定版本或来源 |
| Shell/代码执行 | 小说维护动作映射为类型化 Electron/IPC 命令 | 原始命令字符串、renderer/model 直接 spawn、下载后执行 |
| 修改/发布自身内核 | Agent 生成 Skill/Prompt/规则草稿，用户确认后版本化导入 | 修改 runtime 源码、自动构建发布、掌握更新密钥 |
| 后台自治 | 有预算、可暂停的小说后台任务 | 无预算、无 deadline、退出应用后偷偷运行、无限重试 |
| 跨项目写入 | 专用“素材/设定迁移”流程，预览差异并双重确认 | 普通 Agent Action 指定其他项目、确认重放、路径绕过 |
| draft 进入 Confirmed Memory | 可批量审核 draft/proposed，再逐条生成确认回执 | 模型直接写 confirmed、模糊全选、来源/hash 变化后继续提交 |

## 4. 小说多 Agent 编辑室

### 4.1 固定角色

第一版只允许以下角色，不提供自由创建角色：

| 角色 | 职责 | 输出 |
| --- | --- | --- |
| 主笔 Agent | 理解用户目标、拆解任务、合并最终方案 | 最终计划、正文草稿、保存提案 |
| 剧情 Agent | 检查冲突、节奏、爽点、伏笔和章节推进 | `PlotReview` |
| 人物 Agent | 检查动机、人物弧光、关系和口吻 | `CharacterReview` |
| 连续性 Agent | 对照大纲、设定、时间线和 Confirmed Memory | `ContinuityReview` |
| 文风 Agent | 检查视角、语气、句式和项目文风 | `StyleReview` |

单次任务最多并行三个审校角色。主笔是唯一协调者和唯一保存提案发起者；审校角色只能读当前项目的已授权上下文并返回严格 schema，不持有文件写入、工具安装、terminal、跨项目或 memory confirm 权限。

### 4.2 协作流程

```text
用户小说任务
  -> 主笔生成 NovelTaskPlan
  -> 选择 0～3 个固定审校角色并行分析
  -> 主笔按证据合并，冲突项展示给用户
  -> 质量门与一致性检查
  -> 保存预览
  -> 用户确认后提交
```

角色结论冲突时不得多数投票自动覆盖。主笔必须列出冲突、引用的项目证据和建议选择；涉及剧情方向或人物设定时交由用户决定。

## 5. 小说工具目录

新增只读 `NovelToolCatalog`。工具包必须随应用发布或来自应用维护者配置的固定源，并包含：

- tool ID、版本、sha256、兼容版本；
- 小说用途和允许的输入/输出 schema；
- 网络、文件和模型权限声明；
- 安装/卸载脚本的产品内置实现 ID；
- 回滚版本和数据迁移说明。

Agent 只能调用 `propose_tool_install(tool_id, version, reason)`。Electron 主进程验证白名单和 hash，Workbench 展示权限差异，用户确认后由类型化 IPC 安装。模型不能提供 URL、包名、脚本或安装参数。

第一批工具只考虑小说 tokenizer、epub/txt 导入、离线分词、格式转换和本地索引，不引入编译器、通用代码执行器或系统管理工具。

## 6. 类型化 Electron/IPC 动作

不提供 `shell.execute(command)`。新增小说专用动作：

- `novel.backup_project`
- `novel.export_project`
- `novel.rebuild_index`
- `novel.import_material`
- `novel.convert_document`
- `novel.open_project_folder`

每个动作使用 shared zod schema，主进程自行构造参数并限制路径；renderer 和模型都不能传原始 executable、shell、argv、环境变量或工作目录。用户手动 terminal 继续使用独立真实手势票据，不进入 Agent Action Registry。

## 7. 可控自我改进

Agent 的“自我改进”只允许生成以下草稿：

- 小说 SkillSpec；
- Prompt 模板；
- 文风规则；
- 质量 rubric 候选；
- 路由示例和正反例。

草稿必须经过 dry-run、路由碰撞检查、小说 fixture 回归和用户确认后，作为项目级版本化配置导入。运行中的 Agent 不能修改 TypeScript、Electron main/preload、`NegativeCapabilityPolicy`、更新服务或发布 workflow。

应用内核更新仍由 updater 完成。Agent 最多提示“存在新版本”，不能下载、安装、发布或签名自身内核。

## 8. 有预算后台小说任务

新增 `NovelBackgroundTask`，仅允许：

- 全书一致性扫描；
- 人物/伏笔/时间线索引重建；
- 批量章节质量报告；
- 用户已选素材的整理与摘要；
- 已确认计划的章节草稿生成。

每个任务必须持久化：project ID、task kind、输入 revision、最大章节数、step/replan/model-call 上限、token/费用上限、deadline、重试次数和用户授权 receipt。

应用退出时任务安全暂停，下次启动由用户选择是否恢复。达到任何预算上限时进入 `paused_budget_exhausted`，禁止自动追加预算。

## 9. 跨项目素材与设定迁移

普通 Agent Action 继续只能写当前项目。跨项目操作只能走 `NovelProjectTransfer`：

1. 用户显式选择来源项目和目标项目；
2. 主进程解析两个稳定 project UUID 和 canonical root；
3. Agent 只生成迁移清单和冲突建议；
4. Workbench 展示来源、目标、diff、覆盖策略和记忆影响；
5. 用户确认来源读取和目标写入；
6. 主进程签发绑定双项目 UUID、路径、revision、hash 和 expiry 的一次性 receipt；
7. CommitJournal 原子提交，失败时回滚或可恢复。

第一版只允许迁移用户选中的人物设定、世界观、文风规则和参考素材，不允许迁移运行数据库、API Key、会话、预算、确认回执或整个 `.agent` 目录。

## 10. Confirmed Memory 审核

保持 `draft -> proposed -> confirmed`。为了提高长篇创作效率，新增批量审核 UI，但不得降低确认强度：

- 每条 claim 显示类型、内容、来源文件、source revision、故事时间、视角和冲突；
- 批量确认前展示完整条目数和将被覆盖的旧 claim；
- receipt 逐条绑定 claim ID、project ID、source revision 和 content hash；
- 任一来源或内容变化，该条 receipt 失效；
- 主观推断、人物心理猜测和未来剧情建议默认不能批量确认；
- 用户可纠正、撤销、遗忘，投影重建不能复活旧值。

## 11. 代码修改范围

预计集中修改：

| 层 | 主要内容 |
| --- | --- |
| `packages/shared` | NovelTaskPlan、角色审校结果、工具申请、IPC 动作、后台任务、跨项目迁移和批量 memory receipt schema |
| `packages/agent-runtime` | NovelRoomCoordinator、只读角色运行器、能力策略、预算、合并器、迁移计划和 memory promotion |
| `apps/desktop-shell/src/main` | 工具目录、类型化 IPC、后台任务 owner、双项目 identity/receipt 和 updater 边界 |
| `apps/desktop-shell/src/preload` | 最小 IPC bridge，不暴露 shell/Node/Electron 对象 |
| `apps/workbench` | 编辑室进度、冲突审阅、工具权限、后台任务、迁移 diff、批量记忆确认 |
| `scripts` / `tests` | novel-domain eval、负向能力回归、E2E 和单次验收入口 |

## 12. 单批次实施顺序

以下只是依赖顺序，期间不做阶段验收：

1. 冻结小说域 intent、schema、role/tool/action allowlist 和数据库 migration；
2. 实现只读角色运行器、主笔合并器和统一预算；
3. 实现工具申请与类型化 IPC，不接入任意包管理器或 shell；
4. 实现后台小说任务和安全暂停/恢复；
5. 实现跨项目迁移清单、双确认和 journal；
6. 实现批量 Confirmed Memory 审核；
7. 接入 Workbench 的编辑室、权限、任务、迁移和记忆界面；
8. 一次性补齐 unit、eval、E2E、smoke、回滚和维护记录；
9. 全部修改结束后执行第 13 节集中验收。

实施期间只允许三类最小检查：编译阻断、migration 数据风险、安全疑似 fail-open。最小检查不计入最终验收，也不扩展为全量回归。

## 13. 唯一集中验收

本轮沿用唯一入口，并在实现时把新增测试接入该命令：

```powershell
npm run acceptance:preview
```

最终命令必须覆盖：

- 全 workspace typecheck 和单测；
- `eval:all` 及新增小说协作/工具/后台/迁移/记忆 fixture；
- Workbench/Desktop build；
- Browser E2E 和 Desktop smoke；
- `eval:excluded-capabilities`，验证所有未受控原始入口仍为零成功；
- `git diff --check`。

首次完整矩阵失败后只定向修复失败项。所有失败修复完成后，再完整运行一次矩阵并把结果写入维护手册。

## 14. 验收用例

### 14.1 小说创作质量

- 同一章由剧情、人物、连续性角色并行审校，主笔引用证据合并；
- 角色冲突不会自动覆盖用户设定；
- 生成内容遵守章纲、人物口吻、视角、时间线和项目文风；
- 与非小说通用任务混合时，不扩大权限或偏离当前项目。

### 14.2 权限与安全

- 子 Agent 无写入、安装、terminal、跨项目和 memory confirm 权限；
- 任意 npm/pip、URL、脚本和 shell 字符串均被拒绝；
- 类型化 IPC 路径穿越、symlink/junction、参数注入均失败；
- Agent 无法修改 runtime、preload、策略、workflow 或 updater；
- 缺少预算的后台任务不能创建或恢复；
- 普通写入不能使用其他 project ID；
- draft/proposed 无有效二次确认不能进入 confirmed。

### 14.3 恢复与一致性

- 并行角色中任一失败时主笔可降级，不重复模型调用或文件副作用；
- 应用退出后后台任务暂停，恢复沿用原预算和输入 revision；
- 跨项目迁移在 journal 各边界崩溃后只有完整旧状态或完整新状态；
- receipt 不能跨 run、角色、项目、路径、revision 或内容 hash 重放。

## 15. 完成定义

只有同时满足以下条件，才可以把本方案标记为完成：

- 固定小说角色协作已进入真实写作流程，而非仅存在类或 schema；
- 所有受控能力均有产品 UI、主进程执行、持久状态、回滚和负向测试；
- Agent 仍以小说大纲、正文、人物、世界观、伏笔、文风和一致性为主要工作面；
- 原始任意安装、任意 shell、自改内核、无预算自治、越权写入和草稿直升 confirmed 仍不可达；
- `--safe-agent` 能关闭新能力并停止自动恢复；
- `npm run acceptance:preview` 在最终工作树通过；
- `docs/PROJECT_MAINTENANCE_HANDOFF.md` 已记录真实结果和未完成项。

当前实现对应关系：

| 能力 | 已落地入口 |
| --- | --- |
| 固定角色协作 | `NovelRoomCoordinator` + Workbench“小说 Agent / 编辑室” |
| 内置工具目录 | `NovelAgentControlService` + hash/版本校验 + 真实手势激活 |
| 类型化动作 | `novel:*` preload/IPC + main 自行构造备份、导入、转换和索引参数 |
| 可控自我改进 | 复用现有 Skill 草稿、dry-run、版本和回滚入口，小说编辑室直接跳转 |
| 预算后台任务 | userData 持久任务、deadline/step/token/cost 字段、退出暂停、用户恢复 |
| 跨项目迁移 | 双 UUID、revision/hash、diff、双确认、持久恢复 journal |
| 记忆批审 | 逐 claim hash/revision/receipt，主观与未来剧情条目排除批量确认 |

原始 `agent.spawn`、`npm/pip`、任意 shell、runtime 自改/发布、无预算自治、普通跨项目写入和 draft 直升 confirmed 仍由 `NegativeCapabilityPolicy` 拒绝。

集中验收结果（2026-07-14）：

- `npm run acceptance:preview` 通过；
- 全 workspace typecheck 通过；
- Vitest 112 个测试文件、878 个测试全部通过，另有 3 个 Node 测试通过；
- 8 个 eval manifest 全部通过，`novel-agent` 19/19；
- `excluded-capabilities` 116/116 通过；
- Workbench build、Desktop build、Browser E2E 6/6 和 Desktop smoke 全部通过；
- `git diff --check` 通过。

## 16. 回滚

新增能力统一受一个产品级 `novel_agent_room_v1` 总开关和细分 Flag 控制。`--safe-agent` 优先级最高。回滚时：

1. 停止接收新编辑室和后台任务；
2. 活动任务在检查点暂停；
3. 禁用角色协作、工具申请、后台调度和跨项目迁移；
4. 保留数据库、receipt、Trace 和草稿，不执行破坏性降级；
5. 单 Agent 小说写作、现有项目和手动 terminal 继续可用。
