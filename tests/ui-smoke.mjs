import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import electronPath from 'electron';

// Isolated UI fixtures: no real download, external site, system browser, or deletion.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, '.test-artifacts', `ui-${Date.now()}`);
await mkdir(path.join(fixtureDir, 'profile'), { recursive: true });
const preload = path.join(fixtureDir, 'preload.cjs');
const main = path.join(fixtureDir, 'main.cjs');
await writeFile(preload, `
const { contextBridge } = require('electron');
const calls = [];
const listeners = new Set();
const helperListeners = new Set();
let pendingBrowser = null;
let pendingRequest = null;
let helperState = { pageUrl: 'https://vimeo.example.test/play?token=secret-page', title: '视频播放测试页', loading: false, message: '', candidates: [] };
const video = (id, title) => ({ id, title, url: 'https://media.example.test/' + id, duration: 83, platform: '测试媒体', formats: [{ id: 'best', label: '最高画质 · 自动选择', ext: 'auto' }, { id: '1080', label: '1080p · 原始画质', ext: 'mp4', height: 1080 }] });
const state = {
  tasks: [], settings: { outputDir: 'G:\\\\视频', cookiePath: '', proxy: '' },
  dependencies: ['yt-dlp', 'ffmpeg', 'ffprobe', 'deno'].map(name => ({ name, available: !(process.env.FRAMECATCH_UI_MISSING && name === 'ffmpeg'), version: 'test-fixture', path: 'G:/fixture/resources/bin/' + name + '.exe' })),
  appVersion: '1.2.0', portableRoot: 'G:/fixture/便携软件'
};
const requestResult = () => {
  const mediaUrl = 'https://cdn.example.test/request.m3u8?signature=secret-request';
  return { url: mediaUrl, title: '已导入视频请求', isPlaylist: false, warnings: [], entries: [{ ...video('request', '请求导入的视频'), url: mediaUrl, mediaContext: { referer: 'https://vimeo.example.test/page', userAgent: 'request-fixture-UA', cookiePath: 'G:/fixture/request-secret-cookie.txt', proxy: '' } }] };
};
contextBridge.exposeInMainWorld('desktopApi', {
  getSnapshot: async () => state,
  analyze: async (url) => {
    calls.push({ action: 'analyze', url });
    await new Promise(resolve => setTimeout(resolve, url.includes('first') ? 700 : 40));
    if (url.includes('forbidden')) throw new Error('HTTP Error 403: Forbidden，普通解析无法访问。');
    if (url.includes('playlist')) return { url, title: '测试播放列表', isPlaylist: true, warnings: [], entries: [video('one', '列表视频一'), video('two', '列表视频二')] };
    return { url, title: '单视频', isPlaylist: false, warnings: [], entries: [video(url.includes('first') ? 'first' : 'second', url.includes('first') ? '旧请求视频' : '最新请求视频')] };
  },
  analyzeInBrowser: async (url) => {
    calls.push({ action: 'browser-analyze', url });
    if (url.includes('browser-cancel')) await new Promise((resolve, reject) => { pendingBrowser = { reject }; });
    await new Promise(resolve => setTimeout(resolve, 80));
    const mediaUrl = 'https://cdn.example.test/video.m3u8?signature=secret-media';
    return { url: mediaUrl, title: '浏览器检测结果', isPlaylist: false, warnings: ['请根据页面可用权限下载媒体。'], entries: [{ ...video('browser', '浏览器发现的视频'), url: mediaUrl, mediaContext: { referer: url, userAgent: 'fixture-UA', cookiePath: 'G:/fixture/secret-cookie.txt', proxy: '' } }] };
  },
  analyzeRequest: async (text) => {
    calls.push({ action: 'request-analyze', length: text.length, hadSecret: text.includes('secret-cookie') });
    if (text.includes('cancel-me')) await new Promise((resolve, reject) => { pendingRequest = { reject }; });
    if (text.includes('fail-request')) throw new Error('无法解析请求：' + text);
    await new Promise(resolve => setTimeout(resolve, text.includes('late-request') ? 500 : 80));
    return requestResult();
  },
  analyzeClipboardRequest: async () => {
    calls.push({ action: 'request-clipboard' });
    await new Promise(resolve => setTimeout(resolve, 80));
    return requestResult();
  },
  cancelAnalysis: async () => {
    calls.push({ action: 'cancel' });
    const request = pendingBrowser; pendingBrowser = null;
    if (request) setTimeout(() => request.reject(new Error('分析已取消')), 450);
    const imported = pendingRequest; pendingRequest = null;
    if (imported) setTimeout(() => imported.reject(new Error('请求分析已取消')), 450);
  },
  enqueue: async (requests) => {
    calls.push({ action: 'enqueue', requests });
    const added = requests.map((request, index) => ({ ...request, id: 'task-' + Date.now() + '-' + index, status: 'queued', progress: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputDir: state.settings.outputDir, workDir: 'G:/fixture/work/' + index }));
    state.tasks.push(...added); listeners.forEach(listener => listener(state.tasks)); return added;
  },
  cancelTask: async (id) => { state.tasks = state.tasks.map(task => task.id === id ? { ...task, status: 'cancelled' } : task); listeners.forEach(listener => listener(state.tasks)); },
  retryTask: async () => {},
  saveSettings: async (settings) => { calls.push({ action: 'settings', settings }); if (settings.proxy === 'fail://') throw new Error('代理地址格式无效，请使用 HTTP 或 SOCKS5。'); state.settings = settings; return settings; },
  selectOutputDir: async () => 'G:/已选择/下载目录', selectCookieFile: async () => 'G:/fixture/cookies.txt',
  openOutput: async () => {}, openLog: async () => {}, cleanupTask: async () => ({ cancelled: true, files: 0, bytes: 0 }),
  onTasksChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); }
});
contextBridge.exposeInMainWorld('browserHelper', {
  getState: async () => helperState,
  onState: listener => { helperListeners.add(listener); return () => helperListeners.delete(listener); },
  select: async id => { calls.push({ action: 'helper-select', id }); },
  cancel: () => { calls.push({ action: 'helper-cancel' }); },
  reload: () => { calls.push({ action: 'helper-reload' }); },
  back: () => { calls.push({ action: 'helper-back' }); }
});
contextBridge.exposeInMainWorld('__uiFixture', { getCalls: () => calls, setHelperState: next => { helperState = next; helperListeners.forEach(listener => listener(next)); } });
`, 'utf8');
await writeFile(main, `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(fixtureDir, 'profile'))});
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1120, height: 820, show: true, webPreferences: { preload: process.env.FRAMECATCH_UI_NO_API ? undefined : ${JSON.stringify(preload)}, contextIsolation: true, sandbox: false, nodeIntegration: false } });
  win.loadFile(process.env.FRAMECATCH_UI_HELPER ? ${JSON.stringify(path.join(root, 'resources', 'browser-helper.html'))} : ${JSON.stringify(path.join(root, 'dist-renderer', 'index.html'))});
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
async function launch(extraEnv = {}) {
  const app = await _electron.launch({ executablePath: electronPath, args: [main], env: { ...process.env, ...extraEnv }, timeout: 30000 });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  if (extraEnv.FRAMECATCH_UI_HELPER) await page.getByTestId('helper-candidate').waitFor();
  else await page.getByRole('heading', { name: '添加视频链接' }).waitFor();
  return { app, page };
}
async function paste(page, text) {
  await page.getByTestId('url-input').evaluate((input, value) => {
    input.focus(); input.select();
    const clipboardData = new DataTransfer(); clipboardData.setData('text', value);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}
async function calls(page) { return page.evaluate(() => window.__uiFixture.getCalls()); }
async function pasteRequest(page, text) {
  await page.getByTestId('request-paste').evaluate((input, value) => {
    input.focus();
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, text);
}
const result = [];
let instance;
try {
  instance = await launch();
  const { page } = instance;
  await page.getByText('引擎已就绪').waitFor();
  await page.screenshot({ path: path.join(fixtureDir, 'workspace.png'), fullPage: true });
  assert.equal(await page.getByTestId('analyze-button').isDisabled(), true);
  assert.equal(await page.getByTestId('browser-analyze-button').isDisabled(), true);
  assert.equal(await page.getByTestId('request-import-button').isEnabled(), true);

  await paste(page, 'https://media.example.test/first');
  await page.getByTestId('cancel-analysis-button').waitFor();
  await paste(page, 'https://media.example.test/second');
  await page.getByRole('heading', { name: '最新请求视频', exact: true }).waitFor();
  await wait(850);
  assert.equal(await page.getByRole('heading', { name: '旧请求视频', exact: true }).count(), 0);
  const analyzeCalls = (await calls(page)).filter((call) => call.action === 'analyze');
  assert.equal(analyzeCalls.filter((call) => call.url.endsWith('/first')).length, 1);
  assert.equal(analyzeCalls.filter((call) => call.url.endsWith('/second')).length, 1);
  assert.equal((await calls(page)).filter((call) => call.action === 'browser-analyze').length, 0);
  result.push('自动粘贴仅调用一次；连续粘贴时旧请求无法覆盖最新结果');

  await page.getByTestId('url-input').fill('https://media.example.test/changed');
  assert.equal(await page.getByTestId('download-button').count(), 0);
  result.push('修改网址立即使旧下载结果失效');

  await page.getByTestId('url-input').fill('file:///private/video.mp4');
  await page.getByTestId('analyze-button').click();
  await page.getByText('请输入完整的 http 或 https 视频网址。').waitFor();
  assert.equal((await calls(page)).filter((call) => call.action === 'analyze').length, 2);
  result.push('非HTTP视频网址不会发往下载引擎');

  await paste(page, 'https://media.example.test/playlist');
  await page.getByRole('heading', { name: '发现 2 个视频', exact: true }).waitFor();
  assert.equal(await page.getByTestId('download-button').isDisabled(), true);
  assert.equal(await page.getByRole('checkbox', { name: '选择 列表视频一', exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('checkbox', { name: '选择 列表视频二', exact: true }).isChecked(), false);
  await page.getByRole('checkbox', { name: '选择 列表视频二', exact: true }).check();
  await page.locator('#format-1').selectOption('1080');
  await page.getByTestId('download-button').click();
  await page.getByText('已将 1 个视频加入下载队列。').waitFor();
  const enqueued = (await calls(page)).find((call) => call.action === 'enqueue');
  assert.equal(enqueued.requests.length, 1);
  assert.equal(enqueued.requests[0].video.id, 'two');
  assert.equal(enqueued.requests[0].formatId, '1080');
  result.push('多视频不默认勾选，按实际勾选与画质创建任务');

  await page.getByTestId('history-nav').click();
  await page.getByRole('heading', { name: '列表视频二', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消 列表视频二', exact: true }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '需要关注' }).click();
  await page.getByRole('heading', { name: '列表视频二', exact: true }).waitFor();
  result.push('任务事件同步、取消状态与历史筛选生效');

  await page.getByTestId('settings-nav').click();
  await page.getByRole('button', { name: '选择目录', exact: true }).click();
  assert.equal(await page.locator('#output-dir').inputValue(), 'G:/已选择/下载目录');
  await page.getByRole('button', { name: '导入文件', exact: true }).click();
  assert.equal(await page.locator('#cookie-path').inputValue(), 'G:/fixture/cookies.txt');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存，将用于后续分析与新下载任务。').waitFor();
  await page.locator('#proxy').fill('fail://');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('代理地址格式无效，请使用 HTTP 或 SOCKS5。').waitFor();
  assert.equal(await page.locator('#proxy').inputValue(), 'fail://');
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), false);
  await page.screenshot({ path: path.join(fixtureDir, 'settings.png'), fullPage: true });
  result.push('原生目录与Cookie选择、设置保存成功和失败保留输入');

  await page.getByTestId('workbench-nav').click();
  await paste(page, 'https://media.example.test/forbidden');
  await page.getByText('HTTP Error 403: Forbidden，普通解析无法访问。', { exact: true }).waitFor();
  assert.equal((await calls(page)).filter((call) => call.action === 'browser-analyze').length, 0);
  await page.getByTestId('browser-analyze-retry-button').click();
  await page.getByText('请在新打开的窗口播放目标视频；登录或网站验证请手动完成。检测到媒体后会返回可选画质。').waitFor();
  await page.getByRole('heading', { name: '浏览器发现的视频', exact: true }).waitFor();
  assert.equal(await page.getByTestId('url-input').inputValue(), 'https://media.example.test/forbidden');
  assert.equal(await page.getByTestId('download-button').isEnabled(), true);
  await page.getByText('查看上次普通解析结果').click();
  await page.getByText('HTTP Error 403: Forbidden，普通解析无法访问。', { exact: true }).waitFor();
  await page.getByTestId('download-button').click();
  const browserEnqueue = (await calls(page)).filter((call) => call.action === 'enqueue').at(-1);
  assert.equal(browserEnqueue.requests[0].video.url, 'https://cdn.example.test/video.m3u8?signature=secret-media');
  assert.equal(browserEnqueue.requests[0].video.mediaContext.cookiePath, 'G:/fixture/secret-cookie.txt');
  assert.equal(browserEnqueue.requests[0].video.mediaContext.referer, 'https://media.example.test/forbidden');
  const browserResultText = await page.locator('body').innerText();
  assert.equal(browserResultText.includes('secret-cookie'), false);
  assert.equal(browserResultText.includes('signature=secret'), false);
  result.push('403失败有辅助入口，显式点击后复用结果；保留源网页及普通错误，媒体上下文透传且不展示');

  await page.getByTestId('url-input').fill('https://media.example.test/browser-cancel');
  await page.getByTestId('browser-analyze-button').click();
  await page.getByText('正在等待辅助窗口中的视频', { exact: true }).waitFor();
  await page.getByTestId('cancel-analysis-button').click();
  assert.equal(await page.getByTestId('cancel-analysis-button').isDisabled(), true);
  await wait(100);
  assert.equal(await page.getByTestId('cancel-analysis-button').count(), 1);
  assert.equal(await page.getByTestId('analyze-button').count(), 0);
  await page.getByTestId('analyze-button').waitFor();
  assert.equal(await page.getByTestId('download-button').count(), 0);
  result.push('辅助分析取消后保留等待状态，直到原始Promise真正结束');

  await page.getByTestId('browser-analyze-button').click();
  await page.getByText('正在等待辅助窗口中的视频', { exact: true }).waitFor();
  await page.getByTestId('request-import-button').click();
  await wait(100);
  assert.equal(await page.getByTestId('request-dialog').count(), 0);
  await page.getByTestId('request-dialog').waitFor();
  assert.equal((await calls(page)).filter((call) => call.action.startsWith('request-')).length, 0);
  await page.getByTestId('request-close').click();
  result.push('切换导入前等待旧辅助分析结束，开窗不自动读取请求或剪贴板');

  await page.getByTestId('url-input').fill('');
  const requestCallsBefore = (await calls(page)).filter((call) => call.action.startsWith('request-')).length;
  await page.getByTestId('request-import-button').click();
  await page.getByTestId('request-dialog').waitFor();
  assert.equal((await calls(page)).filter((call) => call.action.startsWith('request-')).length, requestCallsBefore);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('request-dialog').count(), 0);
  await page.getByTestId('request-import-button').click();
  await page.getByTestId('request-clipboard').click();
  await page.locator('.result-card').getByRole('heading', { name: '请求导入的视频', exact: true }).waitFor();
  assert.equal(await page.getByTestId('request-dialog').count(), 0);
  assert.equal(await page.getByTestId('url-input').inputValue(), '');
  assert.equal((await calls(page)).filter((call) => call.action === 'request-clipboard').length, 1);
  assert.equal((await calls(page)).filter((call) => call.action === 'request-analyze').length, 0);
  await page.getByTestId('download-button').click();
  const importedEnqueue = (await calls(page)).filter((call) => call.action === 'enqueue').at(-1);
  assert.equal(importedEnqueue.requests[0].video.url, 'https://cdn.example.test/request.m3u8?signature=secret-request');
  assert.equal(importedEnqueue.requests[0].video.mediaContext.cookiePath, 'G:/fixture/request-secret-cookie.txt');
  result.push('打开请求导入不读剪贴板；显式点击调用专用API，空URL可导入和下载且上下文完整透传');

  const sensitive = "curl 'https://cdn.example.test/master.json?token=secret-token' -H 'Cookie: session=secret-cookie' -H 'Referer: https://vimeo.example.test/page'";
  await page.getByTestId('request-import-button').click();
  assert.equal(await page.getByTestId('request-paste').evaluate((field) => field.readOnly), false);
  await page.getByTestId('request-paste').pressSequentially('typed-secret');
  assert.equal(await page.getByTestId('request-paste').inputValue(), '');
  await pasteRequest(page, sensitive);
  assert.equal(await page.getByTestId('request-paste').inputValue(), '');
  const received = await page.getByTestId('request-dialog').innerText();
  assert.ok(received.includes('敏感内容已隐藏'));
  assert.equal(received.includes('secret-cookie'), false);
  assert.equal(received.includes('secret-token'), false);
  assert.equal((await calls(page)).filter((call) => call.action === 'request-analyze').length, 0);
  await page.getByTestId('request-submit').click();
  await page.getByTestId('request-dialog').waitFor({ state: 'detached' });
  const manualCall = (await calls(page)).find((call) => call.action === 'request-analyze');
  assert.equal(manualCall.length, sensitive.length);
  assert.equal(manualCall.hadSecret, true);
  assert.equal((await page.locator('body').innerText()).includes('secret-cookie'), false);
  result.push('手动粘贴仅保存在内存并显示字符数，原文不进入textarea或DOM；点击后才调用analyzeRequest');

  await page.getByTestId('request-import-button').click();
  assert.equal(await page.getByTestId('request-submit').isDisabled(), true);
  await pasteRequest(page, sensitive + ' fail-request');
  await page.getByTestId('request-submit').click();
  await page.getByTestId('request-dialog').locator('.request-error').waitFor();
  const failureText = await page.getByTestId('request-dialog').innerText();
  assert.equal(failureText.includes('secret-cookie'), false);
  assert.equal(failureText.includes('secret-token'), false);
  assert.ok(failureText.includes('Chrome'));
  assert.equal(await page.getByTestId('request-submit').isEnabled(), true);
  await page.getByTestId('request-close').click();
  await page.getByTestId('request-import-button').click();
  assert.equal(await page.getByTestId('request-submit').isDisabled(), true);
  result.push('导入失败保留说明和重试入口，异常不回显请求原文；关闭后清空手动粘贴内容');

  await pasteRequest(page, sensitive + ' cancel-me');
  await page.getByTestId('request-submit').click();
  await page.getByTestId('request-cancel').waitFor();
  await page.getByTestId('request-cancel').click();
  assert.equal(await page.getByTestId('request-cancel').isDisabled(), true);
  await wait(100);
  assert.equal(await page.getByTestId('request-cancel').count(), 1);
  await page.getByTestId('request-cancel').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('request-dialog').isVisible(), true);
  assert.equal(await page.getByTestId('request-submit').isEnabled(), true);
  assert.equal(await page.getByTestId('download-button').count(), 0);
  result.push('请求分析可取消，等待原Promise结束，取消后保留本地说明并允许重试');

  await pasteRequest(page, sensitive + ' late-request');
  await page.getByTestId('request-submit').click();
  await page.getByTestId('request-cancel').waitFor();
  await page.getByTestId('request-close').click();
  await paste(page, 'https://media.example.test/newer-after-import');
  await page.locator('.result-card').getByRole('heading', { name: '最新请求视频', exact: true }).waitFor();
  assert.equal(await page.locator('.result-card').getByRole('heading', { name: '请求导入的视频', exact: true }).count(), 0);
  result.push('关闭导入取消旧分析；迟到的导入结果不能覆盖新网址结果');

  await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await wait(100);
  const layout = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(layout.scroll <= layout.width, '900px主窗口不应水平溢出');
  await page.screenshot({ path: path.join(fixtureDir, 'workspace-900.png'), fullPage: true });
  await page.getByTestId('request-import-button').click();
  await pasteRequest(page, sensitive);
  const dialogLayout = await page.getByTestId('request-dialog').evaluate((dialog) => ({ left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right, width: window.innerWidth, scroll: dialog.scrollWidth, client: dialog.clientWidth }));
  assert.ok(dialogLayout.left >= 0 && dialogLayout.right <= dialogLayout.width);
  assert.ok(dialogLayout.scroll <= dialogLayout.client);
  await page.screenshot({ path: path.join(fixtureDir, 'request-dialog-900.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByTestId('request-dialog').count(), 0);
  result.push('请求弹窗900px不溢出，原生焦点隔离，Esc可关闭');
  await instance.app.close(); instance = undefined;

  instance = await launch({ FRAMECATCH_UI_NO_API: '1' });
  await instance.page.getByText('当前为界面预览', { exact: true }).waitFor();
  await instance.page.getByTestId('url-input').fill('https://media.example.test/video');
  assert.equal(await instance.page.getByTestId('analyze-button').isDisabled(), true);
  assert.equal(await instance.page.getByTestId('browser-analyze-button').isDisabled(), true);
  assert.equal(await instance.page.getByTestId('request-import-button').isDisabled(), true);
  assert.equal(await instance.page.getByTestId('download-button').count(), 0);
  result.push('脱离桌面API时诚实提示预览，禁用下载入口');
  await instance.app.close(); instance = undefined;

  instance = await launch({ FRAMECATCH_UI_MISSING: '1' });
  await instance.page.getByText('下载组件不完整', { exact: true }).waitFor();
  await paste(instance.page, 'https://media.example.test/second');
  await instance.page.getByRole('heading', { name: '最新请求视频', exact: true }).waitFor();
  assert.equal(await instance.page.getByTestId('download-button').isDisabled(), true);
  result.push('缺失下载组件时提示并禁止开始下载');
  await instance.app.close(); instance = undefined;

  instance = await launch({ FRAMECATCH_UI_HELPER: '1' });
  const helperPage = instance.page;
  assert.equal(await helperPage.getByTestId('helper-select').isDisabled(), true);
  await helperPage.evaluate(() => window.__uiFixture.setHelperState({ pageUrl: 'https://vimeo.example.test/play?token=secret-page', title: '<img src=x onerror=alert(1)> 视频页面', loading: true, message: '请播放视频，验证请手动完成。', candidates: [{ id: 'a', label: '原画质', kind: 'hls' }, { id: 'b', label: '备用资源', kind: 'mp4' }] }));
  await helperPage.getByTestId('helper-candidate').selectOption('b');
  await helperPage.evaluate(() => window.__uiFixture.setHelperState({ pageUrl: 'https://vimeo.example.test/play?token=secret-page', title: '视频页面', loading: false, message: '已发现视频资源。', candidates: [{ id: 'c', label: '新发现的媒体', kind: 'dash' }, { id: 'a', label: '原画质', kind: 'hls' }, { id: 'b', label: '备用资源', kind: 'mp4' }] }));
  assert.equal(await helperPage.getByTestId('helper-candidate').inputValue(), 'b');
  assert.equal((await helperPage.locator('body').innerText()).includes('secret-page'), false);
  assert.equal(await helperPage.locator('img').count(), 0);
  await helperPage.getByTestId('helper-reload').click();
  await helperPage.getByTestId('helper-back').click();
  await helperPage.getByTestId('helper-select').click();
  await helperPage.getByTestId('helper-cancel').click();
  const helperCalls = await calls(helperPage);
  assert.ok(helperCalls.some((call) => call.action === 'helper-select' && call.id === 'b'));
  assert.ok(helperCalls.some((call) => call.action === 'helper-reload'));
  assert.ok(helperCalls.some((call) => call.action === 'helper-back'));
  assert.ok(helperCalls.some((call) => call.action === 'helper-cancel'));
  await instance.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  const toolbarBounds = await helperPage.locator('.toolbar').boundingBox();
  assert.equal(toolbarBounds.height, 178);
  assert.ok(await helperPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await helperPage.screenshot({ path: path.join(fixtureDir, 'browser-helper.png') });
  result.push('178px辅助工具栏：候选保留选择、无签名URL/HTML注入、所有操作API和900px布局');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: result, fixtureDir, pageErrors: errors }, null, 2));
} finally {
  if (instance) await instance.app.close();
}
