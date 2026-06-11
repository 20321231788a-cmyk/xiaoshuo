# TypeScript Migration Programming Plan

本文档是 `ts-migration` 后续迁移的编程执行计划。它不是产品路线图，而是给后续开发直接照着切任务、写代码、跑验证、切流量用的工程手册。

## 当前基线

截至当前收尾核查，迁移状态如下：

- Electron 桌面壳已经不再启动 Python FastAPI 后端。
- Electron 主进程启动 TypeScript runtime gateway：`http://127.0.0.1:18453`。
- `apps/workbench` 是 React/Vite 迁移工作台，默认指向本地 TS runtime。
- `packages/shared` 提供 zod schema 和共享类型。
- `packages/api-client` 提供 typed HTTP client。
- `packages/config-service` 已完成 TS parity，并由 TS runtime 接管 `/api/config`。
- `packages/config-service` 与 Workbench 配置页已新增联网素材搜索配置；开关默认关闭，保存链路继续走 `/api/config`，配置包含 provider/API key/Base URL、最大结果数、超时和搜索上下文字数。
- `packages/project-session` 已完成 TS parity，并由 TS runtime 接管 `/api/projects/current`、`/api/projects/open`、`/api/projects/create`、项目重命名。
- `packages/project-manifest` 已完成只读 TS parity，并由 TS runtime 接管 `/api/documents` 列表、`/api/project/tree`、`/api/project/tree/subtree`、`/api/project/manifest/status`、`/api/libraries`、`/api/project/chrome`。
- `packages/document-service` 已完成第三段 TS parity，并由 TS runtime 接管 `GET /api/documents/{rel_path}`、`PUT /api/documents/{rel_path}`、`/api/timeline*`、`/api/ledger*` 和 `/api/revision-log`；编辑器保存已增加 stale base 冲突保护，Workbench 已暴露最近时间线、确认回滚入口、AI 修正日志可视化面板和可操作伏笔账本。
- `packages/conversation-service` 已完成本地会话文件 CRUD parity，并由 TS runtime 接管非 AI 的会话文件路由。
- Workbench 会话页已接入整理能力：内联改名、刷新确定性/模型摘要、展示固定上下文、固定当前文档、固定文本以及移除单条固定上下文。
- `packages/job-service` 已完成任务状态机 parity，并已加载到 TS runtime；当前 `/api/jobs` 由本地 TS 任务队列接管，未知任务直接返回不支持，不再代理 Python。
- `packages/skill-service` 已完成第一刀 TS parity，并由 TS runtime 接管技能目录、详情与导入链路。
- `/api/agent/run` 与 `/api/agent/run-stream` 的 `chat/read_context` 本地链路、已迁移的 `file_operation` 执行切片、本地 prompt/workflow skill intent，以及会话消息生成 `/api/conversations/{id}/messages`（支持流式/非流式）已切到 TS。此外，本地写作相关的正文生成与批量生成（`body_generate` / `batch_generate`）已完整完成 TS 侧深水区对齐（支持自审回炉修正、修正日志与章节交接摘要落盘、GeneratedCache 物理缓存落地）；向量服务、crawler/card-draw 与主要后台任务也已由 TS runtime 接管，Workbench 已增加向量召回调试入口、待处理生成结果收件箱和可继续处理的任务结果文件卡。
- `packages/agent-runtime` 已在普通 `chat/read_context`、`/api/conversations/{id}/messages`、正文生成、批量正文生成和正文抽卡候选链路中接入联网素材搜索上下文：开启配置且用户明确要求联网/搜索/查资料/找素材时，TS runtime 会抓取摘要与来源 URL 作为低优先级小说素材参考；搜索失败降级为 `None`，不会阻断聊天、正文生成或自动写文件。
- 会话链路和写作 workflow 已增加联网来源透明化：`AgentRunResponse.web_search_sources`、`skill_result.data.web_search_sources` 和 assistant message `metadata.web_search_sources` 只保留标题与 http/https URL；Workbench 会话消息卡片和 Operations 最近技能结果会显示“联网来源”链接，展示前会过滤非法协议、账号密码 URL、敏感 query key、snippet 和额外字段，避免用户不知道本轮是否使用了网络素材，也避免泄露配置或原始搜索内容。正文缓存、候选正文文件和抽卡 manifest 不写入来源摘要，避免污染可写回内容。
- Workbench 概览页已显示联网素材搜索状态，并在自定义搜索开启但缺少 Base URL 时通过下一步建议引导回配置页。

当前必须保持的验证命令：

```powershell
cd D:\xiaoshuo\ts-migration
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
$env:WORKBENCH_BASE_URL='http://127.0.0.1:4180'; npx playwright test tests/e2e/project-entry.spec.ts
```

## 迁移原则

1. 后续新增或修复的模块继续先补 TS parity 测试，再接入 TS runtime，再切前端流量。
2. 当前不再保留 Python proxy 兜底；未支持能力必须显式返回错误，并在计划中登记。
3. 任何涉及真实写文件、任务队列、AI 请求、向量索引的模块，都需要先做 fixture 和回滚策略。
4. `packages/shared` 中的 zod schema 是跨边界契约；新增或调整 API 必须先补 schema。
5. 新增能力必须通过 parity test、runtime smoke、E2E 三层验证后再标记完成。
6. 不要让半成品 TS worker 抢占真实任务队列；worker 未完成前应返回明确的不支持错误。

## 推荐目录布局

后续新增包建议保持这个模式：

