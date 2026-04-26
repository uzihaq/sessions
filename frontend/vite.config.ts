import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PRETTYD_HOST = process.env.PRETTYD_HOST ?? '127.0.0.1';
const PRETTYD_PORT = process.env.PRETTYD_PORT ?? '8787';
const PRETTYD_HTTP = `http://${PRETTYD_HOST}:${PRETTYD_PORT}`;
const PRETTYD_WS = `ws://${PRETTYD_HOST}:${PRETTYD_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 5173),
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
