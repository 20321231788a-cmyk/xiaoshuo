# Agent 文件引用与 Skill 生成编辑升级落地方案

本文档面向 `D:\xiaoshuo\ts-migration` 的后续开发者，目标是把当前 agent 的“项目文件读取”和“skill 生成/编辑”能力升级成可预测、可解释、可测试、可回滚的产品级能力。

本文不是概念方案，而是可以直接拆任务、改代码、补测试和验收的工程修改方案。

## 实施维护记录

### 2026-07-07 P1 shared schema

状态：已完成，提交 `a60d463`。

落地内容：

- `packages/shared/src/schemas/agent.ts` 新增项目文件引用解析/读取 schema，并为 agent run payload 增加 `reference_paths`、`confirmed_reference_paths`、`disable_auto_references`。
- `packages/shared/src/schemas/skill.ts` 新增通用 skill draft、patch、clone、version、rollback schema，并为 skill run payload 增加文件引用字段。
- 新增 `packages/shared/src/schemas/agent.test.ts` 和 `packages/shared/src/schemas/skill.test.ts` 覆盖默认值、边界和旧 payload 兼容。

已验证：

- `npm run typecheck -w @xiaoshuo/shared`
- `npx vitest run packages/shared/src/schemas/agent.test.ts packages/shared/src/schemas/skill.test.ts`

### 2026-07-07 P2/P3 ProjectFileManifest + ProjectFileResolver

状态：已完成，提交 `9a67eb3`。

落地内容：

- 新增 `packages/agent-runtime/src/kernel/project-file-manifest.ts`，扫描 `.txt/.md/.jsonl` 生成 `{AGENT_DIR}/file-manifest.json`，跳过 `.git/node_modules/dist/build/coverage/.agent/cache/.agent/traces` 和大文件。
- 新增 `packages/agent-runtime/src/kernel/project-file-resolver.ts`，支持 confirmed/reference paths、`@路径`、引号路径、显式路径、章纲/细纲/大纲等中文别名、当前文档和 manifest 模糊候选。
- 补齐 manifest/resolver 单测，覆盖固定别名、否定别名、路径越界、缺失文件、歧义候选、禁用自动引用和项目内绝对路径转换。
- 调整 `AgentRunRequest` / `SkillRunRequest` 导出类型，让新增引用字段保持 TypeScript 旧调用兼容，同时 schema parse 仍会补默认值。

已验证：

- `npm run typecheck -w @xiaoshuo/shared`
- `npm run typecheck -w @xiaoshuo/agent-runtime`
- `npx vitest run packages/agent-runtime/src/kernel/project-file-manifest.test.ts packages/agent-runtime/src/kernel/project-file-resolver.test.ts packages/shared/src/schemas/agent.test.ts packages/shared/src/schemas/skill.test.ts`

### 2026-07-07 P4/P5 reference context + project reference API

状态：已完成，提交 `398ad2a`。

落地内容：

- 新增 `packages/agent-runtime/src/kernel/reference-context.ts`，把已解析引用文件转成 `ContextBlock`，沿用 `source: "document"` 并用 metadata 标识 `role: "reference_file"`。
- `chat-runner.ts` 接入 `ProjectFileResolver` 和 reference blocks，保留旧 `project_context_hint/current_path/selection` 逻辑。
- `skill-runner.ts` 在 text/附件之后消费 `reference_paths/confirmed_reference_paths`，并在 `source_path` 后尝试自动别名引用。
- `runtime.ts` 向 skill run payload 透传 reference 字段，并让普通 conversation passthrough 的 reference 字段能进入 agent request。
- 新增 `/api/project/resolve-files`、`/api/project/read-references`、`/api/project/rebuild-file-manifest` 路由，并在 api-client 中增加对应方法。

已验证：

- `npm run typecheck -w @xiaoshuo/api-client`
- `npm run typecheck -w @xiaoshuo/agent-runtime`
- `npm run typecheck -w @xiaoshuo/desktop-shell`
- `npx vitest run packages/agent-runtime/src/kernel/reference-context.test.ts packages/agent-runtime/src/kernel/project-file-manifest.test.ts packages/agent-runtime/src/kernel/project-file-resolver.test.ts packages/agent-runtime/src/skill-runner.test.ts apps/desktop-shell/src/main/runtime/project-reference-routes.test.ts packages/api-client/src/client.test.ts`

### 2026-07-07 P9 SkillService patch/clone/version/rollback

状态：已完成，提交 `a89a1ad`。

落地内容：

- 新增 `packages/skill-service/src/skill-version-store.ts`，版本历史写入 `{AGENT_DIR}/skills/versions/{skill_id}.jsonl`。
- 新增 `packages/skill-service/src/skill-diff.ts`，为 dry-run patch 和 rollback 返回简单文本 diff。
- `SkillService` 新增 `patchSkill`、`cloneSkill`、`listSkillVersions`、`rollbackSkill`；builtin skill 仍禁止原地 patch，clone 后以 imported skill 保存。
- patch 限制白名单字段，支持 `dry_run`、`expected_version` 和 patch 前版本快照；rollback 前保存当前版本。
- 补充 service 单测覆盖 dry-run、实际 patch 写版本、builtin patch 拒绝、clone builtin、rollback。

已验证：

- `npm run typecheck -w @xiaoshuo/skill-service`
- `npx vitest run packages/skill-service/src/service.test.ts`

### 2026-07-07 P10 skill patch/clone/version/rollback routes + client

状态：已完成，提交 `e7d09e9`。

落地内容：

- `PATCH /api/skills/{id}` 支持新 `skillPatchRequestSchema`；仅 description 字段时保留旧响应 `SkillDefinition` 兼容前端。
- 新增 `POST /api/skills/{id}/clone`、`GET /api/skills/{id}/versions`、`POST /api/skills/{id}/rollback`。
- `packages/api-client/src/client.ts` 新增 `patchSkill`、`cloneSkill`、`getSkillVersions`、`rollbackSkill`。
- 补充 route matcher、skill routes 和 api-client 测试。

已验证：

- `npm run typecheck -w @xiaoshuo/desktop-shell`
- `npm run typecheck -w @xiaoshuo/api-client`
- `npx vitest run apps/desktop-shell/src/main/runtime/skill-routes.test.ts apps/desktop-shell/src/main/runtime/runtime-utils.test.ts packages/api-client/src/client.test.ts packages/skill-service/src/service.test.ts`

### 2026-07-07 P8/P10 generic skill draft API

状态：已完成，提交 `a4ece48`。

落地内容：

