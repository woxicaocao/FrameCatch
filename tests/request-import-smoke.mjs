import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import electronPath from 'electron';

// Real engine/ffmpeg tests, using only generated local media and an isolated
// app. clipboard.readText is replaced inside that app; the OS clipboard is
// neither read nor written. Every output is retained for diagnosis.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = path.join(root, '.test-artifacts', `request-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const fixtureDir = path.join(runRoot, 'fixtures');
const portableRoot = path.join(runRoot, '请求导入 隔离便携版');
await mkdir(fixtureDir, { recursive: true });
const packagedSource = process.env.FRAMECATCH_REQUEST_TEST_PACKAGED;
if (packagedSource) await cp(path.resolve(packagedSource), portableRoot, { recursive: true, errorOnExist: true, force: false });
const binDir = path.join(packagedSource ? path.join(portableRoot, 'resources') : path.join(root, 'resources'), 'bin');
const ffmpeg = path.join(binDir, 'ffmpeg.exe');
const ffprobe = path.join(binDir, 'ffprobe.exe');
const cookieName = 'framecatch_request_test';
const cookieValue = 'fixture-cookie-must-never-be-displayed';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ignoredHeader = 'ordinary-header-must-not-be-forwarded';
const mp4Query = '?sig=fixture-signature&expires=1795000000';
const hlsQuery = '?sig=fixture%2Bsignature%2Fhls%3D&token=a%26b';
const requests = [];
const activeSlowResponses = new Set();
const report = { startedAt: new Date().toISOString(), artifacts: runRoot, packaged: Boolean(packagedSource), checks: [] };
const pass = (name, detail) => { report.checks.push({ name, passed: true, detail }); console.log(`通过：${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(executable, args, cwd = fixtureDir, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`执行超时：${path.basename(executable)}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-5000) || `退出码 ${code}`)); });
  });
}
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libopenh264', '-b:v', '250k', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-movflags', '+faststart', 'sample.mp4']);
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'sample.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', 'part%03d.ts', 'sample.m3u8']);
const plainHls = await readFile(path.join(fixtureDir, 'sample.m3u8'), 'utf8');
await writeFile(path.join(fixtureDir, 'signed.m3u8'), plainHls.replace(/^(part\d+\.ts)$/gm, `$1${hlsQuery}`));
pass('生成本地2秒 MP4 和带完整签名分片地址的 HLS 音视频夹具');

