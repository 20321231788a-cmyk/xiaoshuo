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

### 15.11 2026-06-20 GraphRAG-lite 框架第一阶段开发记录

本次为 GraphRAG-lite 第一阶段最小可用版开发。

主要改动：

- **数据库扩展**：在 `VectorDb` (00_设定集/.agent/vector_index.sqlite3) 中扩展创建了图谱所需的基础表：
  - `graph_entities`（实体表）：存储世界观设定中的各类实体。
  - `graph_relations`（关系表）：记录实体之间的一跳关系。
  - `graph_claims`（断言事实表）：存储原子性断言及其状态，支持 confirmed / planned。
  - `graph_communities`（社群摘要表）：保存主线、人设等全局的聚合社群大纲摘要。
- **轻量抽取与增量索引**：
  - 在 `GraphContext` 中实现了基于规则的实体与断言抽取引擎。通过 Markdown 标题级别提取角色/物品/术语等实体。
  - 大纲/章纲抽取为 `planned` 状态，正文事实与设定抽取为 `confirmed` 状态，并能从正文提及实体自动推断出 `appears_in` 关系。
  - 将 `rebuildGraph` 挂载到了 `VectorIndex.rebuild()` 与 `processPending()` 流程后，完成向向量数据库与图谱的增量重建。
- **检索与写作接入**：
  - 编写了 `buildWritingContext` 与 `checkConsistency`。第一阶段实现的是规则版 GraphRAG-lite：基于 chunks、关键词匹配、实体提及和图谱一跳关系生成写作约束。真正的向量相似度融合和更完整的冲突检测留待第二阶段。
  - 整合进 `agent-runtime/runtime.ts` 的 `generateBodyChapter`（正文生成）与 `runConsistencyCheckForText`（一致性校对），提供图谱校验入口，当前第一阶段主要返回命中实体与 confirmed claims 上下文，辅助校验设定跑偏风险，深度冲突判定后续第二阶段接入。
- **API 路由公开与 AI License 安全控制**：
  - 新建 `graph-routes.ts` 暴露 `status`、`rebuild`、`writing-context` 和 `check` 接口，并成功挂载到 `runtime-server.ts` 路由层。
  - 对 rebuild、writing-context 和 check 等 POST 图谱操作增加了 `writeAiLicenseRequiredIfNeeded` 授权拦截，保障未授权无法调用 AI 功能。
- **SQLite 释放与测试覆盖**：
  - 在 `runtime.ts` 和 `indexer.ts` 调用 Graph 数据库的位置全部使用 `try-finally` 连接管理结构，彻底规避数据库连接泄露隐患。
  - 补全了 `checkConsistency` 的参数解包绑定与单元测试。
  - 新建了 `graph-routes.test.ts` 测试文件，并补充了 `license-guarded-routes.test.ts` 中针对 Graph 路由的拦截测试。

本轮已验证：

```powershell
npm test -- packages/vector-service/src/graph-context.test.ts
npm test -- apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts
npm test -- apps/desktop-shell/src/main/runtime/graph-routes.test.ts
npm test
npm run typecheck --workspaces --if-present
npm run build:workbench
```

### 15.12 2026-06-20 拆书库树形化重构与主编辑区分屏系统开发记录

本次为工作台 UI 界面与交互体验的多项重构优化开发。

主要改动：

- **拆书库树形收纳**：
  - 为了改变海量卡片平铺堆叠的混乱体验，将拆书库从一维列表改造为了三层文件夹树结构：
    - 一级：小说主文件夹（以书籍的 `title` 自动做 Group 分类）。
    - 二级：“原书”子文件夹与“拆书产物”子文件夹。
    - 三级：具体的原书记录（有蒸馏和打开操作）与已拆书产物（有融梗和打开操作）。
  - 新增 `NovelFolderNode` 组件，重构 `DisassemblyLibraryTree` 组件，复用了项目原生树型样式，并在组件内维护折叠展开状态。
- **多功能左右分屏系统**：
  - 在主编辑区引入了一分为二的水平分屏布局（重构了 `FeatureWorkbenchPanel`）。支持了两个文档并排对照编辑，也支持文档与 AI对话、设定集、风格库、题材库等常用功能页进行左右分屏组合，且页面卡片支持宽度等比缩放。
  - 引入了高亮边框指示的“聚焦侧(activePane)”概念。用户点击切换激活窗口时，系统同步调用控制器的 `activateDocument` 激活当前文档，让标点栏输入、查找、保存、刷新等工具优先作用于当前聚焦的活动文档中。
  - 选项卡与页面按钮栏点击事件进行了分流拦截。在右侧窗口聚焦时，切换右侧将仅作用于右侧 Feature 且支持点击设定集等卡片在右侧直接打开文档。
- **一致性检查 UI 优化**：
  - 将 `ProjectFileSelect` 组件内的下拉选择框与相对路径输入框包裹在水平 Flex 容器内，以 1:1 等宽排布在同一行上，消除了原有的换行局促感。
  - 在“自动一致性检查”复选框上加内联样式 `gridColumnStart: 2`，强制其定位在 CSS Grid 容器的右下槽位，移动到了风险阈值输入框的下方。

本轮已验证：

```powershell
npm run typecheck --workspaces --if-present
npm run build:workbench
```

### 15.13 2026-06-20 v0.2.8 发布记录

本次将 GraphRAG-lite 写作框架首轮能力与工作台分屏体验合并进入 `0.2.8` 版本，并完成桌面端打包发布。

主要改动：

- **GraphRAG-lite 图谱上下文层**：
  - 在 `packages/vector-service` 中新增 `GraphContext`，支持人物、地点、组织、道具、术语、风格规则、题材规则、伏笔等实体类型，以及属于、冲突、因果、限制、伏笔指向、出场章节、风格约束等关系类型。
  - 新增 claims 与 communities 数据结构，用于记录已确认事实、待定事实、禁止项，以及主线、角色线、世界规则、风格语感、题材玩法、伏笔闭环等聚合摘要。
  - 新增基于章纲/正文的图谱检索与一致性检查入口，当前为规则版 GraphRAG-lite；后续可继续接入 LLM 抽取、DRIFT-like 多跳检索与写后自动修订闭环。
- **桌面 runtime Graph 路由**：
  - 在桌面 runtime 中补充 graph 路由，并接入 AI License 写入权限校验。
  - Graph 数据库访问统一使用 `try-finally` 关闭连接，避免长时间写作过程中 SQLite 连接泄露。
- **工作台 UI 体验**：
  - 拆书库升级为树形收纳结构，降低大量拆书卡片平铺时的浏览成本。
  - 主编辑区新增左右分屏与聚焦侧机制，支持文档对照编辑，以及文档与 AI 对话、设定集、风格库、题材库等常用页面并排使用。
  - 一致性检查页优化了文件选择与自动检查开关布局。
- **版本同步**：
  - 桌面端包版本、窗口标题、工作台 HTML 标题、smoke 页面、更新服务测试桩统一更新为 `0.2.8`。

本轮已验证：

```powershell
npm test
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物：

- `apps/desktop-shell/release/ArcWriter-Setup-0.2.8.exe`
- `apps/desktop-shell/release/ArcWriter-Setup-0.2.8.exe.blockmap`
- `apps/desktop-shell/release/latest.yml`

### 15.14 2026-06-26 v0.2.9 发布记录

本次重点优化无变化保存场景下的磁盘写入，降低长期写作时对 SSD 的无意义写盘压力。

主要改动：

- **文档保存去重**：
  - `DocumentService.saveDocument` 在目标文件已存在且磁盘内容与本次保存内容完全一致时直接返回，不写正文文件，不追加 timeline。
  - 保存结果新增兼容字段 `changed`，无变化为 `false`，实际创建或修改文件为 `true`。
  - 若编辑器基准时间已过期但磁盘内容与本次保存内容一致，不再触发保存冲突；内容不同仍保留原有冲突保护。
- **runtime 后续写盘收敛**：
  - 文档保存路由在 `changed === false` 时跳过 `rebuildProjectManifest` 和 `VectorIndex.markChanged`。
  - `changed` 缺失或为 `true` 时保持旧行为，兼容旧响应结构。
- **manifest 与向量 pending 去重**：
  - `ProjectManifestService.rebuild` 扫描结果与磁盘 manifest entries 完全一致时不重写 `project_manifest.json`，比较时忽略 `generated_at`。
  - `VectorIndex.markChanged` 对同一路径、同 action 的 pending 条目不再刷新 `updated_at`；action 改变时仍正常更新。
- **版本同步**：
  - 桌面端包版本、窗口标题、工作台 HTML 标题、smoke 页面、更新服务测试桩统一更新为 `0.2.9`。

本轮已验证：

```powershell
npm test -- packages/document-service
npm test -- apps/desktop-shell/src/main/runtime/project-document-routes.test.ts
npm test -- packages/project-manifest
npm test -- packages/vector-service
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物：

- `apps/desktop-shell/release/ArcWriter-Setup-0.2.9.exe`
- `apps/desktop-shell/release/ArcWriter-Setup-0.2.9.exe.blockmap`
- `apps/desktop-shell/release/latest.yml`

### 15.15 2026-06-26 v0.3.0 发布记录

本次重点优化右侧任务区的占用高度，并给手动 Embedding 配置增加真实连接检测，方便用户在保存设置前确认向量模型可用。

主要改动：

- **右侧任务区紧凑化**：
  - `RailResultPreview` 改为只展示任务标题、单行摘要和单条进度条。
  - 不再在右侧工作框展示长任务详情、生成正文、结果文件列表，避免挤压底部按钮区。
  - 待保存生成结果仅保留一行最小操作入口，并通过固定高度和单行截断控制卡片尺寸。
- **统一运行摘要**：
  - 新增 `apps/workbench/src/lib/railStatus.ts`，把后台任务、技能/对话忙碌态、待保存结果合并成一条当前运行摘要。
  - 优先级固定为后台任务 > 技能/对话忙碌态 > 待保存结果，避免同时执行两个模块时右栏叠加多个进度条。
  - 增加 `railStatus.test.ts` 覆盖并发运行、技能运行和待保存结果三类摘要。
- **Embedding 连接检测**：
  - 新增 `POST /api/vector/test` 契约、api-client 方法和 desktop runtime 路由。
  - 后端复用 `EmbeddingClient.test()` 发送一次真实 embedding 请求，仅返回连接状态、模型、Base URL、provider 和维度，不写入索引、不改 pending 队列。
  - 手动设置页的“Embedding 与向量召回”区新增“检测链接”按钮，使用当前草稿值测试；网站模型页不增加该入口。
- **版本同步**：
  - 桌面端包版本、窗口标题、工作台 HTML 标题、smoke 页面、更新服务测试桩统一更新为 `0.3.0`。

本轮已验证：

```powershell
npm test -- packages/api-client/src/client.test.ts apps/workbench/src/lib/railStatus.test.ts apps/desktop-shell/src/main/runtime/vector-routes.test.ts apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts packages/vector-service/src/vector-service.test.ts
npm run typecheck --workspaces --if-present
npm run build -w @xiaoshuo/workbench
```

本地打包产物：

- `apps/desktop-shell/release/ArcWriter-Setup-0.3.0.exe`
- `apps/desktop-shell/release/ArcWriter-Setup-0.3.0.exe.blockmap`
- `apps/desktop-shell/release/latest.yml`

### 15.16 2026-06-28 v0.3.1 发布记录

本次重点修复手动 Ark multimodal Embedding 返回体兼容问题，并优化 AI 会话附件上传与发送框展示体验。

主要改动：

- **Ark multimodal Embedding 兼容**：
  - `EmbeddingClient.extractVectors` 支持 `data.embedding` 对象结构，兼容火山 Ark multimodal 接口返回单条向量的真实响应。
  - `embedDoubaoMultimodal` 改为对输入逐条请求，每次只发送一个 `{ type: "text", text }` 输入，避免把 `embedding_batch_size` 误当成 Ark multimodal 单次请求内的 input 数量。
  - 更新向量服务测试，覆盖 `data.embedding` 响应和多输入逐条请求行为。
- **会话附件多文件上传**：
  - AI 会话上传入口支持一次选择多个文件，控制器按上传顺序逐个上传，并在上传完成后刷新会话详情。
  - 发送消息时继续沿用当前会话附件的 `attachment_ids`，确保上传的多个文件会随本次消息一起发送给 AI。
