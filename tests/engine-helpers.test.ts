import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { commonArgs, displayWarnings, downloadArgs, expectsAudio, friendlyError, isPathInside, normalizeAnalysis, parseProgress, PROGRESS_PREFIX, redactLog, relocatePortablePath, safeFilename, validateMediaContext, validateProxy, validateUrl, verifyProbe, vimeoPlayerFallback } from '../electron/engine-helpers';
import type { VideoEntry } from '../shared/types';

const video: VideoEntry = { id: 'movie', url: 'https://example.com/movie?a=1&b=2', title: '电影', platform: 'Generic', formats: [{ id: 'best', label: '最高画质', ext: 'mp4', audioCodec: 'aac' }, { id: '137', label: '1080p', ext: 'mp4', videoCodec: 'avc1', audioCodec: 'aac' }] };

describe('输入与子进程参数边界', () => {
  it('只接受完整 HTTP(S) URL，并保留 & 等字符为单一参数', () => {
    expect(validateUrl(' https://example.com/watch?v=abc&list=xyz ')).toBe('https://example.com/watch?v=abc&list=xyz');
    for (const value of ['file:///C:/a.mp4', 'javascript:alert(1)', 'https://user:password@example.com/video', 'https://example.com/\n--exec cmd', '--exec cmd', '']) expect(() => validateUrl(value)).toThrow();
    const args = downloadArgs('C:\\便携软件\\bin', { outputDir: 'C:\\下载', cookiePath: '', proxy: '' }, { video, formatId: 'best', workDir: 'C:\\便携软件\\work' });
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe(video.url);
    expect(args).toContain('--keep-video');
    expect(args).toContain('--keep-fragments');
    expect(args).toContain('--abort-on-unavailable-fragments');
    expect(args).toContain('--no-overwrites');
    expect(args).not.toContain('--exec');
  });

  it('校验代理配置；凭据作为参数传递而非命令拼接', () => {
    expect(validateProxy('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
    expect(validateProxy('')).toBe('');
    for (const invalid of ['ftp://example.com', 'http://example.com/command', 'http://example.com/?key=value', 'proxy:7890', 'http://x\n--exec']) expect(() => validateProxy(invalid)).toThrow();
    const args = commonArgs('C:\\bin', { outputDir: 'C:\\下载', cookiePath: 'C:\\有空格 cookie.txt', proxy: 'http://user:pass@localhost:7890' });
    expect(args[args.indexOf('--cookies') + 1]).toBe('C:\\有空格 cookie.txt');
    expect(args[args.indexOf('--proxy') + 1]).toBe('http://user:pass@localhost:7890');
  });

  it('拒绝注入格式表达式，保留用户所选真实format id', () => {
    expect(() => downloadArgs('C:\\bin', { outputDir: 'C:\\下载', cookiePath: '', proxy: '' }, { video, formatId: '137/../../x', workDir: 'C:\\work' })).toThrow();
    const args = downloadArgs('C:\\bin', { outputDir: 'C:\\下载', cookiePath: '', proxy: '' }, { video, formatId: '137', workDir: 'C:\\work' });
    expect(args[args.indexOf('--format') + 1]).toBe('137+bestaudio/137');
  });

  it('仅Vimeo下载检查可用格式，不开启保护格式或改变其他站点行为', () => {
    const settings = { outputDir: 'C:\\下载', cookiePath: '', proxy: '' };
    const normal = downloadArgs('C:\\bin', settings, { video, formatId: 'best', workDir: 'C:\\work' });
    const vimeo = downloadArgs('C:\\bin', settings, { video: { ...video, url: 'https://player.vimeo.com/video/76979871' }, formatId: 'best', workDir: 'C:\\work' });
    expect(normal).not.toContain('--check-formats');
    expect(vimeo).toContain('--check-formats');
    expect(vimeo).not.toContain('--allow-unplayable-formats');
    expect(friendlyError(new Error('未找到可用的非 DRM 格式'))).toBe('已检查可选画质，未找到可用的非 DRM 格式，无法完成下载。');
  });

  it('捕获环境继承来源/UA/Origin与当时代理，Cookie仅以域隔离jar传递', () => {
    const settings = { outputDir: 'C:\\下载', cookiePath: 'C:\\全局cookies.txt', proxy: 'http://127.0.0.1:9999' };
    const context = { referer: 'https://example.com/watch/1', userAgent: 'Example Browser/1.0', origin: 'https://example.com', cookiePath: 'C:\\便携版\\data\\captures\\capture.cookies.txt', proxy: 'socks5://127.0.0.1:1080', Cookie: 'private-cookie-value', Authorization: 'private-auth-value', headers: { Cookie: 'private-header-value' } };
    const args = downloadArgs('C:\\bin', settings, { video: { ...video, mediaContext: context }, formatId: 'best', workDir: 'C:\\work' });
    expect(args[args.indexOf('--referer') + 1]).toBe(context.referer);
    expect(args[args.indexOf('--user-agent') + 1]).toBe(context.userAgent);
    expect(args[args.indexOf('--add-headers') + 1]).toBe('Origin:https://example.com');
    expect(args[args.indexOf('--cookies') + 1]).toBe(context.cookiePath);
    expect(args[args.indexOf('--proxy') + 1]).toBe(context.proxy);
    expect(args.join(' ')).not.toContain('private-');
    expect(args.join(' ')).not.toContain('全局cookies');
    expect(args.join(' ')).not.toContain('9999');
    const noCookies = commonArgs('C:\\bin', settings, { referer: context.referer, userAgent: context.userAgent, proxy: '' });
    expect(noCookies).not.toContain('--cookies');
    expect(noCookies).not.toContain('--proxy');
    expect(noCookies).not.toContain('--add-headers');
  });

  it('捕获环境拒绝请求头控制字符、非站点Origin及相对凭据路径', () => {
    const valid = { referer: 'https://example.com/watch', userAgent: 'Example Browser/1.0', proxy: '' };
    expect(validateMediaContext(valid)).toEqual(valid);
    for (const input of [
      { ...valid, referer: 'https://example.com/\r\nCookie: secret' },
      { ...valid, userAgent: 'Browser\tCookie:secret' },
      { ...valid, origin: 'https://example.com/path' },
      { ...valid, origin: 'https://example.com/?token=value' },
      { ...valid, origin: 'null' },
      { ...valid, proxy: 'http://127.0.0.1:7890\n--exec cmd' },
      { ...valid, cookiePath: '../outside.cookies.txt' },
    ]) expect(() => validateMediaContext(input)).toThrow();
  });

  it('只为可信新片场CDN的完整MP4补全资源Range，不转发浏览器有限Range', () => {
    const settings = { outputDir: 'C:\\下载', cookiePath: '', proxy: '' };
    for (const url of ['https://xpccdn.com/movie.mp4?token=preserved', 'https://us-xpc5-l2.xpccdn.com/path/MOVIE.MP4']) {
      const args = commonArgs('C:\\bin', settings, undefined, url);
      expect(args).toContain('Range:bytes=0-');
      const context = { referer: 'https://www.xinpianchang.com/', userAgent: 'Chrome/156', proxy: '', headers: { Range: 'bytes=0-100', Authorization: 'secret' }, range: 'bytes=0-100' };
      const download = downloadArgs('C:\\bin', settings, { video: { ...video, url, mediaContext: context }, formatId: 'best', workDir: 'C:\\work' });
      expect(download.filter(value => value.startsWith('Range:'))).toEqual(['Range:bytes=0-']);
      expect(download.join(' ')).not.toContain('bytes=0-100');
      expect(download.join(' ')).not.toContain('secret');
    }
    for (const url of ['https://xpccdn.com.evil.test/movie.mp4', 'https://evilxpccdn.com/movie.mp4', 'https://xpccdn.com@evil.test/movie.mp4', 'https://media.example.com/movie.mp4', 'https://xpccdn.com/master.m3u8', 'https://xpccdn.com/master.mpd', 'https://www.xinpianchang.com/a13856092']) expect(commonArgs('C:\\bin', settings, undefined, url)).not.toContain('Range:bytes=0-');
  });
});

describe('提取器结果归一化', () => {
  it('Vimeo公开数字入口仅在web client登录错误时回退，并保留查询与unlisted hash', () => {
    const error = 'ERROR: [vimeo] 76979871: The web client only works when logged-in. Use --cookies to authenticate.';
    expect(vimeoPlayerFallback('https://vimeo.com/76979871', error)).toBe('https://player.vimeo.com/video/76979871');
    expect(vimeoPlayerFallback('https://www.vimeo.com/12345/abcdef0123?autoplay=1&quality=1080p#t=20s', error)).toBe('https://player.vimeo.com/video/12345?autoplay=1&quality=1080p&h=abcdef0123#t=20s');
    expect(vimeoPlayerFallback('https://vimeo.com/12345?h=012345abcd&autoplay=0', error)).toBe('https://player.vimeo.com/video/12345?h=012345abcd&autoplay=0');
    for (const url of ['https://player.vimeo.com/video/12345', 'https://vimeo.com/channels/staffpicks/12345', 'https://vimeo.com/showcase/12345', 'https://vimeo.com/12345/private', 'https://vimeo.com.evil.test/12345', 'https://youtube.com/12345']) expect(vimeoPlayerFallback(url, error)).toBeUndefined();
    expect(vimeoPlayerFallback('https://vimeo.com/12345', 'This video is private. Please log in.')).toBeUndefined();
    expect(vimeoPlayerFallback('https://vimeo.com/12345', 'HTTP Error 403: Forbidden')).toBeUndefined();
  });

  it('保留B站多P各自网址，不误拼接或反复下载第一P', () => {
    const url = 'https://www.bilibili.com/video/BV1234567890/';
    const raw = { title: '合集', extractor: 'Bilibili', entries: [1, 2].map(p => ({ id: `BV1234567890_p${p}`, title: `第${p}P`, webpage_url: `${url}?p=${p}`, formats: [{ format_id: '80', vcodec: 'avc1', acodec: 'none', height: 1080, ext: 'mp4' }, { format_id: '30280', vcodec: 'none', acodec: 'aac', ext: 'm4a' }] })) };
    const result = normalizeAnalysis(raw, url);
    expect(result.isPlaylist).toBe(true);
    expect(result.entries.map(entry => entry.url)).toEqual([`${url}?p=1`, `${url}?p=2`]);
    expect(result.entries[0].formats[0].audioCodec).toBe('aac');
    expect(result.entries[0].formats.some(f => f.id === '30280')).toBe(false);
  });

  it('同作品页面内多个视频以playlistIndex稳定选择原顺序', () => {
    const url = 'https://www.behance.net/gallery/123/video';
    const result = normalizeAnalysis({ title: '作品', entries: [null, { id: 'two', title: '第二条', webpage_url: url, formats: [{ format_id: '1', height: 720, ext: 'mp4', vcodec: 'h264', acodec: 'aac' }] }] }, url);
    expect(result.entries[0].playlistIndex).toBe(2);
    const args = downloadArgs('C:\\bin', { outputDir: 'C:\\下载', cookiePath: '', proxy: '' }, { video: result.entries[0], formatId: 'best', workDir: 'C:\\work' });
    expect(args[args.indexOf('--playlist-items') + 1]).toBe('2');
    expect(args).not.toContain('--no-playlist');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('过滤直播和DRM，最高画质加每个分辨率一个最佳选项', () => {
    const result = normalizeAnalysis({ entries: [{ is_live: true, title: '直播' }, { has_drm: true, title: '受保护影片' }, { id: 'movie', title: '正常影片', formats: [
      { format_id: '720-low', height: 720, vcodec: 'h264', acodec: 'none', ext: 'mp4' },
      { format_id: '720-best', height: 720, vcodec: 'h264', acodec: 'none', ext: 'mp4' },
      { format_id: '1080', height: 1080, vcodec: 'h264', acodec: 'aac', ext: 'mp4' },
    ] }] }, 'https://example.com/gallery');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].formats.map(f => f.id)).toEqual(['best', '1080', '720-best']);
    expect(result.warnings).toHaveLength(2);
    expect(() => normalizeAnalysis({ is_live: true }, 'https://example.com/live')).toThrow('点播');
  });
});

describe('完整性验证和进度', () => {
  it('音视频分离必须检查最终音轨，原生无声视频允许无音轨', () => {
    const silent = { streams: [{ codec_type: 'video' }], format: { duration: '120' } };
    expect(() => verifyProbe(silent, false, 120)).not.toThrow();
    expect(() => verifyProbe(silent, true, 120)).toThrow('音频');
    expect(() => verifyProbe({ streams: [{ codec_type: 'audio' }], format: { duration: '120' } }, true)).toThrow('视频');
    expect(expectsAudio({ acodec: 'none', audio_codecs: ['none', 'aac'] })).toBe(true);
    expect(expectsAudio({ acodec: 'none', requested_formats: [{ acodec: 'none' }] })).toBe(false);
  });

  it('截断文件和未知时长不能直接标为成功', () => {
    expect(() => verifyProbe({ streams: [{ codec_type: 'video' }], format: { duration: '15' } }, false, 120)).toThrow('时长');
    expect(() => verifyProbe({ streams: [{ codec_type: 'video' }], format: {} }, false)).toThrow('时长');
  });

  it('机器进度支持未知总大小和分片信息，不依赖英文控制台文案', () => {
    expect(parseProgress(`${PROGRESS_PREFIX}{"downloaded_bytes":50,"total_bytes":200,"eta":0,"speed":1000,"fragment_index":2,"fragment_count":5}`)).toMatchObject({ percent: 25, eta: 0, speed: 1000, detail: '分片 2 / 5' });
    expect(parseProgress(`${PROGRESS_PREFIX}{"downloaded_bytes":50,"status":"downloading"}`)?.percent).toBeUndefined();
    expect(parseProgress('普通下载进度')).toBeUndefined();
    expect(parseProgress(`${PROGRESS_PREFIX}broken json`)).toBeUndefined();
  });
});

describe('便携路径与日志', () => {
  it('界面过滤无关技术警告，保留影响画质与权限的中文摘要并去重', () => {
    expect(displayWarnings('WARNING: [generic] Falling back on generic information extractor\nWARNING: Unable to extract OpenGraph title\nWARNING: No subtitles were found\nWARNING: Unable to download thumbnail')).toEqual([]);
    const warnings = displayWarnings('WARNING: [youtube] Some formats have been skipped as they are missing a url\nWARNING: [youtube] Some formats are missing\nWARNING: HTTP Error 403: Forbidden\nWARNING: Your cookies are no longer valid\nWARNING: Some formats are DRM protected');
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toContain('画质');
    expect(warnings.join('\n')).toContain('网站访问');
    expect(warnings.join('\n')).toContain('登录凭据');
    expect(warnings.join('\n')).toContain('DRM');
    expect(warnings.join('\n')).not.toContain('Some formats');
  });

  it('缺片、FFmpeg失败、未知英文错误显示中文，已有中文原因保留', () => {
    expect(friendlyError(new Error('ERROR: fragment 2 not found, unable to continue'))).toContain('视频分片缺失');
    expect(friendlyError(new Error('ERROR: Postprocessing: ffmpeg exited with code 1'))).toContain('合并、封装');
    expect(friendlyError(new Error('ERROR: Unexpected parser response XYZ'))).toBe('操作未能完成，详细原因已记录到日志。请查看日志后重试。');
    expect(friendlyError(new Error('成品时长明显短于源视频，未标记为完成。'))).toBe('成品时长明显短于源视频，未标记为完成。');
    expect(friendlyError(new Error('HTTP Error 401: Unauthorized'))).toContain('服务器未授权当前播放请求');
    expect(friendlyError(new Error('HTTP Error 401: Unauthorized'))).not.toContain('该视频需要登录');
    expect(friendlyError(new Error('The web client only works when logged-in'))).toContain('网页解析入口要求登录');
    expect(friendlyError(new Error('ERROR: Fresh cookies (not necessarily logged in) are needed'))).toContain('并不一定要求登录账号');
  });

  it('缺失MP4初始化轨道时提示重新捕获总清单，不误归类为登录或通用合并错误', () => {
    for (const reason of ['trun track id unknown, no tfhd was found', 'moov atom not found', 'could not find corresponding trex']) {
      const text = friendlyError(new Error(`成品校验失败：${reason}\nInvalid data found when processing input`));
      expect(text).toContain('MP4 初始化');
      expect(text).toContain('HLS/DASH 总清单');
      expect(text).not.toContain('该视频需要登录');
      expect(text).not.toContain('音视频合并、封装或文件校验失败');
    }
  });

  it('便携目录迁移只重定位软件内部文件，外部保存目录不变', () => {
    const oldRoot = path.resolve('旧便携版'), nextRoot = path.resolve('新便携版');
    expect(relocatePortablePath(path.join(oldRoot, 'Downloads', 'test.mp4'), oldRoot, nextRoot)).toBe(path.join(nextRoot, 'Downloads', 'test.mp4'));
    const external = path.resolve('external-downloads', 'test.mp4');
    expect(relocatePortablePath(external, oldRoot, nextRoot)).toBe(external);
    expect(isPathInside(oldRoot, `${oldRoot}-sibling`)).toBe(false);
    expect(isPathInside(oldRoot, path.join(oldRoot, '..', 'outside'))).toBe(false);
    expect(safeFilename('A/B:C*D? "电影". ')).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('日志隐藏URL查询token、Cookie和代理账号密码，错误按中文分类', () => {
    const redacted = redactLog('https://alice:secret@example.com/video.mp4?token=private\nCookie: session=abc\nhttp://proxy:password@127.0.0.1:7890');
    expect(redacted).not.toContain('private');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('session=abc');
    expect(redacted).not.toContain('password');
    expect(friendlyError(new Error('ERROR: No space left on device'))).toContain('磁盘空间不足');
    expect(friendlyError(new Error('ERROR: Sign in to confirm you are not a bot'))).toContain('Cookie');
    expect(friendlyError(new Error('ERROR: HTTP Error 403: Forbidden'))).toContain('网站拒绝');
  });

  it('裸媒体generic错误ID的完整签名及编码JSON全部隐藏，但保留HTTP原因', () => {
    const query = 'Expires=2000000000&Signature=SECRET_SIGNATURE&token=SECRET_TOKEN&SESSION_KEY=SECRET_SESSION&j=%7B%22ip%22%3A%22SECRET_IP%22%2C%22deviceId%22%3A%22SECRET_DEVICE%22%7D';
    for (const raw of [
      `ERROR: [generic] movie.mp4?${query}: Unable to download webpage: HTTP Error 403: Forbidden`,
      `ERROR: [generic] stream?${query}: Unable to download webpage: HTTP Error 401: Unauthorized`,
      `ERROR: movie.mp4?${query}: HTTP Error 403: Forbidden`,
      `ERROR: [generic] movie.mp4?j={"ip":"SECRET_IP","deviceId":"SECRET_DEVICE"}: Unable to download webpage: HTTP Error 403: Forbidden`,
    ]) {
      const safe = redactLog(raw);
      expect(safe).not.toContain('SECRET_');
      expect(safe).not.toContain('%7B');
      expect(safe).toContain('HTTP Error');
      expect(safe).toContain('[参数已隐藏]');
    }
  });
  it('Vimeo放在路径中的签名和编码保护参数同样不进入新日志', () => {
    const raw = 'ERROR: https://vod-adaptive-ak.vimeocdn.com/exp=PRIVATE_EXP~hmac=PRIVATE_HMAC/v2/range/prot/PRIVATE_ENCODED/avf/movie.mp4?pathsig=PRIVATE_SIG: HTTP Error 403';
    const safe = redactLog(raw);
    expect(safe).not.toContain('PRIVATE_');
    expect(safe).toContain('vod-adaptive-ak.vimeocdn.com');
    expect(safe).toContain('HTTP Error 403');
  });
  it('抖音无文件名媒体产生的裸查询generic编号不泄露签名', () => {
    const safe = redactLog('ERROR: [generic] _a=6383&signature=PRIVATE_SIGNED&device=PRIVATE_DEVICE: Unable to download webpage: HTTP Error 403');
    expect(safe).not.toContain('PRIVATE_');
    expect(safe).toContain('HTTP Error 403');
    expect(safe).toContain('[参数已隐藏]');
    const path = redactLog('ERROR: https://v3.douyinvod.com/PRIVATE_PATH_HASH/PRIVATE_EXP/video/tos/cn/video/?token=PRIVATE_QUERY HTTP Error 403');
    expect(path).not.toContain('PRIVATE_');
    expect(path).toContain('HTTP Error 403');
  });
});
