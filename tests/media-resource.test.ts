import { describe, expect, it } from 'vitest';
import { assertCompleteMediaResource, isVimeoPlaylistUrl, mediaResourceIssue } from '../electron/media-resource';

describe('完整媒体与传输资源边界', () => {
  it.each([
    'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED_RANGE/avf/file.mp4?range=6562581-13875329&pathsig=TEST_SIGNATURE',
    'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED_RANGE/avf/file.mp4?pathsig=TEST_SIGNATURE',
    'https://1vod-adaptive.akamaized.net/signed/v2/%72ange/prot/value/file.mp4',
    'https://media.example.test/file.mp4?range=0-200',
    'https://media.example.test/file.mp4?RANGE=bytes%3D200-300',
  ])('识别局部字节资源，绝不尝试改写签名：%s', url => {
    expect(mediaResourceIssue(url)).toBe('byte-range');
    expect(() => assertCompleteMediaResource(url)).toThrow(/字节区间/);
    try { assertCompleteMediaResource(url); } catch (e) { expect((e as Error).message).not.toContain('TEST_SIGNATURE'); }
  });

  it.each([
    'https://player.vimeo.com/external/123.hd.mp4?s=TEST_SIGNATURE',
    'https://vod-progressive.akamaized.net/clip.mp4?token=TEST_SIGNATURE',
    'https://media.example.test/master.m3u8?query_string_ranges=1',
    'https://media.example.test/master.mpd?range=720p',
    'https://vimeocdn.com.evil.test/v2/range/prot/path/file.mp4',
  ])('不拒绝正常progressive、总清单或无证据的同名路径：%s', url => {
    expect(mediaResourceIssue(url)).toBeUndefined();
    expect(() => assertCompleteMediaResource(url)).not.toThrow();
  });

  it('初始化、分片及独立音频均不能单独代表完整视频', () => {
    for (const path of ['init.mp4', 'chunk/123.mp4', 'segment42.mp4', 'media.m4s', 'media.ts']) expect(mediaResourceIssue(`https://media.test/${path}`)).toBe('fragment');
    for (const path of ['audio/file.mp4', 'sound.m4a', 'sound.aac', 'sound.mp3']) expect(mediaResourceIssue(`https://media.test/${path}`)).toBe('audio');
  });

  it('只有可信CDN的playlist.json被视为Vimeo总清单，保留原始URL', () => {
    for (const url of ['https://vod-adaptive-ak.vimeocdn.com/v2/playlist/av/primary/playlist.json?pathsig=TEST_SIGNATURE', 'https://1vod-adaptive.akamaized.net/v2/playlist/playlist.json?x=1']) expect(isVimeoPlaylistUrl(url)).toBe(true);
    for (const url of ['https://vimeocdn.com.evil.test/playlist.json', 'https://evil.test/playlist.json', 'https://user:pass@vod-adaptive-ak.vimeocdn.com/playlist.json', 'file:///playlist.json']) expect(isVimeoPlaylistUrl(url)).toBe(false);
  });
});