```text
packages/
  project-session/       current project state, open/create/pick/rename
  project-manifest/      manifest build, tree, chrome, libraries, timeline read
  document-service/      document read/write/archive, timeline mutations
  generated-cache/       AI/skill generated cache body and commit/discard
  skill-service/         built-in/imported skill catalog and prompt/workflow runner
  agent-runtime/         plan/run/run-stream orchestration
  vector-service/        sqlite vector index and embedding client
  crawler-service/       novel crawler and disassembly helpers
```

每个包至少包含：

```text
package.json
tsconfig.json
src/index.ts
src/*.ts
src/*.test.ts
```

接入 Electron runtime 的包还必须提供 `build` 输出到 `dist`，并在 `package.json` 中使用可被 Node/Electron 加载的 `exports.default`。

## API 切流矩阵

| API 区域 | 当前归属 | 下一步目标 | 切流策略 |
| --- | --- | --- | --- |
| `/api/config` | TS | 保持 TS | 继续由 `config-service` 接管；联网素材搜索配置已纳入 public config 白名单与 Workbench 配置页 |
| `/api/conversations` list/create/get/rename/pin/summarize/messages/attachments | TS | 保持 TS | 会话 CRUD、附件、确定性摘要、AI 摘要和消息流均由 TS runtime 接管 |
| `/api/conversations/{id}/messages` | TS | 保持 TS | 已由 `agent-runtime` 接管，支持非流式及流式 NDJSON 回复 |
| `/api/jobs` | TS | 保持 TS | TS runtime 本地创建、查询和取消任务；未知 kind 返回不支持 |
| `/api/projects/current/open/create/pick` | TS | 保持 TS project-session | current/open/create/rename 已切 TS，pick 可继续 Electron dialog |
| `/api/project/tree/chrome/manifest/status/libraries` | TS(readonly) | 扩展写入触发 rebuild | 当前 tree/chrome/status/libraries 已切 TS，timeline 也已由 TS document-service 提供 |
| `/api/documents` | TS(readonly) | 继续由 project-manifest 提供清单 | 当前仅文档列表由 TS 提供，文件内容仍未切流 |
| `/api/documents/{rel_path}` | TS | 保持 TS | `GET`/`PUT`/`DELETE`(归档) 已切 TS，agent execute 已切 TS |
| `/api/ledger`、`/api/revision-log`、`/api/timeline` | TS | 保持 TS | ledger、revision-log、timeline 全部已切 TS，archive 和批量文件操作已收口 |
| `/api/skills` | TS | 保持 TS | list/get/import/upload/import-draft/open-folder、`draft-from-url` 与本地 prompt/workflow skill run 已切 TS |
| `/api/agent/generated/*` | TS | 保持 TS | 常规保存、提交、丢弃与清理已切 TS，特化 lore/genre 拆分合并也由 TS 本地处理 |
| `/api/agent/plan/run/run-stream` | TS | 保持 TS | 当前 `/api/agent/plan` 已切 TS，`/api/agent/run` 与 `/api/agent/run-stream` 已切入 `chat/read_context`、已迁移的 `file_operation` 本地链路、本地 prompt/workflow skill intent，以及 `disassemble_book` / `continue_disassemble` / `scan_pits` / `consistency_check` / `body_generate` / `batch_generate` 的本地工作流和写作链路。其中，`body_generate` / `batch_generate` 已完成完整对齐，深度支持了自审回炉二次修正（Auto Revision）、`正文二次修正日志.txt` 与 `章节交接摘要.jsonl` 文件物理写盘、未确认保存时的 `GeneratedCache` 本地物理缓存落盘，并补齐了 `revised`、`deslopped` 等丰富元数据。 |
| `/api/vector/*` | TS | 保持 TS | 接管向量配置、重建、增量同步与搜索，后台任务 reindex、vector_reindex、vector_incremental 也已接管；Project 页已提供召回调试入口查看命中文档、来源类型、分数和片段。 |

## 阶段 5.1：Project Session Service

目标：把“当前项目”状态从 Python `ProjectService` 中剥离成 TS runtime 可管理的项目会话。

参考 Python：

- `agent_backend/project_service.py`
- `agent_backend/app.py` 中的 `/api/projects/current`、`/api/projects/open`、`/api/projects/create`、`/api/projects/pick`

新增包：

```text
packages/project-session/
  src/session.ts
  src/project-template.ts
  src/session.test.ts
```

主要代码任务：

1. 在 `packages/shared/src/schemas/project.ts` 检查并补齐：
   - current project schema
   - project open/create request schema
   - picker response schema
2. 实现 `ProjectSessionService`：
   - `getCurrentProject()`
   - `openProject(path)`
   - `createProject(parentOrPath, projectName, createInParent)`
   - `renameCurrentProject(name)`
   - `requireProject()`
3. 设计项目会话持久化：
   - 优先放在 Electron local state SQLite。
   - 至少保存 `current_project_path`、`current_project_name`、`opened_at`。
   - 启动时可从最近项目恢复，但不能自动创建不存在路径。
4. 实现项目模板创建：
   - 对齐 Python 当前生成的基础目录和 starter files。
   - 使用结构化路径列表，禁止字符串拼 shell。
5. 接入 `apps/desktop-shell/src/main/runtime-server.ts`：
   - 接管 `GET /api/projects/current`
   - 接管 `POST /api/projects/open`
   - 接管 `POST /api/projects/create`
   - `POST /api/projects/pick` 如需恢复，应走 Electron dialog IPC 或显式返回不支持，不再 proxy。

测试任务：

