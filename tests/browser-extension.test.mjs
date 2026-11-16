import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createController } from '../browser-extension/controller.js';
import { CAPTURE_TTL, PAIRING_KEY, SESSION_KEY, capturePayload, headerValue, mediaKind, mediaResourceIssue, privateLabel, safeHttp } from '../browser-extension/media.js';

const fakeToken = 'a'.repeat(43);
function setup(options = {}) {
  let now = 1000, nextId = 0, permissions = true;
  const store = structuredClone(options.session || {}), localStore = structuredClone(options.local || {}), calls = [];
  const tabs = new Map([[7, { id: 7, url: 'https://example.test/watch?v=PRIVATE_PAGE', title: '测试作品' }], [8, { id: 8, url: 'https://elsewhere.test/private', title: '其他网页' }]]);
  const api = {
    storage: { session: {
      async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); },
      async get(key) { return structuredClone({ [key]: store[key] }); },
      async set(value) { Object.assign(store, structuredClone(value)); },
    }, local: {
      async setAccessLevel(options) { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); },
      async get(key) { return structuredClone({ [key]: localStore[key] }); },
      async set(value) { Object.assign(localStore, structuredClone(value)); },
    } },
    tabs: { async get(id) { if (!tabs.has(id)) throw new Error('Unknown tab'); return tabs.get(id); }, async query() { return [tabs.get(7)]; } },
    permissions: { async contains() { return permissions; } },
  };
  let responder = async (url, options) => {
    if (url.endsWith('/pair')) return Response.json({ ok: true, token: fakeToken });
    if (url.endsWith('/capture')) return Response.json({ ok: true, accepted: true }, { status: 202 });
    return Response.json({ ok: true, paired: true, capture: { status: 'completed' } });
  };
  const fetcher = async (url, options) => { calls.push({ url, options }); return responder(url, options); };
  const controller = createController(api, fetcher, () => now, () => `capture-${++nextId}`, 'Fixture Chrome/1');
  const start = () => controller.handle({ type: 'capture:start', tabId: 7 });
  const view = () => controller.handle({ type: 'popup:state', tabId: 7 });
  async function capture({ url = 'https://media.test/movie.mp4?token=PRIVATE_MEDIA', type = 'media', statusCode = 206, mime = 'video/mp4', tabId = 7, requestId = `req-${++nextId}`, cookie = 'media_session=PRIVATE_COOKIE', method = 'GET', headers = [] } = {}) {
    await controller.beforeHeaders({ tabId, type, url, method, requestId, requestHeaders: [{ name: 'Cookie', value: cookie }, { name: 'User-Agent', value: 'Fixture Chrome/2' }, { name: 'Referer', value: 'https://embed.test/player' }, { name: 'Origin', value: 'https://embed.test' }, { name: 'Authorization', value: 'SHOULD_NOT_CAPTURE' }, ...headers] });
    await controller.receivedHeaders({ tabId, type, url, requestId, statusCode, responseHeaders: [{ name: 'Content-Type', value: mime }] });
  }
  return { controller, api, store, localStore, calls, tabs, start, view, capture, respond: fn => { responder = fn; }, advance: value => { now += value; }, disallow: () => { permissions = false; } };
}

test('固定公钥生成预期扩展 ID，只有可信脚本与按需网站权限', async () => {
  const manifest = JSON.parse(await readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  assert.equal([...digest].map(c => String.fromCharCode(97 + parseInt(c, 16))).join(''), 'amlhlbgnmncdfdfjjpimjpopkfmcojcd');
  assert.equal(manifest.manifest_version, 3);
  assert.ok(!manifest.permissions.includes('cookies') && !manifest.permissions.includes('debugger'));
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test('仅接受无凭据的 HTTP(S)，列表标签去除签名和页面查询参数', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'https://u:p@example.test/video.mp4', 'https://example.test/\nvideo']) assert.equal(safeHttp(url), undefined);
  assert.equal(safeHttp('https://example.test/movie.mp4?q=one#position'), 'https://example.test/movie.mp4?q=one');
  assert.equal(privateLabel('https://example.test/movie.mp4?signature=SECRET#token'), 'example.test / movie.mp4');
});

