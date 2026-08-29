import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Admin dashboard (Phase 11). Relative base ('./') keeps the built app
// portable: Express serves it at /admin, Vercel serves the same build at /.
// In dev, the Vite server proxies /api to the local API on :3000.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
