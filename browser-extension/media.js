export const SESSION_KEY = 'framecatch-session-v1';
export const PAIRING_KEY = 'framecatch-pairing-v1';
export const BRIDGE_URL = 'http://127.0.0.1:46783';
export const CAPTURE_LIMIT = 30;
export const CAPTURE_TTL = 30 * 60 * 1000;
const control = /[\u0000-\u001f\u007f]/;

export function safeHttp(value) {
  if (typeof value !== 'string' || value.length > 32768 || control.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.hash = '';
    return parsed.href;
  } catch { return undefined; }
}

export function mediaResourceIssue(value) {
  const safe = safeHttp(value); if (!safe) return undefined;
  const url = new URL(safe);
  let path = url.pathname.toLowerCase();
  try { path = decodeURIComponent(path); } catch {}
  if (/(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/.test(url.hostname) && /\/v2\/range\//.test(path)) return 'byte-range';
  for (const [key, range] of url.searchParams) if (key.toLowerCase() === 'range' && /^(?:bytes=)?\d+-\d*$/i.test(range.trim())) return 'byte-range';
  if (/\.(?:ts|m4s)$/.test(path) || /(?:^|[\/_.-])(?:init|segment|chunk|fragment|frag)(?:[\/_.-]|\d|$)/.test(path)) return 'fragment';
  if (/\.(?:aac|mp3|m4a)$/.test(path) || /(?:^|\/)audio(?:\/|[_.-])/.test(path)) return 'audio';
  return undefined;
}

export const PARTIAL_MEDIA_HINT = '已忽略局部 MP4 或传输片段。请保持检测，刷新网页后从开头播放，优先捕获 HLS/DASH 总清单或 Vimeo 播放清单。';

export function isVimeoPlaylistUrl(value) {
  const safe = safeHttp(value); if (!safe) return false;
  const url = new URL(safe);
  return /(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/.test(url.hostname) && url.pathname.toLowerCase().endsWith('/playlist.json');
}

export function mediaKind(value, contentType = '', requestType = 'other') {
  const url = safeHttp(value);
  if (!url) return undefined;
  const parsed = new URL(url), path = parsed.pathname.toLowerCase();
  const mime = contentType.toLowerCase().split(';')[0].trim();
  if (mediaResourceIssue(url)) return undefined;
  if (isVimeoPlaylistUrl(url)) return 'vimeo-json';
  if (/\.(?:ts|m4s|aac|mp3|m4a|vtt|srt|key)$/.test(path) || /(?:^|[\/_.-])(?:init|segment|chunk|fragment|frag)(?:[\/_.-]|\d|$)/.test(path)) return undefined;
  if (mime.startsWith('audio/') || /(?:^|\/)(?:audio)(?:\/|[_.-])/.test(path)) return undefined;
  if (path.endsWith('.m3u8') || /mpegurl/.test(mime)) return 'hls';
  if (path.endsWith('.mpd') || mime === 'application/dash+xml') return 'dash';
  if (/(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/.test(parsed.hostname) && path.endsWith('/master.json')) return 'dash';
  if ((path.endsWith('.mp4') || mime === 'video/mp4') && ['media', 'xmlhttprequest', 'xhr', 'other'].includes(requestType)) return 'mp4';
  return undefined;
}

export function headerValue(headers, name, limit = 65536) {
  const matches = (headers || []).filter(item => item.name?.toLowerCase() === name.toLowerCase());
  if (!matches.length) return undefined;
  const values = matches.map(item => item.value).filter(value => typeof value === 'string');
  const value = name.toLowerCase() === 'cookie' ? values.join('; ') : values[0];
  return value && value.length <= limit && !control.test(value) ? value : undefined;
}

export function privateLabel(value) {
  try {
    const url = new URL(value);
    let name = url.pathname.split('/').filter(Boolean).at(-1) || '媒体资源';
    try { name = decodeURIComponent(name); } catch {}
    // Labels deliberately omit the query, fragment and account-related data.
    return `${url.hostname} / ${name.length > 60 ? name.slice(0, 57) + '…' : name}`;
  } catch { return '媒体资源'; }
}

export function publicCapture(capture) {
  return { id: capture.id, kind: capture.kind, label: privateLabel(capture.url), hasCookie: Boolean(capture.cookieHeader), capturedAt: capture.capturedAt };
}

export function capturePayload(capture) {
  const result = { url: capture.url, pageUrl: capture.pageUrl, title: capture.title, userAgent: capture.userAgent };
  for (const name of ['referer', 'origin', 'cookieHeader', 'contentType']) if (capture[name]) result[name] = capture[name];
  return result;
}
