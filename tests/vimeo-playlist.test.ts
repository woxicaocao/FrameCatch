import { describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { isVimeoPlaylistUrl, parseVimeoPlaylist } from '../electron/vimeo-playlist';

function box(type: string, content: Buffer = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(8 + content.length); result.writeUInt32BE(result.length); result.write(type, 4); content.copy(result, 8); return result;
}
const init = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov')]).toString('base64');
const source = 'https://vod-adaptive-ak.vimeocdn.com/signed/prefix/v2/playlist/avf/playlist.json?base64_init=1&query_string_ranges=1&signature=SYNTHETIC_SECRET';
function fixture(): any {
  const track = (id: string) => ({ id, base_url: `${id}/`, bitrate: 800000, init_segment: init, codecs: id === 'video' ? 'avc1.42c00b' : 'mp4a.40.2',
    ...(id === 'video' ? { width: 1280, height: 720, fps: 24 } : {}),
    segments: [{ start: 0, end: 2, url: 'one.mp4?range=100-199&pathsig=ONE%2B%2F&sid=1', size: 99 }, { start: 2, end: 4, url: 'one.mp4?range=200-299&pathsig=TWO%2B%2F&sid=2', size: 100 }] });
  return { clip_id: 'fixture-clip', base_url: '../../../remux/avf/', title: '测试 Vimeo 视频', video: [track('video')], audio: [track('audio')] };
}

describe('Vimeo playlist.json 纯转换与输入边界', () => {
  it('只接受可信 CDN 的 playlist.json；不会伪造或改写请求地址', () => {
    expect(isVimeoPlaylistUrl(source)).toBe(true);
    expect(isVimeoPlaylistUrl('https://8vod-adaptive.akamaized.net/a/playlist.json?a=1')).toBe(true);
    for (const url of ['https://vimeocdn.com.evil.test/playlist.json', 'https://evilvimeocdn.com/playlist.json', 'file:///a/playlist.json', 'https://user:pw@vod-adaptive-ak.vimeocdn.com/a/playlist.json', 'https://vod-adaptive-ak.vimeocdn.com/a/video.mp4']) {
      expect(() => parseVimeoPlaylist(fixture(), url)).toThrow();
    }
  });
  it('三层base_url解析保留每条签名；内嵌init与全部片段进入原生DASH下载器', () => {
    const info = parseVimeoPlaylist(fixture(), source);
    expect(info.id).toBe('fixture-clip'); expect(info.title).toBe('测试 Vimeo 视频'); expect(info.duration).toBe(4);
    expect(info.webpage_url).toBe(source); expect(info.formats).toHaveLength(2);
    const video = info.formats[0], audio = info.formats[1];
    expect(video.protocol).toBe('http_dash_segments'); expect(video.vcodec).toBe('avc1.42c00b'); expect(video.acodec).toBe('none');
    expect(audio.vcodec).toBe('none'); expect(audio.acodec).toBe('mp4a.40.2');
    expect(video.fragments[0].url).toBe(`data:application/octet-stream;base64,${init}`);
    expect(video.fragments[1].url).toBe('https://vod-adaptive-ak.vimeocdn.com/signed/prefix/remux/avf/video/one.mp4?range=100-199&pathsig=ONE%2B%2F&sid=1');
    expect(video.fragments[2].url).toContain('range=200-299&pathsig=TWO%2B%2F&sid=2');
    expect(video.filesize).toBe(Buffer.from(init, 'base64').length + 200);
    expect(video.height).toBe(720); expect(video.tbr).toBe(800);
  });
  it('忽略清单注入的命令、下载器选项、路径、头部和处理器，不传给yt-dlp', () => {
    const data = fixture();
    Object.assign(data, { _type: 'url', url: 'file:///secrets', http_headers: { Cookie: 'PRIVATE' }, postprocessors: [{ key: 'Exec', exec_cmd: 'PRIVATE' }], filepath: 'C:/PRIVATE' });
    Object.assign(data.video[0], { http_headers: { Authorization: 'PRIVATE' }, fragments: [{ url: 'file:///PRIVATE' }], protocol: 'exec', filepath: 'PRIVATE' });
    Object.assign(data.video[0].segments[0], { headers: { Cookie: 'PRIVATE' }, path: 'file:///PRIVATE' });
    const info = parseVimeoPlaylist(data, source);
    expect(JSON.stringify(info)).not.toContain('PRIVATE'); expect(JSON.stringify(info)).not.toContain('file:');
    expect((info as any)._type).toBeUndefined(); expect((info.formats[0] as any).http_headers).toBeUndefined();
  });
  it.each(['file:///C:/secret', 'javascript:alert(1)', 'data:application/octet-stream;base64,AAAA', 'https://other.test/a.m4s', 'http://vod-adaptive-ak.vimeocdn.com/a.m4s', 'https://u:p@vod-adaptive-ak.vimeocdn.com/a.m4s'])('拒绝跨域或危险片段地址 %s', bad => {
    const data = fixture(); data.video[0].segments[0].url = bad;
    expect(() => parseVimeoPlaylist(data, source)).toThrow();
  });
  it('清单base_url和轨道base_url同样执行可信域与协议检查', () => {
    for (const where of ['manifest', 'track']) {
      const data = fixture(); if (where === 'manifest') data.base_url = 'file:///C:/'; else data.audio[0].base_url = 'https://other.test/';
      expect(() => parseVimeoPlaylist(data, source)).toThrow();
    }
  });
  it('HTTP夹具只允许同源片段；HTTPS总清单不能降级HTTP', () => {
    const url = 'http://fixture.vimeocdn.com/playlist.json'; const data = fixture(); data.base_url = '/';
    expect(parseVimeoPlaylist(data, url).formats[0].fragments[1].url).toContain('http://fixture.vimeocdn.com/');
    data.video[0].segments[0].url = 'http://other.vimeocdn.com/s.mp4';
    expect(() => parseVimeoPlaylist(data, url)).toThrow();
  });
  it.each(['../init.mp4', 'data:video/mp4;base64,AAAA', 'AAAA', 'not base64!', Buffer.from('not an MP4 initializer').toString('base64')])('不把路径或任意数据当作初始化片段 %s', value => {
    const data = fixture(); data.video[0].init_segment = value;
    expect(() => parseVimeoPlaylist(data, source)).toThrow();
  });
  it('初始化片段必须是有ftyp/moov的完整文件头，拒绝媒体片段和加密标记', () => {
    for (const value of [Buffer.concat([box('moof'), box('mdat')]), Buffer.concat([box('ftyp'), box('moov', box('pssh'))])]) {
      const data = fixture(); data.video[0].init_segment = value.toString('base64'); expect(() => parseVimeoPlaylist(data, source)).toThrow();
    }
  });
  it('重复片段地址不猜测range，给出重新捕获query_string_ranges的提示', () => {
    const data = fixture(); data.video[0].segments[1].url = data.video[0].segments[0].url;
    expect(() => parseVimeoPlaylist(data, source)).toThrow('query_string_ranges=1');
  });
  it('字节范围与size一致，允许原站end-start的边界差一，不改变实际URL', () => {
    for (const size of [99, 100]) { const data = fixture(); data.video[0].segments[0].size = size; expect(parseVimeoPlaylist(data, source).formats[0].fragments).toHaveLength(3); }
    for (const range of ['1-0', '0-', '0-1&range=2-3', '9007199254740999-9007199254741000']) {
      const data = fixture(); data.video[0].segments[0].url = `x.mp4?range=${range}`;
      expect(() => parseVimeoPlaylist(data, source)).toThrow();
    }
    const data = fixture(); data.video[0].segments[0].size = 12; expect(() => parseVimeoPlaylist(data, source)).toThrow('大小与字节范围');
  });
  it('缺片、乱序、不连续时间轴和明显音画时长差异不能通过解析', () => {
    const modify = [(d: any) => d.video[0].segments.splice(0, 1), (d: any) => d.video[0].segments.reverse(),
      (d: any) => d.video[0].segments[1].start = 3, (d: any) => d.audio[0].segments[1].end = 12];
    for (const change of modify) { const data = fixture(); change(data); expect(() => parseVimeoPlaylist(data, source)).toThrow(); }
  });
  it('拒绝超大初始化/URL、重复轨道、空轨道、不安全编号和非有限数值', () => {
    const modify = [(d: any) => d.video[0].init_segment = 'A'.repeat(1400000), (d: any) => d.video[0].segments[0].url = 'x'.repeat(33000),
      (d: any) => d.video.push(d.video[0]), (d: any) => d.video[0].segments = [], (d: any) => d.clip_id = '../secret',
      (d: any) => d.video[0].id = '--exec', (d: any) => d.video[0].segments[0].end = Infinity, (d: any) => d.duration = NaN];
    for (const change of modify) { const data = fixture(); change(data); expect(() => parseVimeoPlaylist(data, source)).toThrow(); }
  });
  it('错误信息不回显签名或注入字段', () => {
    const data = fixture(); data.video[0].segments[0].url = 'file:///PRIVATE_SIGNED_TOKEN';
    try { parseVimeoPlaylist(data, source); throw new Error('应该拒绝'); } catch (error) { expect(String(error)).not.toContain('PRIVATE_SIGNED_TOKEN'); expect(String(error)).not.toContain('SYNTHETIC_SECRET'); }
  });
});

const bin = path.resolve('resources/bin');
const canRun = ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe'].every(name => existsSync(path.join(bin, name)));
async function run(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false, windowsHide: true }); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timeout = setTimeout(() => child.kill(), 30000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`夹具媒体命令失败：${stderr}`)); });
  });
}

