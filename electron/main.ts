import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { access, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngine } from './engine';
import { openBrowserCapture, type BrowserCapture } from './browser-helper';
import { importChromeRequest } from './request-import';
import { createExtensionBridge } from './extension-bridge';
import { importExtensionCapture } from './extension-import';
import extensionManifest from '../browser-extension/manifest.json';
import { normalizeShareLink } from './share-links';
import { openDouyinCapture } from './douyin-browser';
import type { DownloadTask, ExtensionAnalysisEvent } from '../shared/types';

const devUrl = !app.isPackaged ? process.env.FRAMECATCH_DEV_URL : undefined;
const root = (!app.isPackaged && process.env.FRAMECATCH_TEST_ROOT)
  ? path.resolve(process.env.FRAMECATCH_TEST_ROOT)
  : app.isPackaged ? path.dirname(app.getPath('exe')) : path.resolve(__dirname, '..');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(root, 'resources', 'bin');
// Tests isolate mutable data while continuing to use the project's verified binaries.
const actualBinDir = !app.isPackaged && process.env.FRAMECATCH_TEST_ROOT ? path.resolve(__dirname, '../resources/bin') : binDir;
const sessionDir = path.join(root, 'data', 'browser');
let startupError: unknown;
try {
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(path.join(root, 'data', 'crashes'), { recursive: true });
  app.setPath('userData', sessionDir);
  app.setPath('sessionData', sessionDir);
  app.setPath('crashDumps', path.join(root, 'data', 'crashes'));
  app.setAppLogsPath(path.join(root, 'data', 'app-logs'));
} catch (error) { startupError = error; }
app.setName('映取 FrameCatch');
protocol.registerSchemesAsPrivileged([{ scheme: 'framecatch', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let window: BrowserWindow | null = null;
let engine: Awaited<ReturnType<typeof createEngine>>;
let closing = false;
let decidingClose = false;
let browserCapture: BrowserCapture | undefined;
let openingBrowser = false;
let browserGeneration = 0;
let extensionAnalyzing = false;
let extensionBridge: ReturnType<typeof createExtensionBridge>;
const extensionDirectory = app.isPackaged ? path.join(root, '浏览器插件') : path.resolve(__dirname, '../browser-extension');
const extensionId = [...createHash('sha256').update(Buffer.from(extensionManifest.key, 'base64')).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
function extensionEvent(event: ExtensionAnalysisEvent) {
  if (window && !window.isDestroyed()) window.webContents.send('extension:analysis', event);
}
function checkExtensionIdle() {
  if (extensionAnalyzing) throw new Error('正在分析插件发送的视频，请先完成或取消分析。');
}

async function cancelAllAnalysis() {
  ++browserGeneration;
  browserCapture?.cancel(); browserCapture = undefined;
  await engine.cancelAnalysis();
}

function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function trusted(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url ?? '';
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      !(devUrl ? new URL(url).origin === new URL(devUrl).origin : url.startsWith('framecatch://app/'))) {
    throw new Error('已拒绝来自未知页面的请求。');
  }
}
function handle(channel: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    try { return await handler(...args); }
    catch (error) { throw new Error(error instanceof Error ? error.message : '操作未完成，请重试。'); }
  });
}
function getTask(id: unknown): DownloadTask {
  if (typeof id !== 'string') throw new Error('任务编号无效。');
  const task = engine.getTasks().find(t => t.id === id);
  if (!task) throw new Error('找不到该任务。');
  return task;
}
async function inventory(directory: string): Promise<{ files: number; bytes: number }> {
  const result = { files: 0, bytes: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('工作目录含符号链接，已停止清理，请手动检查。');
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) { const child = await inventory(entryPath); result.files += child.files; result.bytes += child.bytes; }
    else if (entry.isFile()) { result.files++; result.bytes += (await stat(entryPath)).size; }
    else throw new Error('工作目录含未知文件类型，已停止清理。');
  }
  return result;
}
async function cleanup(id: unknown) {
  const task = getTask(id);
  if (['queued', 'downloading', 'merging', 'verifying'].includes(task.status)) throw new Error('请先取消活动任务，再清理临时文件。');
  if (task.status !== 'completed') throw new Error('未完成的任务保留临时文件用于续传；完成下载后可清理。');
  const candidates = [
    { directory: path.resolve(task.workDir), parent: path.join(root, 'data', 'work') },
    { directory: path.join(task.outputDir, '.framecatch-staging', task.id), parent: path.resolve(task.outputDir) },
  ];
  const directories: string[] = [];
  const info = { files: 0, bytes: 0 };
  for (const { directory, parent } of candidates) {
    const relative = path.relative(parent, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('临时目录超出指定范围，已停止清理。');
    try { await access(directory); } catch { continue; }
    const resolvedRoot = await realpath(parent);
    const resolvedDir = await realpath(directory);
    const resolvedRelative = path.relative(resolvedRoot, resolvedDir);
    if (!resolvedRelative || resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error('临时目录路径异常，已停止清理。');
    if (task.outputPath && !path.relative(directory, path.resolve(task.outputPath)).startsWith('..')) throw new Error('成品仍在临时目录，已停止清理以保护视频。');
    const count = await inventory(directory);
    info.files += count.files; info.bytes += count.bytes; directories.push(directory);
  }
  if (!info.files) return { cancelled: false, ...info };
  const answer = await dialog.showMessageBox(window!, {
    type: 'question', title: '确认清理临时文件', message: `清理“${task.video.title}”的临时文件？`,
    detail: `视频已完成并校验。为释放磁盘空间，将删除以下目录中的 ${info.files} 个分片或中间文件（逻辑大小约 ${formatBytes(info.bytes)}）：\n\n${directories.join('\n')}\n\n已下载的完整视频、日志和任务记录会保留。硬链接等可能使实际释放空间不同。此操作不可撤销。`,
    buttons: ['保留文件', '确认删除临时文件'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (answer.response !== 1) return { cancelled: true, ...info };
  // Only this explicitly confirmed, validated task-owned directory is removed.
  for (const directory of directories) await rm(directory, { recursive: true, force: false });
  return { cancelled: false, ...info };
}
function registerHandlers() {
  const pendingCleanup = new Set<string>();
  const analyzeRequest = async (text: unknown) => {
    checkExtensionIdle();
    if (browserCapture || openingBrowser) throw new Error('请先取消浏览器辅助窗口，再导入 Chrome 视频请求。');
    const generation = ++browserGeneration;
    const media = await importChromeRequest(text, { portableRoot: root, proxy: engine.getSettings().proxy });
    if (generation !== browserGeneration) throw new Error('已取消 Chrome 请求分析。');
    const result = await engine.analyze(media.url, media.context);
    if (generation !== browserGeneration) throw new Error('已取消 Chrome 请求分析。');
    return result;
  };
  handle('app:snapshot', async () => ({ tasks: engine.getTasks(), settings: engine.getSettings(), dependencies: await engine.getDependencies(), appVersion: app.getVersion(), portableRoot: root }));
  handle('share:normalize', text => normalizeShareLink(text));
  handle('share:open-page', async text => { await shell.openExternal(normalizeShareLink(text).url); });
  handle('share:analyze', async text => {
    checkExtensionIdle();
    if (browserCapture || openingBrowser) throw new Error('请先完成或取消浏览器辅助分析。');
    const link = normalizeShareLink(text);
    const generation = ++browserGeneration;
    try { return await engine.analyze(link.url); }
    catch (error) {
      if (generation !== browserGeneration) throw new Error('已取消分享视频分析。');
      const message = error instanceof Error ? error.message : '分享内容分析未完成。';
      if (link.platform === 'wechat-channels' && /暂时无法解析|没有可下载|未找到可下载|未返回有效|没有找到/.test(message)) throw new Error('已识别视频号分享链接，但分享预览页尚未提供可下载的视频。若原网页只显示二维码，请在微信中观看；这不表示作品丢失。只有能在 Chrome 实际播放的媒体，才可尝试通过插件发送。');
      if (link.platform === 'douyin' && /抖音当前解析入口|暂时无法解析|没有可下载|未返回有效/.test(message)) {
        openingBrowser = true;
        let capture: Awaited<ReturnType<typeof openDouyinCapture>> | undefined;
        try {
          capture = await openDouyinCapture({ url: link.url, portableRoot: root, proxy: engine.getSettings().proxy, parent: window || undefined, resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../resources') });
          if (generation !== browserGeneration) { capture.cancel(); throw new Error('已取消分享视频分析。'); }
          browserCapture = capture; openingBrowser = false;
          const media = await capture.result;
          if (generation !== browserGeneration) throw new Error('已取消分享视频分析。');
          if (browserCapture === capture) browserCapture = undefined;
          const result = await engine.analyze(media.url, media.context);
          if (generation !== browserGeneration) throw new Error('已取消分享视频分析。');
          result.title = media.title;
          const entry = result.entries[0];
          if (entry) {
            entry.title = media.title; entry.platform = 'Douyin';
            if (media.videoId) entry.id = media.videoId;
            if (media.duration) entry.duration = media.duration;
            if (media.uploader) entry.uploader = media.uploader;
            if (media.thumbnail) entry.thumbnail = media.thumbnail;
            for (const format of entry.formats) {
              if (media.height) format.height = media.height;
              if (media.height && media.width) format.label = format.id === 'best' ? `最高可用 MP4 · ${media.width}×${media.height}` : `${media.width}×${media.height} · MP4`;
            }
          }
          return result;
        } finally { openingBrowser = false; if (browserCapture === capture) browserCapture = undefined; }
      }
      throw error;
    }
  });
  handle('video:analyze', url => {
    checkExtensionIdle();
    if (browserCapture || openingBrowser) throw new Error('请先完成或取消浏览器辅助分析。');
    return engine.analyze(url);
  });
  handle('video:analyze-browser', async url => {
    checkExtensionIdle();
    if (browserCapture || openingBrowser) { browserCapture?.focus(); throw new Error('已有浏览器辅助窗口，请先在该窗口完成或取消。'); }
    const generation = ++browserGeneration;
    openingBrowser = true;
    let capture: BrowserCapture | undefined;
    try {
      capture = await openBrowserCapture({ url, portableRoot: root, proxy: engine.getSettings().proxy,
        resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../resources'), parent: window || undefined });
      if (generation !== browserGeneration) { capture.cancel(); throw new Error('已取消浏览器辅助分析。'); }
      browserCapture = capture; openingBrowser = false;
      const media = await capture.result;
      if (generation !== browserGeneration) throw new Error('已取消浏览器辅助分析。');
      if (browserCapture === capture) browserCapture = undefined;
      const analysis = await engine.analyze(media.url, media.context);
      if (media.title && analysis.entries.length === 1) {
        const title = media.title.replace(/\s*(?:::|\||[-–])\s*(?:Behance|Vimeo).*$/i, '').trim();
        if (title) { analysis.title = title; analysis.entries[0].title = title; }
      }
      return analysis;
    } finally {
      openingBrowser = false;
      if (browserCapture === capture) browserCapture = undefined;
    }
  });
  handle('video:cancel-analysis', cancelAllAnalysis);
  handle('video:analyze-request', analyzeRequest);
  // Reading the system clipboard occurs only through this explicit user action.
  // Neither the request text nor Cookie values are sent back to the renderer.
  handle('video:analyze-clipboard-request', () => analyzeRequest(clipboard.readText()));
  handle('extension:start', () => extensionBridge.start());
  handle('extension:status', () => extensionBridge.getStatus());
  handle('extension:stop', async () => {
    if (extensionAnalyzing) await cancelAllAnalysis();
    await extensionBridge.disable();
    return extensionBridge.getStatus();
  });
  handle('extension:forget', async () => {
    if (extensionAnalyzing) await cancelAllAnalysis();
    await extensionBridge.forget();
    return extensionBridge.getStatus();
  });
  handle('extension:open-folder', async () => {
    await access(path.join(extensionDirectory, 'manifest.json'));
    const error = await shell.openPath(extensionDirectory);
    if (error) throw new Error(error);
  });
  handle('task:enqueue', requests => engine.enqueue(requests));
  handle('task:cancel', id => engine.cancelTask(getTask(id).id));
  handle('task:retry', id => engine.retryTask(getTask(id).id));
  handle('task:cleanup', async id => {
    const task = getTask(id);
    if (pendingCleanup.has(task.id)) throw new Error('正在检查或清理该任务的临时文件，请稍候。');
    pendingCleanup.add(task.id);
    try { return await cleanup(task.id); } finally { pendingCleanup.delete(task.id); }
  });
  handle('settings:save', settings => engine.saveSettings(settings));
  handle('dialog:output-dir', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择视频保存目录', defaultPath: engine.getSettings().outputDir, properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('dialog:cookie-file', async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择 Netscape 格式 cookies.txt', filters: [{ name: 'Cookie 文件', extensions: ['txt'] }], properties: ['openFile', 'dontAddToRecent'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('shell:output', async id => {
    if (id !== undefined) {
      const task = getTask(id);
      if (task.outputPath && task.status === 'completed') { await access(task.outputPath); shell.showItemInFolder(task.outputPath); return; }
      await mkdir(task.outputDir, { recursive: true });
      const err = await shell.openPath(task.outputDir); if (err) throw new Error(err);
    } else {
      const outputDir = engine.getSettings().outputDir; await mkdir(outputDir, { recursive: true });
      const err = await shell.openPath(outputDir); if (err) throw new Error(err);
    }
  });
  handle('shell:log', async id => {
    const task = getTask(id); if (!task.logPath) throw new Error('此任务暂无日志。');
    await access(task.logPath); const err = await shell.openPath(task.logPath); if (err) throw new Error(err);
  });
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1260, height: 840, minWidth: 900, minHeight: 640, title: '映取 · FrameCatch',
    backgroundColor: '#f5f5f0', show: false, autoHideMenuBar: true,
    icon: path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../resources'), 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!(devUrl ? url.startsWith(devUrl + '/') || url === devUrl : url.startsWith('framecatch://app/'))) event.preventDefault();
  });
  window.on('ready-to-show', () => window?.show());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    if (decidingClose) return;
    decidingClose = true;
    void (async () => {
      try {
        if (engine.isBusy() || browserCapture || openingBrowser) {
          const choice = await dialog.showMessageBox(window!, { type: 'question', title: '任务正在运行', message: '还有分析或下载任务正在运行', detail: '继续下载会保留窗口。停止并退出会保留已下载的分片，下次启动可重试续传。', buttons: ['继续下载', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true });
          if (choice.response !== 1) return;
        }
        try { await cancelAllAnalysis(); await extensionBridge.stop(); await engine.stopAll(); }
        catch (error) {
          const answer = await dialog.showMessageBox(window!, { type: 'warning', title: '任务记录保存失败', message: '已停止任务，但未能保存最新记录', detail: `${error instanceof Error ? error.message : error}\n\n已下载的文件会保留。请检查磁盘空间及目录权限。`, buttons: ['仍然退出', '返回窗口'], defaultId: 0, cancelId: 1, noLink: true });
          if (answer.response !== 0) return;
        }
        closing = true; window?.close();
      } catch (error) {
        dialog.showErrorBox('退出未完成', error instanceof Error ? error.message : String(error));
      } finally { decidingClose = false; }
    })();
  });
  if (devUrl) await window.loadURL(devUrl); else await window.loadURL('framecatch://app/index.html');
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    if (startupError) throw startupError;
    await mkdir(sessionDir, { recursive: true });
    await access(root);
    protocol.handle('framecatch', async request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      const rendererRoot = path.resolve(__dirname, '../dist-renderer');
      const requestedPath = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
      const relative = path.relative(rendererRoot, requestedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      const response = await net.fetch(pathToFileURL(requestedPath).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    engine = await createEngine({ portableRoot: root, binDir: actualBinDir, onTasksChanged: (tasks: DownloadTask[]) => { if (window && !window.isDestroyed()) window.webContents.send('tasks:changed', tasks); } });
    extensionBridge = createExtensionBridge({ allowedExtensionId: extensionId,
      pairingFile: path.join(root, 'data', 'extension-pairing.json'),
      canCapture: () => !extensionAnalyzing && !engine.isAnalyzing() && !browserCapture && !openingBrowser,
      onCapture: async payload => {
      if (extensionAnalyzing || engine.isAnalyzing() || browserCapture || openingBrowser) {
        throw new Error('映取正在进行其他分析，请先完成或取消后再发送。');
      }
      extensionAnalyzing = true;
      const generation = ++browserGeneration;
      let sourceUrl = '';
      try {
        const media = await importExtensionCapture(payload, { portableRoot: root, proxy: engine.getSettings().proxy });
        if (generation !== browserGeneration) throw new Error('已取消插件视频分析。');
        sourceUrl = (payload as { pageUrl: string }).pageUrl;
        extensionEvent({ status: 'analyzing', sourceUrl });
        window?.restore(); window?.show(); window?.focus();
        const result = await engine.analyze(media.url, media.context);
        if (generation !== browserGeneration) throw new Error('已取消插件视频分析。');
        if (media.title && result.entries.length === 1) { result.title = media.title; result.entries[0].title = media.title; }
        extensionEvent({ status: 'completed', sourceUrl, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : '插件视频分析未完成，请重新播放后发送。';
        if (sourceUrl && generation === browserGeneration) extensionEvent({ status: 'failed', sourceUrl, error: message });
        throw new Error(message);
      } finally { extensionAnalyzing = false; }
    } });
    await extensionBridge.initialize();
    if (extensionBridge.getStatus().autoConnect) await extensionBridge.start();
    registerHandlers(); Menu.setApplicationMenu(null); await createWindow();
  }).catch(error => {
    dialog.showErrorBox('映取无法启动', `请将便携文件夹解压到可写入的位置后重新启动。\n\n${error instanceof Error ? error.message : error}`);
    app.exit(1);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!closing && window && !window.isDestroyed()) { event.preventDefault(); window.close(); }
  });
}
