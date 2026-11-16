import path from 'node:path';
import type { AnalysisResult, AppSettings, DownloadProgress, MediaContext, VideoEntry, VideoFormat } from '../shared/types';

type JsonObject = Record<string, any>;
export const PROGRESS_PREFIX = '__FRAME_PROGRESS__';
export const POST_PREFIX = '__FRAME_POST__';
export const FILE_PREFIX = '__FRAME_FILE__';
export const META_PREFIX = '__FRAME_META__';

export function validateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n\u0000]/.test(value)) throw new Error('请输入有效的视频网页网址。');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的网址，例如 https://www.bilibili.com/video/…'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('仅支持不含账号密码的 HTTP 或 HTTPS 视频网址。');
  return url.href;
}

export function validateProxy(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\u0000]/.test(value)) throw new Error('代理地址格式不正确。');
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('代理地址应类似 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('仅支持 HTTP、HTTPS、SOCKS4、SOCKS5 代理地址。');
  return value.trim();
}

export function validateMediaContext(value: unknown): MediaContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器播放环境信息无效，请重新捕获视频。');
  const input = value as Record<string, unknown>;
  const controls = /[\u0000-\u001f\u007f]/;
  if (typeof input.referer !== 'string' || controls.test(input.referer)) throw new Error('视频来源页面信息无效，请重新捕获视频。');
  const referer = validateUrl(input.referer);
  if (typeof input.userAgent !== 'string' || !input.userAgent.trim() || input.userAgent.length > 2048 || controls.test(input.userAgent)) throw new Error('浏览器标识无效，请重新捕获视频。');
  if (typeof input.proxy !== 'string' || controls.test(input.proxy)) throw new Error('浏览器代理信息无效，请重新捕获视频。');
  const proxy = validateProxy(input.proxy);
  let origin: string | undefined;
  if (input.origin !== undefined && input.origin !== '') {
    if (typeof input.origin !== 'string' || controls.test(input.origin)) throw new Error('视频请求来源信息无效，请重新捕获视频。');
    const parsed = new URL(validateUrl(input.origin));
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('视频请求来源必须为有效的 HTTP 或 HTTPS 站点地址。');
    origin = parsed.origin;
  }
  let cookiePath: string | undefined;
  if (input.cookiePath !== undefined && input.cookiePath !== '') {
    if (typeof input.cookiePath !== 'string' || !path.isAbsolute(input.cookiePath) || controls.test(input.cookiePath)) throw new Error('浏览器登录凭据文件无效，请重新捕获视频。');
    cookiePath = path.resolve(input.cookiePath);
  }
  // Only these named fields are carried forward. Arbitrary renderer-provided
  // headers, Cookie and Authorization must never become global HTTP headers.
  return { referer, userAgent: input.userAgent.trim(), proxy, ...(origin ? { origin } : {}), ...(cookiePath ? { cookiePath } : {}) };
}

export function vimeoPlayerFallback(value: string, error: string): string | undefined {
  // This fallback is deliberately limited to Vimeo's public numeric video URL
  // and its current web-client authentication error. It never rewrites albums,
  // other hosts, existing player links, or general access/password failures.
  if (!/\bThe web client only works when logged[- ]in\b/i.test(error)) return undefined;
  let original: URL;
  try { original = new URL(value); } catch { return undefined; }
  if (!['vimeo.com', 'www.vimeo.com'].includes(original.hostname.toLowerCase()) || !['http:', 'https:'].includes(original.protocol)) return undefined;
  const match = /^\/(\d+)(?:\/([a-f\d]{10}))?\/?$/i.exec(original.pathname);
  if (!match) return undefined;
  const player = new URL(`https://player.vimeo.com/video/${match[1]}`);
  player.search = original.search;
  player.hash = original.hash;
  if (match[2] && !player.searchParams.has('h')) player.searchParams.set('h', match[2]);
  return player.href;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function relocatePortablePath(value: string, oldRoot: string, newRoot: string): string {
  return value && oldRoot && path.isAbsolute(value) && isPathInside(oldRoot, value)
    ? path.join(newRoot, path.relative(oldRoot, value)) : value;
}

function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function httpImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : undefined; } catch { return undefined; }
}

