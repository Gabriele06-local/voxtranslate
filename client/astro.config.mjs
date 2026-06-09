import { defineConfig } from 'astro/config';

// Static client. The WebSocket server runs separately (see PUBLIC_WS_HOST).
export default defineConfig({
  server: {
    port: 4321,
    host: true,
  },
  // The floating dev toolbar overlaps the bottom control bar; not shipped in builds.
  devToolbar: { enabled: false },
});
