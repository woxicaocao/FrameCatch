export type TaskStatus = 'queued' | 'downloading' | 'merging' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface VideoFormat { id: string; label: string; height?: number; fps?: number; ext: string; size?: number; videoCodec?: string; audioCodec?: string; }
export interface MediaContext { referer: string; userAgent: string; origin?: string; cookiePath?: string; proxy: string; }
export interface VideoEntry { id: string; url: string; title: string; thumbnail?: string; duration?: number; uploader?: string; platform: string; formats: VideoFormat[]; playlistIndex?: number; playlistUrl?: string; mediaContext?: MediaContext; }
export interface AnalysisResult { url: string; title: string; entries: VideoEntry[]; isPlaylist: boolean; warnings: string[]; }
export interface DownloadProgress { percent?: number; downloadedBytes?: number; totalBytes?: number; speed?: number; eta?: number; detail?: string; }
export interface DownloadTask { id: string; video: VideoEntry; formatId: string; formatLabel: string; status: TaskStatus; progress: DownloadProgress; createdAt: string; updatedAt: string; outputDir: string; workDir: string; outputPath?: string; error?: string; logPath?: string; }
export interface AppSettings { outputDir: string; cookiePath: string; proxy: string; }
export interface DependencyInfo { name: string; available: boolean; version?: string; path: string; }
export interface AppSnapshot { tasks: DownloadTask[]; settings: AppSettings; dependencies: DependencyInfo[]; appVersion: string; portableRoot: string; }
export interface DownloadRequest { video: VideoEntry; formatId: string; formatLabel: string; }
export interface CleanupResult { cancelled: boolean; bytes: number; files: number; }
export interface ExtensionBridgeStatus { running: boolean; port: number; paired: boolean; pairingCode?: string; error?: string; remembered?: boolean; autoConnect?: boolean; }
export interface ExtensionAnalysisEvent { status: 'analyzing' | 'completed' | 'failed'; sourceUrl: string; result?: AnalysisResult; error?: string; }
export interface ShareLink { platform: 'douyin' | 'wechat-channels'; url: string; }
export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  analyze(url: string): Promise<AnalysisResult>;
  normalizeShare(text: string): Promise<ShareLink>;
  analyzeShare(text: string): Promise<AnalysisResult>;
  openSharePage(text: string): Promise<void>;
  analyzeInBrowser(url: string): Promise<AnalysisResult>;
  analyzeRequest(text: string): Promise<AnalysisResult>;
  analyzeClipboardRequest(): Promise<AnalysisResult>;
  startExtensionBridge(): Promise<ExtensionBridgeStatus>;
  stopExtensionBridge(): Promise<ExtensionBridgeStatus>;
  forgetExtensionPairing(): Promise<ExtensionBridgeStatus>;
  getExtensionBridgeStatus(): Promise<ExtensionBridgeStatus>;
  openExtensionFolder(): Promise<void>;
  onExtensionAnalysis(listener: (event: ExtensionAnalysisEvent) => void): () => void;
  cancelAnalysis(): Promise<void>;
  enqueue(requests: DownloadRequest[]): Promise<DownloadTask[]>;
  cancelTask(id: string): Promise<void>;
  retryTask(id: string): Promise<void>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  selectOutputDir(): Promise<string | null>;
  selectCookieFile(): Promise<string | null>;
  openOutput(id?: string): Promise<void>;
  openLog(id: string): Promise<void>;
  cleanupTask(id: string): Promise<CleanupResult>;
  onTasksChanged(listener: (tasks: DownloadTask[]) => void): () => void;
}