export function normalizeFormats(info: JsonObject): VideoFormat[] {
  const raw: JsonObject[] = Array.isArray(info.formats) ? info.formats : [info];
  const audio = raw.filter(f => f && f.acodec && f.acodec !== 'none').at(-1);
  const videos = raw.filter(f => f && f.vcodec !== 'none' && !f.has_drm && f.format_id != null);
  const best = videos.at(-1) || info;
  const knownAudio = audio?.acodec || (info.acodec && info.acodec !== 'none' ? info.acodec : 'none');
  const result: VideoFormat[] = [{ id: 'best', label: '最高画质', height: positiveNumber(best.height), fps: positiveNumber(best.fps), ext: best.ext || info.ext || '', videoCodec: best.vcodec, audioCodec: knownAudio }];
  // Keep one highest-ranked yt-dlp variant per resolution. The original format ID
  // is retained so selecting 1080p never silently selects a different resolution.
  const byHeight = new Map<string, JsonObject>();
  for (const f of videos) {
    const id = String(f.format_id);
    if (!/^[a-zA-Z0-9_.:-]+$/.test(id) || id === 'best') continue;
    byHeight.set(String(f.height || f.resolution || id), f);
  }
  for (const f of [...byHeight.values()].reverse().slice(0, 24)) {
    const height = positiveNumber(f.height);
    const fps = positiveNumber(f.fps);
    result.push({ id: String(f.format_id), label: `${height ? `${height}p` : (f.resolution || '原始视频')}${fps && fps > 30 ? ` · ${Math.round(fps)}fps` : ''}${f.ext ? ` · ${String(f.ext).toUpperCase()}` : ''}`, height, fps, ext: f.ext || '', size: positiveNumber(f.filesize || f.filesize_approx), videoCodec: f.vcodec, audioCodec: f.acodec && f.acodec !== 'none' ? f.acodec : knownAudio });
  }
  return result;
}

function entryUrl(info: JsonObject, fallback: string): string {
  // Bilibili pages share a BV id, but page number is essential when downloading
  // individual selections. yt-dlp emits the ?p= URL in webpage_url.
  for (const candidate of [info.webpage_url, info.original_url, info.url]) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return validateUrl(candidate);
  }
  if (/youtube/i.test(String(info.ie_key || info.extractor_key || '')) && /^[\w-]{11}$/.test(String(info.id))) return `https://www.youtube.com/watch?v=${info.id}`;
  return fallback;
}

export function normalizeAnalysis(raw: JsonObject, url: string): AnalysisResult {
  if (!raw || typeof raw !== 'object') throw new Error('下载引擎没有返回有效的视频信息。');
  const warnings: string[] = [];
  const isPlaylist = Array.isArray(raw.entries);
  const flattened: { info: JsonObject; index?: number }[] = [];
  function collect(item: JsonObject | null | undefined, topIndex?: number) {
    if (!item) { warnings.push('列表中有暂时无法访问的视频，已略过。'); return; }
    if (Array.isArray(item.entries)) { item.entries.forEach((entry: JsonObject, index: number) => collect(entry, topIndex ?? index + 1)); return; }
    if (item.is_live || item.live_status === 'is_live' || item.live_status === 'is_upcoming') { warnings.push(`「${String(item.title || '该视频')}」是直播或尚未开始的内容，首版仅支持点播。`); return; }
    if (item.has_drm) { warnings.push(`「${String(item.title || '该视频')}」包含 DRM 保护，无法下载。`); return; }
    flattened.push({ info: item, index: topIndex });
  }
  collect(raw);
  const entries: VideoEntry[] = flattened.map(({ info, index: topIndex }, index) => ({
    id: String(info.id || index + 1), url: entryUrl(info, url), title: String(info.title || raw.title || '未命名视频').slice(0, 600),
    thumbnail: httpImage(info.thumbnail) || (Array.isArray(info.thumbnails) ? httpImage(info.thumbnails.at(-1)?.url) : undefined),
    duration: positiveNumber(info.duration), uploader: typeof (info.uploader || info.channel) === 'string' ? String(info.uploader || info.channel).slice(0, 300) : undefined,
    platform: String(info.extractor_key || info.extractor || raw.extractor_key || new URL(url).hostname), formats: normalizeFormats(info),
    ...(isPlaylist && entryUrl(info, url) === url && topIndex ? { playlistUrl: url, playlistIndex: topIndex } : {}),
  }));
  if (!entries.length) throw new Error(warnings[0] || '这个网页未找到可下载的视频。可尝试打开视频的原始播放页面，或更新解析引擎。');
  if (/behance\.net$/i.test(new URL(url).hostname)) warnings.push('Behance 使用通用解析，能否下载取决于作品中的嵌入视频和媒体来源。');
  if (isPlaylist && Number(raw.playlist_count || raw.n_entries) > entries.length) warnings.push('为避免分析过久，首轮最多分析前 50 条。可粘贴未列出视频的独立网址继续下载。');
  return { url, title: String(raw.title || entries[0].title), entries, isPlaylist, warnings: [...new Set(warnings)] };
}