- 单元测试：
  - 打开存在项目
  - 打开不存在路径报错
  - 创建项目生成基础目录
  - rename 限制空名和 80 字长度
  - `requireProject()` 无项目时报错
- Runtime smoke：
  - Electron 启动后 current project 可读。
  - open/create 后 workbench 可以刷新项目入口。
- E2E：
  - 保持 `project-entry.spec.ts` 全绿。

回滚条件：

- 如果 TS open/create 影响旧项目结构，优先收紧写入入口或回退到只读保护，不恢复 Python proxy。
- 项目路径写入 local state 失败时，不能阻断打开项目。

## 阶段 5.2：Project Manifest Service

状态：已完成，后续只保留写入触发 rebuild、覆盖补强和文档收尾。

目标：迁移项目清单、树、资料卡和 chrome snapshot 的只读部分。

参考 Python：

- `agent_backend/project_manifest_service.py`
- `agent_backend/project_service.py`
- `/api/documents`
- `/api/project/tree`
- `/api/project/tree/subtree`
- `/api/project/chrome`
- `/api/project/manifest/status`
- `/api/libraries`

新增包：

```text
packages/project-manifest/
  src/manifest.ts
  src/tree.ts
  src/library-cards.ts
  src/chrome.ts
  src/manifest.test.ts
```

主要代码任务：

1. 将 Python 的项目目录规则整理为 TS 常量：
   - `00_设定集`
   - `01_大纲`
   - `02_正文`
   - 其他当前 app 识别的资料目录
2. 实现安全路径工具：
   - `resolveProjectPath(root, relPath)`
   - `toProjectRelativePath(root, absPath)`
   - 禁止路径越界。
3. 实现文件扫描：
   - 忽略 `.agent` 内部缓存和临时文件。
   - 只扫描项目允许的文本/资料文件。
   - 返回 `DocumentInfo[]`。
4. 实现 tree 构建：
   - 输出 `TreeNode[]`。
   - 保持和 Python `list_tree()` 字段一致。
5. 实现 library cards：
   - 对齐 Python 对设定、风格、题材、伏笔等资料卡的识别。
6. 实现 manifest status：
   - `ready`
   - `files`
   - `version`
   - `generated_at`
   - `source`
   - `path`
7. 实现 `projectChromeSnapshot()`：
   - current project 来自 `project-session`
   - tree、libraries、timeline 组合输出
8. runtime 切流：
   - 先接管 `/api/project/manifest/status`
   - 再接管 `/api/documents`
   - 再接管 `/api/project/tree`
   - 最后接管 `/api/project/chrome`

测试任务：

- 使用 `sandbox-projects` fixture 创建多层目录。
- 测试中文路径、空目录、大文件、隐藏文件、`.agent` 排除。
- 对比 Python fixture 输出字段，不要求排序完全一致时必须在测试中说明排序规则。
- E2E 验证项目树、概览资产数、打开 starter outline。

回滚条件：

- 如果 tree/chrome 中任何字段缺失导致 workbench 空白，收紧到稳定只读子集并补测试，不恢复 Python proxy。

已完成结果：

- `packages/project-manifest` 已落地并通过单测。
- TS runtime 已接管 `/api/documents` 列表、`/api/project/tree`、`/api/project/tree/subtree`、`/api/project/manifest/status`、`/api/libraries`、`/api/project/chrome`。
- `project/chrome` 已改为直接组合 TS document-service 提供的 timeline 数据。

## 阶段 5.3：Document Service

状态：已完成第二刀读写切流，当前已接管 `GET /api/documents/{rel_path}`、`PUT /api/documents/{rel_path}` 和 `GET /api/timeline`。

目标：迁移项目文档读写、追加、归档和 timeline 记录。

参考 Python：

- `agent_backend/project_service.py`
- `/api/documents/{rel_path}`
- `/api/agent/execute`
- `/api/timeline`
- `/api/revision-log`
- `/api/ledger`

新增包：

```text
packages/document-service/
  src/documents.ts
  src/operations.ts
  src/timeline.ts
  src/ledger.ts
  src/revision-log.ts
  src/documents.test.ts
```

主要代码任务：

1. 实现文档读写：
   - `readDocument(relPath)`
   - `saveDocument(relPath, content, source, summary)`
   - `appendDocument(relPath, content, source, summary)`
2. 实现编码策略：
   - 默认 UTF-8。
   - 读取失败时给出明确错误。
   - 不在第一轮迁移中隐式转码旧文件。
3. 实现文件操作计划执行：
   - `create_file`
   - `append_text`
   - `replace_text`
   - `move_file`
   - `archive_file`
4. 实现 timeline：
   - 每次写入记录 before/after 摘录。
   - 支持 list/get/delete/rollback。
5. 实现 ledger：
   - list/add/toggle。
6. 实现 revision log：
   - list/clear。
7. runtime 切流顺序：
   - `GET /api/documents/{rel_path}`
   - `PUT /api/documents/{rel_path}`
   - `GET /api/timeline`
   - `GET /api/revision-log`
   - `GET /api/ledger`
   - `POST /api/agent/execute`

测试任务：

- 路径越界测试。
- replace_text 找不到 old_text 时返回可解释错误。
- archive_file 不直接删除，进入归档目录。
- rollback 能恢复内容。
- workbench editor 保存 E2E 通过。

回滚条件：

- 任何写入类路由失败时，优先保留 read 路由 TS，并让对应 write 路由显式报错后单独修复。

已完成结果：

