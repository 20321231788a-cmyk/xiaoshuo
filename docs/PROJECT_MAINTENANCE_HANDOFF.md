# ArcWriter 项目维护交接手册

> 最近整理：2026-07-13
>
> 当前版本：0.4.0
>
> 当前结论：Batch A、Batch B 和最终集中验收已完成，本轮修改通过代码验收；M2～P5 仍处于集成阶段，P7 仅完成证据机制。不是 RC，也不能声明生产就绪。

本文只保留接手工作需要的当前事实、操作入口、约束和可复用证据。2026-06-13 至 2026-07-13 的逐文件开发流水已从正文移除，需要时通过 Git 历史查询，不再把过期测试结果和已被推翻的状态长期堆叠在交接手册中。

## 1. 先看这里

### 1.1 文档职责

| 文档 | 用途 |
| --- | --- |
| `docs/PROJECT_MAINTENANCE_HANDOFF.md` | 当前运维、接手入口、剩余工作和关键证据 |
| `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md` | Agent 优化的上位设计、阶段契约和第 19 节安全边界 |
| `docs/AGENT_OPTIMIZATION_NEXT_IMPLEMENTATION_MANUAL.md` | 当前 Batch A、Batch B、最终验收和退出条件 |
| `README.md` | 仓库启动与基础开发说明 |
| Git 历史 | 已完成版本和逐刀实现的完整审计记录 |

若三份 Agent 文档出现冲突，当前执行节奏以优化手册第 17、20 节和后续实施手册第 0.3、2 节为准：**两个修改批次完成后，只执行一次最终集中验收。** 当前代码、workflow 和发布事实以本手册第 4、8 节及优化手册第 20 节为准；优化手册中明确描述 0.4.0 或早期 CI 基线的段落只作历史设计依据。

### 1.2 项目快照

| 项目 | 当前值 |
| --- | --- |
| 本地目录 | `D:\xiaoshuo\ts-migration` |
| GitHub | `https://github.com/20321231788a-cmyk/xiaoshuo.git` |
| 主分支 | `main` |
| 应用 | ArcWriter |
| 桌面版本 | `apps/desktop-shell/package.json`，当前为 `0.4.0` |
| 技术栈 | TypeScript、Electron、React/Vite、npm workspaces |
| 本地 runtime | `http://127.0.0.1:18453` |
| 网站 | `https://matian.online/` |
| 网站注册 | `https://matian.online/?page=api-relay&auth=register` |
| 更新源 | 客户端默认 COS 镜像优先，失败后回退公开 GitHub Releases |

旧 Python 后端已经退场。Electron 主进程启动本地 TypeScript runtime gateway，Workbench 通过 typed API client 调用 runtime；生产包加载随安装包分发的 `apps/workbench/dist`。

### 1.3 当前最重要的结论

- 不要恢复“P0～P7 已全部完成”“稳定全绿”或“可投产”的旧说法。
- 当前工作树已完成一次可追溯的最终矩阵；历史绿码仍只作为定位基线，不能代替此记录。
- M2、M3、M4、P3、P4、P5 均仍标记为“集成中”；P7 仅完成可复现证据机制；M7 RC 尚未开始。
- 下一步只做独立的 M7 RC 门禁，不重复 Batch A/B 的开发闭环。
- 第 19 节七项能力是硬禁区，任何 Feature Flag、环境变量、Prompt、网页、附件、项目文件或 Skill 都不能解锁。
- 工作树可能包含用户和当前优化工作的未提交改动。先看 `git status --short`，禁止 reset、clean 或覆盖不属于当前任务的修改。

## 2. 架构与目录

### 2.1 核心运行链路

1. `apps/desktop-shell/src/main/main.ts` 创建 Electron 窗口。
2. 主进程启动本地 runtime gateway。
3. runtime 路由位于 `apps/desktop-shell/src/main/runtime/`。
4. Workbench 通过 `@xiaoshuo/api-client` 请求 runtime。
5. `apps/desktop-shell/src/preload/index.ts` 暴露受控桌面能力。
6. IPC/API schema 由 `packages/shared` 统一定义。
7. Agent durable run、预算、确认、记忆和质量门由 `packages/agent-runtime` 协调。

HTTP/NDJSON 连接只是订阅通道。renderer reload、页面切换或订阅断开不能隐式 pause/cancel durable run；状态变更必须通过带版本和 operation ID 的受控调用。

