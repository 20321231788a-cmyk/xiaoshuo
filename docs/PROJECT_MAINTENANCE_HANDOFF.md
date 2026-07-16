# ArcWriter 项目维护交接

> 更新：2026-07-16
>
> 当前版本：`0.9.0`（Preview 渠道）
>
> 定位：免费、小范围使用的 AI 小说写作 Preview，不按商业软件验收

## 1. 当前结论

0.5.0～0.9.0 已合并为一次交付，不再维护五套开发和验收周期。P0～P7 及小说 Agent 七项受控替代能力保持既有集中验收结论；本次“新 UI 资料库适配”作为独立增量，使用本章定义的 `acceptance:ui-library` 集中验收，不回填或复用旧 UI 验收统计。普通 Desktop 启动默认启用集成 Preview 配置，`--safe-agent` 可一键回退。

Agent 当前执行口径只认两份文档：

| 文档 | 职责 |
| --- | --- |
| `docs/PROJECT_MAINTENANCE_HANDOFF.md` | 唯一维护事实源，记录当前代码、命令、验收和交接状态 |
| `docs/AGENT_NOVEL_CREATION_MODIFICATION_PLAN.md` | 小说创作 Agent 七项受控能力的实现契约和集中验收方案 |

旧 `AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md` 和 `AGENT_OPTIMIZATION_NEXT_IMPLEMENTATION_MANUAL.md` 已删除，不再作为执行依据。
`AGENT_FILE_REFERENCE_AND_SKILL_UPGRADE_PLAN.md` 只保留 2026-07-07 已完成工作的历史记录，不属于当前计划。

本批全部修改完成后已运行唯一集中验收：

```powershell
npm run acceptance:preview
```

该结果只用于 Preview 代码验收。签名、950 条商业数据集、sealed holdout、1000 次故障注入、2 小时 soak、固定设备性能、盲评和正式 release evidence 均为未来商业化事项。

## 2. 快速开始

```powershell
cd D:\xiaoshuo\ts-migration
npm install
npm run dev:desktop
```

常用命令：

| 目的 | 命令 |
| --- | --- |
| 启动 Workbench | `npm run dev:workbench` |
| 启动 Desktop | `npm run dev:desktop` |
| 安全模式 | `npm run dev:desktop -- --safe-agent` |
| 本批 UI 资料库集中验收 | `npm run acceptance:ui-library` |
| Preview 全量验收（发布前才需要） | `npm run acceptance:preview` |
| 无签名安装包 | `npm run dist -w @xiaoshuo/desktop-shell` |

本地 runtime 默认是 `http://127.0.0.1:18453`。受保护调用必须经 preload/IPC 获取会话能力，renderer 不得直接拼接认证信息。

## 3. 架构入口

| 范围 | 路径 |
| --- | --- |
| Electron main/preload/runtime | `apps/desktop-shell/src/` |
| React 工作台 | `apps/workbench/src/` |
| API 与 IPC schema | `packages/shared/src/` |
| Typed API client | `packages/api-client/src/` |
| Agent、run、记忆、上下文、质量门 | `packages/agent-runtime/src/` |
| 文档与安全写入 | `packages/document-service/src/` |
| 生成缓存 | `packages/generated-cache/src/` |
| Browser E2E | `tests/e2e/` |
| Windows workflow | `.github/workflows/` |

持久事实源：

- durable run：项目内 `00_设定集/.agent/agent_runs.sqlite3`；
- governed memory：项目内 `00_设定集/.agent/governed_memory.sqlite3`；
- generated cache：项目内 `00_设定集/.agent/generated_cache/`；
- 项目身份：manifest 稳定 UUID + canonical path/file identity；
- AI 配置：本机 `studio_config.json`。

UI state、进程内 Map 和 Trace 不是持久事实源。

## 4. Preview 配置

Desktop 普通启动默认开启：durable execution、Model Gateway、replanning、context budget、governed memory、memory selector、quality gate、event stream 和 inline plan UI。

配置入口：`apps/desktop-shell/src/main/agent-feature-flags.ts`。

规则：

