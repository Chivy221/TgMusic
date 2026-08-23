import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Через туннель (cloudflared/ngrok) хост приходит чужой — разрешаем любой.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
