# ArcWriter 新 UI 统一实施方案

> 制定日期：2026-07-15
>
> 视觉样稿：`output/ui-final/`
>
> 产品定位：免费、小范围使用、本地优先的 AI 小说写作 Preview
>
> 实施方式：所有 UI 修改在一个批次内完成，开发中只做低成本阻断检查，最后执行一次集中验收
>
> 当前状态：历史 UI 批次与 2026-07-16 结构化资料库增量均已验收；旧验收统计不得用于替代第 13.5 节记录的本次结果。

## 1. 结论

`output/ui-final` 可以作为 ArcWriter 下一版的视觉和信息架构基线，但不能直接复制到生产代码。

原型的正文优先、小说任务分组、AI 上下文可见、审阅结果合并、迁移双确认和记忆二次确认方向正确；同时它仍是静态演示：17 个页面和样例数据集中在一个 React 文件内，没有接入 `WorkbenchController`、typed API、Electron/IPC、真实项目状态或持久化配置。

本轮实施必须遵循以下结论：

1. 保留原型的信息架构和视觉层级，复用现有 Workbench 的数据、Controller、IPC 和运行时能力。
2. 不以原型覆盖 `apps/workbench/src/App.tsx`，不导入 `output/ui-final/src/`。
3. AI 设置只换布局，不精简现有配置；`AppConfig` 中已有字段不得丢失、重置或串线。
4. 保留设置页 Embedding 连接测试，以及现有向量状态、索引、补全和召回测试功能。
5. 原型中没有真实后端支持的统计、评分、云同步、结构化大纲和模型测试不得使用假数据伪装为可用功能。
6. 原型的字号、对比度、响应式和无障碍问题先修正，再进入 Workbench。

## 2. 事实源优先级

实施发生冲突时按以下顺序裁决：

1. `packages/shared/src/` 中的 schema 和 API 契约；
2. 现有 Controller、Electron/preload IPC、runtime 和持久化行为；
3. `PRODUCT.md` 与 `docs/PROJECT_MAINTENANCE_HANDOFF.md`；
4. 现有可运行 Workbench 行为；
5. `output/ui-final` 的截图、README、静态 React 和 CSS。

原型是设计参考，不是功能事实源。原型文案与真实实现不一致时，必须修正文案或隐藏未实现操作，不能修改真实行为去迎合样例数据。

## 3. 不可变约束

### 3.1 功能与数据

- 所有可点击命令必须有真实 handler；没有后端契约的按钮不得以可用状态出现。
- 现有项目打开、创建、文档树、编辑、保存、查找替换、AI 对话、批量生成、拆书、伏笔、时间线、技能、审阅、记忆、后台任务和设置能力不得因换壳丢失。
- 不建立第二套会话、项目、配置或 Agent 状态；页面只能消费现有 Controller/IPC 状态。
- AI 生成内容继续先进入预览或草稿，写入目标、范围和覆盖方式必须可见。
- 跨项目迁移继续执行来源确认、目标确认和 diff 预览。
- `draft/proposed -> confirmed` 的记忆二次确认门禁不变。
- 普通 UI 不暴露原始 shell、任意包安装、IPC 参数或 Agent 内核修改入口。

### 3.2 AI 配置

- `manual_profile` 与 `website_profile` 必须隔离保存，切换模式不得互相覆盖。
- 保存必须 patch/merge 完整 `AppConfig`，禁止用精简表单对象替换配置文件。
- API Key 只能以密码框显示，错误和日志不得回显完整密钥。
- 当前密钥实际写入本机 `studio_config.json`；在真正接入系统凭据存储前，不得显示“仅保存在系统凭据库”。
- 当前 Embedding 使用远程兼容服务；在真正支持本地模型前，不得显示“本地 Embedding”或虚构 `text-embedding-local`。
- 预算事实源当前以 USD 记账；没有可靠人民币换算时不得显示虚构人民币费用。

### 3.3 测试与诊断

