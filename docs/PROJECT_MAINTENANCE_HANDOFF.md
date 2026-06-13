# ArcWriter 项目维护与推送交接手册

这份文档给下一位维护者使用。目标是让接手者不用翻完整聊天记录，也能知道这个仓库是什么、怎么启动、怎么验证、怎么推送、怎么发布安装包，以及发布失败时怎么处理。

## 1. 当前项目状态

- 本地项目目录：`D:\xiaoshuo\ts-migration`
- GitHub 仓库：`https://github.com/20321231788a-cmyk/xiaoshuo`
- 主分支：`main`
- 当前桌面版本号：`apps/desktop-shell/package.json` 中的 `version`
- 当前应用名称：`ArcWriter`
- 当前更新源：公开 GitHub Releases
- 当前网站入口：`https://matian.online/`
- 网站注册入口：`https://matian.online/?page=api-relay&auth=register`

本仓库是小说写作软件的 TypeScript/Electron 迁移版。旧 Python 后端已退场，桌面端启动后由 Electron 主进程拉起本地 TypeScript runtime gateway，前端通过 HTTP 调用本地 runtime。

## 2. 目录职责

```text
ts-migration/
  apps/
    desktop-shell/        Electron 主进程、preload、桌面 runtime、打包配置、更新服务
    workbench/            React/Vite 前端工作台 UI
  packages/
    shared/               共享 zod schema、IPC/API 类型
    api-client/           前端 typed fetch client
    config-service/       studio_config.json 读写、AI 配置归一化
    conversation-service/ 会话、附件、摘要文件存储
    crawler-service/      联网拆书爬虫与来源解析
    document-service/     项目文档读写、归档、时间线、伏笔账本
    generated-cache/      AI 生成缓存、恢复、提交、丢弃
    job-service/          后台任务状态机
    model-client/         OpenAI-compatible 请求与流式封装
    project-manifest/     项目树、manifest、只读项目状态
    project-session/      当前项目打开/创建/重命名状态
    skill-service/        内置/导入技能目录与导入流程
    agent-runtime/        AI 工作流、技能调用、拆书、融梗、蒸馏、批量生成等编排
    vector-service/       SQLite 向量索引、embedding、混合检索
  tests/e2e/              浏览器模式 E2E
  docs/                   维护文档、迁移文档
  .github/workflows/      GitHub Actions 发布流程
```

## 3. 本地环境

推荐使用 Windows + Node 22。项目是 npm workspaces，所有命令默认在 `D:\xiaoshuo\ts-migration` 根目录执行。

首次安装依赖：

```powershell
npm install
```

启动完整桌面开发版：

```powershell
npm run dev:desktop
```

只启动前端：

```powershell
npm run dev:workbench
```

桌面开发脚本会构建 workbench，启动 Vite preview，构建 Electron shell，并用 `XIAOSHUO_RENDERER_URL` 指向 preview。需要换端口时：

```powershell
npm run dev:desktop -- --port 4191
```

## 4. 核心运行链路

1. `apps/desktop-shell/src/main/main.ts` 创建 Electron 窗口。
2. 主进程启动 runtime gateway：`http://127.0.0.1:18453`。
3. Runtime 路由集中在 `apps/desktop-shell/src/main/runtime-*` 和 `apps/desktop-shell/src/main/runtime/`。
4. 前端 `apps/workbench` 通过 `@xiaoshuo/api-client` 请求本地 runtime。
5. preload bridge 在 `apps/desktop-shell/src/preload/index.ts` 暴露桌面能力。
6. 共享 IPC 类型在 `packages/shared/src/desktop.ts`，桌面侧镜像在 `apps/desktop-shell/src/shared/channels.ts`。

生产版不加载远程网站前端，而是把 `apps/workbench/dist` 打包进 Electron extraResources。模型请求仍通过本地 runtime 执行。

## 5. AI 配置与网站配置

AI 设置分两套 profile：

- `manual_profile`：本地 API Key、Base URL、模型、`temperature`、`top_p`
- `website_profile`：网站账号 token、模型、`temperature`、`top_p`

`ai_config_mode` 只决定当前使用哪套 profile。切换模式时不要覆盖另一套配置。

网站配置注意事项：

