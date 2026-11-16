const $ = id => document.getElementById(id);
const queryTab = new URL(location.href).searchParams.get('tabId');
let tabId = /^\d+$/.test(queryTab || '') ? Number(queryTab) : undefined;
let selected = '', current = null, busy = false;
let checkingConnection = false;
const kindNames = { hls: 'HLS 清单', dash: 'DASH 清单', 'vimeo-json': 'Vimeo 总清单', mp4: 'MP4 资源' };
function message(text, error = false) { $('status-message').textContent = text; $('status-message').classList.toggle('error', error); }
async function call(value) {
  const result = await chrome.runtime.sendMessage(value);
  if (!result?.ok) throw new Error(result?.error || '操作未完成，请重新打开插件。');
  return result;
}
function updateControls() {
  $('detect-start').disabled = busy || !current?.tab || current.active;
  $('detect-stop').disabled = busy || !current?.active;
  $('clear-captures').disabled = busy || (!current?.captures.length && !current?.blockedCount);
  $('capture-send').disabled = busy || !current?.paired || !selected;
  $('pair-button').disabled = busy;
  $('refresh-status').disabled = busy;
  $('forget-pairing').disabled = busy;
}
function render(data) {
  current = data; if (data.tab) tabId = data.tab.id;
  $('connection-state').textContent = data.connection === 'connected' ? '已连接' : data.paired ? '等待软件' : '未配对';
  $('connection-state').classList.toggle('active', data.connection === 'connected');
  $('pair-code').hidden = data.paired; $('pair-button').hidden = data.paired; $('forget-pairing').hidden = !data.paired;
  $('pair-help').textContent = data.paired ? data.connection === 'connected' ? '已记住本机配对。下次启动软件或浏览器会自动连接。' : '已记住配对，等待映取启动。软件开启后会自动连接，无需再次输入配对码。' : '首次在映取中开启插件连接并输入 8 位配对码，此后会记住本机并自动连接。';
  $('detect-state').textContent = data.active ? '检测中' : '未开启'; $('detect-state').classList.toggle('active', data.active);
  $('page-title').textContent = data.tab?.title || '请在普通网页中打开插件';
  $('capture-count').textContent = `${data.captures.length} 个`;
  $('partial-media-hint').textContent = data.hint || '';
  $('partial-media-hint').hidden = !data.hint;
  if (!data.captures.some(item => item.id === selected)) selected = data.captures[0]?.id || '';
  const list = $('capture-list'); list.replaceChildren();
  for (const item of data.captures) {
    const label = document.createElement('label'); label.className = 'capture-item';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'capture'; radio.value = item.id; radio.checked = selected === item.id; radio.addEventListener('change', () => { selected = item.id; updateControls(); });
    const text = document.createElement('span'); text.className = 'capture-text';
    const kind = document.createElement('span'); kind.className = 'capture-kind'; kind.textContent = kindNames[item.kind] || '视频'; text.append(kind);
    if (item.hasCookie) { const note = document.createElement('span'); note.className = 'cookie-note'; note.textContent = '携带相关会话'; text.append(note); }
    const title = document.createElement('span'); title.className = 'capture-label'; title.textContent = item.label; text.append(title); label.append(radio, text); list.append(label);
  }
  $('empty-state').hidden = data.captures.length > 0;
  updateControls();
}
async function refresh() { render(await call({ type: 'popup:state', tabId })); }
async function reconnect() {
  if (checkingConnection || busy) return;
  checkingConnection = true;
  try { await call({ type: 'bridge:connect' }); await refresh(); }
  catch { /* The next periodic check can retry without losing the pairing. */ }
  finally { checkingConnection = false; }
}
async function action(work) {
  if (busy) return; busy = true; updateControls();
  try { await work(); } catch (error) { message(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  finally { busy = false; await refresh().catch(() => {}); updateControls(); }
}
$('pair-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('pair-button').addEventListener('click', () => action(async () => { await call({ type: 'bridge:pair', code: $('pair-code').value }); $('pair-code').value = ''; message('已连接并记住本机映取，以后无需重复配对。'); }));
$('forget-pairing').addEventListener('click', () => action(async () => { await call({ type: 'bridge:forget' }); message('已忘记本机连接。再次使用时请重新配对。'); }));
$('refresh-status').addEventListener('click', () => action(async () => { const state = await call({ type: 'bridge:status' }); const status = state.capture?.status; message(status === 'analyzing' ? '映取正在分析，请在软件窗口查看进度。' : status === 'failed' ? '上次分析未完成，请在映取中查看原因，重新播放后可再次发送。' : '本机连接正常。'); }));
$('detect-start').addEventListener('click', () => {
  if (busy || !Number.isInteger(tabId)) return;
  // Request permissions directly inside this user gesture. Cross-site media
  // needs both page and CDN access; background still filters enabled tabs only.
  const approval = chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  void action(async () => { if (!await approval) throw new Error('未获得检测权限。你可以稍后再次开启检测。'); await call({ type: 'capture:start', tabId }); message('检测已开启，请刷新网页并播放视频。只记录当前启用的标签页。'); });
});
$('detect-stop').addEventListener('click', () => action(async () => { await call({ type: 'capture:stop', tabId }); selected = ''; message('检测已停止，本标签页的资源和会话请求已清空。'); }));
$('clear-captures').addEventListener('click', () => action(async () => { await call({ type: 'capture:clear', tabId }); selected = ''; message('已清空检测资源。继续播放可重新捕获。'); }));
$('capture-send').addEventListener('click', () => action(async () => { message('正在发送到本机映取…'); const result = await call({ type: 'capture:send', tabId, id: selected }); message(result.message); }));
await refresh().catch(error => message(error.message, true));
void reconnect();
setInterval(() => { if (!busy) void refresh().catch(() => {}); }, 1200);
setInterval(() => { void reconnect(); }, 5000);