- `SettingsFeaturePage` 中真实的 Embedding 草稿连接测试必须保留。
- `VectorTestFeaturePage` 的状态刷新、重建索引、处理待嵌入、召回查询和结果展示必须保持可达。
- 可将向量测试入口迁到“设置 > AI 模型 > 连接与检索测试”，也可同时保留当前“状态”入口；不得隐藏或删除。
- 测试使用当前表单草稿值，不要求用户先保存；测试过程不得把草稿配置落盘。
- 配置字段变化后，旧的“连接成功”状态必须立即失效。
- 原型中的“默认写作模型测试连接”当前没有真实 API。本批不显示该按钮；若以后新增，必须单独实现 shared schema、typed API、runtime route、鉴权、超时、脱敏和测试，不能做假按钮。

## 4. 原型审阅结果

| 范围 | 结论 | 实施要求 |
| --- | --- | --- |
| 信息架构 | 可采用 | 保留“写作、规划、资料、审阅、工具、全局”分组 |
| 正文编辑层级 | 可采用 | 正文为主，章节树和 AI 侧栏可折叠 |
| AI 上下文与写入范围 | 可采用 | 绑定现有上下文选择与生成缓存，不复制状态 |
| 小说编辑室 | 可采用并补全 | 显示真实角色结果、合并摘要、证据、建议、冲突和 degraded/run 状态 |
| 设置页 | 不可直接采用 | 原型删减大量现有配置，并包含不实存储/Embedding 文案 |
| 交互 | 不可直接采用 | 绝大多数按钮、筛选、表格和状态为静态样例 |
| 响应式 | 不通过 | 固定 `min-width: 1120px`，窄窗口会裁切 |
| 字体与对比度 | 不通过 | 大量 7-10px 文本，弱文字颜色未达到 AA |
| 无障碍 | 不通过 | 多个图标按钮无名称，tab/toggle/progress 语义不完整 |
| 可维护性 | 不通过 | 682 行单文件页面和约 700 行原型 CSS 不能进入生产结构 |

## 5. 17 个页面的落地映射

| 原型页面 | 现有事实源 | 本批落地方式 | 禁止伪造 |
| --- | --- | --- | --- |
| 项目首页 `home` | project session、project chrome、最近项目与项目动作 | 新增轻量项目概览；只显示真实项目和真实动作 | 连续写作天数、虚构统计、未接通云同步 |
| 正文编辑 `editor` | `EditorFeaturePage`、文档树、标签、查找替换、保存与右栏 | 套用正文优先布局；章节树和 AI 右栏可折叠 | 未实现的富文本格式和虚假保存状态 |
| AI 助手 `assistant` | `ConversationFeaturePage` | 使用独立助手页复用现有会话与上下文；全局 `AssistantRail` 不再进入应用壳 | 第二套会话状态、自动直接覆盖正文 |
| 故事大纲 `outline` | `01_大纲` 文档及现有规划流程 | 首版提供大纲文档视图和快捷进入编辑 | 尚无契约的拖拽结构化节点 |
| 伏笔与时间线 `clues` | `LedgerFeaturePage`、`TimelineFeaturePage` | 同一页面用标签切换两个真实视图 | 虚构关联数和扫描结果 |
| 设定资料 `sources` | `lore.v1.jsonl` 主数据、人物/地点/势力/物品/世界规则投影 | 分类列表、详情、关系和人物弧光读写 JSONL；TXT 仅作兼容投影 | 未确认的 AI 内容直接写入设定或记忆 |
| 风格与题材 `style` | `style.v1.jsonl`、`genre.v1.jsonl` 主数据及各自投影 | 风格、规则、偏好、范文、题材和禁用表达读写 JSONL；右栏显示真实范文对照 | 虚构自动评分和未经确认的规则生效 |
| 小说编辑室 `studio` | `NovelAgentWorkspace` 的 `room` | 独立一级入口；补齐范围、进度、摘要、issue 证据/建议、冲突与差异 | 角色直接写文件、隐藏降级状态 |
| 全文审阅 `review` | `ConsistencyFeaturePage`、`full_consistency_scan`、`batch_chapter_quality` | 聚合一致性检查和真实后台报告 | 没有事实源的总分、历史趋势和问题数 |
| 项目记忆 `memory` | `MemoryGovernanceView`、Novel MemoryPanel | 合并治理和批量确认；增加“全选可确认项”和冲突跳转 | 主观/冲突项批量确认、draft 自动 confirmed |
| 拆书工作台 `disassembly` | `DisassembleFeaturePage` | 重排现有书库、分析、导入和结果区域 | 样例书名、章节数、报告进度 |
| 批量章节生成 `batch` | `BatchFeaturePage`、approved draft 后台任务 | 显示章节范围、真实预算、保存落点和任务进度 | 无真实换算的人民币预算、自动覆盖正文 |
| 素材迁移 `transfer` | Novel TransferPanel | 独立页面；使用项目选择器、类型/策略选择、diff 和双确认 | 固定路径、固定 `replace`、跳过双确认 |
| 创作工具 `skills` | `SkillFeaturePage`、Novel ToolsPanel | 聚合 Skill 与内置受控工具，清楚展示权限 | Agent 任意安装包或执行脚本 |
| 后台任务 `tasks` | Novel TasksPanel、现有 job/operation 状态 | 独立全局入口；本地化状态，显示进度、预算、错误和结果 | 无预算运行、退出后静默继续 |
| 设置 `settings` | `SettingsFeaturePage`、`AppConfig`、网站 AI 与 updater | 保留全部字段和动作，只重排为分组设置页 | 精简配置覆盖、静态“连接正常” |
| 关键状态 `states` | 各页面真实状态 | 不作为用户路由；拆为共用 Empty/Loading/Error/Conflict/WriteConfirm 组件 | 单独的演示页面进入正式导航 |

