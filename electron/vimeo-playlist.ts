import { isVimeoPlaylistUrl } from './media-resource';

export { isVimeoPlaylistUrl } from './media-resource';

export interface VimeoFragment { url: string; duration?: number; }
export interface VimeoPlaylistFormat {
  format_id: string; url: string; manifest_url: string; ext: 'mp4' | 'm4a';
  protocol: 'http_dash_segments'; fragments: VimeoFragment[];
  vcodec: string; acodec: string; width?: number; height?: number; fps?: number;
  tbr?: number; abr?: number; duration?: number; filesize?: number;
}
export interface VimeoPlaylistInfo {
  id: string; title: string; webpage_url: string; original_url: string;
  extractor: string; extractor_key: string; is_live: false; has_drm: false;
  duration?: number; formats: VimeoPlaylistFormat[];
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_URL = 32768;
const MAX_TRACKS = 64;
const MAX_FRAGMENTS = 100000;
const MAX_URL_BYTES = 32 * 1024 * 1024;
const MAX_INIT_BYTES = 1024 * 1024;
const MAX_TOTAL_INIT_BYTES = 8 * 1024 * 1024;
const MAX_DURATION = 7 * 24 * 60 * 60;

function fail(message: string): never { throw new Error(`Vimeo 视频清单无效：${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('数据结构不正确，请重新播放并捕获总清单。');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length > limit || CONTROL.test(value)) fail(`${label}格式不正确。`);
  return value;
}
function positive(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
}
function trustedHost(host: string): boolean { return /(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/i.test(host); }

/** The manifest supplies its own signed URLs. Resolve its documented three base
 * levels, without inventing signatures, rewriting ranges or inheriting queries.
 * HTTPS manifests cannot downgrade to HTTP. HTTP is restricted to the same
 * origin, matching existing HTTP input support and the local proxy test fixture. */
function resolveResource(value: unknown, base: URL, source: URL): string {
  const raw = value === undefined ? '' : text(value, MAX_URL, '媒体地址');
  let result: URL;
  try { result = new URL(raw, base); } catch { fail('媒体地址无法解析。'); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.hash ||
      !trustedHost(result.hostname) || result.href.length > MAX_URL || CONTROL.test(result.href) ||
      (source.protocol === 'https:' && result.protocol !== 'https:') ||
      (result.protocol === 'http:' && result.origin !== source.origin)) fail('媒体地址不属于可信视频 CDN，或协议不安全。');
  return result.href;
}

function decodeInit(value: unknown): Buffer {
  const raw = text(value, Math.ceil(MAX_INIT_BYTES / 3) * 4, '初始化数据');
  if (!raw || raw.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    fail('缺少内嵌初始化数据；请重新捕获带 base64_init=1 的总清单。');
  }
  const decoded = Buffer.from(raw, 'base64');
  if (!decoded.length || decoded.length > MAX_INIT_BYTES || decoded.toString('base64') !== raw) fail('初始化数据超出范围或编码不正确。');
  const types = new Set<string>();
  let offset = 0;
  while (offset < decoded.length) {
    if (offset + 8 > decoded.length) fail('初始化 MP4 结构不完整。');
    const kind = decoded.toString('ascii', offset + 4, offset + 8);
    let size = decoded.readUInt32BE(offset), header = 8;
    if (size === 1) {
      if (offset + 16 > decoded.length) fail('初始化 MP4 结构不完整。');
      const extended = decoded.readBigUInt64BE(offset + 8);
      if (extended > BigInt(MAX_INIT_BYTES)) fail('初始化 MP4 结构不完整。');
      size = Number(extended); header = 16;
    }
    if (size === 0) size = decoded.length - offset;
    if (size < header || offset + size > decoded.length) fail('初始化 MP4 结构不完整。');
    types.add(kind); offset += size;
  }
  if (!types.has('ftyp') || !types.has('moov') || types.has('moof') || types.has('mdat')) fail('初始化数据不是完整的 MP4 文件头。');
  if (['pssh', 'encv', 'enca'].some(marker => decoded.includes(Buffer.from(marker)))) fail('此清单包含加密保护，当前不支持下载。');
  return decoded;
}

/** Convert Vimeo's documented master/playlist schema into a narrowly generated
 * yt-dlp info object. No input headers, downloader options, paths or processors
 * are forwarded. Schema reference: akiomik/vimeo-dl, vimeo/masterjson.go and
 * vimeo/testdata/playlist-segments.json. yt-dlp's native DASH downloader accepts
 * a data: initializer, avoiding file:// access or a separate local HTTP server. */
export function parseVimeoPlaylist(value: unknown, sourceUrl: string): VimeoPlaylistInfo {
  if (!isVimeoPlaylistUrl(sourceUrl)) fail('请使用浏览器实际请求的可信 playlist.json 总清单。');
  const source = new URL(sourceUrl);
  if (source.hash || source.href.length > MAX_URL || CONTROL.test(sourceUrl)) fail('总清单地址格式不正确。');
  const input = object(value);
  if (input.is_live === true || input.live === true || input.has_drm === true || input.encrypted === true) fail('不支持直播或加密视频。');
  const rawId = typeof input.clip_id === 'number' && Number.isSafeInteger(input.clip_id) && input.clip_id >= 0 ? String(input.clip_id) : input.clip_id;
  const id = text(rawId, 128, '作品编号');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) fail('作品编号格式不正确。');
  const title = input.title === undefined ? `Vimeo 视频 ${id}` : text(input.title, 512, '作品标题').trim() || `Vimeo 视频 ${id}`;
  const videos = input.video;
  const audios = input.audio === undefined ? [] : input.audio;
  if (!Array.isArray(videos) || !videos.length || !Array.isArray(audios) || videos.length + audios.length > MAX_TRACKS) fail('没有可用的视频轨道，或轨道数量超出范围。');
  const manifestBase = new URL(resolveResource(input.base_url, source, source));
  const formats: VimeoPlaylistFormat[] = [];
  let urlBytes = 0, initBytes = 0, fragments = 0;
  const ids = new Set<string>();
  const durations: number[] = [];
  for (const [kind, tracks] of [['video', videos], ['audio', audios]] as const) {
    for (const rawTrack of tracks) {
      const track = object(rawTrack);
      if (track.has_drm === true || track.encrypted === true) fail('此清单包含加密轨道。');
      const trackId = text(track.id, 128, '轨道编号');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trackId)) fail('轨道编号格式不正确。');
      const formatId = `vimeo-${kind}-${trackId}`;
      if (ids.has(formatId)) fail('轨道编号重复。');
      ids.add(formatId);
      const init = decodeInit(track.init_segment);
      initBytes += init.length;
      if (initBytes > MAX_TOTAL_INIT_BYTES) fail('初始化数据总量超出范围。');
      const segments = track.segments;
      if (!Array.isArray(segments) || !segments.length || segments.length > MAX_FRAGMENTS || (fragments += segments.length) > MAX_FRAGMENTS) fail('视频分片缺失或数量超出范围。');
      const trackBase = new URL(resolveResource(track.base_url, manifestBase, source));
      const seen = new Set<string>();
      const output: VimeoFragment[] = [{ url: `data:application/octet-stream;base64,${init.toString('base64')}` }];
      const firstSegment = object(segments[0]);
      const timed = firstSegment.start !== undefined || firstSegment.end !== undefined;
      let previousEnd: number | undefined, lastEnd: number | undefined, sizeSum = init.length, allSizes = true;
      for (const rawSegment of segments) {
        const segment = object(rawSegment);
        if (typeof segment.url !== 'string' || !segment.url) fail('分片缺少实际请求地址。');
        const url = resolveResource(segment.url, trackBase, source);
        urlBytes += Buffer.byteLength(url);
        if (urlBytes > MAX_URL_BYTES) fail('分片地址总量超出范围。');
        if (seen.has(url)) fail('多个分片指向同一地址；请重新捕获带 query_string_ranges=1 的总清单。');
        seen.add(url);
        const ranges = new URL(url).searchParams.getAll('range');
        let expectedSize = positive(segment.size, 2 ** 40);
        if (segment.size !== undefined && (!Number.isSafeInteger(segment.size) || (segment.size as number) < 0 || (segment.size as number) > 2 ** 40)) fail('分片大小格式不正确。');
        if (ranges.length) {
          const match = ranges.length === 1 && /^(\d+)-(\d+)$/.exec(ranges[0]);
          if (!match) fail('分片字节范围格式不正确。');
          const start = Number(match[1]), end = Number(match[2]);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= 2 ** 40) fail('分片字节范围超出范围。');
          const inclusive = end - start + 1;
          // Vimeo sometimes advertises end-start while serving both endpoints.
          if (segment.size !== undefined && segment.size !== inclusive && segment.size !== inclusive - 1) fail('分片大小与字节范围不一致。');
          expectedSize = inclusive;
        }
        if (expectedSize) sizeSum += expectedSize; else allSizes = false;
        const fragment: VimeoFragment = { url };
        if (timed) {
          const start = segment.start, end = segment.end;
          if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > MAX_DURATION ||
              (previousEnd === undefined && start > 0.1) || (previousEnd !== undefined && Math.abs(start - previousEnd) > 0.1)) fail('分片时间轴缺失、乱序或不连续。');
          fragment.duration = end - start; previousEnd = lastEnd = end;
        } else if (segment.start !== undefined || segment.end !== undefined) fail('分片时间轴不完整。');
        output.push(fragment);
      }
      if (lastEnd) durations.push(lastEnd);
      const codecs = track.codecs === undefined ? 'unknown' : text(track.codecs, 64, '编码信息');
      if (!/^[A-Za-z0-9_.-]+$/.test(codecs)) fail('轨道编码信息不正确。');
      const bitrate = positive(track.bitrate, 10 ** 10);
      const format: VimeoPlaylistFormat = {
        format_id: formatId, url: source.href, manifest_url: source.href,
        ext: kind === 'video' ? 'mp4' : 'm4a', protocol: 'http_dash_segments', fragments: output,
        vcodec: kind === 'video' ? codecs : 'none', acodec: kind === 'audio' ? codecs : 'none',
        ...(lastEnd ? { duration: lastEnd } : {}), ...(allSizes ? { filesize: sizeSum } : {}),
        ...(bitrate ? { tbr: bitrate / 1000, ...(kind === 'audio' ? { abr: bitrate / 1000 } : {}) } : {}),
      };
      if (kind === 'video') {
        for (const key of ['width', 'height', 'fps'] as const) {
          const number = positive(track[key], key === 'fps' ? 1000 : 32768);
          if (number) format[key] = number;
        }
      }
      formats.push(format);
    }
  }
  const declaredDuration = input.duration === undefined ? undefined : positive(input.duration, MAX_DURATION);
  if (input.duration !== undefined && !declaredDuration) fail('视频时长格式不正确。');
  const duration = declaredDuration || (durations.length ? Math.max(...durations) : undefined);
  if (duration && durations.some(end => Math.abs(end - duration) > Math.max(1, duration * 0.03))) fail('音视频轨道时长不一致，可能缺少分片。');
  return { id, title, webpage_url: source.href, original_url: source.href, extractor: 'FrameCatchVimeoPlaylist', extractor_key: 'FrameCatchVimeoPlaylist',
    is_live: false, has_drm: false, ...(duration ? { duration } : {}), formats };
}