- 新增 `packages/agent-runtime/src/skill-draft-service.ts`，支持 instruction、current_document、selection、attachment、markdown、existing_skill、url 的 prompt-only skill draft。
- URL draft 继续复用已有 `draftSkillFromUrl`；非 URL 来源在无模型配置时生成安全 prompt 模板，不自动导入。
- `AgentRuntimeService` 新增 `draftSkill(payload)`，`POST /api/skills/draft` 新增通用草拟入口。
- `packages/api-client/src/client.ts` 新增 `draftSkill(payload)`。
- 补充 draft service、route matcher 和 api-client 测试。

已验证：

- `npm run typecheck -w @xiaoshuo/agent-runtime`
- `npm run typecheck -w @xiaoshuo/desktop-shell`
- `npm run typecheck -w @xiaoshuo/api-client`
- `npx vitest run packages/agent-runtime/src/skill-draft-service.test.ts apps/desktop-shell/src/main/runtime/runtime-utils.test.ts packages/api-client/src/client.test.ts apps/desktop-shell/src/main/runtime/skill-routes.test.ts`

### 2026-07-07 P11 Workbench skill draft preview MVP

状态：已完成，提交 `57da799`。

落地内容：

- `useWorkbenchCoreController.ts` 新增 `pendingSkillDraft` 状态和 `draftSkillPreview`、`importPendingSkillDraft`、`discardPendingSkillDraft` 控制器方法。
- URL skill 入口从“生成后直接导入”改成“先生成草稿，预览后确认导入”，满足保存前预览要求。
- `useOperationsController.ts` 向 Workbench 页面透出 skill 草稿状态和确认/丢弃动作。
- `SkillFeaturePage.tsx` 新增自然语言/当前文档 skill 草稿入口、草稿预览、warnings 展示和导入确认按钮。
- `styles.css` 补充 skill 草稿面板和移动端布局样式。

已验证：

- `npm run typecheck -w @xiaoshuo/workbench`

### 2026-07-07 P6 Workbench project reference confirmation MVP

状态：已完成，提交 `f648ad1`。

落地内容：

- `useWorkbenchCoreController.ts` 在普通对话发送前调用 `client.resolveProjectFiles()`，仅在消息出现 `@`、明确路径、章纲/细纲/大纲/人物/世界观等引用意图时触发。
- 高置信引用自动透传为 `reference_paths`；中置信候选写入 `pendingReferenceResolution` 并暂停发送，等待用户确认。
- 新增 `togglePendingReferenceCandidate`、`confirmPendingReferenceResolution`、`sendPendingReferenceResolutionWithoutCandidates`、`discardPendingReferenceResolution` 控制器动作。
- `ConversationsView.tsx` 新增参考文件确认面板，展示自动引用 chip、候选 checkbox chip、warnings，以及“确认引用发送 / 不引用候选直接发送 / 取消”动作。
- `LegacyWorkbenchView.tsx` 和 `useConversationController.ts` 透出引用确认状态与动作；右侧栏发送会切到会话页后显示确认面板。
- `styles.css` 补充引用确认面板和候选 chip 样式，避免长路径撑破布局。

已验证：

- `npm run typecheck -w @xiaoshuo/workbench`
- `npm run build -w @xiaoshuo/workbench`（通过；Vite 仍提示现有 chunk size warning）

当前剩余完整验收缺口：

- Workbench skill patch/clone/version/rollback 的 diff 与版本 UI 已进入下一阶段，仍需 e2e 覆盖。
- trace 尚未完整展示 skill 管理事件。
- P12 自然语言 skill 管理路由尚未接入。
- Workbench 引用确认和 skill 编辑仍缺 e2e 覆盖。

### 2026-07-07 P11 Workbench skill edit/version UI MVP

状态：已完成，提交 `9565e28`。

落地内容：

- `useWorkbenchCoreController.ts` 新增 skill edit 状态：`pendingSkillPatchPreview`、`selectedSkillVersions`。
- 新增 `cloneSelectedSkill`、`previewSelectedSkillPatch`、`commitPendingSkillPatch`、`discardPendingSkillPatch`、`loadSkillVersions`、`rollbackSelectedSkill` 控制器动作。
- `useOperationsController.ts` 向技能页透出 clone、dry-run patch、确认 patch、版本读取和 rollback 能力。
- `SkillFeaturePage.tsx` 新增选中技能编辑面板：默认技能只能复制为自定义技能，自定义技能可编辑 description/prompt/context_requirements/linked_targets/change_reason。
- 修改保存前必须先 `dry_run` 展示 diff；确认后再调用实际 patch 并刷新 skill catalog 和版本历史。
- 新增版本历史列表和单版本 rollback 按钮。
- `styles.css` 补充 skill 编辑、diff 预览、版本列表和移动端布局样式。

已验证：

- `npm run typecheck -w @xiaoshuo/workbench`
- `npm run build -w @xiaoshuo/workbench`（通过；Vite 仍提示现有 chunk size warning）

当前剩余完整验收缺口：

- trace 尚未完整展示 skill 管理事件。
- P12 自然语言 skill 管理路由尚未接入。
- Workbench 引用确认和 skill 编辑仍缺 e2e 覆盖。

### 2026-07-07 Trace reference metadata

状态：已完成，提交 `dfe9dbe`。

落地内容：

- `agentContextBlockTraceSchema` 显式支持 `metadata`，继续保留 passthrough 兼容旧 trace 和扩展字段。
- `runtime.ts` 在 `context_assembled` trace 记录中透传 reference block 的 `role/path/label/kind/confidence/matched_text/reason`，并把常用字段拍平到顶层，方便 UI 和调试工具读取。
- `reference-context.ts` 补充 `matched_text` metadata，让 trace 能说明引用从哪个用户文本触发。
- `AgentTraceView.tsx` 在上下文块列表中展示参考文件路径、类型、置信度和匹配文本。
- `runtime.test.ts` 新增自动引用“章纲”后 trace metadata 保留测试。

已验证：

- `npm run typecheck -w @xiaoshuo/shared`
- `npm run typecheck -w @xiaoshuo/agent-runtime`
- `npm run typecheck -w @xiaoshuo/workbench`
- `npx vitest run packages/agent-runtime/src/runtime.test.ts packages/agent-runtime/src/kernel/reference-context.test.ts`

当前剩余完整验收缺口：

- skill 管理事件 trace 尚未接入。
- P12 自然语言 skill 管理路由尚未接入。
- Workbench 引用确认和 skill 编辑仍缺 e2e 覆盖。

## 0. 当前基线

评估时间：2026-07-07。