let base, referer;
const server = createServer(async (request, response) => {
  const target = new URL(request.url, 'http://fixture.local');
  const pathname = target.pathname;
  const slow = pathname === '/protected/slow.mp4';
  if (!pathname.startsWith('/protected/')) { response.writeHead(404).end('local request-import fixture only'); return; }
  const expectedQuery = /\.m3u8$|\.ts$/.test(pathname) ? hlsQuery : mp4Query;
  const checks = {
    userAgent: request.headers['user-agent'] === userAgent,
    referer: request.headers.referer === referer,
    origin: request.headers.origin === base,
    cookie: request.headers.cookie?.split(';').some(value => value.trim() === `${cookieName}=${cookieValue}`) || false,
    signature: target.search === expectedQuery,
    ordinaryHeaderIgnored: request.headers['x-do-not-forward'] === undefined,
  };
  const authorized = Object.values(checks).every(Boolean);
  requests.push({ pathname, method: request.method, authorized, checks });
  if (!authorized) { response.writeHead(403, { 'Content-Type': 'text/plain' }).end('local fixture rejected incomplete playback context'); return; }
  const send = async () => {
    try {
      const local = path.join(fixtureDir, pathname.endsWith('.m3u8') ? 'signed.m3u8' : slow ? 'sample.mp4' : path.basename(pathname));
      const info = await stat(local);
      let start = 0, end = info.size - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      const type = pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
      const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') response.end();
      else { const stream = createReadStream(local, { start, end }); stream.pipe(response); response.on('close', () => stream.destroy()); }
    } catch { if (!response.headersSent) response.writeHead(404); response.end('fixture not found'); }
  };
  if (slow) {
    activeSlowResponses.add(response);
    const timer = setTimeout(() => void send(), 10000);
    response.on('close', () => { clearTimeout(timer); activeSlowResponses.delete(response); });
  } else await send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
referer = `${base}/watch/actual-playback-page`;
const mp4Url = `${base}/protected/sample.mp4${mp4Query}`;
const hlsUrl = `${base}/protected/sample.m3u8${hlsQuery}`;
const slowUrl = `${base}/protected/slow.mp4${mp4Query}`;
const curlBash = (url, headerCookie = false) => [
  `curl '${url}'`, `  -H 'User-Agent: ${userAgent}'`, `  -H 'Referer: ${referer}'`, `  -H 'Origin: ${base}'`,
  headerCookie ? `  -H 'Cookie: ${cookieName}=${cookieValue}'` : `  -b '${cookieName}=${cookieValue}'`,
  `  -H 'Accept: */*'`, `  -H 'X-Do-Not-Forward: ${ignoredHeader}'`, '  --compressed',
].join(' \\\n');
// Confirmed current DevTools cmd quoting: ^"...^", ^& / ^( / ^),
// with caret + CRLF between arguments. The test passes this as data only.
const cmdQuote = value => `^"${value.replace(/[&()]/g, char => `^${char}`)}^"`;
const curlCmd = url => [
  `curl --url ${cmdQuote(url)}`, `  -H ${cmdQuote(`User-Agent: ${userAgent}`)}`, `  -H ${cmdQuote(`Referer: ${referer}`)}`,
  `  -H ${cmdQuote(`Origin: ${base}`)}`, `  -b ${cmdQuote(`${cookieName}=${cookieValue}`)}`,
  `  -H ${cmdQuote(`X-Do-Not-Forward: ${ignoredHeader}`)}`, '  --compressed',
].join(' ^\r\n');
const bashMp4 = curlBash(mp4Url);
const bashHls = curlBash(hlsUrl, true);
const cmdMp4 = curlCmd(mp4Url);
const env = { ...process.env, FRAMECATCH_TEST_ROOT: portableRoot };
delete env.ELECTRON_RUN_AS_NODE; delete env.FRAMECATCH_DEV_URL;
let desktop, page;
const pageErrors = [];
const assertNoCredentials = (text, label) => {
  assert.ok(!text.includes(cookieValue), `${label}泄漏测试Cookie`);
  assert.ok(!text.includes(`${cookieName}=`), `${label}泄漏Cookie原文`);
  assert.ok(!text.includes(bashMp4) && !text.includes(cmdMp4) && !text.includes(bashHls), `${label}保留完整cURL原文`);
};
async function poll(fn, message, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await sleep(150); }
  throw new Error(message);
}
async function snapshot() { return page.evaluate(() => window.desktopApi.getSnapshot()); }
async function clipboardCount() { return desktop.evaluate(() => globalThis.__requestImportFixture.reads); }
async function setClipboardFixture(text) { await desktop.evaluate((_electron, text) => { globalThis.__requestImportFixture.text = text; }, text); }
async function captureFiles() { try { return (await readdir(path.join(portableRoot, 'data/captures'))).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function pasteRequest(text) {
  await page.getByTestId('request-paste').evaluate((area, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    area.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}
async function waitTask(id) {
  return poll(async () => { const task = (await snapshot()).tasks.find(task => task.id === id); if (task?.status === 'failed') throw new Error(task.error); return task?.status === 'completed' ? task : null; }, '受保护请求的下载任务未完成', 60000);
}
async function verifyOutput(task, label) {
  const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.outputPath]));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) >= 1.9);
  assertNoCredentials(await readFile(task.logPath, 'utf8'), `${label}任务日志`);
  pass(`${label}真实下载且成品包含完整音视频`, { duration: probe.format.duration, outputPath: task.outputPath });
}
async function verifyContext(result, expectedUrl, label) {
  assert.equal(result.entries.length, 1);
  assert.ok(result.entries[0].formats.length > 0);
  const entry = result.entries[0];
  assert.equal(entry.url, expectedUrl);
  assert.equal(entry.mediaContext.referer, referer);
  assert.equal(entry.mediaContext.userAgent, userAgent);
  assert.equal(entry.mediaContext.origin, base);
  assert.equal(entry.mediaContext.proxy, '');
  assert.ok(entry.mediaContext.cookiePath.startsWith(path.join(portableRoot, 'data/captures')));
  const jar = await readFile(entry.mediaContext.cookiePath, 'utf8');
  assert.ok(jar.startsWith('# Netscape HTTP Cookie File'));
  assert.ok(jar.split(/\r?\n/).some(line => line.split('\t').slice(-2).join('=') === `${cookieName}=${cookieValue}`));
  assertNoCredentials(JSON.stringify(await snapshot()), '应用快照');
  pass(`${label}完整签名地址与四项播放上下文保留`, { formats: entry.formats.length, cookieFile: path.basename(entry.mediaContext.cookiePath) });
  return entry;
}

