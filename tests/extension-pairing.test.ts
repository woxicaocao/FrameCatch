import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createExtensionBridge, FRAMECATCH_EXTENSION_ID } from '../electron/extension-bridge';

const origin = `chrome-extension://${FRAMECATCH_EXTENSION_ID}`;
const instances: ReturnType<typeof createExtensionBridge>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(instances.splice(0).map(instance => instance.stop())); });
async function fixture() {
  const directory = await fs.mkdtemp(path.resolve('.test-artifacts/remember-pairing-'));
  return { directory, file: path.join(directory, 'extension-pairing.json') };
}
function bridge(file?: string) {
  const instance = createExtensionBridge({ allowedExtensionId: FRAMECATCH_EXTENSION_ID, port: 0, pairingFile: file, onCapture: async () => {} });
  instances.push(instance); return instance;
}
function post(port: number, route: string, body: unknown = {}, token = ''): Promise<{ status: number; body: any }> {
  const content = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    call.once('error', reject); call.end(content);
  });
}
async function pair(instance: ReturnType<typeof createExtensionBridge>) {
  const status = await instance.start();
  expect(status.running).toBe(true); expect(status.pairingCode).toMatch(/^[A-F0-9]{8}$/);
  const result = await post(status.port, '/v1/pair', { code: status.pairingCode });
  expect(result.status).toBe(200); expect(result.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { token: result.body.token as string, port: status.port };
}

it('首次配对保存仅含哈希的记录，退出与新进程初始化后旧插件令牌仍可连接', async () => {
  const { file } = await fixture();
  const first = bridge(file);
  expect(await first.initialize()).toMatchObject({ running: false, paired: false, remembered: false, autoConnect: false });
  const { token, port } = await pair(first);
  const recordText = await fs.readFile(file, 'utf8');
  expect(recordText).not.toContain(token);
  const record = JSON.parse(recordText);
  expect(record).toEqual({ version: 1, tokenHash: createHash('sha256').update(token).digest('hex'), autoConnect: true });
  const publicState = await post(port, '/v1/status', {}, token);
  expect(publicState.status).toBe(200);
  expect(JSON.stringify(publicState.body)).not.toMatch(/tokenHash|token|pairingCode/);
  await first.stop();
  expect(first.getStatus()).toMatchObject({ running: false, paired: true, remembered: true, autoConnect: true });

  const second = bridge(file);
  const restored = await second.initialize();
  expect(restored).toMatchObject({ running: false, paired: true, remembered: true, autoConnect: true });
  expect(restored.pairingCode).toBeUndefined();
  const started = await second.start();
  expect(started.pairingCode).toBeUndefined();
  expect((await post(started.port, '/v1/status', {}, token)).status).toBe(200);
  expect(JSON.stringify(started)).not.toContain(record.tokenHash);
});

it('关闭自动连接保留配对，重启后不自动监听，手动开启无需再次输入配对码', async () => {
  const { file } = await fixture(); const first = bridge(file); const { token } = await pair(first);
  const disabled = await first.disable();
  expect(disabled).toMatchObject({ running: false, paired: true, remembered: true, autoConnect: false });
  expect(JSON.parse(await fs.readFile(file, 'utf8')).autoConnect).toBe(false);
  const second = bridge(file);
  expect(await second.initialize()).toMatchObject({ running: false, paired: true, autoConnect: false });
  const started = await second.start();
  expect(started).toMatchObject({ running: true, paired: true, autoConnect: true });
  expect(started.pairingCode).toBeUndefined();
  expect((await post(started.port, '/v1/status', {}, token)).status).toBe(200);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).autoConnect).toBe(true);
});

it('便携配对记录复制到新软件目录后仍可恢复，不依赖原始绝对路径', async () => {
  const before = await fixture(); const first = bridge(before.file); const { token } = await pair(first); await first.stop();
  const after = await fixture(); await fs.copyFile(before.file, after.file);
  const moved = bridge(after.file);
  expect(await moved.initialize()).toMatchObject({ paired: true, remembered: true, autoConnect: true });
  const active = await moved.start();
  expect(active.pairingCode).toBeUndefined();
  expect((await post(active.port, '/v1/status', {}, token)).status).toBe(200);
  expect(await fs.readFile(before.file, 'utf8')).toBe(await fs.readFile(after.file, 'utf8'));
});

it('忘记配对明确撤销旧令牌并保留空记录文件，新配对后旧令牌仍无效', async () => {
  const { file } = await fixture(); const instance = bridge(file); const old = await pair(instance);
  expect(await instance.forget()).toMatchObject({ running: false, paired: false, remembered: false, autoConnect: false });
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, tokenHash: '', autoConnect: false });
  const next = await pair(instance);
  expect(next.token).not.toBe(old.token);
  expect((await post(next.port, '/v1/status', {}, old.token)).status).toBe(401);
  expect((await post(next.port, '/v1/status', {}, next.token)).status).toBe(200);
  await instance.stop();
  const restarted = bridge(file); await restarted.initialize(); const status = await restarted.start();
  expect((await post(status.port, '/v1/status', {}, old.token)).status).toBe(401);
});

