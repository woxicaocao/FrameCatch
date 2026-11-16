import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaContext } from '../shared/types';
import { isPathInside, validateMediaContext, validateProxy, validateUrl } from './engine-helpers';
import { cookieJar, normalizeCapturedMediaUrl } from './browser-helper-utils';
import { assertCompleteMediaResource } from './media-resource';

interface ImportedFields { url: string; referer: string; userAgent: string; origin?: string; cookies: Array<{ name: string; value: string }>; }
const tokenName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const invalidHeaderControl = /[\u0000-\u001f\u007f]/;

function badSyntax(): never { throw new Error('无法识别这段请求文本，请从 Chrome 网络面板复制单条视频请求的 cURL（bash 或 cmd）格式。'); }
function shellOperator(): never { throw new Error('只能导入单条视频请求，不能包含管道、重定向、命令连接或其他脚本。'); }

/** POSIX quoting is decoded as data. No interpolation, eval, shell, expansion,
 * environment lookup, file inclusion, or command substitution takes place. */
function bashTokens(text: string): string[] {
  const result: string[] = [];
  let value = '', started = false, quote: 'single' | 'double' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === 'single') {
      if (c === "'") quote = undefined; else value += c;
      continue;
    }
    if (quote === 'double') {
      if (c === '"') { quote = undefined; continue; }
      if (c === '$' || c === '`') shellOperator();
      if (c === '\\') {
        const next = text[++i];
        if (next === undefined) badSyntax();
        if (next === '\n') continue;
        if (next === '\r' && text[i + 1] === '\n') { i++; continue; }
        value += ['$', '`', '"', '\\'].includes(next) ? next : `\\${next}`;
      } else value += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) { result.push(value); value = ''; started = false; }
      continue;
    }
    if (c === "'") { started = true; quote = 'single'; continue; }
    if (c === '"') { started = true; quote = 'double'; continue; }
    if (c === '$' && text[i + 1] === "'") {
      started = true; i += 2;
      let closed = false;
      for (; i < text.length; i++) {
        if (text[i] === "'") { closed = true; break; }
        if (text[i] !== '\\') { value += text[i]; continue; }
        const escape = text[++i];
        if (!escape) badSyntax();
        const simple: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t', a: '\u0007', b: '\b', f: '\f', v: '\v', e: '\u001b' };
        if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
        if (escape === 'u' || escape === 'U') {
          const length = escape === 'u' ? 4 : 8;
          const hex = text.slice(i + 1, i + 1 + length);
          if (hex.length !== length || !/^[a-f\d]+$/i.test(hex)) badSyntax();
          const point = parseInt(hex, 16);
          if (point > 0x10ffff) badSyntax();
          value += String.fromCodePoint(point); i += length; continue;
        }
        if (escape === 'x') {
          const hex = /^[a-f\d]{1,2}/i.exec(text.slice(i + 1))?.[0];
          if (!hex) badSyntax();
          value += String.fromCharCode(parseInt(hex, 16)); i += hex.length; continue;
        }
        badSyntax();
      }
      if (!closed) badSyntax();
      continue;
    }
    if (c === '$' || c === '`' || /[;&|<>()]/.test(c)) shellOperator();
    if (c === '\\') {
      const next = text[++i];
      if (next === undefined) badSyntax();
      if (next === '\n') continue;
      if (next === '\r' && text[i + 1] === '\n') { i++; continue; }
      started = true; value += next;
    } else { started = true; value += c; }
  }
  if (quote) badSyntax();
  if (started) result.push(value);
  return result;
}

/** Chrome's cmd export has two encoding layers: caret escapes for cmd, then
 * MS C runtime quoted argv. Current exports double literal quotes; older ones
 * use backslash quotes. Both are decoded in memory without running cmd.exe. */
