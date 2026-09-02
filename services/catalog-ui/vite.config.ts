import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The page is built into `dist/web`, which express serves as static files.
 *
 * `/api` is proxied in development so `pnpm dev` behaves like the container
 * does: the page always talks to its own origin and never to the catalog, which
 * is what keeps the token out of the browser.
 */
export default defineConfig({
  root:    'web',
  plugins: [react()],
  build:   { outDir: '../dist/web', emptyOutDir: true },
  server:  { proxy: { '/api': 'http://localhost:8080' } },
});