## 6. 目标信息架构

左侧导航固定为以下层级：

```text
写作
  项目首页
  正文编辑
  AI 助手
规划
  故事大纲
  伏笔与时间线
资料
  设定资料
  风格与题材
审阅
  小说编辑室
  全文审阅
  项目记忆
工具
  拆书工作台
  批量章节生成
  素材迁移
  创作工具
全局
  后台任务
  设置
```

`Agent Trace`、终端、原始日志等维护能力不放入普通主导航，但现有能力不删除。它们保留在“设置 > 高级诊断”或现有受控入口中。向量测试属于用户明确要求保留的配置验证能力，必须在“连接与检索测试”中显式可达。

## 7. 代码组织与改造边界

### 7.1 保持不变

- `WorkbenchController` 的单一状态来源；
- `packages/shared` 中现有请求/响应 schema；
- preload 暴露的最小 IPC bridge；
- runtime 的项目、文档、Agent、记忆和配置事实源；
- 保存预览、确认回执、预算、项目身份和 Negative Capability Gate；
- 现有 E2E 使用的稳定 `data-testid`，除非同一提交同步更新测试。

### 7.2 允许修改

| 路径 | 任务 |
| --- | --- |
| `apps/workbench/src/App.tsx` | 只保留路由组合和顶层状态；把被重做的内联页面移到对应 feature 文件 |
| `apps/workbench/src/layout/AppShell.tsx` | 新应用壳、窄窗口策略、主内容区语义 |
| `apps/workbench/src/layout/LeftSidebar.tsx` | 新导航分组、折叠、项目切换和键盘行为 |
| `apps/workbench/src/layout/RightRail.tsx` | 可折叠 AI 栏、上下文可见和写入范围展示 |
| `apps/workbench/src/features/**` | 按第 5 节映射重排真实页面；不复制 mock 数据 |
| `apps/workbench/src/features/novel-agent/NovelAgentWorkspace.tsx` | 拆分 room/tools/tasks/transfer/memory 子面板并补齐真实状态 |
| `apps/workbench/src/features/settings/SettingsFeaturePage.tsx` | 保留逻辑与字段，重排分组和测试入口 |
| `apps/workbench/src/styles.css` | 作为样式入口；迁移时移除失效规则，禁止整份原型 CSS 覆盖 |
| `apps/workbench/src/styles/` | 新增 tokens、shell、components 和 feature 样式文件，按入口显式导入 |
| `apps/desktop-shell/src/main/runtime/website-ai-routes.ts` 及测试 | 修正网站模式清空向量模型时仍沿用旧配置的问题 |
| `packages/config-service/src/service.ts` 及测试 | 只处理本方案明确列出的配置保存/readiness 一致性问题，不做通用重构 |
| `tests/e2e/` | 新增关键路由、配置保留、测试入口和响应式用例 |

