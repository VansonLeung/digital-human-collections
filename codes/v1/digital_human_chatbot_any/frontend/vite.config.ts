import { defineConfig, loadEnv } from 'vite';
export default defineConfig(() => {
  const env = loadEnv('', '..', 'APP_');
  return {
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${env.APP_PORT || 8000}`, ws: true } },
    },
    build: { chunkSizeWarningLimit: 1100 },
  };
});