it.each([
  '{broken', JSON.stringify({ version: 1, tokenHash: 'not-a-sha256', autoConnect: true }),
  JSON.stringify({ version: 1, tokenHash: '', autoConnect: true }),
  JSON.stringify({ version: 2, tokenHash: '', autoConnect: false }),
  JSON.stringify({ version: 1, tokenHash: '', autoConnect: false, cookie: 'must-not-be-read' }),
])('损坏配对记录不阻断软件初始化，也不覆盖或开放未配对监听：%s', async content => {
  const { file } = await fixture(); await fs.writeFile(file, content);
  const instance = bridge(file);
  const initial = await instance.initialize();
  expect(initial.running).toBe(false); expect(initial.error).toContain('配对信息无法读取');
  expect((await instance.start()).running).toBe(false);
  expect(await fs.readFile(file, 'utf8')).toBe(content);
  await instance.forget();
  expect(instance.getStatus().error).toBeUndefined();
  expect((await instance.start()).pairingCode).toMatch(/^[A-F0-9]{8}$/);
});

it('配对持久化失败返回503，不能返回假成功或保留内存中的授权', async () => {
  const { directory, file } = await fixture(); const instance = bridge(file); const initial = await instance.start();
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('PRIVATE_FILESYSTEM_DETAIL'), { code: 'EACCES' }));
  const result = await post(initial.port, '/v1/pair', { code: initial.pairingCode });
  expect(result.status).toBe(503); expect(result.body.token).toBeUndefined();
  expect(instance.getStatus()).toMatchObject({ paired: false, remembered: false, autoConnect: false });
  expect(JSON.stringify(instance.getStatus())).not.toContain('PRIVATE_');
  await expect(fs.access(file)).rejects.toThrow();
  const retained = (await fs.readdir(directory)).filter(name => name.includes('.next-'));
  expect(retained).toHaveLength(1);
  expect(Object.keys(JSON.parse(await fs.readFile(path.join(directory, retained[0]), 'utf8'))).sort()).toEqual(['autoConnect', 'tokenHash', 'version']);
  const retry = await post(initial.port, '/v1/pair', { code: initial.pairingCode });
  expect(retry.status).toBe(200);
});

it('并发同码配对只有一条成功，不出现两份不同授权令牌', async () => {
  const { file } = await fixture(); const instance = bridge(file); const initial = await instance.start();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  let entered = false;
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { entered = true; await gate; return rename(...args); });
  const first = post(initial.port, '/v1/pair', { code: initial.pairingCode });
  await vi.waitFor(() => expect(entered).toBe(true));
  const second = await post(initial.port, '/v1/pair', { code: initial.pairingCode });
  expect(second.status).toBe(401); expect(second.body.token).toBeUndefined();
  release(); const accepted = await first;
  expect(accepted.status).toBe(200);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).tokenHash).toBe(createHash('sha256').update(accepted.body.token).digest('hex'));
});

it('配对写盘期间忘记配对会等待旧请求回滚，旧授权不能在重启后复活', async () => {
  const { file } = await fixture(); const instance = bridge(file); const initial = await instance.start();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs); let entered = false;
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { entered = true; await gate; return rename(...args); });
  const pairing = post(initial.port, '/v1/pair', { code: initial.pairingCode }).catch(() => null);
  await vi.waitFor(() => expect(entered).toBe(true));
  const forgetting = instance.forget();
  await vi.waitFor(() => expect(instance.getStatus().running).toBe(false));
  release(); await forgetting; await pairing;
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, tokenHash: '', autoConnect: false });
  const restarted = bridge(file);
  expect(await restarted.initialize()).toMatchObject({ remembered: false, autoConnect: false, paired: false });
  expect((await restarted.start()).pairingCode).toMatch(/^[A-F0-9]{8}$/);
});

it('配对文件父目录缺失或目标不是文件时只显示固定错误，不自动创建或替换', async () => {
  const { directory } = await fixture();
  const missing = bridge(path.join(directory, 'not-created', 'pair.json'));
  expect((await missing.initialize()).error).toContain('配对信息无法读取');
  await expect(fs.access(path.join(directory, 'not-created'))).rejects.toThrow();
  const subdirectory = path.join(directory, 'target-directory'); await fs.mkdir(subdirectory);
  const invalid = bridge(subdirectory);
  expect((await invalid.initialize()).error).toContain('配对信息无法读取');
  expect((await invalid.forget()).error).toContain('无法保存');
  expect((await fs.stat(subdirectory)).isDirectory()).toBe(true);
});
