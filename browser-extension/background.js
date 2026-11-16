import { createController } from './controller.js';

const controller = createController(chrome);
const ignore = promise => promise.catch(() => {});
ignore(controller.reconnect());
chrome.runtime.onStartup.addListener(() => { ignore(controller.reconnect()); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Web pages, content scripts and other extensions are not message senders.
  if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== chrome.runtime.getURL('popup.html')) {
    respond({ ok: false, error: '已拒绝来自未知页面的操作。' }); return false;
  }
  controller.handle(message).then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : '操作未完成，请重试。' }));
  return true;
});
chrome.webRequest.onBeforeSendHeaders.addListener(details => { ignore(controller.beforeHeaders(details)); }, { urls: ['http://*/*', 'https://*/*'] }, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(details => { ignore(controller.receivedHeaders(details)); }, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener(details => { ignore(controller.forgetRequest(details.requestId)); }, { urls: ['http://*/*', 'https://*/*'] });
chrome.webRequest.onBeforeRedirect.addListener(details => { ignore(controller.forgetRequest(details.requestId)); }, { urls: ['http://*/*', 'https://*/*'] });
chrome.tabs.onUpdated.addListener((id, change) => { ignore(controller.updatedTab(id, change)); });
chrome.tabs.onRemoved.addListener(id => { ignore(controller.removedTab(id)); });
chrome.alarms.create('framecatch-expire', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'framecatch-expire') ignore(controller.prune()); });