test('清单、Vimeo JSON、无后缀 MP4 可以识别，伪域和传输分片不入列表', () => {
  for (const [url, mime, kind] of [
    ['https://c.test/master.m3u8?x=1', '', 'hls'], ['https://c.test/manifest', 'application/vnd.apple.mpegurl', 'hls'], ['https://c.test/stream.mpd', '', 'dash'],
    ['https://video.vimeocdn.com/1/master.json?x=1', 'application/json', 'dash'], ['https://c.akamaized.net/master.json', '', 'dash'],
    ['https://c.test/complete.mp4', '', 'mp4'], ['https://c.test/playback?id=1', 'video/mp4', 'mp4'],
  ]) assert.equal(mediaKind(url, mime, 'xmlhttprequest'), kind);
  for (const path of ['/segment-1.mp4', '/chunk/1.mp4', '/fragment_2.mp4', '/init.mp4', '/file.ts', '/clip.m4s', '/sound.m4a', '/audio/file.mp4']) assert.equal(mediaKind(`https://c.test${path}`, 'video/mp4'), undefined, path);
  assert.equal(mediaKind('https://vimeocdn.com.evil.test/master.json', 'application/json'), undefined);
  assert.equal(mediaKind('https://c.test/movie.mp4', 'audio/mp4'), undefined);
});

test('Vimeo受签名约束的range MP4不是完整视频，playlist.json总清单保留原始签名', () => {
  for (const url of ['https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/file.mp4?range=6562581-13875329&pathsig=TEST_SIGNED', 'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/file.mp4?pathsig=TEST_SIGNED', 'https://media.test/clip.mp4?range=0-100']) {
    assert.equal(mediaResourceIssue(url), 'byte-range'); assert.equal(mediaKind(url, 'video/mp4', 'xmlhttprequest'), undefined);
  }
  assert.equal(mediaKind('https://vod-adaptive-ak.vimeocdn.com/v2/playlist/av/primary/playlist.json?pathsig=TEST_SIGNED', 'application/json', 'xmlhttprequest'), 'vimeo-json');
  assert.equal(mediaKind('https://vimeocdn.com.evil.test/playlist.json', 'application/json', 'xmlhttprequest'), undefined);
  assert.equal(mediaKind('https://vod-progressive.akamaized.net/file.mp4?token=TEST_SIGNED', 'video/mp4'), 'mp4');
});

test('局部MP4不进入候选且提示重新捕获；不保留局部URL或Cookie', async () => {
  const fixture = setup(); await fixture.start();
  const partial = 'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/file.mp4?range=100-500&pathsig=BLOCKED_SECRET';
  await fixture.capture({ url: partial, cookie: 'partial=BLOCKED_COOKIE' });
  const view = await fixture.view();
  assert.equal(view.captures.length, 0); assert.equal(view.blockedCount, 1); assert.match(view.hint, /局部 MP4/);
  for (const sensitive of [partial, 'BLOCKED_SECRET', 'BLOCKED_COOKIE']) assert.ok(!JSON.stringify(fixture.store).includes(sensitive));
  await fixture.controller.handle({ type: 'capture:clear', tabId: 7 }); assert.equal((await fixture.view()).blockedCount, 0);
  await fixture.capture({ url: partial }); await fixture.controller.updatedTab(7, { status: 'loading' }); assert.equal((await fixture.view()).blockedCount, 0);
  const playlist = 'https://vod-adaptive-ak.vimeocdn.com/v2/playlist/av/primary/playlist.json?pathsig=TEST_SIGNED';
  await fixture.capture({ url: playlist, type: 'xmlhttprequest', mime: 'application/json' });
  const capture = (await fixture.view()).captures[0]; assert.equal(capture.kind, 'vimeo-json');
  await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  await fixture.controller.handle({ type: 'capture:send', tabId: 7, id: capture.id });
  assert.equal(JSON.parse(fixture.calls.at(-1).options.body).url, playlist);
});