try {
  desktop = await _electron.launch({ executablePath: packagedSource ? path.join(portableRoot, 'FrameCatch.exe') : electronPath, args: packagedSource ? [] : [root], env, timeout: 60000 });
  // Replace only this test app's read method. Never call the original method,
  // clipboard.writeText, navigator.clipboard, or a system clipboard utility.
  await desktop.evaluate(({ clipboard }) => {
    globalThis.__requestImportFixture = { reads: 0, text: '' };
    clipboard.readText = () => { globalThis.__requestImportFixture.reads++; return globalThis.__requestImportFixture.text; };
  });
  page = await desktop.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.desktopApi?.analyzeRequest === 'function' && typeof window.desktopApi?.analyzeClipboardRequest === 'function');
  await page.getByTestId('url-input').waitFor();
  await page.getByText('引擎已就绪').waitFor();
  const initial = await snapshot();
  assert.equal(initial.portableRoot, portableRoot);
  assert.equal(initial.dependencies.filter(item => item.available).length, 4);
  assert.equal(await clipboardCount(), 0);
  const bare = await fetch(mp4Url);
  assert.equal(bare.status, 403);
  pass('独立便携测试环境启动，不自动读取剪贴板；无播放上下文的签名资源被拒绝');

  const originalInput = `${base}/watch/different-web-page`;
  await page.getByTestId('url-input').fill(originalInput);
  await page.getByTestId('request-import-button').click();
  await page.getByTestId('request-dialog').waitFor();
  assert.equal(await clipboardCount(), 0);
  await pasteRequest(cmdMp4);
  assert.equal(await page.getByTestId('request-paste').inputValue(), '');
  assertNoCredentials(await page.locator('body').innerText(), '导入弹窗');
  assert.equal(await page.getByTestId('request-submit').isDisabled(), false);
  await page.getByTestId('request-close').click();
  await page.getByTestId('request-dialog').waitFor({ state: 'hidden' });
  assert.equal(await clipboardCount(), 0);
  assert.deepEqual(await captureFiles(), []);
  await page.getByTestId('request-import-button').click();
  assert.equal(await page.getByTestId('request-submit').isDisabled(), true);
  assert.equal(await page.getByTestId('request-paste').inputValue(), '');
  pass('导入弹窗手动粘贴不显示原文，取消清空待解析数据且不读取剪贴板/不导出Cookie');

  await setClipboardFixture(bashMp4);
  await page.getByTestId('request-clipboard').click();
  await page.getByTestId('download-button').waitFor({ timeout: 45000 });
  assert.equal(await clipboardCount(), 1);
  assert.equal(await page.getByTestId('url-input').inputValue(), originalInput);
  assertNoCredentials(await page.locator('body').innerText(), '导入完成主界面');
  const formats = await page.locator('#format-0').locator('option').evaluateAll(options => options.map(option => option.value));
  const selected = formats.find(id => id !== 'best') || 'best';
  await page.locator('#format-0').selectOption(selected);
  await sleep(250);
  assert.equal(await page.locator('#format-0').inputValue(), selected);
  assert.equal(await page.getByTestId('download-button').isDisabled(), false);
  assert.equal(await page.getByTestId('url-input').inputValue(), originalInput);
  await page.screenshot({ path: path.join(runRoot, 'import-result.png'), fullPage: true });
  pass('仅显式操作读取一次合成剪贴板；来源网页与媒体地址不同仍保留结果和画质选择');
  await page.getByTestId('download-button').click();
  const uiTask = await poll(async () => { const task = (await snapshot()).tasks[0]; return task ? task : null; }, 'UI未创建下载任务');
  const completedMp4 = await waitTask(uiTask.id);
  await verifyContext({ entries: [completedMp4.video] }, mp4Url, 'Bash -b Cookie 导入');
  await verifyOutput(completedMp4, 'UI导入MP4');
  report.mp4TaskId = completedMp4.id;

  const cmdResult = await page.evaluate(text => window.desktopApi.analyzeRequest(text), cmdMp4);
  await verifyContext(cmdResult, mp4Url, 'Chrome CMD caret/CRLF 导入');
  assert.equal(await clipboardCount(), 1);
  const hlsResult = await page.evaluate(text => window.desktopApi.analyzeRequest(text), bashHls);
  const hlsEntry = await verifyContext(hlsResult, hlsUrl, 'Bash -H Cookie HLS导入');
  const hlsCreated = await page.evaluate(video => window.desktopApi.enqueue([{ video, formatId: 'best', formatLabel: '请求导入HLS' }]), hlsEntry);
  const completedHls = await waitTask(hlsCreated[0].id);
  await verifyOutput(completedHls, 'HLS签名分片合并');
  report.hlsTaskId = completedHls.id;

  const invalid = [
    ['Authorization', `${bashMp4} -H 'Authorization: Bearer test-token'`],
    ['POST/body', `${bashMp4} -X POST --data 'test-body'`],
    ['multiple URLs', `${bashMp4} '${hlsUrl}'`],
    ['cookie file', `curl '${mp4Url}' -A '${userAgent}' -e '${referer}' -b '@cookies.txt'`],
    ['shell commands', `${bashMp4} && echo never-execute-this-command`],
  ];
  const beforeInvalidRequests = requests.length;
  const beforeInvalidFiles = await captureFiles();
  for (const [label, text] of invalid) {
    let message = '';
    try { await page.evaluate(text => window.desktopApi.analyzeRequest(text), text); } catch (error) { message = error.message; }
    assert.ok(message, `${label}应被拒绝`); assertNoCredentials(message, `${label}错误消息`);
  }
  assert.equal(requests.length, beforeInvalidRequests, '无效命令不得进入HTTP请求/下载器');
  assert.deepEqual(await captureFiles(), beforeInvalidFiles, '无效命令不应生成凭据文件');
  pass('拒绝认证头、POST/body、多网址、Cookie文件输入和shell命令，未发网络请求或保存凭据');

  const tasksBeforeCancel = (await snapshot()).tasks.length;
  await setClipboardFixture(curlBash(slowUrl));
  await page.getByTestId('request-import-button').click();
  await page.getByTestId('request-clipboard').click();
  await poll(() => activeSlowResponses.size > 0, '慢速分析请求没有启动');
  if (await page.getByTestId('request-cancel').isVisible()) await page.getByTestId('request-cancel').click();
  else await page.getByTestId('cancel-analysis-button').click();
  await page.getByTestId('analyze-button').waitFor({ timeout: 20000 });
  await poll(() => activeSlowResponses.size === 0, '取消后分析子进程的HTTP连接未释放', 20000);
  assert.equal((await snapshot()).tasks.length, tasksBeforeCancel);
  assert.equal(await clipboardCount(), 2);
  const recovered = await page.evaluate(text => window.desktopApi.analyzeRequest(text), bashMp4);
  assert.ok(recovered.entries[0].formats.length);
  pass('导入分析可取消且释放请求，不产生任务，取消后可重新解析');

  assertNoCredentials(JSON.stringify(await snapshot()), '最终应用快照');
  assertNoCredentials(await page.locator('body').innerText(), '最终界面');
  assertNoCredentials(await readFile(path.join(portableRoot, 'data/state.json'), 'utf8'), '持久化任务状态');
  for (const name of await readdir(path.join(portableRoot, 'data/logs'))) assertNoCredentials(await readFile(path.join(portableRoot, 'data/logs', name), 'utf8'), `日志${name}`);
  assert.ok(requests.some(item => item.authorized && item.pathname.endsWith('.ts')), '必须实际下载HLS分片');
  assert.ok(requests.filter(item => item.authorized).every(item => Object.values(item.checks).every(Boolean)));
  assert.deepEqual(pageErrors, []);
  assert.equal(await clipboardCount(), 2);
  pass('普通头未转发；界面/快照/持久化/日志均无原始cURL与Cookie；无额外剪贴板读取');
  report.passed = true; report.completedAt = new Date().toISOString();
} catch (error) {
  report.passed = false; report.error = error.stack || String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(runRoot, 'failure-main.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (desktop) {
    if (page && !page.isClosed()) await page.evaluate(() => window.desktopApi.cancelAnalysis()).catch(() => {});
    await desktop.close().catch(() => {});
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(runRoot, 'requests.json'), JSON.stringify(requests, null, 2));
  await writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`浏览器请求导入测试报告：${runRoot}`);
}
