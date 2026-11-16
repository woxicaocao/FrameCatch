import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { importChromeRequest } from '../electron/request-import';
import { createEngine } from '../electron/engine';

const media = 'https://media.example.test/master.m3u8?sig=a%2Fb%3D&part=1';
const referer = 'https://www.example.test/watch?id=1&autoplay=1';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const coreHeaders = `-H 'Referer: ${referer}' -H 'User-Agent: ${userAgent}'`;
const bash = (extra = '', url = media) => `curl '${url}' ${coreHeaders} ${extra}`;
const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'framecatch-request-import-'));

// Synthetic vectors produced by Chrome DevTools generateCurlCommand. Current
// cmd quotes use ^"^" for embedded "; legacy exports use ^\^" instead.
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/panels/network/NetworkLogView.ts
const cmdCurrent = [
  'curl --url ^"https://media.example.test/master.m3u8?sig=a^%^2Fb^%^3D^&part=1^" ^',
  '  -H ^"Referer: https://www.example.test/watch?id=1^&autoplay=1^" ^',
  '  -H ^"User-Agent: Mozilla/5.0 ^(Windows NT 10.0; Win64; x64^)^" ^',
  '  -H ^"sec-ch-ua: ^"^"Chromium^"^";v=^"^"152^"^"^" ^',
  '  -b ^"sid=^"^"a=b^"^"; token=opaque^%^20literal^"',
].join('\r\n');
const cmdLegacy = [
  'curl --url ^"https://media.example.test/master.m3u8?sig=a^%^2Fb^%^3D^&part=1^" ^',
  '  -H ^"Referer: https://www.example.test/watch?id=1^&autoplay=1^" ^',
  '  -H ^"User-Agent: Mozilla/5.0 ^(Windows NT 10.0; Win64; x64^)^" ^',
  String.raw`  -H ^"sec-ch-ua: ^\^"Chromium^\^";v=^\^"152^\^"^" ^`,
  String.raw`  -b ^"sid=^\^"a=b^\^"; token=opaque^%^20literal^"`,
].join('\r\n');

