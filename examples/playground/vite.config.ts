import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const src = (pkg: string) => here(`../../packages/${pkg}/src/index.ts`);
/** .env 在仓根（gitignored）：DEEPSEEK_API_KEY 只进 dev 代理，不进浏览器 bundle。 */
const envDir = here('../..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  const apiKey = env.DEEPSEEK_API_KEY ?? '';
  return {
    root: here('.'),
    envDir,
    plugins: [vue()],
    server: {
      port: 8090,
      open: true,
      fs: {
        // file: 链接的 geoverse 包（core-ol/editor-core）在仓外，须显式放行
        allow: [here('../..'), here('../../../geoverse')],
      },
      proxy: {
        // 浏览器只打 /api/deepseek/*，Authorization 由 dev 代理注入——密钥永不出现在前端
        '/api/deepseek': {
          target: 'https://api.deepseek.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/deepseek/, ''),
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: here('index.html'),
          chat: here('chat.html'),
          geo: here('geo.html'),
          agent: here('agent.html'),
        },
      },
    },
    resolve: {
      alias: {
        // 子路径 alias 必须在裸包名之前：对象形式按插入序前缀匹配，
        // 否则 '@geoverse-sar/kernel/store-idb' 会被裸包项改写成 …/index.ts/store-idb
        '@geoverse-sar/kernel/store-idb': here('../../packages/kernel/src/store-idb.ts'),
        '@geoverse-sar/kernel': src('kernel'),
        '@geoverse-sar/workspace': src('workspace'),
        '@geoverse-sar/engine-memory': src('engine-memory'),
        '@geoverse-sar/capabilities-records': src('capabilities-records'),
        '@geoverse-sar/capabilities-geo': src('capabilities-geo'),
        '@geoverse-sar/engine-geo': src('engine-geo'),
        '@geoverse-sar/skill': src('skill'),
        '@geoverse-sar/planner': src('planner'),
        '@geoverse-sar/agent': src('agent'),
      },
    },
  };
});
