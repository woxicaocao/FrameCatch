import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateExtensionCapture, type ExtensionCapturePayload } from './extension-import';

export interface ExtensionBridgeStatus { running: boolean; port: number; paired: boolean; pairingCode?: string; error?: string; remembered?: boolean; autoConnect?: boolean; }
export interface ExtensionCaptureStatus { status: 'idle' | 'analyzing' | 'completed' | 'failed'; message?: string; }
export const EXTENSION_BRIDGE_PORT = 46783;
export const FRAMECATCH_EXTENSION_ID = 'amlhlbgnmncdfdfjjpimjpopkfmcojcd';
const MAX_BODY = 128 * 1024;
const PAIRING_TTL = 5 * 60 * 1000;
const CAPTURE_MESSAGE = '已发送到映取，请选择画质并下载';
const FAILURE_MESSAGE = '分析未完成，请查看映取中的提示并重新播放后发送';
const RECORD_ERROR = '已保存的插件配对信息无法读取，请在软件中重新配对。';
const SAVE_ERROR = '无法保存插件配对，请检查软件目录权限和磁盘空间后重试。';
interface PairingRecord { version: 1; tokenHash: string; autoConnect: boolean; }

function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** A paired, loopback-only channel. It never listens on a LAN interface and
 * never returns cookies, signed URLs, titles, filesystem paths or error stacks. */
