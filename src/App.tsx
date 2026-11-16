import { useEffect, useRef, useState } from 'react';
import ExtensionDialog from './ExtensionDialog';
import ShareVideoPage from './ShareVideoPage';
import {
  ArrowDown, ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronDown,
  AppWindow, CircleAlert, ClipboardPaste, Clock3, Download, FileText, Film, Folder,
  FolderOpen, Gauge, HardDrive, Layers3, Link2, LoaderCircle, LockKeyhole,
  Music2, Plus, Puzzle, RotateCcw, Settings2, Share2, ShieldCheck, Sparkles, Trash2, Video, X,
} from 'lucide-react';
import type {
  AnalysisResult, AppSettings, AppSnapshot, DesktopApi, DownloadTask,
  ShareLink, TaskStatus, VideoEntry, VideoFormat,
} from '../shared/types';

type Page = 'workspace' | 'social' | 'history' | 'settings';
type AnalysisMode = 'standard' | 'browser' | 'request' | 'extension' | 'share' | 'share-browser';
type Selection = { selected: boolean; formatId: string };
type Notice = { kind: 'success' | 'error' | 'info'; text: string };

const STATUS: Record<TaskStatus, string> = {
  queued: '等待下载', downloading: '正在下载', merging: '正在合并', verifying: '正在校验',
  completed: '下载完成', failed: '下载失败', cancelled: '已取消', interrupted: '下载中断',
};
const ACTIVE = new Set<TaskStatus>(['queued', 'downloading', 'merging', 'verifying']);

export function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '时长未知';
  const value = Math.floor(seconds);
  const s = String(value % 60).padStart(2, '0');
  const m = Math.floor(value / 60) % 60;
  const h = Math.floor(value / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error: /, '');
}

function requestErrorText(error: unknown): string {
  const message = errorText(error);
  if (/取消|cancelled|canceled/i.test(message)) return '本次请求分析已取消。可以重新复制视频请求后再试。';
  if (/剪贴板.*(?:空|没有)|clipboard.*(?:empty|text)/i.test(message)) return '剪贴板中没有可分析的请求文本。请在 Chrome 网络面板复制媒体请求后重试。';
  if (/401|403|forbidden|unauthorized/i.test(message)) return '网站没有接受这条视频请求。请使用与 Chrome 相同的代理和网络，重新播放并复制最新请求后重试。';
  if (/timeout|timed out|ECONN|网络|超时/i.test(message)) return '连接媒体资源未完成。请检查软件与 Chrome 的代理和网络是否一致，再复制最新请求重试。';
  if (/user.agent|referer|请求头|来源页/i.test(message)) return '视频请求缺少必要的浏览器信息。请从 Chrome 网络面板使用“复制为 cURL”，保留浏览器信息与来源页。';
  return '这条请求暂时无法分析。请确认复制的是 m3u8、mpd、mp4 或 Vimeo master.json 媒体请求，优先使用“复制为 cURL（bash）”后重试。';
}

