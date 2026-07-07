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
