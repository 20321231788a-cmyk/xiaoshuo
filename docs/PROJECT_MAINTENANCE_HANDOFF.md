# ArcWriter 项目维护交接

> 更新：2026-08-11
>
> 保留版本基线：`0.4.0`、`1.4.3`
> 当前版本：`1.4.3`（免费、小范围正式发布）

## 当前状态

ArcWriter 是面向小说创作的 TypeScript/Electron 桌面应用。`main` 已压缩为两个版本快照：

1. `v0.4.0`：历史基线；
2. `v1.4.3`：当前维护与发布基线。

除以上两个版本外，不保留历史标签、GitHub Release 或中间提交。不要依赖已清理版本的提交号、安装包或发布说明。

## 快速开始

```powershell
cd D:\xiaoshuo\ts-migration
npm install
npm run dev:desktop
```

常用命令：

| 目的 | 命令 |
| --- | --- |
| 启动工作台 | `npm run dev:workbench` |
| 启动桌面端 | `npm run dev:desktop` |
| 安全模式 | `npm run dev:desktop -- --safe-agent` |
| 发布前完整验收 | `npm run acceptance:preview` |
| 构建 Windows 安装包 | `npm run dist -w @xiaoshuo/desktop-shell` |

## 主要入口

| 范围 | 路径 |
| --- | --- |
| Electron 主进程、preload、runtime | `apps/desktop-shell/src/` |
| React 工作台 | `apps/workbench/src/` |
| 共用类型与 IPC schema | `packages/shared/src/` |
| AI 编排、会话、拆书与技能 | `packages/agent-runtime/src/` |
| 项目文件、时间线与回收站 | `packages/document-service/src/` |
| 生成缓存与确认链路 | `packages/generated-cache/src/` |
| 发布工作流 | `.github/workflows/release-small-scale.yml` |

持久化项目数据位于 `00_设定集/.agent/`；本机 AI 配置位于 `studio_config.json`。不得提交配置、`.env*`、构建产物、安装包、日志、截图或临时项目。

## 当前功能口径

- 未明确要求“保存、写入、落盘”时，AI 生成内容必须先进入持久化预览确认；“覆盖、替换”只表示写入模式。
- 已启用自动提取设定时，大纲、细纲、章纲保存后校验并直接合并写入资料库；正文仅保存一句话章节总结。
- 删除始终移入项目 `99_回收站`；即使启用直写权限，也不得绕过路径、版本、哈希或内容校验。
- 拆书默认分析前 20 万有效字符（含跨界完整章节），按约 1 万字批次检查点和分层归并续跑；前台断开不等于后台失败。
- AI 文件规划会兼容不适用字段的 `null`；拆书批次使用专用 JSON 提示词，不得复用设定提取模板。

## 默认发布流程

小范围正式发布是默认流程。每个匹配应用版本的带注释 `vX.Y.Z` 标签都会触发 `.github/workflows/release-small-scale.yml`：

1. 确认标签是带注释标签，且标签、`apps/desktop-shell/package.json` 和锁文件版本一致；
2. 运行 `npm run acceptance:preview`；
3. 构建 Windows 安装包；
4. 仅上传 `ArcWriter-Setup-<version>.exe`、对应 `.blockmap` 和 `latest.yml`；
5. 创建非预发布 GitHub Release，并核对附件名称、大小与 SHA-256。

发布前必须先运行完整验收、提交干净工作区并推送 `main`，再创建并推送标签。每份 Release 都必须说明：仅供小规模使用、安装包可能未签名、不构成商业稳定性承诺。严格 RC、签名与商业级证据可作为额外质量工作执行，但不再是默认发布前置条件。

## 维护纪律

提交前执行：

```powershell
git status --short
git diff --check
```

不要使用 `git add .`、`reset --hard` 或 `clean`；不要覆盖用户本地项目。发布完成后核对远端 `main`、标签目标、Release 状态及三个附件的 SHA-256。

## 本次整理记录

- Git 历史压缩为 `0.4.0` 与 `1.4.3` 两个版本节点；
- GitHub 仅保留这两个标签与 Release；
- 旧版发布说明已移除，保留当前 `v1.4.3` 与历史基线 `v0.4.0` 的说明；
- 小范围正式发布改为默认标签发布流程。
