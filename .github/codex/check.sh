#!/usr/bin/env bash
set -euo pipefail
: "${CORE_TEST_DATABASE_URL:?Missing isolated core database}"
: "${WORKER_TEST_DATABASE_URL:?Missing isolated worker database}"
pnpm install --frozen-lockfile
pnpm -r --if-present build
pnpm -r --if-present typecheck
pnpm -r --if-present test
# Preserve existing database fixture initialization before health/startup and test discovery.
pnpm --filter @oh-bot/companion test:integration
# Health/startup deliberately refuse an uninitialized pg-boss schema.
COMPANION_DATABASE_URL="$CORE_TEST_DATABASE_URL" COMPANION_WORKER_QUEUE_SETUP=1 pnpm --dir packages/companion exec node dist/worker.js
pnpm --filter @oh-bot/companion test:health
pnpm --filter @oh-bot/companion test:startup
# Discover all companion tests, including files added by a task; database suites remain sequential.
(
  cd packages/companion
  mapfile -d '' tests < <(find test -type f -name '*.test.ts' -print0)
  test "${#tests[@]}" -gt 0
  pnpm exec tsx --test --test-concurrency=1 "${tests[@]}"
)
pnpm codex:check
