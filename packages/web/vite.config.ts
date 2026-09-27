import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` and `/ws` to the API process so the browser only
 * ever talks to one origin; this keeps the httpOnly session cookie first-party.
 */
const API_TARGET = 'http://localhost:4000';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2020',
  },
});
