import { request as httpRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionBridge, FRAMECATCH_EXTENSION_ID } from '../electron/extension-bridge';

const origin = `chrome-extension://${FRAMECATCH_EXTENSION_ID}`;
const bridges: ReturnType<typeof createExtensionBridge>[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
function bridge(callback = async (_payload: unknown): Promise<void> => {}, port = 0) {
  const instance = createExtensionBridge({ allowedExtensionId: FRAMECATCH_EXTENSION_ID, onCapture: callback, port });
  bridges.push(instance); return instance;
}
function send(port: number, route: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: unknown; raw?: string } = {}): Promise<{ status: number; headers: Record<string, unknown>; body: any }> {
  const raw = options.raw ?? (options.body === undefined ? (route === '/v1/status' && options.method !== 'GET' ? '{}' : undefined) : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: route, method: options.method || (raw === undefined ? 'GET' : 'POST'),
      headers: { Origin: origin, ...(raw === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }), ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode!, headers: response.headers, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.once('error', reject); req.end(raw);
  });
}
async function pair(instance: ReturnType<typeof createExtensionBridge>) {
  const status = await instance.start();
  expect(status.running).toBe(true);
  expect(status.pairingCode).toMatch(/^[A-F0-9]{8}$/);
  const response = await send(status.port, '/v1/pair', { body: { code: status.pairingCode } });
  expect(response.status).toBe(200);
  expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { port: status.port, token: response.body.token as string };
}
const payload = () => ({ url: 'https://media.example.test/movie.mp4?token=PRIVATE_SIGNED', pageUrl: 'https://www.example.test/project/1', userAgent: 'Extension-Test/1', cookieHeader: 'session=PRIVATE_COOKIE', title: '测试作品' });