export function formatSelector(video: VideoEntry, id: string): string {
  if (id === 'best') return 'bestvideo*+bestaudio/best/bestvideo';
  const format = video.formats.find(f => f.id === id);
  if (!format || !/^[a-zA-Z0-9_.:-]+$/.test(id)) throw new Error('画质选项已失效，请重新分析视频。');
  // Adding bestaudio has no effect for an already combined format because
  // --no-audio-multistreams keeps its original audio stream.
  return `${id}+bestaudio/${id}`;
}

export function commonArgs(binDir: string, settings: AppSettings, context?: MediaContext, mediaUrl?: string): string[] {
  const mediaContext = context ? validateMediaContext(context) : undefined;
  const credentials = mediaContext || settings;
  const args = ['--ignore-config', '--no-plugin-dirs', '--no-colors', '--encoding', 'utf-8', '--ffmpeg-location', binDir, '--no-js-runtimes', '--js-runtimes', `deno:${path.join(binDir, 'deno.exe')}`, '--socket-timeout', '25', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '2', '--cache-dir', path.join(binDir, '..', '..', 'data', 'yt-cache')];
  if (credentials.cookiePath) args.push('--cookies', credentials.cookiePath);
  if (credentials.proxy) args.push('--proxy', credentials.proxy);
  if (mediaContext) {
    args.push('--referer', mediaContext.referer, '--user-agent', mediaContext.userAgent);
    if (mediaContext.origin) args.push('--add-headers', `Origin:${mediaContext.origin}`);
  }
  // Xinpianchang's own public extractor requires this complete-resource Range
  // header for progressive MP4s. A captured direct URL goes through Generic,
  // so preserve that requirement here without forwarding finite browser ranges.
  if (mediaUrl) {
    try {
      const source = new URL(mediaUrl);
      if (['http:', 'https:'].includes(source.protocol) && (source.hostname.toLowerCase() === 'xpccdn.com' || source.hostname.toLowerCase().endsWith('.xpccdn.com')) && source.pathname.toLowerCase().endsWith('.mp4')) args.push('--add-headers', 'Range:bytes=0-');
    } catch { /* URL validation remains the caller's responsibility. */ }
  }
  return args;
}

