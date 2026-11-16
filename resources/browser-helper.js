(() => {
  'use strict';
  const api = window.browserHelper;
  const elements = Object.fromEntries(['back', 'reload', 'cancel', 'candidate', 'select', 'select-label', 'page-title', 'page-origin', 'page-state', 'loading-label', 'count', 'message'].map((id) => [id, document.getElementById(id)]));
  let state = null;
  let selected = '';
  let busy = false;
  let optionsSignature = '';
  let receivedEvent = false;
  let localError = '';

  // All strings received from websites are rendered as text, never HTML.
  function text(value, fallback = '') {
    const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return (result || fallback).replace(/https?:\/\/[^\s]+/gi, (url) => {
      try { return new URL(url).origin; } catch { return '网页地址'; }
    }).slice(0, 600);
  }

  function origin(value) {
    try { const parsed = new URL(value); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; }
    catch { return ''; }
  }

  function candidates() {
    return Array.isArray(state?.candidates) ? state.candidates.filter((item) => item && typeof item.id === 'string' && ['hls', 'dash', 'mp4'].includes(item.kind)) : [];
  }

  function render() {
    const media = candidates();
    if (!media.some((item) => item.id === selected)) selected = media[0]?.id || '';
    const signature = JSON.stringify(media.map((item) => [item.id, item.label, item.kind]));
    if (signature !== optionsSignature) {
      optionsSignature = signature;
      const options = media.length ? media.map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.kind.toUpperCase()} · ${text(item.label, '视频资源')}`;
        return option;
      }) : [Object.assign(document.createElement('option'), { value: '', textContent: '等待检测，请在下方播放视频…' })];
      elements.candidate.replaceChildren(...options);
    }
    elements.candidate.value = selected;
    elements.candidate.disabled = !api || !media.length || busy;
    elements.select.disabled = !api || !selected || busy;
    elements.select.classList.toggle('busy', busy);
    elements['select-label'].textContent = busy ? '正在分析…' : '分析所选资源';
    elements.count.textContent = String(media.length);
    elements.back.disabled = !api || busy;
    elements.reload.disabled = !api || busy;
    elements['page-title'].textContent = text(state?.title, '在下方播放目标视频');
    elements['page-origin'].textContent = origin(state?.pageUrl);
    elements['page-state'].classList.toggle('loading', Boolean(state?.loading));
    elements['loading-label'].textContent = state?.loading ? '网页加载中' : media.length ? '已检测到媒体' : '等待播放';
    const message = localError || text(state?.message) || (media.length ? '选择需要的视频资源，然后点击「分析所选资源」返回主窗口选择画质。' : '请在下方播放目标视频；登录或网站验证请手动完成。部分站点的媒体可能无法提取。');
    elements.message.textContent = message;
    elements.message.title = message;
    elements.message.classList.toggle('error', Boolean(localError));
  }

  async function action(fn) {
    try { localError = ''; await fn(); }
    catch (error) { localError = text(error?.message || error, '操作未完成，请重试。'); }
    finally { render(); }
  }

  elements.candidate.addEventListener('change', () => { selected = elements.candidate.value; render(); });
  elements.back.addEventListener('click', () => { if (api && !busy) void action(() => api.back()); });
  elements.reload.addEventListener('click', () => { if (api && !busy) void action(() => api.reload()); });
  elements.cancel.addEventListener('click', () => { if (api) void action(() => api.cancel()); else window.close(); });
  elements.select.addEventListener('click', async () => {
    if (!api || !selected || busy || !candidates().some((item) => item.id === selected)) return;
    busy = true;
    localError = '';
    render();
    try { await api.select(selected); }
    catch (error) { localError = text(error?.message || error, '媒体分析未完成，请选择其他资源重试。'); }
    finally { busy = false; render(); }
  });

  if (!api) {
    localError = '辅助窗口尚未连接，请关闭后从主窗口重新打开。';
    render();
    return;
  }
  const unsubscribe = api.onState((next) => { receivedEvent = true; state = next; localError = ''; render(); });
  api.getState().then((next) => { if (!receivedEvent) state = next; render(); }).catch((error) => { localError = text(error?.message || error); render(); });
  window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  render();
})();
