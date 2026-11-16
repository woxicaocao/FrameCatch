import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DownloadTask, ExtensionAnalysisEvent } from '../shared/types';

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('app:snapshot'),
  analyze: url => ipcRenderer.invoke('video:analyze', url),
  normalizeShare: text => ipcRenderer.invoke('share:normalize', text),
  analyzeShare: text => ipcRenderer.invoke('share:analyze', text),
  openSharePage: text => ipcRenderer.invoke('share:open-page', text),
  analyzeInBrowser: url => ipcRenderer.invoke('video:analyze-browser', url),
  analyzeRequest: text => ipcRenderer.invoke('video:analyze-request', text),
  analyzeClipboardRequest: () => ipcRenderer.invoke('video:analyze-clipboard-request'),
  startExtensionBridge: () => ipcRenderer.invoke('extension:start'),
  stopExtensionBridge: () => ipcRenderer.invoke('extension:stop'),
  forgetExtensionPairing: () => ipcRenderer.invoke('extension:forget'),
  getExtensionBridgeStatus: () => ipcRenderer.invoke('extension:status'),
  openExtensionFolder: () => ipcRenderer.invoke('extension:open-folder'),
  onExtensionAnalysis: listener => {
    const callback = (_event: unknown, event: ExtensionAnalysisEvent) => listener(event);
    ipcRenderer.on('extension:analysis', callback);
    return () => ipcRenderer.removeListener('extension:analysis', callback);
  },
  cancelAnalysis: () => ipcRenderer.invoke('video:cancel-analysis'),
  enqueue: requests => ipcRenderer.invoke('task:enqueue', requests),
  cancelTask: id => ipcRenderer.invoke('task:cancel', id),
  retryTask: id => ipcRenderer.invoke('task:retry', id),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  selectOutputDir: () => ipcRenderer.invoke('dialog:output-dir'),
  selectCookieFile: () => ipcRenderer.invoke('dialog:cookie-file'),
  openOutput: id => ipcRenderer.invoke('shell:output', id),
  openLog: id => ipcRenderer.invoke('shell:log', id),
  cleanupTask: id => ipcRenderer.invoke('task:cleanup', id),
  onTasksChanged: listener => {
    const callback = (_event: unknown, tasks: DownloadTask[]) => listener(tasks);
    ipcRenderer.on('tasks:changed', callback);
    return () => ipcRenderer.removeListener('tasks:changed', callback);
  },
};
contextBridge.exposeInMainWorld('desktopApi', Object.freeze(api));
