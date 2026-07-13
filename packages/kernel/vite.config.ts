import { defineConfig } from 'vite';
import { strictDts } from '../../build/strict-dts';

// ESM 轨构建：preserveModules 保 tree-shaking；zod 外置。
// store-idb / store-file 是环境特定存储适配器（浏览器 / Node-only），
// client-remote 是远程 SarClient（需 fetch/WebSocket，选装）——
// 均走独立子入口不进主入口（package.json exports 同步声明）。
export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: 'hidden',
    minify: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        'store-idb': 'src/store-idb.ts',
        'store-file': 'src/store-file.ts',
        'client-remote': 'src/client-remote.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^zod(\/|$)/, /^node:/],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [strictDts()],
});
