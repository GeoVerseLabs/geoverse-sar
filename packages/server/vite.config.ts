import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// ESM 轨构建：Node-only 薄层，node 内置与 ws、kernel 全部外置。
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
      external: [/^node:/, /^ws(\/|$)/, /^zod(\/|$)/, /^@geoverse-sar\//],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      include: ['src'],
      bundleTypes: false,
    }),
  ],
});
