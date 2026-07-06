import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

// dev/build 都指向包源码：改源码即时热更新，不依赖 dist 新鲜度
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { port: 8090, open: true },
  resolve: {
    alias: {
      '@geoverse-sar/kernel': src('kernel'),
      '@geoverse-sar/engine-memory': src('engine-memory'),
      '@geoverse-sar/capabilities-records': src('capabilities-records'),
      '@geoverse-sar/skill': src('skill'),
    },
  },
});
