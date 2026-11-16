import { BRIDGE_URL, CAPTURE_LIMIT, CAPTURE_TTL, PAIRING_KEY, PARTIAL_MEDIA_HINT, SESSION_KEY, capturePayload, headerValue, mediaKind, mediaResourceIssue, publicCapture, safeHttp } from './media.js';

const detectionTypes = new Set(['media', 'xmlhttprequest', 'other']);
const genericBridgeError = '等待映取启动，软件开启后会自动连接。';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

/** Only the extension's own popup may call this controller. Request contents and
 * media stays in trusted session storage. Only the local pairing token is
 * remembered in trusted local storage; neither store is exposed to pages. */
export function createController(api, fetcher = fetch, clock = Date.now, makeId = () => crypto.randomUUID(), browserAgent = globalThis.navigator?.userAgent || 'Chrome') {
  let state = { tabs: {} }, queue = Promise.resolve();
  let token = '', connection = 'unpaired', credentialRevision = 0, credentialWrites = Promise.resolve();
  let connecting, lastCapture;
  const pending = new Map();
  const ready = (async () => {
    await Promise.all([
      api.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      api.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    const stored = (await api.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (stored && typeof stored === 'object' && stored.tabs && typeof stored.tabs === 'object') state = { tabs: stored.tabs };
    const saved = (await api.storage.local.get(PAIRING_KEY))[PAIRING_KEY];
    if (validToken(saved?.token)) token = saved.token;
    // Migrate one older session pairing, without copying any captured media.
    else if (saved === undefined && validToken(stored?.token)) {
      await api.storage.local.set({ [PAIRING_KEY]: { token: stored.token } }); token = stored.token;
    }
    connection = token ? 'waiting' : 'unpaired';
    const changed = expire();
    if (changed || Object.hasOwn(stored || {}, 'token')) await persist();
  })();
  const connectionView = () => ({ paired: Boolean(token), connection, ...(lastCapture ? { capture: { ...lastCapture } } : {}) });
  async function rememberToken(value) {
    const current = ++credentialRevision;
    token = value; connection = token ? 'waiting' : 'unpaired'; lastCapture = undefined;
    const write = credentialWrites.catch(() => {}).then(() => api.storage.local.set({ [PAIRING_KEY]: { token: value } }));
    credentialWrites = write;
    try { await write; }
    catch { if (current === credentialRevision) { token = ''; connection = 'unpaired'; } throw new Error('无法保存本机配对，请检查浏览器存储后重试。'); }
    return current === credentialRevision;
  }
  function expire() {
    const now = clock(); let changed = false;
    for (const [id, tab] of Object.entries(state.tabs)) {
      if (now - tab.startedAt >= CAPTURE_TTL || !safeHttp(tab.pageUrl)) { delete state.tabs[id]; changed = true; continue; }
      const complete = tab.captures.filter(capture => !mediaResourceIssue(capture.url));
      if (complete.length !== tab.captures.length) { tab.blockedCount = Math.min(999, (tab.blockedCount || 0) + tab.captures.length - complete.length); tab.captures = complete; changed = true; }
    }
    for (const [id, request] of pending) if (now - request.at > 30000) pending.delete(id);
    return changed;
  }
  async function persist() { await api.storage.session.set({ [SESSION_KEY]: state }); }
  function serial(work) {
    const run = queue.then(async () => { await ready; if (expire()) await persist(); return work(); });
    queue = run.catch(() => {}); return run;
  }
  async function tabInfo(id) {
    const tab = await api.tabs.get(id);
    const pageUrl = safeHttp(tab.url);
    if (!pageUrl) throw new Error('请先在普通网页中打开并播放视频。');
    return { id: tab.id, pageUrl, title: typeof tab.title === 'string' ? tab.title.slice(0, 300) : '当前网页' };
  }
  async function view(tabId) {
    let info;
    try {
      if (!Number.isInteger(tabId)) {
        const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tabs[0]?.id;
      }
      const browserTab = await api.tabs.get(tabId);
      // Prior to the first host grant Chrome may hide url/title. Keep the tab
      // identity so the popup's user gesture can request permission first.
      if (browserTab.url && !safeHttp(browserTab.url)) throw new Error('Unsupported tab');
      info = { id: browserTab.id, title: typeof browserTab.title === 'string' ? browserTab.title.slice(0, 300) : '当前网页（授权后可检测）' };
    } catch { return { ...connectionView(), active: false, captures: [], tab: null }; }
    const tab = state.tabs[info.id];
    return { ...connectionView(), active: Boolean(tab), tab: { id: info.id, title: info.title }, blockedCount: tab?.blockedCount || 0, hint: tab?.blockedCount ? PARTIAL_MEDIA_HINT : '', captures: (tab?.captures || []).map(publicCapture).sort((a, b) => (a.kind === 'mp4') - (b.kind === 'mp4') || b.capturedAt - a.capturedAt) };
  }
  async function bridge(path, method = 'GET', body, auth = true, timeout = 10000) {
    const requestToken = token, revision = credentialRevision;
    if (auth && !requestToken) throw new Error('请先输入映取中显示的 8 位配对码。');
    let response;
    try {
      response = await fetcher(`${BRIDGE_URL}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${requestToken}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch { if (auth && revision === credentialRevision) connection = 'waiting'; throw new Error(genericBridgeError); }
    let result;
    try { result = await response.json(); } catch { throw new Error(genericBridgeError); }
    if (!response.ok || result.ok !== true) {
      if (response.status === 401 && auth) {
        if (revision === credentialRevision && token === requestToken) await rememberToken('');
        throw new Error('配对已失效，请使用映取中的当前配对码重新连接。');
      }
      if (response.status === 409) throw new Error('映取正在分析其他资源，请稍后再发送。');
      if (response.status === 429) throw new Error('尝试过于频繁，请稍后再配对。');
      if (path === '/v1/pair') throw new Error('配对未完成。请检查 8 位配对码是否有效。');
      throw new Error('发送未完成。请重新播放并选择完整视频或播放清单。');
    }
    return result;
  }
  async function connect(quiet = true) {
    await ready;
    if (!token) {
      if (!quiet) throw new Error('请先输入映取中显示的 8 位配对码。');
      return { ok: true, ...connectionView() };
    }
    const revision = credentialRevision;
    if (connecting?.revision === revision) return connecting.promise.then(result => {
      if (!quiet && result.error) throw new Error(result.error);
      return result;
    });
    const attempt = (async () => {
      try {
        const result = await bridge('/v1/status', 'POST', {}, true, 2000);
        if (revision === credentialRevision) {
          connection = 'connected';
          lastCapture = ['idle', 'analyzing', 'completed', 'failed'].includes(result.capture?.status) ? { status: result.capture.status } : undefined;
        }
        return { ok: true, ...connectionView() };
      } catch (error) {
        if (revision === credentialRevision && token) connection = 'waiting';
        return { ok: true, ...connectionView(), error: error instanceof Error ? error.message : genericBridgeError };
      } finally { if (connecting?.revision === revision) connecting = undefined; }
    })();
    connecting = { revision, promise: attempt };
    const result = await attempt;
    if (!quiet && result.error) throw new Error(result.error);
    return result;
  }
  function clearPending(tabId) { for (const [id, request] of pending) if (request.tabId === tabId) pending.delete(id); }

  const controller = {
    ready,
    reconnect: () => connect(true),
    handle(message) {
      if (!message || typeof message !== 'object') return Promise.reject(new Error('无法识别此操作。'));
      if (message.type === 'bridge:connect') return connect(true);
      if (message.type === 'bridge:status') return connect(false);
      if (message.type === 'bridge:forget') return ready.then(async () => { await rememberToken(''); return { ok: true, ...connectionView() }; });
      if (message.type === 'bridge:pair') return ready.then(async () => {
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{8}$/.test(code)) throw new Error('请输入映取中显示的 8 位字母数字配对码。');
        const result = await bridge('/v1/pair', 'POST', { code }, false);
        if (!validToken(result.token)) throw new Error('配对响应无效，请重试。');
        if (await rememberToken(result.token)) connection = 'connected';
        return { ok: true, ...connectionView() };
      });
      if (message.type === 'capture:send') return (async () => {
        await serial(() => {
          if (!state.tabs[message.tabId]?.captures.some(item => item.id === message.id)) throw new Error('此资源已清空或过期，请重新播放并检测。');
        });
        // Connection checks run outside the media queue, so a sleeping desktop
        // never delays onBeforeSendHeaders/onHeadersReceived capture events.
        await connect(false);
        const payload = await serial(() => {
          const capture = state.tabs[message.tabId]?.captures.find(item => item.id === message.id);
          if (!capture) throw new Error('此资源已清空或过期，请重新播放并检测。');
          return capturePayload(capture);
        });
        await bridge('/v1/capture', 'POST', payload);
        return { ok: true, message: '已发送到映取，请在软件中查看分析结果并选择画质下载。' };
      })();
      return serial(async () => {
        const tabId = message.tabId;
        switch (message.type) {
          case 'popup:state': return { ok: true, ...await view(tabId) };
          case 'capture:start': {
            if (!Number.isInteger(tabId)) throw new Error('请先选择一个网页标签。');
            if (!await api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })) throw new Error('需要先授权网站与视频 CDN 的检测权限。');
            const info = await tabInfo(tabId);
            state.tabs[tabId] = { ...info, startedAt: clock(), captures: [] }; clearPending(tabId); await persist();
            return { ok: true, ...await view(tabId) };
          }
          case 'capture:stop': delete state.tabs[tabId]; clearPending(tabId); await persist(); return { ok: true, ...await view(tabId) };
          case 'capture:clear': if (state.tabs[tabId]) { state.tabs[tabId].captures = []; state.tabs[tabId].blockedCount = 0; } clearPending(tabId); await persist(); return { ok: true, ...await view(tabId) };
          default: throw new Error('无法识别此操作。');
        }
      });
    },
    beforeHeaders(details) {
      return serial(async () => {
        const tab = state.tabs[details.tabId];
        if (!tab || !detectionTypes.has(details.type) || (details.method && details.method !== 'GET')) return;
        const url = safeHttp(details.url); if (!url) return;
        // Small, short-lived request metadata is kept only until a successful
        // media response identifies it. No Authorization or body is collected.
        if (pending.size >= 100) pending.delete(pending.keys().next().value);
        pending.set(details.requestId, { tabId: details.tabId, url, at: clock(), userAgent: headerValue(details.requestHeaders, 'User-Agent', 2048) || browserAgent, referer: safeHttp(headerValue(details.requestHeaders, 'Referer')) || tab.pageUrl, origin: safeHttp(headerValue(details.requestHeaders, 'Origin')), cookieHeader: headerValue(details.requestHeaders, 'Cookie') });
      });
    },
    receivedHeaders(details) {
      return serial(async () => {
        const tab = state.tabs[details.tabId];
        if (!tab || !detectionTypes.has(details.type)) return;
        const request = pending.get(details.requestId); pending.delete(details.requestId);
        if (!request || request.tabId !== details.tabId || request.url !== safeHttp(details.url) || ![200, 206].includes(details.statusCode)) return;
        const contentType = headerValue(details.responseHeaders, 'Content-Type', 200) || '';
        if (mediaResourceIssue(request.url)) { tab.blockedCount = Math.min(999, (tab.blockedCount || 0) + 1); await persist(); return; }
        const kind = mediaKind(request.url, contentType, details.type); if (!kind) return;
        const capture = { id: makeId(), kind, url: request.url, pageUrl: tab.pageUrl, title: tab.title, userAgent: request.userAgent, referer: request.referer, ...(request.origin ? { origin: new URL(request.origin).origin } : {}), ...(request.cookieHeader ? { cookieHeader: request.cookieHeader } : {}), contentType, capturedAt: clock() };
        const index = tab.captures.findIndex(item => item.url === capture.url);
        if (index >= 0) { capture.id = tab.captures[index].id; tab.captures.splice(index, 1); }
        tab.captures.push(capture); if (tab.captures.length > CAPTURE_LIMIT) tab.captures.shift();
        await persist();
      });
    },
    forgetRequest(id) { return serial(async () => { pending.delete(id); }); },
    updatedTab(tabId, change) { return serial(async () => {
      const tab = state.tabs[tabId]; if (!tab) return;
      if (change.status === 'loading' || typeof change.url === 'string') {
        clearPending(tabId); tab.captures = []; tab.blockedCount = 0;
        const url = safeHttp(change.url || tab.pageUrl);
        if (url) tab.pageUrl = url; else delete state.tabs[tabId];
      }
      if (typeof change.title === 'string' && state.tabs[tabId]) tab.title = change.title.slice(0, 300);
      await persist();
    }); },
    removedTab(tabId) { return serial(async () => { delete state.tabs[tabId]; clearPending(tabId); await persist(); }); },
    prune() { return serial(async () => {}); },
  };
  return controller;
}
