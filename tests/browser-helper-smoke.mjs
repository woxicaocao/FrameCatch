import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import electronPath from 'electron';

// Only generated local fixtures and a new app profile are used. No real browser,
// account cookies, external website, system setting, or deletion is involved.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = path.join(root, '.test-artifacts', `browser-helper-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtureDir = path.join(runRoot, 'fixtures');
const portableRoot = path.join(runRoot, '隔离 便携软件');
await mkdir(fixtureDir, { recursive: true });
const packagedSource = process.env.FRAMECATCH_BROWSER_TEST_PACKAGED;
if (packagedSource) await cp(path.resolve(packagedSource), portableRoot, { recursive: true, errorOnExist: true, force: false });
const ffmpeg = path.join(root, 'resources/bin/ffmpeg.exe');
const ffprobe = path.join(root, 'resources/bin/ffprobe.exe');
const secret = 'secret'; // Synthetic fixture value, never a user credential.
const cookieName = 'framecatch_test';
const requests = [];
const proxyRequests = [];
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, checks: [] };
const pass = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(executable, args, cwd = fixtureDir, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`执行超时：${path.basename(executable)}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-5000) || `退出码 ${code}`)); });
  });
}
await access(path.join(root, 'dist-electron/main.cjs'));
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libopenh264', '-b:v', '250k', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-movflags', '+faststart', 'sample.mp4']);
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'sample.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'part%03d.ts', 'sample.m3u8']);
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'sample.mp4', '-vn', '-c:a', 'copy', 'audio.m4a']);
pass('生成本地2秒 H.264/AAC MP4、HLS分片和纯音频夹具');

let base, mediaBase;
const allowedPorts = new Set();
const mime = { '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment' };
const fixtureHandler = async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture.local').pathname;
  try {
    if (pathname.startsWith('/watch/')) {
      const html = `<!doctype html><html><head><title>映取浏览器辅助本地测试</title><meta name="referrer" content="unsafe-url"></head><body>
        <h1>仅本地测试播放页</h1><button id="play-mp4">播放 MP4</button><button id="play-hls">请求 HLS</button><button id="noise">请求非候选片段</button><button id="head">验证 HEAD</button>
        <video id="player" controls preload="none" crossorigin="use-credentials" width="400"></video><p id="status"></p>
        <script>
          const media = ${JSON.stringify(mediaBase)};
          document.getElementById('play-mp4').onclick = () => { const v=document.getElementById('player');v.src=media+'/protected/sample.mp4';v.play().catch(()=>{}); };
          document.getElementById('play-hls').onclick = () => fetch(media+'/protected/sample.m3u8',{credentials:'include'}).then(r=>r.text()).then(()=>document.getElementById('status').textContent='HLS已请求');
          document.getElementById('noise').onclick = () => Promise.all(['part000.ts','part001.ts','chunk.m4s','init.mp4','audio-only.mp4'].map(p=>fetch(media+'/protected/'+p,{credentials:'include'}).then(r=>r.arrayBuffer()))).then(()=>document.getElementById('status').textContent='片段已请求');
          document.getElementById('head').onclick = () => fetch(media+'/protected/sample.mp4',{method:'HEAD',credentials:'include'}).then(r=>document.getElementById('status').textContent='HEAD状态'+r.status);
        </script></body></html>`;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Lax`, 'Referrer-Policy': 'unsafe-url', 'Cache-Control': 'no-store' });
      response.end(html); return;
    }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (!pathname.startsWith('/protected/')) { response.writeHead(404).end(); return; }
    const hasCookie = (request.headers.cookie || '').split(';').some(value => value.trim() === `${cookieName}=${secret}`);
    const hasReferer = Boolean(request.headers.referer?.startsWith(`${base}/watch/`));
    const authorized = hasCookie && hasReferer;
    requests.push({ pathname, method: request.method, authorized, hasCookie, referer: request.headers.referer || '', origin: request.headers.origin || '', userAgent: request.headers['user-agent'] || '' });
    const cors = { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Expose-Headers': 'Content-Length,Content-Range', 'Cache-Control': 'no-store' };
    if (!authorized) { response.writeHead(403, cors).end('fixture requires playback Referer and test cookie'); return; }
    const file = path.basename(pathname);
    const aliases = { 'init.mp4': 'sample.mp4', 'chunk.m4s': 'part000.ts', 'audio-only.mp4': 'audio.m4a' };
    const local = path.join(fixtureDir, aliases[file] || file);
    const info = await stat(local);
    let start = 0, end = info.size - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (start > end) { response.writeHead(416, { ...cors, 'Content-Range': `bytes */${info.size}` }).end(); return; }
    const headers = { ...cors, 'Content-Type': file === 'audio-only.mp4' ? 'audio/mp4' : mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end();
    else { const stream = createReadStream(local, { start, end }); stream.pipe(response); response.on('close', () => stream.destroy()); }
  } catch { if (!response.headersSent) response.writeHead(404); response.end('fixture not found'); }
};
const server = createServer(fixtureHandler);
const mediaServer = createServer(fixtureHandler);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(server); await listen(mediaServer);
base = `http://127.0.0.1:${server.address().port}`;
mediaBase = `http://127.0.0.1:${mediaServer.address().port}`;
allowedPorts.add(String(server.address().port)); allowedPorts.add(String(mediaServer.address().port));

