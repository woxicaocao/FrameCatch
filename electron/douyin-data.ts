import { validateUrl } from './engine-helpers';

export interface DouyinVideoData { id: string; title: string; url: string; duration?: number; width?: number; height?: number; uploader?: string; thumbnail?: string; }
const controls = /[\u0000-\u001f\u007f]/;

export function douyinVideoId(value: string): string {
  const url = new URL(validateUrl(value));
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname)) throw new Error('请使用抖音的独立视频地址。');
  const match = /^\/video\/(\d{10,24})\/?$/.exec(url.pathname);
  if (!match) throw new Error('请先识别抖音分享链接对应的独立视频地址。');
  return match[1];
}

function positive(value: unknown, limit: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= limit ? value : undefined;
}
function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || controls.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !/(?:^|\.)(?:douyinvod\.com|douyin\.com)$/i.test(url.hostname)) return;
    // DASH audio/video URLs are separate tracks. A video-looking HTTP response
    // alone cannot be labelled a complete clip or silently omit its sound.
    if (/\/(?:media-video|media-audio)[/-]/i.test(url.pathname) || url.searchParams.has('range') || /\.(?:m4s|ts|m4a|aac)$/i.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}

/** Only the public detail response for the exact requested work is accepted.
 * No eval, player internals, arbitrary request options or signed URL rewriting. */
export function parseDouyinDetail(value: unknown, expectedId: string): DouyinVideoData | undefined {
  if (!/^\d{10,24}$/.test(expectedId) || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, any>;
  const detail = input.aweme_detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail) || detail.aweme_id !== expectedId || detail.is_live || detail.live_status) return;
  const video = detail.video;
  if (!video || typeof video !== 'object' || !Array.isArray(video.bit_rate) || video.bit_rate.length > 128) return;
  const candidates: Array<{url: string; width?: number; height?: number; bitrate: number}> = [];
  for (const track of video.bit_rate) {
    if (!track || typeof track !== 'object' || track.format !== 'mp4' || !track.play_addr || typeof track.play_addr !== 'object') continue;
    const address = track.play_addr;
    if (!Array.isArray(address.url_list) || address.url_list.length > 16) continue;
    const url = address.url_list.map(mediaUrl).find((candidate: unknown): candidate is string => typeof candidate === 'string');
    if (!url) continue;
    candidates.push({ url, width: positive(address.width, 32768), height: positive(address.height, 32768), bitrate: positive(track.bit_rate, 10 ** 10) || 0 });
  }
  candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)) || b.bitrate - a.bitrate);
  const selected = candidates[0];
  if (!selected) return;
  const title = typeof detail.desc === 'string' ? detail.desc.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 600) : '';
  const durationMs = positive(video.duration, 7 * 24 * 60 * 60 * 1000);
  const uploader = typeof detail.author?.nickname === 'string' ? detail.author.nickname.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : undefined;
  let thumbnail: string | undefined;
  for (const value of Array.isArray(video.cover?.url_list) ? video.cover.url_list.slice(0, 8) : []) {
    try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && value.length <= 8192 && !controls.test(value)) { thumbnail = url.href; break; } } catch {}
  }
  return { id: expectedId, title: title || `抖音视频 ${expectedId}`, url: selected.url,
    ...(durationMs ? { duration: durationMs / 1000 } : {}), ...(selected.width ? { width: selected.width } : {}), ...(selected.height ? { height: selected.height } : {}), ...(uploader ? { uploader } : {}), ...(thumbnail ? { thumbnail } : {}) };
}