- **发送框内置附件条**：
  - 右侧快捷发送框和完整会话页统一改为“输入容器 + 顶部附件条 + textarea”结构。
  - 附件 chip 移动到发送输入框内部顶部，按上传顺序从左到右排列；长文件名省略显示并保留 tooltip。
  - 附件区限制最大高度，文件较多时在容器内换行/滚动，不遮挡输入文字和发送/停止按钮。
- **版本同步**：
  - 桌面端包版本、窗口标题、工作台 HTML 标题、smoke 页面、更新服务测试桩统一更新为 `0.3.1`。

本轮已验证：

```powershell
npm test -- packages/vector-service
npm run typecheck -w @xiaoshuo/workbench
npm run build -w @xiaoshuo/workbench
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物：

- `apps/desktop-shell/release/ArcWriter-Setup-0.3.1.exe`
- `apps/desktop-shell/release/ArcWriter-Setup-0.3.1.exe.blockmap`
- `apps/desktop-shell/release/latest.yml`

### 15.17 2026-06-28 v0.3.2 发布记录

本次重点恢复 AI 输出的可见流式体验，并补齐项目树文件右键操作。

主要改动：

- **可见流式输出恢复**：
  - `OpenAICompatibleClient.streamCompletion` 增强流式解析，兼容标准 SSE、裸 NDJSON、单个普通 JSON 响应和无尾换行 buffer。
  - 扩展增量文本提取，支持更多 OpenAI-compatible 返回形态，包括 `delta.content`、`message.content`、`text` 和顶层文本字段。
  - `agent-runtime` 增加大块文本拆分逻辑，上游一次性返回长文本时也会拆成多个 delta，避免前端看起来像整段跳出。
  - Humanizer 开启时先显示原始模型流式输出，结束后提示“正在进行去AI味润色...”，最终再替换成润色文本。
- **附件条四字横排**：
  - 附件 chip 固定显示去扩展名后的前四个字，完整文件名保留在 hover tooltip。
  - 发送框内附件条不再开内部滚动栏，文件按上传顺序横向排列并自然换行。
- **项目树右键文件操作**：
  - 左侧项目树支持右键文件夹创建文件，右键文件可创建同级文件或删除文件。
  - 创建文件时可输入文件名，未写扩展名默认补 `.txt`，仅允许 `.txt` / `.md`。
  - 删除文件复用现有归档删除路由，避免直接物理硬删；若文件有未保存草稿则阻止删除。
- **版本同步**：
  - 桌面端包版本、窗口标题、工作台 HTML 标题、smoke 页面、更新服务测试桩统一更新为 `0.3.2`。

本轮已验证：

```powershell
npm test -- packages/model-client
npm test -- packages/agent-runtime
npm test -- apps/workbench/src/lib/attachments.test.ts apps/workbench/src/lib/projectTreeActions.test.ts
npm run typecheck --workspaces --if-present
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npm run dist -w @xiaoshuo/desktop-shell
```

本地打包产物：

- `apps/desktop-shell/release/ArcWriter-Setup-0.3.2.exe`
- `apps/desktop-shell/release/ArcWriter-Setup-0.3.2.exe.blockmap`
- `apps/desktop-shell/release/latest.yml`

### 15.18 2026-07-07 Agent 优化手册与 Trace 最小闭环开发记录

本次从专业 Agent 设计视角完成项目评估，并落地第一阶段可观测性改造：先让每次 agent 运行留下可追踪、可复盘、可回归的结构化记录，为后续上下文治理、路由评估、保存决策和模型调用分层优化提供依据。

主要改动：

- **Agent 优化修改手册**：
  - 新增 `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md`，按 P0-P8 分层整理问题、目标状态、落地文件、验收标准与实施顺序。
  - 明确第一阶段优先做 Agent Run Trace，后续再推进 Context Budget、路由评估、模型调用分层、保存策略治理等改造。
- **共享 Trace 契约**：
  - `packages/shared/src/schemas/agent.ts` 新增 agent run trace、路由候选、上下文块、模型调用、保存决策等 schema 与类型。
  - trace stage 覆盖 received、classified、planned、workflow_started、save_committed、conversation_recorded、failed 等关键运行节点。
- **项目本地 Trace 写入器**：
  - 新增 `packages/agent-runtime/src/agent-trace.ts`，按 JSONL 写入 `00_设定集/.agent/runs/YYYYMMDD.jsonl`。
  - 写入器默认吞掉自身失败，避免诊断能力影响正常 agent 执行。
  - 对输入摘要、错误信息、URL、API Key、Bearer token、`sk-` key、JWT 形态 token 做基础脱敏。
- **Runtime 接入**：
  - `AgentRuntimeService.runAgent`、`streamAgentRun`、`runSkill` 增加 trace 包裹，记录路由候选、分类结果、技能启动、保存路径、联网来源和失败信息。
  - trace 已补充请求上下文块摘要和模型调用摘要，只记录字符数、路径/来源和模型名，不保存 prompt 全文。
  - chat/read-context 结束后回填最终 `conversation_id`，方便从 trace 反查会话。
  - 保留原有运行行为，trace 仅作为诊断副产物。
- **测试覆盖**：
  - 新增 `packages/agent-runtime/src/agent-trace.test.ts` 覆盖 JSONL 写入、失败脱敏、URL 清洗、finish 幂等和写入异常吞吐。
  - 扩展 `packages/agent-runtime/src/runtime.test.ts`，覆盖一次真实 `runAgent` 后项目本地 trace 落盘、会话 ID 回填、context blocks 和 model calls。

本轮已验证：

```powershell
npm test -- packages/agent-runtime/src/agent-trace.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts -t "writes a project-local trace"
npm test -- packages/agent-runtime/src/agent-trace.test.ts packages/agent-runtime/src/runtime.test.ts -t "trace|writes a project-local trace"
npm test -- packages/agent-runtime/src/agent-trace.test.ts packages/agent-runtime/src/runtime.test.ts
npm run typecheck -w @xiaoshuo/shared
npm run typecheck -w @xiaoshuo/agent-runtime
```

后续建议：

- P1 优先提取 workflow registry，先迁移 `consistency_check`，再拆 `body_generate` / `batch_generate`。
- P2 再做 ContextAssembler，把当前 trace 里的轻量上下文块升级为统一预算和裁剪记录。
- P3 在模型客户端层精确补齐 `model_calls`，区分主模型、辅助模型和 fallback。

### 15.19 2026-07-07 Workflow Registry 第一刀开发记录

本轮按 `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md` 的 P1 最小闭环执行，先迁移风险较低但价值明确的 `consistency_check`。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/types.ts`，定义 workflow handler 和运行上下文。
- 新增 `packages/agent-runtime/src/workflows/registry.ts`，集中维护 workflow skill id，并注册已迁移 handler。
- 新增 `packages/agent-runtime/src/workflows/consistency-check.ts`，承接一致性检查完整执行链路。
- 新增 `packages/agent-runtime/src/prompts/consistency.ts`，集中保存一致性检查 prompt、裁剪和 JSON 解析逻辑。
- `AgentRuntimeService.runLocalWorkflowSkill()` 改为先查 registry；没有 handler 的 workflow 继续走旧分支。
- 删除 runtime 中 `consistency_check` 对应大分支，外部行为保持不变。
- 新增 `packages/agent-runtime/src/workflows/consistency-check.test.ts`，覆盖 handler 直跑和 JSON 异常降级。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/consistency-check.test.ts packages/agent-runtime/src/runtime.test.ts -t "consistency_check|ConsistencyCheckWorkflow"
```

下一步建议：

- 继续按任务 C 拆 `body_generate`，但要优先抽出可复用保存/回炉/后处理函数，降低一次搬迁的风险。
- `batch_generate` 拆分时应改为调 `body_generate` handler，而不是递归调 runtime legacy 方法。

### 15.20 2026-07-07 body_generate Handler 迁移记录

本轮继续按优化手册任务 C 执行，把正文生成主价值链从 `AgentRuntimeService.runLocalWorkflowSkill()` 中拆到独立 workflow handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/body-generate.ts`，承接 `body_generate` 的章纲解析、正文生成、自动回炉、一致性检查、deslop/humanizer、GeneratedCache、pending save / auto commit、修正日志和章节交接摘要。
- 新增 `packages/agent-runtime/src/prompts/body.ts`，保存正文生成、回炉和去 AI 味 prompt。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BodyGenerateWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `body_generate` 分支；未迁移的 `batch_generate` 调 `body_generate` 时已经通过 registry 落到新 handler。
- 清理 runtime 中只服务旧正文分支的生成、回炉、交接 helper；抽卡正文候选仍复用的少量 helper 暂时保留。
- 新增 `packages/agent-runtime/src/workflows/body-generate.test.ts`，覆盖 pending save 和显式写入 commit。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/body-generate.test.ts packages/agent-runtime/src/runtime.test.ts -t "body_generate|batch_generate|BodyGenerateWorkflow"
```

下一步建议：

- 迁移 `batch_generate` 为独立 handler，改为直接调用 `getWorkflowHandler("body_generate")`。
- 迁移前补一条 batch handler 直跑测试，确保章节范围、联网素材聚合和 saved paths 不漂移。

### 15.21 2026-07-07 batch_generate Handler 迁移记录

本轮继续拆 workflow registry，把批量正文生成从 runtime legacy 分支迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/batch-generate.ts`，承接章节范围解析、逐章正文生成、saved paths 聚合、联网来源去重和会话记录。
- `BatchGenerateWorkflow` 构造时注入 `BodyGenerateWorkflow`，逐章直接调用 body handler，不再递归调 runtime legacy 方法。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BatchGenerateWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `batch_generate` 分支，并清理不再使用的 `resolveBatchChapterRange()`。
- 新增 `packages/agent-runtime/src/workflows/batch-generate.test.ts`，覆盖章节范围、逐章请求构造、saved paths 和 web sources 聚合。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/batch-generate.test.ts packages/agent-runtime/src/workflows/body-generate.test.ts packages/agent-runtime/src/runtime.test.ts -t "batch_generate|BatchGenerateWorkflow|body_generate"
```

下一步建议：

- 若继续 P1，优先迁移 `scan_pits`，它依赖少、风险较低。
- 若转入 P2 ContextAssembler，先接 chat/read_context，再接 prompt skill，避免正文 prompt 大幅波动。

### 15.22 2026-07-07 scan_pits Handler 迁移记录

本轮继续拆 workflow registry，把伏笔扫描从 runtime legacy 分支迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/scan-pits.ts`，承接正文来源解析、`outline_generate` 调用、伏笔条目清洗、ledger 写入和技能会话记录。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `ScanPitsWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `scan_pits` 分支。
- 新增 `packages/agent-runtime/src/workflows/scan-pits.test.ts`，覆盖伏笔条目写入 `00_设定集/.agent/ledger.json`。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/scan-pits.test.ts packages/agent-runtime/src/runtime.test.ts -t "scan_pits|ScanPitsWorkflow"
```

下一步建议：

- P1 若继续瘦 runtime，可迁移 `book_fusion` 或拆 `disassemble_book` / `continue_disassemble`。
- 多个 handler 已重复 `recordSkillExchange()` 和来源解析逻辑，下一刀前可抽 `workflows/helpers.ts`。

### 15.23 2026-07-07 book_fusion Handler 迁移记录

本轮继续拆 workflow registry，把融梗从 runtime legacy 分支迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/book-fusion.ts`，承接 source book 校验、拆书库读取、融梗 prompt、模型调用、融梗库写盘和技能会话记录。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `BookFusionWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `book_fusion` 分支，并清理只服务融梗的旧 helper。
- 新增 `packages/agent-runtime/src/workflows/book-fusion.test.ts`，覆盖少于三本拒绝和三本已拆书籍写入融梗库。
- `runtime.ts` 当前约 2785 行。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/book-fusion.test.ts packages/agent-runtime/src/runtime.test.ts -t "book fusion|BookFusionWorkflow|book_fusion"
```

下一步建议：

- P1 剩余 legacy workflow 为 `disassemble_book`、`continue_disassemble`、`nuwa_style_distill`。
- 拆 `disassemble_book` / `continue_disassemble` 前，建议先抽 `workflows/disassemble-library.ts`，统一 manifest、legacy 和 source text helper。

### 15.24 2026-07-07 nuwa_style_distill Handler 迁移记录

本轮继续拆 workflow registry，把 Nuwa 文风蒸馏从 runtime 特判迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/nuwa-style-distill.ts`，承接文风蒸馏、status、delete、toggle、来源解析和 profile 写入。
- `NuwaStyleDistillWorkflow` 同时实现 `runAgent()` 和 `runSkill()`，保持 `/api/agent/run` 与 `/api/skills/{id}/run` 两条路径可用。
- `AgentRuntimeService.runSkillInternal()` 改为优先调用带 `runSkill()` 的 workflow handler，删除 Nuwa runtime 特判。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `NuwaStyleDistillWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `nuwa_style_distill` 分支，并清理旧 source resolver。
- 新增 `packages/agent-runtime/src/workflows/nuwa-style-distill.test.ts`，覆盖蒸馏、status、toggle 和 runtime runSkill 直调。
- `runtime.ts` 当前约 2567 行。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/nuwa-style-distill.test.ts -t "NuwaStyleDistillWorkflow"
```

