#!/usr/bin/env bash
set -euo pipefail

# These variables point only at the job's disposable PostgreSQL service.
: "${CORE_TEST_DATABASE_URL:?Missing isolated core database}"
: "${WORKER_TEST_DATABASE_URL:?Missing isolated worker database}"
pnpm --filter @oh-bot/companion typecheck
pnpm --filter @oh-bot/companion build
pnpm --filter @oh-bot/companion test
# Keep database-mutating suites sequential.
pnpm --filter @oh-bot/companion test:integration
pnpm --filter @oh-bot/companion test:health
pnpm --filter @oh-bot/companion test:startup
pnpm codex:check
