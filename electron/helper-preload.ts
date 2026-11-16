import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('browserHelper', Object.freeze({
  getState: () => ipcRenderer.invoke('helper:state'),
  select: (id: string) => ipcRenderer.invoke('helper:select', id),
  cancel: () => ipcRenderer.send('helper:cancel'),
  reload: () => ipcRenderer.send('helper:reload'),
  back: () => ipcRenderer.send('helper:back'),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('helper:changed', handler);
    return () => ipcRenderer.removeListener('helper:changed', handler);
  },
}));