test('工作线程重启会清除旧版本遗留的局部MP4候选', async () => {
  const fixture = setup(); await fixture.start();
  fixture.store[SESSION_KEY].tabs[7].captures.push({ id: 'legacy-partial', kind: 'mp4', url: 'https://vod-adaptive-ak.vimeocdn.com/signed/v2/range/prot/ENCODED/avf/file.mp4', cookieHeader: 'partial=LEGACY_SECRET' });
  const resumed = createController(fixture.api, async () => { throw new Error('No request expected'); }, () => 1000);
  const view = await resumed.handle({ type: 'popup:state', tabId: 7 });
  assert.equal(view.captures.length, 0); assert.equal(view.blockedCount, 1); assert.ok(!JSON.stringify(fixture.store).includes('LEGACY_SECRET'));
});

test('头部只取大小受限、无换行的明确字段，Cookie 多行按实际值拼接', () => {
  assert.equal(headerValue([{ name: 'Cookie', value: 'a=1' }, { name: 'cookie', value: 'b=2' }], 'cookie'), 'a=1; b=2');
  assert.equal(headerValue([{ name: 'Referer', value: 'bad\r\nInjection' }], 'referer'), undefined);
  assert.equal(headerValue([{ name: 'Cookie', value: 'a'.repeat(65537) }], 'cookie'), undefined);
});

test('未开启的网页不会记录；授权并启用后仅捕获目标标签的成功 GET 媒体', async () => {
  const fixture = setup(); await fixture.capture(); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.start();
  await fixture.capture({ tabId: 8 }); await fixture.capture({ statusCode: 403 }); await fixture.capture({ method: 'POST' });
  await fixture.capture({ url: 'https://c.test/account', mime: 'application/json', type: 'xmlhttprequest' });
  assert.equal((await fixture.view()).captures.length, 0);
  await fixture.capture(); const result = await fixture.view();
  assert.equal(result.captures.length, 1); assert.equal(result.captures[0].hasCookie, true);
  assert.equal(result.tab.id, 7); assert.equal(result.captures[0].kind, 'mp4');
  const output = JSON.stringify(result); for (const value of ['PRIVATE_COOKIE', 'PRIVATE_MEDIA', 'PRIVATE_PAGE', 'SHOULD_NOT_CAPTURE']) assert.ok(!output.includes(value));
  assert.ok(!JSON.stringify(fixture.store).includes('SHOULD_NOT_CAPTURE'));
});

test('首次未授权时保留标签身份，允许点击申请权限，未授权启动仍拒绝', async () => {
  const fixture = setup(); fixture.tabs.set(7, { id: 7 }); fixture.disallow();
  const view = await fixture.view(); assert.equal(view.tab.id, 7); assert.equal(view.active, false);
  await assert.rejects(fixture.start(), /授权/);
});

test('特殊页面无法检测，弹窗不返回完整页面地址', async () => {
  const fixture = setup(); fixture.tabs.set(7, { id: 7, url: 'chrome://settings', title: '设置' });
  assert.equal((await fixture.view()).tab, null); await assert.rejects(fixture.start(), /普通网页/);
});

