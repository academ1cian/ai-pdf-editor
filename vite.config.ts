import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
let revision = 'local-unpublished';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { /* source archive / unborn checkout */ }
export default defineConfig({
  plugins: [react()],
  define: {'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(revision)},
  build: { target: 'esnext' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['mupdf'] },
});