- 合法持久覆盖可关闭产品能力；
- 非法配置文件 fail closed，全部关闭且不自动恢复；
- `--safe-agent` 最高优先级，全部关闭但不改写 userData；
- runtime 通用库默认仍为关闭；
- 安全控制和七项原始高风险能力不能通过普通 Feature Flag 直接解锁。

## 5. 小说 Agent 七项受控能力

当前 `0.9.0` 仍硬禁用以下原始能力：

1. 多 Agent 并行协作；
2. Agent 自行安装工具/库；
3. Agent 或模型执行任意 shell/代码；用户手动 terminal 必须有真实用户手势并走 Electron/IPC；
4. Agent 修改并发布自身内核；
5. 无预算后台自治；
6. 未确认跨项目写入；
7. draft 未经二次确认进入 Confirmed Memory。

关键实现位于 `packages/agent-runtime/src/negative-capability-policy.ts`、`action-executor.ts`、main-process terminal 授权、持久预算、项目身份和 governed-memory confirmation receipt。

同一批次已经实现以下受控替代路径：

| 能力 | 目标形态 |
| --- | --- |
| 多 Agent | 固定剧情、人物、连续性、文风角色最多三个只读并行审校，主笔合并 |
| 工具安装 | 内置小说工具白名单、hash/版本校验、真实手势确认；“安装”只激活随应用发布的工具 |
| Shell/代码 | 小说专用类型化 Electron/IPC 动作；schema 不接受 executable、shell、argv、环境或源/目标执行路径 |
| 自我修改 | 只生成 Skill/Prompt/rubric 草稿，不能修改或发布运行内核 |
| 后台自治 | 持久化 token/费用/时间/步骤预算，退出暂停，恢复沿用原预算和输入 revision |
| 跨项目写入 | 用户选择双项目、预览 diff、双确认、持久 journal 提交和崩溃恢复 |
| Confirmed Memory | 保持二次确认，提供逐条 receipt 的批量审核 UI |

Workbench 入口为主导航“小说编辑室”；后台任务、素材迁移和项目记忆也有独立正式入口。主进程事实源为 userData `state/novel-agent-control.json`，迁移恢复备份位于目标项目 `00_设定集/.agent/transfer-journals/`。详细契约见 `docs/AGENT_NOVEL_CREATION_MODIFICATION_PLAN.md`。

## 6. 验收与失败处理

开发中不重复跑根级验收。小说 Agent 计划的所有修改结束后已执行：

```powershell
npm run acceptance:preview
```

执行过程中仅定向重跑失败项；所有失败修复后完成了一次最终总验收。新增小说多 Agent、工具、IPC、后台任务、跨项目迁移和记忆审核测试均已接入该命令。

当前结果：全 workspace typecheck 通过；Vitest 112 个测试文件、881 个测试通过；3 个 Node 测试通过；8 个 eval manifest 通过，其中 `novel-agent` 19/19；Workbench/Desktop build 通过；Browser E2E 10/10；Desktop smoke 通过；`git diff --check` 通过。原始七项高风险入口仍不可达。

以上统计是 2026-07-15 上一批 Preview 的历史证据。它不代表本次结构化资料库、草稿确认与新页面的验收结果。

### 6.1 新 UI 资料库契约（2026-07-16）