下一步建议：

- P1 剩余 legacy workflow 为 `disassemble_book` 和 `continue_disassemble`。
- 先抽拆书库 helper，再迁移两个拆书 workflow，能减少重复和行为漂移。

### 15.25 2026-07-07 continue_disassemble Handler 迁移记录

本轮继续拆 workflow registry，先抽公共拆书库 helper，再把继续拆细纲迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/disassemble-library.ts`，统一拆书库 manifest、legacy 产物、书籍创建、来源读取和标题推断 helper。
- 新增 `packages/agent-runtime/src/workflows/continue-disassemble.ts`，承接 `continue_disassemble` 的反向细纲读取、outline_generate 调用、拆书细纲写入和 legacy 同步。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `ContinueDisassembleWorkflow`。
- `packages/agent-runtime/src/workflows/book-fusion.ts` 改用共享拆书库读取 helper，删除重复的 manifest / legacy 读取实现。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除 `continue_disassemble` 分支；`disassemble_book` legacy 分支暂留，但已改用共享 helper。
- 新增 `packages/agent-runtime/src/workflows/continue-disassemble.test.ts`，覆盖 handler 直跑和 runtime registry 路由。
- `runtime.ts` 当前约 2224 行。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/continue-disassemble.test.ts packages/agent-runtime/src/workflows/book-fusion.test.ts
npm test -- packages/agent-runtime/src/runtime.test.ts -t "disassemble"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- P1 剩余 legacy workflow 为 `disassemble_book`。
- 迁移 `disassemble_book` 时直接复用 `workflows/disassemble-library.ts`，覆盖 `list_library`、`archive_source` 和完整拆书生成路径。

### 15.26 2026-07-07 disassemble_book Handler 迁移记录

本轮完成 P1 最后一个 workflow legacy 分支，把完整拆书入口迁移到独立 handler。

主要改动：

- 新增 `packages/agent-runtime/src/workflows/disassemble-book.ts`，承接 `list_library`、`archive_source`、完整拆书生成、拆书库写入和 legacy 同步。
- `DisassembleBookWorkflow` 复用 `packages/agent-runtime/src/workflows/disassemble-library.ts`，与 `continue_disassemble` / `book_fusion` 共用 manifest、legacy 和 source helper。
- `packages/agent-runtime/src/workflows/registry.ts` 注册 `DisassembleBookWorkflow`。
- `AgentRuntimeService.runLocalWorkflowSkill()` 删除最后的 workflow legacy 大分支，只保留 registry 分发与未注册 workflow 报错。
- 新增 `packages/agent-runtime/src/workflows/disassemble-book.test.ts`，覆盖完整拆书、列出拆书库、归档来源和 runtime registry 路由。
- `runtime.ts` 当前约 2056 行。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/workflows/disassemble-book.test.ts packages/agent-runtime/src/runtime.test.ts -t "disassemble"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- P1 Workflow Handler Registry 迁移完成，可进入 P2 `ContextAssembler`。
- P2 第一刀建议只抽上下文读取/组装边界，先不要调 prompt 语义，避免生成质量和重构混在同一提交里。

### 15.27 2026-07-07 P2 ContextAssembler 第一刀开发记录

本轮进入 P2，先建立 ContextAssembler 基础设施，并用最保守方式接入 chat-runner。

主要改动：

- 新增 `packages/agent-runtime/src/kernel/context-block.ts`，定义 context block priority/source 与 assembled block 统计类型。
- 新增 `packages/agent-runtime/src/kernel/context-assembler.ts`，实现 chat、compact retry、prompt skill、body_generate、consistency_check 默认预算，以及 priority/maxChars 裁剪。
- 新增 `packages/agent-runtime/src/kernel/context-assembler.test.ts`，覆盖 critical/high/low 预算行为、critical 裁剪、per-block maxChars 和 compact retry 预算。
- `packages/agent-runtime/src/chat-runner.ts` 将 `buildTurnContext()`、`buildConversationTurnContext()`、`buildStableProjectContext()` 的最终上下文裁剪交给 assembler。
- 本刀没有重排 prompt 结构：仍先沿用旧文本拼装，再做 assembler 预算封装，减少生成质量漂移风险。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/agent-runtime
npm test -- packages/agent-runtime/src/kernel/context-assembler.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- P2 下一刀把 chat stable context / turn context 拆成多个真实 `ContextBlock`，并把 assembled block 统计写入 agent trace。
- 后续再接 `skill-runner.ts` 的 prompt skill 上下文，继续保持 prompt 语义稳定。

### 15.28 2026-07-07 P2 ContextAssembler 第二刀开发记录

本轮继续 P2，通过主线程 + 子智能体 Pauli 并行推进：主线程负责 chat trace 集成，Pauli 负责 skill-runner 接入。

主要改动：

- `packages/agent-runtime/src/chat-runner.ts` 将 stable project context 和 turn context 拆为真实 `ContextBlock`，保留原 section 文本。
- `AgentChatRunner` 增加可选 `ChatContextAssemblyObserver`，把 assembled context 的 blocks 暴露给 runtime。
- `packages/agent-runtime/src/runtime.ts` 将 chat assembled blocks 写入 trace，包含 scope、priority、budget、included_chars 和 truncated 等 passthrough 字段。
- `packages/agent-runtime/src/skill-runner.ts` 将 prompt skill 上下文交给 `assembleContext()`，普通执行使用 `prompt_skill` 26k 预算，compact retry 保持 12k 预算。
- `packages/agent-runtime/src/runtime.test.ts` 扩展 trace context block 断言。
- `packages/agent-runtime/src/skill-runner.test.ts` 新增超长 prompt skill 上下文裁剪测试。

本轮已验证：

```powershell
npm test -- packages/agent-runtime/src/kernel/context-assembler.test.ts packages/agent-runtime/src/skill-runner.test.ts packages/agent-runtime/src/runtime.test.ts -t "trace|ContextAssembler|prompt-skill context|read-context chat"
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- P2 可继续把 workflow 上下文纳入 assembler，优先 `body_generate` / `consistency_check`。
- 下一大块可进入 P3 GraphMemory，建议先做 vector-service skeleton，再进入 agent-runtime 集成。

### 15.29 2026-07-07 P3 GraphMemory 最小骨架开发记录

本轮由子智能体 McClintock 并行实现 vector-service 内的 P3 GraphMemory 最小骨架，主线程审阅、验证并提交。

主要改动：

- 新增 `packages/vector-service/src/graph-memory.ts`，提供 `GraphMemory` facade，封装 rebuild、updatePaths、writing context 和 draft consistency。
- 新增 `packages/vector-service/src/graph-extractor.ts`，作为规则抽取 facade，复用现有 `GraphContext.extractGraphData()`。
- 新增 `packages/vector-service/src/graph-consistency.ts`，实现保守 advisory draft consistency 检查，能识别 draft 对 confirmed claim 的直接否定。
- `packages/vector-service/src/graph-context.ts` 让 `appears_in` 使用现有中文/阿拉伯数字章节 parser。
- `packages/vector-service/src/index.ts` 导出新模块与类型。
- 新增 `packages/vector-service/src/graph-memory.test.ts`，覆盖 planned/confirmed claims、角色出场关系、blocking claims、上下文截断和 extractor facade。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/vector-service
npx vitest run packages/vector-service/src/graph-context.test.ts packages/vector-service/src/graph-memory.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- 将 `GraphMemory.buildWritingContext()` 接入 `body_generate`，作为 GraphContext 的后续替代 facade。
- 将 `GraphMemory.checkDraftConsistency()` 接入 `consistency_check`，先作为 advisory，不阻断保存。
- 后续再把 `updatePaths()` 从全量 rebuild 优化为按变更路径增量更新。

### 15.30 2026-07-07 P3 GraphMemory runtime 集成记录

本轮完成 GraphMemory 到 agent-runtime 的第一轮集成，保持 advisory / fail-soft 策略。

主要改动：

- `packages/agent-runtime/src/workflows/body-generate.ts` 使用 `GraphMemory.buildWritingContext()` 注入正文生成和一致性回炉 prompt 的图谱上下文。
- `body_generate` 生成后执行 `GraphMemory.checkDraftConsistency()`，blocking claims 会合并到 risks 并进入既有 revision 流程。
- `body_generate` 保存后调用 `GraphMemory.updatePaths(savedPaths)`，失败只写 metadata，不影响保存。
- `packages/agent-runtime/src/workflows/consistency-check.ts` 并行执行 GraphMemory advisory，保留模型结果并附加 graph metadata。
- `packages/vector-service/src/graph-consistency.ts` 去除章节数字占位 advisory，减少误报。
- 扩展 `body-generate.test.ts` 与 `consistency-check.test.ts`，覆盖 graph blocking claim、graph unavailable 和正文回炉。
- 本轮由主线程 + 子智能体 Meitner 并行完成；Meitner 负责 consistency-check，主线程负责 body-generate。

本轮已验证：

```powershell
npm test -- packages/agent-runtime/src/workflows/body-generate.test.ts -t "BodyGenerateWorkflow"
npm test -- packages/agent-runtime/src/workflows/consistency-check.test.ts
npm run typecheck -w @xiaoshuo/agent-runtime
npm run typecheck -w @xiaoshuo/vector-service
npx vitest run packages/vector-service/src/graph-memory.test.ts packages/vector-service/src/graph-context.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- P3 后续可将 graph advisory 写入 agent trace，方便检查 blocking claim 来源。
- `GraphMemory.updatePaths()` 当前仍全量 rebuild，后续可增量化。
- 若切到 P4，优先建立 body_generate / consistency_check 的 eval fixture，覆盖 graph advisory 不误伤。

### 15.31 2026-07-07 P4 Agent Eval 开发记录

本轮建立 agent-runtime 的 P4 Agent Eval 最小体系，并修复 eval 暴露的若干路由/联网/上下文统计问题。

主要改动：

- 新增 `packages/agent-runtime/evals/routing-cases.jsonl`，覆盖 intent、skill、file operation、chat 与 web-search 触发边界。
- 新增 `packages/agent-runtime/evals/save-policy-cases.jsonl`，覆盖生成内容写入决策、保存目标/模式、确认策略和归档类操作确认。
- 新增 `packages/agent-runtime/evals/context-cases.jsonl`，覆盖 ContextAssembler priority、budget、`maxChars` 与低优先级丢弃。
- 新增 `packages/agent-runtime/src/routing-eval.test.ts`，从 JSONL 读取 eval，检查 routing accuracy >= 90%、skill selection accuracy >= 90%，并确保联网搜索只在明确素材/资料搜索时触发。
- 新增 `packages/agent-runtime/src/save-policy-eval.test.ts`，检查 write decision accuracy >= 95%、destructive action confirmation accuracy = 100%，并通过空配置与 mock model client 保证 eval 不意外调用模型。
- `packages/agent-runtime/src/intent-router.ts` 补齐 `scan_pits`、去 AI 味、继续拆书、批量章节和继续对白等语义信号，避免被普通 read_context 或 generic body route 抢走。
- `packages/agent-runtime/src/web-search.ts` 收紧 `查一下` 触发条件，避免“查一下这章有没有设定矛盾”这类本地检查触发联网。
- `packages/agent-runtime/src/kernel/context-assembler.ts` 的 `truncated` 现在会反映 per-block `maxChars` 裁剪。
- 子智能体 Hume 因 503 失败；替代 worker Feynman 返回后补充了确定性保护，save-policy eval 最终由主线程整合收口。

本轮已验证：

```powershell
npm test -- packages/agent-runtime/src/routing-eval.test.ts packages/agent-runtime/src/intent-router.test.ts packages/agent-runtime/src/web-search.test.ts packages/agent-runtime/src/kernel/context-assembler.test.ts
npm test -- packages/agent-runtime/src/routing-eval.test.ts packages/agent-runtime/src/save-policy-eval.test.ts packages/agent-runtime/src/generated-save-planner.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

下一步建议：