describe('Chrome请求文本兼容性', () => {
  it.each([['当前cmd格式', cmdCurrent], ['旧版cmd反斜杠引号格式', cmdLegacy]])('%s完整保留签名参数、浏览器标识和Cookie引号', async (_label, text) => {
    const portableRoot = await temporary();
    const result = await importChromeRequest(text, { portableRoot, proxy: '' });
    expect(result.url).toBe(media);
    expect(result.context.referer).toBe(referer);
    expect(result.context.userAgent).toBe(userAgent);
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    expect(jar).toContain('\tsid\t"a=b"\n');
    expect(jar).toContain('\ttoken\topaque%20literal\n');
    expect(jar).not.toContain('^');
  });

  it('支持bash续行、单双引号、长参数及内联Cookie，忽略其他浏览器头', async () => {
    const portableRoot = await temporary();
    const text = String.raw`curl --url='https://media.example.test/video.mp4?signature=a%2Fb%2B%3D&opaque=%2526&x=1+2' \
  --header='Referer: https://www.example.test/watch?id=1&autoplay=1' \
  --header "User-Agent: Chrome Browser/152.0" \
  --header 'Origin: https://www.example.test' \
  --header 'Range: bytes=0-100' \
  --header 'sec-ch-ua: "Chromium";v="152"' \
  --cookie='session=private-value; sign=a=b==' \
  --compressed --globoff --http2 --path-as-is`;
    const result = await importChromeRequest(text, { portableRoot, proxy: 'http://127.0.0.1:7897' });
    expect(result.url).toBe('https://media.example.test/video.mp4?signature=a%2Fb%2B%3D&opaque=%2526&x=1+2');
    expect(result.context).toMatchObject({ referer, userAgent: 'Chrome Browser/152.0', origin: 'https://www.example.test', proxy: 'http://127.0.0.1:7897' });
    expect(Object.keys(result.context).sort()).toEqual(['cookiePath', 'origin', 'proxy', 'referer', 'userAgent']);
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    expect(jar).toContain('\tsign\ta=b==\n');
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('bytes=');
  });

  it('支持bash ANSI-C引号及单引号拼接，不进行命令或环境展开', async () => {
    const portableRoot = await temporary();
    const text = String.raw`curl 'https://media.example.test/video.mp4?opaque=$HOME&literal=$(calc)' -e 'https://www.example.test/watch' -A 'Chrome Browser' -b $'name=it\'s; bang=\u0021; slash=a\\b; literal=$(calc)'`;
    const result = await importChromeRequest(text, { portableRoot, proxy: '' });
    expect(result.url).toBe('https://media.example.test/video.mp4?opaque=$HOME&literal=$(calc)');
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    expect(jar).toContain("\tname\tit's\n");
    expect(jar).toContain('\tbang\t!\n');
    expect(jar).toContain('\tslash\ta\\b\n');
    expect(jar).toContain('\tliteral\t$(calc)\n');
    const joined = await importChromeRequest(bash(String.raw`-H 'Cookie: name=it'\''s'`), { portableRoot, proxy: '' });
    expect(await fs.readFile(joined.context.cookiePath!, 'utf8')).toContain("\tname\tit's\n");
  });

  it('支持短参数紧邻取值、HEAD及GET，移除curl专用URL括号转义', async () => {
    const portableRoot = await temporary();
    const result = await importChromeRequest(String.raw`curl.exe --url 'https://media.example.test/movie.mp4?filter=\[a\]&obj=\{b\}' -e'https://www.example.test/watch' -A'Browser/1' -H'Origin:https://www.example.test' -b'name=value' -XHEAD -I -g --http1.1`, { portableRoot, proxy: '' });
    expect(result.url).toBe('https://media.example.test/movie.mp4?filter=[a]&obj={b}');
    expect(result.context.origin).toBe('https://www.example.test');
    const get = await importChromeRequest(bash('--request=GET'), { portableRoot, proxy: '' });
    expect(get.url).toBe(media);
  });

  it('不包含Cookie时不创建凭据文件，Vimeo master.json按官方映射MPD且保留签名', async () => {
    const portableRoot = await temporary();
    const result = await importChromeRequest(bash('', 'https://vod-adaptive-ak.vimeocdn.com/clip/master.json?base64_init=1&token=a%2Fb%3D'), { portableRoot, proxy: '' });
    expect(result.url).toBe('https://vod-adaptive-ak.vimeocdn.com/clip/master.mpd?base64_init=1&token=a%2Fb%3D');
    expect(result.context.cookiePath).toBeUndefined();
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });
});

describe('凭据最小范围及核心兼容性', () => {
  it('Cookie仅写入媒体精确host的会话jar，不保存原始cURL或扩散到来源域', async () => {
    const portableRoot = await temporary();
    const result = await importChromeRequest(bash("-H 'Cookie: session=super-private-value; a=b'"), { portableRoot, proxy: '' });
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    expect(jar.startsWith('# Netscape HTTP Cookie File\n')).toBe(true);
    const rows = jar.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.slice(0, 5)).toEqual(['media.example.test', 'FALSE', '/', 'TRUE', '0']);
    expect(jar).not.toContain('www.example.test');
    expect(jar).not.toContain('\n.example.test\t');
    expect(jar).not.toContain('curl ');
    expect(JSON.stringify(result)).not.toContain('super-private-value');
    const files = await fs.readdir(path.join(portableRoot, 'data', 'captures'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^request-[\w-]+\.cookies\.txt$/);

    const engine = await createEngine({ portableRoot, binDir: portableRoot, spawnProcess: () => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough(), stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, exitCode: null, pid: undefined });
      queueMicrotask(() => { stdout.end(JSON.stringify({ id: 'media', title: '视频', formats: [{ format_id: '1', vcodec: 'h264', acodec: 'aac', ext: 'mp4' }] })); stderr.end(); child.emit('close', 0); });
      return child;
    } });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: portableRoot }];
    const analysis = await engine.analyze(result.url, result.context);
    expect(analysis.entries[0].mediaContext?.cookiePath).toBe(result.context.cookiePath);
    await engine.stopAll();
  });

  it('同名Cookie值相同可去重，冲突必须拒绝且错误不泄漏值', async () => {
    const portableRoot = await temporary();
    const result = await importChromeRequest(bash("-b 'session=a' -H 'Cookie: session=a; other=b'"), { portableRoot, proxy: '' });
    const jar = await fs.readFile(result.context.cookiePath!, 'utf8');
    expect(jar.match(/\tsession\t/g)).toHaveLength(1);
    const error = await importChromeRequest(bash("-b 'session=SECRET_ONE' -H 'Cookie: session=SECRET_TWO'"), { portableRoot, proxy: '' }).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('同名');
    expect((error as Error).message).not.toContain('SECRET');
  });
});