### 7.3 建议新增的共用组件

```text
apps/workbench/src/components/ui/
  PageHeader.tsx
  SegmentedControl.tsx
  StatusBadge.tsx
  AsyncState.tsx
  ConfirmWriteDialog.tsx
  FieldGroup.tsx
```

只抽取至少被两个页面实际复用的组件。不得为了复刻原型建立与现有 Controller 平行的页面状态框架。

## 8. AI 配置完整保留矩阵

以下是 UI 修改的硬门槛，不是可选项。

| 区域 | 必须保留的字段/动作 |
| --- | --- |
| 模式 | `ai_config_mode: manual | website`；两份 profile 独立保存 |
| 手动主模型 | `api_key`、`base_url`、`model`、`temp`、`top_p` |
| 手动副模型 | `secondary_api_key`、`secondary_base_url`、`secondary_model`、`secondary_temp`、`secondary_top_p`；副 URL 为空时沿用主 URL |
| 模型行为兼容字段 | `model_thinking_enabled` 当前被 config-service/runtime 固定为启用；本批只保留磁盘兼容，不显示无效开关 |
| Embedding | `embedding_enabled`、`embedding_api_key`、`embedding_base_url`、`embedding_model` |
| 向量参数 | `embedding_timeout`、`embedding_batch_size`、`vector_top_k`、`vector_context_chars` |
| 联网搜索 | `web_search_enabled`、`web_search_provider`、`web_search_api_key`、`web_search_base_url`、`web_search_max_results`、`web_search_timeout`、`web_search_context_chars` |
| 搜索提供商 | Bing、自定义、DuckDuckGo；schema 已支持的值不能被 UI 强制改回 Bing |
| 写作/上下文 | `auto_lore_extract_enabled`、`humanizer_enabled`、`context_limit_chars` |
| 一致性 | `enable_consistency_revision`、`consistency_revision_score` |
| 授权 | `license_account_key` 及当前应用授权动作 |
| 网站模式 | 登录、账号、余额/用量、并发/RPM/TPM、文本模型、向量模型、`temp`、`top_p`、兑换、充值、刷新、应用配置 |
| 软件更新 | 保留当前检查、下载/安装状态和相关操作，不因设置页换壳删除 |
| 旧版顶层兼容 | 顶层主/副模型和 Embedding 兼容字段不作为第二套表单，但保存已知字段时不得主动清空 |
| 未知根字段 | 不在 UI/API 中承诺可编辑或回读；patch 保存已知字段时，磁盘上的无关根字段不得被删除 |

### 8.1 配置交互规则

1. 页面加载时读取完整 `AppConfig`，表单只 patch 被用户修改的字段。
2. 切换 `manual/website` 只切换当前编辑区，不清空另一份 profile。
3. 显示/隐藏密钥只改变输入框可见性，不修改值。
4. 保存、重启和再次进入设置后，所有用户可编辑的已知字段必须 round-trip 一致。
5. 网站模式选择空向量模型时，UI、`website-ai-routes.ts` 和持久化测试必须共同写入 `embedding_enabled: false` 与空 `embedding_model`，不能沿用旧状态或旧模型。
6. DuckDuckGo 必须成为真实可选项，不能在 UI 中被折叠成 Bing。
7. 副模型 URL 为空时，UI readiness 与 runtime 都按“沿用主 URL”判断。
8. Embedding 启用状态、配置就绪状态与索引外呼行为必须一致；关闭后重建只能建立关键词索引，不得发送 Embedding 请求。
9. 成功、失败、超时、鉴权和额度错误使用独立状态；不得默认显示成功。

