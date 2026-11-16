import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

// Launch only a new, test-owned Chrome for Testing profile. Do not attach to
// the user's browser, read their browser databases, or use their clipboard.
// All generated fixtures, browser data and app outputs are retained.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, _electron } = await import('playwright');
const runRoot = path.join(root, '.test-artifacts', `extension-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtureDir = path.join(runRoot, 'fixtures');
const appRoot = path.join(runRoot, '扩展测试 隔离便携版');
let sourceExtensionDir = process.env.FRAMECATCH_EXTENSION_DIR || path.join(root, 'browser-extension');
const extensionDir = path.join(runRoot, 'extension-preauthorized-fixture');
const packagedSource = process.env.FRAMECATCH_EXTENSION_TEST_PACKAGED;
await mkdir(fixtureDir, { recursive: true });
if (packagedSource) await cp(path.resolve(packagedSource), appRoot, { recursive: true, force: false, errorOnExist: true });
if (packagedSource && !process.env.FRAMECATCH_EXTENSION_DIR) sourceExtensionDir = path.join(appRoot, '浏览器插件');
const binDir = path.join(packagedSource ? path.join(appRoot, 'resources') : path.join(root, 'resources'), 'bin');
const ffmpeg = path.join(binDir, 'ffmpeg.exe');
const ffprobe = path.join(binDir, 'ffprobe.exe');
const manifest = JSON.parse(await readFile(path.join(sourceExtensionDir, 'manifest.json'), 'utf8'));
// Native optional-permission prompts are deliberately not automated. The
// fixture copy pregrants only the production manifest's declared optional host
// permissions; every JS/HTML/CSS runtime file stays byte-identical. This tests
// actual extension traffic and app downloads, not first-user permission UI.
await cp(sourceExtensionDir, extensionDir, { recursive: true, force: false, errorOnExist: true });
const testManifest = { ...manifest, host_permissions: [...new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])])] };
delete testManifest.optional_host_permissions;
await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(testManifest, null, 2));
for (const name of await readdir(sourceExtensionDir)) if (/\.(?:js|html|css)$/.test(name)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(extensionDir, name))).digest('hex'), createHash('sha256').update(await readFile(path.join(sourceExtensionDir, name))).digest('hex'), `测试扩展运行文件不同：${name}`);
}
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [byte >> 4, byte & 15]).map(nibble => String.fromCharCode(97 + nibble)).join('');
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, packaged: Boolean(packagedSource), extensionId, permissionSetup: '测试副本将正式manifest的optional hosts预授权为required hosts；runtime字节相同；首次真实用户授权提示未自动验证', checks: [] };
const pass = (name, details) => { report.checks.push({ name, passed: true, details }); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];
const cookieName = 'framecatch_extension_fixture';
const cookieValue = 'test-session-private-cookie';
const signature = '?sig=fixture%2Bsignature%2F&expires=1999999999';
let base, referer, phase = 'setup';
let desktop, appPage, browser, popup;
const pageErrors = [];
function run(executable, args, cwd = fixtureDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`进程超时：${path.basename(executable)}`)); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-3000) || `退出码 ${code}`)); });
  });
}
async function poll(callback, message, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await callback(); if (result) return result; await sleep(150); }
  throw new Error(message);
}
function assertPrivate(text, label) {
  assert.ok(!text.includes(cookieValue), `${label}泄漏测试Cookie值`);
  assert.ok(!text.includes(`${cookieName}=`), `${label}泄漏测试Cookie原文`);
}
const server = createServer(async (request, response) => {
  const target = new URL(request.url, 'http://fixture.local');
  if (target.pathname === '/extension-origin-probe') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ method: request.method, origin: request.headers.origin || null })); return;
  }
  if (target.pathname === '/login') {
    response.writeHead(302, { 'Location': '/watch', 'Set-Cookie': `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax`, 'Cache-Control': 'no-store' }).end();
    return;
  }
  if (target.pathname === '/watch') {
    const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>扩展隔离播放夹具</title>
      <h1>本地视频请求捕获测试</h1><p>只使用本地生成的媒体和测试会话。</p>
      <button id="play-mp4">播放 MP4</button><button id="load-hls">加载 HLS 清单</button><video id="video" controls width="400"></video>
      <script>document.querySelector('#play-mp4').onclick=()=>{const v=document.querySelector('#video');v.src='/protected/sample.mp4${signature}';v.play().catch(()=>{});};
      document.querySelector('#load-hls').onclick=async()=>{const r=await fetch('/protected/sample.m3u8${signature}');window.hlsFixture={ok:r.ok,text:await r.text()};};</script></html>`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'unsafe-url', 'Cache-Control': 'no-store' }).end(html); return;
  }
  if (!target.pathname.startsWith('/protected/')) { response.writeHead(404).end('local fixture only'); return; }
  const checks = {
    cookie: request.headers.cookie?.split(';').some(value => value.trim() === `${cookieName}=${cookieValue}`) || false,
    referer: request.headers.referer === referer,
    signature: target.search === signature,
    userAgent: Boolean(request.headers['user-agent']),
  };
  const authorized = Object.values(checks).every(Boolean);
  requests.push({ pathname: target.pathname, authorized, checks, phase });
  if (!authorized) { response.writeHead(403, { 'Content-Type': 'text/plain' }).end('fixture needs browser playback session and referer'); return; }
  try {
    const alias = /\/(?:init\.mp4|part000\.m4s|audio\.aac)$/.test(target.pathname) ? 'sample.mp4' : path.basename(target.pathname);
    const local = path.join(fixtureDir, target.pathname.endsWith('/sample.m3u8') ? 'master.m3u8' : alias);
    const size = (await stat(local)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    let start = 0, end = size - 1;
    if (range) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    const type = target.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : target.pathname.endsWith('.ts') ? 'video/mp2t' : target.pathname.endsWith('.aac') ? 'audio/aac' : 'video/mp4';
    const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end();
    else { const stream = createReadStream(local, { start, end }); stream.pipe(response); response.on('close', () => stream.destroy()); }
  } catch { if (!response.headersSent) response.writeHead(404); response.end('fixture not found'); }
});

