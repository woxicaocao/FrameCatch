import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ windows: [] as any[], cookies: [] as any[], body: '' }));
vi.mock('electron', () => {
  const makeEvents = () => { const listeners = new Map<string, Function[]>(); return {
    on(name: string, fn: Function) { listeners.set(name, [...listeners.get(name) || [], fn]); return this; },
    off(name: string, fn: Function) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== fn)); return this; },
    emit(name: string, ...args: unknown[]) { for (const fn of listeners.get(name) || []) fn(...args); },
  }; };
  const browserSession = { ...makeEvents(), setProxy: vi.fn(async () => {}), setUserAgent: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), cookies: { get: vi.fn(async () => fixture.cookies) } };
  class Window {
    options: any; destroyed = false; url = ''; shown = false; muted = false; enabled?: () => void;
    listeners = makeEvents(); contentsListeners = makeEvents();
    debugger = { ...makeEvents(), attached: false, calls: [] as string[],
      attach: () => { this.debugger.attached = true; }, isAttached: () => this.debugger.attached,
      detach: () => { this.debugger.attached = false; },
      sendCommand: async (command: string) => { this.debugger.calls.push(command); if (command === 'Network.enable') return new Promise<void>(resolve => { this.enabled = resolve; }); return { body: fixture.body, base64Encoded: false }; },
    };
    webContents = { ...this.contentsListeners, debugger: this.debugger, setAudioMuted: (value: boolean) => { this.muted = value; }, setWindowOpenHandler: vi.fn(), isDestroyed: () => this.destroyed };
    constructor(options: any) { this.options = options; fixture.windows.push(this); }
    on(...args: [string, Function]) { this.listeners.on(...args); }
    loadURL(url: string) { this.url = url; this.enabled?.(); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.listeners.emit('closed'); } }
    show() { this.shown = true; }
    focus() {}
  }
  return { BrowserWindow: Window, session: { fromPath: () => browserSession } };
});

import { openDouyinCapture } from '../electron/douyin-browser';
const id = '7704696872263034451';
async function create(url = `https://www.douyin.com/video/${id}`) {
  const portableRoot = await fs.mkdtemp(path.resolve('.test-artifacts/douyin-browser-unit-'));
  const capture = await openDouyinCapture({ url, portableRoot, proxy: '' });
  return { capture, window: fixture.windows.at(-1) };
}

describe('自有抖音浏览器生命周期', () => {
  it('首次导航不等待尚无renderer target的Network.enable，及时返回可取消对象', async () => {
    const { capture, window } = await create();
    expect(window.url).toBe(`https://www.douyin.com/video/${id}`);
    expect(window.debugger.calls).toEqual(['Network.enable']);
    expect(window.options.show).toBe(false);
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    expect(window.muted).toBe(true);
    capture.cancel(); await expect(capture.result).rejects.toThrow('已取消');
    expect(window.destroyed).toBe(true);
    expect(window.debugger.attached).toBe(false);
  });
  it('只读精确作品的公开detail响应，不读取其他作品、登录API或任意响应体', async () => {
    const { capture, window } = await create();
    fixture.body = JSON.stringify({ aweme_detail: { aweme_id: id, desc: '精确作品', video: { duration: 2000, bit_rate: [{ format: 'mp4', bit_rate: 100000, play_addr: { width: 720, height: 1280, url_list: ['https://v11-weba.douyinvod.com/complete.mp4?sig=SYNTHETIC'] } }] } } });
    for (const [requestId, url] of [['other', 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7704614785010175270'], ['login', `https://www.douyin.com/login?aweme_id=${id}`], ['evil', `https://www.douyin.com.evil.test/aweme/v1/web/aweme/detail/?aweme_id=${id}`]]) {
      window.debugger.emit('message', {}, 'Network.responseReceived', { requestId, response: { status: 200, url } });
      window.debugger.emit('message', {}, 'Network.loadingFinished', { requestId, encodedDataLength: 100 });
    }
    expect(window.debugger.calls).toEqual(['Network.enable']);
    window.debugger.emit('message', {}, 'Network.responseReceived', { requestId: 'right', response: { status: 200, url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}` } });
    window.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: 'right', encodedDataLength: 100 });
    const media = await capture.result;
    expect(media.videoId).toBe(id); expect(media.duration).toBe(2); expect(media.title).toBe('精确作品');
    expect(media.context.referer).toBe('https://www.douyin.com/');
    expect(media.context.cookiePath).toBeUndefined();
    expect(window.destroyed).toBe(true);
  });
  it('短链仅允许合法iesdouyin中间跳转并绑定同一视频ID，阻止跨站和换作品', async () => {
    const { capture, window } = await create('https://v.douyin.com/short/');
    const event = () => ({ preventDefault: vi.fn() });
    const allowed = event(); window.contentsListeners.emit('will-redirect', allowed, `https://www.iesdouyin.com/share/video/${id}/?share_sign=SYNTHETIC`);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    const canonical = event(); window.contentsListeners.emit('will-redirect', canonical, `https://www.douyin.com/video/${id}`);
    expect(canonical.preventDefault).not.toHaveBeenCalled();
    for (const url of ['https://other.test/video/123', 'https://www.douyin.com/video/7704614785010175270', 'https://www.iesdouyin.com/share/video/7704614785010175270/']) {
      const denied = event(); window.contentsListeners.emit('will-redirect', denied, url); expect(denied.preventDefault).toHaveBeenCalled();
    }
    capture.cancel(); await expect(capture.result).rejects.toThrow('已取消');
  });
});