export function downloadArgs(binDir: string, settings: AppSettings, task: { video: VideoEntry; formatId: string; workDir: string }): string[] {
  const selection = task.video.playlistUrl && task.video.playlistIndex ? ['--yes-playlist', '--playlist-items', String(task.video.playlistIndex)] : ['--no-playlist'];
  // Vimeo can advertise an apparently clear HLS format that only declares DRM
  // when tested. Check candidates so best can fall back to an accessible clear
  // stream. This tests availability only; it never enables protected formats.
  const checkFormats = /^(?:(?:www|player)\.)?vimeo\.com$/i.test(new URL(task.video.playlistUrl || task.video.url).hostname) ? ['--check-formats'] : [];
  return [...commonArgs(binDir, settings, task.video.mediaContext, task.video.playlistUrl || task.video.url), ...selection, ...checkFormats, '--concat-playlist', 'never', '--no-simulate', '--no-overwrites', '--no-post-overwrites', '--continue', '--part', '--keep-video', '--keep-fragments', '--abort-on-unavailable-fragments', '--no-write-info-json', '--no-write-playlist-metafiles', '--match-filters', '!is_live', '--merge-output-format', 'mp4/mkv', '--format', formatSelector(task.video, task.formatId), '--paths', task.workDir, '--output', 'media.%(ext)s', '--windows-filenames', '--newline', '--progress', '--progress-delta', '0.5', '--progress-template', `download:${PROGRESS_PREFIX}%(progress)j`, '--progress-template', `postprocess:${POST_PREFIX}%(progress)j`, '--print', `before_dl:${META_PREFIX}{"acodec":%(acodec)j,"vcodec":%(vcodec)j,"duration":%(duration)j,"audio_codecs":%(requested_formats.:.acodec)j}`, '--print', `after_move:${FILE_PREFIX}%(filepath)j`, '--', validateUrl(task.video.playlistUrl || task.video.url)];
}

export function parseProgress(line: string): DownloadProgress | undefined {
  const start = line.indexOf(PROGRESS_PREFIX);
  if (start < 0) return undefined;
  try {
    const raw = JSON.parse(line.slice(start + PROGRESS_PREFIX.length));
    const totalBytes = positiveNumber(raw.total_bytes || raw.total_bytes_estimate);
    const downloadedBytes = Number.isFinite(Number(raw.downloaded_bytes)) ? Number(raw.downloaded_bytes) : undefined;
    return { percent: totalBytes && downloadedBytes != null ? Math.min(100, Math.max(0, downloadedBytes / totalBytes * 100)) : (raw.status === 'finished' ? 100 : undefined), downloadedBytes, totalBytes, speed: positiveNumber(raw.speed), eta: typeof raw.eta === 'number' && raw.eta >= 0 ? raw.eta : undefined, detail: raw.fragment_count ? `分片 ${raw.fragment_index || 0} / ${raw.fragment_count}` : (raw.status === 'finished' ? '当前轨道下载完成' : '正在下载视频') };
  } catch { return undefined; }
}

export function expectsAudio(metadata: JsonObject): boolean {
  if (metadata.acodec && metadata.acodec !== 'none' && metadata.acodec !== 'NA') return true;
  if (Array.isArray(metadata.audio_codecs) && metadata.audio_codecs.some((codec: unknown) => typeof codec === 'string' && codec !== 'none')) return true;
  return Array.isArray(metadata.requested_formats) && metadata.requested_formats.some((f: JsonObject) => f.acodec && f.acodec !== 'none');
}

export function verifyProbe(probe: JsonObject, expectedAudio: boolean, expectedDuration?: number): void {
  if (!Array.isArray(probe.streams) || !probe.streams.some((s: JsonObject) => s.codec_type === 'video')) throw new Error('合并后的文件缺少视频轨道，未标记为完成。');
  if (expectedAudio && !probe.streams.some((s: JsonObject) => s.codec_type === 'audio')) throw new Error('合并后的文件缺少应有的音频轨道，未标记为完成。');
  const duration = positiveNumber(probe.format?.duration);
  if (!duration) throw new Error('无法读取成品时长，文件可能不完整。');
  if (expectedDuration && expectedDuration >= 10 && duration < expectedDuration - Math.max(5, expectedDuration * 0.03)) throw new Error('成品时长明显短于源视频，可能有缺失分片，未标记为完成。');
}

export function safeFilename(title: string): string {
  const clean = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return (clean || '视频').slice(0, 100).replace(/[. ]+$/g, '');
}

