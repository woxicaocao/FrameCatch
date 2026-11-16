import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaContext } from '../shared/types';
import { isPathInside, validateMediaContext, validateProxy, validateUrl } from './engine-helpers';
import { cookieJar, mediaKind, normalizeCapturedMediaUrl } from './browser-helper-utils';
import { assertCompleteMediaResource, isVimeoPlaylistUrl } from './media-resource';

/** A single media request observed by the paired browser extension. Never accept
 * arbitrary headers, commands, paths, account APIs or a client-selected proxy. */
export interface ExtensionCapturePayload {
  url: string;
  pageUrl: string;
  title?: string;
  userAgent: string;
  referer?: string;
  origin?: string;
  cookieHeader?: string;
  contentType?: string;
}

const fields = new Set(['url', 'pageUrl', 'title', 'userAgent', 'referer', 'origin', 'cookieHeader', 'contentType']);
const control = /[\u0000-\u001f\u007f]/;
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function cookiesFromHeader(value: string): Array<{ name: string; value: string }> {
  if (Buffer.byteLength(value, 'utf8') > 64 * 1024 || control.test(value)) throw new Error('视频请求凭据格式无效，请重新播放后发送。');
  const cookies = new Map<string, string>();
  for (const raw of value.split(';')) {
    const pair = raw.trim();
    if (!pair) continue;
    const equal = pair.indexOf('=');
    if (equal <= 0) throw new Error('视频请求凭据格式无效，请重新播放后发送。');
    const name = pair.slice(0, equal).trim();
    const content = pair.slice(equal + 1).trim();
    if (!cookieName.test(name) || (cookies.has(name) && cookies.get(name) !== content)) throw new Error('视频请求凭据冲突，请重新播放后发送。');
    cookies.set(name, content);
  }
  return [...cookies].map(([name, value]) => ({ name, value }));
}

/** Validate synchronously before an HTTP capture is acknowledged. Errors are
 * intentionally independent of input values, so secrets cannot enter logs/UI. */
export function validateExtensionCapture(value: unknown): ExtensionCapturePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('插件发送的视频信息无效。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.has(key))) throw new Error('插件发送了不支持的字段，请更新插件并重新捕获。');
  for (const key of fields) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || control.test(input[key] as string))) throw new Error('插件发送的视频信息包含无效字符。');
  }
  const url = normalizeCapturedMediaUrl(validateUrl(input.url));
  assertCompleteMediaResource(url);
  const pageUrl = validateUrl(input.pageUrl);
  const referer = input.referer === undefined || input.referer === '' ? pageUrl : validateUrl(input.referer);
  const context = validateMediaContext({ referer, userAgent: input.userAgent, origin: input.origin, proxy: '' });
  if (input.title !== undefined && (input.title as string).length > 512) throw new Error('作品标题过长，请重新捕获。');
  if (input.contentType !== undefined && (input.contentType as string).length > 256) throw new Error('视频类型信息无效。');
  const contentType = (input.contentType as string | undefined)?.trim();
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\.(?:m4a|m4s|ts|aac|mp3|vtt|srt|key)$/.test(pathname) || (!isVimeoPlaylistUrl(url) && !mediaKind(url, contentType || '', 'media'))) throw new Error('请发送完整的 MP4、HLS/DASH 总清单或 Vimeo 播放清单，不能发送分片、初始化文件或纯音频。');
  if (input.cookieHeader !== undefined) cookiesFromHeader(input.cookieHeader as string);
  return {
    url, pageUrl, userAgent: context.userAgent, referer: context.referer,
    ...(context.origin ? { origin: context.origin } : {}),
    ...(input.title ? { title: (input.title as string).trim() } : {}),
    ...(input.cookieHeader ? { cookieHeader: input.cookieHeader as string } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

export async function importExtensionCapture(value: unknown, options: { portableRoot: string; proxy: string }): Promise<{ url: string; context: MediaContext; title?: string }> {
  const parsed = validateExtensionCapture(value);
  if (!options || typeof options.portableRoot !== 'string' || !path.isAbsolute(options.portableRoot) || control.test(options.portableRoot)) throw new Error('软件的便携数据目录无效。');
  const proxy = validateProxy(options.proxy);
  const context: MediaContext = { referer: parsed.referer!, userAgent: parsed.userAgent, proxy, ...(parsed.origin ? { origin: parsed.origin } : {}) };
  const cookies = cookiesFromHeader(parsed.cookieHeader || '');
  if (cookies.length) {
    const root = path.resolve(options.portableRoot);
    const realRoot = await fs.realpath(root);
    const data = path.join(root, 'data');
    await fs.mkdir(data, { recursive: true });
    if (!isPathInside(path.join(realRoot, 'data'), await fs.realpath(data))) throw new Error('软件数据目录指向外部位置，无法保存请求凭据。');
    const directory = path.join(data, 'captures');
    await fs.mkdir(directory, { recursive: true });
    if (!isPathInside(path.join(realRoot, 'data', 'captures'), await fs.realpath(directory))) throw new Error('请求凭据目录指向外部位置，无法保存。');
    const resource = new URL(parsed.url);
    // Header cookies have no browser Domain/Path metadata. Limit every cookie
    // to this exact media host; never turn page login cookies into global headers.
    const contents = cookieJar(cookies.map(cookie => ({ domain: resource.hostname, hostOnly: true, path: '/', secure: resource.protocol === 'https:', expirationDate: 0, ...cookie })), [resource.hostname]);
    const cookiePath = path.join(directory, `extension-${randomUUID()}.cookies.txt`);
    try { await fs.writeFile(cookiePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('无法在软件数据目录保存请求凭据，请检查目录权限和磁盘空间。'); }
    context.cookiePath = cookiePath;
  }
  return { url: parsed.url, context, ...(parsed.title ? { title: parsed.title } : {}) };
}
