# Runtime Modules

This folder contains the local TypeScript runtime gateway building blocks used by
`runtime-server.ts`.

## Route Modules

- `base-routes.ts`: health, license, config
- `project-document-routes.ts`: project session, documents, tree/chrome, timeline, ledger, revision log
- `agent-routes.ts`: agent execute/plan/run/run-stream
- `skill-routes.ts`: skills catalog, import/upload, draft-from-url, run
- `conversation-routes.ts`: conversations, attachments, summaries, message streaming
- `generated-cache-routes.ts`: generated save/commit/discard/cleanup
- `vector-routes.ts`: vector status, rebuild, incremental processing, search
- `job-routes.ts`: local job probe, list, create, detail, cancel

## Shared Utilities

- `types.ts`: runtime host/port/url and runtime context/state types
- `http-utils.ts`: JSON body parsing, request field parsing, NDJSON/JSON writers, multipart parsing
- `route-matchers.ts`: pathname-to-route helpers
- `runtime-helpers.ts`: project session lookup, document session lifecycle, manifest rebuild

## Usage

`runtime-server.ts` is the composition root. It owns server startup/shutdown,
constructs the runtime context, and delegates requests into these modules.
