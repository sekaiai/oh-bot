# AGENTS.md

## Project Overview

`oh-bot` is a NapCat/OneBot based QQ bot middleware with a separate admin frontend.

Main areas:

- `src/index.ts`: process bootstrap, WS connection, inbound message handling, outbound send path
- `src/services/reply-engine.ts`: reply decision and orchestration
- `src/services/tool-router.ts`: plugin and tool dispatch
- `src/services/ai-client.ts`: OpenAI-compatible model calls and intent classification
- `src/services/data-repository.ts`: JSON-backed config and runtime data loading/saving
- `src/admin/server.ts`: admin API
- `admin/src/*`: Vue 3 admin frontend

## Useful Commands

- `pnpm dev` or `pnpm dev:bot`: run the bot in watch mode
- `pnpm admin:dev` or `pnpm dev:admin`: run the admin frontend
- `pnpm build`: build the bot backend
- `pnpm admin:build`: build the admin frontend
- `pnpm check`: run the main verification pass for both backend and admin
- `pnpm codex:doctor`: inspect env, runtime data, and plugin configuration health
- `pnpm codex:check`: run build verification plus the doctor pass

Before finishing meaningful code changes, prefer running:

```bash
pnpm codex:check
```

## Runtime Data

These files are local runtime data, not normal source-of-truth code:

- `data/sessions.json`
- `data/plugins/*.json`
- `data/rules.json`
- `data/personas.json`

Read them when needed for debugging or feature work, but avoid rewriting or committing runtime-only changes unless the task is specifically about seed data or config defaults.

## Plugin Notes

Current built-in plugins:

- `qweather`: weather and location-based tool requests
- `ds2api`: routed AI requests
- `qingmeng`: grouped media/tool endpoints with intent routing

Plugin persistence is JSON-based under `data/plugins/`.
Defaults and normalization logic live in `src/services/data-repository.ts`.

## Media Sending Notes

Qingmeng media delivery is sensitive to deployment topology.

- `NAPCAT_MEDIA_SEND_MODE=base64` is the safest default when the bot and NapCat are not sharing the same filesystem
- `NAPCAT_MEDIA_SEND_MODE=local_path|file_url` requires a shared readable path, usually with `NAPCAT_MEDIA_TEMP_DIR`

If QQ media is "sent" in logs but not visible in chat, check filesystem visibility between the bot process and NapCat container first.

## Change Discipline

- Prefer small, scoped commits by feature area
- 本仓库所有 git commit message 必须使用中文
- Do not commit `data/sessions.json` unless explicitly requested
- Keep admin type definitions in sync with backend types and validators when changing plugin schemas
- If you touch routing logic, verify both direct intent matches and fallback behavior
