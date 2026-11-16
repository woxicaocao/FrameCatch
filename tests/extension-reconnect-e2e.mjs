import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

// Uses only fresh, test-owned Chrome/app profiles. The fixture manifest grants
// declared optional hosts up front; production JS/HTML/CSS stay byte-identical.
// No user browser, cookies, clipboard, file removal or native permission clicks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, _electron } = await import('playwright');
const runRoot = path.join(root, '.test-artifacts', `extension-reconnect-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtureDir = path.join(runRoot, 'fixtures');
const appRoot = path.join(runRoot, '自动重连测试 便携版');
const profile = path.join(runRoot, 'fresh-chrome-profile');
const extensionDir = path.join(runRoot, 'extension-preauthorized-fixture');
const packagedSource = process.env.FRAMECATCH_EXTENSION_TEST_PACKAGED;
const localKey = 'framecatch-pairing-v1';
const sessionKey = 'framecatch-session-v1';
await mkdir(fixtureDir, { recursive: true });
if (packagedSource) await cp(path.resolve(packagedSource), appRoot, { recursive: true, force: false, errorOnExist: true });
const sourceExtension = process.env.FRAMECATCH_EXTENSION_DIR || (packagedSource ? path.join(appRoot, '浏览器插件') : path.join(root, 'browser-extension'));
const bin = path.join(packagedSource ? path.join(appRoot, 'resources') : path.join(root, 'resources'), 'bin');
const ffmpeg = path.join(bin, 'ffmpeg.exe'), ffprobe = path.join(bin, 'ffprobe.exe');
const manifest = JSON.parse(await readFile(path.join(sourceExtension, 'manifest.json'), 'utf8'));
await cp(sourceExtension, extensionDir, { recursive: true, force: false, errorOnExist: true });
const fixtureManifest = { ...manifest, host_permissions: [...new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])])] };
delete fixtureManifest.optional_host_permissions;
await writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(fixtureManifest, null, 2));
for (const name of await readdir(sourceExtension)) if (/\.(?:js|html|css)$/.test(name)) {
  assert.equal(createHash('sha256').update(await readFile(path.join(extensionDir, name))).digest('hex'), createHash('sha256').update(await readFile(path.join(sourceExtension, name))).digest('hex'), `运行文件不同：${name}`);
}
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .flatMap(byte => [byte >> 4, byte & 15]).map(value => String.fromCharCode(97 + value)).join('');
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, packaged: Boolean(packagedSource), extensionId,
  permissionSetup: '仅测试副本预授权正式声明的optional hosts；正式runtime逐文件哈希相同；首次用户权限UI不自动操作', checks: [] };
const pass = (name, details) => { report.checks.push({ name, passed: true, details }); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cookieName = 'framecatch_reconnect_fixture', cookieValue = 'test-reconnect-private-cookie';
const signature = '?sig=test-reconnect-private-signature';
const pageErrors = [], requests = [];
let desktop, page, browser, worker, watch, popup, base, referer, retainedToken;
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: fixtureDir, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`夹具进程超时：${path.basename(exe)}`)); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-2000) || `退出码 ${code}`)); });
  });
}
async function poll(callback, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await sleep(150); }
  throw new Error(message);
}
function assertPrivate(text, label) {
  assert.ok(!text.includes(cookieValue) && !text.includes(`${cookieName}=`), `${label}含媒体Cookie`);
  assert.ok(!text.includes('test-reconnect-private-signature'), `${label}含媒体签名`);
}
async function launchDesktop() {
  const env = { ...process.env, FRAMECATCH_TEST_ROOT: appRoot };
  delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(appRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  page = await desktop.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByTestId('url-input').waitFor();
}
async function launchBrowser() {
  const executablePath = process.env.FRAMECATCH_EXTENSION_CHROMIUM || chromium.executablePath();
  await access(executablePath);
  report.browserExecutable = executablePath;
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: process.env.FRAMECATCH_EXTENSION_HEADFUL !== '1', ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-proxy-server'] });
  worker = browser.serviceWorkers().find(value => value.url().startsWith(`chrome-extension://${extensionId}/`)) || await browser.waitForEvent('serviceworker', { predicate: value => value.url().startsWith(`chrome-extension://${extensionId}/`), timeout: 30000 });
  watch = await browser.newPage(); await watch.goto(`${base}/login`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).filter(tab => tab.url === url).at(-1)?.id, referer);
  assert.equal(typeof tabId, 'number');
  popup = await browser.newPage(); popup.on('pageerror', error => pageErrors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  return tabId;
}
async function popupState(tabId) { return popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'popup:state', tabId }), tabId); }
async function assertLocalPairOnly() {
  const local = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(Object.keys(local), [localKey], '持久存储只能包含配对记录');
  assert.deepEqual(Object.keys(local[localKey]), ['token'], '配对记录不能附带媒体或账号字段');
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(local[localKey].token), '只允许随机配对令牌');
  assertPrivate(JSON.stringify(local), '扩展持久存储');
  return local[localKey].token;
}
const server = createServer(async (request, response) => {
  const target = new URL(request.url, base || 'http://fixture.local');
  if (target.pathname === '/login') {
    response.writeHead(302, { Location: '/watch', 'Set-Cookie': `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax`, 'Cache-Control': 'no-store' }).end(); return;
  }
  if (target.pathname === '/watch') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'unsafe-url', 'Cache-Control': 'no-store' }).end(`<!doctype html><meta charset="utf-8"><title>自动重连隔离测试</title><button id="play">播放测试视频</button><video id="video" controls width="400"></video><script>document.querySelector('#play').onclick=()=>{const v=document.querySelector('#video');v.src='/media.mp4${signature}';v.play().catch(()=>{});};</script>`); return;
  }
  if (target.pathname !== '/media.mp4') { response.writeHead(404).end(); return; }
  const checks = { cookie: request.headers.cookie?.split(';').some(value => value.trim() === `${cookieName}=${cookieValue}`) || false,
    referer: request.headers.referer === referer, signature: target.search === signature, userAgent: Boolean(request.headers['user-agent']) };
  const authorized = Object.values(checks).every(Boolean); requests.push({ authorized, checks });
  if (!authorized) { response.writeHead(403).end('requires fixture session'); return; }
  try {
    const file = path.join(fixtureDir, 'media.mp4'), total = (await stat(file)).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start > end) { response.writeHead(416).end(); return; }
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}) });
    if (request.method === 'HEAD') response.end();
    else { const stream = createReadStream(file, { start, end }); stream.pipe(response); response.on('close', () => stream.destroy()); }
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});

