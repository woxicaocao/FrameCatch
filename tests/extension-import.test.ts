import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importExtensionCapture, validateExtensionCapture } from '../electron/extension-import';

const request = (extra: Record<string, unknown> = {}) => ({ url: 'https://media.example.test/movie.mp4?token=SIGNED_TEST_ONLY', pageUrl: 'https://www.example.test/project/1', userAgent: 'Chrome-Extension-Test/1', ...extra });
async function temporary() {
  const base = path.resolve('.test-artifacts');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'extension-import-'));
}

describe('浏览器扩展请求导入', () => {
  it('保留媒体签名及真实来源，代理仅从桌面设置继承，不凭空添加Cookie', async () => {
    const portableRoot = await temporary();
    const result = await importExtensionCapture(request({ title: '  测试作品  ', referer: 'https://player.example.test/embed/1', origin: 'https://player.example.test' }), { portableRoot, proxy: 'http://127.0.0.1:7897' });
    expect(result).toEqual({ url: request().url, title: '测试作品', context: { referer: 'https://player.example.test/embed/1', userAgent: 'Chrome-Extension-Test/1', origin: 'https://player.example.test', proxy: 'http://127.0.0.1:7897' } });
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it('只将实际媒体请求Cookie导出为精确host-only jar，不扩大到网页或父域', async () => {
    const portableRoot = await temporary();
    const result = await importExtensionCapture(request({ cookieHeader: 'session=PRIVATE_SESSION; token=PRIVATE_TOKEN; session=PRIVATE_SESSION' }), { portableRoot, proxy: '' });
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    const rows = jar.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.slice(0, 5))).toEqual(Array(2).fill(['media.example.test', 'FALSE', '/', 'TRUE', '0']));
    expect(jar).not.toContain('www.example.test');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SESSION');
    expect(result.context.cookiePath).toMatch(/extension-[\w-]+\.cookies\.txt$/);
  });

  it.each([
    ['https://media.example.test/master.m3u8?x=1', undefined],
    ['https://media.example.test/master.mpd?x=1', undefined],
    ['https://media.example.test/stream?id=1', 'application/vnd.apple.mpegurl'],
    ['https://media.example.test/stream?id=1', 'application/dash+xml'],
    ['https://media.example.test/stream?id=1', 'video/mp4'],
    ['https://vod-adaptive.vimeocdn.com/path/master.json?x=SIGNED_TEST_ONLY', undefined],
  ])('接收完整清单或可识别的无后缀媒体：%s', (url, contentType) => {
    const result = validateExtensionCapture(request({ url, contentType }));
    expect(result.url).toBe(url.replace('/master.json?', '/master.mpd?'));
    expect(result.referer).toBe(request().pageUrl);
  });

  it('保留可信Vimeo新playlist.json原样，不错误改写为MPD', () => {
    const url = 'https://vod-adaptive-ak.vimeocdn.com/signed/v2/playlist/av/primary/playlist.json?pathsig=TEST_SIGNED&base64_init=1';
    expect(validateExtensionCapture(request({ url, contentType: 'application/json' })).url).toBe(url);
    expect(() => validateExtensionCapture(request({ url: 'https://vimeocdn.com.evil.test/v2/playlist/playlist.json', contentType: 'application/json' }))).toThrow();
  });

  it.each([
    'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/clip.mp4?range=6562581-13875329&pathsig=TEST_SECRET',
    'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/clip.mp4?pathsig=TEST_SECRET',
    'https://media.example.test/movie.mp4?range=0-1023',
  ])('旧插件发来的伪完整MP4会在下载前被拒绝：%s', async url => {
    const portableRoot = await temporary();
    await expect(importExtensionCapture(request({ url, contentType: 'video/mp4', cookieHeader: 'session=TEST_PRIVATE' }), { portableRoot, proxy: '' })).rejects.toThrow(/字节区间/);
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it.each(['clip.ts', 'clip.m4s', 'audio.m4a', 'audio.aac', 'init.mp4', 'init-001.mp4', 'chunk123.mp4', 'segment/123.mp4', 'subtitles.vtt', 'plain.html', 'master.json'])('拒绝分片、纯音频和非媒体：%s', async suffix => {
    const portableRoot = await temporary();
    await expect(importExtensionCapture(request({ url: `https://media.example.test/${suffix}` }), { portableRoot, proxy: '' })).rejects.toThrow();
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it.each([
    { authorization: 'Bearer PRIVATE_AUTH' }, { Authorization: 'Bearer PRIVATE_AUTH' }, { cookiePath: 'C:\\private.txt' }, { proxy: 'http://evil.example.test' },
    { headers: { Cookie: 'SECRET' } }, { cookies: [] }, { command: 'calc.exe' }, { method: 'POST' },
    { cookieHeader: 'session=SECRET\r\nX-Injected: yes' }, { cookieHeader: 'session=SECRET_ONE; session=SECRET_TWO' },
    { cookieHeader: 'not-a-pair' }, { cookieHeader: 'bad name=SECRET' }, { cookieHeader: 'session=' + 'x'.repeat(65536) },
    { userAgent: '' }, { userAgent: 'Browser\tInjected' }, { referer: 'file:///C:/private.txt' }, { origin: 'https://example.test/path' },
    { url: 'https://user:SECRET@media.example.test/movie.mp4' }, { url: 'file:///C:/private.mp4' }, { pageUrl: 'javascript:alert(1)' },
  ])('拒绝不受支持的字段或凭据格式且不泄漏值 %j', async extra => {
    const portableRoot = await temporary();
    const error = await importExtensionCapture(request(extra), { portableRoot, proxy: '' }).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/SECRET|PRIVATE_AUTH/);
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it('拒绝数组、原型对象和无效便携目录/代理，校验失败不落盘', async () => {
    const portableRoot = await temporary();
    for (const value of [undefined, null, [], 'request', Object.create(request()), { ...request(), title: 'x'.repeat(513) }]) expect(() => validateExtensionCapture(value)).toThrow();
    await expect(importExtensionCapture(request({ cookieHeader: 'session=x' }), { portableRoot: 'relative', proxy: '' })).rejects.toThrow();
    await expect(importExtensionCapture(request({ cookieHeader: 'session=x' }), { portableRoot, proxy: 'ftp://private.example.test' })).rejects.toThrow();
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });
});
