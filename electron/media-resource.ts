export type MediaResourceIssue = 'byte-range' | 'fragment' | 'audio';

export function isVimeoPlaylistUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && /(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/i.test(url.hostname) && url.pathname.toLowerCase().endsWith('/playlist.json');
  } catch { return false; }
}

/** A media-looking filename can still identify just one transport fragment.
 * Never remove signed range/path parameters to guess a complete resource. */
export function mediaResourceIssue(value: string): MediaResourceIssue | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  let pathname = url.pathname.toLowerCase();
  try { pathname = decodeURIComponent(pathname); } catch {}
  const vimeo = /(?:^|\.)(?:vimeocdn\.com|akamaized\.net)$/i.test(url.hostname);
  if (vimeo && /\/v2\/range\//.test(pathname)) return 'byte-range';
  for (const [key, range] of url.searchParams) {
    if (key.toLowerCase() === 'range' && /^(?:bytes=)?\d+-\d*$/i.test(range.trim())) return 'byte-range';
  }
  if (/\.(?:m4s|ts)$/.test(pathname) || /(?:^|[\/_.-])(?:init|segment|chunk|fragment|frag)(?:[\/_.-]|\d|$)/.test(pathname)) return 'fragment';
  if (/\.(?:m4a|aac|mp3)$/.test(pathname) || /(?:^|\/)audio(?:\/|[_.-])/.test(pathname)) return 'audio';
}

export function assertCompleteMediaResource(value: string): void {
  const issue = mediaResourceIssue(value);
  if (issue === 'byte-range' || issue === 'fragment') throw new Error('这是视频传输片段或局部字节区间，不是完整视频。请在 Chrome 开启检测后刷新，从开头播放并发送 HLS/DASH 总清单或 Vimeo 播放清单。已有文件会保留。');
  if (issue === 'audio') throw new Error('这是独立音轨，不能作为完整视频下载。请重新捕获包含视频与音频的总清单。');
}
