import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

// This is a local, test-owned Vimeo-shaped CDN. The public-domain suffix remains
// subject to production validation; Chrome DNS and desktop HTTP proxy route only
// this fixture host to our loopback server. No user Chrome profile is attached.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, _electron } = await import('playwright');
const runRoot = path.join(root, '.test-artifacts', `vimeo-extension-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtureDir = path.join(runRoot, 'fixtures');
const appRoot = path.join(runRoot, 'Vimeo JSON 测试便携版');
const extensionDir = path.join(runRoot, 'extension-preauthorized-fixture');
const packagedSource = process.env.FRAMECATCH_EXTENSION_TEST_PACKAGED;
await mkdir(fixtureDir, { recursive: true });
if (packagedSource) await cp(path.resolve(packagedSource), appRoot, { recursive: true, force: false, errorOnExist: true });
const sourceExtensionDir = process.env.FRAMECATCH_EXTENSION_DIR || (packagedSource ? path.join(appRoot, '浏览器插件') : path.join(root, 'browser-extension'));
const binDir = path.join(packagedSource ? path.join(appRoot, 'resources') : path.join(root, 'resources'), 'bin');
const ffmpeg = path.join(binDir, 'ffmpeg.exe'), ffprobe = path.join(binDir, 'ffprobe.exe');
const manifest = JSON.parse(await readFile(path.join(sourceExtensionDir, 'manifest.json'), 'utf8'));
await cp(sourceExtensionDir, extensionDir, { recursive: true, force: false, errorOnExist: true });
const testManifest = { ...manifest, host_permissions: [...new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])])] };
delete testManifest.optional_host_permissions;
await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(testManifest, null, 2));
for (const name of await readdir(sourceExtensionDir)) if (/\.(?:js|html|css)$/.test(name)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(extensionDir, name))).digest('hex'), createHash('sha256').update(await readFile(path.join(sourceExtensionDir, name))).digest('hex'), `运行文件不同：${name}`);
}
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].flatMap(byte => [byte >> 4, byte & 15]).map(value => String.fromCharCode(97 + value)).join('');
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, packaged: Boolean(packagedSource), extensionId,
  permissionSetup: '仅测试副本预授权正式manifest声明的optional hosts；JS/HTML/CSS逐文件哈希一致；不自动操作首次用户权限提示', checks: [] };
const requests = [], pageErrors = [];
const cookieName = 'framecatch_vimeo_fixture', cookieValue = 'vimeo-fixture-cookie-private';
const signature = '?sig=fixture%2Bsignature%2F&expires=1999999999';
const jsonPath = '/v2/playlist/av/fixture/playlist.json';
const rangePath = '/v2/range/prot/cmFuZ2U9MTAwLTIwMA/avf/not-complete.mp4';
let origin, local, referer, manifestJSON, expectedUA, desktop, appPage, browser, popup;
const pass = (name, details) => { report.checks.push({ name, passed: true, details }); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(executable, args, cwd = fixtureDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`夹具进程超时：${path.basename(executable)}`)); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-3000) || `退出码 ${code}`)); });
  });
}
async function poll(callback, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await sleep(150); }
  throw new Error(message);
}
function privateCheck(text, label) {
  assert.ok(!text.includes(cookieValue) && !text.includes(`${cookieName}=`), `${label}泄漏测试会话值`);
}
const server = createServer(async (request, response) => {
  try {
    const target = new URL(request.url, origin || 'http://fixture.vimeocdn.com');
    if (target.pathname === '/login') {
      response.writeHead(302, { Location: '/watch', 'Set-Cookie': `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax`, 'Cache-Control': 'no-store' }).end(); return;
    }
    if (target.pathname === '/watch') {
      const html = `<!doctype html><meta charset="utf-8"><title>Vimeo JSON 总清单隔离测试</title><h1>Vimeo JSON 总清单与范围片段回归</h1>
        <button id="range">请求范围片段</button><button id="json">加载完整 JSON 清单</button>
        <script>document.querySelector('#range').onclick=async()=>{const r=await fetch('${rangePath}${signature}&range=100-200');await r.arrayBuffer();window.rangeLoaded=r.ok;};
        document.querySelector('#json').onclick=async()=>{const r=await fetch('${jsonPath}${signature}&base64_init=1&query_string_ranges=1');window.manifestLoaded=r.ok;await r.json();};</script>`;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'unsafe-url', 'Cache-Control': 'no-store' }).end(html); return;
    }
    const checks = {
      host: request.headers.host === new URL(origin).host,
      cookie: (request.headers.cookie || '').split(';').some(value => value.trim() === `${cookieName}=${cookieValue}`),
      referer: request.headers.referer === referer,
      signature: target.searchParams.get('sig') === 'fixture+signature/' && target.searchParams.get('expires') === '1999999999',
      userAgent: expectedUA ? request.headers['user-agent'] === expectedUA : /Chrome\/\d+/.test(request.headers['user-agent'] || ''),
    };
    const authorized = Object.values(checks).every(Boolean);
    requests.push({ pathname: target.pathname, method: request.method, proxyRequest: /^http:\/\//.test(request.url), checks, authorized });
    if (!authorized) { response.writeHead(403, { 'Content-Type': 'text/plain' }).end('fixture media needs exact browser session, origin host, signature and referer'); return; }
    if (target.pathname === jsonPath) {
      expectedUA ||= request.headers['user-agent'];
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(manifestJSON)); return;
    }
    let file;
    if (target.pathname === rangePath) file = path.join(fixtureDir, 'chunk-0-00001.m4s');
    else if (/^\/media\/(?:init-[01]\.mp4|chunk-[01]-\d+\.m4s)$/.test(target.pathname)) file = path.join(fixtureDir, path.basename(target.pathname));
    else { response.writeHead(404).end('fixture route unavailable'); return; }
    const size = (await stat(file)).size;
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Cache-Control': 'no-store' };
    if (target.pathname === rangePath) headers['Content-Range'] = `bytes 100-${99 + size}/${100 + size}`;
    response.writeHead(target.pathname === rangePath ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end();
    else { const stream = createReadStream(file); stream.pipe(response); response.on('close', () => stream.destroy()); }
  } catch { if (!response.headersSent) response.writeHead(500); response.end('fixture handling failed'); }
});
try {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000', '-t', '2', '-c:v', 'libopenh264', '-b:v', '250k', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-movflags', '+faststart', 'sample.mp4']);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'sample.mp4', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', '-init_seg_name', 'init-$RepresentationID$.mp4', '-media_seg_name', 'chunk-$RepresentationID$-$Number%05d$.m4s', 'fixture.mpd']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  local = `http://127.0.0.1:${server.address().port}`;
  origin = `http://fixture.vimeocdn.com:${server.address().port}`; referer = `${origin}/watch`;
  const mpd = await readFile(path.join(fixtureDir, 'fixture.mpd'), 'utf8');
  const tracks = [];
  for (const [representation, kind, codec] of [['0', 'video', 'avc1.42c00b'], ['1', 'audio', 'mp4a.40.2']]) {
    const block = mpd.match(new RegExp(`<Representation\\b[^>]*id="${representation}"[^>]*>[\\s\\S]*?<\\/Representation>`))?.[0];
    assert.ok(block, 'DASH夹具缺少轨道');
    const timescale = Number(block.match(/<SegmentTemplate\b[^>]*timescale="(\d+)"/)?.[1]);
    assert.ok(timescale > 0);
    const timings = []; let time = 0;
    for (const match of block.matchAll(/<S\b([^>]*)\/>/g)) {
      const attributes = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]+)"/g)].map(item => [item[1], item[2]]));
      if (attributes.t) time = Number(attributes.t);
      for (let i = 0; i <= Number(attributes.r || 0); i++) { timings.push({ start: time / timescale, end: (time + Number(attributes.d)) / timescale }); time += Number(attributes.d); }
    }
    const names = (await readdir(fixtureDir)).filter(name => name.startsWith(`chunk-${representation}-`) && name.endsWith('.m4s')).sort();
    assert.equal(names.length, timings.length, '分片数与时间轴不同');
    const init = await readFile(path.join(fixtureDir, `init-${representation}.mp4`));
    const segments = await Promise.all(names.map(async (name, index) => ({ ...timings[index], url: `${origin}/media/${name}${signature}`, size: (await stat(path.join(fixtureDir, name))).size })));
    tracks.push({ kind, id: `${kind}-fixture`, base_url: './', bitrate: kind === 'video' ? 250000 : 70000, mime_type: `${kind}/mp4`, codecs: codec, ...(kind === 'video' ? { width: 256, height: 144, fps: 24 } : { sample_rate: 48000, channels: 1 }), init_segment: init.toString('base64'), segments });
  }
  const duration = Math.max(...tracks.map(track => track.segments.at(-1).end));
  manifestJSON = { clip_id: 'fixture-vimeo-json', base_url: `${origin}/media/`, duration, video: tracks.filter(track => track.kind === 'video').map(({ kind, ...track }) => track), audio: tracks.filter(track => track.kind === 'audio').map(({ kind, ...track }) => track) };
  await writeFile(path.join(fixtureDir, 'playlist.json'), JSON.stringify(manifestJSON, null, 2));
  assert.equal((await fetch(`${local}${jsonPath}${signature}`)).status, 403);
  pass('真实FFmpeg生成独立初始化与音视频fMP4分片；无Cookie/来源/签名的请求被服务器拒绝');

  const env = { ...process.env, FRAMECATCH_TEST_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(appRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  appPage = await desktop.firstWindow(); appPage.on('pageerror', error => pageErrors.push(error.message));
  await appPage.getByTestId('url-input').waitFor();
  const settings = (await appPage.evaluate(() => window.desktopApi.getSnapshot())).settings;
  await appPage.evaluate(settings => window.desktopApi.saveSettings(settings), { ...settings, proxy: local });
  await appPage.getByTestId('extension-open').click(); await appPage.getByTestId('extension-start').click();
  const code = await poll(async () => (await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus())).pairingCode, '桌面配对未开启');
  await appPage.getByTestId('extension-close').click();
  const executablePath = process.env.FRAMECATCH_EXTENSION_CHROMIUM || chromium.executablePath();
  await access(executablePath); report.browserExecutable = executablePath;
  browser = await chromium.launchPersistentContext(path.join(runRoot, 'fresh-chrome-profile'), { executablePath, headless: process.env.FRAMECATCH_EXTENSION_HEADFUL !== '1', ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-proxy-server', '--host-resolver-rules=MAP fixture.vimeocdn.com 127.0.0.1'] });
  const worker = browser.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${extensionId}/`)) || await browser.waitForEvent('serviceworker', { predicate: item => item.url().startsWith(`chrome-extension://${extensionId}/`), timeout: 30000 });
  const watch = await browser.newPage(); await watch.goto(`${origin}/login`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, referer);
  assert.equal(typeof tabId, 'number');
  popup = await browser.newPage(); popup.on('pageerror', error => pageErrors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.getByTestId('pair-code').fill(code); await popup.getByTestId('pair-button').click();
  await poll(async () => (await appPage.evaluate(() => window.desktopApi.getExtensionBridgeStatus())).paired, '真实扩展配对失败');
  await popup.getByTestId('detect-start').click();
  const state = () => popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'popup:state', tabId }), tabId);
  await poll(async () => (await state()).active, '当前页检测未开启');
  pass('正式扩展运行时在独立Chrome中完成配对，仅测试域DNS映射到环回');

  await watch.getByRole('button', { name: '请求范围片段' }).click();
  await watch.waitForFunction(() => window.rangeLoaded === true);
  await poll(async () => (await state()).blockedCount > 0, '可信Vimeo范围片段未被识别并计数');
  assert.equal((await state()).captures.length, 0, '范围MP4不得当作完整视频');
  assert.match(await popup.locator('body').innerText(), /分片|范围|清单/);
  assert.equal((await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, 0);
  await popup.screenshot({ path: path.join(runRoot, 'extension-blocked-range.png'), fullPage: true });
  pass('真实成功返回的Vimeo范围MP4被过滤，有固定引导且不创建下载任务');

  await watch.getByRole('button', { name: '加载完整 JSON 清单' }).click();
  await watch.waitForFunction(() => window.manifestLoaded === true);
  const capture = await poll(async () => (await state()).captures.find(item => /playlist\.json/.test(item.label || '')), '扩展没有捕获可信Vimeo JSON总清单');
  await popup.locator(`input[name="capture"][value="${capture.id}"]`).check(); await popup.getByTestId('capture-send').click();
  await appPage.getByTestId('download-button').waitFor({ timeout: 45000 });
  assert.equal((await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, 0, '发送不得自动入队');
  privateCheck(await popup.locator('body').innerText(), '插件界面'); privateCheck(await appPage.locator('body').innerText(), '桌面界面');
  await appPage.screenshot({ path: path.join(runRoot, 'desktop-json-analyzed.png'), fullPage: true });
  pass('真实JSON请求保留浏览器会话并通过本机桥接分析出可选画质，未自动下载');
  await appPage.getByTestId('download-button').click();
  const completed = await poll(async () => { const task = (await appPage.evaluate(() => window.desktopApi.getSnapshot())).tasks[0]; if (task?.status === 'failed') throw new Error(task.error); return task?.status === 'completed' && task; }, 'JSON清单完整下载失败', 60000);
  const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completed.outputPath]));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) >= 1.9);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', completed.outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  assert.ok(requests.some(item => item.proxyRequest && item.pathname === jsonPath && item.authorized), 'JSON读取必须实际走配置代理');
  for (const track of ['0', '1']) assert.ok(requests.some(item => item.proxyRequest && item.pathname.includes(`chunk-${track}-`) && item.authorized), `轨道${track}分片必须真实请求并带必要会话`);
  privateCheck(await readFile(completed.logPath, 'utf8'), '任务日志');
  privateCheck(await readFile(path.join(appRoot, 'data/state.json'), 'utf8'), '持久任务状态');
  const stored = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(Object.keys(stored), ['framecatch-pairing-v1']);
  assert.deepEqual(Object.keys(stored['framecatch-pairing-v1']), ['token']);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(stored['framecatch-pairing-v1'].token), '只允许持久保存随机本机配对令牌');
  privateCheck(JSON.stringify(stored), '扩展持久区');
  await popup.screenshot({ path: path.join(runRoot, 'extension-json-captured.png'), fullPage: true });
  await appPage.screenshot({ path: path.join(runRoot, 'desktop-json-completed.png'), fullPage: true });
  pass('JSON初始化与独立音视频分片真实下载、合并，ffprobe双轨/时长与全片解码通过', { duration: probe.format.duration, outputPath: completed.outputPath });
  await popup.getByTestId('detect-stop').click(); await poll(async () => (await state()).captures.length === 0, '停止后未清空捕获');
  await appPage.evaluate(() => window.desktopApi.stopExtensionBridge());
  assert.deepEqual(pageErrors, []);
  pass('停止清空会话；扩展不持久化Cookie；界面与日志无Cookie原文');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack || String(error);
  if (appPage && !appPage.isClosed()) await appPage.screenshot({ path: path.join(runRoot, 'failure-desktop.png'), fullPage: true }).catch(() => {});
  if (popup && !popup.isClosed()) await popup.screenshot({ path: path.join(runRoot, 'failure-extension.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (desktop) {
    if (appPage && !appPage.isClosed()) { await appPage.evaluate(() => window.desktopApi.stopExtensionBridge()).catch(() => {}); await appPage.evaluate(() => window.desktopApi.cancelAnalysis()).catch(() => {}); }
    await desktop.close().catch(() => {});
  }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(runRoot, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Vimeo扩展真实端到端报告：${runRoot}`);
}