- UI 不显示 URL、API Key、token、Base URL。
- 登录网站配置后，runtime 会把网站 relay token 和隐藏 base URL 写入本地配置。
- 默认网站 base URL 在 runtime 中处理，生产默认是 `https://matian.online`。
- 第一次没有 AI 配置且没有项目使用历史时，前端会默认打开“设置 - 网站配置”。
- 网站充值、兑换、模型列表和账号状态走本地 runtime 代理，前端不要直接跨域请求网站。

相关文件：

- `apps/workbench/src/App.tsx`
- `apps/workbench/src/hooks/useWorkbenchController.ts`
- `apps/desktop-shell/src/main/runtime/website-ai-routes.ts`
- `packages/config-service/src/service.ts`

## 6. 不能提交的文件

以下文件包含本地状态、敏感信息或构建产物，不要提交：

- `studio_config.json`
- `.env`
- `.env.*`
- `dist/`
- `release/`
- `output/`
- `coverage/`
- `test-results/`
- `playwright-report/`
- `sandbox-projects/`
- `*.log`
- 截图、临时图片和手工测试产物

提交前必须看：

```powershell
git status --short
```

如果看到上面这些产物，先确认 `.gitignore` 是否已覆盖，不要用 `git add .` 盲加。

## 7. 常用验证命令

轻量验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run typecheck -w @xiaoshuo/desktop-shell
npm run build:workbench
npm run build:desktop
```

全量类型检查：

```powershell
npm run typecheck --workspaces --if-present
```

桌面 smoke：

```powershell
npm run smoke:desktop
```

本地打包：

```powershell
npm run dist -w @xiaoshuo/desktop-shell
```

测试：

```powershell
npm test
npm run test:e2e
```

不是每次小 UI 改动都必须跑所有测试，但发布前至少应通过：

```powershell
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

## 8. 本地打包产物

打包输出目录：

```text
apps/desktop-shell/release/
```

应看到：

```text
ArcWriter-Setup-x.y.z.exe
ArcWriter-Setup-x.y.z.exe.blockmap
latest.yml
win-unpacked/
```

`latest.yml` 里的 `path` 必须能对应同目录下真实存在的安装包文件。例如：

```yaml
path: ArcWriter-Setup-0.1.5.exe
```

则必须存在：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.1.5.exe
```

如果两者不一致，自动更新会失败。

## 9. 普通代码推送方案

适用于普通修 bug、UI 调整、文档调整，不发布安装包。

1. 确认当前分支：

```powershell
git branch --show-current
```

2. 查看改动：

```powershell
git status --short
git diff --stat
```

3. 跑最小验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run typecheck -w @xiaoshuo/desktop-shell
```

4. 提交：

```powershell
git add <明确文件列表>
git commit -m "简短英文提交信息"
```

5. 推送：

```powershell
git push origin main
```

不要把 `release/`、`dist/`、`studio_config.json` 或日志文件加进提交。

## 10. 正式发布方案

适用于需要让用户下载新安装包或软件内检查更新的版本。

1. 修改版本号：

```powershell
# 编辑 apps/desktop-shell/package.json
# 例如 0.1.5 -> 0.1.6
```

2. 同步锁文件：

```powershell
npm install --package-lock-only -w @xiaoshuo/desktop-shell
```

3. 本地验证：