### 2.2 目录职责

| 路径 | 职责 |
| --- | --- |
| `apps/desktop-shell` | Electron main/preload、runtime、打包、更新和安装态验证 |
| `apps/workbench` | React/Vite 工作台 |
| `packages/shared` | zod schema、API/IPC 契约 |
| `packages/api-client` | 前端 typed client |
| `packages/agent-runtime` | Agent workflow、durable run、记忆、上下文和质量门 |
| `packages/document-service` | 项目文档、归档、时间线和安全写入 |
| `packages/generated-cache` | 生成缓存、预览、提交和恢复 |
| `packages/config-service` | `studio_config.json` 与 AI profile |
| `packages/model-client` | OpenAI-compatible 模型调用 |
| `packages/conversation-service` | 会话、附件和摘要 |
| `packages/vector-service` | SQLite 向量索引与图谱 |
| `tests/e2e` | Browser Playwright E2E |
| `.github/workflows` | Windows PR、RC/nightly 和 release gate |

### 2.3 关键持久数据

| 数据 | 位置/权威来源 |
| --- | --- |
| Durable run | 项目内 `00_设定集/.agent/agent_runs.sqlite3` |
| Governed memory | 项目内 `00_设定集/.agent/governed_memory.sqlite3` |
| Generated cache | `00_设定集/.agent/generated_cache/` |
| 项目身份 | project manifest 的稳定 UUID，加 canonical path/file identity guard |
| AI 配置 | 本地 `studio_config.json` |

不要把进程内 Map、UI state 或 Trace 当成持久事实源。

## 3. 本地环境与启动

推荐 Windows + Node 22。在仓库根目录执行：

```powershell
npm install
npm run dev:desktop
```

只启动 Workbench：

```powershell
npm run dev:workbench
```

更换桌面 preview 端口：

```powershell
npm run dev:desktop -- --port 4191
```

已有 renderer 时可使用 `XIAOSHUO_RENDERER_URL`。`XIAOSHUO_RUNTIME_URL` 只影响启动脚本传给 renderer 的 URL，不能让 Electron 复用外部 runtime；主进程仍会启动绑定本进程 session token 的本地 runtime。不要把该变量描述成 runtime 复用开关，也不要让测试探针误连正在使用的正式实例。

### 3.1 AI 与网站配置

配置分为：

- `manual_profile`：本地 API Key、Base URL、模型、`temperature`、`top_p`。
- `website_profile`：网站 token、模型、`temperature`、`top_p`。

`ai_config_mode` 只选择当前 profile，切换模式不能覆盖另一套配置。网站 token、API Key 和隐藏 Base URL 不应暴露到 UI、日志、Trace 或 CI artifact。网站账号、模型、兑换和充值请求必须经本地 runtime 代理。

### 3.2 不得提交

- `studio_config.json`
- `.env`、`.env.*`
- `dist/`、`release/`、`output/`
- `coverage/`、`test-results/`、`playwright-report/`
- `sandbox-projects/`
- 日志、截图、临时项目和手工测试产物

提交前始终执行：

```powershell
git status --short
git diff --stat
```

不要使用 `git add .` 收集不明确的文件。

## 4. 当前实现状态

| 范围 | 状态 | 当前事实 | 剩余出口 |
| --- | --- | --- | --- |
| M0/M1 | 本轮代码验收通过 | 文档口径已校准；Desktop smoke 认证经 preload/IPC，最终 smoke 通过 | M7 installed-build 和发布证据 |
| M2 | 集成中，本轮代码验收通过 | 主执行门和八个子 Flag 均有生产消费者及关闭路径 | M7 独立的 Flag 放量与回滚演练 |
| M3/P6 | 集成中，本轮代码验收通过 | 会话计划卡/Trace 使用真实 run/version/step；E2E 6/6 覆盖控制、冲突、reload 与确认 | packaged installed-build 证据留给 M7 |
| M4 | 集成中，本轮代码验收通过 | Negative Capability Gate、用户终端手势、预算、Action receipt、项目身份均已接入；excluded-capabilities manifest 110/110 | M7 安装/发布级安全证据 |
| P3 | 集成中，本轮代码验收通过 | governed store、二次确认、来源失效、结构化摘要、治理 UI、投影/重建和 100 轮隔离回放已接入 | M7 的完整 RC 证据 |
| P4 | 集成中，本轮代码验收通过 | ContextScheduler 覆盖 chat/skill 上下文，并保留 Flag 回退 | M7 版本化上下文质量数据 |
| P5 | 集成中，本轮代码验收通过 | 统一 pre-save quality gate、报告和经确认 feedback 已接线 | M7 人工质量校准 |
| P7 | 证据机制完成，本阶段未完成 | 每个 eval 写 manifest/hash/case/artifact；Windows workflow 使用 `always()` 上传 | sealed holdout、最低数据规模、统计协议和人工校准 |
| M7 | 预演中 | 本地构建了 0.4.0 安装器；安装/卸载和 0.3.2 → 0.4.0 → 0.3.2 通过；dirty evidence 被拒绝；RC/release 强制 13 类数据集/holdout declaration | 干净候选、签名、真实数据规模、installed-build、soak、人工校准和 release evidence |