## 9. 测试功能保留契约

### 9.1 Embedding 连接测试

现有调用链必须保持：

```text
SettingsFeaturePage
  -> WorkbenchController.testEmbeddingConnection
  -> typed API client
  -> POST /api/vector/test
  -> desktop runtime vector route
  -> EmbeddingClient.test()
```

实施要求：

- 使用表单当前的 enabled/key/base URL/model/timeout/batch 值；
- 测试中显示 busy、成功详情和可读错误；
- 许可拒绝时不触发下游网络请求；
- 不把 API Key 写入错误、trace 或 UI；
- key/base URL/model 任一变化后清除旧结果；
- 测试不依赖静态“已就绪”标签。

### 9.2 向量与索引测试

以下能力一项不减：

- 查看向量服务和索引状态；
- 重建项目索引；
- 处理待嵌入内容；
- 输入查询并执行召回；
- 查看召回文本、来源和必要的诊断信息；
- 刷新状态和展示失败原因。

入口调整后必须保留原有测试选择器或同步更新 E2E。普通写作页面不展示向量数值，但用户进入“连接与检索测试”后可以主动查看诊断。

### 9.3 本批不新增的测试按钮

主模型和副模型目前没有独立连接测试 API。本批为了效率不扩展该后端契约，设置页不显示原型中的主模型“测试连接”。网站模式继续使用现有登录、刷新和应用配置动作反映中转状态。

## 10. 视觉、响应式与无障碍标准

### 10.1 视觉基线

- 保留暖象牙正文面、冷灰导航、深墨正文和低饱和强调色；状态色不能承担唯一语义。
- 正文使用稳定的中文衬线字体，默认至少 16px；界面正文至少 13px，辅助文字至少 12px。
- 小型工具按钮可紧凑，但点击目标不得小于 24x24px，主要操作建议至少 32px 高。
- 卡片圆角不超过 8px；页面区块不做层层嵌套卡片。
- 不使用原型中的 3px 左侧状态色条；状态用图标、文字和背景共同表达。
- 颜色对比：普通文字至少 4.5:1，大文字和非文字控件至少 3:1。

### 10.2 桌面窗口策略

| 视口 | 行为 |
| --- | --- |
| `>= 1280px` | 完整侧栏、主内容、按需 AI 右栏 |
| `1024-1279px` | 侧栏可折叠；AI 右栏默认收起或覆盖显示；内容不横向裁切 |
| `< 1024px` | 导航和辅助栏改为抽屉；主任务占满；复杂表格可在自身容器内滚动 |

禁止在 `body` 或应用壳使用导致窗口内容不可达的固定 `min-width: 1120px`。集中验收至少覆盖 1024x720、1280x720、1440x900。

### 10.3 交互语义

- 图标按钮必须有 `aria-label` 和 tooltip；
- tab 使用 `role=tablist/tab/tabpanel`、`aria-selected`，支持方向键切换；
- toggle 优先使用 checkbox/switch 语义；
- 进度使用原生 `progress` 或完整 ARIA 值；
- dialog 具备标题、焦点圈定、Esc 关闭和关闭后焦点恢复；
- 所有 loading/error/empty/success 状态不改变固定工具栏和主要布局尺寸；
- 支持 `prefers-reduced-motion`，焦点样式始终可见。

## 11. 单批次实施清单

以下编号只表示依赖顺序，不形成多轮验收、发布或提交。

### UI-00 冻结契约

