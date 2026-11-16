import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [directory, metadata] of Object.entries(lock.packages)) {
  if (!directory || metadata.dev || directory.includes('/node_modules/')) continue;
  let license;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try { license = await readFile(path.join(directory, name), 'utf8'); break; } catch {}
  }
  if (!license) throw new Error(`无法找到生产依赖的许可证：${directory}`);
  notices.push(`${directory.replace('node_modules/', '')} ${metadata.version}\n${'='.repeat(60)}\n${license}`);
}
await mkdir('resources/licenses', { recursive: true });
await writeFile('resources/licenses/frontend-THIRD-PARTY.txt', notices.join('\n\n'));
await copyFile('LICENSE', 'resources/licenses/FrameCatch-LICENSE.txt');
console.log(`已收集 ${notices.length} 个生产依赖的许可证。`);