describe('本机浏览器扩展桥接', () => {
  it('只监听IPv4环回，配对后HTTP状态不含配对码/令牌/媒体或凭据', async () => {
    const instance = bridge();
    const initial = instance.getStatus();
    expect(initial).toEqual({ running: false, port: 0, paired: false });
    const { port, token } = await pair(instance);
    expect(instance.getStatus()).toEqual({ running: true, port, paired: true });
    const response = await send(port, '/v1/status', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, paired: true, capture: { status: 'idle' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it.each([
    { Origin: 'https://evil.example.test' }, { Origin: 'null' }, { Origin: `chrome-extension://${'b'.repeat(32)}` },
    { Host: 'evil.example.test' }, { Host: 'localhost:46783' }, { Host: '127.0.0.1:1' },
  ])('拒绝未知来源、DNS重绑定或别名 %j', async headers => {
    const instance = bridge(); const status = await instance.start();
    const response = await send(status.port, '/v1/pair', { body: { code: status.pairingCode }, headers });
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(instance.getStatus().paired).toBe(false);
  });

  it('预检只允许固定扩展、精确路径、方法及受支持请求头', async () => {
    const instance = bridge(); const status = await instance.start();
    const options = { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } };
    expect((await send(status.port, '/v1/capture', options)).status).toBe(204);
    expect((await send(status.port, '/v1/status', { ...options, headers: { ...options.headers, 'Access-Control-Request-Method': 'GET' } })).status).toBe(403);
    expect((await send(status.port, '/v1/capture', { ...options, headers: { ...options.headers, 'Access-Control-Request-Headers': 'x-arbitrary' } })).status).toBe(403);
    expect((await send(status.port, '/v1/capture?token=SECRET', options)).status).toBe(404);
  });

  it('未配对、错误令牌、错误路径及请求方式均不调用捕获', async () => {
    const callback = vi.fn(async () => {}); const instance = bridge(callback); const status = await instance.start();
    expect((await send(status.port, '/v1/status')).status).toBe(401);
    expect((await send(status.port, '/v1/capture', { body: payload() })).status).toBe(401);
    expect((await send(status.port, '/v1/capture', { body: payload(), headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status).toBe(401);
    expect((await send(status.port, '/v1/status', { method: 'GET' })).status).toBe(405);
    const originlessGet = await send(status.port, '/v1/status', { method: 'GET', headers: { Origin: '' } });
    expect(originlessGet.status).toBe(405);
    expect(originlessGet.headers['access-control-allow-origin']).toBeUndefined();
    expect((await send(status.port, '/v1/status', { body: {}, headers: { Origin: '' } })).status).toBe(403);
    expect((await send(status.port, '/arbitrary', { body: payload() })).status).toBe(404);
    expect(callback).not.toHaveBeenCalled();
  });

  it('配对码五分钟有效，错误尝试限速；单码只可换一个令牌', async () => {
    const instance = bridge(); const status = await instance.start();
    for (let i = 0; i < 5; i++) expect((await send(status.port, '/v1/pair', { body: { code: 'WRONG' } })).status).toBe(401);
    expect((await send(status.port, '/v1/pair', { body: { code: status.pairingCode } })).status).toBe(429);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const result = await send(status.port, '/v1/pair', { body: { code: status.pairingCode } });
    expect(result.status).toBe(200);
    expect((await send(status.port, '/v1/pair', { body: { code: status.pairingCode } })).status).toBe(401);
    vi.restoreAllMocks();
    const expired = bridge(); const expiredStatus = await expired.start();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);
    expect((await send(expiredStatus.port, '/v1/pair', { body: { code: expiredStatus.pairingCode } })).status).toBe(401);
    expect(expired.getStatus().pairingCode).toBeUndefined();
  });

  it('捕获立即202回执，异步分析时拒绝重复，不向扩展返回私有结果', async () => {
    let finish!: () => void;
    const callback = vi.fn((_payload: unknown) => new Promise<void>(resolve => { finish = resolve; }));
    const instance = bridge(callback); const { port, token } = await pair(instance);
    const headers = { Authorization: `Bearer ${token}` };
    const response = await send(port, '/v1/capture', { body: payload(), headers });
    expect(response.status).toBe(202); expect(response.body).toEqual({ ok: true, accepted: true, message: '已发送到映取，请选择画质并下载' });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback.mock.calls[0][0]).toEqual({ ...payload(), referer: payload().pageUrl });
    expect((await send(port, '/v1/status', { headers })).body.capture.status).toBe('analyzing');
    expect((await send(port, '/v1/capture', { body: payload(), headers })).status).toBe(409);
    finish();
    await vi.waitFor(async () => expect((await send(port, '/v1/status', { headers })).body.capture.status).toBe('completed'));
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|cookiePath|example\.test/);
  });

  it('异步错误只回固定提示，stop使旧token和未完成callback失效', async () => {
    let fail!: (error: Error) => void;
    const callback = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const instance = bridge(callback); const { port, token } = await pair(instance);
    await send(port, '/v1/capture', { body: payload(), headers: { Authorization: `Bearer ${token}` } });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    fail(new Error('PRIVATE_COOKIE C:\\private.cookies.txt https://private.example.test/?token=PRIVATE_SIGNED'));
    await vi.waitFor(async () => expect((await send(port, '/v1/status', { headers: { Authorization: `Bearer ${token}` } })).body.capture.status).toBe('failed'));
    const failure = await send(port, '/v1/status', { headers: { Authorization: `Bearer ${token}` } });
    expect(JSON.stringify(failure.body)).not.toMatch(/PRIVATE|cookies\.txt|example\.test/);
    await instance.stop();
    expect(instance.getStatus().paired).toBe(false);
    const restarted = await instance.start();
    expect((await send(restarted.port, '/v1/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    const paired = await send(restarted.port, '/v1/pair', { body: { code: restarted.pairingCode } });
    expect((await send(restarted.port, '/v1/status', { headers: { Authorization: `Bearer ${paired.body.token}` } })).body.capture.status).toBe('idle');
  });

  it('格式、body上限与未知字段在捕获回调之前拒绝，不产生外部操作', async () => {
    const callback = vi.fn(async () => {}); const instance = bridge(callback); const { port, token } = await pair(instance);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await send(port, '/v1/capture', { body: payload(), headers: { ...headers, 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await send(port, '/v1/capture', { raw: '{bad', headers })).status).toBe(400);
    expect((await send(port, '/v1/capture', { raw: 'x'.repeat(128 * 1024 + 1), headers })).status).toBe(413);
    expect((await send(port, '/v1/capture', { body: { ...payload(), cookiePath: 'C:\\private.txt' }, headers })).status).toBe(400);
    expect((await send(port, '/v1/capture', { body: { ...payload(), url: 'https://media.example.test/chunk123.mp4' }, headers })).status).toBe(400);
    expect(callback).not.toHaveBeenCalled();
  });

  it('连接重启后旧分析回调完成也不能覆盖新会话状态', async () => {
    let finish!: () => void;
    const callback = vi.fn((_payload: unknown) => new Promise<void>(resolve => { finish = resolve; }));
    const instance = bridge(callback); const first = await pair(instance);
    await send(first.port, '/v1/capture', { body: payload(), headers: { Authorization: `Bearer ${first.token}` } });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    await instance.stop();
    const second = await pair(instance);
    finish(); await Promise.resolve();
    expect((await send(second.port, '/v1/status', { headers: { Authorization: `Bearer ${second.token}` } })).body.capture.status).toBe('idle');
    expect((await send(second.port, '/v1/status', { headers: { Authorization: `Bearer ${first.token}` } })).status).toBe(401);
  });

  it('桌面普通分析或浏览器窗口忙时在202前拒绝，不执行捕获回调', async () => {
    let available = false;
    const callback = vi.fn(async (_payload: unknown) => {});
    const instance = createExtensionBridge({ allowedExtensionId: FRAMECATCH_EXTENSION_ID, port: 0, onCapture: callback, canCapture: () => available });
    bridges.push(instance);
    const { port, token } = await pair(instance);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await send(port, '/v1/capture', { body: payload(), headers })).status).toBe(409);
    expect(callback).not.toHaveBeenCalled();
    expect((await send(port, '/v1/status', { headers })).body.capture.status).toBe('idle');
    available = true;
    expect((await send(port, '/v1/capture', { body: payload(), headers })).status).toBe(202);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  });

  it('端口被占用时仅报告可读错误，重复start/stop安全', async () => {
    const occupied = createServer(); servers.push(occupied);
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('listen failed');
    const instance = bridge(async () => {}, address.port);
    const [first, second] = await Promise.all([instance.start(), instance.start()]);
    expect(first.running).toBe(false); expect(second.running).toBe(false);
    expect(first.error).toContain('端口');
    expect(first.pairingCode).toBeUndefined();
    await instance.stop(); await instance.stop();
    expect(instance.getStatus().error).toBeUndefined();
  });
});