- [x] 记录 `CenterFeature`、现有入口、controller 方法、IPC 方法和关键 `data-testid`。
- [x] 复用完整配置 round-trip 与未知根字段测试，补充 manual、website、Embedding 和搜索交互验证。
- [x] 确认原型中每个按钮属于“接真实能力、隐藏、只读状态”中的一种。
- [x] 未扩展 shared/IPC 契约，只修复第 8.1 节已确认的配置一致性问题。

### UI-01 应用壳和导航

- [x] 实现第 6 节导航分组和项目切换区。
- [x] 保留现有项目树/拆书树切换、标题信息、全局任务和设置入口。
- [x] 实现 AI 侧栏折叠，以及窄窗口下项目树/AI 栏隐藏和主导航图标化。
- [x] 建立 tokens、排版、按钮、表单、状态和滚动容器基线。

### UI-02 写作主路径

- [x] 落地项目首页，只显示真实项目状态和动作。
- [x] 重排正文编辑器，确保正文、文档树、标签、查找替换、保存冲突均可用。
- [x] AI 侧栏可收起，保留上下文、写入范围和预览/确认动作。
- [x] AI 助手复用现有 Conversation 状态；正式入口会主动展开 AI 侧栏。

### UI-03 规划和资料

- [x] 大纲页映射真实 `01_大纲` 文档。
- [x] 伏笔与时间线整合为分段视图，保留各自 controller 行为。
- [x] 设定资料、风格与题材升级为 JSONL 主数据与 TXT 兼容投影；首次旧文件导入和投影冲突均要求用户确认。
- [x] 未实现的结构化拖拽和自动统计不进入可点击 UI。

### UI-04 审阅和记忆

- [x] 将小说编辑室提升为主导航页面，五个现有子视图保持独立可达。
- [x] 审阅结果显示 `merged_summary`、issue suggestion/evidence、冲突、run 和 degraded 状态。
- [x] 全文审阅只展示真实一致性结果和后台报告。
- [x] 记忆页增加“选择全部可确认项”，主观和冲突项保持逐条确认。
- [x] 保留加载、无项目、空结果、错误和重试的真实状态反馈。

### UI-05 小说工具和任务

- [x] 重排拆书、批量生成、素材迁移、创作工具和后台任务页面。
- [x] 迁移页使用真实项目选择、内容种类、目标路径、策略和 diff；不再固定为人物设定加 replace。
- [x] 后台任务本地化状态，显示预算、已用量、错误、结果、暂停/恢复/取消。
- [x] 工具页只允许现有白名单工具和 typed action，不出现任意安装或 shell。

### UI-06 设置和测试

- [x] 按第 8 节逐项迁移设置页，保持全部可编辑已知字段 round-trip；`model_thinking_enabled` 仅兼容保留，不显示无效开关。
- [x] 保留网站模式登录、状态、余额、模型、向量模型、兑换、充值、刷新和应用。
- [x] 补齐 DuckDuckGo 选择、副 URL 回退和网站向量关闭交互；同步修改 `website-ai-routes.ts` 及其契约测试。
- [x] 保留 Embedding 连接测试，并让测试状态随字段变化失效。
- [x] 将完整 VectorTest 功能放入明确可达的“连接与检索测试”。
- [x] 保留授权和软件更新区域。
- [x] 删除“系统凭据库”“本地 Embedding”和静态“连接正常”等不实文案。

### UI-07 状态、响应式与可访问性

- [x] 不创建正式 `states` 路由，继续使用真实页面状态。
- [x] 完成三档桌面窗口布局，自动检查页面级横向溢出并进行真实截图检查。
- [x] 修正颜色对比、字号、焦点、tab/dialog/progress/toggle 语义。
- [x] 为导航和诊断图标补 tooltip 和 accessible name。
- [x] 加入 reduced-motion 样式。

### UI-08 收口

- [x] 新 UI 使用末端主题覆盖保持旧维护入口兼容，未复制原型 mock 组件或 CSS。
- [x] 搜索静态样例书名、虚构费用、默认成功状态和假按钮，生产代码未引入这些内容。
- [x] 检查所有新增页面只读取真实 controller/IPC 数据。
- [x] 更新 `docs/PROJECT_MAINTENANCE_HANDOFF.md`，记录新导航、配置测试入口和最终验收结果。

