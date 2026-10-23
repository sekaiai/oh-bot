#!/bin/sh
set -eu
node --import tsx packages/companion/src/cli/operations.ts backup --output "${BACKUP_OUTPUT:?set BACKUP_OUTPUT}" --deletion-journal "${DELETION_JOURNAL_PATH:?set DELETION_JOURNAL_PATH}" --deletion-sequence "${DELETION_JOURNAL_SEQUENCE:?set DELETION_JOURNAL_SEQUENCE}" --asset "${MEM0_HISTORY_PATH:?set MEM0_HISTORY_PATH}"
node --import tsx packages/companion/src/database/migrate-cli.ts
