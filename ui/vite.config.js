import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产物被根目录的 server.mjs 以静态文件形式托管，因此 base 用根路径。
// 开发期由 vite dev server 代理 /api 到本地服务，避免跨端口。
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 本地工具，不需要 sourcemap 进产物
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7801', changeOrigin: false },
      '/preview': { target: 'http://127.0.0.1:7801', changeOrigin: false }
    }
  }
});
