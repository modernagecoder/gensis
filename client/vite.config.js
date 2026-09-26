import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const API_TARGET = `http://localhost:${process.env.API_PORT || 3001}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.CLIENT_PORT || 5188),
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/games': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/screenshots': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