- 若继续 P4，可把 Vitest 内联 JSONL runner 抽成 `src/evals/` 或 scripts，并加 npm script 方便 CI 单独跑。
- P4 eval 数据可继续扩充真实 `body_generate` / `consistency_check` workflow context fixture，覆盖 graph advisory 不误伤。
- 下一大块可进入 P5 前端 Controller 拆分，先拆 hook/controller 边界，保持 UI 行为不变。

### 15.32 2026-07-07 P5 前端 Controller 拆分记录

本轮完成 Workbench controller / shell 的第一轮低风险拆分，重点是降低热点文件行数并保持旧 UI 行为。

主要改动：

- `apps/workbench/src/hooks/useWorkbenchController.ts` 改为约 35 行 facade，组合 project、document、conversation、operations、config、cloud project controller。
- 原大 hook 实现迁入 `apps/workbench/src/hooks/controllers/useWorkbenchCoreController.ts`，其余 `hooks/controllers/*.ts` 先作为选择性 facade，便于后续按真实状态所有权继续拆。
- `apps/workbench/src/App.tsx` 缩减到约 1183 行。
- 新增 `apps/workbench/src/layout/AppShell.tsx`、`LeftSidebar.tsx`、`RightRail.tsx`。
- 新增/拆出 `features/project/ProjectSidebar.tsx`、`ProjectTreeNode.tsx`、settings、skills、card draw、disassembly、ledger、revision、workflow controls 等 feature page。
- 新增 `apps/workbench/src/features/legacy/LegacyWorkbenchView.tsx`，保留旧 E2E 和用户流依赖的 `Workbench sections` 导航。
- 修复 legacy 项目创建/打开后异步切回编辑页的竞态，避免用户快速切到会话页后被 `.then()` 覆盖。
- `apps/desktop-shell/src/main/runtime/license-guard.ts` 增加 E2E-only license bypass，只在 `XIAOSHUO_E2E_RUNTIME=1` 且 `XIAOSHUO_E2E_BYPASS_LICENSE=1` 同时存在时启用；`tests/e2e/start-runtime.mjs` 负责注入测试环境变量。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
npx playwright test tests/e2e/project-entry.spec.ts --workers=1 --reporter=list
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

验收结果：

- P5 手册要求的两个行数目标已达成：`App.tsx` < 1500，`useWorkbenchController.ts` < 1200。
- 关键 E2E `project-entry.spec.ts` 6/6 通过。
- 完整测试集当前为 59 个文件、384 个用例通过。

下一步建议：

- 若继续前端瘦身，优先把 `useWorkbenchCoreController.ts` 内的真实状态与副作用继续拆到各 domain controller。
- 可继续把 `App.tsx` 内剩余 workflow glue 迁入 feature page / feature hooks。
- 下一大块可进入 P6 Agent 运行检查器 UI。

### 15.33 2026-07-07 P6 Agent 运行检查器 UI 记录

本轮完成 P6，补齐 trace 查询 API，并在 Workbench 中加入 Agent 运行检查器。

主要改动：

- `packages/agent-runtime/src/agent-trace.ts` 新增 `getAgentTraceDirPath()`，避免 trace writer 和 reader 重复维护目录规则。
- `packages/shared/src/api.ts` 新增 `agentTraces` / `agentTrace` contract。
- `packages/api-client/src/client.ts` 新增 `getAgentTraces(limit)` / `getAgentTrace(runId)`。
- 新增 `apps/desktop-shell/src/main/runtime/agent-trace-routes.ts`，读取项目内 `00_设定集/.agent/runs/*.jsonl`。
- `apps/desktop-shell/src/main/runtime-server.ts` 挂载 trace route，`runtime/index.ts` 导出 route。
- 新增 `apps/workbench/src/views/AgentTraceView.tsx`，展示 trace 的输入摘要、intent、技能选择、上下文块、模型调用、联网来源、保存决策、保存路径和错误。
- `apps/workbench/src/layout/RightRail.tsx` 新增“运行”入口，`App.tsx` 新增 `traces` center feature。
- `apps/workbench/src/styles.css` 新增 trace inspector 布局与响应式样式。
- 新增 `apps/desktop-shell/src/main/runtime/agent-trace-routes.test.ts`，并扩展 `packages/api-client/src/client.test.ts`。

本轮已验证：

```powershell
npm test -- apps/desktop-shell/src/main/runtime/agent-trace-routes.test.ts packages/agent-runtime/src/agent-trace.test.ts packages/api-client/src/client.test.ts
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
npx playwright test tests/e2e/project-entry.spec.ts --workers=1 --reporter=list
```

验收结果：

- trace list/detail API 可用，未打开项目返回 400，缺失单条返回 404，坏 JSONL 行不会影响其他记录。
- Workbench 可从右侧栏“运行”进入 Agent Trace 检查器。
- 完整测试集当前为 60 个文件、389 个用例通过。
- 关键 E2E `project-entry.spec.ts` 6/6 通过。

下一步建议：

- P6 后续可加 trace 过滤、搜索、失败-only 视图，以及从会话消息跳转到对应 run。
- 下一大块可进入 P7 Skill 平台化，先从 manifest schema 和内置 skill manifest 兼容层开始。

### 15.34 2026-07-07 P7 Skill 平台化第一刀记录

本轮完成 P7 的保守第一刀：先把 skill manifest 变成共享契约和导入/展示兼容层，保持现有运行路径不变。

主要改动：

- `packages/shared/src/schemas/skill.ts` 新增 `skillManifestSchema`、`skillModelPolicySchema`、`skillSavePolicySchema` 和对应类型。
- `skillDefinitionSchema` 继续兼容旧 flat skill，同时新增 `version`、schema、tools、model/save policy、eval cases 与 nested `manifest` 字段。
- `packages/skill-service/src/service.ts` 新增 manifest 归一化，内置技能与导入技能都会补齐 `version = "1.0.0"`、默认 `model_policy` 和默认 `save_policy.requires_confirmation = true`。
- 导入外部 `SKILL.md` 继续走 prompt skill 安全路径，但可读取 version、tools、input/output schema、model/save policy、eval cases 等简单 frontmatter 字段。
- 保存导入技能前重新归一化，`00_设定集/.agent/skills/imported.json` 会持久化 manifest。
- Workbench 技能卡片显示版本号；导出 `SKILL.md` 时写入 manifest 相关 frontmatter，便于再导入。
- 扩展 shared schema 测试与 skill-service 导入测试，覆盖旧 `SKILL.md` 默认值和带 manifest 元数据的导入。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/skill-service
npm run typecheck -w @xiaoshuo/workbench
npm test -- packages/shared/src/schemas.test.ts packages/skill-service/src/service.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
npm run build -w @xiaoshuo/workbench
```

验收结果：

- P7 要求的版本化 manifest schema 已进入 shared contract。
- 无 manifest 的 `SKILL.md` 导入保持兼容，并默认需要保存确认。
- 完整测试集当前为 60 个文件、391 个用例通过。

下一步建议：

- P7 后续可将内置技能迁出 `BUILTIN_SKILLS` 内联数组，拆成独立 manifest / prompt 文件。
- 让 `PromptSkillRunner` 或 runtime 逐步消费 `model_policy`、`save_policy` 和 `tools`，但每一步都要有 trace/eval 覆盖。
- 若继续平台化 workflow/job/external skill 导入，仍应先设计白名单和签名/来源校验，避免直接执行外部 handler。

### 15.35 2026-07-07 P8 取消/中断治理记录

本轮完成 agent 长任务取消治理，让 Workbench 停止响应和 HTTP 断连能真正传到模型调用、workflow、抽卡和 trace。

主要改动：

- 新增 `packages/agent-runtime/src/cancellation.ts`，统一 `AgentRunOptions`、取消错误和 `throwIfAborted()`。
- `packages/model-client/src/openai-compatible.ts` 支持外部 `AbortSignal`；caller abort 会取消 fetch / stream reader，并保持 `AbortError` 语义，不再误走 timeout 或非流式 fallback。
- `AgentRuntimeService`、`AgentChatRunner`、`PromptSkillRunner`、planner、save planner、smart skill orchestrator、humanizer、`streamModelText()` 全部接收并传递 `options.signal`。
- 流式聊天已产生 partial delta 后取消时，不产出 final；会话写入 partial assistant，并在 metadata 标记 `stopped` / `cancelled`。
- `packages/shared/src/schemas/agent.ts` 的 trace schema 增加 `cancelled`，runtime 取消时 trace 以 `workflow_completed` + `cancelled=true` 收尾。
- `WorkflowRunContext` 增加 `signal`；正文生成、批量生成、一致性检查、融梗、Nuwa 蒸馏、拆书、扫伏笔等 workflow 在模型调用和写盘前检查取消。
- `batch_generate` 取消后不会继续进入下一章。
- `generateCardDraw()` 支持取消，预取消不会启动候选模型调用，也不会写候选文件或 manifest。
- `apps/desktop-shell/src/main/runtime/http-utils.ts` 新增 `createRequestAbortSignal()`；agent routes、conversation routes 和 card draw route 已把 request abort/early response close 传给 runtime。
- 新增/扩展测试覆盖 model-client abort、流式 stopped 会话、batch 章间取消、抽卡预取消、HTTP abort helper 与 conversation routes。

本轮已验证：

```powershell
npx vitest run packages/model-client/src/openai-compatible.test.ts packages/agent-runtime/src/workflows/batch-generate.test.ts packages/agent-runtime/src/runtime.test.ts apps/desktop-shell/src/main/runtime/runtime-utils.test.ts apps/desktop-shell/src/main/runtime/conversation-routes.test.ts apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts
npm run typecheck
npm test
npm run build:desktop
npm run smoke:desktop
```

验收结果：

- 完整测试集当前为 60 个文件、402 个用例通过。
- `npm run typecheck`、`npm run build:desktop`、`npm run smoke:desktop` 均通过。
- 停止响应不会再把半截内容作为正常 final assistant 保存；partial 会话可通过 metadata 区分 stopped/cancelled。

下一步建议：

- 若后续把长 agent 任务迁入 `JobManager` 后台 job，继续把 job worker signal 显式传入 runtime。
- Agent Trace 检查器可增加 cancelled/stopped 筛选。
- web search / graph memory 底层 I/O 目前主要依赖调用前后检查；若服务层未来支持 AbortSignal，可继续向下传递。

### 15.36 2026-07-07 Agent 文件引用与 Skill 管理复审加固记录

本轮对“项目文件引用”和“skill 生成/编辑”升级做了一次专业 agent 工程复审，并补齐会影响用户真实体验的三处缺口。

主要改动：

- Workbench 普通会话发送 payload 现在会带上 `current_path`，会话中提到“当前文档/这章/本文”时，后端可通过 `ProjectFileResolver` 解析并读取当前打开文件。
- `conversationMessageRequestSchema` 显式允许可选 `current_path`，保持旧调用兼容。
- `AgentRuntimeService.conversationPayloadToAgentRequest()` 不再把会话 `current_path` 清空，会透传到 `AgentRunRequest`。
- `AgentChatRunner.buildConversationTurnContext()` 改为接收完整会话 payload，并把 `reference_paths`、`confirmed_reference_paths`、`disable_auto_references`、`current_path` 统一解析成 reference context blocks。
- `SkillService.importSkillDraft()` 导入重复 ID 草稿时使用 `nextAvailableSkillId()` 分配新 ID，避免中文/重复 skill ID 归一化后静默覆盖旧导入技能。
- `SkillService.cloneSkill()` 只允许复制 `prompt` 型 skill；`workflow/job/external` skill 会明确拒绝，避免把复杂执行型内置技能伪装成 prompt-only 副本。
- 补充 runtime 和 skill-service 回归测试，覆盖显式项目文件引用、当前文档引用、重复 draft ID 不覆盖、非 prompt 内置 skill 拒绝 clone。

本轮已验证：

```powershell
npx vitest run packages/agent-runtime/src/runtime.test.ts packages/skill-service/src/service.test.ts
npm run typecheck
npm test
npm run build:workbench
npm run build:desktop
npm run smoke:desktop
git diff --check
```

验收结果：

- 普通会话消息已能把用户显式/确认引用的项目文件内容送入模型上下文。
- 普通会话消息已能在用户提到当前文档时读取 `current_path` 对应文件内容。
- 完整测试集当前为 68 个文件、456 个用例通过。
- `npm run typecheck`、Workbench build、Desktop build、Desktop smoke 均通过；Workbench build 仍只有既有 Vite chunk size warning。

下一步建议：

- Workbench 引用确认和 skill 编辑/回滚仍建议补专门 Playwright e2e；优先给引用 chip、候选确认面板、skill diff/rollback 按钮补稳定 `data-testid`。
- 若后续支持 workflow/job/external skill 的用户自定义，必须先设计 manifest 白名单、来源签名、handler registry 和隔离执行策略，不要复用 prompt clone/import 通道。

### 15.37 2026-07-07 拆书格式与 20 万字导入记录

本轮按拆书样例文件的“逐章速览 + 大事件拆解”形态，收紧一键拆书落盘格式，并把拆书导入/爬取默认字数从 6 万扩到 20 万。

主要改动：

- `disassemble_book` workflow 为 `拆书设定提取.txt` 和 `反向细纲.txt` 注入硬格式指令，不再只给泛泛的“提取设定 / 提取剧情推进”。
- `拆书设定提取.txt` 固定以 `# 《书名》拆书设定提取` 开头，并保留 `人物设定`、`体系设定`、`地图设定`、`道具设定`、`势力与关系`、`伏笔与可复用素材` 六个二级标题。
- `反向细纲.txt` 固定以 `# 《书名》详细剧情发展` 开头，并保留 `逐章速览`、`大事件拆解`、`全书结构总览` 三个二级标题；大事件要求包含章节范围、高潮和小事件 `起 / 承 / 转 / 合`。
- 落盘前新增拆书输出归一化：去除 Markdown 代码块，兼容旧式 `【人物设定】` 标题，缺失必需标题时自动补齐，避免生成结果破坏文件结构。
- `DISASSEMBLE_SOURCE_IMPORT_CHARS` 从 `60_000` 提升到 `200_000`；上传附件、按项目文件读取拆书源、从已归档拆书库重新一键拆书，统一使用 20 万字上限。
- 联网拆书爬虫默认 `min_chars` 从 `60_000` 提升到 `200_000`；shared job schema 默认值和 Workbench “最少字数”输入默认值同步为 `200000`。
- 本轮只扩大拆书源导入和爬取默认值；Nuwa 蒸馏、一致性检查、扫伏笔等非拆书主流程仍保留各自原有上限，避免无关长上下文任务超时。
- 补充 `DisassembleBookWorkflow` 回归测试：校验格式指令进入模型 prompt、落盘文件包含固定标题骨架，以及超过旧 6/8 万位置的原文会进入新的拆书归档。

