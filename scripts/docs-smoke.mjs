import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = readdirSync(resolve(root, 'docs'))
  .filter((file) => file.endsWith('.md') && file !== 'README.md')
  .map((file) => `docs/${file}`);

function readSnippetSource(reference) {
  return readFileSync(resolve(root, reference), 'utf8').replace(/\r\n/g, '\n').trim();
}

function extractSmokeBlocks(text, file) {
  const marker = /<!--\s*docs-smoke:\s*([^\s]+)\s*-->/g;
  const snippets = [];
  let match;
  while ((match = marker.exec(text))) {
    const afterMarker = text.slice(marker.lastIndex);
    const fence = afterMarker.match(/^\s*```(?:ts|typescript)\s*\n([\s\S]*?)\n```/);
    if (!fence) {
      throw new Error(`${file}: docs-smoke 标记后必须紧跟 ts fenced code block`);
    }
    snippets.push({ source: match[1], code: fence[1].trim() });
    marker.lastIndex += fence[0].length;
  }
  return snippets;
}

const seen = new Set();
for (const doc of docs) {
  const text = readFileSync(resolve(root, doc), 'utf8').replace(/\r\n/g, '\n');
  for (const snippet of extractSmokeBlocks(text, doc)) {
    if (seen.has(snippet.source)) {
      throw new Error(`docs-smoke 片段重复引用：${snippet.source}`);
    }
    seen.add(snippet.source);
    const expected = readSnippetSource(snippet.source);
    if (snippet.code !== expected) {
      throw new Error(
        `${doc}: 代码块与 ${snippet.source} 不一致；请从测试源重新同步，而不是手改其中一份。`,
      );
    }
  }
}

if (seen.size === 0) throw new Error('未发现任何 docs-smoke 片段');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(
  pnpm,
  ['--filter', '@geoverse-sar/eval', 'test', '--', 'docs-smoke.test.ts'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`docs-smoke: ${seen.size} 个 Living Doc 片段与测试源同步且执行通过`);