export function redactLog(text: string): string {
  // Generic extractor IDs can be bare media filenames followed by the FULL
  // signed query, without an http:// prefix. Stop at the actual error message,
  // not at encoded JSON, so IP/device/session fields cannot survive in the ID.
  const genericSafe = text.replace(/(\[generic\]\s+[^\r\n?]*\?)[^\r\n]*?(?=:\s*(?:Unable|Got|HTTP|Requested|This|No\b|The\b|Video\b|Unsupported|Download|fragment)\b|$)/gim, '$1[参数已隐藏]');
  const safeIds = genericSafe.replace(/(\[generic\]\s+)([^\r\n]*?)(?=:\s*(?:Unable|Got|HTTP|Requested|This|No\b|The\b|Video\b|Unsupported|Download|fragment)\b|$)/gim,
    (all, prefix: string, id: string) => /[?&=]/.test(id) ? `${prefix}[参数已隐藏]` : all);
  return safeIds.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const u = new URL(value);
      const privatePath = /(?:^|\.)(?:vimeocdn\.com|akamaized\.net|douyinvod\.com)$/i.test(u.hostname) ? '/[媒体路径已隐藏]' : u.pathname;
      return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${privatePath}${u.search ? '?[参数已隐藏]' : ''}`;
    } catch { return '[网址已隐藏]'; }
  }).replace(/([^\s"'<>?]+\.(?:mp4|m4v|mov|mkv|webm|m3u8|mpd|json|ts|m4s)\?)[^\s<>]+/gi, (value, prefix: string) => `${prefix}[参数已隐藏]${value.endsWith(':') ? ':' : ''}`)
    .replace(/(?:Cookie|Authorization|Proxy-Authorization)\s*[:=][^\r\n]*/gi, '[凭据已隐藏]').replace(/(?:socks5h?|socks4|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '[代理凭据已隐藏]@');
}

/** Product-facing summaries only. The complete, redacted source stays in logs. */
export function displayWarnings(stderr: string): string[] {
  const messages: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!/^\s*WARNING:/i.test(line)) continue;
    const warning = line.replace(/^\s*WARNING:\s*/i, '').replace(/^(?:\[[^\]]+\]\s*)+/, '');
    if (/DRM|protected content/i.test(warning)) messages.push('部分媒体流受 DRM 保护，软件将仅尝试其他可用格式。');
    else if (/HTTP Error (?:403|429)|forbidden|too many requests|geo.restrict|not available in your country|region.restrict/i.test(warning)) messages.push('部分资源受到网站访问、地区或请求频率限制，所列画质可能不完整。请先在浏览器确认可播放。');
    else if (/cookies?.*(?:expired|invalid|no longer valid)|(?:expired|invalid).*cookies?/i.test(warning)) messages.push('登录凭据可能已经过期，部分视频或画质可能不可用。请重新导入有效的 Cookie 文件。');
    else if (/login|logged.in|sign in|members.only|premium.only|account.*required|authentication/i.test(warning)) messages.push('部分内容或画质需要有效的登录态及账号权限，可在设置中导入 Cookie 后重试。');
    else if (/signature.*(?:fail|unable)|challenge.*(?:fail|unable)|(?:javascript|JS) runtime|n.?challenge/i.test(warning)) messages.push('部分画质暂时无法解析。请检查便携包是否完整，并按使用说明更新解析引擎。');
    else if (/(?:formats?|quality).*(?:missing|unavailable|not available|skipped|fail)|(?:missing|unavailable|skipped).*formats?|SABR/i.test(warning)) messages.push('部分画质或播放线路暂时不可用，软件已展示当前可解析的选项。');
    else if (/m3u8|DASH|manifest|playlist.*(?:unable|fail)|(?:unable|fail).*playlist/i.test(warning)) messages.push('部分播放线路读取失败，当前可用画质可能不完整。可稍后重新分析。');
    else if (/outdated|older than|update.*yt-dlp|yt-dlp.*update/i.test(warning)) messages.push('解析引擎版本可能较旧，部分网站可能无法使用，可按使用说明更新。');
    else if (/falling back on generic information extractor|generic information extractor|(?:unable|cannot|could not|failed).*title|title.*(?:missing|unavailable)|subtitles?|captions?|thumbnails?/i.test(warning)) continue;
    else messages.push('部分视频信息未能完整获取；当前可用选项已展示。如遇下载问题，请查看解析日志。');
  }
  return [...new Set(messages)].slice(0, 5);
}

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '未知错误');
  if (/no space|ENOSPC|disk.*full|磁盘.*空间/i.test(raw)) return '磁盘空间不足，请释放空间或更改保存位置后重试。';
  if (/EACCES|EPERM|permission denied|access.*denied|拒绝访问/i.test(raw)) return '无法写入文件，请检查保存目录权限、磁盘或文件是否被占用。';
  if (/ENOENT|not found.*ffmpeg|ffmpeg.*not found|ffprobe.*not found/i.test(raw)) return '所需组件或文件缺失，请检查便携包是否完整，或查看任务日志。';
  if (/未找到可用的非 DRM 格式/.test(raw)) return '已检查可选画质，未找到可用的非 DRM 格式，无法完成下载。';
  if (/DRM|protected content|encrypted.*not supported/i.test(raw)) return '所选媒体流受 DRM 保护。可重新分析并选择其他可用画质；全部媒体流受保护时无法下载。';
  if (/fragment.*(?:not found|unavailable|unable to continue|failed)|unable to continue.*fragment/i.test(raw)) return '视频分片缺失或下载失败，已停止合并以避免输出不完整视频。请稍后重试，中间文件已保留。';
  if (/trun track id unknown|no tfhd was found|moov atom not found|could not find corresponding trex/i.test(raw)) return '当前媒体缺少完整的 MP4 初始化或轨道信息，可能是播放器分片或不完整文件。请在 Chrome 插件中重新检测并发送 HLS/DASH 总清单，不要重试同一条局部 MP4；已下载的文件保留。';
  if (/ffmpeg.*(?:exited|error|failed)|(?:merg|mux|remux|postprocess).*(?:error|fail)|could not write header|error initializing output|invalid data found when processing input|(?:合并|封装|成品校验).*失败/i.test(raw)) return '音视频合并、封装或文件校验失败，源文件与中间文件已保留。请查看任务日志后重试。';
  if (/web client only works when logged[- ]in/i.test(raw)) return '当前 Vimeo 网页解析入口要求登录，并不能确定视频本身需要账号。可以尝试浏览器辅助分析。';
  if (/fresh cookies.*needed/i.test(raw)) return '抖音当前解析入口没有返回完整的视频信息，可能需要浏览器会话或网站验证，并不一定要求登录账号。请使用浏览器辅助分析，或在 Chrome 正常播放后通过插件发送视频。';
  if (/HTTP Error 401|Unauthorized/i.test(raw)) return '服务器未授权当前播放请求，可能与浏览器播放环境、来源页面或访问限制有关。请使用浏览器辅助分析，或确认原网页可以正常播放后重试。';
  if (/Sign in|login required|log in|cookies|private video|members.only|premium.only|not a bot|captcha/i.test(raw)) return '该视频需要登录、账号权限或通过网站验证。请在浏览器确认可播放，并在设置中导入有效的 Cookie 文件后重试。';
  if (/HTTP Error 403|HTTP Error 429|forbidden|too many requests|geo.restrict|not available in your country/i.test(raw)) return '网站拒绝了访问，可能要求浏览器验证或限制当前网络、地区及账号权限。请先在浏览器确认可播放，可导入有效 Cookie 后重试；Cookie 不保证能解决访问限制。';
  if (/unsupported url|no video|no formats|unable to extract|extractor error|requested format.*not available/i.test(raw)) return '暂时无法解析这个页面或所选画质。请尝试原始视频网址、重新分析，或按说明更新解析引擎。';
  if (/timed? ?out|connection|network|resolve|HTTP Error 5\d\d|remote end closed/i.test(raw)) return '网络连接失败或超时，请检查网络、代理配置后重试。';
  if (/[\u3400-\u9fff]/.test(raw)) return redactLog(raw).replace(/^ERROR:\s*/i, '').slice(-1200);
  return '操作未能完成，详细原因已记录到日志。请查看日志后重试。';
}
