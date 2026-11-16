import { describe, expect, it } from 'vitest';
import { cookieJar, mediaKind, normalizeCapturedMediaUrl, privateUrlLabel, safeHttp } from '../electron/browser-helper-utils';

describe('浏览器辅助媒体边界', () => {
  it('兼容Vimeo播放器JSON清单入口，保留签名且不改任意站点JSON', () => {
    expect(normalizeCapturedMediaUrl('https://vod-adaptive.vimeocdn.com/exp=123/master.json?base64_init=1&token=keep')).toBe('https://vod-adaptive.vimeocdn.com/exp=123/master.mpd?base64_init=1&token=keep');
    expect(normalizeCapturedMediaUrl('https://vod-adaptive.akamaized.net/video/master.json?sig=keep')).toBe('https://vod-adaptive.akamaized.net/video/master.mpd?sig=keep');
    expect(normalizeCapturedMediaUrl('https://other.test/master.json?token=keep')).toBe('https://other.test/master.json?token=keep');
  });
  it('识别带签名的完整清单和视频，而非依赖文件后缀', () => {
    expect(mediaKind('https://cdn.example.test/media?signature=secret', 'application/dash+xml; charset=utf-8', 'xhr')).toBe('dash');
    expect(mediaKind('https://cdn.example.test/master.m3u8?signature=secret', 'application/octet-stream', 'xhr')).toBe('hls');
    expect(mediaKind('https://cdn.example.test/movie.mp4', 'video/mp4', 'media')).toBe('mp4');
  });
  it('不将单个分片、初始化片和纯音频列为完整视频', () => {
    for (const url of ['https://cdn.test/chunk-0001.mp4', 'https://cdn.test/init.mp4', 'https://cdn.test/init-001.mp4', 'https://cdn.test/media.m4s', 'https://cdn.test/media.ts']) {
      expect(mediaKind(url, 'video/mp4', 'media')).toBeUndefined();
    }
    expect(mediaKind('https://cdn.test/music.mp4', 'audio/mp4', 'media')).toBeUndefined();
    expect(mediaKind('blob:https://cdn.test/id', 'video/mp4', 'media')).toBeUndefined();
  });
  it('资源标签隐藏签名参数，拒绝含账号密码的来源地址', () => {
    expect(privateUrlLabel('https://cdn.test/movie.mp4?token=do-not-show#secret')).toBe('cdn.test/movie.mp4');
    expect(safeHttp('https://user:password@cdn.test/file')).toBeUndefined();
  });
  it('只导出相关域Cookie，并拒绝破坏Netscape字段的控制字符', () => {
    const base = { path: '/', secure: true, hostOnly: true, expirationDate: 1800000000 };
    const jar = cookieJar([
      { ...base, domain: 'video.example.test', name: 'session', value: 'local-only' },
      { ...base, domain: 'other.test', name: 'unrelated', value: 'never-export' },
      { ...base, domain: 'video.example.test', name: 'bad', value: 'a\tb' },
    ], ['video.example.test']);
    expect(jar).toContain('# Netscape HTTP Cookie File');
    expect(jar).toContain('session\tlocal-only');
    expect(jar).not.toContain('unrelated'); expect(jar).not.toContain('never-export'); expect(jar).not.toContain('\tbad\t');
  });
});