### 4.1 可复用的历史证据

| 范围 | 历史证据 | 限制 |
| --- | --- | --- |
| M3 | Browser E2E 6/6 | 使用 test-only runtime token，不是安装态 IPC 证据 |
| M4 | `eval:excluded-capabilities` 11 files / 104 tests，E2E 6/6，Desktop smoke | 属于较早代码树，不替代最终矩阵 |
| P3/B3 | 9 files / 178 tests，相关 workspace typecheck | L2/L3 未执行；只证明定向实现基线 |
| M2 子 Flag | runtime + desktop route 2 files / 117 tests，两个 workspace typecheck 和 diff check | 后增的高负载 fixture 已移除，不算绿色证据 |

不得把表中结果相加后宣称“当前全绿”。

## 5. 下一步执行

### 5.1 本轮开发闭环已结束

Batch A 已完成 durable UI 状态校准、P4 token 上下文调度/回退和 P5 统一质量门/确认反馈；Batch B 已完成 Eval Manifest、固定 seed、fixture/case hash、诊断 artifact 与 Windows workflow 上传。固定六命令矩阵最终复跑已通过，详细记录见 12.3。

不要为同一工作树重新执行 Batch A/B，也不要把浏览器 harness 的 token 或 source smoke 称为安装态发布证据。

### 5.2 后续仅限 M7 RC 门禁

1. 建立符合手册最低规模的版本化数据集和至少 20% sealed holdout，完成统计协议和人工质量校准。
2. 在干净候选 commit 上执行 clean install/build、installed-build smoke、Authenticode 签名/时间戳和同 commit release evidence；本地 `NotSigned` 包不能复用。
3. 复跑已接线的 previous-release download、安装、升级、回滚 smoke，并演练 SQLite migration/backup、commit journal 故障恢复和至少两小时长任务 soak。
4. 验证发布包与 COS/GitHub 更新回退链路；在所有 M7 证据齐备前不得 bump release 或创建 tag。

## 6. 第 19 节安全边界

以下七项在 0.5.0～0.9.0 内保持硬禁用：

1. 多 Agent 并行协作。
2. Agent 自行安装任意工具或库。
3. Agent 或模型驱动的任意 shell/代码执行；唯一例外是与 Agent 隔离、经真实用户手势和 Electron/IPC 主进程受控通道创建的用户手动 terminal。
4. Agent 自动修改和发布自身运行内核。
5. 无预算后台自治任务。
6. 未经确认的跨项目越权写入。
7. 未经用户二次确认，把模型 draft 直接写入 Confirmed Memory。

执行不变量：

- Agent Action Registry、runtime API、模型 tool schema 和 Skill manifest 不暴露 `terminal.*`。
- 用户手动 terminal 是独立 capability，只能经 Electron preload/IPC/main process 和真实用户手势创建。
- 当前跨项目写入直接拒绝；未来若讨论放开，必须另立 ADR、精确 scope receipt 和专属安全评估。
- Confirmed Memory 固定遵循 `draft -> proposed -> confirmed`；模型最多创建 draft/proposed。
- 每个 run 必须有步骤、重规划、模型调用、token、费用和 deadline 预算。
- 未知 actor、capability、scope 或缺失确认一律 fail closed。
- 任何 Feature Flag 都不能开启本节能力。

负向门禁统一由 `npm run eval:excluded-capabilities` 覆盖，并进入最终矩阵和未来 RC/release。