it.skipIf(!canRun)('真实yt-dlp以data初始化+签名HTTP分片下载独立音视频并合并，双轨及全片解码通过', async () => {
  const root = path.resolve('.test-artifacts', `vimeo-playlist-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`);
  await fs.mkdir(root, { recursive: true });
  const ffmpeg = path.join(bin, 'ffmpeg.exe'), ytdlp = path.join(bin, 'yt-dlp.exe'), ffprobe = path.join(bin, 'ffprobe.exe');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-g', '24', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', 'source.mp4'], root);
  const resources = new Map<string, Buffer>();
  const tracks: Record<string, any[]> = { video: [], audio: [] };
  for (const [kind, map] of [['video', '0:v:0'], ['audio', '0:a:0']]) {
    const file = path.join(root, `${kind}.mp4`);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-i', 'source.mp4', '-map', map, '-c', 'copy', '-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '1000000', file], root);
    const bytes = await fs.readFile(file); let offset = 0, initEnd = 0; const chunks: Buffer[] = [];
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'moof') { if (!initEnd) initEnd = offset; const next = offset + size; const mdatSize = bytes.readUInt32BE(next); expect(bytes.toString('ascii', next + 4, next + 8)).toBe('mdat'); chunks.push(bytes.subarray(offset, next + mdatSize)); offset = next + mdatSize; }
      else offset += size;
    }
    expect(initEnd).toBeGreaterThan(0); expect(chunks.length).toBeGreaterThanOrEqual(2);
    const probe = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_format', '-of', 'json', file], root)).stdout);
    const duration = Number(probe.format.duration);
    const segments = chunks.map((chunk, index) => {
      const address = `/${kind}/${index}.mp4?range=${index * 10000000}-${index * 10000000 + chunk.length - 1}&pathsig=SYNTHETIC%2B%2F&sid=${index}`;
      resources.set(address, chunk);
      return { start: index * duration / chunks.length, end: (index + 1) * duration / chunks.length, size: chunk.length, url: address };
    });
    tracks[kind].push({ id: kind, base_url: '', bitrate: kind === 'video' ? 250000 : 64000, codecs: kind === 'video' ? 'mp4v.20.9' : 'mp4a.40.2',
      ...(kind === 'video' ? { width: 160, height: 90, fps: 24 } : {}), init_segment: bytes.subarray(0, initEnd).toString('base64'), segments });
  }
  const requests: Array<{ path: string; authorized: boolean }> = [];
  const cookieValue = 'SYNTHETIC_SESSION', userAgent = 'FrameCatch-Vimeo-Unit/1';
  const proxy = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.vimeocdn.com');
    const data = resources.get(url.pathname + url.search);
    const authorized = request.headers.cookie?.includes(`fixture=${cookieValue}`) === true && request.headers.referer === 'https://player.vimeo.com/' && request.headers['user-agent'] === userAgent;
    requests.push({ path: url.pathname, authorized });
    if (!authorized || !data) { response.writeHead(403).end('fixture requires signed segments and session'); return; }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length }); response.end(data);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('本地代理未启动');
    const manifestUrl = 'http://fixture.vimeocdn.com/signed/playlist.json?base64_init=1&query_string_ranges=1';
    const info = parseVimeoPlaylist({ clip_id: 'fixture-clip', base_url: '/', video: tracks.video, audio: tracks.audio }, manifestUrl);
    const input = path.join(root, 'trusted-info.json'); await fs.writeFile(input, JSON.stringify(info));
    const jar = path.join(root, 'fixture.cookies.txt'); await fs.writeFile(jar, `# Netscape HTTP Cookie File\nfixture.vimeocdn.com\tFALSE\t/\tFALSE\t0\tfixture\t${cookieValue}\n`);
    const output = path.join(root, 'merged.mp4');
    await run(ytdlp, ['--ignore-config', '--no-update', '--no-progress', '--no-overwrites', '--keep-fragments', '--keep-video', '--abort-on-unavailable-fragments', '--ffmpeg-location', bin,
      '--proxy', `http://127.0.0.1:${address.port}`, '--user-agent', userAgent, '--referer', 'https://player.vimeo.com/', '--cookies', jar,
      '--load-info-json', input, '--format', 'bestvideo+bestaudio', '--merge-output-format', 'mp4', '--output', output], root);
    const probe = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], root)).stdout);
    expect(probe.streams.some((stream: any) => stream.codec_type === 'video')).toBe(true);
    expect(probe.streams.some((stream: any) => stream.codec_type === 'audio')).toBe(true);
    expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(1.95);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], root);
    expect(requests).toHaveLength(resources.size); expect(requests.every(request => request.authorized)).toBe(true);
    await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ passed: true, requests, fragments: resources.size, duration: probe.format.duration, streams: probe.streams.map((stream: any) => ({ type: stream.codec_type, codec: stream.codec_name })) }, null, 2));
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}, 60000);