- `00_设定集/.agent/libraries/{lore,style,genre}.v1.jsonl` 是设定、风格和题材的唯一结构化主数据；UI 只读写这三个 JSONL。人物关系、人物弧光、风格档案、规则、偏好、范文、参考素材、题材素材、冲突模板和禁用表达都有对应记录，不能再退回到按 TXT 编辑。
- 既有 `00_设定集/设定集/*.txt`、`风格库/*.txt`、`题材库/*.txt` 是由主数据一次性生成的 AI、Skill 和向量检索兼容投影，不能再作为 UI 的主编辑源。
- 首次遇到旧 TXT 时只显示迁移预览。只有用户点击导入后，才会创建 JSONL 和新投影；外部改写投影会暂停编辑，用户必须选择重建投影或重新导入。
- `lore_extract`、`style_extract`、`genre_generate` 的模型输出仅写入 `00_设定集/.agent/library-drafts/`。工作台显示待确认草稿，只有“确认写入”才会更新主数据和投影。
- 保存 JSONL 与全部 TXT 投影使用一个文件事务和一条时间线记录。提交后重建 manifest、标记向量索引，并使相关治理记忆失效。
- 本批集中验收命令为 `npm run acceptance:ui-library`，另须人工检查 1440x900 与 1280x720 的“设定资料”“风格与题材”页面。它替代本次开发期间的根级全量验收。
- 2026-07-16 最终 `acceptance:ui-library` 已通过：6 个 workspace 定向 typecheck、5 个测试文件共 132 项测试、Workbench production build 和 `git diff --check`。它同时覆盖资料库 Desktop runtime route：保存或确认草稿后必须重建 manifest、标记投影向量变更、失效对应治理记忆。直接浏览器调用 runtime 会被 Electron IPC/CORS 身份边界拦截，这是预期安全行为；最终人工页面检查必须在 Desktop renderer 内完成。
- Desktop renderer 已在隔离 smoke 项目完成实际保存复验：旧风格/题材 TXT 经用户确认迁移后，新增题材素材同时写入 `genre.v1.jsonl` 和 `题材素材.txt`；新增人物设定同时写入 `lore.v1.jsonl` 和 `人物设定.txt`。新建设定的默认标题会在首次输入时自动全选替换，避免出现标题拼接。1440x900 与 1280x720 下资料列表、详情和题材预览均无旧版全局 AI 工具栏、遮挡或不可达操作。

`desktop-rc.yml` 的 nightly 路径可生成无签名 Preview artifact；严格 `channel=rc` 和 `release.yml` 留给未来商业化，不阻塞本次小范围使用。

## 7. 打包与回退

```powershell
npm run dist -w @xiaoshuo/desktop-shell
```

产物目录：`apps/desktop-shell/release/`。无签名包可能触发 Windows SmartScreen，符合当前小范围 Preview 定位。

回退优先使用 `--safe-agent`。版本回退前备份整个小说项目；不要用旧版本写入已经升级的 SQLite schema。卸载默认不删除用户数据。

## 8. 常见问题

| 现象 | 检查 |
| --- | --- |
| runtime 401 | 是否绕过 preload/IPC session token |
| Agent 功能全部关闭 | 是否使用 `--safe-agent`，或 userData Flag 文件是否合法 |
| 项目写入被拒绝 | manifest UUID、canonical root、symlink/junction、file identity |
| run 无法恢复 | version、budget、memory revision、lease/attempt |
| Browser E2E 绿但安装后失败 | Browser token 不是安装态 IPC 证据 |
| `rg` 入口失效 | 执行 `Get-Command rg`、`rg --version`；本仓库已恢复使用系统 ripgrep，不再依赖失效别名 |

## 9. 提交纪律

先检查：

```powershell
git status --short
git diff --stat
git diff --check
```

禁止 `reset --hard`、`clean`、覆盖用户修改和 `git add .`。不要提交 `studio_config.json`、`.env*`、`dist/`、`release/`、测试报告、日志、截图或临时项目。

## 10. 状态记录

历史的 Batch A/Batch B、M7 商业 RC 预演和逐文件测试流水保留在 Git 历史，不再堆入交接正文。

2026-07-14 集成交付变更：

- 0.5.0～0.9.0 合并为 `0.9.0` Preview；
- Desktop 默认启用完整 Preview Feature Flag 配置；
- `--safe-agent` 和非法配置保持全关闭；
- 新增 `npm run acceptance:preview`；
- 商业 RC 要求移出当前完成门槛；
- 七项原始高风险能力的硬门禁保持不变；
- 最终集中验收：`npm run acceptance:preview` 已通过；112 files / 878 tests、3/3 Node tests、8 类 eval（novel-agent 19/19）、两个 build、Browser E2E 6/6、Desktop smoke 和 diff check 全部成功；excluded-capabilities 为 116/116。

首次矩阵曾因 `0.9.0-preview.1` 不符合 Windows 三段式 ProductVersion 停在发布证据测试。保持严格校验并改用包版本 `0.9.0` 后，定向测试和完整矩阵均通过。当前结论是“0.9 Preview 代码验收完成”，不是商业生产就绪。

本轮最终复跑首次在一个 SQLite/文件恢复用例上触发默认 5 秒超时；该用例单独复现为 195ms。仅将该用例超时上限调整为 15 秒，定向复验通过，随后完整矩阵通过。

