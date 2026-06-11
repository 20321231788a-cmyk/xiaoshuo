# Phased Migration Plan

> Note
>
> This document preserves the original staged migration path as a historical record.
> Phases 0-4 describe the migration checkpoints that were true when those phases were active.
> The current live state is that the desktop app has already entered a pure TypeScript runtime
> endgame, with Python runtime spawning and proxy fallback removed from the active Electron path.

## Phase 0: Isolated Workspace

Goal: create a migration workspace that does not affect the current working app.

Deliverables:

- `ts-migration` folder
- workspace `package.json`
- shared schema package
- Electron shell scaffold
- migration docs

Exit criteria:

- Existing Python launcher still works
- Migration code can be typechecked independently after dependencies are installed

## Phase 1: Shared Contracts

Goal: define runtime-safe TypeScript contracts for the current FastAPI backend.

Deliverables:

- zod schemas for health, config, project, document, job, conversation, and skill data
- typed endpoint map for the existing `/api/*` surface
- tests for schema compatibility using representative payloads

Exit criteria:

- Frontend API responses can be validated in TypeScript
- New UI modules can import shared types instead of redefining them locally

## Phase 2: Electron Shell

Goal: replace the Python browser launcher with an Electron desktop shell while keeping Python FastAPI during the transition window.

Deliverables:

- Electron main process
- preload bridge
- backend process manager
- context menu/download integration
- optional Sentry setup

Exit criteria:

- Electron starts the Python backend
- Electron opens the current UI
- Backend shutdown is handled cleanly

## Phase 3: Local State in SQLite

Goal: move app-local state to SQLite without touching project manuscript files.

First migration targets:

- recent projects
- app settings
- task history
- conversation index
- generated cache metadata

Current slice:

- recent projects are recorded in desktop local SQLite
- current project conversation summaries and job summaries are mirrored as rebuildable local snapshots
- lightweight workbench preferences, including the last active tab and project-entry drafts, are stored in desktop local SQLite
- generated-cache metadata was first tracked locally as pending, saved, or discarded before the cache body and file writes were also migrated to TS
- Python FastAPI originally remained the source of truth for project files and live workflow state during this phase, but that responsibility has since moved into the local TS runtime

Exit criteria:

- `better-sqlite3` database owns local operational state
- file-based project content remains compatible with the current app

## Phase 4: Terminal and Task Console

Goal: add a local terminal and task/log console.

Deliverables:

- `node-pty` process manager in Electron main
- `@xterm/xterm` renderer component
- terminal resize via `@xterm/addon-fit`
- stream protocol over IPC or WebSocket

Exit criteria:

- Users can run local project commands inside the desktop app
- AI/task logs stream into a visible console

## Phase 5: Backend Module Migration

Goal: gradually replace Python services with TypeScript services.

Current slice:

