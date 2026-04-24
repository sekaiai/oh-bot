import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 10032,
    proxy: {
      '/admin': {
        target: 'http://127.0.0.1:3100',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
});