## 12. 高效开发规则

本批采用“完成修改后集中验收”，避免每改一个页面就重复执行全矩阵。

开发期间只允许以下低成本检查：

1. TypeScript 出现结构性改动后运行一次 Workbench 定向 typecheck；
2. 某个失败阻断继续开发时，只运行与该失败直接相关的单个测试；
3. 每个逻辑批次结束运行 `git diff --check`；
4. 不在 17 个页面之间循环执行完整 build、E2E、Desktop smoke 或根级验收。

所有页面、配置和测试接线完成后，再进入第 13 节。集中验收失败时只定向复验失败项；已经通过的前置矩阵不重复执行，继续补齐尚未运行的尾部门禁。

## 13. 集中验收

### 13.1 自动化用例必须新增

- 17 个目标入口中，16 个正式页面可达；`states` 不进入正式导航。
- 项目首页、正文、AI 助手、编辑室、记忆、任务和设置至少各覆盖一条真实操作路径。
- manual/website 双 profile 预置后，切换、保存、重启均不串线、不丢字段。
- 主/副模型、Embedding、联网搜索、授权和一致性已知字段 round-trip；patch 保存不删除无关根字段。
- Embedding 测试覆盖 busy、成功、401/许可拒绝、超时和字段变化后状态失效。
- 向量测试覆盖状态、重建、处理待嵌入和召回。
- Embedding 关闭后重建索引不发送向量网络请求，关键词能力仍可用。
- 迁移双确认和记忆二次确认门禁不回退。
- 1024x720、1280x720、1440x900 无页面级横向溢出、文字遮挡和不可达命令。
- 侧栏、tab、dialog 和主要表单可仅用键盘完成操作。

浏览器用例放入 `tests/e2e/`，配置与 runtime 契约用例放在对应 package 的现有测试文件旁，Desktop 独有 IPC 行为由 Desktop smoke 覆盖。

### 13.2 唯一完整命令

全部实现和新增用例完成后执行：

```powershell
npm run acceptance:preview
```

该命令必须继续覆盖 workspace typecheck、单元/契约测试、eval、Workbench/Desktop build、Browser E2E、Desktop smoke 和 `git diff --check`。若在后段失败，允许定向复验失败项并单独补跑未执行的尾部门禁，避免重复执行已经通过的前置矩阵。

### 13.3 最短人工检查

自动化通过后只做一次短检查；本项目为免费小范围 Preview，不要求每次提交使用真实付费模型或 Embedding 凭据：

1. 打开现有小说项目并编辑、保存一个测试章节；
2. 打开和收起 AI 侧栏，确认上下文及写入目标可见；
3. 进入小说编辑室、后台任务、记忆和迁移页面，确认真实数据与高风险确认存在；
4. 切换 manual/website 设置，确认字段回填；
5. 确认 Embedding 连接测试和向量检索测试入口可达；真实外部连接按用户当前配置选做；
6. 调整到 1024x720 和 1440x900，确认无重叠、裁切和不可达按钮。

### 13.4 历史验收结果（2026-07-15）

- 全 workspace typecheck 通过；Vitest 112 个文件、880 项测试通过；3 项 Node 测试通过。
- routing、planning、memory、quality、recovery、security、novel-agent、excluded-capabilities 共 8 类 eval manifest 通过；`novel-agent` 19/19。
- Workbench 与 Desktop build 通过；新增网站向量关闭和关键词索引回归测试通过。
- Browser E2E 共 8 项：16 个正式入口、设置保留项和三档溢出检查通过；首次矩阵中 3 个旧会话用例因 1280 宽默认折叠 AI 侧栏失败，修复“AI 助手”正式入口后定向复验 3/3 通过，其余 5 项在原矩阵已通过。
- Playwright 真实截图检查覆盖 1440x900 编辑器/设置和 1024x720 设置页，无重叠、裁切或页面级横向溢出；截图为临时验收产物，未提交。
- Desktop smoke 通过（Electron 42.3.0、node-pty、node:sqlite）；最终 `git diff --check` 通过。
- 为效率未重复执行已通过的 880 项测试和 8 类 eval；上述证据共同覆盖 `acceptance:preview` 的全部阶段。

