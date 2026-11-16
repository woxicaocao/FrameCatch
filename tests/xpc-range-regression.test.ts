import { expect, it } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createEngine } from '../electron/engine';
import { importChromeRequest } from '../electron/request-import';

const bin = path.resolve('resources/bin');
const canRun = ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe'].every(name => existsSync(path.join(bin, name)));
async function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    const timer = setTimeout(() => child.kill(), 15000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`媒体夹具命令失败：${stderr}`)); });
  });
}

it.skipIf(!canRun)('本地真实HTTP夹具复现新片场Range要求；无上下文、导入上下文及重试均请求完整MP4', async () => {
  const root = path.resolve('.test-artifacts', `xpc-range-regression-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
  await fs.mkdir(root, { recursive: true });
  const source = path.join(root, 'fixture.mp4');
  await run(path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.25', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-movflags', '+faststart', source]);
  const bytes = await fs.readFile(source);
  const requests: Array<{ host: string; range?: string; userAgent?: string; authHeader: boolean; blocked: boolean }> = [];
  let blockMedia = false;
  // This local server acts as an HTTP proxy, letting yt-dlp request a synthetic
  // xpccdn.com URL without DNS changes, external traffic or a broad whitelist.
  const server = createServer((request, response) => {
    const host = request.headers.host || '';
    const isXpc = host === 'fixture.xpccdn.com';
    requests.push({ host, range: request.headers.range, userAgent: request.headers['user-agent'], authHeader: Boolean(request.headers.authorization || request.headers['proxy-authorization']), blocked: isXpc && blockMedia });
    if (request.headers.range !== 'bytes=0-' || (isXpc && blockMedia)) { response.writeHead(403, { 'Content-Type': 'text/plain' }); response.end('Complete-resource Range required'); return; }
    response.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, 'Content-Length': bytes.length });
    if (request.method === 'HEAD') response.end(); else response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('夹具服务器未启动');
  const proxy = `http://127.0.0.1:${address.port}`;
  const url = 'http://fixture.xpccdn.com/complete.mp4?token=SYNTHETIC_ONLY';
  const engine = await createEngine({ portableRoot: path.join(root, 'portable'), binDir: bin });
  try {
    const withoutRange = await fetch(`${proxy}/complete.mp4`);
    expect(withoutRange.status).toBe(403); await withoutRange.text();
    const withRange = await fetch(`${proxy}/complete.mp4`, { headers: { Range: 'bytes=0-' } });
    expect(withRange.status).toBe(206); expect((await withRange.arrayBuffer()).byteLength).toBe(bytes.length);
    await engine.saveSettings({ ...engine.getSettings(), proxy });
    const ordinary = await engine.analyze(url);
    expect(ordinary.entries).toHaveLength(1);
    await expect(engine.analyze('http://xpccdn.com.evil.test/complete.mp4')).rejects.toThrow('网站拒绝');
    const imported = await importChromeRequest(`curl '${url}' -H 'Referer: https://www.xinpianchang.com/a13856092' -H 'User-Agent: XPC-Regression/1' -H 'Origin: https://www.xinpianchang.com' -H 'Range: bytes=0-100' -b 'fixture_cookie=synthetic'`, { portableRoot: path.join(root, 'portable'), proxy });
    const captured = await engine.analyze(imported.url, imported.context);
    expect(captured.entries).toHaveLength(1);
    blockMedia = true;
    const [created] = await engine.enqueue([{ video: captured.entries[0], formatId: 'best', formatLabel: '最高画质' }]);
    async function terminal() {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const task = engine.getTasks().find(item => item.id === created.id)!;
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status) && !engine.isBusy()) return task;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('夹具下载任务未能结束');
    }
    expect((await terminal()).status).toBe('failed');
    blockMedia = false;
    await engine.retryTask(created.id);
    const completed = await terminal();
    expect(completed.status).toBe('completed');
    expect(await fs.readFile(completed.outputPath!)).toEqual(bytes);
    const probe = JSON.parse(await run(path.join(bin, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completed.outputPath!]));
    expect(probe.streams.some((item: { codec_type: string }) => item.codec_type === 'video')).toBe(true);
    expect(probe.streams.some((item: { codec_type: string }) => item.codec_type === 'audio')).toBe(true);
    expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(1.2);
    const xpc = requests.filter(request => request.host === 'fixture.xpccdn.com');
    expect(xpc.length).toBeGreaterThanOrEqual(4);
    expect(xpc.every(request => request.range === 'bytes=0-')).toBe(true);
    expect(xpc.some(request => request.blocked)).toBe(true);
    expect(requests.find(request => request.host === 'xpccdn.com.evil.test')?.range).toBeUndefined();
    expect(requests.every(request => !request.authHeader)).toBe(true);
    expect(requests.some(request => request.range === 'bytes=0-100')).toBe(false);
    await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ requests, completed: true, duration: probe.format.duration, bytes: bytes.length, streams: probe.streams.map((item: { codec_type: string }) => item.codec_type) }, null, 2));
  } finally {
    await engine.stopAll();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60000);
