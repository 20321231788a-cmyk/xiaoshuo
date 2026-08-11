# Current API Inventory

This inventory mirrors the current `agent_backend/app.py` FastAPI surface and gives the TypeScript migration a stable checklist.

## Core

- `GET /api/health`
- `POST /api/app/shutdown`

## License and Config

- `GET /api/license/status`
- `POST /api/license/account-key`
- `GET /api/config`
- `PUT /api/config`
- `POST /api/config`

## Projects and Documents

- `POST /api/projects/open`
- `POST /api/projects/create`
- `POST /api/projects/pick`
- `GET /api/projects/current`
- `PUT /api/projects/current`
- `GET /api/documents`
- `GET /api/project/tree`
- `GET /api/project/tree/subtree`
- `GET /api/project/chrome`
- `GET /api/project/manifest/status`
- `GET /api/libraries`
- `GET /api/documents/{rel_path}`
- `PUT /api/documents/{rel_path}`

## AI, Agent, Skills

- `GET /api/skills`
- `GET /api/skills/{skill_id}`
- `POST /api/skills/import`
- `POST /api/skills/open-folder`
- `POST /api/skills/upload`
- `POST /api/skills/draft-from-url`
- `POST /api/skills/import-draft`
- `POST /api/skills/{skill_id}/run`
- `POST /api/agent/plan`
- `POST /api/agent/run`
- `POST /api/agent/run-stream`
- `POST /api/agent/generated/save`
- `GET /api/agent/generated/cache/{cache_id}`
- `POST /api/agent/generated/cache/{cache_id}/commit`
- `DELETE /api/agent/generated/cache/{cache_id}`
- `POST /api/agent/generated/cache/cleanup`
- `POST /api/agent/execute`

## Conversations

- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/{conversation_id}`
- `PUT /api/conversations/{conversation_id}`
- `POST /api/conversations/{conversation_id}/messages`
- `POST /api/conversations/{conversation_id}/attachments`
- `DELETE /api/conversations/{conversation_id}/attachments/{attachment_id}`
- `POST /api/conversations/{conversation_id}/pin-context`
- `DELETE /api/conversations/{conversation_id}/pin-context`
- `DELETE /api/conversations/{conversation_id}/pin-context/{item_id}`
- `POST /api/conversations/{conversation_id}/summarize`

## Jobs and Tools

- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/jobs/{job_id}`
- `POST /api/jobs/{job_id}/cancel`
- `GET /api/vector/status`
- `POST /api/vector/rebuild`
- `POST /api/vector/process-pending`
- `POST /api/vector/search`
- `GET /api/embedding/config`
- `PUT /api/embedding/config`
- `POST /api/embedding/test`

## Project Utilities

- `GET /api/continuity/context`
- `GET /api/ledger`
- `POST /api/ledger`
- `POST /api/ledger/toggle`
- `GET /api/revision-log`
- `DELETE /api/revision-log`
- `GET /api/timeline`
- `GET /api/timeline/{entry_id}`
- `DELETE /api/timeline/{entry_id}`
- `POST /api/timeline/{entry_id}/rollback`
- `POST /api/card-draw/{draw_id}/select`
