import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createEngine } from '../electron/engine';
import { importChromeRequest } from '../electron/request-import';
import { mediaKind } from '../electron/browser-helper-utils';

it('旧捕获、cURL及内置窗口均拒绝受保护范围MP4，重试不碰保留文件', async () => {
  const root = await fs.mkdtemp(path.resolve('.test-artifacts/range-entry-regression-'));
  const url = 'https://vod-adaptive-ak.vimeocdn.com/exp=SYNTHETIC/v2/range/prot/ENCODED/avf/movie.mp4?range=500-999&pathsig=SYNTHETIC';
  const id = 'retained-range-task';
  const workDir = path.join(root, 'data/work', id);
  await fs.mkdir(workDir, { recursive: true });
  const retained = path.join(workDir, 'media.mp4');
  await fs.writeFile(retained, 'retained-fragment-evidence');
  const context = { referer: 'https://vimeo.com/123', userAgent: 'Regression/1', proxy: '' };
  const stamp = new Date().toISOString();
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify({ version: 1, portableRoot: root,
    settings: { outputDir: path.join(root, 'Downloads'), cookiePath: '', proxy: '' },
    tasks: [{ id, video: { id: 'movie', title: '范围片段', url, platform: 'Generic', formats: [], mediaContext: context }, formatId: 'best', formatLabel: '最高画质', status: 'failed', progress: {}, createdAt: stamp, updatedAt: stamp, workDir, outputDir: path.join(root, 'Downloads') }] }));
  let spawns = 0;
  const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => { spawns++; throw new Error('不得下载局部文件'); } });
  await expect(engine.analyze(url, context)).rejects.toThrow('局部字节区间');
  await expect(engine.retryTask(id)).rejects.toThrow('局部字节区间');
  await expect(importChromeRequest(`curl '${url}' -H 'Referer: https://vimeo.com/123' -H 'User-Agent: Regression/1'`, { portableRoot: root, proxy: '' })).rejects.toThrow('局部字节区间');
  expect(mediaKind(url, 'video/mp4', 'xhr')).toBeUndefined();
  expect(mediaKind('https://vod-adaptive-ak.vimeocdn.com/v2/playlist/av/playlist.json?sig=keep', 'application/json', 'xhr')).toBe('dash');
  expect(spawns).toBe(0);
  expect(engine.getTasks()[0].status).toBe('failed');
  expect(await fs.readFile(retained, 'utf8')).toBe('retained-fragment-evidence');
  await engine.stopAll();
});
