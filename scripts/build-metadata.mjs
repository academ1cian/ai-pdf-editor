import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
let commit = process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || 'local-unpublished';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* unborn local checkout */
}
await writeFile(
  'public/version.json',
  JSON.stringify({ product: 'AI PDF Editor', commit }, null, 2) + '\n',
);
await mkdir('public/licenses', { recursive: true });
await copyFile('LICENSE', 'public/licenses/AGPL-3.0.txt');
for (const [source, destination] of [
  ['react/LICENSE', 'React-MIT.txt'],
  ['react-dom/LICENSE', 'React-DOM-MIT.txt'],
  ['zod/LICENSE', 'Zod-MIT.txt'],
  ['lucide-react/LICENSE', 'Lucide-ISC.txt'],
  ['@fontsource/dm-sans/LICENSE', 'DM-Sans-OFL.txt'],
  ['@fontsource/manrope/LICENSE', 'Manrope-OFL.txt'],
  ['tesseract.js/LICENSE.md', 'Tesseract-Apache-2.0.txt'],
])
  await copyFile(`node_modules/${source}`, `public/licenses/${destination}`);

await copyFile('src/assets/fonts/OFL.txt', 'public/licenses/Noto-Sans-OFL.txt');