当前项目已经具备以下基础：

- `packages/agent-runtime/src/chat-runner.ts` 已支持读取 `current_path`、`selection`、附件、项目连续性上下文和向量召回。
- `packages/agent-runtime/src/skill-runner.ts` 已支持 prompt skill 从 `text`、附件、`source_path` 和固定 fallback 文件读取输入。
- `packages/agent-runtime/src/runtime.ts` 已有部分中文文件别名路由，例如“章纲 / 细纲 / 大纲 / 正文”。
- `packages/agent-runtime/src/kernel/context-assembler.ts` 已有统一上下文预算装配器。
- `packages/agent-runtime/src/agent-trace.ts` 和 `packages/shared/src/schemas/agent.ts` 已有 agent trace schema。
- `apps/desktop-shell/src/main/runtime/skill-routes.ts` 已有 skill 列表、详情、运行、导入、上传、URL 草拟、导入草稿、删除、禁用/恢复、打开导入目录等接口。
- `packages/skill-service/src/service.ts` 已有导入 skill、保存 imported skill、删除 imported skill、禁用 builtin skill、更新 imported skill description 的能力。

当前主要缺口：

- 文件引用能力分散在 `chat-runner.ts`、`skill-runner.ts`、`runtime.ts`，没有统一的“用户引用 -> 项目文件路径 -> 上下文块”解析层。
- 用户提到任意自定义文件名时，无法稳定从项目文件中定位。
- 上下文 trace 只能看到 block 级信息，无法完整说明“为什么读了这个文件”。
- skill 只能从 URL/上传/草稿导入，缺少“根据自然语言 / 当前文档 / 当前选区 / 附件生成 skill 草稿”的通用入口。
- skill 编辑 API 目前只允许修改 imported skill 的 `description`，不能安全修改 `prompt`、`context_requirements`、`linked_targets`、`save_policy` 等核心字段。
- builtin skill 不能复制为自定义 skill 后再编辑。
- skill 修改没有版本历史、diff 预览和回滚能力。

## 1. 升级目标

### 1.1 文件引用目标

用户输入以下指令时，agent 应能稳定识别并读取相应项目文件：

```text
参考章纲继续写
根据细纲生成正文
读取 01_大纲/大纲.txt
参考 @01_大纲/章纲.txt
参考“人物设定”
用当前文档和世界观设定一起改
根据当前选区生成短篇审稿意见
参考我刚上传的设定文档
```

系统必须做到：

- 能识别显式路径、`@路径`、中文固定别名、当前文档、当前选区、附件和模糊文件名。
- 能返回“本次引用了哪些文件、为什么引用、置信度多少”。
- 高置信度文件自动读取；中置信度候选要求用户确认；低置信度不自动读。
- 所有读取必须限制在项目根目录内，继续复用 `DocumentService` 的路径安全规则。
- 单轮自动引用文件数量和字符数必须有上限，防止上下文膨胀。

### 1.2 Skill 生成与编辑目标

用户输入以下指令时，系统应有对应工作流：

```text
把这套提示词做成一个技能
根据当前文档生成一个“短篇审稿”技能
把这个网页整理成 skill
把“去AI味”技能复制一份，改成更适合男频网文
修改我导入的 short_review 技能，让它输出更严格
回滚 short_review 到上一个版本
```

系统必须做到：

- 支持自然语言、当前文档、当前选区、附件、URL、Markdown 文本生成 prompt skill 草稿。
- 保存前必须预览 skill 草稿。
- 编辑 imported skill 时必须展示 diff。
- builtin skill 不允许原地修改，只允许“复制为自定义 skill”后编辑。
- 每次 skill 修改都写版本历史，支持回滚。
- 外部生成/导入 skill 默认仍只允许 `handler_type: "prompt"`，不得生成脚本执行能力。

## 2. 总体架构

目标结构如下：

```text
packages/shared/src/schemas/
  agent.ts                       # 扩展文件引用 schema
  skill.ts                       # 扩展 skill 草拟、编辑、版本 schema

packages/agent-runtime/src/kernel/
  context-assembler.ts           # 已存在，继续作为预算裁剪入口
  context-block.ts               # 扩展 metadata 约定，不必新增 source 类型也可落地
  project-file-resolver.ts       # 新增：用户文本/显式引用 -> 文件候选
  project-file-manifest.ts       # 新增：构建/读取轻量项目文件 manifest
  reference-context.ts           # 新增：resolved references -> ContextBlock[]

packages/agent-runtime/src/
  chat-runner.ts                 # 接入 project-file-resolver 和 assembleContext
  skill-runner.ts                # 接入 reference paths，不再只靠 source_path/fallback
  runtime.ts                     # 将 resolveSkillSourcePath 中的文件别名逻辑迁移到 resolver

packages/skill-service/src/
  service.ts                     # 扩展 skill patch/clone/version/rollback
  skill-version-store.ts         # 新增：skill 版本历史
  skill-diff.ts                  # 新增：diff 生成工具

apps/desktop-shell/src/main/runtime/
  project-reference-routes.ts    # 新增：文件引用解析/读取/manifest 重建
  skill-routes.ts                # 扩展 skill draft/edit/clone/version/rollback

packages/api-client/src/
  client.ts                      # 新增对应 client 方法

apps/workbench/src/
  App.tsx / hooks                # 增加引用文件 chip、歧义确认、skill 草稿预览、diff 确认
```

注意：不要重建已有 `agent-trace` 和 `context-assembler`。本方案是在现有基线上增量接入。

## 3. 阶段 P1：新增文件引用 Schema

### 3.1 修改文件

```text
packages/shared/src/schemas/agent.ts
```

### 3.2 新增 schema

建议新增：