test('选中请求只发白名单字段、媒体实际 Cookie 与来源，完全不发 Authorization 或 Range', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture({ headers: [{ name: 'Range', value: 'bytes=0-100' }] });
  await fixture.controller.handle({ type: 'bridge:pair', code: 'abcd1234' });
  const result = await fixture.view(); await fixture.controller.handle({ type: 'capture:send', tabId: 7, id: result.captures[0].id });
  const request = fixture.calls.at(-1), payload = JSON.parse(request.options.body);
  assert.equal(request.options.headers.Authorization, `Bearer ${fakeToken}`);
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error');
  assert.equal(payload.cookieHeader, 'media_session=PRIVATE_COOKIE'); assert.equal(payload.userAgent, 'Fixture Chrome/2'); assert.equal(payload.referer, 'https://embed.test/player');
  assert.deepEqual(Object.keys(payload).sort(), ['url', 'pageUrl', 'title', 'userAgent', 'referer', 'origin', 'cookieHeader', 'contentType'].sort());
  assert.ok(!JSON.stringify(payload).includes('SHOULD_NOT_CAPTURE')); assert.ok(!JSON.stringify(payload).includes('bytes='));
});

test('只有随机配对令牌进入可信本机存储；捕获仍仅在会话存储，工作线程可恢复', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture(); await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  assert.equal(fixture.store[SESSION_KEY].token, undefined);
  assert.deepEqual(fixture.localStore, { [PAIRING_KEY]: { token: fakeToken } });
  for (const secret of ['PRIVATE_COOKIE', 'PRIVATE_MEDIA', 'PRIVATE_PAGE']) assert.ok(!JSON.stringify(fixture.localStore).includes(secret));
  const resumed = createController(fixture.api, async () => { throw new Error('No request expected'); }, () => 1000);
  const state = await resumed.handle({ type: 'popup:state', tabId: 7 }); assert.equal(state.paired, true); assert.equal(state.captures.length, 1);
});

test('导航清空旧资源但保持检测，刷新后可捕获新资源', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture();
  await fixture.controller.updatedTab(7, { status: 'loading', url: 'https://example.test/new' });
  assert.equal((await fixture.view()).active, true); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.capture(); assert.equal((await fixture.view()).captures.length, 1);
});

test('停止、清空、标签关闭会清除相应捕获；清空不停止检测', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture();
  await fixture.controller.handle({ type: 'capture:clear', tabId: 7 }); assert.equal((await fixture.view()).active, true); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.capture(); await fixture.controller.handle({ type: 'capture:stop', tabId: 7 }); assert.equal((await fixture.view()).active, false); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.start(); await fixture.capture(); await fixture.controller.removedTab(7); assert.equal((await fixture.view()).captures.length, 0);
  assert.deepEqual(fixture.store[SESSION_KEY].tabs, {});
});

test('30 分钟后过期且清除会话存储，过期资源不可再发送', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture(); const id = (await fixture.view()).captures[0].id;
  fixture.advance(CAPTURE_TTL + 1); await fixture.controller.prune(); const state = await fixture.view();
  assert.equal(state.active, false); assert.equal(state.captures.length, 0); assert.deepEqual(fixture.store[SESSION_KEY].tabs, {});
  await assert.rejects(fixture.controller.handle({ type: 'capture:send', tabId: 7, id }), /过期/);
});

test('重复 URL 去重且最多30项，清单优先排列', async () => {
  const fixture = setup(); await fixture.start();
  for (let i = 0; i < 35; i++) await fixture.capture({ url: `https://c.test/video-${i}.mp4` });
  await fixture.capture({ url: 'https://c.test/master.m3u8', mime: 'application/vnd.apple.mpegurl' });
  const state = await fixture.view(); assert.equal(state.captures.length, 30); assert.equal(state.captures[0].kind, 'hls');
  const id = state.captures[0].id; await fixture.capture({ url: 'https://c.test/master.m3u8', mime: 'application/vnd.apple.mpegurl' });
  assert.equal((await fixture.view()).captures[0].id, id); assert.equal((await fixture.view()).captures.length, 30);
});

