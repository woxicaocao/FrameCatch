import { mediaResourceIssue, isVimeoPlaylistUrl } from './media-resource';
export type MediaKind = 'hls' | 'dash' | 'mp4';

export function normalizeCapturedMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    // Vimeo's own yt-dlp extractor uses this same CDN manifest mapping. Its
    // HTML5 player can request master.json rather than a literal MPD URL.
    if (['http:', 'https:'].includes(url.protocol) && /(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/i.test(url.hostname) && url.pathname.endsWith('/master.json')) {
      url.pathname = url.pathname.slice(0, -'master.json'.length) + 'master.mpd';
      return url.href;
    }
  } catch {}
  return value;
}

export function mediaKind(url: string, contentType: string, resourceType: string): MediaKind | undefined {
  if (mediaResourceIssue(url)) return;
  if (isVimeoPlaylistUrl(url)) return 'dash';
  let path: string;
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) return; path = parsed.pathname.toLowerCase(); } catch { return; }
  const mime = contentType.toLowerCase().split(';')[0].trim();
  if (/(?:\.m4s|\.ts|\.aac|\.mp3|\.vtt|\.srt|\.key)$/.test(path) || /(?:^|[\/_.-])(?:init|segment|chunk|fragment|frag)(?:[\/_.-]|\d)/.test(path)) return;
  if (mime === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
  if (/mpegurl/.test(mime) || path.endsWith('.m3u8')) return 'hls';
  if (mime.startsWith('audio/')) return;
  if ((path.endsWith('.mp4') || mime === 'video/mp4') && (resourceType === 'media' || resourceType === 'xhr' || resourceType === 'other')) return 'mp4';
}

export function safeHttp(value: string | undefined): string | undefined {
  if (!value || /[\r\n\u0000]/.test(value)) return;
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch {}
}

export function safeOrigin(value: string | undefined): string | undefined {
  const url = safeHttp(value); return url ? new URL(url).origin : undefined;
}

export function cookieDomainMatches(domain: string, hostname: string): boolean {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  const host = hostname.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function cookieJar(cookies: Array<{domain: string; hostOnly?: boolean; path: string; secure: boolean; expirationDate?: number; name: string; value: string}>, hosts: string[]): string {
  const lines = ['# Netscape HTTP Cookie File', '# FrameCatch browser helper: local isolated session, domain-scoped export'];
  for (const cookie of cookies) {
    if (!hosts.some(host => cookieDomainMatches(cookie.domain, host))) continue;
    if ([cookie.domain, cookie.path, cookie.name, cookie.value].some(value => /[\t\r\n\u0000]/.test(value))) continue;
    const subdomains = cookie.hostOnly === false || cookie.domain.startsWith('.');
    const domain = subdomains && !cookie.domain.startsWith('.') ? `.${cookie.domain}` : cookie.domain;
    lines.push([domain, subdomains ? 'TRUE' : 'FALSE', cookie.path || '/', cookie.secure ? 'TRUE' : 'FALSE', cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0, cookie.name, cookie.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function privateUrlLabel(value: string): string {
  try { const url = new URL(value); const path = decodeURIComponent(url.pathname); return `${url.host}${path.length > 70 ? ' /…/' + path.split('/').at(-1)?.slice(-52) : path}`; } catch { return '媒体资源'; }
}