export function createExtensionBridge(options: {
  allowedExtensionId: string;
  onCapture: (payload: ExtensionCapturePayload) => Promise<void>;
  canCapture?: () => boolean;
  port?: number;
  pairingFile?: string;
}) {
  if (!/^[a-p]{32}$/.test(options.allowedExtensionId)) throw new Error('浏览器插件标识无效。');
  const configuredPort = options.port ?? EXTENSION_BRIDGE_PORT;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('插件连接端口无效。');
  const origin = `chrome-extension://${options.allowedExtensionId}`;
  const pairingFile = options.pairingFile;
  if (pairingFile !== undefined && (typeof pairingFile !== 'string' || !path.isAbsolute(pairingFile) || /[\u0000-\u001f\u007f]/.test(pairingFile))) throw new Error('插件配对记录位置无效。');
  let server: Server | undefined;
  let running = false, port = configuredPort, generation = 0;
  let code = '', codeExpires = 0, tokenHash = '', autoConnect = false, lastError: string | undefined;
  let recordError: string | undefined;
  let initialized = false, initializing: Promise<void> | undefined;
  let pendingPair: Promise<void> | undefined;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let failures: number[] = [];
  let capture: ExtensionCaptureStatus = { status: 'idle' };

  const getStatus = (): ExtensionBridgeStatus => ({ running, port, paired: !!tokenHash,
    ...(running && code && Date.now() < codeExpires && !tokenHash ? { pairingCode: code } : {}),
    ...(pairingFile ? { remembered: !!tokenHash, autoConnect } : {}),
    ...(lastError || recordError ? { error: lastError || recordError } : {}),
  });

  // Lifecycle mutations are ordered, so a simultaneous disable/forget/start
  // cannot persist an older credential after the user has revoked it.
  function schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycle.then(operation);
    lifecycle = result.catch(() => {}); return result;
  }
  async function checkedParent(): Promise<void> {
    if (!pairingFile) return;
    const parent = path.dirname(pairingFile);
    const info = await fs.lstat(parent);
    const canonical = await fs.realpath(parent);
    const same = process.platform === 'win32' ? canonical.toLowerCase() === path.resolve(parent).toLowerCase() : canonical === path.resolve(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || !same) throw new Error('parent');
    try { const target = await fs.lstat(pairingFile); if (!target.isFile() || target.isSymbolicLink()) throw new Error('target'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async function saveRecord(record: PairingRecord): Promise<void> {
    if (!pairingFile) return;
    await checkedParent();
    const temporary = `${pairingFile}.next-${randomBytes(8).toString('hex')}`;
    // A failed write/rename keeps its diagnostic temporary file. No files are
    // deleted; the descriptor contains only a hash, never the bearer credential.
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await checkedParent();
    await fs.rename(temporary, pairingFile);
  }
  async function loadRecord(): Promise<void> {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        if (pairingFile) {
          await checkedParent();
          try {
            const file = await fs.stat(pairingFile);
            if (file.size > 4096) throw new Error('size');
            const input: unknown = JSON.parse(await fs.readFile(pairingFile, 'utf8'));
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shape');
            const value = input as Record<string, unknown>;
            if (Object.keys(value).some(key => !['version', 'tokenHash', 'autoConnect'].includes(key)) || value.version !== 1 || typeof value.tokenHash !== 'string' ||
                (value.tokenHash !== '' && !/^[a-f0-9]{64}$/.test(value.tokenHash)) || typeof value.autoConnect !== 'boolean' || (!value.tokenHash && value.autoConnect)) throw new Error('shape');
            tokenHash = value.tokenHash; autoConnect = value.autoConnect;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      } catch { recordError = RECORD_ERROR; tokenHash = ''; autoConnect = false; }
      finally { initialized = true; initializing = undefined; }
    })();
    return initializing;
  }

  function reply(response: ServerResponse, status: number, body: Record<string, unknown>, cors = true) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...(cors ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    });
    response.end(JSON.stringify(body));
  }
  function reject(response: ServerResponse, status: number, message: string, cors = true) { reply(response, status, { ok: false, message }, cors); }
  function uniqueHeader(request: IncomingMessage, name: string): boolean {
    let count = 0;
    for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
    return count <= 1;
  }
  function authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    return !!tokenHash && typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) &&
      timingSafeEqual(createHash('sha256').update(header.slice(7)).digest(), Buffer.from(tokenHash, 'hex'));
  }
  async function jsonBody(request: IncomingMessage): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) throw new Error('type');
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new Error('size');
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY) throw new Error('size');
      chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('json'); }
  }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const requestGeneration = generation;
    // The exact authority check also blocks DNS rebinding and localhost aliases.
    if (!running || request.headers.host !== `127.0.0.1:${port}` ||
        ['host', 'origin', 'authorization', 'content-type'].some(name => !uniqueHeader(request, name))) {
      reject(response, 403, '已拒绝未知来源的插件连接。', false); return;
    }
    const route = request.url;
    if (!['/v1/pair', '/v1/status', '/v1/capture'].includes(route || '')) { reject(response, 404, '插件连接地址无效。', request.headers.origin === origin); return; }
    // Chrome extension GET fetches can omit Origin even with an Authorization
    // header. Keep every authenticated endpoint POST JSON instead of relaxing
    // origin validation for requests that have no trustworthy browser origin.
    if (request.method !== 'POST' && request.method !== 'OPTIONS') { reject(response, 405, '插件连接方式无效。', request.headers.origin === origin); return; }
    if (request.headers.origin !== origin) { reject(response, 403, '已拒绝未知来源的插件连接。', false); return; }
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const expected = 'POST';
      const headers = (request.headers['access-control-request-headers'] || '').toString().toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (method !== expected || headers.some(value => !['authorization', 'content-type'].includes(value))) { reject(response, 403, '插件连接方式无效。'); return; }
      response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': expected,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '60', Vary: 'Origin', 'Cache-Control': 'no-store' });
      response.end(); return;
    }
    if (route !== '/v1/pair' && !authorized(request)) { reject(response, 401, '请使用映取中显示的配对码重新连接。'); return; }
    if (route === '/v1/pair') {
      failures = failures.filter(time => Date.now() - time < 60 * 1000);
      if (failures.length >= 5) { reject(response, 429, '配对尝试过于频繁，请一分钟后再试。'); return; }
    }
    let body: unknown;
    try { body = await jsonBody(request); }
    catch (error) {
      const kind = error instanceof Error ? error.message : 'json';
      reject(response, kind === 'size' ? 413 : kind === 'type' ? 415 : 400, '插件请求格式无效或内容过大。'); return;
    }
    if (!running || requestGeneration !== generation || (route !== '/v1/pair' && !authorized(request))) { reject(response, 401, '插件连接已失效，请重新配对。'); return; }
    if (route === '/v1/status') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) { reject(response, 400, '插件状态请求格式无效。'); return; }
      reply(response, 200, { ok: true, paired: true, capture: { ...capture } }); return;
    }
    if (route === '/v1/pair') {
      failures = failures.filter(time => Date.now() - time < 60 * 1000);
      if (failures.length >= 5) { reject(response, 429, '配对尝试过于频繁，请一分钟后再试。'); return; }
      const input = body as Record<string, unknown> | null;
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length !== 1 || typeof input.code !== 'string' || input.code.length > 32 ||
          !code || Date.now() >= codeExpires || !equalSecret(input.code, code) || tokenHash || pendingPair) {
        failures.push(Date.now()); reject(response, 401, '配对码无效或已过期，请在映取中重新开启插件连接。'); return;
      }
      const token = randomBytes(32).toString('base64url');
      const nextHash = createHash('sha256').update(token).digest('hex');
      const previous: PairingRecord = { version: 1, tokenHash, autoConnect };
      const operation = (async () => {
        await saveRecord({ version: 1, tokenHash: nextHash, autoConnect: true });
        if (!running || requestGeneration !== generation) {
          await saveRecord(previous); return;
        }
        tokenHash = nextHash; autoConnect = !!pairingFile;
        code = ''; codeExpires = 0; failures = []; lastError = undefined;
        reply(response, 200, { ok: true, token });
      })();
      pendingPair = operation;
      try { await operation; }
      catch { lastError = SAVE_ERROR; reject(response, 503, SAVE_ERROR); }
      finally { if (pendingPair === operation) pendingPair = undefined; }
      return;
    }
    if (capture.status === 'analyzing' || (options.canCapture && !options.canCapture())) { reject(response, 409, '映取正在分析视频，请完成或取消后再发送。'); return; }
    let payload: ExtensionCapturePayload;
    try { payload = validateExtensionCapture(body); }
    catch { reject(response, 400, '请发送完整视频或播放清单，视频信息无效时请重新播放并捕获。'); return; }
    const currentGeneration = generation;
    capture = { status: 'analyzing', message: '映取正在分析，请在软件中查看结果。' };
    reply(response, 202, { ok: true, accepted: true, message: CAPTURE_MESSAGE });
    // Acknowledge immediately: a long media analysis must not keep a Manifest V3
    // service-worker fetch open. Desktop IPC delivers the full analysis result.
    void Promise.resolve().then(() => options.onCapture(payload)).then(() => {
      if (currentGeneration === generation && running) capture = { status: 'completed', message: CAPTURE_MESSAGE };
    }, () => {
      if (currentGeneration === generation && running) capture = { status: 'failed', message: FAILURE_MESSAGE };
    });
  }

  async function startInternal(): Promise<ExtensionBridgeStatus> {
    await loadRecord();
    if (recordError || running) return getStatus();
    lastError = undefined;
    const currentGeneration = ++generation;
    const instance = createServer((request, response) => { void handle(request, response).catch(() => reject(response, 400, '插件请求未完成，请重试。')); });
    server = instance;
    instance.requestTimeout = 10_000;
    instance.headersTimeout = 10_000;
    instance.maxHeadersCount = 32;
    try {
      await new Promise<void>((resolve, rejectListen) => {
        const failed = (error: Error) => { instance.off('listening', listening); rejectListen(error); };
        const listening = () => { instance.off('error', failed); resolve(); };
        instance.once('error', failed); instance.once('listening', listening); instance.listen(configuredPort, '127.0.0.1');
      });
      const address = instance.address();
      if (!address || typeof address === 'string') throw new Error('listen');
      port = address.port;
      if (pairingFile && tokenHash && !autoConnect) {
        await saveRecord({ version: 1, tokenHash, autoConnect: true });
        autoConnect = true;
      }
      if (currentGeneration !== generation) throw new Error('interrupted');
      if (!tokenHash) { code = randomBytes(5).toString('hex').slice(0, 8).toUpperCase(); codeExpires = Date.now() + PAIRING_TTL; }
      else { code = ''; codeExpires = 0; }
      failures = []; capture = { status: 'idle' }; running = true;
      instance.on('error', () => { lastError = '插件连接发生错误，请关闭连接后重试。'; });
      return getStatus();
    } catch {
      if (instance.listening) { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); }
      if (server === instance) server = undefined;
      running = false; code = ''; codeExpires = 0;
      if (!pairingFile) tokenHash = '';
      lastError = '无法开启插件连接，请检查端口占用、软件目录权限或磁盘空间。';
      return getStatus();
    }
  }

  async function stopInternal(): Promise<ExtensionBridgeStatus> {
    ++generation;
    running = false; code = ''; codeExpires = 0; failures = [];
    capture = { status: 'idle' }; lastError = undefined;
    const instance = server; server = undefined;
    if (instance?.listening) {
      instance.closeAllConnections();
      await new Promise<void>(resolve => instance.close(() => resolve()));
    }
    // A pairing request may be saving when the user exits/revokes. Wait for its
    // generation check and rollback before reporting that shutdown is complete.
    if (pendingPair) await pendingPair.catch(() => {});
    if (!pairingFile) { tokenHash = ''; autoConnect = false; }
    return getStatus();
  }

  const initialize = () => schedule(async () => { await loadRecord(); return getStatus(); });
  const start = () => schedule(startInternal);
  const stop = () => schedule(stopInternal);
  const disable = () => schedule(async () => {
    await loadRecord(); await stopInternal();
    if (recordError) return getStatus();
    try { await saveRecord({ version: 1, tokenHash, autoConnect: false }); autoConnect = false; }
    catch { lastError = SAVE_ERROR; }
    return getStatus();
  });
  const forget = () => schedule(async () => {
    await loadRecord(); await stopInternal();
    // Revocation is immediate in memory even if a full disk prevents persisting
    // it. Report that error explicitly; never claim the saved pairing is gone.
    tokenHash = ''; autoConnect = false;
    try { await saveRecord({ version: 1, tokenHash: '', autoConnect: false }); recordError = undefined; lastError = undefined; }
    catch { lastError = SAVE_ERROR; recordError = RECORD_ERROR; }
    return getStatus();
  });
  return { initialize, start, stop, disable, forget, getStatus };
}
