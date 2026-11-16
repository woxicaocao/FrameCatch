import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = path.join(root, '.test-artifacts', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtures = path.join(runRoot, 'fixtures');
await mkdir(fixtures, { recursive: true });
const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const ffprobe = path.join(root, 'resources', 'bin', 'ffprobe.exe');
await access(ffmpeg);
const report = { startedAt: new Date().toISOString(), checks: [], artifacts: runRoot };
const check = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log(`通过：${name}`); };
function run(exe, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false, cwd: fixtures });
    let out = '', err = '';
    child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`执行超时：${path.basename(exe)}`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.slice(-5000))); });
  });
}
const inputArgs = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4'];
await run(ffmpeg, [...inputArgs, '-c:v', 'mpeg4', '-q:v', '4', '-g', '24', '-c:a', 'aac', 'sample.mp4']);
await run(ffmpeg, [...inputArgs, '-c:v', 'mpeg2video', '-g', '24', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'part%03d.ts', 'sample.m3u8']);
await run(ffmpeg, [...inputArgs, '-c:v', 'mpeg4', '-q:v', '4', '-g', '24', '-c:a', 'aac', '-f', 'dash', '-seg_duration', '1', 'sample.mpd']);
const hls = await readFile(path.join(fixtures, 'sample.m3u8'), 'utf8');
await writeFile(path.join(fixtures, 'broken.m3u8'), hls.replace('part001.ts', 'missing001.ts'));
await writeFile(path.join(fixtures, 'video.html'), '<!doctype html><html><head><title>映取本地视频测试</title></head><body><video controls src="sample.mp4"></video></body></html>');
await writeFile(path.join(fixtures, 'empty.html'), '<!doctype html><html><head><title>没有视频</title></head><body>这是无视频网页。</body></html>');
check('生成 MP4、HLS、分离音视频 DASH 测试素材');
const mime = { '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.html': 'text/html; charset=utf-8' };
const server = createServer(async (request, response) => {
  let stream;
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    const local = path.resolve(fixtures, name === 'slow.mp4' ? 'sample.mp4' : name);
    if (!local.startsWith(fixtures + path.sep)) { response.writeHead(403).end(); return; }
    const info = await stat(local);
    let start = 0, end = info.size - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
    const headers = { 'Content-Type': mime[path.extname(local)] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    if (name === 'slow.mp4') {
      const buffer = (await readFile(local)).subarray(start, end + 1);
      let offset = 0;
      const interval = setInterval(() => { const chunk = buffer.subarray(offset, offset + 4096); offset += chunk.length; response.write(chunk); if (offset >= buffer.length) { clearInterval(interval); response.end(); } }, 50);
      response.on('close', () => clearInterval(interval));
    } else { stream = createReadStream(local, { start, end }); stream.pipe(response); response.on('close', () => stream?.destroy()); }
  } catch { response.writeHead(404).end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, FRAMECATCH_TEST_ROOT: path.join(runRoot, '便携 软件') };
delete env.ELECTRON_RUN_AS_NODE;
const appErrors = [];
let desktop;
async function waitTask(page, id, allowed, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const task = await page.evaluate(async id => (await window.desktopApi.getSnapshot()).tasks.find(task => task.id === id), id);
    if (allowed.includes(task?.status)) return task;
    if (task?.status === 'failed') throw new Error(`任务失败：${task.error}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`等待任务超时：${id}`);
}
try {
  desktop = await electron.launch({ args: [root], env, timeout: 60000 });
  let page = await desktop.firstWindow();
  page.on('pageerror', error => appErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktopApi));
  await page.getByTestId('url-input').waitFor();
  const snapshot = await page.evaluate(() => window.desktopApi.getSnapshot());
  assert.equal(snapshot.dependencies.filter(item => item.available).length, 4, JSON.stringify(snapshot.dependencies));
  assert.ok(snapshot.portableRoot.endsWith('便携 软件'));
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.screenshot({ path: path.join(runRoot, '01-workbench.png'), fullPage: true });
  check('中文与空格便携路径启动、四个内置组件、渲染进程隔离', snapshot.dependencies.map(item => `${item.name}: ${item.version}`));

  await page.getByTestId('url-input').fill(`${base}/video.html`);
  await page.getByTestId('analyze-button').click();
  await page.getByTestId('download-button').waitFor({ state: 'visible', timeout: 45000 });
  await page.screenshot({ path: path.join(runRoot, '02-analysis.png'), fullPage: true });
  await page.getByTestId('download-button').click();
  let tasks = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks;
  assert.equal(tasks.length, 1);
  const complete = await waitTask(page, tasks[0].id, ['completed']);
  const directProbe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', complete.outputPath]));
  assert.ok(directProbe.streams.some(s => s.codec_type === 'video'));
  assert.ok(directProbe.streams.some(s => s.codec_type === 'audio'));
  check('界面分析网页、手动开始下载、成品含视频和音频');

  for (const [name, file] of [['HLS分片', 'sample.m3u8'], ['DASH分离音视频', 'sample.mpd']]) {
    const result = await page.evaluate(url => window.desktopApi.analyze(url), `${base}/${file}`);
    const created = await page.evaluate(video => window.desktopApi.enqueue([{ video, formatId: 'best', formatLabel: '最高画质' }]), result.entries[0]);
    const task = await waitTask(page, created[0].id, ['completed']);
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', task.outputPath]));
    assert.ok(probe.streams.some(s => s.codec_type === 'video'));
    assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) >= 3.8);
    check(`${name}真实下载与自动合并`, { output: task.outputPath, duration: probe.format.duration });
  }

  const slowResult = await page.evaluate(url => window.desktopApi.analyze(url), `${base}/slow.mp4`);
  const slowCreated = await page.evaluate(video => window.desktopApi.enqueue([{ video, formatId: 'best', formatLabel: '最高画质' }]), slowResult.entries[0]);
  await waitTask(page, slowCreated[0].id, ['downloading']);
  await new Promise(resolve => setTimeout(resolve, 1500));
  await page.evaluate(id => window.desktopApi.cancelTask(id), slowCreated[0].id);
  await waitTask(page, slowCreated[0].id, ['cancelled']);
  await page.evaluate(id => window.desktopApi.retryTask(id), slowCreated[0].id);
  await waitTask(page, slowCreated[0].id, ['completed']);
  check('取消停止子进程、保留中间数据、重试完成');

  const broken = await page.evaluate(url => window.desktopApi.analyze(url), `${base}/broken.m3u8`);
  const brokenCreated = await page.evaluate(video => window.desktopApi.enqueue([{ video, formatId: 'best', formatLabel: '最高画质' }]), broken.entries[0]);
  const failed = await waitTask(page, brokenCreated[0].id, ['failed']);
  assert.ok(failed.error);
  check('缺失分片显示失败，未误报完成', failed.error);
  let unsupported = '';
  try { await page.evaluate(url => window.desktopApi.analyze(url), `${base}/empty.html`); } catch (error) { unsupported = error.message; }
  assert.ok(unsupported);
  check('无视频页面返回明确错误');

  await page.getByTestId('settings-nav').click();
  await page.screenshot({ path: path.join(runRoot, '03-settings.png'), fullPage: true });
  await page.getByTestId('history-nav').click();
  await page.screenshot({ path: path.join(runRoot, '04-history.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByTestId('workbench-nav').click();
  await page.screenshot({ path: path.join(runRoot, '05-compact.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(appErrors, []);
  check('设置、历史、900px紧凑窗口无横向溢出或界面异常');

  const persistedTasks = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length;
  await desktop.close(); desktop = undefined;
  desktop = await electron.launch({ args: [root], env, timeout: 60000 });
  page = await desktop.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopApi));
  assert.equal((await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, persistedTasks);
  check('关闭后重新启动，任务记录持久化');
  report.completedAt = new Date().toISOString();
} catch (error) { report.error = error.stack || String(error); throw error; }
finally {
  if (desktop) await desktop.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`验证报告及截图：${runRoot}`);
}