本轮已验证：

```powershell
npx vitest run packages/agent-runtime/src/workflows/disassemble-book.test.ts packages/crawler-service/src/crawler.test.ts
npx vitest run packages/agent-runtime/src/runtime.test.ts
npm run typecheck -w @xiaoshuo/agent-runtime
npm run typecheck -w @xiaoshuo/crawler-service
npm run typecheck -w @xiaoshuo/shared
npm run typecheck -w @xiaoshuo/workbench
```

验收结果：

- 一键拆书的两个产物现在都有固定 Markdown 文件骨架，适配“详细剧情发展”类拆书文件。
- 拆书上传/项目文件读取/已归档源书重跑不再卡在旧 6 万或 8 万上限。
- 相关 workflow、crawler 和 runtime 回归测试通过。

### 15.38 2026-07-08 Workbench 状态入口与二级运行页调整记录

本轮按界面反馈收拢中间工作区和右侧功能入口，把“运行”和“向量测试”移入统一的状态入口。

主要改动：

- 移除 Workbench 中心区顶部旧版“项目 / 编辑 / 会话 / 终端”四个按钮，默认直接显示新版中间工作区，让内容上移。
- 右侧九宫格不再单独显示“运行”，保留 AI、批量、拆书、抽卡、伏笔、日志、技能、一致性、设置。
- 中间顶部原“刷新”位置改为“状态”下拉，内含“刷新 / 运行 / 向量测试”三个动作。
- “运行”作为二级页打开现有 `AgentTraceView`。
- 新增 `VectorTestFeaturePage`，把向量索引重建、待嵌入处理、刷新状态、召回调试放到独立“向量测试”二级页。
- 桌面顶部菜单从“刷新”改为“状态”子菜单，并通过新增 IPC 事件打开“运行”和“向量测试”页。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run typecheck -w @xiaoshuo/desktop-shell
npm run build:workbench
npm run build -w @xiaoshuo/desktop-shell
```

验收结果：

- Workbench 和 Desktop Shell 类型检查通过。
- Workbench 和 Desktop Shell 构建通过；Workbench build 仍只有既有 Vite chunk size warning。
- 已重启本地 Electron 预览，右侧“运行”入口消失，应用窗口可正常打开。

### 15.39 2026-07-08 技能页手动草稿入口移除记录

本轮按界面反馈删除技能页内“技能名 / 提示词 / 生成草稿 / 当前文档草稿”手动创建区域，技能创建改由右侧 AI 对话自然语言完成。

主要改动：

- 技能页不再展示手动技能草稿生成表单，也不再提供“当前文档草稿”按钮。
- 保留顶部本地路径导入、文件上传、URL 草稿、技能目录、刷新技能入口。
- 保留 URL 草稿生成后的预览、导入草稿和丢弃确认区，避免 URL 导入流程失去确认入口。
- 清理手动草稿表单相关状态、函数和 CSS，仅保留草稿预览样式。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
```

验收结果：

- Workbench 类型检查通过。
- Workbench 构建通过；仍只有既有 Vite chunk size warning。
- 技能页手动创建技能表单已从中心区移除；现有导入、预览确认和技能管理流程保持可用。

### 15.40 2026-07-08 向量测试状态横条压缩记录

本轮按界面反馈压缩“向量测试”页的向量索引状态展示，减少中心工作区上方的空白占位。

主要改动：

- 给向量测试页的状态卡增加专用横条布局，标题、状态标签和分块/可检索/待处理/模型信息横向排列。
- 保持项目页其他状态卡不受影响，只覆盖向量测试页的状态卡。
- 增加窄窗口响应式折行，避免模型名或指标在小宽度下撑破布局。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
```

验收结果：

- Workbench 类型检查通过。
- Workbench 构建通过；仍只有既有 Vite chunk size warning。
- 向量索引状态区域由竖向卡片压缩为横向长条，减少纵向空间占用。

### 15.41 2026-07-08 一致性自动检查入口位置调整记录

本轮按界面标注调整“一致性检查”页的自动检查开关，让它出现在来源文件下方的左侧空位，并使用右侧功能选中态同风格的点击效果。

主要改动：

- 将“自动一致性检查”从右侧小 checkbox 改为独立胶囊按钮，放到表单网格第二行左列。
- 点击按钮仍然写入 `enable_consistency_revision` 配置，保持原有自动一致性检查功能不变。
- 按钮开启后使用蓝色填充和浅色文字，视觉接近右侧“一致性”功能按钮的选中效果。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
```

验收结果：

- Workbench 类型检查通过。
- Workbench 构建通过；仍只有既有 Vite chunk size warning。
- 一致性自动检查入口已移动到标注位置，点击后会切换为蓝色激活态。

### 15.42 2026-07-08 批量生成开关胶囊化记录

本轮按界面标注调整“批量生成”页的两个开关，让它们按红圈位置排列，并复用上一轮一致性入口的点击效果。

主要改动：

- “生成后直接写入正文文件”从 checkbox 改为第 4 列胶囊按钮，默认开启时显示蓝色激活态。
- “自动审查生成文件”从 checkbox 改为第 2 行第 1 列胶囊按钮，点击后切换 `enable_consistency_revision` 配置。
- 将上一轮一致性页按钮样式抽成通用 `xw-operation-toggle`，批量页和一致性页复用同一套 hover、focus、active、按下反馈。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
```

验收结果：

- Workbench 类型检查通过。
- Workbench 构建通过；仍只有既有 Vite chunk size warning。
- 批量页两个开关已按标注位置排列，点击效果与上一条一致。

### 15.43 2026-07-08 左侧刷新与补全索引入口收拢记录

本轮按界面反馈收拢左侧项目操作区，避免重复入口占用项目树上方空间。

主要改动：

- 左侧项目操作区移除“补全索引”和“刷新项目”按钮，只保留“新建项目”“打开项目”和上传/同步项目入口，项目树位置随之上移。
- 顶部“状态 - 刷新”和桌面菜单刷新统一执行项目工作区刷新；若当前打开了文档，也会继续读取当前文档最新版。
- “补全索引”入口移动到“状态 - 向量测试”页，原向量重建按钮文案改为“补全索引”。
- 教程弹层从单一网站教程改为“网站使用 / 软件使用”两部分；软件使用里说明统一刷新入口和补全索引位置。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
```

验收结果：

- Workbench 类型检查通过。
- Workbench 构建通过；仍只有既有 Vite chunk size warning。
- 左侧重复按钮已移除，刷新和补全索引入口已按新位置收拢。

### 15.44 2026-07-08 0.4.0 版本号同步记录

本轮按发布要求将 ArcWriter 应用版本推进到 `0.4.0`，并通过 `v0.4.0` 标签触发 GitHub Release 工作流生成安装包。

主要改动：

- 桌面壳 `@xiaoshuo/desktop-shell` 的包版本从 `0.3.2` 更新为 `0.4.0`，锁文件同步更新。
- Workbench 浏览器窗口标题从 `ArcWriter 0.3.2` 更新为 `ArcWriter 0.4.0`。
- 更新服务测试里的打包应用模拟版本同步为 `0.4.0`。

本轮已验证：

```powershell
npm run typecheck -w @xiaoshuo/workbench
npm run build:workbench
npm run typecheck -w @xiaoshuo/desktop-shell
npm run build -w @xiaoshuo/desktop-shell
```

验收结果：

- 应用显示版本和桌面壳打包版本已统一为 `0.4.0`。
- 维护文档已记录本次版本号同步范围。
- `main` 已推送到 GitHub，`v0.4.0` 标签已推送并触发 `Release Desktop` 工作流。
- GitHub Actions 运行 `28925684476` 已成功完成，Release 页面已生成 `ArcWriter-Setup-0.4.0.exe`、`ArcWriter-Setup-0.4.0.exe.blockmap` 和 `latest.yml`。
- 本地 `release/` 下旧安装包产物没有手工修改；0.4.0 安装包由 GitHub Actions 从 `v0.4.0` 标签构建生成。

### 15.45 2026-07-10 Agent 智能化优化手册换版记录

本轮先对 ArcWriter 0.4.0 的 Agent Runtime、模型调用、上下文、记忆、图谱、任务、Trace、Workbench 交互和测试体系进行只读审阅，再用当前审阅结论完整覆盖旧版 Agent 优化手册。

主要结论：

- 当前系统已具备规则/模型混合路由、技能串行编排、文件引用、向量/图谱上下文、安全保存、取消、Trace 和 Skill 版本能力，属于可控自动化型 Agent。
- 主要智能化缺口是任务状态不持久、失败后不能从步骤恢复、规划缺少 Observe/Replan、模型调用治理不足、会话记忆偏文本摘录、上下文仍按字符裁剪，以及质量门和聊天内 Agent 控制尚未统一。
- 新版 `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md` 完整取代 2026-07-07 旧方案，以 0.4.0 为基线，重新定义 P0-P7：持久执行、Model Gateway、Plan-Act-Observe-Replan、分层记忆、Token 上下文、质量门、Agent 交互和 Eval 发布门禁。
- 新方案明确暂缓多 Agent、任意 shell 和无预算自治，先完成单 Agent 的可恢复、可验证闭环。

本轮审阅基线验证：

```powershell
npm run typecheck
npm test
```

验收结果：

- 全 workspace 类型检查通过。
- 68 个测试文件、457 个测试用例通过。
- 本轮只替换设计与维护文档，没有修改运行时代码。
- 工作区原有未跟踪 `PRODUCT.md` 未纳入本轮变更。

### 15.46 2026-07-10 Agent 优化方案二次审查补强记录

本轮对新版 Agent 智能化优化手册进行第二次工程完整性审查，并按审查结果直接补强现行方案。

新增和修正内容：

