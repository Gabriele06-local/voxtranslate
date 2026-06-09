import { defineConfig } from 'astro/config';

// Static client. The WebSocket server runs separately (see PUBLIC_WS_HOST).
// COVERAGE=1 produces an un-minified build with sourcemaps so Playwright V8
// coverage maps back to src/scripts/*.ts.
const coverage = process.env.COVERAGE === '1';

export default defineConfig({
  server: {
    port: 4321,
    host: true,
  },
  // The floating dev toolbar overlaps the bottom control bar; not shipped in builds.
  devToolbar: { enabled: false },
  vite: {
    build: {
      sourcemap: coverage ? 'inline' : false,
      minify: coverage ? false : 'esbuild',
    },
  },
});