test('原请求过期、跨标签或重定向到另一地址不能携带旧Cookie', async () => {
  const fixture = setup(); await fixture.start();
  const details = { tabId: 7, requestId: 'r', url: 'https://c.test/movie.mp4', method: 'GET', type: 'media', requestHeaders: [{ name: 'Cookie', value: 'secret=one' }] };
  await fixture.controller.beforeHeaders(details); fixture.advance(31000);
  await fixture.controller.receivedHeaders({ ...details, statusCode: 200, responseHeaders: [] }); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.controller.beforeHeaders(details);
  await fixture.controller.receivedHeaders({ ...details, url: 'https://other.test/movie.mp4', statusCode: 200, responseHeaders: [] }); assert.equal((await fixture.view()).captures.length, 0);
  await fixture.controller.beforeHeaders(details); await fixture.controller.forgetRequest('r');
  await fixture.controller.receivedHeaders({ ...details, statusCode: 200, responseHeaders: [] }); assert.equal((await fixture.view()).captures.length, 0);
});

test('未配对不能发送；非法配对码不发网络请求', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture(); const state = await fixture.view();
  await assert.rejects(fixture.controller.handle({ type: 'capture:send', tabId: 7, id: state.captures[0].id }), /配对码/);
  await assert.rejects(fixture.controller.handle({ type: 'bridge:pair', code: 'BAD!' }), /8 位/); assert.equal(fixture.calls.length, 0);
});

test('HTTP错误不会回显服务端敏感原文，401使配对失效', async () => {
  const fixture = setup(); await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  const controller = createController(fixture.api, async () => Response.json({ ok: false, error: 'SERVER_SECRET' }, { status: 401 }));
  await assert.rejects(controller.handle({ type: 'bridge:status' }), error => /配对已失效/.test(error.message) && !error.message.includes('SERVER_SECRET'));
  assert.equal((await controller.handle({ type: 'popup:state', tabId: 7 })).paired, false); assert.equal(fixture.localStore[PAIRING_KEY].token, '');
});

test('连接检查使用 JSON POST，保留桥接严格Origin条件且不手工伪造Origin', async () => {
  const fixture = setup(); await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  const state = await fixture.controller.handle({ type: 'bridge:status' });
  assert.equal(state.paired, true); const request = fixture.calls.at(-1);
  assert.equal(request.url, 'http://127.0.0.1:46783/v1/status'); assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json'); assert.equal(request.options.body, '{}');
  assert.ok(!Object.keys(request.options.headers).some(name => name.toLowerCase() === 'origin'));
});

test('模拟浏览器重启后恢复本机配对，媒体会话不会随之恢复', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture();
  await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  const rebooted = setup({ local: fixture.localStore });
  const before = await rebooted.view();
  assert.equal(before.paired, true); assert.equal(before.connection, 'waiting');
  assert.equal(before.active, false); assert.deepEqual(before.captures, []);
  const connected = await rebooted.controller.reconnect();
  assert.equal(connected.connection, 'connected');
  assert.equal(rebooted.calls.length, 1); assert.ok(rebooted.calls[0].url.endsWith('/v1/status'));
  assert.ok(!JSON.stringify(connected).includes(fakeToken));
});

test('旧会话配对迁移到本机存储并清除session令牌，不迁移媒体内容', async () => {
  const fixture = setup({ session: { [SESSION_KEY]: { token: fakeToken, tabs: {} } } });
  assert.equal((await fixture.view()).paired, true);
  assert.deepEqual(fixture.localStore, { [PAIRING_KEY]: { token: fakeToken } });
  assert.deepEqual(fixture.store[SESSION_KEY], { tabs: {} });
  const forgotten = setup({ local: { [PAIRING_KEY]: { token: '' } }, session: { [SESSION_KEY]: { token: fakeToken, tabs: {} } } });
  assert.equal((await forgotten.view()).paired, false, '用户明确忘记的配对不能从旧会话复活');
});

