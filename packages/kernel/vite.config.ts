import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// ESM 轨构建：preserveModules 保 tree-shaking；zod 外置。
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
      external: [/^zod(\/|$)/],
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