```ts
export const projectFileReferenceKindSchema = z.enum([
  "explicit_path",
  "at_path",
  "alias",
  "current_document",
  "selection",
  "attachment",
  "manifest_match",
  "vector_hint"
]);

export const projectFileReferenceCandidateSchema = z
  .object({
    label: z.string().default(""),
    path: z.string().default(""),
    kind: projectFileReferenceKindSchema,
    confidence: z.number().min(0).max(1).default(0),
    reason: z.string().default(""),
    matched_text: z.string().default(""),
    exists: z.boolean().default(false),
    readable: z.boolean().default(false),
    chars: z.number().int().min(0).default(0),
    updated_at: z.string().default("")
  })
  .passthrough();

export const projectFileResolveRequestSchema = z
  .object({
    text: z.string().default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    explicit_paths: z.array(z.string()).default([]),
    max_candidates: z.number().int().min(1).max(20).default(8)
  })
  .passthrough();

export const projectFileResolveResponseSchema = z
  .object({
    references: z.array(projectFileReferenceCandidateSchema).default([]),
    candidates: z.array(projectFileReferenceCandidateSchema).default([]),
    ambiguous: z.boolean().default(false),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();

export const projectFileReadRequestSchema = z
  .object({
    paths: z.array(z.string()).default([]),
    max_chars_per_file: z.number().int().min(500).max(50000).default(12000),
    max_total_chars: z.number().int().min(1000).max(120000).default(36000)
  })
  .passthrough();

export const projectFileReadBlockSchema = z
  .object({
    path: z.string(),
    title: z.string().default(""),
    content: z.string().default(""),
    chars: z.number().int().min(0).default(0),
    truncated: z.boolean().default(false)
  })
  .passthrough();

export const projectFileReadResponseSchema = z
  .object({
    blocks: z.array(projectFileReadBlockSchema).default([]),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();
```

### 3.3 扩展 agent 请求

在 `agentRunRequestSchema` 中增加：

```ts
reference_paths: z.array(z.string()).default([]),
confirmed_reference_paths: z.array(z.string()).default([]),
disable_auto_references: z.boolean().default(false)
```

含义：

- `reference_paths`：前端从用户显式选择或 `@路径` 得到的路径。
- `confirmed_reference_paths`：用户从歧义候选中确认的路径。
- `disable_auto_references`：用户明确不希望自动读项目文件时使用。

### 3.4 测试

新增或扩展：

```text
packages/shared/src/schemas/agent.test.ts
```

测试点：

- 默认值正确。
- 非法 confidence 被拒绝。
- `max_candidates` 上限生效。
- agent 请求兼容旧 payload。

## 4. 阶段 P2：新增 ProjectFileManifest

### 4.1 修改文件

新增：

```text
packages/agent-runtime/src/kernel/project-file-manifest.ts
packages/agent-runtime/src/kernel/project-file-manifest.test.ts
```

### 4.2 Manifest 位置

建议保存在项目内：

```text
{AGENT_DIR}/file-manifest.json
```

其中 `AGENT_DIR` 使用 `@xiaoshuo/project-session` 已有常量，避免硬编码目录名。

### 4.3 Manifest 数据结构

```ts
export type ProjectFileManifestEntry = {
  path: string;
  name: string;
  stem: string;
  extension: string;
  size: number;
  updatedAt: string;
  updatedAtMs: number;
  title: string;
  excerpt: string;
  keywords: string[];
};

export type ProjectFileManifest = {
  version: 1;
  projectRoot: string;
  generatedAt: string;
  entries: ProjectFileManifestEntry[];
};
```

### 4.4 扫描规则

允许纳入 manifest 的文件：

- `.txt`
- `.md`
- `.jsonl`

默认跳过：