- config service parity layer exists in `packages/config-service`
- TS tests cover public config defaults, alias save behavior, primary/secondary model config, and embedding config fallback
- project session parity layer exists in `packages/project-session`
- TS tests cover current-project restore, open/create parity, unique child-folder creation, and rename persistence
- job manager parity layer exists in `packages/job-service`
- TS tests cover queued/running/done/failed/cancelled states, progress clamping, missing-job errors, and latest-50 listing
- conversation service parity layer exists in `packages/conversation-service`
- TS tests cover list/create/load repair, append validation, rename truncation, pinned context document/text handling, context removal, and deterministic summary generation
- project manifest parity layer exists in `packages/project-manifest`
- TS tests cover manifest rebuild, `.agent` filtering, tree/subtree generation, library card summaries, and project chrome snapshot composition
- document service parity layer exists in `packages/document-service`
- TS tests cover safe document reads, direct saves with stale-base conflict protection, archive (single and batch), batch file operations (create/append/replace/move/archive), timeline list/delete/rollback behavior, ledger toggles, revision-log parsing and clearing, legacy outline alias normalization, blocked suffix checks, and missing-file errors
- generated cache service parity layer exists in `packages/generated-cache`
- TS tests cover cache creation with empty metadata, text appending, atomic writing replacements, file committing (in append/replace modes) with path validation, discard deletions, error marking, and custom time-based expiry cleanups
- skill catalog parity layer exists in `packages/skill-service`
- TS tests cover built-in skill listing, local/imported skill persistence, uploaded markdown/zip parsing, draft import normalization, broken imported-skill entry tolerance, and imported directory resolution
- model client parity layer exists in `packages/model-client`
- TS tests cover OpenAI-compatible SSE delta parsing, non-stream fallback, and gateway/limit style error normalization
- agent runtime parity layer exists in `packages/agent-runtime`
- TS tests cover local rename planning, missing-model plan fallback, AI-plan operation normalization for fixed document targets, local prompt-skill execution, generated-cache pending save flow, direct write_result writes, and attachment-backed skill input
- Electron starts a TypeScript runtime gateway at `127.0.0.1:18453`
- `/api/config` is served by `packages/config-service`
- `/api/projects/current`, `/api/projects/open`, `/api/projects/create`, and project rename are served by `packages/project-session`
- `/api/documents` list, `/api/project/tree`, `/api/project/tree/subtree`, `/api/project/manifest/status`, `/api/libraries`, and `/api/project/chrome` readonly data are served by `packages/project-manifest`
- `GET /api/documents/{rel_path}`, `PUT /api/documents/{rel_path}`, `DELETE /api/documents/{rel_path}` (archive), `/api/timeline*`, `/api/ledger*`, and `/api/revision-log` are served by `packages/document-service`
- Workbench editor now sends document save base timestamps, blocks stale saves with a 409 conflict path, exposes recent timeline entries, and supports user-confirmed timeline rollback from the editor.
- Workbench overview now surfaces recent AI revision-log entries with target paths, scores, risks, excerpts, document-open actions, and a user-confirmed clear-log action.
- Workbench overview now exposes the ledger as an actionable panel, including adding new foreshadowing notes, marking open items as recovered, and reopening recently closed items.
- Workbench conversations now expose conversation organization controls: inline title editing, deterministic/model-backed summary refresh, pinned context listing, pin-current-document, pin-text, and per-item pinned-context removal.
- Workbench project status now includes a vector recall debug panel, backed by typed `/api/vector/search`, so users can inspect recalled paths, source types, scores, and excerpts from the current index.
- Workbench overview now includes a generated-result inbox for pending local generated caches, with restore-to-save-panel, open-target, and discard actions after refresh/restart.
- Workbench overview generated-result inbox now reports the true pending-cache count, keeps the first six compact by default, and exposes a show-all/collapse control so hidden cached outputs remain recoverable.
- Workbench pending generated-cache counts now use a shared current-project filter across the overview runtime summary, generated-result inbox, and next-action recommendations, while still treating legacy caches without `project_path` as visible for recovery.
- Workbench pending generated-result panels now support copying full generated content and saving to `00_设定集/AI生成草稿/` as a draft so users can preserve output without changing the original target document; discard actions now require a second confirmation, and a global pending-generated banner keeps save/copy/draft/discard actions visible across tabs.
- Workbench operations now renders job results as actionable result-file cards, with open-file, copy-path, continue-in-conversation actions, user-facing result summaries, falsey-result handling, and truncated raw JSON behind a details fallback.
- Workbench 概览页现在会在运行时概况和最新快照中展示联网素材搜索状态，并在自定义联网搜索已开启但缺少 Base URL 时给出下一步配置提醒。
- `POST /api/agent/execute` with all five operations (create_file, append_text, replace_text, move_file, archive_file) is served by `packages/document-service`
- non-AI conversation file CRUD, attachment uploading (txt/md/docx/pdf), extraction, deletion, and local summary routes are served by `packages/conversation-service`
- `/api/agent/generated/save`, `GET /api/agent/generated/cache/{cache_id}`, `/api/agent/generated/cache/{cache_id}/commit` (for normal skills), `/api/agent/generated/cache/{cache_id}` (DELETE), and `/api/agent/generated/cache/cleanup` are served by `packages/generated-cache`
- `/api/skills`, `/api/skills/{skill_id}`, `/api/skills/import`, `/api/skills/upload`, `/api/skills/import-draft`, and `/api/skills/open-folder` are served by `packages/skill-service`
- `POST /api/agent/plan`，包含本地 workflow 与 prompt 技能在内的统一 `POST /api/skills/{skill_id}/run` 直调接口（已将 `disassemble_book`、`continue_disassemble`、`scan_pits`、`consistency_check`、`body_generate`、`batch_generate` 从 Python 代理切至本地 TS 运行）、本地 `chat/read_context` 与最小 `file_operation` 分支，以及会话消息生成 `/api/conversations/{id}/messages`，已完全由 TS 接管。此外，正文生成与批量正文生成已经完成深水区完整对齐，支持了自审评分回炉（Auto Revision）、日志写盘及物理缓存落盘，使写作大主线平稳运转在 TS 侧。网络抓取与自动拆书工作流 (`crawl_disassemble` 和遗留任务)、多候选抽卡生成 (`card_draw_generate`)、URL 起草技能 (`POST /api/skills/draft-from-url`) 以及抽卡挑选与物理归档 (`POST /api/card-draw/{draw_id}/select`) 也已完全由 TS 本地运行时承接，移除了相应的 Python 代理。
- `/api/vector/status`, `/api/vector/rebuild`, `/api/vector/process-pending`, `/api/vector/search` 均已由 TS 的 `vector-service` 承接，本地已接管 `reindex`、`vector_reindex` 与 `vector_incremental` 后台任务，并在会话中支持基于向量混合检索的长期记忆召回。
- `packages/config-service` 与 Workbench 配置页已新增“联网素材搜索”开关、provider/API key/Base URL、结果数、超时和上下文字数配置；`packages/agent-runtime` 在本地聊天、会话消息、正文生成、批量正文生成和正文抽卡候选 prompt 中按需注入联网小说素材摘要，默认关闭，且只在用户明确要求联网/搜索/查资料/找素材时触发。
- 会话消息和写作 workflow 现在会把已使用的联网来源以安全白名单结构 `web_search_sources: [{ title, url }]` 暴露在 final payload、skill result data 或 assistant message metadata 中；Workbench 会话卡片和 Operations 最近技能结果都会显示清洗后的来源链接，但不会展示 API key、敏感 query、搜索请求参数、网页全文、snippet 或 prompt 内容。正文生成缓存、候选正文文件和抽卡 manifest 仍只保存生成正文/候选，不写入来源摘要。
- Python FastAPI runtime and proxy fallback have been removed from the Electron/TS runtime path.
- 整个迁移已进入纯 TS 收尾阶段，剩余工作以文档卫生、覆盖补强和路由拆分为主。
- AI model summaries (with use_model=true), local prompt/workflow skills, migrated `file_operation` branches, vector/crawler/card-draw workers, and generated-cache commit/save flows are handled locally by the TS runtime.
- `packages/job-service` is loaded, managing local scan_project, build_continuity_context, writing, vector, crawler, card draw and workflow jobs without merging Python job lists.

