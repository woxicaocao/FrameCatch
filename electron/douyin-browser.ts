import { BrowserWindow, session } from 'electron';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPathInside, validateProxy, validateUrl } from './engine-helpers';
import { cookieJar } from './browser-helper-utils';
import { douyinVideoId, parseDouyinDetail } from './douyin-data';
import type { CapturedMedia, BrowserCapture } from './browser-helper';

export interface DouyinCapturedMedia extends CapturedMedia { id: string; videoId: string; duration?: number; width?: number; height?: number; uploader?: string; thumbnail?: string; }
interface Options { url: string; portableRoot: string; proxy: string; parent?: BrowserWindow; resourcesDir?: string; }

/** A separate app-owned browser, never the installed Chrome. Its own DevTools
 * protocol reads only the exact work's normal public detail response; no page
 * scripts, login APIs, debugger ports, account stores or challenge solver. */
export async function openDouyinCapture(options: Options): Promise<BrowserCapture & { result: Promise<DouyinCapturedMedia> }> {
  const initial = new URL(validateUrl(options.url));
  let expectedId: string | undefined;
  let pageUrl: string;
  if (initial.protocol === 'https:' && initial.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]{3,80}\/?$/.test(initial.pathname)) pageUrl = initial.href;
  else { expectedId = douyinVideoId(initial.href); pageUrl = `https://www.douyin.com/video/${expectedId}`; }
  if (!path.isAbsolute(options.portableRoot) || /[\u0000-\u001f\u007f]/.test(options.portableRoot)) throw new Error('抖音辅助会话目录无效。');
  const proxy = validateProxy(options.proxy);
  if (proxy && (new URL(proxy).username || new URL(proxy).password)) throw new Error('抖音网页辅助暂不支持带账号密码的代理，请使用本机代理端口。');
  const profile = path.join(options.portableRoot, 'data', 'douyin-browser');
  await mkdir(profile, { recursive: true });
  const canonicalRoot = await realpath(options.portableRoot);
  if (!isPathInside(path.join(canonicalRoot, 'data', 'douyin-browser'), await realpath(profile))) throw new Error('抖音辅助会话目录指向外部位置，已停止分析。');
  const browserSession = session.fromPath(profile);
  await browserSession.setProxy(proxy ? { proxyRules: proxy.replace(/^socks5h:/i, 'socks5:'), proxyBypassRules: '<-loopback>' } : { mode: 'system' });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  browserSession.setUserAgent(userAgent);
  const helper = new BrowserWindow({ width: 1000, height: 760, show: false, autoHideMenuBar: true, title: '映取 · 抖音网页分析',
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.resourcesDir ? { icon: path.join(options.resourcesDir, 'icon.png') } : {}),
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: false } });
  const contents = helper.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  const denyNavigation = (event: Electron.Event, url: string) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' && !target.username && !target.password && target.hostname === 'www.iesdouyin.com') {
        const sharedId = /^\/share\/video\/(\d{10,24})\/?$/.exec(target.pathname)?.[1];
        if (!sharedId || (expectedId && expectedId !== sharedId)) { event.preventDefault(); return; }
        expectedId = sharedId; return;
      }
      if (target.protocol === 'https:' && !target.username && !target.password && ['www.douyin.com', 'douyin.com'].includes(target.hostname)) {
        try { const resolvedId = douyinVideoId(target.href); if (expectedId && expectedId !== resolvedId) { event.preventDefault(); return; } expectedId = resolvedId; } catch {}
        return;
      }
    } catch {}
    event.preventDefault();
  };
  contents.on('will-navigate', denyNavigation);
  contents.on('will-redirect', denyNavigation);
  contents.on('login', event => event.preventDefault());
  let settled = false, resolving = false;
  let resolveResult!: (value: DouyinCapturedMedia) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<DouyinCapturedMedia>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const pending = new Set<string>();
  const timer = setTimeout(() => fail('抖音网页未返回该作品的完整视频信息。请使用可见浏览器辅助分析，或在 Chrome 正常播放后通过插件发送；需要的网站验证请手动完成。'), 35_000);
  const preventDownload = (event: Electron.Event) => event.preventDefault();
  browserSession.on('will-download', preventDownload);
  function detach() {
    clearTimeout(timer); pending.clear(); browserSession.off('will-download', preventDownload);
    if (!contents.isDestroyed()) {
      contents.debugger.off('message', receive);
      try { if (contents.debugger.isAttached()) contents.debugger.detach(); } catch {}
    }
  }
  function destroy() { if (!helper.isDestroyed()) helper.destroy(); }
  function fail(message: string) {
    if (settled) return; settled = true; detach(); rejectResult(new Error(message)); destroy();
  }
  async function receive(_event: unknown, method: string, parameters: Record<string, any>) {
    if (settled || resolving) return;
    if (method === 'Network.responseReceived') {
      const response = parameters.response;
      if (!response || response.status !== 200 || typeof response.url !== 'string' || typeof parameters.requestId !== 'string') return;
      try {
        const url = new URL(response.url);
        if (expectedId && url.protocol === 'https:' && url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/detail/' && url.searchParams.getAll('aweme_id').length === 1 && url.searchParams.get('aweme_id') === expectedId && pending.size < 4) pending.add(parameters.requestId);
      } catch {}
      return;
    }
    if (method === 'Network.loadingFailed') { pending.delete(parameters.requestId); return; }
    if (method !== 'Network.loadingFinished' || !pending.delete(parameters.requestId) || parameters.encodedDataLength > 5 * 1024 * 1024) return;
    try {
      const response = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: parameters.requestId });
      if (settled || resolving || typeof response.body !== 'string' || response.body.length > 7 * 1024 * 1024) return;
      const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      if (Buffer.byteLength(body) > 5 * 1024 * 1024) return;
      if (!expectedId) return;
      const media = parseDouyinDetail(JSON.parse(body), expectedId);
      if (!media) return;
      resolving = true;
      const host = new URL(media.url).hostname;
      const cookies = await browserSession.cookies.get({ url: media.url });
      if (settled || contents.isDestroyed()) return;
      let cookiePath: string | undefined;
      if (cookies.length) {
        const directory = path.join(options.portableRoot, 'data', 'captures');
        await mkdir(directory, { recursive: true });
        if (!isPathInside(path.join(canonicalRoot, 'data', 'captures'), await realpath(directory))) throw new Error('抖音媒体凭据目录指向外部位置。');
        cookiePath = path.join(directory, `douyin-${randomUUID()}.cookies.txt`);
        await writeFile(cookiePath, cookieJar(cookies.map(cookie => ({ domain: host, hostOnly: true, path: cookie.path || '/', secure: Boolean(cookie.secure), expirationDate: cookie.expirationDate, name: cookie.name, value: cookie.value })), [host]), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
      }
      if (settled || contents.isDestroyed()) return;
      settled = true; detach();
      resolveResult({ ...media, videoId: media.id, context: { referer: 'https://www.douyin.com/', userAgent, proxy, ...(cookiePath ? { cookiePath } : {}) } });
      destroy();
    } catch { resolving = false; }
  }
  helper.on('closed', () => { if (!settled) fail('已关闭抖音网页分析。'); });
  try {
    contents.debugger.attach('1.3');
    contents.debugger.on('message', receive);
    // A new Electron window has no renderer target until its first navigation.
    // Queue enable before loadURL, but do not await it and deadlock navigation.
    void contents.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 12 * 1024 * 1024, maxResourceBufferSize: 6 * 1024 * 1024 })
      .catch(() => fail('抖音网页辅助组件未能启动，请使用 Chrome 插件或可见浏览器辅助分析。'));
    void helper.loadURL(pageUrl).catch(() => fail('抖音网页未能打开，请检查网络或改用浏览器辅助分析。'));
  } catch { fail('抖音网页辅助组件未能启动，请使用 Chrome 插件或可见浏览器辅助分析。'); }
  return { result, cancel: () => fail('已取消抖音网页分析。'), focus: () => { if (!helper.isDestroyed()) { helper.show(); helper.focus(); } } };
}