- `.git`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.agent/cache`
- `.agent/traces`
- 大于 2MB 的单文件

注意：`DocumentService.resolveSafePath()` 当前允许读 `.txt/.md/.jsonl`，manifest 不应绕过它做最终读取。manifest 只用于候选检索，真正读取仍走 `DocumentService.readRawText()`。

### 4.5 匹配字段

每个 entry 至少抽取：

- `path`：相对项目根目录路径。
- `name`：文件名。
- `stem`：不含扩展名的文件名。
- `title`：Markdown 第一个标题，或 txt 前 40 字。
- `excerpt`：前 300 字。
- `keywords`：路径分段、文件名分词、中文关键词。

### 4.6 刷新策略

MVP 做法：

- 通过 API 手动重建。
- 启动项目时如果 manifest 不存在则懒构建。
- 文件保存、生成内容 commit 后异步触发重建，不阻塞主流程。

后续优化：

- 按 mtime 增量更新。
- 项目树变化时 debounce 更新。

## 5. 阶段 P3：新增 ProjectFileResolver

### 5.1 修改文件

新增：

```text
packages/agent-runtime/src/kernel/project-file-resolver.ts
packages/agent-runtime/src/kernel/project-file-resolver.test.ts
```

### 5.2 Resolver 输入

```ts
export type ProjectFileResolverInput = {
  text: string;
  currentPath?: string;
  selection?: string;
  attachmentIds?: string[];
  explicitPaths?: string[];
  confirmedPaths?: string[];
  disableAutoReferences?: boolean;
  maxCandidates?: number;
};
```

### 5.3 Resolver 输出

直接复用 `projectFileResolveResponseSchema`。

### 5.4 解析优先级

按以下顺序解析：

1. 用户已确认路径：`confirmed_reference_paths`
2. 前端显式路径：`reference_paths`
3. `@路径`：例如 `@01_大纲/章纲.txt`
4. 反引号/引号中的路径：例如 `` `01_大纲/大纲.txt` ``、`“人物设定.md”`
5. 带扩展名的显式路径：`.txt/.md/.jsonl`
6. 固定中文别名：章纲、细纲、大纲、正文、设定、人物、世界观、风格、题材
7. 当前文档：当前文档、当前文件、这篇、这章、本文
8. manifest 模糊匹配
9. 向量 hint 只作为辅助，不直接决定读文件

### 5.5 固定别名表

先落地以下映射：

```ts
const FILE_ALIASES = [
  { pattern: /章纲(?:文件|文档)?/, paths: ["01_大纲/章纲.txt"], confidence: 0.98 },
  { pattern: /细纲(?:文件|文档)?/, paths: ["01_大纲/细纲.txt"], confidence: 0.98 },
  { pattern: /大纲(?:文件|文档)?/, paths: ["01_大纲/大纲.txt"], confidence: 0.95 },
  { pattern: /风格(?:样本|文件|文档)?/, paths: ["02_设定/风格.txt", "00_设定/风格.txt"], confidence: 0.75 },
  { pattern: /人物(?:设定|档案|小传)?/, query: "人物 设定", confidence: 0.70 },
  { pattern: /世界观|设定集|背景设定/, query: "世界观 设定", confidence: 0.70 },
  { pattern: /正文(?:文件|文档)?/, query: "正文", confidence: 0.65 }
];
```

说明：

- 对确定路径的 alias，如果文件不存在，不报错，降级为 manifest query。
- 对 `query` 类 alias，走 manifest 检索。
- 目录名不确定的“人物/世界观/正文”不要硬编码单一路径。

### 5.6 置信度规则

```text
confidence >= 0.85  -> references，自动读取
0.55 <= confidence < 0.85 -> candidates，标记 ambiguous
confidence < 0.55 -> 丢弃，只记录 warning 或 trace
```

最多自动读取：

- 普通聊天：5 个文件
- prompt skill：4 个文件
- 正文生成：6 个文件
- 单文件默认上限：12000 字
- 总上限由 `ContextAssembler` 再裁剪

### 5.7 安全规则

- 所有路径归一化必须使用 `DocumentService.normalizeRelativePath()`。
- 所有读取必须使用 `DocumentService.readRawText()`。
- 禁止接受绝对路径作为项目外文件读取目标。
- 如果用户输入 `D:\...`，只有在该路径位于当前 project root 内时才转换成相对路径。
- `../`、`.git`、二进制扩展名继续拒绝。

### 5.8 单测用例

必须覆盖：

```text
参考章纲 -> 01_大纲/章纲.txt
参考细纲 -> 01_大纲/细纲.txt
参考大纲但不要细纲 -> 01_大纲/大纲.txt
@01_大纲/章纲.txt -> explicit at_path
读取 `01_大纲/大纲.txt` -> explicit path
参考人物设定 -> manifest candidate
当前文档 -> current_path
没有 current_path 时说当前文档 -> warning
路径越界 ../secret.txt -> 拒绝
不存在的明确路径 -> candidate exists=false readable=false
多个候选接近 -> ambiguous=true
confirmed_reference_paths 优先于自动解析
disable_auto_references=true 时只保留 explicit/confirmed
```

## 6. 阶段 P4：接入 ContextAssembler

### 6.1 修改文件

```text
packages/agent-runtime/src/kernel/reference-context.ts
packages/agent-runtime/src/chat-runner.ts
packages/agent-runtime/src/skill-runner.ts
packages/agent-runtime/src/runtime.ts
packages/agent-runtime/src/kernel/context-block.ts
```

### 6.2 reference-context 责任

新增：

```ts
export async function buildReferenceContextBlocks(input: {
  documents: DocumentService;
  references: ProjectFileReferenceCandidate[];
  maxCharsPerFile: number;
}): Promise<ContextBlock[]>
```

每个引用文件生成一个 `ContextBlock`：

```ts
{
  id: `reference:${path}`,
  title: `参考文件：${path}`,
  source: "document",
  priority: "high",
  content: `【参考文件：${path}】\n【引用原因：${reason}】\n\n${text}`,
  maxChars: maxCharsPerFile,
  metadata: {
    role: "reference_file",
    path,
    label,
    kind,
    confidence,
    reason
  }
}
```

不建议马上新增 `ContextBlockSource = "reference"`，因为 `agentContextBlockTraceSchema.source` 也要同步扩展。MVP 可用 `source: "document"` + `metadata.role = "reference_file"`。

### 6.3 chat-runner 接入

修改 `resolveRuntimeContext()`：

- 保留 `project_context_hint`、`current_path`、`selection` 兼容逻辑。
- 新增 resolver 调用。
- 将当前文档、选区、引用文件、附件、向量召回转成 `ContextBlock[]`。
- 调用 `assembleContext(blocks, { mode: compact ? "compact_retry" : "chat" })`。
- trace 中记录每个 block 的 `id/title/source/chars/included/metadata.path/reason`。

短期不必一次性删除旧拼接逻辑，可以先做 wrapper：

```ts
const referenceResolution = await this.fileResolver.resolve({
  text: payload.content,
  currentPath: payload.current_path,
  selection: payload.selection,
  attachmentIds: payload.attachment_ids,
  explicitPaths: payload.reference_paths,
  confirmedPaths: payload.confirmed_reference_paths,
  disableAutoReferences: payload.disable_auto_references
});
```

### 6.4 skill-runner 接入

修改 `resolvePromptSourceText()`：

当前优先级是：

1. `payload.text`
2. attachment
3. lore fallback
4. `payload.source_path`
5. skill fallback

升级后建议调整为：

1. `payload.text`
2. attachment
3. `confirmed_reference_paths/reference_paths`
4. `payload.source_path`
5. resolver 自动别名
6. skill fallback

这样用户运行 skill 时说“参考人物设定”才不会只落到默认 fallback。

`skillRunRequestSchema` 也要增加：

```ts
reference_paths: z.array(z.string()).default([]),
confirmed_reference_paths: z.array(z.string()).default([]),
disable_auto_references: z.boolean().default(false)
```

### 6.5 runtime.ts 迁移

`resolveSkillSourcePath()` 里现有“章纲 / 细纲 / 大纲”逻辑先不要删除，第一轮改成调用 resolver：

```ts
const resolved = await this.projectFileResolver.resolve(...);
if (resolved.references[0]?.path) return resolved.references[0].path;
return legacyResolveSkillSourcePath(...);
```

第二轮确认测试通过后，再删除重复别名逻辑。

## 7. 阶段 P5：新增文件引用 API

### 7.1 修改文件

```text
apps/desktop-shell/src/main/runtime/project-reference-routes.ts
apps/desktop-shell/src/main/runtime/index.ts
apps/desktop-shell/src/main/runtime/route-matchers.ts
packages/api-client/src/client.ts
```

### 7.2 API 设计

#### POST `/api/project/resolve-files`

请求：

```json
{
  "text": "参考人物设定和章纲继续写",
  "current_path": "02_正文/第001章.txt",
  "selection": "",
  "attachment_ids": [],
  "explicit_paths": []
}
```

响应：

```json
{
  "references": [
    {
      "label": "章纲",
      "path": "01_大纲/章纲.txt",
      "kind": "alias",
      "confidence": 0.98,
      "reason": "用户提到“章纲”",
      "matched_text": "章纲",
      "exists": true,
      "readable": true
    }
  ],
  "candidates": [
    {
      "label": "人物设定",
      "path": "02_设定/人物设定.txt",
      "kind": "manifest_match",
      "confidence": 0.72,
      "reason": "文件名与“人物设定”匹配"
    }
  ],
  "ambiguous": true,
  "warnings": []
}
```

#### POST `/api/project/read-references`

请求：

```json
{
  "paths": ["01_大纲/章纲.txt", "02_设定/人物设定.txt"],
  "max_chars_per_file": 12000,
  "max_total_chars": 36000
}
```

响应：

```json
{
  "blocks": [
    {
      "path": "01_大纲/章纲.txt",
      "title": "章纲",
      "content": "...",
      "chars": 8200,
      "truncated": false
    }
  ],
  "warnings": []
}
```

#### POST `/api/project/rebuild-file-manifest`

响应：

```json
{
  "ok": true,
  "entries": 128,
  "path": ".agent/file-manifest.json"
}
```

### 7.3 API 测试

新增：

```text
apps/desktop-shell/src/main/runtime/project-reference-routes.test.ts
```

覆盖：

- 没有当前项目时返回 400。
- resolve-files 可解析 alias。
- read-references 不能读项目外路径。
- rebuild-file-manifest 能生成 entries。
- 路由 schema 拒绝非法 payload。

## 8. 阶段 P6：Workbench 文件引用交互

### 8.1 修改点

优先小步接入，不要大重构 `App.tsx`。

建议新增组件：

```text
apps/workbench/src/components/ReferenceChips.tsx
apps/workbench/src/components/ReferenceCandidateDialog.tsx
apps/workbench/src/hooks/useProjectReferences.ts
```

### 8.2 交互要求

输入框中：

- 用户输入 `@` 时，可弹出项目文件候选。
- 用户发送前，若解析到高置信度引用，显示小 chip：`章纲 01_大纲/章纲.txt`。
- 若有歧义候选，发送前弹窗让用户选。
- 用户可删除某个引用 chip。

发送请求时：

- chip 路径进入 `reference_paths`。
- 歧义确认路径进入 `confirmed_reference_paths`。
- 用户关闭自动引用时传 `disable_auto_references: true`。

回答展示：

- 在消息元信息或折叠区展示“本次参考文件”。
- 不要把大段引用内容直接展示给用户，展示路径和原因即可。

## 9. 阶段 P7：扩展 Skill 生成 Schema

### 9.1 修改文件

```text
packages/shared/src/schemas/skill.ts
```

### 9.2 新增通用草拟请求

当前只有 `skillDraftFromUrlRequestSchema`。新增：

```ts
export const skillDraftSourceKindSchema = z.enum([
  "instruction",
  "current_document",
  "selection",
  "attachment",
  "url",
  "markdown",
  "existing_skill"
]);