- 新增安全与信任模型：区分系统策略、用户指令、可信项目、不可信文件/网页和模型草稿，明确 imported skill 工具权限白名单、本地 runtime 会话令牌、Origin 校验和统一脱敏要求。
- 新增并发与事务原则：写入携带文档版本/hash、幂等键和 write lease；Generated Cache、时间线和文档版本按逻辑事务提交，禁止多个 run 静默覆盖同一路径。
- 补齐 AgentConfirmation、AgentRunEvent、Artifact 和 Verification 数据契约，增加确认过期/失效、SSE 或流式事件重连、sequence 去重和状态回放要求。
- P0 增加 SQLite schema migration、备份、只读恢复、数据保留、磁盘清理、并发冲突和故障测试。
- P1 增加 provider 并发限制、Rate Limiter、Circuit Breaker、数据发送披露和本地私密内容保护。
- P2 通过 VerifierPort/MemoryCommitPort 解除对 P3/P5 的阶段依赖，并补充 Action 权限和 Prompt Injection 测试。
- P3 增加记忆查看、纠正、遗忘、导出、冲突处理和跨项目隔离；P5 增加评分校准与用户覆盖；P6 增加事件重连和 WCAG 2.2 AA 验收。
- P7 增加可复现 Eval Manifest、人工盲评校准、故障注入、并发、安全、性能和长时间 soak test。
- 更新 0.5.0-0.7.0 工作量、P0 第一批任务、Feature Flag 兼容矩阵、停止放量条件和最终完成定义。

本轮验证：

- 文档结构、标题编号和 Markdown 围栏检查。
- `git diff --check`。
- 本轮只修改文档，未重复运行代码测试；代码基线仍沿用上一轮已通过的 68 个测试文件、457 个测试用例。
- 工作区原有未跟踪 `PRODUCT.md` 继续保留，未纳入提交。

### 15.47 2026-07-10 Agent 优化方案第三次实施前冻结记录

本轮在 P0 开始落地后暂停继续扩写代码，结合实际 runtime、JobManager、SQLite 驱动、Workbench 和两路独立子代理审查结果，再次修改现行 Agent 智能化实施手册。重点不是增加概念，而是冻结会直接影响数据库和恢复链路的实现语义。

主要修订：

- 冻结单一 `run_id`：同步响应、流式事件、Execution Store、Agent Trace 和会话必须使用同一 ID；恢复和步骤重试复用原 run。
- 把 `AgentStepAttempt`、IntentResolution、协作模式、plan draft/approved/superseded、run/step/confirmation version、operation id 和稳定错误码补为正式契约。
- 固定项目内 Execution Store 路径为 `00_设定集/.agent/agent_runs.sqlite3`，与向量库和桌面全局状态库分离；通过 adapter 支持现有 `better-sqlite3`/`node:sqlite` 驱动探测。
- 新增 runtime instance heartbeat/lease、fencing token、Windows/Electron 生命周期矩阵和唯一 scheduler 规则，避免启动时无条件暂停或重复接管任务。
- 明确 SQLite 与项目文件不具备跨资源 ACID，新增 commit journal、临时文件、原子替换、transactional outbox 和启动对账协议。
- 明确 Agent Run 与旧 `JobManager` 的唯一事实源边界，批量正文/拆书进入持久内核，legacy crawler/index job 只做显式映射。
- 增加 assist/plan/execute 协作模式、阻塞歧义与安全假设分类、计划执行前协商、主动建议冷却和默认无后台云调用。
- 强化自然语言 Skill 创建为 SkillSpec + 正反例 + 权限 lint + 路由碰撞 + dry-run；增加作者主观质量建议的授权边界和 artifact feedback。
- 增加 user override、memory revision 和纠正向会话摘要/向量/图谱/缓存传播的闭环，防止全量重建复活旧事实。
- 评估增加 sealed holdout、统计协议、确定性故障注入、性能预算和 installed-build smoke；P7 是统一收口，不再允许前序版本延后发布门禁。
- 将路线重排为 `0.5.0` 持久执行、`0.6.0` 模型与闭环规划、`0.7.0` 记忆上下文、`0.8.0` 质量交互、`0.9.0` 评估硬化；P0 第一批改为 A-H 垂直切片。
- Feature Flag 改为 `off/shadow/on` 执行模式，run 固化 flag snapshot；安全基线不可由普通用户关闭，回滚增加 active run 排空和 schema reader/writer 兼容规则。

本轮验证：

- Markdown 标题层级与 P0-P7/Task A-H 编号检查通过。
- Markdown 围栏数量为偶数，未发现未闭合代码块。
- `git diff --check -- docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md docs/PROJECT_MAINTENANCE_HANDOFF.md` 通过。
- 本轮只提交两份文档；工作区已有 P0 shared schema、状态机和 runtime Origin 校验草稿保留，未混入本次计划冻结提交。
- 未跟踪 `PRODUCT.md` 继续保留，未纳入提交。

### 15.48 2026-07-10 Agent 优化方案第四次实现校准记录

本轮按用户要求再次修改现行优化计划。主线程对照当前 P0 工作树、CI/release 能力和三路独立子代理审查，重点把“已有代码”与“已经验收”分开，并修正会直接造成恢复、安全和智能质量偏差的契约。

主要修订：

- 增加 P0 实施台账：Task A-F、H 标记为“实现中”，Task G 标记为“未开始”；F/H 仅有 store/Origin 等基础，尚未进入可验收生产链路。明确 P0 当前不可发布，也不得提前进入 P1。
- shared 契约补入 `chat/file_operation` step、`chat_answer` artifact 和 `interrupted` attempt；暂停不再作为普通失败或消耗重试预算。
- 明确 stale run 接管必须结算孤儿 attempt，renderer/HTTP 断连只结束事件订阅，只有显式 pause/cancel API 能改变 run。
- `request_snapshot` 改为版本化字段白名单 `AgentRecoverableRequest`，模型 attempt 单独记录实际出站数据分类和 policy/consent receipt，禁止把任意请求塞进 settings snapshot 后仅靠字段名脱敏。
- `project_id` 从 P0 起改为项目 manifest 的稳定 UUID，项目移动后仍可关联旧 run；canonical path 只作为可更新定位信息，重复 UUID 路径先隔离写入。
- commit journal 的 `RECOVERY_REQUIRED` 统一表示为 `paused + error_code`；v2 任何真实文件写入必须经 `CommitJournalService -> DocumentService`，只建表/CRUD 不算 Task F 完成。
- 认证计划补齐 runtime token 的生成、轮换、401/403、Host/Origin、packaged `file://`、preload/IPC 注入，以及 Electron CSP、导航、权限、IPC sender 和 terminal 高权限边界。
- 发布门禁按仓库现状重写：当前 tag workflow 不能证明 CI 阻断；P0 必须新增 Windows PR CI、nightly/RC、签名、真实安装/升级/卸载 smoke 和 tag 对同 commit RC 证据的不可绕过依赖。
- 增加持续评估轨道 G0，以任务完成率、可用初稿率、采用/丢弃、编辑保留、人工介入、完成时间、引用正确率和每成功任务成本衡量“更智能”，P7 只负责统一收口。
- 0.7.0 顺序调整为 `P4a token/语义分块 -> P3 时序化 canon -> P4b memory-aware 选择`；新增带剧情时间、有效区间、视角、项目 UUID 和来源版本的 `CanonClaim`。
- P5 增加 Artifact Policy Matrix 和“反馈聚合 -> 偏好候选 -> 用户确认 -> 版本化应用 -> 回归评估 -> 可撤销”的本地提升闭环，禁止把记录反馈直接称为学习。
- 增加阶段依赖/最小 UI/非目标矩阵；移除缺乏基础设施依据的固定人日和 100/500 beta run 承诺，以可复现退出证据驱动版本发布。
- 最终一致性复核补齐：step `running -> pending` 的唯一恢复事务和 attempt 计数、有限 JSON replay/长连接 NDJSON 双事件端点、P4a/P4b 独立 flags、稳定 project UUID 的具体模块归属、P0 outbound disclosure、可排序 NarrativeCoordinate、P5 feedback/preference 持久 schema，以及 G0 固定任务配额和 Holm-Bonferroni 判定协议。

审查期间的实现状态证据：

- P0 定向测试 118/118 通过，agent-runtime 与 desktop-shell typecheck 通过；
- Workbench typecheck 当前失败 7 处，`AgentTraceView.tsx` 尚缺 `RunControls`、operation ID 和状态格式化等符号，因此 Task E 仍为实现中；
- 当前恢复逻辑只把 stale run 设为 paused，未结算 running step/attempt，尚不能完成真实同 ID resume；
- commit journal、lease/fencing 和 Confirmation 目前主要停留在 store/route 基础，未贯通真实文件副作用；
- runtime 当前只有 Origin 基础校验，桌面会话令牌、Feature Flag registry、CI/RC/签名/installed smoke 尚未实现。

本轮文档提交边界：

- 只提交 `docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md` 和本维护文档；
- 保留工作区所有 P0 实现草稿，不回退、不混入本次文档提交；
- 未跟踪 `PRODUCT.md` 保留，不纳入提交。

本轮文档验证：

- Markdown 围栏共 96 个，为偶数；P0-P7、P4a/P4b、Task A-H 和新增小节编号检查通过；
- 旧 `agent_execution_v2`、`context_selector_v2`、固定 100/500 beta run 和模糊 `recovery_required` run 状态引用已清理；
- `git diff --check -- docs/AGENT_OPTIMIZATION_MODIFICATION_MANUAL.md docs/PROJECT_MAINTENANCE_HANDOFF.md` 通过；
- 本轮未重新运行完整代码测试，118/118 和 typecheck 结果来自三路审查中的当前工作树定向验证；Workbench 失败被保留为实施台账阻塞项，没有伪报绿色。

### 15.49 2026-07-10 P0 持久执行基础实现记录

本轮开始落实冻结的 P0 顺序，完成 E0 编译基线和 A-C/D 的一组可运行基础能力提交；这不是 P0 发布完成，也没有将任何 Task 标为“已验收”。

本轮实现：

- 修复 Workbench `AgentTraceView` 的运行控制、状态格式化和安全 operation ID，暂停、恢复、取消和重试按运行状态禁用；
- 新增项目 manifest 稳定 UUID，旧 manifest 首次读取会原子回填，移动项目后保留 UUID；每个 durable run 将该 UUID 写入 `project_id`，不再以路径哈希作为生产身份；
- 补齐 Agent Run/step/attempt schema、SQLite Execution Store、状态机、CAS/idempotency、runtime lease 和基础 lifecycle API/Trace UI 草稿；
- 显式 pause 将 attempt 结算为 `interrupted` 且 step 回到 `pending`，不消耗失败重试预算；stale lease 在同一 SQLite transaction 中结算 orphan running attempt、重置 step 后才允许同一 `run_id` 新 attempt；
- HTTP/renderer 连接关闭不再向 durable executor 传递 abort，只有 pause/cancel 控制 API 可改变 run；
- 新增真实子进程强杀 E2E：持有执行租约的子进程被终止，新进程接管同一 run，保留 interrupted attempt 并以第二个 attempt 完成。

本轮验证：

- `npm run typecheck` 通过，所有 workspace 均为绿色；
- `npm test` 通过：75 个测试文件、560 个测试；
- `npm run build:workbench` 通过，仅有既有 bundle size warning；
- `npm run build:desktop` 通过；
- `git diff --check` 通过。

尚未满足的 P0 退出条件：recoverable request 白名单、重复 project UUID 路径隔离、驱动 adapter/备份及迁移故障矩阵、两步恢复 fixture、`POST /api/agent/runs` 幂等创建、认证事件补流/E2E、真实文件 CommitJournal/Confirmation、长任务迁移，以及 H 的会话令牌与发布门禁。下一轮严格按 D 余项再进入 E；不得提前开始 P1。

本轮提交边界：提交 P0 shared/store/coordinator/runtime/route/API/Workbench/manifest 基础实现、测试与本维护记录；未跟踪 `PRODUCT.md` 保留且不纳入提交。

### 15.50 2026-07-10 P0 Durable Run API 核心记录

本轮在 15.49 的 durable execution 基础上补齐 E 的创建和有限回放 API 核心，仍不代表 Task E 或 P0 已验收。

本轮实现：

- `POST /api/agent/runs` 以 `request_id` 作为创建幂等键：首次返回 `201` 并后台启动 durable run；相同规范化请求返回原 run 与 `200`，不同请求摘要返回 `409 REQUEST_ID_REUSED`；
- API client 和 shared contract 同步公开创建接口，后台执行路径有运行时回归测试；
- 有限 `/events` replay 支持 `limit <= 1000`，返回 `next_sequence`、`has_more`、`earliest_available_sequence` 和 `gap_detected`，保留兼容字段 `next_after`；
- UI/后续订阅方可在 `gap_detected=true` 时回读 run detail，避免静默跳过已被保留策略清理的事件。

本轮定向验证：

