import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts', 'src/worker.ts', 'src/cli/chat.ts'],
  format: ['esm'],
  dts: true,
  target: 'node24',
  clean: true,
});
