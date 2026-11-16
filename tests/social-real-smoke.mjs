import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright';
import electronPath from 'electron';

// This is a real-site acceptance run for the three user-supplied inputs. It
// launches only a test-owned app/profile and keeps every diagnostic/output.
// Network media URLs and session information are never printed or put in the
// public report. No user Chrome profile, database or OS clipboard is accessed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = path.join(root, '.test-artifacts', `social-real-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const portableRoot = path.join(runRoot, '分享视频 实测便携版');
const packagedSource = process.env.FRAMECATCH_SOCIAL_TEST_PACKAGED;
await mkdir(runRoot, { recursive: true });
if (packagedSource) await cp(path.resolve(packagedSource), portableRoot, { recursive: true, errorOnExist: true, force: false });
const bin = path.join(packagedSource ? path.join(portableRoot, 'resources') : path.join(root, 'resources'), 'bin');
const ffmpeg = path.join(bin, 'ffmpeg.exe'), ffprobe = path.join(bin, 'ffprobe.exe');
await access(ffmpeg); await access(ffprobe);
const inputs = [
  {
    key: 'douyin-share', platform: 'douyin', id: '7704696872263034451', expectedDuration: 459.219592,
    label: '抖音分享口令', expectedSource: 'https://v.douyin.com/nb0IbhnzrDM/',
    input: String.raw`3.35 复制打开抖音，看看【八道的作品】没想到中国短剧在国外热度这么高 # 短剧出海  https\://v.douyin.com/nb0IbhnzrDM/ 11/16 Mwf:/ Y@M.jc :5pm `,
  },
  {
    key: 'douyin-modal', platform: 'douyin', id: '7704614785010175270', expectedDuration: 209.769002,
    label: '抖音精选 modal_id 链接', expectedSource: 'https://www.douyin.com/video/7704614785010175270',
    input: 'https://www.douyin.com/jingxuan?modal_id=7704614785010175270',
  },
];
const wechatInput = 'https://weixin.qq.com/sph/APs1aO2qFw';
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, packaged: Boolean(packagedSource), checks: [], results: [] };
const pageErrors = [];
let desktop, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => String(error instanceof Error ? error.stack || error.message : error).replace(/https?:\/\/[^\s"'<>]+/g, '[网址已隐藏]');
const pass = (name, details) => { report.checks.push({ name, passed: true, ...(details ? { details } : {}) }); console.log(`通过：${name}`); };
async function poll(callback, message, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await callback(); if (result) return result; await sleep(200); }
  throw new Error(message);
}
function run(executable, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); finish(new Error(`验证进程超时：${path.basename(executable)}`)); }, timeout);
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? null : new Error(safeError(stderr.slice(-4000)) || `验证进程退出 ${code}`), stdout));
  });
}
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function textIfPresent(testId) {
  const locator = page.getByTestId(testId);
  return await locator.count() ? (await locator.textContent({ timeout: 1000 })) || '' : '';
}
async function fillShare(input, expectedSource) {
  await page.getByTestId('social-nav').click();
  await page.getByTestId('share-input').fill(input);
  await poll(async () => (await textIfPresent('share-source-url')).trim() === expectedSource, '分享来源预览未按实际输入规范化', 15000);
  await page.getByTestId('share-analyze').waitFor({ state: 'visible' });
  await poll(() => page.getByTestId('share-analyze').isEnabled(), '分享分析按钮未就绪', 15000);
}
try {
  const env = { ...process.env, FRAMECATCH_TEST_ROOT: portableRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(portableRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  page = await desktop.firstWindow();
  page.on('pageerror', error => pageErrors.push(safeError(error)));
  await page.getByTestId('social-nav').waitFor();
  const snapshot = await page.evaluate(() => window.desktopApi.getSnapshot());
  assert.equal(snapshot.portableRoot, portableRoot);
  assert.equal(snapshot.dependencies.filter(item => item.available).length, 4);
  // Save only this isolated app's normal direct-network configuration. No user
  // settings or login files are imported into the acceptance environment.
  await page.evaluate(settings => window.desktopApi.saveSettings({ ...settings, proxy: '', cookiePath: '' }), snapshot.settings);
  pass('真实新版桌面启动；新分享标签页和四个便携组件可用，测试数据独立');

  for (const sample of inputs) {
    await fillShare(sample.input, sample.expectedSource);
    const before = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.map(task => task.id);
    await page.getByTestId('share-analyze').click();
    await poll(async () => {
      const error = await textIfPresent('share-analysis-error');
      if (error) throw new Error(`${sample.label}分析失败：${error}`);
      return await page.getByTestId('download-button').isVisible().catch(() => false);
    }, `${sample.label}真实分析超时`, 240000);
    assert.equal((await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, before.length, '分析成功不得自动创建下载任务');
    const title = (await page.locator('.video-info h3').first().textContent())?.trim();
    assert.ok(title && title.length > 1, '真实作品必须有可读标题');
    assert.ok((await page.getByLabel('下载画质').first().locator('option').count()) > 0, '必须有可选画质');
    await page.screenshot({ path: path.join(runRoot, `${sample.key}-analyzed.png`), fullPage: true });
    pass(`${sample.label}规范化、真实解析、作品标题与画质展示完成`, { source: sample.expectedSource, title });
    await page.getByTestId('download-button').click();
    const task = await poll(async () => {
      const tasks = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks;
      return tasks.find(task => !before.includes(task.id));
    }, `${sample.label}未建立下载任务`, 15000);
    const completed = await poll(async () => {
      const value = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.find(item => item.id === task.id);
      if (value?.status === 'failed') throw new Error(`${sample.label}下载失败：${value.error}`);
      return value?.status === 'completed' && value;
    }, `${sample.label}下载未完成`, 300000);
    assert.equal(completed.video.id, sample.id, '真实下载必须与分享作品编号一致');
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completed.outputPath]));
    await writeFile(path.join(runRoot, `${sample.key}-probe.private.json`), JSON.stringify(probe, null, 2));
    const video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.ok(video && audio, '真实成品必须同时有视频与音轨');
    const duration = Number(probe.format.duration);
    assert.ok(Number.isFinite(duration) && Math.abs(duration - sample.expectedDuration) < 2, '真实成品时长须与已确认作品相符');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', completed.outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], 180000);
    const item = { inputKind: sample.key, source: sample.expectedSource, id: sample.id, title: completed.video.title, outputPath: completed.outputPath, size: (await stat(completed.outputPath)).size, sha256: await sha256(completed.outputPath), duration, video: { codec: video.codec_name, width: video.width, height: video.height }, audio: { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels }, fullDecodeExitCode: 0 };
    report.results.push(item);
    await page.screenshot({ path: path.join(runRoot, `${sample.key}-completed.png`), fullPage: true });
    pass(`${sample.label}完整下载、双轨/时长校验及全片解码通过`, item);
  }

  const beforeWechat = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length;
  await fillShare(wechatInput, wechatInput);
  await page.getByTestId('share-analyze').click();
  const error = await poll(() => textIfPresent('share-analysis-error'), '视频号应明确提示预览限制', 180000);
  assert.match(error, /视频号/); assert.match(error, /预览|二维码/); assert.match(error, /微信/);
  assert.doesNotMatch(error, /Cookie/i, '已确认为微信预览时不应反复要求导入Cookie');
  assert.equal(await page.getByTestId('download-button').isVisible().catch(() => false), false, '预览页不得提供虚假的下载按钮');
  assert.equal((await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, beforeWechat, '视频号预览不得创建下载任务');
  await page.screenshot({ path: path.join(runRoot, 'wechat-preview-error.png'), fullPage: true });
  report.results.push({ inputKind: 'wechat-share', source: wechatInput, actualDownload: false, error });
  pass('视频号真实分享页返回针对预览页的限制说明，未误判作品丢失或创建下载任务');
  assert.deepEqual(pageErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = safeError(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(runRoot, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(runRoot, 'failure-snapshot.private.json'), JSON.stringify(await page.evaluate(() => window.desktopApi.getSnapshot()).catch(() => null), null, 2));
  }
  console.error(report.error); process.exitCode = 1;
} finally {
  if (desktop) {
    if (page && !page.isClosed()) {
      await page.evaluate(() => window.desktopApi.cancelAnalysis()).catch(() => {});
      const tasks = await page.evaluate(() => window.desktopApi.getSnapshot()).then(value => value.tasks).catch(() => []);
      for (const task of tasks.filter(value => ['queued', 'downloading', 'merging', 'verifying'].includes(value.status))) await page.evaluate(id => window.desktopApi.cancelTask(id), task.id).catch(() => {});
      await page.evaluate(() => window.desktopApi.stopExtensionBridge()).catch(() => {});
    }
    await desktop.close().catch(() => {});
  }
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`分享真实实测报告：${runRoot}`);
}
