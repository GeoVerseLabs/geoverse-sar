import { defineConfig } from 'vite';
import { strictDts } from '../../build/strict-dts';

// ESM 轨构建：preserveModules 保 tree-shaking；kernel 外置（peer 由 workspace 协议链接）。
export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: 'hidden',
    minify: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^zod(\/|$)/, /^@geoverse-sar\//],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [strictDts()],
});
