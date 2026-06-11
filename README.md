# XiaoShuo TypeScript Migration

This folder is the TypeScript/Electron desktop application for the XiaoShuo novel-writing agent. The Python backend has been fully retired — all services run natively in TypeScript.

## Current Status

- Phase 6 complete: Python runtime fully removed
- Electron + TypeScript owns all backend services, desktop shell, local state, and terminal
- All unit tests (168), smoke integrations, and Playwright E2E tests pass 100%

## Layout

```text
ts-migration/
  apps/
    desktop-shell/        Electron main/preload shell + TS runtime gateway
    workbench/            React/Vite migration frontend
  packages/
    shared/               zod schemas and shared TypeScript types
    api-client/           typed fetch client built on shared contracts
    config-service/       application and model configuration
    job-service/          task queue state machine and local workers
    project-session/      current project open/create/rename state
    project-manifest/     project manifest/tree/chrome readonly data
    document-service/     safe project document reads, saves, archive, timeline, ledger, revision-log
    generated-cache/      AI/skill generated cache save/commit/discard flows
    conversation-service/ conversation storage, attachments, and summaries
    skill-service/        built-in/imported skill catalog and import flows
    model-client/         OpenAI-compatible model client and streaming helpers
    agent-runtime/        planner, prompt/workflow skill runner, chat stream orchestration
    vector-service/       SQLite vector index, embedding client, and hybrid search
    crawler-service/      novel web crawler and page parser
  docs/
    phases.md             phased migration plan
    migration-programming-plan.md detailed implementation plan
```

## Commands

Run these from `ts-migration` after installing dependencies:

```powershell
npm install
npm run dev:workbench        # Vite dev server for the frontend
npm run dev:desktop          # Build + launch full Electron shell
npm run build:workbench      # Production workbench build
npm run build:desktop        # Production Electron build
npm run smoke:desktop        # Electron smoke test (headless)
npm run typecheck            # Full TypeScript compilation check
npm test                     # Vitest unit tests (all packages)
npm run test:e2e             # Playwright browser-mode E2E tests
```

`npm run dev:desktop` builds the workbench, starts a local Vite preview, builds the Electron main/preload shell, and launches Electron with `XIAOSHUO_RENDERER_URL` pointed at the preview. Pass `-- --port 4191` to change the preview port, or set `XIAOSHUO_RENDERER_URL` to use an already running renderer.

`npm run smoke:desktop` runs the shell in an automated Playwright Electron smoke test. It checks that the preload bridge is available, desktop capabilities can be read, and a `node-pty` terminal session can echo a marker through the IPC event stream.

`npm run test:e2e` starts both the browser preview and a lightweight TypeScript runtime harness for `http://127.0.0.1:18453`, so browser-mode Playwright tests can exercise all TS routes without launching the full Electron shell.

## Architecture

The Electron shell starts a local TypeScript runtime gateway at `http://127.0.0.1:18453`. All API routes are served by the `packages/*` service modules — there is no Python proxy or fallback. The terminal tab uses `node-pty` inside Electron; in browser preview it shows a safe fallback.

Desktop local state uses SQLite for recent projects, conversation/job-summary snapshots, generated-cache metadata, and workbench preferences. The shell prefers `better-sqlite3`; on Node 24 it can fall back to `node:sqlite` if the native binding is not built.

The migration workbench is the frontend. It uses `@xiaoshuo/shared` and `@xiaoshuo/api-client` directly and connects to the TS runtime gateway for all backend communication.