- shared、API client、desktop shell 类型检查通过；
- shared schema、API client、runtime coordinator/runtime 和 desktop route 共 104 个相关测试通过；
- `git diff --check` 通过。

下一步：完成认证长连接 event stream、客户端 sequence 补流/详情校准和 E2E；在此之前 Task E 继续维持“实现中”。`PRODUCT.md` 继续不纳入提交。

### 15.51 2026-07-10 P0 隔离、存储可靠性与事件补流记录

本轮并行补强 A、B 和 E 的未验收实现，不代表 P0 或任一 Task 已验收。

本轮实现：

- 恢复请求改用 `AgentRecoverableRequest` 明确白名单，未知扩展字段和凭据类嵌套载荷不会进入 durable snapshot；
- desktop 在 userData 中持久记录项目 UUID 与 canonical path，同 UUID 的两个存活路径拒绝创建 runtime，旧路径消失时允许移动重关联；
- Execution Store 对既有数据库先以 query-only 只读方式探测；未来 schema 始终只读隔离。迁移前备份经临时文件、`quick_check` 与 schema 校验后原子发布，文件系统 seam 覆盖空间不足、复制损坏和锁失败；
- Workbench Trace 改为按 sequence 分页补流、按 `event_id` 去重，并在 retention gap 后重新读取权威 run detail，避免游标停滞或状态静默失真。

本轮验证：

- `npm run typecheck` 通过，所有 workspace 均为绿色；
- `npm test` 通过：77 个测试文件、579 个测试；
- `npm run build:workbench` 通过，仅有 bundle size warning；
- `npm run build:desktop` 通过；
- `git diff --check` 通过。

仍未满足的 P0 退出条件：C 的 feature-flag snapshot 与真实副作用幂等；D 的两步恢复和旧入口回归；E 的认证长连接及任务 UI E2E；F 的真实 CommitJournal/Confirmation 接线；G 的长任务检查点迁移；H 的会话令牌、Electron 安全与发布门禁。`PRODUCT.md` 继续保留且不纳入提交。

### 15.52 2026-07-10 P0 恢复、文件提交与 runtime 认证记录

本轮继续并行推进 D、F、H；所有 Task 仍为“实现中”，P0 不具备发布条件。

本轮实现：

- 强杀恢复 E2E 改为两步骤检查点：第一步保留唯一完成 attempt，重启后仅结算、恢复并完成第二步，`run_id` 不变；旧 `streamAgentRun` 入口也有 durable run 回归；
- 新增 `CommitJournalService`，通过 `DocumentService` 执行同卷临时文件、备份、原子替换、hash 校验和 write-lease fencing；未终结 journal 会依据磁盘内容与 base/new hash 对账；
- runtime 每次启动生成 32-byte 会话 token。health 以外请求同时受精确 Host、Origin 与恒定时间 Bearer 校验保护；受信 Electron IPC 代理剥离 renderer 提供的认证头并在主进程注入 token，Workbench 全部 API client 通过该代理请求；
- Electron 阻止不受信导航，测试覆盖认证缺失、错误 Host/Origin 和 health 放行。

本轮验证：

- `npm run typecheck` 通过，所有 workspace 均为绿色；
- `npm test` 通过：78 个测试文件、583 个测试；
- `npm run build:workbench` 和 `npm run build:desktop` 通过；
- `git diff --check` 通过。

关键未完成项：CommitJournalService 尚未由 AgentFileOperationRunner、Skill/workflow 或 durable RunCoordinator 调用，故不能宣称真实写入已不可绕过；未实现认证长连接 NDJSON 和任务 UI E2E；发布 CI/RC/签名/installed smoke、长任务迁移和 Confirmation 完整生命周期仍未完成。`PRODUCT.md` 继续保留且不纳入提交。

### 15.53 2026-07-10 P0 Durable 文件提交与认证事件流记录

本轮把 F 的一条 durable 文件写入路径和 E 的认证实时订阅接入现有代码，仍不代表 F、E 或 P0 已验收。

本轮实现：

- durable `runAgent` 与 `streamAgentRun` 的 direct-save、batch-replace 会传递 run/step/attempt 到 `CommitJournalService`；提交记录保存身份、fencing token、备份和最终状态，非 durable 调用仍保持原有 DocumentService 路径；
- `GET /api/agent/runs/{run_id}/events/stream?after=N` 在既有会话认证内提供 NDJSON 回放与增量补流，包含 retention gap、15 秒 heartbeat、背压处理、关闭清理和终态 `end`；断连不影响 run；
- API client 公开 `streamAgentRunEvents`，解析 event/heartbeat/gap/end，供 Workbench 后续替换轮询订阅。

本轮验证：

- `npm run typecheck` 通过，所有 workspace 均为绿色；
- `npm test` 通过：78 个测试文件、586 个测试；
- `npm run build:workbench` 和 `npm run build:desktop` 通过；
- `git diff --check` 通过。

仍未验收：Workbench 尚未消费实时 stream，任务控制 E2E 未完成；journal 尚未覆盖全部 Skill/workflow 写入，Confirmation 仍缺完整生命周期；G 的长任务检查点、H 的发布门禁和 C 的 flag/副作用幂等仍未完成。`PRODUCT.md` 继续保留且不纳入提交。

### 15.54 2026-07-10 P0 Workbench 实时事件订阅记录

本轮完成 E 的 Workbench 消费层，Task E 仍处于“实现中”。

- Agent Trace 在分页回放后调用认证 API client 的实时订阅；按 `event_id` 去重并推进 sequence；
- retention gap 时重新读取权威 run detail；刷新、切换 run 或卸载时中止对应 `AbortController`，避免遗留连接；
- `agentRunEvents` 覆盖流状态辅助测试，Workbench typecheck 和生产构建通过。

未完成项：任务列表/详情/暂停恢复控制的端到端用例仍未建立。`PRODUCT.md` 继续保留且不纳入提交。

### 15.55 2026-07-10 P0 Feature Flag Snapshot 记录

本轮完成 C 的最小可执行 registry 与 run snapshot，Task C 仍为“实现中”。

- 新增版本化的 P0 feature flag 定义与 metadata；`agent_execution_v2_mode` 支持 `off/shadow/on`，其他路线 flag 默认 fail-closed；
- registry 在依赖不满足时归一化到安全组合，RunCoordinator 只在创建时读取一次并固化到 `goal.request_snapshot.feature_flag_snapshot`；
- shared schema 对 v1 snapshot 严格校验，同时把既有空对象视为 legacy 默认值，避免旧 run 数据失效；
- 测试证明运行创建后的 registry 变更不会改变原有 run snapshot。

仍未验收：受控的 desktop 持久覆盖与 safe-mode、shadow 对照报告、真实副作用幂等和完整发布门禁尚未完成。`PRODUCT.md` 继续保留且不纳入提交。

### 15.56 2026-07-10 P0 Confirmation、Batch Checkpoint 与发布门禁记录

- Confirmation 支持等待、批准后显式 resume、拒绝/过期失败、取消 supersede 和幂等决议；
- batch_generate 将已完成章节写为 durable event checkpoint，同一 run 重启跳过已完成单元；
- 增加 Windows PR CI、RC evidence 和 tag provenance gate，签名/安装 smoke 脚本 fail-closed；真实 GitHub environment、证书和 Windows runner 证据仍待配置后运行。

本轮根级验证：`npm run typecheck`、`npm test`（79 files/596 tests）、`npm run build:desktop` 和 `git diff --check` 通过。P0 仍未验收；`PRODUCT.md` 未纳入提交。

### 15.57 2026-07-10 P0 拆书恢复、legacy 映射与 Confirmation UI 记录

- `disassemble_book` 为 book、lore、reverse_outline 持久单元写入 checkpoint；SQLite reopen 后复用 manifest 并仅重跑未完成单元；
- 旧 JobManager 通过 `legacy-job:` 只读、不可恢复投影公开，拒绝将 legacy job 当作 Agent Run 控制；
- Agent Trace 可展示 pending Confirmation 并执行 approve/reject；批准后保持 paused，必须显式 resume；路由、client、UI 都有回归覆盖。

本轮根级验证：`npm run typecheck`、`npm test`（82 files/605 tests）、`npm run build:workbench`、`npm run build:desktop` 和 `git diff --check` 通过。P0 仍未验收；`PRODUCT.md` 未纳入提交。

### 15.58 2026-07-10 P0 Batch 强杀恢复与 Electron 安全记录

- batch checkpoint 在真实 child-process `SIGKILL` 后接管同一 run，只运行 N+1，测试精确断言前一单元没有重复模型或写入副作用；
- terminal session 绑定创建 renderer，跨 renderer 的写入被拒绝、resize/kill 无效，输出仅投递所有者，窗口关闭会清理其 session；
- Electron 默认拒绝 permission、webview 与不受信导航，外部窗口只允许受控 http(s) 链接。

本轮根级验证：`npm run typecheck`、`npm test`（84 files/612 tests）、`npm run build:workbench`、`npm run build:desktop` 和 `git diff --check` 通过。P0 仍未验收；`PRODUCT.md` 未纳入提交。

### 15.59 2026-07-10 P0 认证 Browser E2E 记录

- E2E runtime 仅在 `XIAOSHUO_E2E_RUNTIME=1` 下接受固定测试 session token，生产启动继续轮换随机 token；
- E2E state 目录每次启动清理，并显式允许 preview Origin，避免继承项目身份与 CORS 状态；
- Playwright 通过认证 runtime API 建立隔离项目/run，从 Workbench `状态 -> 运行` 进入 Agent Trace，验证列表、详情和 pause 后的持久 `run.pause_requested` 事件。

验证：`npx playwright test tests/e2e/project-entry.spec.ts --reporter=line` 通过（1 passed）；同时 `npm run typecheck`、`npm test`（84 files/612 tests）、Workbench/desktop 构建和 `git diff --check` 通过。`PRODUCT.md` 未纳入提交。

### 15.60 2026-07-10 P0 Flag、审计生命周期与拆书 Journal 记录

- feature flag 仅在 desktop 主进程按 allowlist 原子持久化；`--safe-agent` 不改写用户配置，强制关闭 v2 执行并禁用 stale-run 自动恢复；
- durable run API 支持项目作用域的完整 audit export 与终态受控删除，删除不会删除用户文档或 cache；
- 拆书 durable 输出逐项走 CommitJournalService，测试核对最终文件、journal target path 和 `new_hash`。

本轮根级验证：`npm run typecheck`、`npm test`（85 files/622 tests）、`npm run build:workbench`、`npm run build:desktop` 和 `git diff --check` 通过。P0 仍未验收；`PRODUCT.md` 未纳入提交。

### 15.61 2026-07-10 P0 Confirmation Browser E2E 与 Schema 契约记录

- 修复 Execution Store 将 SQLite 空字符串泄露为 `resolved_at`/`resolved_by` 的契约错误；未解决的 Confirmation 现在省略这两个可选字段，符合 shared schema；
- Playwright 在认证隔离 runtime 中创建真实确认写入 run，覆盖 pending 展示、批准后保持 paused、显式恢复至 completed，以及拒绝至 failed；
- 这补齐了 Confirmation 的浏览器生命周期回归，但 E 仍缺异常/恢复矩阵，F 仍缺旧 execute、Skill 与 workflow 的统一 CommitJournal 覆盖，P0 仍未验收。

本轮验证：`npm run typecheck`、`npm test`（85 files/622 tests）、`npm run build:workbench`、`npm run build:desktop`、`npx playwright test tests/e2e/project-entry.spec.ts --reporter=line --workers=1`（3 passed）和 `git diff --check` 通过。`PRODUCT.md` 未纳入提交。

### 15.62 2026-07-10 P0 旧 Raw Execute 端点退役记录

- `POST /api/agent/execute` 曾直接调用 `DocumentService.executeOperations`，绕过 durable run、Confirmation 与 CommitJournal；现固定返回 `410 AGENT_EXECUTE_RETIRED`，且不再读取请求体或打开项目；
- 移除 API client 中未被仓内调用的 `executeOperations` 暴露，并清理该旧端点专用的 runtime 依赖；
- 不把 raw operations 临时路由至 `runAgent`：当前普通文件操作计划仍需单独完成“先 Confirmation、后 journal 提交”以及 move/archive 协议，不能伪装为迁移完成。

定向验证：`npx vitest run apps/desktop-shell/src/main/runtime/agent-routes.test.ts apps/desktop-shell/src/main/runtime/license-guarded-routes.test.ts`（2 files/20 tests）、`npm run typecheck -w @xiaoshuo/api-client`、`npm run typecheck -w @xiaoshuo/desktop-shell` 和 `git diff --check` 通过。P0-F 与 P0 均仍为实现中；`PRODUCT.md` 未纳入提交。