## 7. Git 与普通推送

普通代码或文档修改：

```powershell
git branch --show-current
git status --short
git diff --stat
git diff --check
```

只暂存明确文件：

```powershell
git add <明确文件列表>
git commit -m "concise English message"
git push origin main
```

当前 Batch A/B 期间，提交不是测试触发器。可以按可回滚能力拆提交，但不要在提交边界重复跑全量测试，也不要把无关 UI、格式化、构建产物或用户文件混入提交。

## 8. CI、打包与发布

### 8.1 当前工作流

| Workflow | 作用 | 当前限制 |
| --- | --- | --- |
| `windows-pr-ci.yml` | main/PR 的 typecheck、test、build、Browser E2E、Desktop source smoke 和全部 eval | `always()` 上传 eval manifest、失败摘要、脱敏 trace、性能/安全计数；不替代 RC |
| `desktop-rc.yml` | nightly/手动 RC 打包、安装态 smoke、完整 eval 和 evidence | P7 artifact 已接线；数据规模、签名与人工校准仍由 M7 关闭 |
| `release.yml` | `v*` tag 的 Windows release gate、签名、安装态 smoke 和发布 | 也暴露 `workflow_dispatch`，但非 tag ref 当前会被 tag/version 校验拒绝；M7 前不得用于宣称生产就绪 |

M7 仍必须确保 tag release 消费同一 commit 的不可变 RC 证据，不能只在打 tag 后临时补门禁。当前 release workflow 只发布 GitHub 资产，不负责同步或验证 COS 镜像；正式发布流程必须另行提供镜像同步/校验证据，或明确验证客户端能安全回退 GitHub。

### 8.2 本地打包