Recommended order:

1. ~~config service~~ (done)
2. ~~job manager~~ (local TS workers done)
3. ~~conversation service~~ (non-AI CRUD, attachments and local summaries done)
4. ~~project file archive and batch execute service~~ (done)
5. ~~generated cache service~~ (done)
6. ~~skill routing/service~~ (catalog/import and local prompt/workflow skill runs done)
7. ~~agent runtime remaining conversation/intent parity and remaining skill parity~~ (done)
8. ~~vector service and crawler/workflow service~~ (done)

Exit criteria:

- Each migrated module has zod-validated input/output contracts
- TypeScript implementations have replaced the previous Python traffic path with verified local behavior

## Phase 6: Full TS Desktop App (Done)

Goal: remove the Python runtime only after all critical services have TypeScript replacements.

Exit criteria:

- Electron + TypeScript owns desktop shell, local state, terminal, and backend services (Done - Python backend spawning completely disabled; all previously proxied endpoints rewritten in local TS)
- Playwright covers the critical flows (Done - All local units, smoke integrations, and Playwright E2E tests pass 100% cleanly)
- The old Python launcher is no longer needed (Done - Python runtime completely bypassed)

Post-migration enhancements:

- 联网素材搜索已作为纯 TS runtime 增强接入：配置由 `/api/config` 往返保存，聊天和写作 workflow 上下文由 `agent-runtime` 服务端按需构建，搜索失败不会阻断 AI 回复/正文生成，也不会自动写入项目文件。