try {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libopenh264', '-b:v', '250k', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-movflags', '+faststart', 'sample.mp4']);
  for (const [track, map, prefix] of [['video', '0:v:0', 'vidpart'], ['audio', '0:a:0', 'audpart']]) {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'sample.mp4', '-map', map, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${prefix}%03d.ts`, `${track}-plain.m3u8`]);
    const hls = await readFile(path.join(fixtureDir, `${track}-plain.m3u8`), 'utf8');
    await writeFile(path.join(fixtureDir, `${track}.m3u8`), hls.replace(/^(\w+\d+\.ts)$/gm, `$1${signature}`));
  }
  await writeFile(path.join(fixtureDir, 'master.m3u8'), `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="AAC",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8${signature}"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=256x144,CODECS="avc1.42c00b,mp4a.40.2",AUDIO="sound"\nvideo.m3u8${signature}\n`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; referer = `${base}/watch`;
  assert.equal((await fetch(`${base}/protected/sample.mp4${signature}`)).status, 403);
  pass('生成本地 MP4/HLS；没有登录 Cookie、来源页和签名的访问被真实服务器拒绝');

  const env = { ...process.env, FRAMECATCH_TEST_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(appRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  appPage = await desktop.firstWindow();
  appPage.on('pageerror', error => pageErrors.push(error.message));
  await appPage.getByTestId('url-input').waitFor();
  await appPage.getByTestId('extension-open').click();
  await appPage.getByTestId('extension-start').click();
  const code = await poll(async () => { const status = await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus()); return status.running && status.pairingCode; }, '桌面辅助连接未启动');
  assert.match(code, /^[A-Z0-9]{8}$/);
  await appPage.screenshot({ path: path.join(runRoot, 'desktop-pairing.png'), fullPage: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 760));
  await sleep(200);
  assert.equal(await appPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '900px宽出现横向溢出');
  await appPage.screenshot({ path: path.join(runRoot, 'desktop-pairing-900px.png'), fullPage: true });
  await appPage.keyboard.press('Escape');
  await appPage.getByTestId('extension-dialog').waitFor({ state: 'hidden' });
  assert.equal((await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus())).running, true);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1260, 840));
  pass('配对窗口在900px宽无横向溢出，Esc关闭后本机连接保持开启');
  pass('桌面界面手动启用本机桥接并生成一次性配对码');

  const executablePath = process.env.FRAMECATCH_EXTENSION_CHROMIUM || chromium.executablePath();
  try { await access(executablePath); }
  catch { throw new Error('未找到测试浏览器。先执行 npx playwright install chromium，或通过 FRAMECATCH_EXTENSION_CHROMIUM 指定专用 Chrome for Testing 可执行文件。测试始终使用全新配置目录。'); }
  report.browserExecutable = executablePath;
  browser = await chromium.launchPersistentContext(path.join(runRoot, 'fresh-chrome-profile'), {
    executablePath, headless: process.env.FRAMECATCH_EXTENSION_HEADFUL !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-proxy-server'],
  });
  const worker = browser.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${extensionId}/`))
    || await browser.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith(`chrome-extension://${extensionId}/`), timeout: 30000 });
  const watch = await browser.newPage();
  await watch.goto(`${base}/login`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, referer);
  assert.equal(typeof tabId, 'number');
  popup = await browser.newPage();
  popup.on('pageerror', error => pageErrors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.getByTestId('pair-code').fill(code);
  await popup.getByTestId('pair-button').click();
  await poll(async () => (await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus())).paired, '真实扩展配对失败');
  await popup.screenshot({ path: path.join(runRoot, 'extension-paired.png'), fullPage: true });
  pass('预授权测试配置的原始扩展runtime在全新 Chrome for Testing 配置中加载，实际扩展 Origin 与桌面完成配对');
  report.extensionOriginProbe = await worker.evaluate(async base => {
    const result = [];
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${base}/extension-origin-probe`, { method, headers: { Authorization: 'Bearer synthetic-origin-probe', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}), credentials: 'omit', cache: 'no-store', redirect: 'error' });
      result.push(await response.json());
    }
    return result;
  }, base);
  assert.equal(report.extensionOriginProbe.find(item => item.method === 'POST').origin, `chrome-extension://${extensionId}`);
  await popup.getByTestId('refresh-status').click();
  await poll(async () => (await popup.getByTestId('status-message').innerText()).includes('本机连接正常'), '真实扩展 POST /status 未成功（检查Origin）', 15000);
  pass('实际扩展 POST /status 与 POST /pair 均通过严格Origin和配对鉴权；GET/POST Origin差异已真实回显验证');
  await popup.getByTestId('detect-start').click();
  await poll(async () => {
    const response = await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'popup:state', tabId }), tabId);
    return response.ok && (response.detecting || response.state?.detecting || response.active || response.state?.active);
  }, '没有进入当前标签页检测状态：检查测试浏览器的权限确认', process.env.FRAMECATCH_EXTENSION_HEADFUL === '1' ? 180000 : 45000);
  pass('通过扩展弹窗用户手势启用当前标签页检测（测试配置预授权，首次真实用户授权未自动验证）');

  async function state() { return popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'popup:state', tabId }), tabId); }
  phase = 'filter-checks';
  const otherWatch = await browser.newPage();
  await otherWatch.goto(referer);
  await otherWatch.evaluate(async signature => { const response = await fetch(`/protected/sample.mp4${signature}`); await response.arrayBuffer(); }, signature);
  await sleep(300);
  assert.equal((await state()).captures.length, 0, '未启用的标签页不应进入捕获列表');
  await otherWatch.close();
  await watch.evaluate(async signature => {
    await Promise.all(['vidpart000.ts', 'part000.m4s', 'init.mp4', 'audio.aac', 'audio.m3u8'].map(async name => { const response = await fetch(`/protected/${name}${signature}`); if (!response.ok) throw new Error(`过滤夹具未成功返回：${name}`); await response.arrayBuffer(); }));
  }, signature);
  await sleep(300);
  assert.equal((await state()).captures.length, 0, '分片、初始化文件及音频不应列为完整视频');
  pass('未启用标签页不捕获；成功响应的 TS、M4S、init MP4 与纯音频均不进入完整视频列表');
  async function selectCapture(kind) {
    return poll(async () => {
      const value = await state();
      const entries = value.captures || value.state?.captures || value.items || value.state?.items || [];
      return entries.find(item => kind === 'mp4' ? /sample\.mp4/.test(item.url || item.label || '') : /\.m3u8/.test(item.url || item.label || ''));
    }, `插件没有捕获${kind}完整资源`);
  }
  async function sendAndDownload(capture, label) {
    phase = label;
    const beforeTasks = (await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks.length;
    await popup.locator(`input[name="capture"][value="${capture.id}"]`).check();
    await popup.getByTestId('capture-send').click();
    await appPage.getByTestId('download-button').waitFor({ timeout: 45000 });
    assert.equal((await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, beforeTasks, '插件发送不得自动创建下载任务');
    assertPrivate(await appPage.locator('body').innerText(), `${label}桌面界面`);
    assertPrivate(await popup.locator('body').innerText(), `${label}扩展界面`);
    await appPage.getByTestId('download-button').click();
    const completed = await poll(async () => {
      const tasks = (await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks;
      const task = tasks.find(task => task.video.url.includes(label === 'MP4' ? 'sample.mp4' : 'sample.m3u8'));
      if (task?.status === 'failed') throw new Error(task.error);
      return task?.status === 'completed' && task;
    }, `${label}下载未完成`, 60000);
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completed.outputPath]));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) >= 1.9);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', completed.outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    assertPrivate(await readFile(completed.logPath, 'utf8'), `${label}任务日志`);
    pass(`${label}真实浏览器请求携带会话发送，桌面手动下载后双轨/时长/全片解码正常`, { duration: probe.format.duration, outputPath: completed.outputPath });
  }
  await watch.getByRole('button', { name: '播放 MP4' }).click();
  const mp4Capture = await selectCapture('mp4');
  await sendAndDownload(mp4Capture, 'MP4');
  await watch.getByRole('button', { name: '加载 HLS 清单' }).click();
  await watch.waitForFunction(() => window.hlsFixture?.ok);
  const hlsCapture = await selectCapture('hls');
  await sendAndDownload(hlsCapture, 'HLS');
  assert.ok(requests.some(request => request.authorized && request.phase === 'HLS' && /vidpart\d+\.ts$/.test(request.pathname)), 'HLS视频分片必须实际下载');
  assert.ok(requests.some(request => request.authorized && request.phase === 'HLS' && /audpart\d+\.ts$/.test(request.pathname)), 'HLS独立音频分片必须实际下载并与视频合并');
  await popup.screenshot({ path: path.join(runRoot, 'extension-captured.png'), fullPage: true });
  await appPage.screenshot({ path: path.join(runRoot, 'desktop-completed.png'), fullPage: true });

  await popup.getByTestId('detect-stop').click();
  await poll(async () => { const value = await state(); const entries = value.captures || value.state?.captures || value.items || value.state?.items || []; return entries.length === 0; }, '停止后未清空捕获会话');
  const localStorage = await worker.evaluate(() => chrome.storage.local.get(null));
  assertPrivate(JSON.stringify(localStorage), '扩展持久存储');
  assert.deepEqual(Object.keys(localStorage), ['framecatch-pairing-v1']);
  assert.deepEqual(Object.keys(localStorage['framecatch-pairing-v1']), ['token']);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(localStorage['framecatch-pairing-v1'].token), '持久区只能含随机本机配对令牌');
  await appPage.evaluate(() => window.desktopApi.stopExtensionBridge());
  const bridgeStopped = await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus());
  assert.equal(bridgeStopped.running, false);
  assert.equal(bridgeStopped.paired, true);
  assert.equal(bridgeStopped.remembered, true);
  assert.equal(bridgeStopped.autoConnect, false);
  assertPrivate(JSON.stringify(await appPage.evaluate(() => window.desktopApi.getSnapshot())), '软件快照');
  assertPrivate(await readFile(path.join(appRoot, 'data/state.json'), 'utf8'), '软件持久任务状态');
  for (const name of await readdir(path.join(appRoot, 'data/logs'))) assertPrivate(await readFile(path.join(appRoot, 'data/logs', name), 'utf8'), `日志${name}`);
  assert.deepEqual(pageErrors, []);
  pass('停止检测清空捕获；扩展只持久保存随机配对令牌；暂停连接保留配对并关闭自动启动；界面与日志无Cookie原文');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || String(error);
  if (appPage && !appPage.isClosed()) await appPage.screenshot({ path: path.join(runRoot, 'failure-desktop.png'), fullPage: true }).catch(() => {});
  if (popup && !popup.isClosed()) await popup.screenshot({ path: path.join(runRoot, 'failure-extension.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (desktop) {
    if (appPage && !appPage.isClosed()) {
      await appPage.evaluate(() => window.desktopApi.stopExtensionBridge()).catch(() => {});
      await appPage.evaluate(() => window.desktopApi.cancelAnalysis()).catch(() => {});
    }
    await desktop.close().catch(() => {});
  }
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(runRoot, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`扩展真实端到端报告：${runRoot}`);
}
