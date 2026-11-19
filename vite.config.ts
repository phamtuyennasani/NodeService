import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3210',
      '/v1': 'http://127.0.0.1:3210',
      '/widget': 'http://127.0.0.1:3210',
    },
  },
});