// A local forwarding proxy checks that capture context and subsequent yt-dlp
// requests keep the configured proxy. It refuses every non-fixture destination.
const proxy = createServer((request, response) => {
  let target;
  try { target = new URL(request.url); } catch { response.writeHead(400).end(); return; }
  if (target.hostname !== '127.0.0.1' || !allowedPorts.has(target.port)) { response.writeHead(403).end('local fixture proxy only'); return; }
  proxyRequests.push({ method: request.method, pathname: target.pathname, port: target.port });
  const forwarded = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, upstream => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); });
  forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(forwarded);
});
proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
await listen(proxy);
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const env = { ...process.env, FRAMECATCH_TEST_ROOT: portableRoot };
delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
let desktop, mainPage;
const pageErrors = [];

async function helperPage(timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const page of desktop.windows()) {
      if (page === mainPage || page.isClosed()) continue;
      if (await page.evaluate(() => Boolean(window.browserHelper)).catch(() => false)) return page;
    }
    await sleep(100);
  }
  throw new Error('未找到隔离浏览器辅助工具栏窗口');
}
async function remoteDetails() {
  return desktop.evaluate(async ({ webContents, session }, localBase) => {
    const view = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(localBase + '/watch/'));
    if (!view) return null;
    const ready = await view.executeJavaScript('Boolean(document.getElementById("play-mp4"))');
    if (!ready) return null;
    const safety = await view.executeJavaScript('({desktopApi:typeof window.desktopApi,browserHelper:typeof window.browserHelper,require:typeof window.require,process:typeof window.process,url:location.href})');
    const preferences = view.getLastWebPreferences();
    return { id: view.id, safety, preferences: { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox }, isolatedSession: view.session !== session.defaultSession, storagePath: view.session.getStoragePath() };
  }, base);
}
async function remoteClick(id) {
  await desktop.evaluate(async ({ webContents }, { localBase, id }) => {
    const view = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(localBase + '/watch/'));
    if (!view) throw new Error('本地播放页未打开');
    await view.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`, true);
  }, { localBase: base, id });
}
async function state(helper) { return helper.evaluate(() => window.browserHelper.getState()); }
async function poll(fn, message, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(150); }
  throw new Error(message);
}
async function openHelper(route) {
  await mainPage.evaluate(url => {
    window.__helperAttempt = { status: 'pending' };
    void window.desktopApi.analyzeInBrowser(url).then(value => { window.__helperAttempt = { status: 'fulfilled', value }; }, error => { window.__helperAttempt = { status: 'rejected', message: error.message }; });
  }, `${base}/watch/${route}`);
  const helper = await helperPage();
  helper.on('pageerror', error => pageErrors.push(error.message));
  await helper.getByTestId('helper-candidate').waitFor();
  await poll(remoteDetails, '本地播放页加载超时');
  return helper;
}
async function noHelperRemains() {
  return desktop.evaluate(({ BrowserWindow, webContents }, { localBase, mainUrl }) => ({
    helperWindows: BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() !== mainUrl).length,
    remoteContents: webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(localBase)).length,
  }), { localBase: base, mainUrl: mainPage.url() });
}
async function capture(kind) {
  const helper = await openHelper(kind);
  const details = await remoteDetails();
  assert.deepEqual(details.safety, { desktopApi: 'undefined', browserHelper: 'undefined', require: 'undefined', process: 'undefined', url: `${base}/watch/${kind}` });
  assert.equal(details.preferences.nodeIntegration, false);
  assert.equal(details.preferences.contextIsolation, true);
  assert.equal(details.preferences.sandbox, true);
  assert.equal(details.isolatedSession, true);
  if (details.storagePath) assert.ok(details.storagePath.startsWith(portableRoot));
  await desktop.evaluate(async ({ webContents }, localBase) => {
    const view = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(localBase + '/watch/'));
    await view.session.cookies.set({ url: 'http://unrelated-fixture.invalid/', name: 'framecatch_unrelated', value: 'offsite-fixture' });
  }, base);
  const initial = await state(helper);
  assert.deepEqual(initial.candidates, []);
  const noiseBefore = requests.filter(item => /part|chunk|init|audio-only/.test(item.pathname)).length;
  await remoteClick('noise');
  await poll(async () => requests.filter(item => /part|chunk|init|audio-only/.test(item.pathname)).length >= noiseBefore + 5, '片段噪声请求未完成');
  await sleep(350);
  assert.equal((await state(helper)).candidates.length, 0, '不能把ts/m4s/init.mp4/纯音频当作完整视频候选');
  await remoteClick(kind === 'hls' ? 'play-hls' : 'play-mp4');
  const found = await poll(async () => { const value = await state(helper); return value.candidates?.length ? value : null; }, '播放后未检测到媒体候选');
  assert.equal(found.candidates.length, 1, JSON.stringify(found));
  assert.equal(found.candidates[0].kind.toLowerCase(), kind === 'hls' ? 'hls' : 'mp4');
  assert.deepEqual(Object.keys(found.candidates[0]).sort(), ['id', 'kind', 'label']);
  assert.ok(!JSON.stringify(found).includes(secret), '工具栏状态不应含Cookie值');
  assert.ok(!JSON.stringify(found.candidates).includes(mediaBase), '候选列表不应暴露原始媒体URL');
  assert.ok(!(await helper.locator('body').innerText()).includes(secret));
  await helper.screenshot({ path: path.join(runRoot, `helper-${kind}.png`), fullPage: true });
  await helper.getByTestId('helper-candidate').selectOption(found.candidates[0].id);
  await helper.getByTestId('helper-select').click();
  const outcome = await poll(async () => { const attempt = await mainPage.evaluate(() => window.__helperAttempt); return attempt.status !== 'pending' ? attempt : null; }, '选择媒体后的真实分析未完成');
  assert.equal(outcome.status, 'fulfilled', outcome.message);
  const result = outcome.value;
  assert.ok(result.entries[0].formats.length > 0);
  const video = result.entries[0];
  const context = video.mediaContext;
  assert.ok(context, '分析结果需要保留捕获上下文');
  assert.equal(context.referer, `${base}/watch/${kind}`);
  assert.equal(context.origin, base);
  assert.ok(context.userAgent.includes('Chrome') || context.userAgent.includes('Electron'));
  assert.equal(context.proxy, proxyUrl);
  assert.ok(context.cookiePath.startsWith(path.join(portableRoot, 'data', 'captures')));
  const jar = await readFile(context.cookiePath, 'utf8');
  assert.ok(jar.startsWith('# Netscape HTTP Cookie File'));
  assert.ok(jar.split(/\r?\n/).some(line => line.split('\t').slice(-2).join('=') === `${cookieName}=${secret}`));
  assert.ok(!jar.includes('offsite-fixture') && !jar.includes('framecatch_unrelated'));
  const cookieRows = jar.split(/\r?\n/).filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  assert.ok(cookieRows.every(line => line.replace(/^#HttpOnly_/, '').split('\t')[0] === '127.0.0.1'), '只能导出捕获媒体相关域Cookie');
  await poll(async () => { const remains = await noHelperRemains(); return remains.helperWindows === 0 && remains.remoteContents === 0; }, '成功选取后辅助窗口/远程WebContents未释放');
  pass(`${kind.toUpperCase()} 捕获、手动选择、参数/Cookie隔离和窗口释放`, { formats: video.formats.length, cookieFile: path.basename(context.cookiePath), proxyCaptured: true });
  const created = await mainPage.evaluate(video => window.desktopApi.enqueue([{ video, formatId: 'best', formatLabel: '本地浏览器捕获' }]), video);
  const task = await poll(async () => { const current = (await mainPage.evaluate(() => window.desktopApi.getSnapshot())).tasks.find(task => task.id === created[0].id); if (current?.status === 'failed') throw new Error(current.error); return current?.status === 'completed' ? current : null; }, '捕获媒体下载未完成', 60000);
  const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.outputPath]));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) >= 1.9);
  const log = task.logPath ? await readFile(task.logPath, 'utf8') : '';
  assert.ok(!log.includes(secret) && !log.includes(`${cookieName}=`), '下载日志不应泄露Cookie');
  pass(`${kind.toUpperCase()} 真实受保护下载并验证音视频轨道`, { outputPath: task.outputPath, duration: probe.format.duration });
  return task;
}

try {
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(portableRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  mainPage = await desktop.firstWindow();
  mainPage.on('pageerror', error => pageErrors.push(error.message));
  await mainPage.waitForFunction(() => typeof window.desktopApi?.analyzeInBrowser === 'function');
  await mainPage.getByTestId('url-input').waitFor();
  const snapshot = await mainPage.evaluate(() => window.desktopApi.getSnapshot());
  assert.equal(snapshot.portableRoot, portableRoot);
  await mainPage.evaluate(async proxy => { const state = await window.desktopApi.getSnapshot(); await window.desktopApi.saveSettings({ ...state.settings, proxy }); }, proxyUrl);
  const unauthorized = await fetch(`${mediaBase}/protected/sample.mp4`);
  assert.equal(unauthorized.status, 403);
  assert.equal((await fetch(`${mediaBase}/protected/sample.mp4`, { method: 'HEAD' })).status, 403);
  pass('新便携测试目录启动；本地服务器拒绝未带播放上下文的请求');
  report.mp4 = await capture('mp4');
  report.hls = await capture('hls');
  const before = await readdir(path.join(portableRoot, 'data', 'captures'));
  let helper = await openHelper('cancel');
  await remoteClick('head');
  await poll(async () => requests.some(item => item.method === 'HEAD' && item.authorized), '带有效播放上下文的HEAD未通过');
  await helper.getByTestId('helper-cancel').click();
  let outcome = await poll(async () => { const value = await mainPage.evaluate(() => window.__helperAttempt); return value.status === 'rejected' ? value : null; }, '取消后主窗口的Promise未结束');
  assert.match(outcome.message, /取消|关闭/);
  await poll(async () => { const value = await noHelperRemains(); return value.remoteContents === 0 && value.helperWindows === 0; }, '取消后辅助窗口残留');
  helper = await openHelper('close');
  await desktop.evaluate(({ BrowserWindow }, helperUrl) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === helperUrl); if (!window) throw new Error('辅助BrowserWindow未找到'); window.close(); }, helper.url());
  outcome = await poll(async () => { const value = await mainPage.evaluate(() => window.__helperAttempt); return value.status === 'rejected' ? value : null; }, '关闭后主窗口Promise未结束');
  assert.match(outcome.message, /取消|关闭/);
  await poll(async () => { const value = await noHelperRemains(); return value.remoteContents === 0 && value.helperWindows === 0; }, '关闭后辅助窗口残留');
  assert.deepEqual(await readdir(path.join(portableRoot, 'data', 'captures')), before, '取消/关闭不应新增Cookie导出');
  pass('取消和原生关闭均结束分析Promise并释放辅助内容，无新增捕获文件');
  assert.ok(proxyRequests.some(item => item.pathname.endsWith('sample.mp4')));
  assert.ok(proxyRequests.some(item => item.pathname.endsWith('sample.m3u8')));
  const authorized = requests.filter(item => item.authorized);
  assert.ok(authorized.some(item => /yt-dlp|Chrome|Electron/.test(item.userAgent)));
  assert.ok(authorized.some(item => item.method === 'HEAD'));
  assert.ok(authorized.some(item => item.method === 'GET'));
  const logs = await readdir(path.join(portableRoot, 'data', 'logs'));
  for (const filename of logs) { const text = await readFile(path.join(portableRoot, 'data', 'logs', filename), 'utf8'); assert.ok(!text.includes(secret) && !text.includes(`${cookieName}=`), `日志${filename}泄漏测试Cookie`); }
  assert.ok(!(await mainPage.locator('body').innerText()).includes(secret));
  assert.deepEqual(pageErrors, []);
  pass('配置代理被保留；HEAD/GET均通过播放上下文校验；主界面和所有任务日志无Cookie值');
  report.passed = true;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.passed = false; report.error = error.stack || String(error);
  if (mainPage && !mainPage.isClosed()) await mainPage.screenshot({ path: path.join(runRoot, 'failure-main.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  for (const item of [server, mediaServer, proxy]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); }
  await writeFile(path.join(runRoot, 'requests.json'), JSON.stringify({ requests, proxyRequests }, null, 2));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`浏览器辅助测试报告：${runRoot}`);
}