```powershell
npm run build:workbench
npm run build:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

产物位于 `apps/desktop-shell/release/`：

- `ArcWriter-Setup-x.y.z.exe`
- `ArcWriter-Setup-x.y.z.exe.blockmap`
- `latest.yml`
- `win-unpacked/`

`latest.yml.path` 必须与真实 exe 文件名一致。

### 8.3 正式发布

只有 M7 前置条件满足后才执行：

1. 修改 `apps/desktop-shell/package.json` 的 version。
2. 同步 lockfile：

```powershell
npm install --package-lock-only -w @xiaoshuo/desktop-shell
```

3. 确认 RC evidence 与候选 commit 一致。
4. 提交并推送版本改动。
5. 创建与 version 完全一致的 tag：

```powershell
git tag -a vx.y.z -m "ArcWriter x.y.z"
git push origin vx.y.z
```

6. `release.yml` 需要 production environment approval，以及 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。
7. workflow 必须完成签名/时间戳、installed-build smoke 和 same-commit release evidence。
8. Release 至少包含 exe、blockmap、`latest.yml`、installed smoke 和 release evidence。

发布后验证：

```powershell
$version = "x.y.z"
$base = "https://github.com/20321231788a-cmyk/xiaoshuo/releases/download/v$version"
Invoke-WebRequest -UseBasicParsing -Method Head "$base/latest.yml" -MaximumRedirection 5
Invoke-WebRequest -UseBasicParsing -Method Head "$base/ArcWriter-Setup-$version.exe" -MaximumRedirection 5
Invoke-WebRequest -UseBasicParsing -Method Head "$base/ArcWriter-Setup-$version.exe.blockmap" -MaximumRedirection 5
```

tag 已推送但 workflow 失败时，不在旧 tag 上堆修复或强推。修复后升补丁版本、提交 main，再创建新 tag。

## 9. 常见故障

| 现象 | 首要检查 |
| --- | --- |
| runtime 401 | 受保护调用是否绕过 preload/IPC session token |
| Browser E2E 通过但安装态失败 | Browser harness 使用 test-only token，不能替代 installed Electron |
| `latest.yml` 存在但 exe 404 | `artifactName`、version、tag 和 `latest.yml.path` 是否一致 |
| Release 只有源码包 | workflow 的 files glob 和前序打包步骤 |
| 签名失败 | production secrets、证书有效期和时间戳 |
| `electron-updater` 在 ESM 下崩溃 | 是否通过兼容加载方式引入 |
| 原生依赖在 CI 重建失败 | dist/release 的 `-c.npmRebuild=false` 是否被误删 |
| 项目写入被 scope guard 拒绝 | manifest UUID、canonical root、symlink/junction 和 file identity |
| run 无法恢复 | expected version、budget、memory revision、lease/attempt 状态 |
| `rg` 无法执行 | 先运行 `rg --version` 和 `Get-Command rg`；当前已验证 ripgrep 15.1.0 |

不要通过关闭认证、放宽路径校验、跳过确认或扩大预算来“修复”测试。

## 10. 按任务找入口

| 任务 | 首要文件 |
| --- | --- |
| Electron 生命周期/runtime | `apps/desktop-shell/src/main/main.ts`、`runtime-server.ts`、`main/runtime/` |
| preload/IPC/terminal | `apps/desktop-shell/src/preload/index.ts`、`src/shared/channels.ts` |
| Workbench UI | `apps/workbench/src/App.tsx`、`features/`、`hooks/controllers/`、`styles.css` |
| API 契约 | `packages/shared/src/schemas/`、`packages/api-client/src/client.ts` |
| Agent 执行 | `packages/agent-runtime/src/runtime.ts`、`planner.ts`、`chat-runner.ts` |
| Durable run | `packages/agent-runtime/src/kernel/` |
| Governed memory | `packages/agent-runtime/src/governed-memory-store.ts` 及 memory/projection 模块 |
| 项目文档/Journal | `packages/document-service`、agent runtime commit journal |
| AI 配置/模型 | `packages/config-service/src/service.ts`、`packages/model-client` |
| 发布/更新 | `apps/desktop-shell/package.json`、`update-service.ts`、`.github/workflows/` |

## 11. 历史索引

### 11.1 版本索引

| 日期 | 版本 |
| --- | --- |
| 早期标签 | v0.1.0～v0.1.7（仓库没有 v0.1.8） |
| 2026-06-13 | v0.1.9、v0.2.0 |
| 2026-06-14 | v0.2.1、v0.2.2 |
| 2026-06-15 | v0.2.3、v0.2.4、v0.2.5 |
| 2026-06-16 | v0.2.6、v0.2.7 |
| 2026-06-20 | v0.2.8 |
| 2026-06-26 | v0.2.9、v0.3.0 |
| 2026-06-28 | v0.3.1、v0.3.2 |
| 2026-07-08 | 0.4.0 版本同步 |

具体变更、commit、构建结果和发布资产以 Git tag、GitHub Release 和 Git 历史为准。

### 11.2 工程里程碑

| 日期 | 里程碑 | 当前解释 |
| --- | --- | --- |
| 2026-06-20 | GraphRAG-lite、拆书树和分屏工作台 | 早期功能基线 |
| 2026-07-07 | Workflow Registry、ContextAssembler、GraphMemory、Eval、Controller 和 Skill 平台化 | 原型/基础设施，不等同当前 P3～P7 完成 |
| 2026-07-10 | P0 durable run、Execution Store、CommitJournal、恢复、认证和发布门禁 | 主体实现已有历史证据 |
| 2026-07-11 | M1 smoke 认证、M2 gate、M3 计划卡、M4 Negative Capability Gate | 后续多次校准，现状见第 4 节 |
| 2026-07-13 | Batch A/B 收口、Eval artifact 机制和最终矩阵 | 本轮代码验收通过；M7 RC 证据仍未形成 |

2026-07-11 曾出现“P3～P7 100% 绿过/完成”的记录，随后代码审阅确认生产消费者、Manifest、安装态和 RC 证据不完整，该结论已经撤销，不得恢复。

## 12. 接手与后续记录

### 12.1 接手检查

1. 阅读本文件和两份优化手册。
2. 执行 `git status --short`，区分用户改动、当前批次和生成产物。
3. 确认 Node 22、`npm --version` 和 `rg --version`。
4. 不重新执行旧 B1/B2/B3 或逐 Flag 验收。
5. 不重复 Batch A/B；从 M7 数据集、安装态和发布证据开始。
6. 先核对 12.3 记录和候选 commit，再生成新的 RC 证据。
7. 不在未取得 M7 证据时 bump release/tag。

### 12.2 交接记录规则

不要恢复 `15.1～15.92` 式逐小改动流水。Batch A、Batch B 和最终集中验收全部结束后，只追加一条合并记录：

```markdown
### YYYY-MM-DD Batch A + Batch B 集中验收

