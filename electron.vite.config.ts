import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: { '@shared': resolve('src/shared') } } },
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }, resolve: { alias: { '@shared': resolve('src/shared') } } },
  renderer: { root: 'src/renderer', resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } }, plugins: [react()] }
});
