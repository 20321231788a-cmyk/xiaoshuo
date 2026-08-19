# ArcWriter 项目维护交接

> 更新：2026-08-19
>
> 保留版本基线：`0.4.0`、`1.4.3`
> 当前版本：`1.4.6`（免费、小范围正式发布）

## 当前状态

ArcWriter 是面向小说创作的 TypeScript/Electron 桌面应用。`main` 以历史基线和小范围正式发布节点维护：

1. `v0.4.0`：历史基线；
2. `v1.4.3`：维护与发布基线；
3. `v1.4.5`：对话与技能工作流维护版本；
4. `v1.4.6`：当前维护版本。

不要依赖已清理版本的提交号、安装包或发布说明；新的小范围正式发布会在上述基线上增加对应的版本节点。

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

- 所有 AI 主要生成内容（大纲、细纲、章纲、正文、风格题材与批量续写）先保存至项目内部缓存 Markdown，完成后必须确认才写入项目；“保存、写入、落盘”只用于识别目标和写入模式。
- 已启用自动提取设定时，用户确认保存大纲、细纲、章纲后校验并直接合并写入资料库；正文仅保存一句话章节总结。
- 所有文件操作都限定在当前项目内并校验真实路径；创建、追加、局部修改与设定合并直接执行，整文件覆盖和移入 `99_回收站` 才需要确认。
- 拆书默认仅分析前 100 个识别章节（不足 100 章则全部；序章、番外等明确标题计入；无章节标题则按顺序段）。最多 4 批并行、每批约 1.6 万有效字符、失败只快速重试一次，并直接生成一份四板块《拆书报告.md》。
- AI 文件规划会兼容不适用字段的 `null`；拆书批次使用专用 JSON 提示词，不得复用设定提取模板。
- 会话使用可恢复的消息部件保存正文、推理和执行步骤；附件支持选择、拖放、粘贴并实际进入本轮上下文。
- 技能编排由模型从受限技能目录中选择，旧规则仅作为确定性回退，不再用只读参考文件确认卡阻断对话。

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

## 1.4.6 维护记录

- 对话运行按会话、运行编号和任务类型隔离；普通停止、拆书取消与批量续写取消互不影响，生成中断从缓存断点续跑并去重；
- AI 主要生成内容统一先写入 `.agent/generated_cache/<cache_id>/content.md`，以同一份缓存完成预览、确认与提交；
- 自动提取设定在大纲、细纲、章纲确认保存后直接原子合并，正文只记录一句话章节总结；
- 拆书更新为前 100 章极速流程：四板块单报告、最多 4 批并行、检查点续跑及程序化合并，不再触发旧的多轮归并与反向细纲；
- 完成全量自动测试、重点工作流测试、类型检查及桌面构建验证。

## 历史整理记录

- Git 历史曾压缩为 `0.4.0` 与 `1.4.3` 两个版本节点；
- 后续按默认小范围正式发布流程增加版本标签与 Release；
- 旧版发布说明已移除，保留当前 `v1.4.3` 与历史基线 `v0.4.0` 的说明；
- 小范围正式发布改为默认标签发布流程。