- 候选 commit：
- Batch A 范围：
- Batch B 范围：
- Flag 开/关与回滚：
- 数据迁移：
- 中途例外检查：
- 首次六命令矩阵：
- 失败项与定向重跑：
- 修复后的完整矩阵最终复跑：
- 复用的历史证据：
- RC 未完成项：
```

记录必须写实际命令、结果和未完成项。禁止只写“全绿”“完成”或测试数量，不得把开发闭环验收描述为 RC/生产发布证据。

### 12.3 2026-07-13 Batch A + Batch B 集中验收

- 状态：本轮修改通过代码验收；M2～P5 继续为集成中，P7 仅完成可复现证据机制，非 RC 候选。
- 候选 commit：工作树尚未提交；验证基线 HEAD 为 `7a0d697`。
- Batch A 范围：durable UI 控制后的 run/event 校准，`ContextScheduler` 的 chat/skill 调度与 Flag 回退，以及 generated cache、文件操作、项目文档的统一 quality gate 和用户确认 feedback。
- Batch B 范围：`scripts/run-eval.mjs`、Eval Manifest/fixture inventory、case/failure/trace/performance/security artifact、三个 Windows workflow 的 `always()` 上传。
- Flag 开/关与回滚：`context_budget_v2=off` 回到 legacy assembler；`memory_context_selector_v2=off` 保留 P4a 预算；`quality_gate_v2=off` 回到旧保存检查；其他已有 v2 Flag 保持各自 fail-closed/legacy 分支。
- 数据迁移：Execution Store migration 2（P5 feedback store）和 migration 3（M4 model budget ledger）保留 pre-migration backup/只读高 schema 隔离；回滚使用已校验 backup，不 down-migrate 用户数据。
- 中途例外检查：定向 Playwright `project-entry.spec.ts` 6/6，用于修复协作式暂停后的事件/状态同步。
- 首次六命令矩阵：typecheck、test、E2E、Desktop smoke 通过；`eval:excluded-capabilities` 在 Windows 以 `shell: false` 启动 `npx.cmd` 时发生 `spawn EINVAL`，测试未执行。
- 失败项与定向重跑：运行器改为由当前 Node 直接启动锁定的 Vitest 入口；`npm run eval:excluded-capabilities` 通过并生成 manifest。
- 修复后的完整矩阵最终复跑：`npm run typecheck` 通过；`npm test` 103 files / 836 tests；`npm run test:e2e` 6/6；`npm run smoke:desktop` 通过；`npm run eval:excluded-capabilities` 110/110、pass rate 1；`git diff --check` 通过（仅 CRLF 预警）。
- 复用的同 commit 证据：无；最终矩阵直接在当前工作树重跑。文档状态更新属于验证后的文档提交，不改变已验证的产品代码。
- RC 未完成项：最低数据规模、sealed holdout、clean install/build、installed-build smoke、签名/时间戳、安装/升级/回滚、soak、人工质量校准和 same-commit release evidence。

### 12.4 2026-07-13 M7 本地预演

- 本地 `npm run dist -w @xiaoshuo/desktop-shell` 产生 `ArcWriter-Setup-0.4.0.exe` 与 blockmap；因前台工具时限，构建改为后台监控，最终产物与 electron-builder 成功日志均存在。
- `smoke-installed-desktop.ps1` 对该安装器的静默安装、启动观测和卸载通过。
- 新增 `smoke-upgrade-rollback-desktop.ps1`，使用本地 0.3.2 基线与 0.4.0 候选完成安装、升级、回滚、启动观测和卸载。
- 新增 previous-release 下载脚本；RC/release workflow 现在要求此基线并将升级/回滚 evidence 绑定候选安装器 hash、source commit 和发布 evidence。
- 本地构建来自 dirty workspace，evidence 写入 `workspace_dirty=true`，验证器按预期拒绝；Authenticode 检查为 `NotSigned`，没有证书时不得绕过。
- 新增 `verify-rc-eval-evidence.mjs`；RC/release 需要 13 类数据集、每类最低 case 数、至少 20% sealed holdout 和 project-group 声明。缺少 `evals/rc-dataset-manifest.json` 的负向验证已确认 fail closed。
- M7 仍未完成：干净同 commit 安装包、有效签名/时间戳、真实数据集/holdout、soak、人工校准、迁移故障演练和真实 CI/release evidence。
