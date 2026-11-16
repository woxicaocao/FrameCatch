import { BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import type { WebContents, Cookie, IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaContext } from '../shared/types';
import { validateUrl } from './engine-helpers';
import { cookieJar, mediaKind, normalizeCapturedMediaUrl, privateUrlLabel, safeHttp, safeOrigin, type MediaKind } from './browser-helper-utils';

export interface CapturedMedia { url: string; context: MediaContext; title: string; }
interface Candidate { id: string; url: string; kind: MediaKind; referer: string; userAgent: string; origin?: string; }
interface HelperOptions { url: string; portableRoot: string; proxy: string; resourcesDir: string; parent?: BrowserWindow; }
export interface BrowserCapture { result: Promise<CapturedMedia>; cancel(): void; focus(): void; }

/** Only the helper's isolated session is observed. No installed browser profile,
 * debugger port, injected page script, or user browser cookie store is read. */
export async function openBrowserCapture(options: HelperOptions): Promise<BrowserCapture> {
  const pageUrl = validateUrl(options.url);
  if (options.proxy && (new URL(options.proxy).username || new URL(options.proxy).password)) throw new Error('浏览器辅助暂不支持带账号密码的代理，请使用本机代理端口或系统代理后重试。');
  const profile = path.join(options.portableRoot, 'data', 'helper-browser');
  await mkdir(profile, { recursive: true });
  const browserSession = session.fromPath(profile);
  await browserSession.setProxy(options.proxy ? { proxyRules: options.proxy.replace(/^socks5h:/i, 'socks5:'), proxyBypassRules: '<-loopback>' } : { mode: 'system' });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  // app.setName contains Chinese. Electron's application token would otherwise
  // become question marks in HTTP headers. Use this runtime's actual Chromium
  // version and an ASCII browser UA, then retain that exact UA for downloads.
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  browserSession.setUserAgent(userAgent);
  const helper = new BrowserWindow({
    width: 1120, height: 860, minWidth: 900, minHeight: 640, show: false,
    title: '映取 · 浏览器辅助分析', backgroundColor: '#f6f7f2', autoHideMenuBar: true,
    icon: path.join(options.resourcesDir, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'helper-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  helper.contentView.addChildView(view);
  const popupWindows = new Set<BrowserWindow>();
  const candidates = new Map<string, Candidate>();
  const requestInfo = new Map<number, { referer: string; userAgent: string; origin?: string }>();
  let loading = true;
  let message = '请在下方正常播放目标视频。登录、密码和网站验证请由你手动完成。';
  let settled = false;
  let selecting = false;
  let lastTitle = '';
  let resolveResult: (value: CapturedMedia) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<CapturedMedia>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach an observer immediately while main awaits window creation.
  result.catch(() => {});
  const toolbarFile = path.join(options.resourcesDir, 'browser-helper.html');
  const getState = () => ({
    pageUrl: privateUrlLabel(view.webContents.isDestroyed() ? pageUrl : view.webContents.getURL() || pageUrl),
    title: lastTitle, loading, message,
    candidates: [...candidates.values()].sort((a, b) => ({ dash: 0, hls: 1, mp4: 2 }[a.kind] - { dash: 0, hls: 1, mp4: 2 }[b.kind])).map(item => ({ id: item.id, kind: item.kind, label: `${({ dash: 'DASH 清单', hls: 'HLS 清单', mp4: 'MP4 视频' })[item.kind]} · ${privateUrlLabel(item.url)}` })),
  });
  const emit = () => { if (!helper.isDestroyed()) helper.webContents.send('helper:changed', getState()); };
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent) => !helper.isDestroyed() && event.sender === helper.webContents && event.senderFrame === helper.webContents.mainFrame;
  const align = () => { if (!helper.isDestroyed()) { const [width, height] = helper.getContentSize(); view.setBounds({ x: 0, y: 178, width, height: Math.max(1, height - 178) }); } };
  helper.on('resize', align);
  const protectRemote = (contents: WebContents) => {
    contents.on('will-navigate', (event, url) => { if (!safeHttp(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!safeHttp(url)) event.preventDefault(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => safeHttp(url) ? { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 760, autoHideMenuBar: true, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } } } : { action: 'deny' });
    contents.on('did-create-window', child => { popupWindows.add(child); child.on('closed', () => popupWindows.delete(child)); protectRemote(child.webContents); });
  };
  protectRemote(view.webContents);
  helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  helper.webContents.on('will-navigate', event => event.preventDefault());
  const detach = () => {
    browserSession.webRequest.onBeforeSendHeaders(null);
    browserSession.webRequest.onHeadersReceived(null);
    browserSession.webRequest.onCompleted(null);
    browserSession.webRequest.onErrorOccurred(null);
    browserSession.removeListener('will-download', preventDownload);
    ipcMain.removeHandler('helper:state'); ipcMain.removeHandler('helper:select');
    ipcMain.removeListener('helper:cancel', cancelHandler); ipcMain.removeListener('helper:reload', reloadHandler); ipcMain.removeListener('helper:back', backHandler);
    for (const popup of popupWindows) if (!popup.isDestroyed()) popup.destroy();
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    requestInfo.clear(); candidates.clear();
  };
  const cancel = () => { if (settled) return; settled = true; rejectResult(new Error('已取消浏览器辅助分析。')); if (!helper.isDestroyed()) helper.destroy(); };
  const cancelHandler = (event: IpcMainEvent) => { if (trusted(event)) cancel(); };
  const reloadHandler = (event: IpcMainEvent) => { if (trusted(event) && !view.webContents.isDestroyed()) view.webContents.reload(); };
  const backHandler = (event: IpcMainEvent) => { if (trusted(event) && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); };
  const preventDownload = (event: Electron.Event) => { event.preventDefault(); message = '此窗口用于检测视频。请回到上方选择资源，由映取下载；不会在网页中直接保存文件。'; emit(); };
  helper.on('closed', () => { if (!settled) { settled = true; rejectResult(new Error('已关闭浏览器辅助窗口。')); } detach(); });
  ipcMain.handle('helper:state', event => { if (!trusted(event)) throw new Error('请求来源无效。'); return getState(); });
  ipcMain.handle('helper:select', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || selecting || settled) throw new Error('资源选择无效或正在处理。');
    const item = [...candidates.values()].find(candidate => candidate.id === id);
    if (!item) throw new Error('资源已失效，请重新播放视频。');
    selecting = true;
    try {
      const hosts = [...new Set([item.url, item.referer, pageUrl].map(value => new URL(value).hostname))];
      const cookies = await browserSession.cookies.get({});
      const directory = path.join(options.portableRoot, 'data', 'captures');
      await mkdir(directory, { recursive: true });
      const cookiePath = path.join(directory, `${randomUUID()}.cookies.txt`);
      const domainCookies = cookies.filter((cookie): cookie is Cookie & {domain: string; path: string} => Boolean(cookie.domain && cookie.path));
      await writeFile(cookiePath, cookieJar(domainCookies.map(cookie => ({ ...cookie, secure: Boolean(cookie.secure) })), hosts), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await browserSession.cookies.flushStore();
      if (settled || helper.isDestroyed()) throw new Error('已取消浏览器辅助分析。');
      const captured: CapturedMedia = { url: item.url, title: lastTitle, context: { referer: item.referer, userAgent: item.userAgent, origin: item.origin, cookiePath, proxy: options.proxy } };
      settled = true; resolveResult(captured);
      // Let the invoke response reach the toolbar before destroying its host.
      setImmediate(() => { if (!helper.isDestroyed()) helper.destroy(); });
    } finally { selecting = false; }
  });
  ipcMain.on('helper:cancel', cancelHandler); ipcMain.on('helper:reload', reloadHandler); ipcMain.on('helper:back', backHandler);
  browserSession.on('will-download', preventDownload);
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (requestInfo.size > 1000) requestInfo.clear();
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
    requestInfo.set(details.id, { referer: safeHttp(headers.referer) || safeHttp(view.webContents.getURL()) || pageUrl, userAgent: headers['user-agent'] || userAgent, origin: safeOrigin(headers.origin) });
    callback({ requestHeaders: details.requestHeaders });
  });
  browserSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
    if (!settled && ['mainFrame', 'subFrame'].includes(details.resourceType) && [401, 403, 429].includes(details.statusCode)) {
      message = `网站拒绝了辅助窗口的页面请求（HTTP ${details.statusCode}）。如果 Chrome 能正常播放，请取消辅助分析，回主窗口导入 Chrome 视频请求。`;
      emit();
    }
    if (settled || details.statusCode < 200 || details.statusCode >= 300 || candidates.size >= 80) return;
    const type = Object.entries(details.responseHeaders || {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.[0] || '';
    const mediaUrl = normalizeCapturedMediaUrl(details.url);
    const kind = mediaKind(mediaUrl, type, details.resourceType);
    if (!kind || !safeHttp(mediaUrl) || candidates.has(mediaUrl)) return;
    const context = requestInfo.get(details.id) || { referer: safeHttp(view.webContents.getURL()) || pageUrl, userAgent };
    candidates.set(mediaUrl, { id: randomUUID(), url: mediaUrl, kind, ...context });
    message = `已检测到 ${candidates.size} 条媒体资源。请选择对应视频的清单或 MP4，然后点击分析。`;
    emit();
  });
  browserSession.webRequest.onCompleted(details => { requestInfo.delete(details.id); });
  browserSession.webRequest.onErrorOccurred(details => { requestInfo.delete(details.id); });
  view.webContents.on('page-title-updated', (_event, title) => { lastTitle = title.slice(0, 600); emit(); });
  view.webContents.on('did-start-loading', () => { loading = true; emit(); });
  view.webContents.on('did-stop-loading', () => { loading = false; emit(); });
  view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) { loading = false; message = '页面未能加载。请检查软件设置中的网络或代理，或在此窗口重新加载。'; emit(); }
  });
  view.webContents.on('did-navigate', () => emit());
  try {
    await helper.loadFile(toolbarFile); align(); helper.show();
    void view.webContents.loadURL(pageUrl).catch(() => {});
  } catch (error) { cancel(); throw error; }
  return { result, cancel, focus: () => { if (!helper.isDestroyed()) { helper.show(); helper.focus(); } } };
}