- `packages/document-service` 已落地并通过单测。
- TS runtime 已接管 `GET /api/documents/{rel_path}`、`PUT /api/documents/{rel_path}`、`DELETE /api/documents/{rel_path}`（归档）、`/api/timeline*`、`/api/ledger*` 和 `/api/revision-log`。
- `PUT /api/documents/{rel_path}` 支持 `base_updated_at` / `base_updated_at_ms` / `force`，在磁盘已有新版时返回 409 防止编辑器静默覆盖后台或其他窗口写入的新稿。
- `POST /api/agent/execute` 已由 TS runtime 接管，支持全部五种操作：`create_file`、`append_text`、`replace_text`、`move_file`、`archive_file`。
- `project/chrome` 已改为直接组合 TS timeline。
- 编辑器打开 starter outline 的现有 E2E 继续通过，desktop smoke 已覆盖 runtime 内的真实文档保存、时间线回读、ledger toggle、revision-log 解析、agent execute 批量操作（含归档）和 DELETE document 归档路由。
- 单测覆盖批量归档 `archiveDocuments`、create_file 拒绝覆盖、move_file 目标已存在等边界场景。
- Workbench 编辑器新增“最近改动 / 保存与回滚记录”入口，展示 timeline 的时间、来源、摘要、影响文件和片段预览；回滚必须先进入确认态，再执行 `rollbackTimelineEntry(..., true)`，回滚后刷新项目 chrome 并将已打开的受影响文档标记为需要读取最新版。
- Workbench 概览新增“AI 修正日志”面板，展示最近修正的目标文件、评分、风险标签和日志摘录，支持打开正文、打开原始日志文件，并通过二次确认清空修正日志。
- Workbench 概览新增“伏笔账本”面板，支持新增伏笔、查看未回收伏笔、标记回收，以及重新打开最近已回收条目；新增和切换后局部同步 `DashboardSnapshot.ledger`。

## 阶段 5.4：Generated Cache Service

目标：把 AI/skill 生成结果的临时缓存、保存、丢弃迁移到 TS。

参考 Python：

- `agent_backend/agent_runtime.py`
- `agent_backend/project_service.py`
- `/api/agent/generated/save`
- `/api/agent/generated/cache/{cache_id}/commit`
- `DELETE /api/agent/generated/cache/{cache_id}`
- `/api/agent/generated/cache/cleanup`

新增包：

```text
packages/generated-cache/
  src/cache.ts
  src/commit.ts
  src/cache.test.ts
```

主要代码任务：

1. 定义 cache payload schema：
   - cache id
   - source: chat/skill
   - skill id
   - content
   - target path(s)
   - mode: replace/append
   - created_at
2. 文件存储位置继续兼容 `.agent/generated`。
3. 实现 save/commit/discard/cleanup。
4. 接入 `document-service` 写入。
5. 同步 Electron local state 的 generated-cache metadata。

测试任务：

- 保存单文件 replace。
- 保存单文件 append。
- 保存多文件 target_paths。
- discard 删除 body，但 local metadata 可标记 discarded。
- cleanup 只清过期 cache，不清 pending。

回滚条件：

- 如果 generated body 和 local metadata 不一致，前端必须展示错误并禁止误写文件。

已完成结果：

- `packages/generated-cache` 包已落地并实现全部 9 个单元测试（覆盖空文本生成、append累加、replace覆盖、多文件写入、丢弃清除、错误标记和过期清理）。
- TS runtime Gateway 接管了 `/api/agent/generated/save`（常规保存）、`GET /api/agent/generated/cache/{cache_id}`（缓存恢复读取）、`/api/agent/generated/cache/{cache_id}/commit`（常规提交）、`DELETE /api/agent/generated/cache/{cache_id}` 和 `/api/agent/generated/cache/cleanup`，并与底层 `DocumentService` 的安全路径和黑名单检验机制深度整合。
- 设定提取 `lore_extract` 与题材生成 `genre_generate` 在路由层检测后由 TS 本地 `PromptSkillRunner` 完成特化拆分、合并和写入。
- Electron 冒烟测试已补充常规 save、物理缓存 commit 提交、discard 丢弃及 cleanup 定时清理的全流程集成验证，测试顺利全绿通过。
- Workbench 概览页新增“待处理生成结果”收件箱，基于 Electron local-state 的 `generated_caches` 索引展示遗留 pending 缓存，并通过 typed API 读回正文，恢复到原有待保存确认面板，避免刷新或重启后用户找不到生成内容。
- 生成结果收件箱现在显示真实待确认总数，默认保留前 6 条的紧凑视图，并提供“显示全部/收起”操作；下一步建议中的“处理待写入生成结果”会回到概览页的收件箱入口，避免用户被带到没有历史缓存列表的页面。
- Workbench 已统一 pending 生成缓存的统计口径：概览运行时概况、生成结果收件箱和下一步建议都使用当前项目过滤后的数量；没有 `project_path` 的遗留缓存继续视为当前可恢复缓存，避免旧数据被隐藏。
- Workbench 的聊天/技能待保存面板新增“复制全文”和“另存草稿”动作；草稿会把完整生成内容写入 `00_设定集/AI生成草稿/`，刷新并打开草稿文件，同时不改动原目标文档，给覆盖/追加前提供安全缓冲。待保存面板和概览缓存收件箱的丢弃动作已增加二次确认，概览缓存卡也可直接复制缓存正文。App 顶部 tabbar 下方新增全局待处理生成结果条，跨 tab 展示来源、目标、字数、写入意图，并提供去处理、追加/覆盖保存、复制全文、另存草稿和确认丢弃动作。
- Workbench 任务详情不再默认把 `job.result` 作为大段 raw JSON 占主视觉；前端新增 unknown result 文件归一化 helper，支持顶层、数组与嵌套结果里的 `saved_path(s)`、`archived_path(s)`、`target_path(s)`、`output_path` 和 `path`，并渲染为可打开、可复制、可带入会话继续处理的结果文件卡片。任务详情同时显示用户向结果摘要，任务完成提示会带上结果摘要；false/0/空字符串/空数组等合法结果不再被隐藏，超大 raw JSON 会截断展示以避免 UI 卡顿。

