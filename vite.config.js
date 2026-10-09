import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Port API dibaca dari .env di root proyek (APP_PORT), sama seperti server.
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.APP_PORT || 3000);
  return {
    root: 'web',
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
    },
  };
});
