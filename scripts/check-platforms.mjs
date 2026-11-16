// Optional live integration check. It records failures honestly and does not
// change the user's normal settings or need authenticated accounts.
import { build } from 'esbuild';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = process.cwd();
const output = path.join(root, '.test-artifacts', `platforms-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const bundle = path.join(output, 'engine.cjs');
await build({ entryPoints: ['electron/engine.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { createEngine } = createRequire(import.meta.url)(bundle);
const samples = [
  ['B站', 'https://www.bilibili.com/video/BV13x41117TL'],
  ['YouTube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
  ['Vimeo', 'https://vimeo.com/76979871'],
  ['新片场', 'https://www.xinpianchang.com/a11766551'],
];
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
const download = process.argv.includes('--download');
const results = await Promise.all(samples.filter(([platform]) => !only || only.includes(platform)).map(async ([platform, url], index) => {
  const engine = await createEngine({ portableRoot: path.join(output, `case-${index}`), binDir: path.join(root, 'resources/bin') });
  if (process.env.FRAMECATCH_CHECK_PROXY) await engine.saveSettings({ ...engine.getSettings(), proxy: process.env.FRAMECATCH_CHECK_PROXY });
  const timer = setTimeout(() => void engine.cancelAnalysis(), 90000);
  const started = Date.now();
  try {
    const result = await engine.analyze(url);
    const item = { platform, url, success: true, title: result.title, entries: result.entries.length, formats: result.entries[0].formats.length, duration: result.entries[0].duration, warnings: result.warnings, elapsedMs: Date.now() - started };
    console.log(`${platform}：解析通过，${item.formats} 个画质选项`);
    if (download) {
      const [created] = await engine.enqueue([{ video: result.entries[0], formatId: 'best', formatLabel: '最高画质' }]);
      const deadline = Date.now() + 240000;
      let task;
      while (Date.now() < deadline) {
        task = engine.getTasks().find(task => task.id === created.id);
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      item.download = { status: task.status, error: task.error, outputPath: task.outputPath, bytes: task.outputPath ? (await stat(task.outputPath)).size : undefined };
      console.log(`${platform}：真实下载${task.status === 'completed' ? '通过' : '未通过'}${task.error ? `，${task.error}` : ''}`);
    }
    return item;
  } catch (error) {
    const item = { platform, url, success: false, error: error.message, elapsedMs: Date.now() - started };
    console.log(`${platform}：未通过，${item.error}`);
    return item;
  } finally { clearTimeout(timer); await engine.stopAll(); }
}));
await writeFile(path.join(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), authenticated: false, proxyConfigured: Boolean(process.env.FRAMECATCH_CHECK_PROXY), results, note: '仅验证上述样例的真实解析，不代表整个站点持续可用；Behance尚无用户作品链接实测。' }, null, 2));
console.log(`平台联调记录：${output}`);