## 阶段 5.5：Conversation Attachments and Summary Completion

目标：把会话附件、确定性摘要和模型摘要完整迁到 TS。

参考 Python：

- `agent_backend/conversation_service.py`
- `/api/conversations/{id}/attachments`
- `/api/conversations/{id}/summarize`

现有包：

```text
packages/conversation-service/
```

主要代码任务：

1. 增加附件目录处理：
   - `.agent/attachments/{conversation_id}`
   - original file
   - extracted text file
2. 使用 `mime-types` 判断媒体类型。
3. 支持第一批附件类型：
   - `.txt`
   - `.md`
   - `.docx`
   - `.pdf`
4. 实现 `addAttachment()`。
5. 实现 `deleteAttachment()`。
6. `summarize(use_model=false)` 继续 TS。
7. `summarize(use_model=true)` 使用 TS model client；副模型未配置或失败时降级到确定性摘要。

测试任务：

- 文本附件提取。
- docx/pdf 至少 fixture 一个。
- 删除附件同时删除 original/text。
- 附件路径越界测试。

回滚条件：

- 如果二进制附件解析失败，不影响已有会话读取。

已完成结果：

- `packages/conversation-service` 包已完成附件添加（支持 .txt, .md, .docx, .pdf 解析与纯文本提取）、附件删除与越界校验逻辑，并为新接口补充了完整的单元测试，实现 100% 覆盖通过。
- 在 `apps/desktop-shell/src/main/runtime-server.ts` 路由层接管并实现了安全且低内存耗用的二进制 multipart/form-data 文件解析器 `parseMultipartFile`，成功代理并处理了文件上传路由（POST /api/conversations/{id}/attachments）以及删除路由（DELETE /api/conversations/{id}/attachments/{item_id}）。
- 在 Electron 冒烟测试中补充了完整的会话和附件上传、列表验证、物理落地文件结构校验以及删除附件联动清理等测试用例，完美通过了全量集成验证。
- Workbench 会话页已从被动展示升级为可整理面板：支持改名、刷新摘要、固定当前文档、固定文本、查看并移除固定上下文；`packages/api-client` 已补齐 summarize/pin/remove/clear 的 typed methods 并覆盖请求测试。


## 阶段 5.6：Job Worker Cutover

目标：让 `packages/job-service` 不只是状态机，而是承接真实 worker。

前置依赖：

- `project-session`
- `project-manifest`
- `document-service`
- `generated-cache`
- 至少一部分 `vector-service`

主要代码任务：

1. 修改 TS runtime 的 `/api/jobs` 策略：
   - TS worker kind 由 TS 创建。
   - 未支持 kind 返回明确错误。
   - `GET /api/jobs` 返回本地 TS job 列表。
2. 第一批可切 TS worker：
   - `scan_project`
   - `build_continuity_context`
   - `summarize_conversation` with `use_model=false`
3. 第二批可切 TS worker：
   - `reindex` text manifest 部分
   - generated cache cleanup
4. 后续可继续补齐的 TS worker：
   - `generate_chapter`
   - `batch_generate`
   - `consistency_check`
   - workflow skills
   - vector jobs，直到 vector-service 完成

测试任务：

- 本地 job id 使用 `ts-` 前缀，避免和旧项目历史任务 id 混淆。
- list jobs 合并后排序稳定。
- cancel TS job 不影响未知或历史 job id。
- 非 TS job id 返回 404，不再代理。
- E2E 任务详情和取消按钮可用。

回滚条件：

- 如果任务列表导致前端轮询错 job，回滚到只暴露本地稳定 job 子集。

已完成结果：

- **Schema 扩展**：在 `packages/shared/src/schemas/project.ts` 中补充了 `continuityContextSchema` 以及 `ContinuityContext` 的类型定义。
- **业务方法支持**：在 `packages/project-session/src/service.ts` 的 `ProjectSessionService` 中实现了 `buildContinuityContext()` 写作上下文数据组装，并为该方法编写了独立的单元测试（测试通过）。
- **Gateway 路由及分流机制**：
  - 在 `apps/desktop-shell/src/main/runtime-server.ts` 实例化 `JobManager` 时通过 `idFactory` 强制本地任务 ID 携带 `ts-` 前缀（与 Python 端 hex 格式硬性隔离）。
  - 在路由层全面接管了 `POST /api/jobs`（本地运行已支持的 worker，未知 kind 返回不支持）、`GET /api/jobs`（返回最近 50 项本地任务）、`GET /api/jobs/{id}` 以及 `POST /api/jobs/{id}/cancel`（带 `ts-` 前缀则在本地处理，否则返回 404）。
- **集成测试通过**：在 Electron 冒烟集成测试中补充了对本地任务创建、结果检索、合并去重及取消（取消延迟 100ms 轮询状态变更）的测试逻辑，全量编译与冒烟测试顺利通过。


## 阶段 5.7：Skill Catalog and Imported Skill Service

目标：先迁移技能目录、导入、详情读取；运行 prompt/workflow 延后。

参考 Python：

