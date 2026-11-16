export interface ShareLink { platform: 'douyin' | 'wechat-channels'; url: string; }

/** Share captions are data. Extract one supported link without evaluating the
 * caption, invoking a shell, decoding a command, or rounding numeric video IDs. */
export function normalizeShareLink(value: unknown): ShareLink {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw new Error('请粘贴一条抖音或视频号的分享口令、完整分享文案或链接。');
  }
  const text = value.replace(/https?\\?:\\?\/\\?\//gi, token => token.replace(/\\/g, ''));
  const candidates = text.match(/https?:\/\/[^\s<>"'`()[\]{}\\“”‘’（）《》【】]+/gi) || [];
  const found = new Map<string, ShareLink>();
  let unsupported = false;
  for (const candidate of candidates) {
    let url: URL;
    try { url = new URL(candidate.replace(/[.,。，、；;！!？?]+$/u, '')); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if (!['douyin.com', 'www.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'weixin.qq.com'].includes(host)) { unsupported = true; continue; }
    if (url.username || url.password || url.port || url.href.length > 8192) throw new Error('分享网址格式无效，请重新复制平台提供的完整链接。');
    url.protocol = 'https:'; url.hash = '';
    let item: ShareLink;
    if (host === 'weixin.qq.com') {
      const match = /^\/sph\/([A-Za-z0-9_-]{2,128})\/?$/.exec(url.pathname);
      if (!match) throw new Error('请复制视频号作品的 weixin.qq.com/sph/ 分享链接；暂不支持公众号文章或账号主页。');
      item = { platform: 'wechat-channels', url: `https://weixin.qq.com/sph/${match[1]}${url.search}` };
    } else if (host === 'v.douyin.com') {
      if (!/^\/[A-Za-z0-9_-]{2,80}\/?$/.test(url.pathname)) throw new Error('抖音短链接不完整，请重新复制分享口令。');
      item = { platform: 'douyin', url: url.href };
    } else {
      const ids = url.searchParams.getAll('modal_id');
      const pathId = /^(?:\/video\/|\/share\/video\/)([1-9]\d{7,23})\/?$/.exec(url.pathname)?.[1];
      if (ids.length > 1 || (ids.length && !/^[1-9]\d{7,23}$/.test(ids[0])) || (pathId && ids.length && pathId !== ids[0])) throw new Error('网址中的抖音作品编号不明确，请每次复制一条作品链接。');
      const id = pathId || ids[0];
      if (!id) throw new Error('请复制单条抖音视频的分享链接，暂不支持账号主页、图集或直播。');
      item = { platform: 'douyin', url: `https://www.douyin.com/video/${id}` };
    }
    found.set(`${item.platform}:${item.url}`, item);
  }
  if (!found.size) throw new Error(unsupported ? '这个标签页仅接收抖音和视频号作品；其他网站请使用下载工作台。' : '分享内容中没有找到网址，请复制包含链接的完整分享口令。');
  if (found.size > 1) throw new Error('检测到多条不同的作品链接，请每次粘贴一条作品。');
  return [...found.values()][0];
}