### 13.5 结构化资料库增量验收（2026-07-16）

本节只覆盖本次新 UI 与资料保存适配，不复跑商业化或发布验收。

1. 运行 `npm run acceptance:ui-library`：shared/document/vector/agent/desktop/workbench 类型检查，资料库、图谱、生成草稿、Desktop runtime route 和既有 agent-runtime 定向测试，Workbench build 与 diff check。
2. 在 Desktop 中打开一个项目：分别进入“设定资料”“风格与题材”，确认没有旧全局 AI 工具栏，且两页不显示静态 mock 数据。
3. 在 1440x900 与 1280x720 检查列表、详情、草稿确认条和右侧效果预览，无横向溢出、重叠或不可达按钮。
4. 用一个旧 TXT 项目验证迁移预览；确认导入后检查 JSONL 和投影；手工改写投影后验证冲突提示；生成一次 AI 内容并在页面确认草稿后验证投影更新。

实际结果：2026-07-16 最终 `npm run acceptance:ui-library` 通过，包含 6 个 workspace 定向 typecheck、5 个测试文件共 132 项测试、Workbench production build 和 `git diff --check`。测试覆盖资料库服务/图谱/Agent/Desktop route；浏览器可加载新工作台外壳并确认旧全局 AI 栏已移除。直接浏览器访问 runtime 被 Electron IPC 的认证/CORS 边界拒绝，未绕过该安全设计。随后在 Desktop renderer 的隔离 smoke 项目中完成手工复验：旧风格/题材 TXT 先显示迁移确认，确认后新增题材素材同步写入 `genre.v1.jsonl` 和 `题材素材.txt`；新建人物设定同步写入 `lore.v1.jsonl` 和 `人物设定.txt`，默认标题首次输入会被替换而非拼接。1440x900 与 1280x720 下资料列表、详情、草稿确认条和题材预览均可达，未见旧全局 AI 工具栏、重叠或横向溢出。

## 14. 完成定义

本计划的原始 17 页 UI 交付已完成，后续增量按第 13.5 节独立验收，不回退到商业化发布矩阵。结构化资料库增量只有同时满足以下条件，才能标记为“已完成”：

- JSONL 是 UI 的唯一主编辑源，所有对应 TXT 投影可由它完整重建；
- 旧 TXT 导入、投影冲突恢复与 AI 草稿确认门禁保持可用；
- 设定资料可展示人物、地点、势力、物品、世界规则、关系和人物弧光；风格与题材可展示档案、规则、偏好、范文、参考素材、题材素材、冲突模板和禁用表达；
- `acceptance:ui-library` 通过，包含服务、Desktop route、Workbench build 和 diff check；
- 仅在 Desktop renderer 内完成一次 1440x900 与 1280x720 人工检查，不要求重跑 `acceptance:preview`、商业化 E2E、发布或外部模型实测；
- 维护交接已回填实际命令、结果和剩余限制。

## 15. 本批非目标

为控制复杂性和实施时间，本批不做：

- 直接发布或托管 `output/ui-final` 原型；
- 主模型/副模型连接测试新 API；
- 系统凭据库迁移；
- 本地 Embedding 引擎；
- 云同步服务；
- 没有数据契约的写作连续天数、全文评分和趋势统计；
- 结构化可拖拽大纲后端；
- 移动端或 Web 营销页；
- 通用编程、运维、任意 shell 或任意工具安装能力；
- 商业级签名、海量数据集、长时 soak 和正式发布证据。

这些事项以后如需实施，应单独建立契约和计划，不能以补 UI 的名义混入本批。