- `agent_backend/skill_service.py`
- `/api/skills`
- `/api/skills/{skill_id}`
- `/api/skills/import`
- `/api/skills/open-folder`
- `/api/skills/upload`
- `/api/skills/draft-from-url`
- `/api/skills/import-draft`

新增包：

```text
packages/skill-service/
  src/catalog.ts
  src/imported-skills.ts
  src/skill-parser.ts
  src/catalog.test.ts
```

主要代码任务：

1. 定义 built-in skill registry。
2. 读取 imported skills 目录。
3. 解析 `SKILL.md` 或当前 Python 支持的技能定义格式。
4. 实现 list/get/import/import-draft。
5. `open-folder` 应通过 Electron shell IPC，而不是 Node 随意启动 shell。
6. `draft-from-url` 由 crawler/AI runtime 在 TS 本地处理。
7. `runSkill` 由 agent-runtime 和本地 worker 处理；未知能力显式报错。

测试任务：

- built-in skill 数量和关键 id 对齐 Python。
- imported skill 解析错误不阻断整个目录。
- upload/import 只写入允许目录。

回滚条件：

- 如果目录解析不兼容旧技能，保留 TS parser tests 并返回明确错误，不恢复 Python proxy。

已完成结果：

- `packages/skill-service` 已落地，内置技能注册表、导入目录索引、`SKILL.md` frontmatter 解析、上传 markdown/zip 导入、草稿导入归档和 source snapshot 写盘都已完成，并补齐了对应单测。
- TS runtime 已接管 `GET /api/skills`、`GET /api/skills/{skill_id}`、`POST /api/skills/import`、`POST /api/skills/upload`、`POST /api/skills/import-draft` 和 `POST /api/skills/open-folder`。
- `POST /api/skills/draft-from-url` 已切到 TS crawler/AI runtime。
- `POST /api/skills/{skill_id}/run` 已切入 TS prompt/workflow skill：当前 `outline_generate`、`detail_outline_generate`、`chapter_outline_generate`、`polish_text`、`reverse_outline_extract`、`style_extract`、`continue_text`、`story_deslop`、`lore_extract`、`genre_generate`、`disassemble_book`、`continue_disassemble`、`scan_pits`、`consistency_check`、`body_generate`、`batch_generate` 与导入的普通 prompt skills 走 TS。
- Electron smoke 已补充 skills catalog、local import、multipart upload、draft import、imported.json 落盘验证，以及本地 prompt skill 生成缓存/commit 验证。

## 阶段 5.8：OpenAI/Model Client and Agent Runtime

目标：迁移 AI 请求、流式输出、planner、conversation message flow。

参考 Python：

- `agent_backend/ai_client.py`
- `agent_backend/planner.py`
- `agent_backend/agent_runtime.py`
- `agent_backend/conversation_service.py`
- `/api/agent/plan`
- `/api/agent/run`
- `/api/agent/run-stream`
- `/api/conversations/{id}/messages`
- `/api/skills/{skill_id}/run`

新增包：

```text
packages/model-client/
  src/openai-compatible.ts
  src/model-client.test.ts
packages/agent-runtime/
  src/planner.ts
  src/runtime.ts
  src/stream.ts
  src/runtime.test.ts
```

主要代码任务：

1. 实现 OpenAI-compatible client：
   - primary model
   - secondary model
   - thinking flag
   - timeout/error normalization
2. 实现 streaming NDJSON：
   - `{ type: "start" }`
   - `{ type: "delta", text }`
   - `{ type: "final", payload }`
   - `{ type: "error", message }`
3. 实现 planner：
   - prompt parity
   - operation schema validation
   - destructive operation confirmation
4. 实现 conversation message flow：
   - append user message
   - build stable project context
   - invoke model
   - append assistant message
   - generated cache handling
5. 实现 skill run 第一批：
   - prompt skill
   - write_result=false
   - generated pending save
6. runtime 切流：
   - 先 `/api/agent/plan`
   - 再 `/api/skills/{id}/run` prompt skill
   - 再 `/api/agent/run`
   - 最后 `/api/agent/run-stream` 和 `/api/conversations/{id}/messages`

测试任务：

- 使用 fake model client，不在单测中打真实 API。
- 流式事件顺序测试。
- 模型错误时会话保留 user turn。
- generated cache 出错不覆盖文件。
- Playwright 测试聊天输入、停止响应、pending save。

回滚条件：

- 真实模型错误率或流式事件解析异常时，agent 路由返回明确错误并保留 user turn，不恢复 Python proxy。

已完成结果（前两刀）：