2026-07-14 文档收口：

- 删除两份旧 Agent 优化/后续实施计划；
- 新增 `AGENT_NOVEL_CREATION_MODIFICATION_PLAN.md`；
- 七项能力采用“统一修改、全部完成后集中验收”，本批已经完成；
- 产品方向固定为小说创作，不扩展为通用编程、运维或无人自治 Agent；
- 七项受控小说能力的 shared schema、runtime、main/preload IPC、Workbench 页面、持久状态和负向测试已接入；
- Desktop Preview 默认开启六个小说 Agent Feature Flag，`--safe-agent` 全部关闭；
- 新增 `novel-agent` eval，并把小说手势门禁加入 excluded-capabilities；
- 原始七项高风险入口未放宽，最终集中验收已通过并完成回填。

2026-07-15 Git 收口：

- 本批小说 Agent 代码、测试、Feature Flag、Workbench、评测和文档作为一个完整变更提交；
- 提交前最终证据沿用第 6 节的 `npm run acceptance:preview` 完整通过结果；
- 本次只创建本地 Git commit，不创建 tag、不推送 Release，也不宣称商业 RC 或生产就绪。

2026-07-15 写作优先 UI 交付：

- `output/ui-final/` 仅作为视觉和信息架构参考；生产 Workbench 继续使用现有 Controller、typed API、Electron/IPC 和真实项目状态；
- 主导航调整为写作、规划、资料、审阅、工具、全局六组，共 16 个正式入口；`states` 不进入导航；
- 新增真实项目首页；大纲映射 `01_大纲`；伏笔/时间线、风格/题材使用组合视图；AI 助手入口会主动展开右侧会话栏；
- 小说编辑室展示合并摘要、证据、建议、冲突、run 和 degraded 状态；任务展示预算、Token、费用、步骤、截止时间和错误；迁移保留策略选择、diff 和双确认；
- 设置保留 manual/website 双 profile、主副模型、Embedding、联网搜索、写作/上下文、一致性、授权和更新；DuckDuckGo 为真实选项；
- “连接与检索测试”保留 Embedding 草稿连接测试、向量状态、重建、待处理和召回诊断；未新增没有后端契约的主/副模型假测试按钮；
- 网站模式清空向量模型会同步关闭 Embedding 并清空 key/base/model；Embedding 禁用后重建只建立关键词索引，不发送向量请求；
- 1024 宽隐藏项目树和 AI 栏并将主导航图标化；1280/1440 使用完整导航，三档均无页面级横向溢出；
- 本批验收为 112 files / 880 tests、3/3 Node tests、8 类 eval、两个 build、Browser E2E 8/8、Desktop smoke 和 diff check 全部通过；详细过程见 `docs/UI_MODIFICATION_IMPLEMENTATION_PLAN.md` 第 13.4 节；
- UI 方案是本批已完成实施记录，不新增长期并行计划；后续维护仍以本交接和小说 Agent 契约为事实源。

2026-07-15 文档保存可靠性收口：

- 普通编辑保存改为目标文件同目录临时文件写入和原子替换；成功或失败后清理 ArcWriter 临时文件和备份；
- Workbench 对所有未保存文档注册 `beforeunload` 保护，Electron 捕获 `will-prevent-unload` 并提供“继续编辑 / 退出且丢弃”原生确认；用户取消退出时不提前关闭 Agent、SQLite 或 runtime；
- 分屏任一侧显示编辑器时，关闭、重载和保存冲突横幅均保持可见；主页面处于设置等非编辑页面时也可完成冲突处理；
- 顶部新增“保存全部 (N)”，顺序保存所有脏文档；首个失败或冲突即停止，保留现有冲突门禁，不静默覆盖磁盘新版；
- 保存当前显式绑定当前分屏文档路径，文档保存结果通过可访问状态区反馈；
- 集中验证通过：全 workspace typecheck；112 files / 881 tests；3/3 Node tests；Document Service 32/32；Browser E2E 10/10；Desktop smoke；`git diff --check`；
- 当前只保留既有的 Workbench 构建 chunk 超过 500 kB 警告，不影响本批保存行为，也不作为免费小范围 Preview 的阻断项。
