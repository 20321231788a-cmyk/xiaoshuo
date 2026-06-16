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

### 15.2 2026-06-13 v0.1.9 发布记录

本次发布版本：`0.1.9`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- Skill 路由从“内置规则先命中先返回”改为全局候选评分排序。新增 `rankSkillRoutes()`、`SkillRouteIntent`、`RankedSkillRoute` 等导出，`resolveSkillRoute()` 和 `routeBuiltinSkill()` 保持兼容但改为取最高分候选。
- 正文、对白、片段、风格仿写会优先匹配语义相近的导入 Skill 或写作 Skill；明确大纲、润色、设定提取、一致性检查仍保持正确路由；普通聊天和读取上下文不强行绑定 Skill。
- `smart-skill-orchestrator`、`runtime`、`chat-runner` 已统一使用候选评分结果。显式 `skill_id` 永远优先；当前会话 Skill 只在语义兼容时继承。
- 拆书联网来源已收敛：Workbench 去掉旧来源下拉，只保留“自动来源：Bing”和“自定义来源”切换；输入框下方新增“保存来源”按钮，自定义 URL 保存在本地浏览器存储。
- 爬虫后端不再自动轮询书海阁、Novel543、书库阁、zxtyz、22biqu 等旧来源，避免在用户输入其它 URL 时出现一串“其它来源 403”。书名走 Bing 定位候选目录；直接 URL 或保存的自定义 URL 走通用目录解析。
- 右侧 AI 面板新增固定“运行结果”区域，只显示结果正文；拆书右侧状态不再展示任务 ID 和失败来源明细，只显示进度和最终写入文件。
- 桌面 smoke 改为自动分配独立 runtime 端口，并通过 `XIAOSHUO_RUNTIME_PORT` 注入 Electron，避免本机已运行的正式 ArcWriter 占用 `127.0.0.1:18453` 时误打到真实实例。

本轮已验证：

```powershell
npm test -- packages/agent-runtime/src/intent-router.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts
npm test -- packages/agent-runtime/src/skill-runner.test.ts
npm test -- packages/crawler-service/src/crawler.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物检查通过：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.1.9.exe
apps/desktop-shell/release/ArcWriter-Setup-0.1.9.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 当前记录：

```yaml
version: 0.1.9
path: ArcWriter-Setup-0.1.9.exe
```

### 15.3 2026-06-13 v0.2.0 发布记录

本次发布版本：`0.2.0`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 联网拆书爬虫支持直接解析 `.txt` / 纯文本小说链接，按章节标题切分原文；书名爬取时 Bing 查询同时覆盖“txt 全本”“txt 下载”“目录”候选。
- 新增拆书爬取 `min_chars` 参数，默认 `60000`。爬虫会在基础章节数之外继续抓取，直到达到 6 万字；如果来源全文不足 6 万字，则导入已能抓取的全部内容。
- 上传拆书 txt 原文时不再只读取附件摘要。拆书归档和 Nuwa 蒸馏读取附件会保留原文换行，最多取 6 万字，不足 6 万字完整导入。
- 拆书库按文件夹状态显示入口：已完成拆书的文件夹显示“融梗”，只有 `原文.txt` 的原文文件夹显示“蒸馏”。原文文件夹不再进入融梗选择。
- `book_fusion` 后端增加保护，只允许包含拆书产物的文件夹参与融梗，直接传入原文文件夹会被拒绝。
- 会话服务列表排序增加同毫秒 ID 兜底，避免 Windows 文件 mtime 相同导致列表和测试顺序抖动。

本轮已验证：

```powershell
npm test -- packages/crawler-service/src/crawler.test.ts
npm test -- packages/conversation-service/src/service.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物检查通过：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.0.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.0.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 当前记录：

```yaml
version: 0.2.0
path: ArcWriter-Setup-0.2.0.exe
```

### 15.4 2026-06-14 v0.2.1 发布记录

本次发布版本：`0.2.1`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 左侧项目卡片去掉应用内深色模式入口和“退出软件”按钮，改为“导出项目”和“导入项目”。菜单栏退出仍保留。
- 桌面壳新增项目完整 ZIP 导入导出：导出当前项目为 `.arcwriter.zip`，保留 `.agent`、设定、正文、拆书库等项目数据，排除 `.git`、`node_modules`、临时文件和日志。
- 导入项目归档时先选择 zip，再选择目标文件夹；重名目录自动追加时间戳，不覆盖已有项目；zip 条目会做安全路径校验，阻止路径穿越。
- Workbench 项目导入成功后复用现有打开项目流程，刷新项目树、索引状态、会话和任务，并记录最近项目。
- 中间“拆书”页的“拆书 / 蒸馏 / 融梗”改为三个默认收起的横条折叠卡片，点击标题条展开对应功能，减少页面首屏拥挤。

本轮已验证：