- `packages/model-client` 已落地，提供 OpenAI-compatible chat completion 调用、SSE 流式增量解析、stream 不支持时回退到普通 completion，以及网关/连接/限流类错误归一化。
- `packages/agent-runtime` 已落地第二批能力，当前包含 planner 骨架、NDJSON 事件编码工具、runtime service，以及本地 prompt-skill 执行器；已实现本地 rename 规划、无模型时的明确降级、基于模型 JSON 输出的文件操作规划与固定路径规范化，以及 prompt-skill 的 continuity context、附件输入、generated-cache pending save 和 direct write_result 写入。
- TS runtime 已接管 `POST /api/agent/plan`，desktop smoke 已覆盖真实 rename plan 生成，typed api-client 也已补齐 `planAgent()`。
- TS runtime 已接管 `POST /api/skills/{skill_id}/run` 的 prompt skills、本地 workflow/job skills、lore/genre 特化写入和已迁移的多段写入链路。
- `packages/agent-runtime` 现已接管 `/api/agent/run` 与 `/api/agent/run-stream` 的最小 `chat/read_context` 切片：本地完成意图分类、会话 user/assistant 追加、稳定项目上下文拼装、附件摘录、普通 completion 与流式 NDJSON 输出。
- `/api/conversations/{id}/messages` 已由 TS runtime 完全接管，支持流式 NDJSON 与非流式回复；`/api/agent/run` 与 `/api/agent/run-stream` 现已额外接管 `file_operation` 切片（planner 执行、删除确认预览、“保存到大纲/细纲/章纲/正文”的直接写入、批量替换，以及基于项目文档的主角名自动推断替换）和本地 skill intent。
- `packages/api-client` 与 `apps/workbench` 的聊天发送入口已开始切到 `/api/conversations/{id}/messages` 流式链路，前端停止响应仍沿用 `AbortController` 本地中断当前 fetch。
- 联网素材搜索已接入 `packages/agent-runtime`：`buildTurnContext()`、`buildConversationTurnContext()`、`generateBodyChapter()` 与 `generateBodyCardCandidate()` 会在配置开启且命中明确搜索意图时注入 `【联网搜索小说素材】` 块；`batch_generate` 会保留原始批量指令并复用正文生成路径。搜索服务限制 http/https URL、最大结果数、超时和上下文字数，API key 不进入 prompt、会话消息、生成缓存或抽卡 manifest。测试覆盖默认关闭、无触发词不开搜、触发后注入来源摘要、来源透明化只保留 title/url、body/batch/card draw 返回 sources、搜索失败继续聊天/正文生成、正文抽卡候选注入，以及 DuckDuckGo HTML 解析与配置保存往返。
- browser-mode Playwright 现已通过独立的 TS runtime harness 启动 `18453`，`tests/e2e/project-entry.spec.ts` 也已覆盖会话页真实发消息并显示 assistant 回复的链路。

## 阶段 5.9：Vector Service

目标：迁移 embedding 配置、向量索引状态、重建、增量处理、搜索。

参考 Python：

- `agent_backend/vector_service.py`
- `/api/embedding/config`
- `/api/embedding/test`
- `/api/vector/status`
- `/api/vector/rebuild`
- `/api/vector/process-pending`
- `/api/vector/search`

新增包：

```text
packages/vector-service/
  src/embedding-client.ts
  src/vector-db.ts
  src/indexer.ts
  src/search.ts
  src/vector-service.test.ts
```

主要代码任务：

1. 配置继续复用 `config-service`。
2. SQLite 存储建议先兼容 Python DB schema，必要时加 migration。
3. embedding client 支持 OpenAI-compatible embeddings endpoint。
4. 实现 status。
5. 实现 rebuild/process-pending worker。
6. 实现 search 和 build_context。
7. 先由 `job-service` 调度 vector worker，再切 `/api/vector/*`。

测试任务：

- fake embedding client，稳定返回向量。
- DB schema migration 测试。
- search top_k、max_chars 测试。
- 大量文件增量处理不阻塞 UI。

回滚条件：

- 如果 DB schema 不兼容旧数据，禁止自动写入旧 DB；使用新 DB 文件名并要求显式迁移。

已完成结果：

- `/api/vector/search` 已补齐 shared request/response schema、api contract 和 typed api-client 方法。
- Project 页“索引与资料状态”新增召回调试面板，支持输入查询、查看命中文档/来源类型/分数/片段，并可直接打开命中文档。
- `packages/api-client` 已补充 vector search 请求测试，覆盖 URL、method、body 和命中结果解析。

## 阶段 5.10：Crawler and Workflow Skills (已完成)

**状态：已完成**
将网络抓取与自动拆书工作流 (`crawl_disassemble`)、多候选抽卡生成 (`card_draw_generate`)、URL 起草技能 (`POST /api/skills/draft-from-url`) 以及抽卡挑选与归档 (`POST /api/card-draw/{draw_id}/select`) 完整迁移到 TS 本地运行时，并在 `/api/jobs` 创建时拦截之前遗留的 3 个 workflow 任务。

参考 Python：

- `agent_backend/novel_crawler_service.py`
- `agent_backend/skill_service.py`
- `agent_backend/writing_service.py`

新增包：

```text
packages/crawler-service/
packages/workflow-service/
```

主要代码任务：

1. 先迁移 crawler fetch/parse，所有网络结果保存 fixture。
2. workflow 技能按 handler 拆分，不要在一个巨型 service 中堆实现。
3. 使用 `zod` 验证每个 workflow 输入。
4. 所有长任务通过 `job-service`。
5. 写文件必须走 `document-service`。

测试任务：

- parser fixture 测试。
- 网络失败重试和错误提示测试。
- workflow 只生成 pending cache，不直接覆盖用户文件，除非请求明确。

回滚条件：

- 外部站点结构变化时 workflow 自动降级到错误提示，不影响本地编辑流程。

## 阶段 6：Remove Python Runtime (已完成)

**状态：已完成**
已成功移除对 Python 运行时的依赖。不再在 Electron 启动时 spawn Python 进程。所有的网络代理逻辑（`proxyRequest`/`proxyStreamingRequest`等）已在本地使用 TS 模块和本地 AI 客户端完全实现并彻底解耦。

进入条件：

- `/api/config` TS。
- `/api/projects/*` TS。
- `/api/project/*` TS。
- `/api/documents/*` TS。
- `/api/conversations/*` TS。
- `/api/jobs/*` TS。
- `/api/skills/*` TS 或明确废弃未迁移功能。
- `/api/agent/*` TS。
- `/api/vector/*` TS 或功能开关关闭。
- Python proxy 在正常 E2E 中不再被调用。

