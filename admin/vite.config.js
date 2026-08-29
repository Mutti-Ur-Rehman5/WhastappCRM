import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Admin dashboard (Phase 11). `base: '/admin/'` matches where the Express app
// serves the built app, so asset URLs work in production. In dev, the Vite
// server proxies /api to the local API on :3000.
export default defineConfig({
  base: '/admin/',
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