export const skillDraftRequestSchema = z
  .object({
    kind: skillDraftSourceKindSchema.default("instruction"),
    instruction: z.string().max(12000).default(""),
    text: z.string().max(120000).default(""),
    url: z.string().max(2000).default(""),
    current_path: z.string().default(""),
    selection: z.string().default(""),
    attachment_ids: z.array(z.string()).default([]),
    source_skill_id: z.string().default(""),
    target_name: z.string().max(100).default(""),
    target_id: z.string().max(100).default("")
  })
  .passthrough();
```

### 9.3 新增编辑请求

```ts
export const skillPatchRequestSchema = z
  .object({
    description: z.string().max(1000).optional(),
    prompt: z.string().max(120000).optional(),
    context_requirements: z.array(z.string()).optional(),
    linked_targets: z.array(z.string()).optional(),
    model_policy: skillModelPolicySchema.optional(),
    save_policy: skillSavePolicySchema.optional(),
    writable: z.boolean().optional(),
    change_reason: z.string().max(2000).default(""),
    expected_version: z.string().default(""),
    dry_run: z.boolean().default(false)
  })
  .passthrough();

export const skillPatchResponseSchema = z
  .object({
    skill: skillDefinitionSchema,
    previous_skill: skillDefinitionSchema.optional(),
    diff: z.string().default(""),
    version_id: z.string().default(""),
    dry_run: z.boolean().default(false),
    warnings: z.array(z.string()).default([])
  })
  .passthrough();
```

### 9.4 新增 clone/version/rollback schema

```ts
export const skillCloneRequestSchema = z
  .object({
    target_id: z.string().max(100).default(""),
    target_name: z.string().max(100).default(""),
    instruction: z.string().max(4000).default("")
  })
  .passthrough();

export const skillVersionEntrySchema = z
  .object({
    version_id: z.string(),
    skill_id: z.string(),
    created_at: z.string(),
    change_reason: z.string().default(""),
    author: z.string().default("agent"),
    snapshot: skillDefinitionSchema
  })
  .passthrough();

export const skillVersionsResponseSchema = z
  .object({
    skill_id: z.string(),
    versions: z.array(skillVersionEntrySchema).default([])
  })
  .passthrough();

export const skillRollbackRequestSchema = z
  .object({
    version_id: z.string(),
    change_reason: z.string().max(2000).default("rollback")
  })
  .passthrough();