test('无效持久令牌不会用于请求，也不返回给弹窗', async () => {
  for (const token of ['bad-token', 'secret\nheader', 'a'.repeat(100000), 123]) {
    const fixture = setup({ local: { [PAIRING_KEY]: { token } } });
    const result = await fixture.controller.reconnect();
    assert.equal(result.paired, false); assert.equal(result.connection, 'unpaired'); assert.equal(fixture.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('软件离线保留已记住的配对，软件恢复后自动重连而不请求配对码', async () => {
  const fixture = setup({ local: { [PAIRING_KEY]: { token: fakeToken } } });
  fixture.respond(async () => { throw new Error('offline'); });
  const offline = await fixture.controller.reconnect();
  assert.equal(offline.connection, 'waiting'); assert.equal(offline.paired, true);
  assert.match(offline.error, /等待映取启动/); assert.ok(!offline.error.includes(fakeToken));
  assert.equal(fixture.localStore[PAIRING_KEY].token, fakeToken);
  fixture.respond(async () => Response.json({ ok: true, paired: true, capture: { status: 'idle', ignored: 'SECRET' } }));
  const online = await fixture.controller.reconnect();
  assert.equal(online.connection, 'connected'); assert.deepEqual(online.capture, { status: 'idle' });
  assert.ok(fixture.calls.every(request => request.url.endsWith('/status')));
});

test('后台重连等待不阻塞媒体请求捕获，重复重连共用一个请求', async () => {
  const fixture = setup({ local: { [PAIRING_KEY]: { token: fakeToken } } });
  let finish;
  fixture.respond(() => new Promise(resolve => { finish = resolve; }));
  const first = fixture.controller.reconnect(), second = fixture.controller.reconnect();
  await fixture.start(); await fixture.capture();
  assert.equal((await fixture.view()).captures.length, 1);
  assert.equal(fixture.calls.length, 1);
  finish(Response.json({ ok: true, paired: true }));
  assert.equal((await first).connection, 'connected'); assert.equal((await second).connection, 'connected');
});

test('主动忘记仅清除配对令牌，不持久化或删除已检测媒体', async () => {
  const fixture = setup(); await fixture.start(); await fixture.capture();
  await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  const result = await fixture.controller.handle({ type: 'bridge:forget' });
  assert.equal(result.connection, 'unpaired'); assert.equal(result.paired, false);
  assert.deepEqual(fixture.localStore, { [PAIRING_KEY]: { token: '' } });
  assert.equal((await fixture.view()).captures.length, 1);
  assert.ok(!JSON.stringify(fixture.localStore).includes('PRIVATE_'));
});

test('旧401响应不能清除在它之后成功的新配对', async () => {
  const fixture = setup({ local: { [PAIRING_KEY]: { token: fakeToken } } });
  let completeOld;
  const newer = 'b'.repeat(43);
  fixture.respond(url => url.endsWith('/pair') ? Response.json({ ok: true, token: newer }) : new Promise(resolve => { completeOld = resolve; }));
  const old = fixture.controller.reconnect();
  await fixture.view();
  await fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' });
  completeOld(Response.json({ ok: false }, { status: 401 })); await old;
  const current = await fixture.view(); assert.equal(current.paired, true); assert.equal(current.connection, 'connected');
  assert.equal(fixture.localStore[PAIRING_KEY].token, newer);
});

test('配对存储失败时不假装已记住，也不泄漏服务端内容', async () => {
  const fixture = setup(); await fixture.controller.ready;
  fixture.api.storage.local.set = async () => { throw new Error('LOCAL_STORAGE_SECRET'); };
  await assert.rejects(fixture.controller.handle({ type: 'bridge:pair', code: 'ABCD1234' }), error => /无法保存本机配对/.test(error.message) && !error.message.includes('SECRET'));
  assert.equal((await fixture.view()).paired, false);
});

test('payload序列化白名单不传播未来内部字段', () => {
  const payload = capturePayload({ url: 'https://c.test/movie.mp4', pageUrl: 'https://p.test', title: '标题', userAgent: 'Chrome', authorization: 'PRIVATE', proxy: 'BAD', cookiePath: 'C:/secret', internal: 'PRIVATE' });
  assert.deepEqual(Object.keys(payload).sort(), ['url', 'pageUrl', 'title', 'userAgent'].sort());
});