function inputSource(value: string) { return normalizeUrl(value) ?? value.trim(); }
function isSocialPageUrl(value: string) {
  try { return /(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/.test(new URL(value).hostname) || /(?:^|\.)weixin\.qq\.com$/.test(new URL(value).hostname); } catch { return false; }
}

function entryKey(entry: VideoEntry, index: number) { return `${index}:${entry.id}`; }
function availableFormats(entry: VideoEntry): VideoFormat[] {
  const formats = entry.formats ?? [];
  return formats.some((f) => f.id === 'best') ? formats : [{ id: 'best', label: '最高画质 · 自动选择', ext: 'auto' }, ...formats];
}
function safeImage(url?: string) { return url && /^https?:\/\//i.test(url) ? url : undefined; }
function platformLabel(value?: string) {
  if (!value || /generic|html5/i.test(value)) return '网页视频';
  if (/bilibili/i.test(value)) return 'B 站';
  if (/youtube/i.test(value)) return 'YouTube';
  if (/vimeo/i.test(value)) return 'Vimeo';
  if (/xinpianchang/i.test(value)) return '新片场';
  if (/douyin/i.test(value)) return '抖音';
  if (/wechat.?channels|weixin|视频号/i.test(value)) return '视频号';
  return value;
}

function Thumbnail({ src, title, duration, small = false }: { src?: string; title: string; duration?: number; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <div className={`thumbnail${small ? ' thumbnail-small' : ''}`}>
    {safeImage(src) && !failed ? <img src={src} alt={title} onError={() => setFailed(true)} referrerPolicy="no-referrer" /> : <Film size={small ? 21 : 34} strokeWidth={1.3} />}
    {!small && duration !== undefined && <span className="duration">{formatDuration(duration)}</span>}
  </div>;
}

export default function App() {
  const api = window.desktopApi;
  const [page, setPage] = useState<Page>('workspace');
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [bootError, setBootError] = useState('');
  const [url, setUrl] = useState('');
  const [shareText, setShareText] = useState('');
  const [shareLink, setShareLink] = useState<ShareLink | null>(null);
  const [shareChecking, setShareChecking] = useState(false);
  const [shareInputError, setShareInputError] = useState('');
  const [shareStarting, setShareStarting] = useState(false);
  const [analysisScope, setAnalysisScope] = useState<'workspace' | 'social'>('workspace');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('standard');
  const [cancelling, setCancelling] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [standardFailure, setStandardFailure] = useState<{ url: string; message: string } | null>(null);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [requestDialogOpening, setRequestDialogOpening] = useState(false);
  const [extensionDialogOpen, setExtensionDialogOpen] = useState(false);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [enqueueing, setEnqueueing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [historyFilter, setHistoryFilter] = useState('all');
  const sequence = useRef(0);
  const analyzingRef = useRef(false);
  const cancellingRef = useRef(false);
  const activeRequestRef = useRef<Promise<AnalysisResult> | null>(null);
  const activeUrlRef = useRef<string | null>(null);
  const completedUrlRef = useRef<string | null>(null);
  const completedInputRef = useRef<string | null>(null);
  const requestDialogOpeningRef = useRef(false);
  const cancellationChain = useRef<Promise<void>>(Promise.resolve());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extensionActive = useRef(false);
  const shareRevision = useRef(0);
  const shareStartingRef = useRef(false);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const unsubscribe = api.onTasksChanged((tasks) => {
      if (mounted) setSnapshot((current) => current ? { ...current, tasks } : current);
    });
    api.getSnapshot().then((value) => { if (mounted) setSnapshot(value); }).catch((e) => { if (mounted) setBootError(errorText(e)); });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    let mounted = true;
    const revision = shareRevision.current;
    setShareLink(null); setShareInputError('');
    if (!shareText.trim()) { setShareChecking(false); return; }
    if (typeof api?.normalizeShare !== 'function') { setShareChecking(false); setShareInputError('请启动新版映取，以识别抖音或视频号分享内容。'); return; }
    setShareChecking(true);
    const timer = setTimeout(() => {
      api.normalizeShare(shareText).then(link => { if (mounted && revision === shareRevision.current) setShareLink(link); })
        .catch(error => { if (mounted && revision === shareRevision.current) setShareInputError(errorText(error)); })
        .finally(() => { if (mounted && revision === shareRevision.current) setShareChecking(false); });
    }, 160);
    return () => { mounted = false; clearTimeout(timer); };
  }, [shareText, api]);

  useEffect(() => {
    if (typeof api?.onExtensionAnalysis !== 'function') return;
    return api.onExtensionAnalysis(event => {
      if (event.status === 'analyzing') {
        ++sequence.current;
        extensionActive.current = true;
        analyzingRef.current = true;
        cancellingRef.current = false;
        activeUrlRef.current = event.sourceUrl;
        completedUrlRef.current = null;
        completedInputRef.current = null;
        const scope = isSocialPageUrl(event.sourceUrl) ? 'social' : 'workspace';
        setPage(scope); setAnalysisScope(scope); setRequestDialogOpen(false); setExtensionDialogOpen(false);
        if (scope === 'social') { ++shareRevision.current; setShareText(event.sourceUrl); }
        setUrl(event.sourceUrl); setAnalysisMode('extension'); setAnalyzing(true); setCancelling(false);
        setAnalysis(null); setAnalysisError(''); setStandardFailure(null); setSelections({});
      } else if (extensionActive.current) {
        extensionActive.current = false;
        analyzingRef.current = false; activeUrlRef.current = null; setAnalyzing(false); setCancelling(false);
        if (event.status === 'completed' && event.result) {
          const result = event.result;
          setAnalysis(result);
          setSelections(Object.fromEntries(result.entries.map((entry, index) => [entryKey(entry, index), { selected: result.entries.length === 1, formatId: 'best' }])));
          completedUrlRef.current = normalizeUrl(event.sourceUrl); completedInputRef.current = event.sourceUrl;
        } else setAnalysisError(event.error || '插件视频分析未完成，请重新播放并发送。');
      }
    });
  }, [api]);

  const showNotice = (kind: Notice['kind'], text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ kind, text });
    noticeTimer.current = setTimeout(() => setNotice(null), 6500);
  };

  const runAction = async (action: () => Promise<unknown>, success?: string) => {
    try { await action(); if (success) showNotice('success', success); }
    catch (e) { showNotice('error', errorText(e)); }
  };

  const requestAnalysisCancellation = () => {
    const next = cancellationChain.current.catch(() => {}).then(() => api?.cancelAnalysis());
    cancellationChain.current = next;
    return next;
  };

  const performAnalysis = async (source: string, mode: AnalysisMode, operation: () => Promise<AnalysisResult>) => {
    extensionActive.current = false;
    const current = ++sequence.current;
    const shouldCancel = analyzingRef.current;
    const previousRequest = activeRequestRef.current;
    let request: Promise<AnalysisResult> | null = null;
    analyzingRef.current = true;
    cancellingRef.current = false;
    activeUrlRef.current = source;
    completedUrlRef.current = null;
    completedInputRef.current = null;
    setAnalyzing(true);
    setAnalysisMode(mode);
    setAnalysisScope(mode === 'share' || mode === 'share-browser' ? 'social' : 'workspace');
    setCancelling(false);
    setAnalysis(null);
    setAnalysisError('');
    if (mode === 'standard' || standardFailure?.url !== source) setStandardFailure(null);
    setSelections({});
    try {
      try {
        if (shouldCancel) await requestAnalysisCancellation();
        else await cancellationChain.current.catch(() => {});
      } finally { if (previousRequest) await previousRequest.catch(() => {}); }
      if (sequence.current !== current) return;
      request = operation();
      activeRequestRef.current = request;
      const result = await request;
      if (sequence.current !== current) return;
      setAnalysis(result);
      setSelections(Object.fromEntries(result.entries.map((entry, index) => [entryKey(entry, index), { selected: result.entries.length === 1, formatId: 'best' }])));
      completedUrlRef.current = normalizeUrl(source);
      completedInputRef.current = source;
      if (!result.entries.length) {
        const message = mode === 'share' ? '这条分享暂未找到可下载视频。请在原网页确认可播放，再尝试浏览器辅助或插件。' : mode === 'request' ? '请求中没有找到可下载的视频。请在 Chrome 播放视频后，重新复制实际媒体请求再试。' : mode === 'browser' || mode === 'share-browser' ? '辅助窗口没有找到可下载的媒体。可以重新打开，在页面中实际播放目标视频后再检测。' : '这个页面没有找到可下载的视频。可以尝试视频的独立播放页，或使用浏览器辅助分析。';
        setAnalysisError(message);
        if (mode === 'standard') setStandardFailure({ url: source, message });
      } else if (mode === 'request') {
        setRequestDialogOpen(false);
      }
    } catch (e) {
      if (sequence.current === current) {
        const message = mode === 'request' ? requestErrorText(e) : errorText(e);
        setAnalysisError(message);
        if (mode === 'standard') setStandardFailure({ url: source, message });
      }
    }
    finally {
      if (activeRequestRef.current === request) activeRequestRef.current = null;
      if (sequence.current === current) { setAnalyzing(false); setCancelling(false); analyzingRef.current = false; cancellingRef.current = false; activeUrlRef.current = null; }
    }
  };

  const runAnalysis = async (raw: string, force = false, mode: 'standard' | 'browser' = 'standard') => {
    const validUrl = normalizeUrl(raw);
    if (!validUrl) { setAnalysisError('请输入完整的 http 或 https 视频网址。'); return; }
    if (!api) { setAnalysisError('请在映取桌面软件中分析视频；浏览器预览无法调用本机下载组件。'); return; }
    if (mode === 'browser' && typeof api.analyzeInBrowser !== 'function') { setAnalysisError('浏览器辅助组件尚未加载，请重新启动软件后重试。'); return; }
    if (analyzingRef.current && activeUrlRef.current === validUrl) return;
    if (!force && completedUrlRef.current === validUrl) return;
    setUrl(validUrl);
    await performAnalysis(validUrl, mode, () => mode === 'browser' ? api.analyzeInBrowser(validUrl) : api.analyze(validUrl));
  };

  const runRequestAnalysis = async (kind: 'clipboard' | 'paste', text = '') => {
    if (!api || (analyzingRef.current && analysisMode === 'request')) return;
    if ((kind === 'clipboard' && typeof api.analyzeClipboardRequest !== 'function') || (kind === 'paste' && typeof api.analyzeRequest !== 'function')) {
      setAnalysisMode('request');
      setAnalysisError('请求导入组件尚未加载，请重新启动软件后重试。');
      return;
    }
    if (kind === 'paste' && !text.trim()) return;
    await performAnalysis(inputSource(url), 'request', () => kind === 'clipboard' ? api.analyzeClipboardRequest() : api.analyzeRequest(text));
  };

  const cancelAnalysis = async () => {
    if (!analyzingRef.current) return;
    if (cancellingRef.current) {
      await cancellationChain.current.catch(() => {});
      if (activeRequestRef.current) await activeRequestRef.current.catch(() => {});
      return;
    }
    const current = ++sequence.current;
    extensionActive.current = false;
    const request = activeRequestRef.current;
    cancellingRef.current = true;
    setCancelling(true);
    try {
      if (api) await requestAnalysisCancellation();
    } catch (e) { if (sequence.current === current) showNotice('error', errorText(e)); }
    finally {
      if (request) await request.catch(() => {});
      if (sequence.current === current) {
        analyzingRef.current = false;
        cancellingRef.current = false;
        activeUrlRef.current = null;
        setAnalyzing(false);
        setCancelling(false);
      }
    }
  };

  const openRequestDialog = async () => {
    if (!api || !snapshot || requestDialogOpeningRef.current) return;
    requestDialogOpeningRef.current = true;
    setRequestDialogOpening(true);
    try {
      if (analyzingRef.current) await cancelAnalysis();
      setRequestDialogOpen(true);
    } finally { requestDialogOpeningRef.current = false; setRequestDialogOpening(false); }
  };

  const closeRequestDialog = () => {
    setRequestDialogOpen(false);
    if (analysisMode === 'request' && analyzingRef.current) void cancelAnalysis();
  };

  const changeUrl = (value: string) => {
    setUrl(value);
    setAnalysisError('');
    const normalized = inputSource(value);
    if (normalized !== completedInputRef.current) {
      setAnalysis(null);
      setSelections({});
      completedUrlRef.current = null;
      completedInputRef.current = null;
    }
    if (normalized !== standardFailure?.url) setStandardFailure(null);
    if (analyzingRef.current && !cancellingRef.current && normalized !== activeUrlRef.current) void cancelAnalysis();
  };

  const changeShareText = (value: string) => {
    ++shareRevision.current;
    setShareText(value); setShareLink(null); setShareInputError('');
    if (analysisScope === 'social') {
      setAnalysis(null); setAnalysisError(''); setSelections({});
      completedUrlRef.current = null; completedInputRef.current = null;
      if (analyzingRef.current && !cancellingRef.current) void cancelAnalysis();
    }
  };

  const runShareAnalysis = async (browser = false) => {
    if (!api || shareStartingRef.current || analyzingRef.current || !shareText.trim()) return;
    if (typeof api.normalizeShare !== 'function' || typeof api.analyzeShare !== 'function') { setShareInputError('分享解析组件尚未加载，请重新启动新版映取。'); return; }
    const raw = shareText, revision = shareRevision.current, requestSequence = sequence.current;
    shareStartingRef.current = true; setShareStarting(true); setShareInputError('');
    try {
      const link = await api.normalizeShare(raw);
      if (revision !== shareRevision.current || requestSequence !== sequence.current) return;
      setShareLink(link); setUrl(link.url);
      await performAnalysis(link.url, browser ? 'share-browser' : 'share', () => browser ? api.analyzeInBrowser(link.url) : api.analyzeShare(raw));
    } catch (error) { if (revision === shareRevision.current) setShareInputError(errorText(error)); }
    finally { shareStartingRef.current = false; setShareStarting(false); }
  };

  const enqueueSelected = async () => {
    if (!api || !analysis || enqueueing) return;
    const chosen = analysis.entries.flatMap((video, index) => {
      const choice = selections[entryKey(video, index)];
      if (!choice?.selected) return [];
      return [{ video, formatId: choice.formatId, formatLabel: availableFormats(video).find((format) => format.id === choice.formatId)?.label ?? '最高画质' }];
    });
    if (!chosen.length) return;
    setEnqueueing(true);
    try {
      const tasks = await api.enqueue(chosen);
      setSnapshot((current) => current ? { ...current, tasks: [...current.tasks.filter((task) => !tasks.some((added) => added.id === task.id)), ...tasks] } : current);
      showNotice('success', `已将 ${chosen.length} 个视频加入下载队列。`);
      if (analysis.entries.length > 1) setSelections((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, selected: false }])));
    } catch (e) { showNotice('error', errorText(e)); }
    finally { setEnqueueing(false); }
  };

  const sortedTasks = [...(snapshot?.tasks ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeCount = sortedTasks.filter((task) => ACTIVE.has(task.status)).length;
  const completeCount = sortedTasks.filter((task) => task.status === 'completed').length;
  const missingDependencies = snapshot?.dependencies.filter((dependency) => !dependency.available) ?? [];
  const ready = Boolean(api && snapshot && !missingDependencies.length);
  const visibleAnalysis = (page === 'social' ? analysisScope === 'social' : analysisScope === 'workspace') ? analysis : null;
  const selectedCount = analysis?.entries.filter((entry, index) => selections[entryKey(entry, index)]?.selected).length ?? 0;
  const visibleHistory = sortedTasks.filter((task) => historyFilter === 'all' || (historyFilter === 'completed' ? task.status === 'completed' : ['failed', 'cancelled', 'interrupted'].includes(task.status)));

  const onTaskAction = (action: 'cancel' | 'retry' | 'open' | 'log' | 'cleanup', task: DownloadTask) => {
    if (!api) return;
    if (action === 'cancel') void runAction(() => api.cancelTask(task.id));
    if (action === 'retry') void runAction(() => api.retryTask(task.id), '已重新加入队列，将尝试继续未完成的下载。');
    if (action === 'open') void runAction(() => api.openOutput(task.id));
    if (action === 'log') void runAction(() => api.openLog(task.id));
    if (action === 'cleanup') void runAction(async () => {
      const result = await api.cleanupTask(task.id);
      if (!result.cancelled) showNotice('success', `已清理 ${result.files} 个临时文件（逻辑大小 ${formatBytes(result.bytes)}）。`);
    });
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="#" className="brand" aria-label="映取首页" onClick={(event) => { event.preventDefault(); setPage('workspace'); }}>
        <span className="brand-mark"><Film size={27} strokeWidth={1.7} /></span>
        <span><strong>映取<span className="brand-dot">.</span></strong><small>FrameCatch</small></span>
      </a>
      <div className="nav-caption">你的影像工具箱</div>
      <nav className="navigation" aria-label="主导航">
        <button data-testid="workbench-nav" className={page === 'workspace' ? 'nav-item selected' : 'nav-item'} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => setPage('workspace')}><ArrowDownToLine size={19} /><span>下载工作台</span>{activeCount > 0 && <b className="nav-count">{activeCount}</b>}</button>
        <button data-testid="social-nav" className={page === 'social' ? 'nav-item selected' : 'nav-item'} aria-current={page === 'social' ? 'page' : undefined} onClick={() => setPage('social')}><Share2 size={19} /><span>抖音 / 视频号</span></button>
        <button data-testid="history-nav" className={page === 'history' ? 'nav-item selected' : 'nav-item'} aria-current={page === 'history' ? 'page' : undefined} onClick={() => setPage('history')}><Clock3 size={19} /><span>下载记录</span></button>
        <button data-testid="settings-nav" className={page === 'settings' ? 'nav-item selected' : 'nav-item'} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}><Settings2 size={19} /><span>设置</span></button>
      </nav>
      <div className="sidebar-note"><span className="note-icon"><HardDrive size={20} strokeWidth={1.5} /></span><strong>轻装出发，随处使用</strong><p>免安装 · 本机下载<br />把完整影像留在身边。</p><span className="portable-tag"><span /> 便携版</span></div>
      <div className="sidebar-bottom"><span className="version">FrameCatch {snapshot ? `v${snapshot.appVersion}` : ''}</span><span className="local-tag"><ShieldCheck size={12} /> 本地运行</span></div>
    </aside>

    <main className="main-content">
      <header className="page-header">
        <div><div className="eyebrow">FRAMECATCH <span>/</span> {page === 'workspace' ? 'WORKSPACE' : page === 'social' ? 'SHARE VIDEO' : page === 'history' ? 'LIBRARY' : 'PREFERENCES'}</div><h1>{page === 'workspace' ? '下载工作台' : page === 'social' ? '抖音 / 视频号' : page === 'history' ? '下载记录' : '软件设置'}</h1><p>{page === 'workspace' ? '一条链接，让精彩完整落地。' : page === 'social' ? '分享里的好视频，完整保存到本机。' : page === 'history' ? '每一次保存，都有迹可循。' : '按照你的习惯，准备下一次下载。'}</p></div>
        <button className="button button-white folder-button" onClick={() => api && void runAction(() => api.openOutput())} disabled={!api || !snapshot}><FolderOpen size={17} /> 打开下载文件夹</button>
      </header>

      {!api && <div className="alert alert-warning" role="status"><CircleAlert size={18} /><div><strong>当前为界面预览</strong><span>请启动映取桌面程序，以使用链接分析、本机下载与目录选择。</span></div></div>}
      {bootError && <div className="alert alert-error" role="alert"><CircleAlert size={18} /><div><strong>软件初始化失败</strong><span>{bootError}</span></div></div>}
      {api && !snapshot && !bootError && <div className="loading-strip"><LoaderCircle size={17} className="spin" /> 正在检查本机下载组件…</div>}
      {missingDependencies.length > 0 && <div className="alert alert-error" role="alert"><CircleAlert size={18} /><div><strong>下载组件不完整</strong><span>缺少 {missingDependencies.map((dependency) => dependency.name).join('、')}，请在设置中查看路径。</span></div><button className="text-button" onClick={() => setPage('settings')}>查看设置 <ArrowRight size={14} /></button></div>}

      {(page === 'workspace' || page === 'social') && <>
        {page === 'social' && <ShareVideoPage text={shareText} onChange={changeShareText} link={shareLink} checking={shareChecking} inputError={shareInputError} analysisError={analysisScope === 'social' ? analysisError : ''} ready={ready} busy={analyzing || shareStarting} analyzing={analyzing && analysisScope === 'social'} cancelling={cancelling} onAnalyze={() => void runShareAnalysis()} onCancel={() => void cancelAnalysis()} onBrowser={() => void runShareAnalysis(true)} onOpenPage={() => api && void runAction(() => api.openSharePage(shareText))} onExtension={() => setExtensionDialogOpen(true)} />}
        {page === 'workspace' && <section className="card link-card" aria-labelledby="link-heading">
          <div className="section-heading"><div className="heading-label"><span className="step-number">01</span><h2 id="link-heading">添加视频链接</h2></div><span className={`ready-indicator${ready ? '' : ' not-ready'}`}><span />{ready ? '引擎已就绪' : api ? '检查下载环境' : '桌面版可用'}</span></div>
          <div className={`url-field${analyzing ? ' is-analyzing' : ''}`}>
            <Link2 size={21} className="url-icon" />
            <input data-testid="url-input" aria-label="视频网址" value={url} placeholder="粘贴视频网址，自动分析可用画质…" autoComplete="off" spellCheck={false} onChange={(event) => changeUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runAnalysis(url, true); } }} onPaste={(event) => {
              const pasted = event.clipboardData.getData('text');
              const field = event.currentTarget;
              const next = `${field.value.slice(0, field.selectionStart ?? 0)}${pasted}${field.value.slice(field.selectionEnd ?? field.value.length)}`;
              if (normalizeUrl(next)) { event.preventDefault(); setUrl(next.trim()); void runAnalysis(next); }
            }} />
            {url && <button className="icon-button clear-url" aria-label="清空网址" title="清空网址" onClick={() => { setUrl(''); setAnalysis(null); setAnalysisError(''); setStandardFailure(null); completedUrlRef.current = null; completedInputRef.current = null; void cancelAnalysis(); }}><X size={17} /></button>}
            {analyzing ? <button data-testid="cancel-analysis-button" className="button button-primary analyze-button" disabled={cancelling} onClick={() => void cancelAnalysis()}><LoaderCircle size={17} className="spin" /> {cancelling ? '正在取消…' : '取消分析'}</button> : <button data-testid="analyze-button" className="button button-primary analyze-button" disabled={!url.trim() || !api || !snapshot} onClick={() => void runAnalysis(url, true)}>分析链接 <ArrowRight size={17} /></button>}
          </div>
          <div className="analysis-methods"><button data-testid="browser-analyze-button" className="button button-white browser-analyze-button" disabled={!normalizeUrl(url) || !api || !snapshot || analyzing} onClick={() => void runAnalysis(url, true, 'browser')}><AppWindow size={16} /> 浏览器辅助分析</button><button data-testid="request-import-button" className="button button-white request-import-button" disabled={!api || !snapshot || requestDialogOpening} onClick={() => void openRequestDialog()}>{requestDialogOpening ? <LoaderCircle size={16} className="spin" /> : <ClipboardPaste size={16} />}{requestDialogOpening ? '准备导入…' : '导入 Chrome 视频请求'}</button><span>Chrome 能播放的视频，可复制一次媒体请求后导入</span></div>
          <div className="extension-assist-row"><span className="extension-assist-icon"><Puzzle size={20} /></span><div><strong>使用已登录的 Chrome</strong><p>在浏览器播放，插件一键发送视频，无需手动复制请求。</p></div><button data-testid="extension-open" className="button button-white" disabled={!api || !snapshot || analyzing || typeof api.startExtensionBridge !== 'function'} onClick={() => setExtensionDialogOpen(true)}>连接浏览器插件<ArrowRight size={15} /></button></div>
          <div className="supported-platforms"><span className="supports-label">支持解析</span><span>B 站</span><span>YouTube</span><span>Vimeo</span><span>新片场</span><span>Behance*</span><span className="more-platforms">以及更多网站</span></div>
          <div className="link-footnote">* Behance 及其他网页使用通用媒体解析，是否可下载取决于页面的视频来源。</div>
          <div className="browser-privacy"><ShieldCheck size={11} /><span>内置辅助窗口使用独立会话；Chrome 插件仅在你发送视频时接收相关请求信息，凭据保存在本机。</span></div>
          {analyzing && analysisMode !== 'extension' && <div className={`analysis-status${analysisMode !== 'standard' ? ' browser-analysis-status' : ''}`} role="status"><span className="pulse-dot" /><div><strong>{cancelling ? '正在结束分析，请稍候…' : analysisMode === 'request' ? '正在分析 Chrome 视频请求' : analysisMode === 'browser' ? '正在等待辅助窗口中的视频' : '正在获取视频信息和画质，请稍候…'}</strong><p>{cancelling ? '取消按钮会保留到分析结束；尚未创建下载任务。' : analysisMode === 'request' ? '正在提取媒体信息；请求原文不会显示，也不会作为命令运行。' : analysisMode === 'browser' ? '请在新打开的窗口播放目标视频；登录或网站验证请手动完成。检测到媒体后会返回可选画质。' : '复杂页面可能需要更长时间，也可以取消后换用浏览器辅助分析或导入 Chrome 请求。'}</p></div></div>}
          {analyzing && analysisMode === 'extension' && <div className="analysis-status browser-analysis-status" role="status"><LoaderCircle size={18} className="spin" /><div><strong>{cancelling ? '正在取消插件视频分析…' : '正在分析插件发送的视频'}</strong><p>已接收当前浏览器的媒体请求；完成后可选择画质并下载。</p></div></div>}
          {analysisError && analysisScope === 'workspace' && <div className="analysis-error-block"><div className="inline-error" role="alert"><CircleAlert size={16} /><div><strong>{analysisMode === 'extension' ? '插件视频分析未完成' : analysisMode === 'request' ? '请求导入未完成' : analysisMode === 'browser' ? '辅助分析未完成' : '普通解析未完成'}</strong><span>{analysisError}</span></div></div><div className="analysis-recovery"><p>{analysisMode === 'extension' ? '请在 Chrome 正常播放该视频，再在插件中清空并重新检测、发送；保持软件与浏览器使用相同的代理和网络。' : analysisMode === 'request' ? '请在 Chrome 重新播放目标视频，复制最新媒体请求，并确认软件与 Chrome 使用相同代理和网络。' : '如果该视频在 Chrome 中能播放，可从网络面板复制媒体请求后导入；也可以尝试浏览器辅助分析。'}</p><div className="recovery-actions">{normalizeUrl(url) && <button data-testid="browser-analyze-retry-button" className="text-button" disabled={!api || !snapshot || analyzing} onClick={() => void runAnalysis(url, true, 'browser')}><AppWindow size={14} />{analysisMode === 'browser' ? '重新辅助分析' : '浏览器辅助分析'}</button>}<button data-testid="request-import-retry-button" className="text-button" disabled={!api || !snapshot || requestDialogOpening} onClick={() => void openRequestDialog()}><ClipboardPaste size={14} />导入 Chrome 视频请求<ArrowRight size={13} /></button></div></div></div>}
          {standardFailure && analysisMode !== 'standard' && standardFailure.url === normalizeUrl(url) && <details className="previous-analysis-error"><summary>查看上次普通解析结果</summary><p>{standardFailure.message}</p></details>}
        </section>}

        {visibleAnalysis && visibleAnalysis.entries.length > 0 ? <section className="card result-card" aria-labelledby="result-heading">
          <div className="section-heading"><div className="heading-label"><span className="step-number">02</span><h2 id="result-heading">{visibleAnalysis.entries.length === 1 ? '视频已准备就绪' : `发现 ${visibleAnalysis.entries.length} 个视频`}</h2></div><span className="muted-small">{visibleAnalysis.entries.length > 1 ? '勾选需要下载的视频，各自保存' : '保留原始画质 · 自动合并音画'}</span></div>
          {(analysisMode === 'request' || analysisMode === 'extension') && <p className="request-result-note"><ClipboardPaste size={12} />{analysisMode === 'extension' ? '已接收浏览器插件发送的视频，可选择画质并下载。' : '已从 Chrome 视频请求识别媒体，可选择画质并下载。'}</p>}
          {visibleAnalysis.entries.length > 1 && <div className="playlist-toolbar"><label className="checkbox-label"><input type="checkbox" checked={selectedCount === visibleAnalysis.entries.length} onChange={(event) => setSelections((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, selected: event.target.checked }])))} />选择全部</label><span>已选 {selectedCount} / {visibleAnalysis.entries.length}</span></div>}
          <div className={visibleAnalysis.entries.length > 1 ? 'video-list' : 'video-list single-video'}>{visibleAnalysis.entries.map((entry, index) => {
            const key = entryKey(entry, index);
            const selection = selections[key] ?? { selected: false, formatId: 'best' };
            return <div className="video-row" key={key}>
              {visibleAnalysis.entries.length > 1 && <input className="video-checkbox" type="checkbox" aria-label={`选择 ${entry.title}`} checked={selection.selected} onChange={(event) => setSelections((current) => ({ ...current, [key]: { ...selection, selected: event.target.checked } }))} />}
              <Thumbnail src={entry.thumbnail} title={entry.title} duration={entry.duration} />
              <div className="video-info"><div className="video-meta"><span className="platform-tag">{platformLabel(entry.platform)}</span>{entry.uploader && <span>{entry.uploader}</span>}</div><h3 title={entry.title}>{entry.title}</h3><div className="format-picker"><label htmlFor={`format-${index}`}><Gauge size={14} /> 下载画质</label><span className="select-wrap"><select id={`format-${index}`} value={selection.formatId} onChange={(event) => setSelections((current) => ({ ...current, [key]: { ...selection, formatId: event.target.value } }))}>{availableFormats(entry).map((format) => <option value={format.id} key={format.id}>{format.label}{format.size ? ` · ${formatBytes(format.size)}` : ''}</option>)}</select><ChevronDown size={14} /></span></div></div>
            </div>;
          })}</div>
          {visibleAnalysis.warnings.length > 0 && <div className="analysis-warnings">{visibleAnalysis.warnings.map((warning, index) => <p key={index}><CircleAlert size={14} />{warning}</p>)}</div>}
          <div className="result-footer"><span><ShieldCheck size={15} /> 自动合并分片与音视频，尽量保持原始画质</span><button data-testid="download-button" className="button button-primary" disabled={!selectedCount || enqueueing || !ready} onClick={() => void enqueueSelected()}>{enqueueing ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}{enqueueing ? '加入队列中…' : `下载${selectedCount > 1 ? ` ${selectedCount} 个视频` : '视频'}`}</button></div>
        </section> : !analyzing && <section className="welcome-layout" aria-label="使用方式">
          <div className="welcome-card"><div className="welcome-art" aria-hidden="true"><span className="art-grid" /><span className="art-film"><Video size={30} strokeWidth={1.4} /></span><span className="art-download"><ArrowDown size={18} /></span><span className="art-dot dot-one" /><span className="art-dot dot-two" /></div><div><h2>{page === 'social' ? '从一段分享开始' : '从一条链接开始'}</h2><p>{page === 'social' ? '粘贴分享口令或链接，确认作品后下载。' : '粘贴网址，选择画质，下载完整视频。'}<br />繁琐的分片与音画合并，交给映取。</p></div></div>
          <div className="feature-card"><div><span className="feature-icon"><Layers3 size={17} /></span><div><strong>分片自动合并</strong><small>HLS / DASH 分片完整保存</small></div></div><div><span className="feature-icon"><Music2 size={17} /></span><div><strong>视频与音频合一</strong><small>分离的音画，自动组合</small></div></div><div><span className="feature-icon"><Sparkles size={17} /></span><div><strong>原始画质优先</strong><small>尽量不转码，保留每一帧细节</small></div></div></div>
        </section>}

        <section className="queue-section" aria-labelledby="queue-heading"><div className="section-heading queue-heading"><div className="heading-label"><h2 id="queue-heading">下载队列</h2><span className="count-pill">{activeCount}</span></div><button className="text-button" onClick={() => setPage('history')}>全部记录 <ArrowRight size={14} /></button></div>
          <div className="card task-list">{sortedTasks.length ? [...sortedTasks.filter((task) => ACTIVE.has(task.status)), ...sortedTasks.filter((task) => !ACTIVE.has(task.status))].slice(0, 5).map((task) => <TaskRow task={task} key={task.id} onAction={onTaskAction} />) : <div className="queue-empty"><span><Download size={23} strokeWidth={1.5} /></span><div><strong>还没有下载任务</strong><p>分析上方的视频链接，开始第一次下载。</p></div><span className="queue-empty-detail">按顺序下载 · 支持失败重试</span></div>}</div>
          <div className="workspace-footer"><span><LockKeyhole size={12} /> 登录凭据与任务记录仅在本机使用</span><span>默认最高画质 · MP4 / MKV 自动选择</span></div>
        </section>
      </>}

      {page === 'history' && <>
        <div className="history-summary"><div className="summary-card"><span className="summary-icon"><Folder size={20} /></span><div><strong>{sortedTasks.length}</strong><small>全部任务</small></div></div><div className="summary-card"><span className="summary-icon complete"><CheckCircle2 size={20} /></span><div><strong>{completeCount}</strong><small>已完成</small></div></div><div className="summary-card"><span className="summary-icon active"><ArrowDownToLine size={20} /></span><div><strong>{activeCount}</strong><small>队列中</small></div></div></div>
        <div className="history-toolbar"><div className="tabs" role="tablist" aria-label="筛选下载记录">{[['all', '全部任务'], ['completed', '已完成'], ['stopped', '需要关注']].map(([value, label]) => <button role="tab" aria-selected={historyFilter === value} className={historyFilter === value ? 'tab active' : 'tab'} key={value} onClick={() => setHistoryFilter(value)}>{label}</button>)}</div><span className="muted-small">共 {visibleHistory.length} 个任务</span></div>
        <div className="card task-list history-list">{visibleHistory.length ? visibleHistory.map((task) => <TaskRow task={task} key={task.id} onAction={onTaskAction} detailed />) : <div className="large-empty"><Clock3 size={34} strokeWidth={1.2} /><h2>{historyFilter === 'all' ? '下载记录将在这里出现' : '暂时没有符合条件的任务'}</h2><p>{historyFilter === 'all' ? '回到工作台，保存你的第一条视频。' : '更换筛选条件，查看其他下载记录。'}</p>{historyFilter === 'all' && <button className="button button-primary" onClick={() => setPage('workspace')}><Plus size={16} /> 添加下载</button>}</div>}</div>
      </>}

      {page === 'settings' && (snapshot && api ? <SettingsPage snapshot={snapshot} api={api} onSave={(settings) => setSnapshot((current) => current ? { ...current, settings } : current)} onNotice={showNotice} /> : <div className="card large-empty"><Settings2 size={34} strokeWidth={1.2} /><h2>桌面版设置</h2><p>{bootError || '启动映取桌面程序后，可配置保存目录、登录凭据和下载组件。'}</p></div>)}
    </main>

    {requestDialogOpen && <RequestImportDialog canAnalyze={Boolean(api && snapshot)} analyzing={analyzing && analysisMode === 'request'} cancelling={cancelling} error={analysisMode === 'request' ? analysisError : ''} onClose={closeRequestDialog} onClipboard={() => runRequestAnalysis('clipboard')} onSubmit={(text) => runRequestAnalysis('paste', text)} onCancel={() => void cancelAnalysis()} onPasteReceived={() => { if (analyzingRef.current && analysisMode === 'request') void cancelAnalysis(); }} />}

    {extensionDialogOpen && api && <ExtensionDialog api={api} onClose={() => setExtensionDialogOpen(false)} />}
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleAlert size={18} /> : notice.kind === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>;
}