```powershell
npm test -- apps/desktop-shell/src/main/project-archive.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物检查通过：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.1.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.1.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 当前记录：

```yaml
version: 0.2.1
path: ArcWriter-Setup-0.2.1.exe
```

### 15.5 2026-06-14 v0.2.2 发布记录

本次发布版本：`0.2.2`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 软件更新改为优先检查腾讯云 COS 国内镜像，镜像失败、404 或解析失败后自动回退 GitHub Releases；Workbench 更新状态区新增“更新源”，显示“国内镜像”或“GitHub”。
- 默认国内镜像地址为 `https://ai-downloads-1318078295.cos.ap-guangzhou.myqcloud.com/software/novel/`，支持通过 `XIAOSHUO_UPDATE_MIRROR_URL` 覆盖。COS 目录仍需同步 `latest.yml`、安装包和 `.blockmap` 三个文件。
- 左侧项目动作区将本地 ZIP 导入导出并入“上传/同步项目”折叠横条卡片，默认收起；展开后同时显示“本地项目”和“云项目”。
- 桌面壳新增云项目 IPC 和服务：列出、上传当前项目、同步云项目覆盖当前项目、删除云项目。同步覆盖前会自动备份当前项目，并复用 ZIP 安全导入校验防止路径穿越。
- 网站端新增 ArcWriter 云项目接口，复用 relay 登录账号的 `Authorization: Bearer <accountKey>`。每个账号最多 3 个项目槽位，项目 ZIP 保存在服务器磁盘。
- 云项目上传限制从 35MB 调整为 20MB。桌面端会先做本地大小检查，网站端也会用 multer 限制和 ZIP 头校验拒绝超限、空文件、非 zip 和假 zip。

本轮已验证：

```powershell
npm test -- apps/desktop-shell/src/main/project-archive.test.ts
npm test -- apps/desktop-shell/src/main/update-service.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
cd D:\网站 && npm run test:security
cd D:\网站 && npm run build
```

本地打包产物应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.2.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.2.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.2
path: ArcWriter-Setup-0.2.2.exe
```

### 15.6 2026-06-15 v0.2.3 发布记录

本次发布版本：`0.2.3`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 修复桌面软件登录网站账号后无法读取面板的问题。网站端 `/api/relay/dashboard` 和充值订单接口现在要求 `Authorization: Bearer <accountKey>`，桌面端已从旧的 `?key=` 查询参数切换为 Bearer 请求头。
- 项目重命名从“只修改显示名”改为同步重命名项目根文件夹；目标同级目录已存在时会拒绝覆盖，Windows 上仅大小写变化也会通过临时目录中转完成。
- 项目文件夹改名后会迁移文档会话、重建项目索引，并把最近项目、会话索引、任务历史和生成缓存的旧项目路径更新为新路径，避免左侧列表残留旧文件夹。

本轮已验证：

```powershell
npm test -- packages/project-session/src/service.test.ts
npm test -- apps/desktop-shell/src/main/runtime/project-document-routes.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.3.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.3.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.3
path: ArcWriter-Setup-0.2.3.exe
```

### 15.7 2026-06-15 v0.2.4 发布记录

本次发布版本：`0.2.4`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 未授权账号现在会在桌面 runtime 后端被硬拦截，聊天生成、Agent 计划/执行、Skill 运行、小说爬取、向量重建/搜索、抽卡生成和模型总结都会返回 `AI_LICENSE_REQUIRED`，不再只依赖 UI 提示。
- 云项目上传纳入授权限制：桌面端上传前先校验授权，网站端 `/api/arcwriter/cloud-projects` 上传接口也要求账号拥有 ArcWriter 授权，绕过客户端直接调接口同样会被拒绝。
- 云项目上传增加每天每账号最多 10 次限制。网站端按北京时间自然日统计成功上传次数，第 11 次返回 `ARCWRITER_CLOUD_UPLOAD_DAILY_LIMIT`，列表和上传响应会返回当天已用/剩余次数。
- 授权验证请求已统一带 `Authorization: Bearer <accountKey>`，兼容网站端 Bearer 认证要求。
- 桌面 smoke 已改为使用本地授权 mock 校验受保护 AI 路由；本地状态读取兼容历史数据库中的 `last_synced_at = null`。

本轮已验证：

```powershell
npm test -- apps/desktop-shell/src/main/cloud-projects.test.ts
npm test -- apps/desktop-shell/src/main/runtime/base-routes.test.ts
npm test -- apps/desktop-shell/src/main/runtime/conversation-routes.test.ts
npm test -- apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
cd D:\网站 && npm run build
cd D:\网站 && npm run test:security
```

本地打包产物应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.4.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.4.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.4
path: ArcWriter-Setup-0.2.4.exe
```

### 15.8 2026-06-15 v0.2.5 发布记录

