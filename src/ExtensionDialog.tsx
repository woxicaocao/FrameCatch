import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FolderOpen, LoaderCircle, Puzzle, ShieldCheck, X } from 'lucide-react';
import type { DesktopApi, ExtensionBridgeStatus } from '../shared/types';

export default function ExtensionDialog({ api, onClose }: { api: DesktopApi; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<ExtensionBridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    const refresh = () => api.getExtensionBridgeStatus().then(value => { if (alive.current) setStatus(value); }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { alive.current = false; clearInterval(timer); dialog.current?.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, [api]);
  async function action(operation: () => Promise<ExtensionBridgeStatus | void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await operation(); if (result && alive.current) setStatus(result); }
    catch (e) { if (alive.current) setError((e instanceof Error ? e.message : '操作未完成。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { if (alive.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="request-dialog extension-dialog" data-testid="extension-dialog" aria-labelledby="extension-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="request-dialog-header">
      <span className="request-dialog-icon"><Puzzle size={23} strokeWidth={1.5} /></span>
      <div><h2 id="extension-title">连接 Chrome 视频助手</h2><p>在平常使用的浏览器播放，一键把视频发送到映取。</p></div>
      <button data-testid="extension-close" className="icon-button" aria-label="关闭插件连接窗口" onClick={onClose}><X size={19} /></button>
    </header>
    <div className="request-dialog-body">
      <ol className="request-steps">
        <li><span>1</span><p>点击<b>打开插件文件夹</b>，在 Chrome 地址栏输入 <code>chrome://extensions</code>，开启<b>开发者模式</b>，选择<b>加载已解压的扩展程序</b>，选中该文件夹。</p></li>
        <li><span>2</span><p>首次在下方<b>开启插件连接</b>，将配对码输入<b>映取视频助手</b>。配对成功后会记住本机连接，以后启动软件和浏览器即可自动重连。</p></li>
        <li><span>3</span><p>打开作品页，在插件中<b>开始检测当前页</b>，再刷新并播放。选中检测到的完整视频，点击<b>发送到映取</b>。</p></li>
      </ol>
      <button data-testid="extension-folder" className="button button-white extension-folder" disabled={busy} onClick={() => void action(() => api.openExtensionFolder())}><FolderOpen size={16} />打开插件文件夹</button>
      <section className={`extension-pair-box${status?.paired ? ' is-paired' : ''}`} aria-label="插件配对状态">
        <div className="extension-pair-heading"><strong>{status?.running ? status.paired ? '已记住本机配对' : '等待首次配对' : status?.remembered ? '自动连接已暂停' : '插件连接未开启'}</strong><span className={`ready-indicator${status?.running ? '' : ' not-ready'}`}><span />{status?.running ? status.paired ? '自动连接已开启' : '等待连接' : '关闭'}</span></div>
        {status?.running && !status.paired && status.pairingCode && <><label htmlFor="extension-pair-code">本次配对码</label><input id="extension-pair-code" data-testid="extension-code" className="extension-code" value={status.pairingCode} readOnly onFocus={event => event.currentTarget.select()} aria-label="插件配对码" /><p>配对码有效期 5 分钟；过期后点击重新配对。</p></>}
        {status?.running && status?.paired && <p>重启软件、浏览器或重新加载插件后，无需再次输入配对码。只需保持映取运行，在 Chrome 开启当前页检测并发送视频。</p>}
        {!status?.running && <p>{status?.remembered ? '配对关系已保留，点击开启即可恢复连接。' : '开启后仅在本机接受已配对插件发送的视频。'}</p>}
        <div className="extension-pair-actions">
          {!status?.running ? <button data-testid="extension-start" className="button button-primary" disabled={busy || !status} onClick={() => void action(() => api.startExtensionBridge())}>{busy ? <LoaderCircle size={15} className="spin" /> : <Puzzle size={15} />}开启插件连接</button> : <><button data-testid="extension-renew" className="button button-white" disabled={busy} onClick={() => void action(async () => { await api.forgetExtensionPairing(); return api.startExtensionBridge(); })}>重新配对</button><button data-testid="extension-stop" className="text-button" disabled={busy} onClick={() => void action(() => api.stopExtensionBridge())}>暂停自动连接</button></>}
          {(status?.remembered || status?.error) && <button data-testid="extension-forget" className="text-button" disabled={busy} onClick={() => void action(() => api.forgetExtensionPairing())}>忘记配对</button>}
        </div>
      </section>
      {(error || status?.error) && <div className="request-error" role="alert"><CircleAlert size={15} /><p>{error || status?.error}</p></div>}
      <div className="request-privacy"><ShieldCheck size={15} /><div><strong>只记住本机配对，视频请求仍按会话保存</strong><p>插件保存随机配对凭据，软件保存其校验值；网站 Cookie 与检测到的视频地址不进入插件持久存储。可随时暂停连接或忘记配对。</p></div></div>
    </div>
    <footer className="request-dialog-footer"><span>退出后保留配对，下次启动自动恢复连接。</span><button className="button button-white" onClick={onClose}>回到工作台</button></footer>
  </dialog>;
}
