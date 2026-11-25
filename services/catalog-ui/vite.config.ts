import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The page is built into `dist/web`, which express serves as static files.
 *
 * In development `/api` is proxied to a catalog-ui server on `localhost:8080`,
 * started separately, so the page talks to its own origin there as it does in
 * the container, and never to the catalog or to prospector.
 */
export default defineConfig({
  root:    'web',
  plugins: [react()],
  build:   { outDir: '../dist/web', emptyOutDir: true },
  server:  { proxy: { '/api': 'http://localhost:8080' } },
});