function RequestImportDialog({ canAnalyze, analyzing, cancelling, error, onClose, onClipboard, onSubmit, onCancel, onPasteReceived }: {
  canAnalyze: boolean;
  analyzing: boolean;
  cancelling: boolean;
  error: string;
  onClose: () => void;
  onClipboard: () => Promise<void>;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
  onPasteReceived: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const payloadRef = useRef('');
  const [receivedCount, setReceivedCount] = useState(0);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.documentElement.style.overflow;
    const previousFocus = document.activeElement;
    document.documentElement.style.overflow = 'hidden';
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLButtonElement>('[data-testid="request-clipboard"]')?.focus({ preventScroll: true });
    return () => {
      payloadRef.current = '';
      dialog?.close();
      document.documentElement.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const clear = () => { payloadRef.current = ''; setReceivedCount(0); onPasteReceived(); };
  return <dialog ref={dialogRef} data-testid="request-dialog" className="request-dialog" aria-labelledby="request-title" aria-describedby="request-description" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="request-dialog-header"><span className="request-dialog-icon"><ClipboardPaste size={22} strokeWidth={1.5} /></span><div><h2 id="request-title">导入 Chrome 视频请求</h2><p id="request-description">在 Chrome 复制一次视频请求，回到映取选择画质并下载。</p></div><button data-testid="request-close" className="icon-button" title="关闭导入窗口（Esc）" aria-label="关闭请求导入窗口" onClick={onClose}><X size={19} /></button></header>
    <div className="request-dialog-body">
      <ol className="request-steps">
        <li><span>1</span><p>在 Chrome 打开目标视频，按 <kbd>F12</kbd>，进入 <b>网络</b> 面板。</p></li>
        <li><span>2</span><p>播放视频，筛选 <code>m3u8</code>、<code>mpd</code>、<code>mp4</code>；Vimeo 也可搜索 <code>master.json</code>。</p></li>
        <li><span>3</span><p>右键媒体请求 → 复制 → <b>复制为 cURL</b>。优先选 <b>bash</b>；cmd 格式也会尽力支持。</p></li>
        <li><span>4</span><p>回到这里点击 <b>从剪贴板分析</b>；也可在下方按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 手动粘贴。</p></li>
      </ol>
      <div className="request-network-note"><Link2 size={14} /><p>软件需与 Chrome 使用相同的代理和网络。请求可能过期，建议复制后立即分析。</p></div>
      <div className="request-paste-heading"><label htmlFor="request-paste">手动粘贴请求 <span>可选</span></label>{receivedCount > 0 && <button className="text-button" onClick={clear}>清空已接收内容</button>}</div>
      <div className={`request-paste-zone${receivedCount > 0 ? ' has-request' : ''}`}><textarea id="request-paste" data-testid="request-paste" value="" aria-label="在此按 Ctrl+V 粘贴视频请求" placeholder="点击这里，按 Ctrl+V 粘贴。请求原文始终隐藏。" spellCheck={false} autoComplete="off" onBeforeInput={(event) => event.preventDefault()} onChange={(event) => { event.currentTarget.value = ''; }} onDrop={(event) => event.preventDefault()} onPaste={(event) => {
        event.preventDefault();
        const raw = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
        payloadRef.current = raw;
        setReceivedCount(raw.length);
        onPasteReceived();
      }} /><div className="request-received" role="status">{receivedCount > 0 ? <><ShieldCheck size={13} />已接收 {receivedCount.toLocaleString('zh-CN')} 字符，敏感内容已隐藏</> : <><LockKeyhole size={12} />粘贴仅接收到内存，需点击按钮才开始分析</>}</div></div>
      {analyzing && <div className="request-progress" role="status"><LoaderCircle size={15} className="spin" /><span>{cancelling ? '正在取消请求分析，请稍候…' : '正在提取并分析视频请求，请稍候…'}</span><button data-testid="request-cancel" className="text-button" disabled={cancelling} onClick={onCancel}>{cancelling ? '正在取消…' : '取消分析'}</button></div>}
      {error && <div className="request-error" role="alert"><CircleAlert size={15} /><p>{error}</p></div>}
      <div className="request-privacy"><ShieldCheck size={15} /><div><strong>仅在本机处理请求凭据，不要分享请求文本。</strong><p>软件只提取请求信息，不运行复制的命令。原文不会显示在界面中，关闭窗口后会清空本次手动粘贴内容。</p></div></div>
    </div>
    <footer className="request-dialog-footer"><span>不会自动读取剪贴板</span><div><button data-testid="request-submit" className="button button-white" disabled={!canAnalyze || !receivedCount || analyzing} onClick={() => void onSubmit(payloadRef.current)}>分析已粘贴请求 <ArrowRight size={15} /></button><button data-testid="request-clipboard" className="button button-primary" autoFocus disabled={!canAnalyze || analyzing} onClick={() => void onClipboard()}>{analyzing ? <LoaderCircle size={16} className="spin" /> : <ClipboardPaste size={16} />}{analyzing ? '正在分析…' : '从剪贴板分析'}</button></div></footer>
  </dialog>;
}

function TaskRow({ task, onAction, detailed = false }: { task: DownloadTask; onAction: (action: 'cancel' | 'retry' | 'open' | 'log' | 'cleanup', task: DownloadTask) => void; detailed?: boolean }) {
  const active = ACTIVE.has(task.status);
  const running = ['downloading', 'merging', 'verifying'].includes(task.status);
  const percent = Math.max(0, Math.min(100, task.progress.percent ?? 0));
  const canRetry = ['failed', 'cancelled', 'interrupted'].includes(task.status);
  return <article className={`task-row task-${task.status}`}>
    <Thumbnail src={task.video.thumbnail} title={task.video.title} small />
    <div className="task-body"><div className="task-title-line"><h3 title={task.video.title}>{task.video.title}</h3><span className={`task-status status-${task.status}`}>{running ? <LoaderCircle size={12} className="spin" /> : task.status === 'completed' ? <CheckCircle2 size={12} /> : task.status === 'failed' ? <CircleAlert size={12} /> : null}{STATUS[task.status]}</span></div>
      <div className="task-meta"><span>{platformLabel(task.video.platform)}</span><span>{task.formatLabel || '最高画质'}</span>{task.status === 'downloading' ? <><span>{task.progress.speed ? `${formatBytes(task.progress.speed)}/s` : '正在连接…'}</span>{task.progress.eta !== undefined && <span>剩余 {formatDuration(task.progress.eta)}</span>}</> : <span>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}</div>
      {active && <div className="progress-line"><div className={`progress-track${task.status === 'merging' || task.status === 'verifying' ? ' progress-indeterminate' : ''}`} role="progressbar" aria-label={`${task.video.title} 下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.status === 'downloading' ? Math.round(percent) : undefined}><span style={{ width: task.status === 'queued' ? '0%' : task.status === 'downloading' ? `${percent}%` : '40%' }} /></div><span className="progress-label">{task.status === 'queued' ? '等待中' : task.status === 'downloading' ? `${percent.toFixed(1)}%` : task.status === 'merging' ? '合并音画' : '检查文件'}</span></div>}
      {task.error && <p className="task-error"><CircleAlert size={12} /><span>{task.error}</span></p>}
      {detailed && <div className="task-path" title={task.outputPath || task.outputDir}><Folder size={11} />{task.outputPath || task.outputDir}</div>}
    </div>
    <div className="task-actions">
      {active && <button className="icon-button" title="取消任务" aria-label={`取消 ${task.video.title}`} onClick={() => onAction('cancel', task)}><X size={17} /></button>}
      {canRetry && <button className="icon-button" title="重试下载" aria-label={`重试 ${task.video.title}`} onClick={() => onAction('retry', task)}><RotateCcw size={16} /></button>}
      {task.status === 'completed' && <button className="icon-button" title="在文件夹中显示" aria-label={`显示 ${task.video.title} 的文件`} onClick={() => onAction('open', task)}><FolderOpen size={17} /></button>}
      {task.logPath && <button className="icon-button" title="查看任务日志" aria-label={`查看 ${task.video.title} 的日志`} onClick={() => onAction('log', task)}><FileText size={16} /></button>}
      {task.status === 'completed' && <button className="icon-button cleanup-button" title="清理临时文件（需要确认）" aria-label={`清理 ${task.video.title} 的临时文件`} onClick={() => onAction('cleanup', task)}><Trash2 size={15} /></button>}
    </div>
  </article>;
}

function SettingsPage({ snapshot, api, onSave, onNotice }: { snapshot: AppSnapshot; api: DesktopApi; onSave: (settings: AppSettings) => void; onNotice: (kind: Notice['kind'], text: string) => void }) {
  const [draft, setDraft] = useState(snapshot.settings);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const choose = async (kind: 'output' | 'cookie') => {
    try {
      const path = kind === 'output' ? await api.selectOutputDir() : await api.selectCookieFile();
      if (path) setDraft((current) => ({ ...current, [kind === 'output' ? 'outputDir' : 'cookiePath']: path }));
    } catch (e) { onNotice('error', errorText(e)); }
  };
  const save = async () => {
    setSaving(true);
    try { const result = await api.saveSettings(draft); setDraft(result); onSave(result); onNotice('success', '设置已保存，将用于后续分析与新下载任务。'); }
    catch (e) { onNotice('error', errorText(e)); }
    finally { setSaving(false); }
  };
  return <div className="settings-page">
    <section className="card settings-card"><div className="settings-title"><Folder size={19} /><div><h2>文件保存</h2><p>选择视频下载完成后的保存位置。</p></div></div><label className="field-label" htmlFor="output-dir">下载目录</label><div className="settings-field"><input id="output-dir" value={draft.outputDir} onChange={(event) => setDraft({ ...draft, outputDir: event.target.value })} spellCheck={false} /><button className="button button-white" onClick={() => void choose('output')}><FolderOpen size={16} /> 选择目录</button></div><p className="field-help">同名视频会自动区分；原始分片和中间文件保留在任务目录，清理时需要你确认。</p></section>
    <section className="card settings-card"><div className="settings-title"><LockKeyhole size={19} /><div><h2>登录与网络</h2><p>部分视频或高画质需要登录状态，以及可访问目标网站的网络。</p></div></div><label className="field-label" htmlFor="cookie-path">Cookie 文件 <span>可选</span></label><div className="settings-field"><input id="cookie-path" value={draft.cookiePath} readOnly placeholder="导入 Netscape 格式的 cookies.txt" /><button className="button button-white" onClick={() => void choose('cookie')}><Plus size={16} /> 导入文件</button>{draft.cookiePath && <button className="icon-button" aria-label="取消使用 Cookie 文件" title="取消使用，不删除文件" onClick={() => setDraft({ ...draft, cookiePath: '' })}><X size={17} /></button>}</div><p className="field-help">登录凭据只交给本机下载引擎使用。请妥善保管 Cookie 文件，勿分享给他人。</p><label className="field-label spaced-label" htmlFor="proxy">代理地址 <span>可选</span></label><div className="settings-field"><input id="proxy" type="text" autoComplete="off" spellCheck={false} value={draft.proxy} onChange={(event) => setDraft({ ...draft, proxy: event.target.value })} placeholder="例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" /></div><p className="field-help">支持 HTTP / HTTPS / SOCKS5。留空时使用下载引擎的默认网络配置。</p></section>
    <div className="settings-save-bar"><span>{dirty ? '有尚未保存的更改' : '设置已保存'}</span><button className="button button-primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{saving ? '正在保存…' : '保存设置'}</button></div>
    <section className="card settings-card dependencies-card"><div className="settings-title"><Gauge size={19} /><div><h2>下载组件</h2><p>所需组件随便携包提供，无需在电脑上安装。</p></div></div><div className="dependency-list">{snapshot.dependencies.map((dependency) => <div className="dependency-row" key={dependency.name}><span className={`dependency-indicator${dependency.available ? '' : ' unavailable'}`}>{dependency.available ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}</span><div><strong>{dependency.name}</strong><span title={dependency.path}>{dependency.path}</span></div><code>{dependency.available ? dependency.version || '可用' : '未找到'}</code></div>)}</div><div className="dependency-help"><CircleAlert size={16} /><p>网站解析规则会变化。更新组件时，请先退出软件，备份旧组件，再将官方新版放入上方对应路径；重新启动后会检查版本。</p></div></section>
    <section className="portable-info"><HardDrive size={20} /><div><h3>便携数据，跟着软件走</h3><p>配置、任务记录与缓存保存在软件目录下的 data 文件夹。移动整套软件时，请保留所有文件和子目录。</p><code>{snapshot.portableRoot}</code></div><span className="portable-version">v{snapshot.appVersion}</span></section>
  </div>;
}
