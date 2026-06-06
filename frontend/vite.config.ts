import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PRETTYD_HOST = process.env.PRETTYD_HOST ?? '127.0.0.1';
const PRETTYD_PORT = process.env.PRETTYD_PORT ?? '8787';
const PRETTYD_HTTP = `http://${PRETTYD_HOST}:${PRETTYD_PORT}`;
const PRETTYD_WS = `ws://${PRETTYD_HOST}:${PRETTYD_PORT}`;

const VITE_HOST = process.env.VITE_HOST ?? '127.0.0.1';
const ANY_BIND = new Set(['0.0.0.0', '::', '::0', '*']);
if (ANY_BIND.has(VITE_HOST) || ANY_BIND.has(PRETTYD_HOST)) {
  // Hard fail before Vite even starts. We never bind to any-interface;
  // for tailnet access, set the env var to your specific tailnet IP.
  throw new Error(
    `pretty-PTY config: ${ANY_BIND.has(VITE_HOST) ? 'VITE_HOST' : 'PRETTYD_HOST'} ` +
    `is set to ${ANY_BIND.has(VITE_HOST) ? VITE_HOST : PRETTYD_HOST}, which is rejected. ` +
    `Use a specific address (127.0.0.1 for loopback, or a 100.x.y.z tailnet IP).`
  );
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: VITE_HOST,
    // 5273 (not 5173) so pretty-PTY can run alongside pretty-tmux,
    // which is still on the default :5173 until Phase 5.
    port: Number(process.env.VITE_PORT ?? 5273),
    strictPort: false,
    proxy: {
      '/api': { target: PRETTYD_HTTP, changeOrigin: true },
      '/ws': { target: PRETTYD_WS, ws: true, changeOrigin: true }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['xterm', '@xterm/addon-fit']
        }
      }
    }
  }
});