```powershell
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

4. 检查本地产物：

```powershell
Get-ChildItem apps\desktop-shell\release -Filter "ArcWriter-Setup-*"
Get-Content apps\desktop-shell\release\latest.yml
```

5. 提交版本改动：

```powershell
git add apps/desktop-shell/package.json package-lock.json
git commit -m "Release ArcWriter x.y.z"
git push origin main
```

6. 创建并推送标签：

```powershell
git tag -a vx.y.z -m "ArcWriter x.y.z"
git push origin vx.y.z
```

7. GitHub Actions 会自动运行 `.github/workflows/release.yml`。工作流会：

- 安装依赖
- 全工作区 typecheck
- 构建 workbench
- 构建 desktop
- 本地打包安装包
- 上传 Release 资产

Release 资产必须包含：

- `ArcWriter-Setup-x.y.z.exe`
- `ArcWriter-Setup-x.y.z.exe.blockmap`
- `latest.yml`

8. 发布后验证下载链接：

```powershell
$version = "0.1.5"
$base = "https://github.com/20321231788a-cmyk/xiaoshuo/releases/download/v$version"
Invoke-WebRequest -UseBasicParsing -Method Head "$base/latest.yml" -MaximumRedirection 5
Invoke-WebRequest -UseBasicParsing -Method Head "$base/ArcWriter-Setup-$version.exe" -MaximumRedirection 5
Invoke-WebRequest -UseBasicParsing -Method Head "$base/ArcWriter-Setup-$version.exe.blockmap" -MaximumRedirection 5
```

三个链接都应返回成功。安装包链接如果 404，软件内自动更新也会失败。

## 11. 发布失败处理

如果 tag 已推送但 GitHub Actions 失败：

1. 不要继续在失败 tag 上堆修改。
2. 不要强推已有 tag，除非明确知道没有用户或 CI 消费过它。
3. 本地修复 workflow 或打包配置。
4. 升一个补丁版本，例如 `0.1.5 -> 0.1.6`。
5. 重新提交、推送 `main`，再推新 tag。

常见失败：

- `latest.yml` 存在，但 exe 404：安装包文件名和 `latest.yml` 的 `path` 不一致。检查 `apps/desktop-shell/package.json` 的 `build.win.artifactName`。
- Release 只有源码包，没有安装包：workflow 上传步骤未匹配到文件或中途失败。检查 `.github/workflows/release.yml` 的 `files` glob。
- `electron-updater` 启动崩溃：Electron 主进程是 ESM，`electron-updater` 需要用 `createRequire` 兼容加载。
- CI 原生依赖重建失败：当前 dist/release 脚本带 `-c.npmRebuild=false`，不要随意移除。
- GitHub API rate limit：等一段时间再查，或者直接打开 Actions/Release 页面确认。

## 12. GitHub 更新链路

客户端更新逻辑：

- `apps/desktop-shell/src/main/update-service.ts` 封装更新检查、下载、安装重启。
- `apps/desktop-shell/src/main/main.ts` 注册更新 IPC。
- `apps/desktop-shell/src/preload/index.ts` 暴露 `xiaoshuoDesktop.updates`。
- `apps/workbench/src/App.tsx` 的“软件更新”区域调用更新桥接。

发布配置：

- `apps/desktop-shell/package.json`：Electron Builder 配置、安装包命名、GitHub provider。
- `.github/workflows/release.yml`：CI 构建与上传 Release 资产。

原则：

- GitHub token 只在 GitHub Actions 中使用仓库自带 `GITHUB_TOKEN`。
- 客户端不要内置 GitHub token。
- 更新源使用公开 GitHub Releases。
- 不做静默安装，用户必须点击“重启安装”。

## 13. 接手者第一天检查清单

1. 拉取仓库：

```powershell
git clone https://github.com/20321231788a-cmyk/xiaoshuo.git
cd xiaoshuo
```

2. 安装依赖：

```powershell
npm install
```

3. 检查类型：

```powershell
npm run typecheck --workspaces --if-present
```

4. 启动桌面开发版：

```powershell
npm run dev:desktop
```

5. 打开设置页，确认：

- “网站配置”在“手动配置”前面。
- 网站配置不显示 URL、Key、token、Base URL。
- 有“注册”“前往网站”“兑换”“充值”入口。
- `temperature` 和 `top_p` 是滑块。
- 首次无 AI 配置时默认进入网站配置。

6. 打包一次：

```powershell
npm run dist -w @xiaoshuo/desktop-shell
```

7. 检查 `latest.yml` 与安装包文件名是否一致。

## 14. 维护优先级建议

优先级从高到低：

1. 启动稳定性：Electron 主进程、runtime gateway、preload bridge。
2. 配置安全：不要泄露网站 token、本地 API Key、Base URL。
3. 生成链路：AI 对话、技能调用、拆书、批量、抽卡、伏笔、一致性检查。
4. 项目文件安全：文档保存、归档、时间线、生成缓存恢复。
5. 发布链路：Release assets、`latest.yml`、安装包启动。
6. UI polish：浅蓝工作台风格、响应式布局、按钮密度。

## 15. 最近重要变更

- UI 已改成浅蓝三栏工作台风格。
- 设置页已改为“网站配置 / 手动配置”双模式，网站配置优先。
- 网站配置新增注册、前往网站、兑换、充值入口。
- 顶部菜单精简为“退出 / 刷新 / 教程”。
- 教程弹层加入网站注册、登录、模型、充值兑换、授权说明。
- 软件更新改为 GitHub Releases。
- 安装包命名应统一为 `ArcWriter-Setup-x.y.z.exe`，与 `latest.yml` 保持一致。
- 2026-06-13 审计后的三轮改动已合并：
  - 会话体验与网页搜索上下文修复：AI 对话页会自动滚动到末尾；联网搜索素材上下文数字输入改成可自主输入任意范围内数值，不再被 3000/8000 固定值卡住。
  - 题材库、风格库旧项目逻辑对齐：`style_extract` 生成并拆分保存 `写作风格.txt`、`风格示例.txt`、`参考素材.txt`；`genre_generate` 生成并拆分保存 `题材规则.txt`、`题材素材.txt`、`战斗模板.txt`、`违禁词.txt`。聊天、技能、正文生成、抽卡正文候选都会注入同一套风格/题材约束块，向量索引的来源分类也改为识别 `风格库` 和 `题材库`。
  - 全 AI 生成流式与旧缓存保存：`/api/agent/run-stream` 的 `delta` 事件支持 `stage`、`skill_id`、`cache_id`、`target_paths`；prompt skill 生成开始即创建 `00_设定集/.agent/generated_cache/<cache_id>/`，流式追加，结束 replace 最终内容。Workbench 功能页公共入口已改为流式调用；明确“保存/写入/覆盖/追加”等意图时按旧项目逻辑直接提交缓存并刷新项目树和向量索引。

### 15.1 2026-06-13 改动审计结论

本次审计按最近三轮用户目标逐项确认：

1. AI 对话自动到底部、联网搜索上下文可填入：
   - 已解决。相关改动在 `apps/workbench/src/App.tsx` 和 `apps/workbench/src/views/ConversationsView.tsx`。
   - 数字输入从直接受控 `number` 改为本地 draft + blur/Enter commit，用户可以输入中间态，不会刚键入就被归一化回固定值。

2. 题材库、风格库生成逻辑向旧项目对齐：
   - 已解决主要路径。相关改动在 `packages/skill-service/src/service.ts`、`packages/agent-runtime/src/skill-runner.ts`、`packages/agent-runtime/src/generated-save-planner.ts`、`packages/agent-runtime/src/style-genre-context.ts`、`packages/vector-service/src/indexer.ts`。
   - 风格库/题材库的多文件拆分、保存规划、缓存提交路由和正文/会话上下文注入都已覆盖。

3. 所有 AI 生成改为流式输出，保存复用旧项目缓存模式：
   - 已解决主链路。相关改动在 `packages/agent-runtime/src/stream.ts`、`packages/agent-runtime/src/skill-runner.ts`、`packages/agent-runtime/src/runtime.ts`、`packages/shared/src/schemas/agent.ts`、`apps/workbench/src/hooks/useWorkbenchController.ts`、`apps/desktop-shell/src/main/runtime/agent-routes.ts`。
   - 聊天与 prompt skill 是真实增量流；复杂 workflow 入口已经统一走流事件和缓存/保存链路，其中部分内部子阶段仍是“阶段提示 + 最终结果块”的兼容流。后续如果要继续细化，应优先拆 `body_generate` 的一致性检查/修订/去 AI 味、`book_fusion`、`nuwa_style_distill` 和抽卡候选生成。

本轮已验证：

```powershell
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm test -- packages/agent-runtime/src/skill-runner.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts
npm test -- packages/agent-runtime/src/generated-save-planner.test.ts
```

## 16. 交接注意

接手时先看这三个文件：

- `README.md`
- `docs/PROJECT_MAINTENANCE_HANDOFF.md`
- `.github/workflows/release.yml`

改 UI 先看：

- `apps/workbench/src/App.tsx`
- `apps/workbench/src/styles.css`
- `apps/workbench/src/hooks/useWorkbenchController.ts`

改 runtime/API 先看：

- `apps/desktop-shell/src/main/runtime-server.ts`
- `apps/desktop-shell/src/main/runtime/`
- `packages/shared/src/index.ts`
- `packages/api-client/src/index.ts`

改配置或模型调用先看：

- `packages/config-service/src/service.ts`
- `packages/model-client/src/index.ts`
- `packages/agent-runtime/src/runtime.ts`

改发布和更新先看：

- `apps/desktop-shell/package.json`
- `apps/desktop-shell/src/main/update-service.ts`
- `.github/workflows/release.yml`