function windowsTokens(text: string): string[] {
  let decoded = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '^') { decoded += text[i]; continue; }
    const next = text[++i];
    if (next === undefined) badSyntax();
    if (next === '\n') continue;
    if (next === '\r' && text[i + 1] === '\n') { i++; continue; }
    decoded += next;
  }
  const result: string[] = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded[i];
    if (!quoted && /\s/.test(c)) {
      if (started) { result.push(value); value = ''; started = false; }
      continue;
    }
    if (!quoted && /[;&|<>()`]/.test(c)) shellOperator();
    started = true;
    if (c === '\\') {
      let count = 1;
      while (decoded[i + count] === '\\') count++;
      if (decoded[i + count] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        i += count;
        if (count % 2) value += '"';
        else if (quoted && decoded[i + 1] === '"') { value += '"'; i++; }
        else quoted = !quoted;
      } else { value += '\\'.repeat(count); i += count - 1; }
    } else if (c === '"') {
      if (quoted && decoded[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else value += c;
  }
  if (quoted) badSyntax();
  if (started) result.push(value);
  return result;
}

function parseCookies(value: string): Array<{ name: string; value: string }> {
  if (invalidHeaderControl.test(value)) throw new Error('请求凭据包含不支持的控制字符，无法导入。');
  if (!value.trim()) return [];
  if (value.startsWith('@') || !value.includes('=')) throw new Error('仅支持请求中直接携带的 Cookie，不支持读取 Cookie 文件。请完整复制视频媒体请求。');
  const result = new Map<string, string>();
  for (const part of value.split(';')) {
    if (!part.trim()) continue;
    const pair = part.trim(), separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('请求中的 Cookie 格式不完整，请重新复制视频媒体请求。');
    const name = pair.slice(0, separator).trim(), cookieValue = pair.slice(separator + 1).trim();
    if (!tokenName.test(name)) throw new Error('请求中的 Cookie 名称无效，无法导入。');
    if (result.has(name) && result.get(name) !== cookieValue) throw new Error('请求中存在同名但内容不同的 Cookie，无法准确恢复；请重新复制单条媒体请求。');
    result.set(name, cookieValue);
  }
  return [...result].map(([name, cookieValue]) => ({ name, value: cookieValue }));
}

function parseArguments(tokens: string[]): ImportedFields {
  if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0])) badSyntax();
  const headers = new Map<string, string>();
  const cookieValues: string[] = [];
  let rawUrl: string | undefined;
  let method: string | undefined;
  const putUrl = (value: string) => { if (rawUrl !== undefined) throw new Error('一次只能导入一个视频请求，请不要使用“复制全部请求”。'); rawUrl = value; };
  const putHeader = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (invalidHeaderControl.test(name) || invalidHeaderControl.test(value) || !tokenName.test(name)) throw new Error('请求头包含无效字符或换行，无法导入。');
    if (lower === 'authorization' || lower === 'proxy-authorization') throw new Error('该请求包含暂不支持的授权头，请选择实际的视频清单或 MP4 媒体请求，而不是登录或接口请求。');
    if (lower === 'cookie') { cookieValues.push(value); return; }
    if (!['referer', 'user-agent', 'origin'].includes(lower)) return;
    const previous = headers.get(lower);
    if (previous !== undefined && previous !== value) throw new Error('请求中有互相冲突的来源或浏览器信息，请重新复制单条媒体请求。');
    headers.set(lower, value);
  };
  const putMethod = (value: string) => {
    const selected = value.toUpperCase();
    if (!['GET', 'HEAD'].includes(selected)) throw new Error('只支持视频资源的 GET 或 HEAD 请求，请不要复制提交表单、登录或上传请求。');
    if (method && method !== selected) throw new Error('请求方法互相冲突，请重新复制视频媒体请求。');
    method = selected;
  };
  const switches = new Set(['--compressed', '--globoff', '-g', '--http1.1', '--http2', '--path-as-is']);
  const optionNames = new Map([['--url', 'url'], ['--header', 'header'], ['--cookie', 'cookie'], ['--user-agent', 'ua'], ['--referer', 'referer'], ['--request', 'method']]);
  const shortNames = new Map([['H', 'header'], ['b', 'cookie'], ['A', 'ua'], ['e', 'referer'], ['X', 'method']]);
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (switches.has(token)) continue;
    if (token === '-I' || token === '--head') { putMethod('HEAD'); continue; }
    if (/^(?:--data(?:[=-]|$)|--form(?:[=-]|$)|--json(?:=|$)|--upload-file(?:=|$)|-[dFT])/.test(token)) throw new Error('不支持带请求正文、表单或上传内容的命令，请复制视频清单或 MP4 的 GET 请求。');
    let kind: string | undefined, value: string | undefined;
    if (token.startsWith('--')) {
      const equal = token.indexOf('=');
      const name = equal < 0 ? token : token.slice(0, equal);
      kind = optionNames.get(name);
      if (!kind) throw new Error('这段文本含有暂不支持的 cURL 参数，请只复制单条视频媒体请求。');
      value = equal < 0 ? tokens[++i] : token.slice(equal + 1);
    } else if (/^-[HbAeX]/.test(token)) {
      kind = shortNames.get(token[1]);
      value = token.length === 2 ? tokens[++i] : token.slice(2);
    } else if (token.startsWith('-')) throw new Error('这段文本含有暂不支持的 cURL 参数，请只复制单条视频媒体请求。');
    else { putUrl(token); continue; }
    if (value === undefined || value.startsWith('@')) throw new Error('请求参数缺失或包含文件引用，软件不会读取命令中指定的文件。');
    if (kind === 'url') putUrl(value);
    else if (kind === 'cookie') cookieValues.push(value);
    else if (kind === 'ua') putHeader('User-Agent', value);
    else if (kind === 'referer') putHeader('Referer', value);
    else if (kind === 'method') putMethod(value);
    else if (kind === 'header') {
      if (invalidHeaderControl.test(value)) throw new Error('请求头包含无效字符或换行，无法导入。');
      const colon = value.indexOf(':');
      if (colon > 0) putHeader(value.slice(0, colon).trim(), value.slice(colon + 1).trim());
      else if (value.endsWith(';')) putHeader(value.slice(0, -1).trim(), '');
      else throw new Error('请求头格式不完整，请从 Chrome 重新复制视频媒体请求。');
    }
  }
  if (!rawUrl) throw new Error('这段请求没有视频网址，请重新复制单条媒体请求。');
  if (invalidHeaderControl.test(rawUrl)) throw new Error('视频网址包含无效控制字符，请重新复制媒体请求。');
  // DevTools escapes curl URL-globbing brackets after shell quoting. Undo only
  // these four curl-specific escapes; never decode URI escapes or signed queries.
  const url = validateUrl(rawUrl.replace(/\\([\[\]{}])/g, '$1'));
  const resourcePath = new URL(url).pathname.toLowerCase();
  const basename = resourcePath.split('/').at(-1) || '';
  if (/\.(?:m4s|ts|aac|mp3|m4a|vtt|srt|key)$/.test(resourcePath) || (/\.mp4$/.test(basename) && (/(?:^|[_.-])init(?:[_.-]|\d)/.test(basename) || /(?:^|[\/_.-])(?:segment|chunk|fragment|frag)[\/_.-]*\d/.test(resourcePath)))) throw new Error('这条请求是视频分片、初始化文件或音频资源，请选择 master.m3u8、MPD 清单或完整 MP4 请求。');
  assertCompleteMediaResource(url);
  const referer = headers.get('referer'), userAgent = headers.get('user-agent');
  if (!referer || !userAgent) throw new Error('请求中缺少来源页面或浏览器标识，请在 Chrome 网络面板中完整复制视频清单或 MP4 的 cURL 请求。');
  const origin = headers.get('origin') || undefined;
  const context = validateMediaContext({ referer, userAgent, origin, proxy: '' });
  const cookies = new Map<string, string>();
  for (const raw of cookieValues) for (const cookie of parseCookies(raw)) {
    if (cookies.has(cookie.name) && cookies.get(cookie.name) !== cookie.value) throw new Error('请求中存在同名但内容不同的 Cookie，无法准确恢复；请重新复制单条媒体请求。');
    cookies.set(cookie.name, cookie.value);
  }
  return { url: normalizeCapturedMediaUrl(url), referer: context.referer, userAgent: context.userAgent, origin: context.origin, cookies: [...cookies].map(([name, value]) => ({ name, value })) };
}

function parseText(text: string): ImportedFields {
  const results: ImportedFields[] = [], errors: Error[] = [];
  const parsers = /\^"|\^\r?\n/.test(text) ? [windowsTokens, bashTokens] : [bashTokens, windowsTokens];
  for (const tokenize of parsers) {
    try { results.push(parseArguments(tokenize(text))); }
    catch (error) { errors.push(error instanceof Error ? error : new Error('请求文本无法识别。')); }
  }
  if (!results.length) throw errors[0] || new Error('请求文本无法识别。');
  if (results.length > 1 && JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new Error('这段命令的转义格式不明确，请在 Chrome 中选择“复制为 cURL（bash）”后重新导入。');
  return results[0];
}

export async function importChromeRequest(text: unknown, options: { portableRoot: string; proxy: string }): Promise<{ url: string; context: MediaContext }> {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error('请粘贴单条 Chrome 视频请求，文本大小不能超过 512 KB。');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('请求文本包含不支持的控制字符，无法导入。');
  if (!options || typeof options.portableRoot !== 'string' || !path.isAbsolute(options.portableRoot) || invalidHeaderControl.test(options.portableRoot)) throw new Error('软件的便携数据目录无效。');
  const proxy = validateProxy(options.proxy);
  const parsed = parseText(text.trim());
  const context: MediaContext = { referer: parsed.referer, userAgent: parsed.userAgent, proxy, ...(parsed.origin ? { origin: parsed.origin } : {}) };
  if (parsed.cookies.length) {
    const root = path.resolve(options.portableRoot);
    const realRoot = await fs.realpath(root);
    const data = path.join(root, 'data');
    await fs.mkdir(data, { recursive: true });
    if (!isPathInside(path.join(realRoot, 'data'), await fs.realpath(data))) throw new Error('软件数据目录指向外部位置，无法保存请求凭据。');
    const directory = path.join(data, 'captures');
    await fs.mkdir(directory, { recursive: true });
    if (!isPathInside(path.join(realRoot, 'data', 'captures'), await fs.realpath(directory))) throw new Error('请求凭据目录指向外部位置，无法保存。');
    const resource = new URL(parsed.url);
    // A copied Cookie header does not contain browser Domain/Path metadata.
    // Never invent parent-domain scope: export host-only cookies for this exact
    // media host. Redirects or other CDN hosts will not receive those secrets.
    const contents = cookieJar(parsed.cookies.map(cookie => ({ domain: resource.hostname, hostOnly: true, path: '/', secure: resource.protocol === 'https:', expirationDate: 0, ...cookie })), [resource.hostname]);
    const cookiePath = path.join(directory, `request-${randomUUID()}.cookies.txt`);
    try { await fs.writeFile(cookiePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('无法在软件数据目录保存请求凭据，请检查目录权限和磁盘空间。'); }
    context.cookiePath = cookiePath;
  }
  return { url: parsed.url, context };
}
