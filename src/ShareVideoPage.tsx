import { AppWindow, ArrowRight, CircleAlert, ExternalLink, Link2, LoaderCircle, Puzzle, ShieldCheck, X } from 'lucide-react';
import type { ShareLink } from '../shared/types';

interface Props {
  text: string;
  onChange: (value: string) => void;
  link: ShareLink | null;
  checking: boolean;
  inputError: string;
  analysisError: string;
  ready: boolean;
  busy: boolean;
  analyzing: boolean;
  cancelling: boolean;
  onAnalyze: () => void;
  onCancel: () => void;
  onBrowser: () => void;
  onOpenPage: () => void;
  onExtension: () => void;
}

export default function ShareVideoPage(props: Props) {
  const { text, onChange, link, checking, inputError, analysisError, ready, busy, analyzing, cancelling, onAnalyze, onCancel, onBrowser, onOpenPage, onExtension } = props;
  return <section className="card link-card share-card" aria-labelledby="share-heading">
    <div className="section-heading"><div className="heading-label"><span className="step-number">01</span><h2 id="share-heading">粘贴口令或分享链接</h2></div><span className="share-platforms"><span>抖音</span><span>视频号</span></span></div>
    <p className="share-intro">整段分享文案也可以直接粘贴，无需自己提取网址。每次分析一条作品。</p>
    <div className="share-input-wrap">
      <textarea data-testid="share-input" aria-label="抖音或视频号分享内容" autoComplete="off" spellCheck={false} maxLength={32768} value={text} onChange={event => onChange(event.target.value)} placeholder={'粘贴抖音分享口令、作品链接，或视频号分享链接…\n例如：复制打开抖音，看看… https://v.douyin.com/…'} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && ready && link && !busy) { event.preventDefault(); onAnalyze(); } }} />
      {text && <button data-testid="share-clear" className="icon-button share-clear" title="清空分享内容" aria-label="清空分享内容" onClick={() => onChange('')}><X size={17} /></button>}
    </div>
    <div className="share-input-footer"><span>{checking ? <><LoaderCircle size={13} className="spin" />正在识别分享链接…</> : link ? <><Link2 size={13} />已识别{link.platform === 'douyin' ? '抖音' : '视频号'}作品</> : <><ShieldCheck size={13} />仅在你点击分析时获取视频</>}</span>{analyzing ? <button data-testid="share-cancel" className="button button-primary" disabled={cancelling} onClick={onCancel}><LoaderCircle size={16} className="spin" />{cancelling ? '正在取消…' : '取消分析'}</button> : <button data-testid="share-analyze" className="button button-primary" disabled={!ready || !link || checking || busy} onClick={onAnalyze}>分析分享内容<ArrowRight size={16} /></button>}</div>
    {link && <div className="share-source" data-testid="share-source"><span>{link.platform === 'douyin' ? '抖音' : '视频号'} · 作品网址</span><p data-testid="share-source-url" title={link.url}>{link.url}</p></div>}
    {inputError && <p data-testid="share-input-error" className="share-input-error" role="alert"><CircleAlert size={14} />{inputError}</p>}
    <div className="share-assist-actions"><button data-testid="share-open-page" className="button button-white" disabled={!ready || !link || busy} onClick={onOpenPage}><ExternalLink size={15} />打开原网页</button><button data-testid="share-browser" className="button button-white" disabled={!ready || !link || busy} onClick={onBrowser}><AppWindow size={15} />浏览器辅助分析</button><button data-testid="share-extension" className="button button-white" disabled={!ready || busy} onClick={onExtension}><Puzzle size={15} />连接浏览器插件</button></div>
    <div className="share-availability"><ShieldCheck size={14} /><p>{link?.platform === 'wechat-channels' ? '视频号分享页可能仅提供二维码预览。请先打开原网页；若只有二维码，请在微信内观看，该预览页暂不能下载。' : '需要登录或网站验证时，先在可正常播放的浏览器打开作品，再用插件发送媒体。请确认原网页中的作品与你要保存的视频一致。'}</p></div>
    {analyzing && <div className="analysis-status browser-analysis-status" role="status"><span className="pulse-dot" /><div><strong>{cancelling ? '正在结束分析，请稍候…' : '正在获取分享视频及可用画质'}</strong><p>分析完成后确认作品、选择画质，再点击下载。</p></div></div>}
    {analysisError && <div data-testid="share-analysis-error" className="inline-error" role="alert"><CircleAlert size={16} /><div><strong>分享视频分析未完成</strong><span>{analysisError}</span></div></div>}
    {busy && !analyzing && <p className="share-wait" role="status">正在准备或等待其他分析，请稍候。</p>}
  </section>;
}