```

## 10. 阶段 P8：SkillDraftService

### 10.1 修改文件

新增：

```text
packages/agent-runtime/src/skill-draft-service.ts
packages/agent-runtime/src/skill-draft-service.test.ts
```

也可以先放在 `skill-runner.ts`，但建议新建文件，避免继续膨胀。

### 10.2 行为

`SkillDraftService.draftSkill(payload)` 根据 `kind` 取源：

- `instruction`：只使用用户说明。
- `current_document`：读取 `current_path`。
- `selection`：使用 `selection` 或 `text`。
- `attachment`：读取 conversation attachments。
- `url`：复用现有 `draftSkillFromUrl()`。
- `markdown`：解析/整理 `text`。
- `existing_skill`：读取已有 skill，作为改造基础。

输出仍为 `SkillDraftResponse`，这样前端可复用现有导入草稿接口。

### 10.3 Prompt 要求

生成 skill 时系统提示必须包含：

```text
只生成 prompt 型 SkillDefinition。
handler_type 固定为 prompt。
input_mode 固定为 text，除非用户明确要求其他输入模式且系统已支持。
不得生成执行命令、脚本、外部程序、联网抓取等能力。
prompt 必须包含适用场景、输入要求、处理步骤、输出格式、质量标准。
如果源材料不足，返回 warnings，不要凭空扩写危险能力。
```

### 10.4 验证

草稿生成后必须经过 `SkillService.normalizeSkill()` 和 `skillDefinitionSchema`。

额外限制：

- `id` 归一化。
- `handler_type` 强制改为 `prompt`。
- `tools` 默认空数组。
- `writable` 默认 false，除非用户明确要求且 save policy 合法。
- `prompt` 为空则拒绝导入。

## 11. 阶段 P9：Skill 编辑、复制、版本和回滚

### 11.1 修改文件

```text
packages/skill-service/src/service.ts
packages/skill-service/src/skill-version-store.ts
packages/skill-service/src/skill-diff.ts
packages/skill-service/src/service.test.ts
```

### 11.2 版本存储

建议路径：

```text
{AGENT_DIR}/skills/versions/{skill_id}.jsonl
```

每行一个 `skillVersionEntrySchema`。

写入时机：

- patch imported skill 前，保存旧版本。
- rollback 前，保存当前版本。
- clone builtin skill 后，保存初始版本。

### 11.3 patchSkill 规则

新增：

```ts
async patchSkill(skillId: string, payload: SkillPatchRequest): Promise<SkillPatchResponse>
```

规则：

- 只允许 patch imported skill。
- 如果 `skillId` 是 builtin，抛错：`默认技能不能直接修改，请先复制为自定义技能`。
- patch 只能修改白名单字段。
- `handler_type`、`id` 不允许通过 patch 修改。
- `expected_version` 非空时必须匹配当前 skill version，否则返回冲突。
- `dry_run=true` 只返回 diff，不写入。
- 实际写入前保存旧版本。

### 11.4 cloneSkill 规则

新增：

```ts
async cloneSkill(skillId: string, payload: SkillCloneRequest): Promise<SkillDefinition>
```

规则：

- builtin 和 imported 都可 clone。
- 新 id 默认：`custom_${source_id}`，冲突时追加 `_2/_3`。
- 新 name 默认：`{原名称}（自定义）`。
- `builtin=false`。
- `imported_from` 记录：`clone:{source_id}`。
- 保存到 imported skills。

### 11.5 rollbackSkill 规则

新增：

```ts
async rollbackSkill(skillId: string, payload: SkillRollbackRequest): Promise<SkillPatchResponse>
```

规则：

- 只允许 rollback imported skill。
- rollback 前保存当前版本。
- rollback 后返回 diff。

### 11.6 diff 生成

MVP 可以使用简单 line diff，不强依赖新包：

```text
--- previous
+++ next
@@ description
- old
+ new
@@ prompt
- ...
+ ...
```

如果后续引入依赖，优先选择轻量 diff 库并集中封装在 `skill-diff.ts`。

## 12. 阶段 P10：扩展 Skill API 和客户端

### 12.1 修改文件

```text
apps/desktop-shell/src/main/runtime/skill-routes.ts
packages/api-client/src/client.ts
```

### 12.2 新增/扩展 API

#### POST `/api/skills/draft`

通用草拟入口，支持自然语言、当前文档、选区、附件、URL、Markdown、已有 skill。

#### PATCH `/api/skills/{id}`

从只改 description 扩展为 `skillPatchRequestSchema`。

兼容旧 payload：

- 如果 body 只有 `description`，行为等同旧版。
- 如果是 builtin，返回 400 和明确错误。

#### POST `/api/skills/{id}/clone`

复制 skill 为 imported skill。

#### GET `/api/skills/{id}/versions`

返回版本列表。

#### POST `/api/skills/{id}/rollback`

回滚到指定版本。

#### POST `/api/skills/{id}/draft-edit`

可选接口。输入自然语言修改要求，返回 dry-run patch：

```json
{
  "instruction": "改成更适合男频网文，输出更犀利",
  "dry_run": true
}
```

MVP 可先不做这个接口，先让前端把 draft-edit 结果转成 `PATCH dry_run`。

### 12.3 客户端方法

在 `packages/api-client/src/client.ts` 增加：

```ts
draftSkill(payload)
patchSkill(skillId, payload)
cloneSkill(skillId, payload)
getSkillVersions(skillId)
rollbackSkill(skillId, payload)
```

## 13. 阶段 P11：Workbench Skill 交互

### 13.1 新增组件

建议新增：

```text
apps/workbench/src/components/SkillDraftPanel.tsx
apps/workbench/src/components/SkillDiffDialog.tsx
apps/workbench/src/components/SkillVersionPanel.tsx
```

### 13.2 用户流程

#### 创建 skill

```text
用户：把当前选区做成“短篇审稿”技能
系统：生成草稿 -> 展示 id/name/description/prompt/context/save policy -> 用户确认导入
```

#### 编辑 imported skill

```text
用户：修改 short_review，让它更严格
系统：生成 patch dry-run -> 展示 diff -> 用户确认保存 -> 写版本历史
```

#### 编辑 builtin skill

```text
用户：修改去AI味技能
系统：提示默认技能不能直接修改 -> 提供“复制为自定义技能并修改” -> 用户确认 -> clone + patch
```

#### 回滚

```text
用户：回滚 short_review
系统：展示版本列表 -> 用户选择 -> 展示 diff -> 确认回滚
```

## 14. 阶段 P12：Agent 自然语言路由接入

### 14.1 修改文件

```text
packages/agent-runtime/src/runtime.ts
packages/agent-runtime/src/chat-runner.ts
packages/agent-runtime/src/skill-runner.ts
```

后续如果已拆出 routing：

```text
packages/agent-runtime/src/routing/intent-router.ts
packages/agent-runtime/src/routing/skill-orchestrator.ts
```

### 14.2 新增意图

`agentIntentSchema` 当前为：

```ts
["file_operation", "read_context", "skill", "chat"]
```

建议新增：

```ts
"skill_management"
```

如果担心影响面大，MVP 可不改 enum，先把 skill 管理作为 `skill` 意图下的 action。

### 14.3 路由规则

识别以下触发词：

```text
创建技能
生成技能
做成 skill
沉淀成 skill
导入技能
修改技能
编辑 skill
复制技能
回滚技能
禁用技能
恢复技能
```

### 14.4 执行边界

自然语言触发 skill 管理时：

- 可以自动生成 draft。
- 可以自动生成 dry-run patch。
- 不允许无确认直接保存 skill。
- 不允许无确认 rollback。
- 不允许修改 builtin skill，只能 clone。

## 15. Trace 与可观测性

### 15.1 文件引用 trace

扩展 `agentRunTraceSchema.context_blocks` 的 metadata 使用约定：

```json
{
  "name": "参考文件：01_大纲/章纲.txt",
  "source": "document",
  "chars": 12000,
  "included": true,
  "reason": "用户提到“章纲”",
  "metadata": {
    "role": "reference_file",
    "path": "01_大纲/章纲.txt",
    "kind": "alias",
    "confidence": 0.98
  }
}
```

如果当前 trace schema 不支持 metadata，可先把 path/reason 合并到 `reason` 字段，后续再扩 schema。

### 15.2 Skill 管理 trace

新增 trace 事件或在现有 trace 中记录：

- `skill_draft_started`
- `skill_draft_completed`
- `skill_patch_dry_run`
- `skill_patch_committed`
- `skill_cloned`
- `skill_rolled_back`

MVP 如果不扩 `agentTraceStageSchema`，可写到 `selected_reason` 或单独 service log。正式产品化建议扩 schema。

## 16. 测试计划

### 16.1 必跑命令

每个阶段完成后至少运行：

```powershell
cd D:\xiaoshuo\ts-migration
npm run typecheck
npm test
```

涉及 Electron route：

```powershell
npm run build:desktop
npm run smoke:desktop
```

涉及 Workbench UI：

```powershell
npm run build:workbench
npm run test:e2e
```

### 16.2 单测清单

新增/扩展：

```text
packages/agent-runtime/src/kernel/project-file-manifest.test.ts
packages/agent-runtime/src/kernel/project-file-resolver.test.ts
packages/agent-runtime/src/kernel/reference-context.test.ts
packages/agent-runtime/src/skill-draft-service.test.ts
packages/skill-service/src/service.test.ts
apps/desktop-shell/src/main/runtime/project-reference-routes.test.ts
apps/desktop-shell/src/main/runtime/skill-routes.test.ts
```

### 16.3 集成用例

必须覆盖：

```text
1. 聊天：“参考章纲总结下一章重点”
   期望：读取 01_大纲/章纲.txt，trace 中有 reference_file。