describe('拒绝执行、任意文件读取及不完整媒体', () => {
  it.each([
    '--exec "calc"', '--config @secrets.txt', '-K secrets.txt', '-H @headers.txt', '--header=@headers.txt', '-b cookies.txt', '--cookie=@cookies.txt',
    '-X POST', '--request=PUT', '--data-raw "private body"', '--data-binary @body.bin', '-F file=@private.txt', '--form-string name=value', '--upload-file private.bin',
    '-H "Authorization: Bearer PRIVATE_AUTH"', '-H "Proxy-Authorization: Basic PRIVATE_AUTH"',
    '--output stolen.txt', '--cookie-jar stolen.txt', '--next', '--insecure', '--proxy http://localhost:1234',
  ])('拒绝不支持的参数或授权来源：%s', async extra => {
    const portableRoot = await temporary();
    const error = await importChromeRequest(bash(extra), { portableRoot, proxy: '' }).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('PRIVATE_AUTH');
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it.each([
    '; calc', '&& calc', '| calc', '> output.txt', '& curl https://second.example.test/movie.mp4', 'https://second.example.test/movie.mp4', '--url https://second.example.test/movie.mp4',
  ])('拒绝外部操作符或多请求：%s', async extra => {
    const portableRoot = await temporary();
    await expect(importChromeRequest(bash(extra), { portableRoot, proxy: '' })).rejects.toThrow();
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it.each(['clip.ts', 'video.m4s', 'audio.aac', 'audio.m4a', 'subtitles.vtt', 'init.mp4', 'init-001.mp4', 'chunk123.mp4', 'segment-0001.mp4', 'frag_22.mp4', 'segment/123.mp4'])('拒绝分片资源%s并明确指引选择清单', async suffix => {
    const portableRoot = await temporary();
    await expect(importChromeRequest(bash('', `https://media.example.test/${suffix}`), { portableRoot, proxy: '' })).rejects.toThrow('master.m3u8');
  });

  it('无后缀媒体URL仍交给引擎判断；缺UA或Referer给出明确指引', async () => {
    const portableRoot = await temporary();
    expect((await importChromeRequest(bash('', 'https://media.example.test/stream?id=123'), { portableRoot, proxy: '' })).url).toBe('https://media.example.test/stream?id=123');
    await expect(importChromeRequest(`curl '${media}' -A 'Browser/1'`, { portableRoot, proxy: '' })).rejects.toThrow('缺少来源页面或浏览器标识');
    await expect(importChromeRequest(`curl '${media}' -e '${referer}'`, { portableRoot, proxy: '' })).rejects.toThrow('缺少来源页面或浏览器标识');
  });

  it.each([
    "-H $'Cookie: session=a\\r\\nInjected: value'", "-H $'User-Agent: Browser\\u0000'", "-H $'X-Custom: foo\\tbar'", "-b $'session=a\\n'",
  ])('拒绝引用解码后的控制字符：%s', async extra => {
    const portableRoot = await temporary();
    await expect(importChromeRequest(bash(extra), { portableRoot, proxy: '' })).rejects.toThrow();
    expect(await fs.readdir(portableRoot)).toEqual([]);
  });

  it('输入类型、大小、引号、协议和原始控制字符均严格校验', async () => {
    const portableRoot = await temporary();
    for (const input of [null, 123, '', 'x'.repeat(512 * 1024 + 1), '中'.repeat(200000), `curl '${media} ${coreHeaders}`, bash('', 'file:///C:/private.mp4'), bash('\u0000')]) await expect(importChromeRequest(input, { portableRoot, proxy: '' })).rejects.toThrow();
    await expect(importChromeRequest(bash(), { portableRoot, proxy: 'ftp://localhost:21' })).rejects.toThrow();
  });
});
