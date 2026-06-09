import { defineConfig } from 'astro/config';

// Static client. The WebSocket server runs separately (see PUBLIC_WS_HOST).
export default defineConfig({
  server: {
    port: 4321,
    host: true,
  },
});
