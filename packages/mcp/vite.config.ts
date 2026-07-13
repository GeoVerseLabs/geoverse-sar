import { defineConfig } from 'vite';
import { strictDts } from '../../build/strict-dts';

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
      external: [/^zod(\/|$)/, /^@geoverse-sar\//, /^@modelcontextprotocol\//],
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
  plugins: [strictDts()],
});