### 15.63 2026-07-10 P0 正文生成 CommitJournal 接线记录

- GeneratedCacheService 新增只准备、校验和合成目标文本的接口；持久调用者可以在不触碰目标文件的情况下取得稳定写入清单，缓存只在所有写入成功后标记 committed；
- `body_generate` 在 durable execution 中将正文缓存提交经 CommitJournalService 写入；修正日志和章节交接摘要同样改为 journal 追加，保留非 durable `runSkill` 的旧兼容路径；
- 回归测试断言正文和交接摘要均存在 finalized journal 记录，且缓存 prepare 本身不创建目标文件。

定向验证：`npx vitest run packages/generated-cache/src/service.test.ts packages/agent-runtime/src/runtime.test.ts`（2 files/77 tests）、`npm run typecheck -w @xiaoshuo/generated-cache`、`npm run typecheck -w @xiaoshuo/agent-runtime` 和 `git diff --check` 通过。仍未覆盖聊天、Prompt Skill、HTTP 延后缓存提交和普通文件操作计划；P0-F 与 P0 均仍为实现中，`PRODUCT.md` 未纳入提交。

### 15.64 2026-07-10 P0 GeneratedCache Synthetic Durable Commit 记录

- `AgentRuntimeService.commitGeneratedCache()` 统一承接普通 cache/save-plan 与无 cache 的直接草稿保存；HTTP 延后保存会创建 `agent.generated_cache_commit` synthetic durable run，以 cache 内容和规范化提交意图派生稳定 request id，并逐目标调用 `CommitJournalService`；
- 无 cache 的 raw draft 先映射为确定性 32-hex GeneratedCache，同一请求重放不会创建第二个 run、第二份 cache 或重复 append；已有 durable execution 也可复用同一提交器，供后续 chat/Prompt Skill 迁移；
- synthetic run、request 与 journal id 会写回 cache 元数据，已 committed cache 的重复保存仍可返回原审计关联；跨 `/generated/save` 与兼容 commit 入口的 transport source/skill 不参与提交身份，失败后会恢复同一 run；
- `GeneratedCacheService` 的普通 target prepare 改为稳定路径顺序和路径级 action key；save-plan segment 保留输入顺序和 index key，但同一目标的多段 append 会以上一段 staged content 继续合成。committed 元数据先原子落盘，再 best-effort 清理正文，避免先删正文后崩溃造成 pending cache 不可恢复；
- CommitJournal 重放现在区分“新内容已落盘”和“磁盘仍是旧内容”：前者复用 finalized journal，后者保留原恢复记录并用当前 attempt 补写，解决多目标第二项在替换前失败后无法继续的问题；
- `/api/agent/generated/save` 的普通 cache、save-plan 和 raw content 分支，以及 `/api/agent/generated/cache/{id}/commit` 的普通分支已改走 runtime；style/genre/lore 特殊分段保存仍是下一板块，未宣称整条路由完成。

恢复与回滚：本轮没有新增 SQLite schema。失败时 cache 保持 pending，已完成 target journal 可在同 run retry 中重放；run 已完成但 cache 元数据未收口时，下一次相同请求从 observation 补齐 committed 状态。代码回滚不得删除已有 run、journal 或 deterministic cache，旧版本仍可读取目标文档和 cache 元数据。

本轮验证：

- 定向：`npx vitest run packages/generated-cache/src/service.test.ts packages/agent-runtime/src/runtime.test.ts packages/agent-runtime/src/kernel/commit-journal-service.test.ts apps/desktop-shell/src/main/runtime/generated-cache-routes.test.ts packages/shared/src/schemas/agent.test.ts --reporter=dot`，5 files / 111 tests；
- 根级：`npm run typecheck`、`npm test`（85 files / 636 tests）、`npm run build:desktop`、`npm run build:workbench` 和 `git diff --check` 通过；Workbench 只有既有的 >500 kB chunk warning；
- P0-F 与 P0 继续为“实现中”；`PRODUCT.md` 未修改、未纳入提交。

### 15.65 2026-07-10 P0 Style/Genre/Lore 分段 GeneratedCache Journal 记录

- 新增无文件副作用的 sectioned generated-save planner，统一承接 `style_extract`、`genre_generate`、`lore_extract` 的标题别名、legacy fenced 文件块、固定目标顺序、style/genre 首目标 fallback、Lore 关键词分类与空占位过滤；`PromptSkillRunner` 的兼容 writer facade 复用同一解析结果，避免两套规则漂移；
- `/api/agent/generated/save` 与 `/api/agent/generated/cache/{id}/commit` 不再实例化 `PromptSkillRunner` 直写特殊分段文件，统一委托 `AgentRuntimeService.commitGeneratedCache()`；特殊缓存只按 metadata `skill_id` 决定 handler，body 技能不一致返回 `409 GENERATED_CACHE_SKILL_MISMATCH`，空 metadata 不能被提升为特殊技能；
- runtime 为每个实际 section 生成固定目标、稳定 action key 和服务端派生的 timeline source/summary；客户端 `target_paths`、`save_plan` 及 passthrough 字段不能改写特殊目标或伪造 journal 审计元数据。Lore 的 HTTP replace 继续保持原有覆盖语义，Prompt Skill 自动保存的 merge-existing 兼容语义未被改动；
- section append 继续使用 `existing.trimEnd() + "\n\n---\n" + content + "\n"`；多文件中途失败保持 cache pending，并在同一 run 新 attempt 恢复，已经 finalized 的 section 不重复追加。普通 save-plan 对同一目标的多个 segment 现在先合成为一个最终 replacement，只生成一次原子 journal 写入，封住“首段成功、后段崩溃、重试重复首段”的恢复漏洞；
- 无 cache 的特殊 raw 内容仍使用确定性 32-hex cache；若 Lore 等解析后没有实际目标，cache 会立即进入 discarded 并删除正文，不留下调用方无法寻址的 pending 项。调用未显式给 mode 时，特殊缓存沿用 metadata/save-plan mode；
- 本板块没有新增 SQLite schema。回滚代码不得删除已有 cache、run 或 journal；失败重试仍以 cache 内容、规范化 section plan 和原 run journal 为恢复依据。

本轮验证：

- 定向：`npx vitest run packages/agent-runtime/src/sectioned-generated-save.test.ts packages/agent-runtime/src/skill-runner.test.ts packages/agent-runtime/src/runtime.test.ts packages/generated-cache/src/service.test.ts apps/desktop-shell/src/main/runtime/generated-cache-routes.test.ts packages/shared/src/schemas/agent.test.ts --reporter=dot`，6 files / 135 tests；
- 根级：`npm run typecheck`、`npm test`（86 files / 650 tests）、`npm run build:desktop`、`npm run build:workbench` 和 `git diff --check` 通过；Workbench 只有既有的 >500 kB chunk warning；
- P0-F 与 P0 继续为“实现中”；Prompt Skill 自动提交、chat 写回、普通文件操作计划和 card draw 仍是未完成旁路；`PRODUCT.md` 未修改、未纳入提交。

### 15.66 2026-07-10 P0 Prompt Skill Durable Commit 记录

- PromptSkillRunner 在 durable 调用中只生成稳定 cache、保存计划和 deferred commit 描述；runtime 承担目标文件副作用，单独拥有 CommitJournal 写入和 cache `markCommitted`，避免分段 writer 或普通 save plan 再次直写、重复收口；
- `runAgent`、`streamAgentRun` 的本地 Prompt Skill 路径传递同一 durable execution；`/api/skills/:id/run` 对 writable 或显式 `write_result` 的 prompt skill 调用 `runDurableSkill`，运行时不可用时以 `503 DURABLE_SKILL_RUNTIME_UNAVAILABLE` fail-closed；
- durable 直接运行以 request id 重放结果，最终 SkillRunResponse 写入 observation；同请求不会再次调用模型或重复文件副作用。style/genre 保留固定分段目标；Lore replace 的 merge-existing 在 journal 前合成最终内容，保留已有条目并合并新信息；
- 本板块没有新增 SQLite schema。回滚代码不得删除 durable run、journal 或 pending cache；旧二进制只能继续读取现有 cache/目标文档，不能对已创建 durable run 重新走直写路径。

本轮验证：`npm run typecheck`、`npm test`（86 files / 663 tests）、`npm run build:workbench`、`npm run build:desktop`、`npx vitest run packages/agent-runtime/src/runtime.test.ts packages/agent-runtime/src/skill-runner.test.ts packages/agent-runtime/src/sectioned-generated-save.test.ts apps/desktop-shell/src/main/runtime/skill-routes.test.ts --reporter=dot`（4 files / 112 tests）和 `git diff --check` 通过；后续补充的 `runtime.test.ts` 流式 outer-run 回归也通过（82 tests）。Workbench 只有既有的 >500 kB chunk warning。P0-F 与 P0 继续为“实现中”；普通文件操作计划、chat 写回和 card draw 仍未统一 journal/confirmation；`PRODUCT.md` 未纳入提交。

### 15.67 2026-07-10 P0 Stale Run 同 ID 自动恢复记录

- 复核并确认 `AgentTraceView.tsx` 已在既有 P0 提交中修复；全仓 Workbench 类型检查再次通过，本板块没有重复修改该 UI 文件；
- `AgentRuntimeService` 启动时不再止于 stale claim 的 `paused` 状态：可安全重放的请求会使用稳定恢复 operation 创建新 attempt，并沿用原 `run_id`、请求快照和事件时间线执行；
- 增加真实 SQLite 交接回归：旧 runtime 的 chat attempt 被视为租约过期后，新 runtime 自动完成同一 `run_id`，历史 attempt 标为 `interrupted`，新 attempt 为 `done`；
- 普通 `file_operation` 计划在 CommitJournal 尚未覆盖前保持 fail-closed：接管后仍为 `paused`，并写入 `run.recovery_deferred(FILE_OPERATION_JOURNAL_REQUIRED)`，不在应用启动时重放可能绕过 journal 的文件副作用。

本轮定向验证：`npx vitest run packages/agent-runtime/src/runtime.test.ts packages/agent-runtime/src/kernel/run-coordinator.test.ts packages/agent-runtime/src/kernel/run-recovery.e2e.test.ts --reporter=dot`（3 files / 100 tests）、`npm run typecheck -w @xiaoshuo/agent-runtime` 和 `git diff --check` 通过。最终根级验证：`npm run typecheck`、`npm test`（86 files / 668 tests）通过。`PRODUCT.md` 未修改、未纳入提交；chat generated-save 的并发工作保持未暂存，未混入本提交。

### 15.68 2026-07-10 P0 Chat Generated Save Durable Commit 记录

- `chat/read_context` 的自动保存不再通过 `GeneratedCacheService.commitSavePlan()` 直接写目标文件；durable run 会用 `run_id + step_id + chat_auto_save` 派生确定性 cache，并通过当前 outer run 的 `commitGeneratedCache()` 写入 CommitJournal；
- 同步与流式 chat 共享同一提交协议：模型回复先进入 pending cache，目标写入 journal finalized 后，outer run observation 完成，再统一把 cache 标记为 committed 并清理正文；
- 覆盖 journal finalized 后、outer run complete 前崩溃的恢复窗口：同一 `run_id` resume 时优先读取 pending cache 复原最终回复，不重新调用模型，也不会重复写入目标文件；
- 覆盖 outer run completed 后、cache metadata 收口失败的恢复窗口：重复同 `request_id` 或 completed-run 对账会从 observation 重放 finalizer，只补 `committed`/cleanup，不重新调用模型；
- 本板块没有新增 SQLite schema。回滚代码不得删除已有 durable run、journal 或 deterministic cache；失败恢复仍以 cache 正文、保存计划和原 run journal 为依据；
- 本板块只收口 chat/read_context 自动保存；显式会话 `write_target` 写回、普通 `file_operation` plan 和 card draw 写入仍是 P0-F 的剩余旁路，P0 继续为“实现中”。`PRODUCT.md` 未修改、未纳入提交。

本轮定向验证：`npm run typecheck -w @xiaoshuo/agent-runtime`、`npx vitest run packages/agent-runtime/src/runtime.test.ts`（87 tests）和 `git diff --check` 通过。根级验证：`npm run typecheck`、`npm test`（86 files / 671 tests）、`npm run build:desktop`、`npm run build:workbench` 和 `git diff --check` 通过；Workbench 只有既有的 >500 kB chunk warning。

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