本次发布版本：`0.2.5`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- 修复桌面软件兑换码无效的问题：`/api/website-ai/redeem` 现在向网站 `/api/redeem` 发送 `Authorization: Bearer <accountKey>`，请求体只保留兑换码，匹配网站端 Bearer 认证。
- 修复“刷新账号”读取到旧模型 Key 的问题：桌面端网站面板、应用网站配置、兑换码和 Workbench 自动刷新统一优先使用 `website_profile.license_account_key`，再回退 `api_key`。
- 新增 `website-ai-routes` 单测，覆盖 Bearer 兑换和刷新账号时的 Key 优先级，避免后续把账号 token 与模型 key 再次混用。
- 网站小说工具页已改为 ArcWriter 软件介绍页，不再展示旧的本地客户端连接检测、一键写入 API 配置和旧简介卡；下载按钮下方直接展示登录、授权、兑换码等账号授权入口。

本轮已验证：

```powershell
npm test -- apps/desktop-shell/src/main/runtime/website-ai-routes.test.ts
npm test -- apps/desktop-shell/src/main/runtime/base-routes.test.ts apps/desktop-shell/src/main/runtime/website-ai-routes.test.ts
npm test -- packages/api-client/src/client.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
cd D:\网站 && npm run build
cd D:\网站 && npm run test:security
```

本地打包产物应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.5.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.5.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.5
path: ArcWriter-Setup-0.2.5.exe
```

### 15.9 2026-06-16 v0.2.6 发布记录

本次发布版本：`0.2.6`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题和 `APP_WINDOW_TITLE`。

主要改动：

- **拆书库重排**：将“拆书库”从左侧项目 Sidebar 移除，迁移到了中间页面 Tab 中，并升级为卡片网格响应式设计。原有选书、蒸馏、融梗、打开文件能力保留。
- **融梗锁定修复**：移除了提示词输入框的禁用逻辑，输入框始终可正常编辑，且运行时会将最新的 `fusionPrompt.trim()` 作为核心指令投递给后端。
- **爬虫来源 UI 及本地管理**：
  - 支持对旧版 `customCrawlSourceUrl` 单一自定义 URL 的平滑迁移与自动去重。
  - 新增了爬虫来源选择器，默认内置 Bing、自动选择旧来源、书库阁、zxtyz、22biqu，支持删除任意来源或恢复默认。
  - 列表删空时会触发红字异常警示并禁用普通书名爬取，但允许直接输入 URL 爬取。
- **爬虫多路由恢复**：在 `crawler.ts` 中恢复了 `auto`（内置源优先级轮询）、指定源以及 `custom`（空 query 抓取）等路由，且在抓取成功后将 manifest 里的 `source_path` 记为实际的 `novel.source_url`。
- **技能页空列表兜底**：确认 `/api/skills` 可正常返回内置技能后，在 Workbench 技能页加入空列表自动重拉、手动“刷新技能/重新读取技能”和错误提示，避免前端快照或缓存偶发为空时误显示“暂无技能”。
- **右侧结果栏 UI 收敛**：批量、拆书、抽卡和技能页不再各自重复展示结果预览，统一由右侧 RailResultPreview 承接后台任务、技能运行、待保存结果和已写入文件，并补充运行进度、待保存操作按钮和不确定进度动画。

本轮已验证：

```powershell
npm test -- packages/crawler-service/src/crawler.test.ts
npm test -- apps/workbench/src/lib/crawlSources.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
```

执行桌面打包后，本地发布目录应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.6.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.6.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.6
path: ArcWriter-Setup-0.2.6.exe
```

### 15.10 2026-06-16 v0.2.7 发布记录

本次发布版本：`0.2.7`。版本号已同步到 `apps/desktop-shell/package.json`、`package-lock.json`、Workbench 页面标题、桌面 smoke 页面标题、更新服务测试版本桩和 `APP_WINDOW_TITLE`。

主要改动：

- **拆书库左侧页签化**：将拆书库整合到左侧项目树区域，提供“项目树 / 拆书库”二级页签；切换到拆书爬取功能时会自动打开左侧拆书库，保留选书、蒸馏、融梗、打开源文件和历史拆书产物入口。
- **UI 审核清理**：移除了中间页面旧 `disassembly-library` 不可达入口与重复实现，避免拆书库同时存在两套展示逻辑；当前拆书库状态继续复用 `selectedDisassemblyBookId` 与 `fusionBookIds`。
- **发布版本同步**：升级桌面端版本到 `0.2.7`，同步 Workbench 标题、桌面 smoke 标题和自动更新测试中的应用版本。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run typecheck -w @xiaoshuo/desktop-shell
npm test -- apps/desktop-shell/src/main/update-service.test.ts
npm run build:workbench
npm run dist -w @xiaoshuo/desktop-shell
```

执行桌面打包后，本地发布目录应包含：

```text
apps/desktop-shell/release/ArcWriter-Setup-0.2.7.exe
apps/desktop-shell/release/ArcWriter-Setup-0.2.7.exe.blockmap
apps/desktop-shell/release/latest.yml
```

`latest.yml` 应记录：

```yaml
version: 0.2.7
path: ArcWriter-Setup-0.2.7.exe
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