try {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libopenh264', '-b:v', '250k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'media.mp4']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`; referer = `${base}/watch`;
  assert.equal((await fetch(`${base}/media.mp4${signature}`)).status, 403);
  await launchDesktop();
  const initial = await page.evaluate(() => window.desktopApi.getExtensionBridgeStatus());
  assert.equal(initial.running, false, '首次未配对不应自动监听');
  await page.getByTestId('extension-open').click(); await page.getByTestId('extension-start').click();
  const code = await poll(async () => (await page.evaluate(() => window.desktopApi.getExtensionBridgeStatus())).pairingCode, '首次配对码未显示');
  let tabId = await launchBrowser();
  await popup.getByTestId('pair-code').fill(code); await popup.getByTestId('pair-button').click();
  await poll(async () => (await popupState(tabId)).connection === 'connected', '首次配对未连接');
  retainedToken = await assertLocalPairOnly();
  const pairingPath = path.join(appRoot, 'data/extension-pairing.json');
  const pairingText = await readFile(pairingPath, 'utf8'), pairing = JSON.parse(pairingText);
  assert.ok(pairing.tokenHash === createHash('sha256').update(retainedToken).digest('hex'), '桌面仅保存配对令牌哈希');
  assert.ok(!pairingText.includes(retainedToken), '桌面不能保存明文令牌');
  assert.equal(pairing.autoConnect, true);
  assertPrivate(pairingText, '桌面配对文件');
  pass('首次配对成功；桌面仅保存哈希，扩展持久区仅保存随机配对令牌');

  await popup.getByTestId('detect-start').click();
  await poll(async () => (await popupState(tabId)).active, '未开始当前页检测');
  await watch.getByRole('button', { name: '播放测试视频' }).click();
  await poll(async () => (await popupState(tabId)).captures.length > 0, '未捕获重启前的测试媒体');
  await popup.screenshot({ path: path.join(runRoot, 'before-restart-captured.png'), fullPage: true });
  await desktop.close(); desktop = undefined; page = undefined;
  await poll(async () => (await popupState(tabId)).connection === 'waiting', '软件关闭后未自动转为等待状态', 20000);
  assert.ok(await assertLocalPairOnly() === retainedToken, '离线不得丢失已记住配对');
  await launchDesktop();
  await poll(async () => { const state = await page.evaluate(() => window.desktopApi.getExtensionBridgeStatus()); return state.running && state.paired && state.remembered && state.autoConnect; }, '重启软件没有自动恢复监听');
  await poll(async () => (await popupState(tabId)).connection === 'connected', '插件没有自动重连重启的软件', 20000);
  await popup.screenshot({ path: path.join(runRoot, 'desktop-restarted-connected.png'), fullPage: true });
  pass('正常退出保留配对；软件重启自动监听，插件离线等待后无需输入配对码自动连接');

  await browser.close(); browser = undefined; worker = undefined; popup = undefined; watch = undefined;
  tabId = await launchBrowser();
  await poll(async () => (await popupState(tabId)).connection === 'connected', '浏览器重启没有从持久令牌自动连接', 20000);
  const restartedState = await popupState(tabId);
  assert.deepEqual(restartedState.captures, [], '浏览器重启不得恢复含Cookie的媒体候选');
  assert.equal(restartedState.active, false, '浏览器重启不得主动检测新标签页');
  const session = await worker.evaluate(key => chrome.storage.session.get(key), sessionKey);
  assertPrivate(JSON.stringify(session), '浏览器重启后的会话区');
  assert.ok(await assertLocalPairOnly() === retainedToken, '重启应复用已保存配对');
  await popup.screenshot({ path: path.join(runRoot, 'browser-restarted-connected.png'), fullPage: true });
  pass('重启Chrome同一测试配置自动连接；媒体候选和检测状态为空，Cookie未被持久化');

  await popup.getByTestId('detect-start').click();
  await poll(async () => (await popupState(tabId)).active, '重启后未启用用户选择的标签页');
  await watch.getByRole('button', { name: '播放测试视频' }).click();
  await poll(async () => (await popupState(tabId)).captures.length > 0, '重启后未捕获媒体');
  await popup.getByTestId('capture-send').click();
  await page.getByTestId('download-button').waitFor({ timeout: 45000 });
  assert.equal((await page.evaluate(() => window.desktopApi.getSnapshot())).tasks.length, 0, '自动连接不等于自动下载');
  await page.getByTestId('download-button').click();
  const completed = await poll(async () => { const task = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks[0]; if (task?.status === 'failed') throw new Error(task.error); return task?.status === 'completed' && task; }, '自动重连后下载未完成', 60000);
  const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completed.outputPath]));
  assert.ok(probe.streams.some(value => value.codec_type === 'video') && probe.streams.some(value => value.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) >= 1.9);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', completed.outputPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  assertPrivate(await readFile(completed.logPath, 'utf8'), '任务日志');
  await page.screenshot({ path: path.join(runRoot, 'reconnected-download-completed.png'), fullPage: true });
  pass('自动重连后真实请求带媒体会话完成下载，成品双轨、时长及全片解码通过', { duration: probe.format.duration, outputPath: completed.outputPath });

  await page.getByTestId('extension-open').click();
  await page.getByTestId('extension-forget').click();
  await poll(async () => await page.getByTestId('extension-start').isVisible() && await page.getByTestId('extension-start').isEnabled(), '忘记配对尚未完成写盘');
  const forgotten = await page.evaluate(() => window.desktopApi.getExtensionBridgeStatus());
  assert.equal(forgotten.running, false); assert.equal(forgotten.remembered, false); assert.equal(forgotten.paired, false);
  const forgottenText = await readFile(pairingPath, 'utf8');
  assert.ok(!forgottenText.includes(createHash('sha256').update(retainedToken).digest('hex')), '撤销后不能保留旧令牌哈希');
  await page.getByTestId('extension-start').click();
  const denied = await worker.evaluate(async token => { const response = await fetch('http://127.0.0.1:46783/v1/status', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit' }); return response.status; }, retainedToken);
  assert.equal(denied, 401);
  await poll(async () => (await popupState(tabId)).connection === 'unpaired', '撤销后旧插件令牌没有失效', 20000);
  assert.deepEqual(pageErrors, []);
  pass('用户忘记配对后停止自动连接；重新开启接口仍拒绝旧令牌，需要新的配对码');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = (error.stack || String(error)).replaceAll(retainedToken || '\u0000', '[测试配对令牌已隐藏]');
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runRoot, 'failure-desktop.png'), fullPage: true }).catch(() => {});
  if (popup && !popup.isClosed()) await popup.screenshot({ path: path.join(runRoot, 'failure-extension.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  // Close normally: stopExtensionBridge() is an explicit user disable and would
  // test a different state from the ordinary app-exit reconnect behavior.
  if (desktop) {
    if (page && !page.isClosed()) await page.evaluate(async () => {
      await window.desktopApi.cancelAnalysis();
      for (const task of (await window.desktopApi.getSnapshot()).tasks) if (['queued', 'downloading', 'merging', 'verifying'].includes(task.status)) await window.desktopApi.cancelTask(task.id);
    }).catch(() => {});
    await desktop.close().catch(() => {});
  }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(runRoot, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`自动重连端到端报告：${runRoot}`);
}