2. 聊天：“参考人物设定和当前文档修改”
   期望：人物设定若有多个候选，返回 ambiguous，前端要求确认。

3. 技能运行：“用章纲生成正文”
   期望：skill source 使用章纲，不只依赖 source_path。

4. 创建 skill：“把当前选区做成短篇审稿技能”
   期望：返回 draft，不自动导入。

5. 导入 skill draft
   期望：写入 imported skills，handler_type=prompt。

6. 修改 imported skill prompt
   期望：dry_run 返回 diff；确认后写版本。

7. 修改 builtin skill
   期望：直接 patch 被拒绝；clone 后可 patch。

8. rollback imported skill
   期望：版本恢复，当前版本被保存为 rollback 前快照。

9. 路径越界
   输入：参考 ../secret.txt
   期望：拒绝读取，trace/warnings 记录。

10. 大文件引用
    期望：按 max_chars_per_file 截断，context assembler 再裁剪。
```

## 17. 验收标准

### 17.1 文件引用验收

达到以下标准才算完成：

- 用户可用 `@路径` 明确引用项目文件。
- 用户说“章纲 / 细纲 / 大纲”能稳定读到对应文件。
- 用户说“人物设定 / 世界观设定”等非固定路径时，能从 manifest 找候选。
- 歧义候选不会被静默读取，必须让用户确认。
- 回答或 trace 能看到“本轮参考文件”。
- 所有读取都限制在项目根目录和允许扩展名内。

### 17.2 Skill 管理验收

达到以下标准才算完成：

- 可以从自然语言生成 skill draft。
- 可以从当前文档/选区/附件生成 skill draft。
- 可以导入 draft。
- 可以 patch imported skill 的 prompt/description/context/targets/save policy。
- patch 有 dry-run diff。
- builtin skill 不能原地修改。
- builtin skill 可以 clone 为 imported skill。
- imported skill 有版本历史。
- rollback 可用。
- 所有 skill 生成/编辑接口都有 route 测试。

## 18. 回滚方案

### 18.1 文件引用回滚

保留旧逻辑 fallback：

- `chat-runner.ts` 保留原 `current_path`、`selection` 注入。
- `skill-runner.ts` 保留原 `source_path` 和 fallback。
- `runtime.ts` 保留原 `resolveSkillSourcePath()` 至少一个版本。

如果 resolver 出错：

```ts
try {
  references = await resolver.resolve(...);
} catch {
  references = { references: [], candidates: [], ambiguous: false, warnings: ["文件引用解析失败，已使用旧逻辑"] };
}
```

### 18.2 Skill 编辑回滚

- `PATCH /api/skills/{id}` 先兼容旧 description-only payload。
- 新字段出现问题时，可以只关闭 UI 入口，不影响旧导入/运行 skill。
- 每次 patch 前保存版本，所以数据层可 rollback。

## 19. 建议实施顺序

推荐按以下顺序拆 PR：

```text
PR-1 shared schema：文件引用 + skill draft/patch/version schema
PR-2 ProjectFileManifest + ProjectFileResolver + 单测
PR-3 project reference routes + api-client
PR-4 chat-runner/skill-runner/runtime 接入引用上下文
PR-5 Workbench 引用 chip + 歧义确认
PR-6 SkillDraftService + POST /api/skills/draft
PR-7 Skill patch/clone/version/rollback service + routes
PR-8 Workbench skill 草稿预览 + diff + 回滚 UI
PR-9 trace/eval/文档补齐
```

如果只做 MVP，优先做：

```text
1. ProjectFileResolver
2. @路径 + 章纲/细纲/大纲别名 + manifest 模糊匹配
3. chat/skill 接入 reference_paths
4. POST /api/skills/draft
5. PATCH imported skill + dry-run diff + version history
6. clone builtin skill
```

## 20. 风险与注意事项

- 不要让 resolver 静默读取大量文件。默认自动读取数量必须少，且 trace 可见。
- 不要让 manifest 内容绕过 `DocumentService` 安全规则。
- 不要让自然语言 skill 生成直接保存。必须 preview/confirm。
- 不要允许外部 skill 生成 `workflow/job/external` 执行能力。
- 不要原地修改 builtin skill。复制是更安全的产品语义。
- 不要把 UI 重构和能力升级绑在一个大 PR。先 route/API/单测，再接 UI。
- 不要一次性删除旧 `resolveSkillSourcePath()` 逻辑，至少保留一个版本作为 fallback。

## 21. 完成后的用户体验样例

### 21.1 文件引用

用户：

```text
参考人物设定和章纲，帮我判断第 12 章有没有人设冲突。
```

系统行为：

```text
自动引用：
- 01_大纲/章纲.txt，原因：用户提到“章纲”，置信度 0.98

需要确认：
- 02_设定/人物设定.txt，原因：文件名匹配“人物设定”，置信度 0.74
- 02_设定/主要角色.md，原因：标题匹配“人物”，置信度 0.68
```

用户确认后再执行。

### 21.2 Skill 创建

用户：

```text
把当前选区做成一个“短篇情绪张力审稿”技能。
```

系统行为：

```text
生成 skill draft：
- id: short_emotion_review
- name: 短篇情绪张力审稿
- handler_type: prompt
- writable: false

展示 prompt 预览，用户确认后导入。
```

### 21.3 Skill 编辑

用户：

```text
把 short_emotion_review 改得更严格，输出必须包含问题等级。
```

系统行为：

```text
生成 dry-run diff：
- prompt 中加入“问题等级：致命/严重/一般/建议”
- 输出格式增加“等级”和“修改建议”

用户确认后保存，写入版本历史。
```
