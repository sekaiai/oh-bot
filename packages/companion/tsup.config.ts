import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts', 'src/worker.ts', 'src/cli/chat.ts', 'src/cli/start.ts', 'src/cli/model-smoke.ts', 'src/cli/operations.ts', 'src/database/migrate-cli.ts', 'src/application/restore-replay-adapter.ts'],
  format: ['esm'],
  dts: true,
  target: 'node24',
  clean: true,
});
