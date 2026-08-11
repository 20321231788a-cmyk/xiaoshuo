# Dependency Map

## Phase 1: Contracts and Tests

- `zod`: runtime validation for API, IPC, config, and migrated service contracts
- `vitest`: unit tests for schemas and service logic
- `playwright`: end-to-end tests once the shell can launch

## Phase 2: Electron Shell

- `electron-context-menu`: desktop context menus
- `electron-dl`: controlled downloads
- `@sentry/electron`: renderer and main process crash/error reporting
- `@sentry/node`: Node service error reporting if TypeScript services move outside Electron main

## Phase 3: Local State

- `better-sqlite3`: local operational database for settings, recent projects, jobs, conversation indexes, and generated cache metadata
- `zod`: validates database records before they cross service boundaries
- Development fallback: when `better-sqlite3` native bindings are unavailable on Node 24, the Electron shell uses `node:sqlite` so Phase 3 can keep moving. Packaged builds should still prefer `better-sqlite3` once the native build toolchain or matching prebuild is present.

## Phase 4: Terminal and Streaming

- `@xterm/xterm`: terminal UI
- `@xterm/addon-fit`: terminal resize behavior
- `node-pty`: shell process creation in Electron main
- `ws`: optional stream protocol for terminal, logs, and long-running AI tasks

## Phase 5: UI Polish

- `framer-motion`: restrained transitions for panels, dialogs, progress, and task state changes
- `mime-types`: attachment, import, and export content-type detection