主要代码任务（已完成记录）：

1. 已完成 Python proxy 使用路径清理，正常桌面链路不再经过 `proxyRequest` / `proxyStreamingRequest`。
2. 已完成 Electron 启动逻辑改造，不再 spawn Python backend。
3. 已完成桌面侧构建与运行时依赖收口，主路径以本地 TS runtime 为准。
4. 已完成阶段性文档同步，包括迁移状态、运行时结构与当前验证基线。

验收命令：

```powershell
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npx playwright test
```

额外验收：

- 新建项目。
- 打开旧项目。
- 编辑并保存正文。
- 执行一个 prompt skill。
- 发起一次 AI 流式对话。
- 生成 pending cache 并保存。
- 取消一个后台任务。
- 重启应用后最近项目、会话、任务快照仍可读。

## 每个切片的固定交付清单

每完成一个后续切片，都要交付：

1. 新增或更新 package。
2. 更新 `packages/shared` schema。
3. 更新 `packages/api-client`，如果前端需要新 client method。
4. 更新 `apps/desktop-shell/src/main/runtime-server.ts` 路由。
5. 更新 docs：
   - `docs/phases.md`
   - 本文件对应状态
   - 必要时 `docs/api-inventory.md`
6. 单元测试。
7. runtime smoke 或 Playwright E2E。
8. 明确哪些路由已 TS，哪些能力显式不支持或待补。

## 最小验证矩阵

| 变更类型 | 必跑验证 |
| --- | --- |
| 只改 docs | 不强制跑测试，至少人工检查链接和命令 |
| 改 shared schema | `npm run typecheck`、`npm test` |
| 改 service package | 对应包 typecheck、对应 vitest、全量 `npm test` |
| 改 runtime-server | `npm run build:desktop`、`npm run smoke:desktop` |
| 改 workbench | `npm run build:workbench`、相关 Playwright |
| 改文件写入逻辑 | 单元测试、E2E、手动检查 sandbox 项目文件 |
| 改 AI/stream | fake model 单测、流式 E2E、失败中断测试 |
| 改 job worker | job 单测、cancel 测试、operations view E2E |

## Runtime Gateway 编程规则

当前 runtime gateway 已经完成模块化拆分，结构如下：

```text
apps/desktop-shell/src/main/runtime/
  index.ts
  README.md
  types.ts
  http-utils.ts
  route-matchers.ts
  runtime-helpers.ts
  base-routes.ts
  project-document-routes.ts
  conversation-routes.ts
  skill-routes.ts
  generated-cache-routes.ts
  agent-routes.ts
  vector-routes.ts
  job-routes.ts
```

本轮拆分结果：

- `runtime-server.ts` 已收缩为组合根，负责 server startup/shutdown、上下文装配和总派发。
- 主要路由已按领域拆入 `runtime/` 子模块，并通过 `runtime/index.ts` 集中导出。
- `runtime/README.md` 记录了模块职责，方便后续继续增量维护。

后续继续演进时仍遵守以下拆分触发条件：

- `runtime-server.ts` 超过 400 行。
- 某个 API 区域有 5 个以上 handler。
- 路由需要独立测试。

路由 handler 规则：

- 输入先用 zod parse。
- 输出尽量用 shared schema parse。
- 错误统一返回 `{ detail: string }`。
- 未迁移能力必须显式返回错误，不要静默返回 mock。
- 写入类 handler 必须做路径越界检查。

## 阶段 6 最终收尾验证 (Done)

- 已成功修复 Playwright E2E 中因 `/api/health` 缺少 `version` 字段以及缺失 `/api/license/status` 接口对齐 `licensed: boolean` 字段所导致的前端 Zod 校验及白屏报错。
- 现在，在无 Python 进程常驻的纯 TypeScript 原生本地环境下，全量单元测试、冒烟测试及 6 个 Playwright 端到端（E2E）回归测试均已 100% 绿灯通过。
- `apps/desktop-shell/src/main/runtime-server.ts` 已从千行级路由大文件拆分为轻量组合根，当前主文件体量约 229 行，便于继续维护与补测试。

## 推荐下一次开工顺序

最推荐的下一步是：

1. 继续 `阶段 5.8`，在已切到 TS 的 `/api/conversations/{id}/messages` 基础上补停止响应与错误中断语义。
2. `conversation messages` 已补进 api-client 与 desktop smoke；下一步让 generated cache、skills 写入与 agent runtime 串成统一 TS 链路。
3. 继续扩大 `file_operation` / `skill` intent 的本地执行与 smoke 覆盖，下一步优先排查并补齐“主角名自动推断替换”在 desktop smoke 集成层的专用覆盖，再推进复杂 source 推断与 skill-run 闭环。
4. 最后补前端 Playwright 覆盖，验证聊天输入、流式显示、停止响应和写回目标文档。
5. 若继续做运行时收尾，优先给 `runtime/` 下的 route module 增加更细的集成型测试，而不是再把逻辑堆回 `runtime-server.ts`。

理由：

- `project-session`、`project-manifest`、`document-service`、`generated-cache`、`conversation-service`、`job-service` 和 `skill-service` 的底座已经把项目上下文、文件写入、任务混合调度与技能目录完整接住。
- 当前收尾重点已经转向 agent runtime 的中断语义、前端 E2E 覆盖、运行时路由拆分和文档卫生。
- `planner`、`model-client`、最小 chat/run-stream 骨架已经立住，下一步直接补 `conversation messages` 和更复杂 intent 会比从零开始顺得多。
