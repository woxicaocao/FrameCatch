import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs, constants, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AnalysisResult, AppSettings, DependencyInfo, DownloadRequest, DownloadTask, MediaContext } from '../shared/types';
import { commonArgs, displayWarnings, downloadArgs, expectsAudio, FILE_PREFIX, friendlyError, isPathInside, META_PREFIX, normalizeAnalysis, parseProgress, POST_PREFIX, redactLog, relocatePortablePath, safeFilename, validateMediaContext, validateProxy, validateUrl, verifyProbe, vimeoPlayerFallback } from './engine-helpers';
import { assertCompleteMediaResource, isVimeoPlaylistUrl } from './media-resource';
import { parseVimeoPlaylist } from './vimeo-playlist';

export interface EngineOptions {
  portableRoot: string;
  binDir: string;
  onTasksChanged?: (tasks: DownloadTask[]) => void;
  /** Injectable only for deterministic process lifecycle tests. */
  spawnProcess?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess;
}
interface RunResult { code: number | null; stdout: string; stderr: string; }
interface RunningTask { task: DownloadTask; child?: ChildProcess; copyAbort?: AbortController; cancelled: boolean; interrupted: boolean; promise?: Promise<void>; }
interface SavedState { version: 1; portableRoot: string; settings: AppSettings; tasks: DownloadTask[]; }

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const activeStatuses = new Set(['downloading', 'merging', 'verifying']);

export class DownloadEngine extends EventEmitter {
  private readonly root: string;
  private readonly bin: string;
  private readonly options: EngineOptions;
  private tasks: DownloadTask[] = [];
  private settings: AppSettings;
  private active?: RunningTask;
  private analysisChild?: ChildProcess;
  private analysisPending = false;
  private analysisCancelled = false;
  private analysisGeneration = 0;
  private shuttingDown = false;
  private pumping = false;
  private persistence: Promise<void> = Promise.resolve();
  private lastProgressSave = 0;
  private dependencyCache?: DependencyInfo[];

  constructor(options: EngineOptions) {
    super();
    this.options = options;
    this.root = path.resolve(options.portableRoot);
    this.bin = path.resolve(options.binDir);
    this.settings = { outputDir: path.join(this.root, 'Downloads'), cookiePath: '', proxy: '' };
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.root, 'data', 'work'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'data', 'logs'), { recursive: true });
    const statePath = path.join(this.root, 'data', 'state.json');
    let saved: SavedState | undefined;
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      try { saved = JSON.parse(raw); } catch { throw new Error('任务记录 data/state.json 无法读取。原文件已保留，请备份该文件并修复 JSON 后再启动。'); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.tasks) || !saved.settings || typeof saved.portableRoot !== 'string') throw new Error('任务记录格式不兼容，原文件已保留。请检查 data/state.json。');
      const oldRoot = saved.portableRoot;
      this.settings = {
        outputDir: relocatePortablePath(saved.settings.outputDir, oldRoot, this.root),
        cookiePath: relocatePortablePath(saved.settings.cookiePath || '', oldRoot, this.root),
        proxy: saved.settings.proxy || '',
      };
      this.tasks = saved.tasks.map(task => {
        if (!task || !/^[\w-]+$/.test(task.id) || !task.video || typeof task.workDir !== 'string' || typeof task.outputDir !== 'string') throw new Error('任务记录存在无效条目，原文件已保留。请检查 data/state.json。');
        const video = copy(task.video);
        if (video.mediaContext?.cookiePath) video.mediaContext.cookiePath = relocatePortablePath(video.mediaContext.cookiePath, oldRoot, this.root);
        const recovered = { ...task, video, outputDir: relocatePortablePath(task.outputDir, oldRoot, this.root), workDir: path.join(this.root, 'data', 'work', task.id), logPath: path.join(this.root, 'data', 'logs', `${task.id}.log`), outputPath: task.outputPath ? relocatePortablePath(task.outputPath, oldRoot, this.root) : undefined };
        if (activeStatuses.has(task.status) || task.status === 'queued') { recovered.status = 'interrupted'; recovered.error = '上次运行已中断，点击重试可尝试续传。'; recovered.updatedAt = new Date().toISOString(); }
        return recovered;
      });
    }
    await fs.mkdir(this.settings.outputDir, { recursive: true });
    await this.persist();
  }

  getSettings(): AppSettings { return copy(this.settings); }
  getTasks(): DownloadTask[] { return copy(this.tasks); }
  isBusy(): boolean { return Boolean(this.active || this.analysisPending || this.tasks.some(t => t.status === 'queued')); }
  isAnalyzing(): boolean { return this.analysisPending; }

  private executable(name: string): string { return path.join(this.bin, `${name}.exe`); }
  private environment(): NodeJS.ProcessEnv {
    // Route runtime caches to the portable folder. No installed Python/Node or
    // PATH lookup is needed for any downloaded-media operation.
    return { ...process.env, PATH: `${this.bin}${path.delimiter}${process.env.PATH || ''}`, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', DENO_DIR: path.join(this.root, 'data', 'deno-cache'), XDG_CACHE_HOME: path.join(this.root, 'data', 'cache') };
  }

  private start(file: string, args: string[]): ChildProcess {
    const options: SpawnOptionsWithoutStdio = { cwd: this.root, shell: false, windowsHide: true, env: this.environment(), stdio: 'pipe' };
    return this.options.spawnProcess ? this.options.spawnProcess(file, args, options) : spawn(file, args, options);
  }

  private async run(file: string, args: string[], options: { owner?: RunningTask; onLine?: (line: string) => void; analysis?: boolean; limit?: number; timeoutMs?: number } = {}): Promise<RunResult> {
    const child = this.start(file, args);
    if (options.owner) options.owner.child = child;
    if (options.analysis) this.analysisChild = child;
    let stdout = '', stderr = '', overflow = false;
    const limit = options.limit ?? 2 * 1024 * 1024;
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (value: string) => {
        if (options.owner) { stdout = (stdout + value).slice(-limit); return; }
        if (stdout.length + value.length > limit) { overflow = true; void this.killTree(child); return; }
        stdout += value;
      });
      if (options.onLine) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', options.onLine);
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(-200_000); });
      if (options.onLine) createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', options.onLine);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (options.timeoutMs) timeout = setTimeout(() => { timedOut = true; void this.killTree(child); }, options.timeoutMs);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (overflow) throw new Error('视频列表信息过大，请改用具体视频的独立网址。');
      if (timedOut) throw new Error('网络分析超时，请检查网络及代理，或使用单个视频的独立网址。');
      return { code, stdout, stderr };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.owner?.child === child) options.owner.child = undefined;
      if (this.analysisChild === child) this.analysisChild = undefined;
    }
  }

  async getDependencies(): Promise<DependencyInfo[]> {
    if (this.dependencyCache) return copy(this.dependencyCache);
    const names = ['yt-dlp', 'ffmpeg', 'ffprobe', 'deno'];
    const results = await Promise.all(names.map(async name => {
      const file = this.executable(name);
      try {
        await fs.access(file, constants.R_OK);
        const result = await this.run(file, name === 'ffmpeg' || name === 'ffprobe' ? ['-version'] : ['--version'], { timeoutMs: 20_000, limit: 300_000 });
        const version = (result.stdout || result.stderr).split(/\r?\n/)[0].slice(0, 220);
        return { name, path: file, available: result.code === 0, version };
      } catch { return { name, path: file, available: false }; }
    }));
    this.dependencyCache = results;
    return copy(results);
  }

  private async checkDependencies(): Promise<void> {
    const missing = (await this.getDependencies()).filter(d => !d.available);
    if (missing.length) throw new Error(`便携包组件缺失或不能运行：${missing.map(d => d.name).join('、')}。请确认已完整解压，并查看使用说明。`);
  }

  async analyze(input: string, context?: MediaContext): Promise<AnalysisResult> {
    const url = validateUrl(input);
    if (context || /\.mp4$/i.test(new URL(url).pathname)) assertCompleteMediaResource(url);
    if (this.shuttingDown) throw new Error('软件正在退出。');
    if (this.analysisPending) throw new Error('正在分析其他网址，请稍候或取消当前分析。');
    this.analysisPending = true;
    const generation = ++this.analysisGeneration;
    this.analysisCancelled = false;
    try {
      const mediaContext = context === undefined ? undefined : await this.prepareMediaContext(context);
      await this.checkDependencies();
      if (!mediaContext) await this.validateCookie();
      if (generation !== this.analysisGeneration || this.analysisCancelled || this.shuttingDown) throw new Error('已取消分析。');
      const extract = (source: string) => {
        const args = [...commonArgs(this.bin, this.settings, mediaContext, source), '--skip-download', '--dump-single-json', '--no-write-playlist-metafiles', '--playlist-end', '50', '--ignore-errors', '--concat-playlist', 'never', '--cache-dir', path.join(this.root, 'data', 'yt-cache'), '--', source];
        return this.run(this.executable('yt-dlp'), args, { analysis: true, limit: 64 * 1024 * 1024, timeoutMs: 180_000 });
      };
      const parseInfo = (stdout: string): Record<string, any> | undefined => {
        try {
          const value: unknown = JSON.parse(stdout.trim());
          return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 ? value as Record<string, any> : undefined;
        } catch { return undefined; }
      };
      let effectiveUrl = url;
      let result: RunResult;
      let raw: Record<string, any> | undefined;
      if (isVimeoPlaylistUrl(url)) {
        const playlist = await this.loadVimeoPlaylist(url, mediaContext, { analysis: true, check: () => generation === this.analysisGeneration && !this.analysisCancelled && !this.shuttingDown });
        raw = playlist.info; result = { code: 0, stdout: '', stderr: '' };
      } else { result = await extract(url); raw = parseInfo(result.stdout); }
      if (generation !== this.analysisGeneration || this.analysisCancelled) throw new Error('已取消分析。');
      // --ignore-errors can emit the JSON literal `null` (even with exit 0).
      // Only an actual information object counts as an extraction result.
      const playerUrl = !raw ? vimeoPlayerFallback(url, result.stderr) : undefined;
      if (playerUrl) {
        await fs.appendFile(path.join(this.root, 'data', 'logs', 'analysis.log'), `${new Date().toISOString()} ${redactLog(url)}\n${redactLog(result.stderr)}\n尝试该视频的公开播放器入口：${redactLog(playerUrl)}\n`, 'utf8').catch(() => {});
        if (generation !== this.analysisGeneration || this.analysisCancelled) throw new Error('已取消分析。');
        effectiveUrl = playerUrl;
        result = await extract(playerUrl);
        raw = parseInfo(result.stdout);
      }
      if (generation !== this.analysisGeneration || this.analysisCancelled) throw new Error('已取消分析。');
      if (!raw) throw new Error(result.stderr || '该网页没有可下载的视频，或解析引擎未返回有效的视频信息。');
      let resultInfo: AnalysisResult;
      try { resultInfo = normalizeAnalysis(raw, effectiveUrl); }
      catch (error) { throw /ERROR:/i.test(result.stderr) ? new Error(result.stderr) : error; }
      if (playerUrl) {
        // Vimeo metadata may canonicalize webpage_url back to the failing web
        // client. Retain the proven successful player URL for actual downloads.
        for (const entry of resultInfo.entries) entry.url = playerUrl;
      }
      if (mediaContext) {
        if (resultInfo.entries.length !== 1) throw new Error('捕获的视频链接返回了多个条目，请选择另一条独立媒体链接。');
        const entry = resultInfo.entries[0];
        // Re-extract the proven captured manifest/media URL during download,
        // never a canonical watch page that may require a different session.
        entry.url = url;
        entry.mediaContext = copy(mediaContext);
        delete entry.playlistUrl;
        delete entry.playlistIndex;
        resultInfo.url = url;
        resultInfo.isPlaylist = false;
      }
      if (result.code !== 0) resultInfo.warnings.push('列表中有部分视频无法解析，已展示可用条目；可查看原网页确认访问权限。');
      if (/WARNING:/i.test(result.stderr)) {
        await fs.appendFile(path.join(this.root, 'data', 'logs', 'analysis.log'), `${new Date().toISOString()} ${redactLog(effectiveUrl)}\n${redactLog(result.stderr)}\n`, 'utf8').catch(() => {});
        resultInfo.warnings.push(...displayWarnings(result.stderr));
      }
      return resultInfo;
    } catch (e) {
      if (this.analysisCancelled || generation !== this.analysisGeneration) throw new Error('已取消分析。');
      await fs.appendFile(path.join(this.root, 'data', 'logs', 'analysis.log'), `${new Date().toISOString()} ${redactLog(url)}\n${redactLog(e instanceof Error ? e.message : String(e))}\n`, 'utf8').catch(() => {});
      throw new Error(friendlyError(e));
    } finally { this.analysisPending = false; }
  }

  async cancelAnalysis(): Promise<void> {
    this.analysisCancelled = true;
    ++this.analysisGeneration;
    if (this.analysisChild) await this.killTree(this.analysisChild);
  }

  async saveSettings(input: AppSettings): Promise<AppSettings> {
    if (!input || typeof input.outputDir !== 'string' || !path.isAbsolute(input.outputDir) || input.outputDir.length > 240 || /[\r\n\u0000]/.test(input.outputDir)) throw new Error('请选择有效的绝对保存路径（路径长度不超过 240 个字符）。');
    const proxy = validateProxy(input.proxy);
    if (typeof input.cookiePath !== 'string' || (input.cookiePath && (!path.isAbsolute(input.cookiePath) || /[\r\n\u0000]/.test(input.cookiePath)))) throw new Error('Cookie 文件路径无效。');
    if (isPathInside(path.join(this.root, 'data', 'work'), input.outputDir)) throw new Error('请将成品保存到临时工作目录之外。');
    await fs.mkdir(input.outputDir, { recursive: true });
    await fs.access(input.outputDir, constants.W_OK);
    const next = { outputDir: path.resolve(input.outputDir), cookiePath: input.cookiePath ? path.resolve(input.cookiePath) : '', proxy };
    await this.validateCookie(next);
    this.settings = next;
    await this.persist();
    return this.getSettings();
  }

  private async validateCookie(settings = this.settings): Promise<void> {
    if (!settings.cookiePath) return;
    try {
      const stat = await fs.stat(settings.cookiePath);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error();
      const file = await fs.open(settings.cookiePath, 'r');
      try {
        const buffer = Buffer.alloc(256);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (!/^\s*#(?: Netscape)? HTTP Cookie File/i.test(buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, ''))) throw new Error();
      } finally { await file.close(); }
    } catch { throw new Error('Cookie 文件不可读取或格式不正确，请导入 Netscape 格式的 cookies.txt（首行应为 # Netscape HTTP Cookie File）。'); }
  }

  private async prepareMediaContext(value: unknown): Promise<MediaContext> {
    const context = validateMediaContext(value);
    if (!context.cookiePath) return context;
    const captureBase = path.join(this.root, 'data', 'captures');
    if (!isPathInside(captureBase, context.cookiePath) || path.resolve(context.cookiePath) === path.resolve(captureBase)) throw new Error('浏览器凭据文件必须来自本软件的独立捕获会话，请重新捕获视频。');
    // Validate the canonical target as well, so symlinks/junctions cannot turn a
    // renderer-supplied context into an arbitrary local file read.
    try {
      const [realRoot, realCookie] = await Promise.all([fs.realpath(this.root), fs.realpath(context.cookiePath)]);
      if (!isPathInside(path.join(realRoot, 'data', 'captures'), realCookie)) throw new Error();
    } catch { throw new Error('浏览器凭据文件已失效或不属于独立捕获会话，请重新捕获视频。'); }
    try { await this.validateCookie({ ...this.settings, cookiePath: context.cookiePath, proxy: context.proxy }); }
    catch { throw new Error('独立浏览器会话的登录凭据不可读取或格式不正确，请重新捕获视频。'); }
    return context;
  }

  async enqueue(requests: DownloadRequest[]): Promise<DownloadTask[]> {
    if (this.shuttingDown) throw new Error('软件正在退出。');
    if (!Array.isArray(requests) || !requests.length || requests.length > 100) throw new Error('请选择 1～100 个视频加入下载队列。');
    await this.checkDependencies();
    // Validate the whole batch before creating any tasks, so failures do not
    // silently enqueue only a portion of the user's selection.
    const preparedRequests: DownloadRequest[] = [];
    for (const request of requests) {
      if (!request || !request.video || typeof request.video.id !== 'string' || typeof request.video.title !== 'string' || !Array.isArray(request.video.formats) || typeof request.formatId !== 'string' || typeof request.formatLabel !== 'string') throw new Error('视频信息不完整，请重新分析。');
      validateUrl(request.video.url);
      if (request.video.mediaContext || /\.mp4$/i.test(new URL(request.video.url).pathname)) assertCompleteMediaResource(request.video.url);
      if (request.video.playlistUrl) { validateUrl(request.video.playlistUrl); if (!Number.isInteger(request.video.playlistIndex) || request.video.playlistIndex! < 1 || request.video.playlistIndex! > 10000) throw new Error('列表选择信息无效，请重新分析。'); }
      if (request.formatId !== 'best' && !request.video.formats.some(f => f.id === request.formatId && /^[\w.:-]+$/.test(f.id))) throw new Error('画质选项无效，请重新分析。');
      const video = copy(request.video);
      if (video.mediaContext !== undefined) video.mediaContext = await this.prepareMediaContext(video.mediaContext);
      preparedRequests.push({ ...request, video });
    }
    if (preparedRequests.some(request => !request.video.mediaContext)) await this.validateCookie();
    const created = preparedRequests.map(request => {
      const id = randomUUID();
      const now = new Date().toISOString();
      const task: DownloadTask = { id, video: copy(request.video), formatId: request.formatId, formatLabel: request.formatLabel.slice(0, 100), status: 'queued', progress: {}, createdAt: now, updatedAt: now, outputDir: this.settings.outputDir, workDir: path.join(this.root, 'data', 'work', id), logPath: path.join(this.root, 'data', 'logs', `${id}.log`) };
      return task;
    });
    this.tasks.push(...created);
    await this.changed();
    this.launchPump();
    return copy(created);
  }

  async cancelTask(id: string): Promise<void> {
    const task = this.find(id);
    if (task.status === 'completed' || ['cancelled', 'failed', 'interrupted'].includes(task.status)) return;
    if (this.active?.task.id === id) {
      const owner = this.active;
      owner.cancelled = true;
      owner.copyAbort?.abort();
      task.status = 'cancelled'; task.error = undefined; task.progress.detail = '已取消，中间文件保留，可重试续传。';
      let saveError: unknown;
      try { await this.changed(); } catch (e) { saveError = e; }
      finally {
        if (owner.child) await this.killTree(owner.child);
        await owner.promise;
      }
      if (saveError) throw saveError;
    } else { task.status = 'cancelled'; task.progress.detail = '已取消'; task.updatedAt = new Date().toISOString(); await this.changed(); }
  }

  async retryTask(id: string): Promise<void> {
    const task = this.find(id);
    if (!['failed', 'cancelled', 'interrupted'].includes(task.status) || this.active?.task.id === id) throw new Error('该任务当前不能重试。');
    if (this.shuttingDown) throw new Error('软件正在退出。');
    if (task.video.mediaContext || /\.mp4$/i.test(new URL(task.video.url).pathname)) assertCompleteMediaResource(task.video.url);
    task.status = 'queued'; task.error = undefined; task.progress = { detail: '等待重试，将尝试续传' }; task.updatedAt = new Date().toISOString();
    await this.changed();
    this.launchPump();
  }

  private find(id: string): DownloadTask {
    const task = this.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在。');
    return task;
  }

  private launchPump(): void {
    // The queue is deliberately detached from the IPC request. Any unexpected
    // scheduler failure still needs a terminal state and a handled promise.
    void this.pump().catch(error => {
      for (const task of this.tasks) {
        if (activeStatuses.has(task.status)) { task.status = 'failed'; task.error = friendlyError(error); }
        else if (task.status === 'queued') { task.status = 'interrupted'; task.error = '下载调度已中断，请点击重试。'; }
        else continue;
        task.updatedAt = new Date().toISOString();
      }
      this.active = undefined;
      try { this.notify(); } catch { /* A detached UI must not crash the queue. */ }
      void this.persist().catch(() => {});
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.active || this.shuttingDown) return;
    this.pumping = true;
    try {
      while (!this.shuttingDown) {
        const task = this.tasks.find(t => t.status === 'queued');
        if (!task) break;
        const owner: RunningTask = { task, cancelled: false, interrupted: false };
        this.active = owner;
        owner.promise = this.download(owner);
        await owner.promise;
        if (this.active === owner) this.active = undefined;
      }
    } finally { this.pumping = false; }
  }

  private stillRunning(owner: RunningTask): boolean { return !owner.cancelled && !owner.interrupted && this.active === owner && !this.shuttingDown; }

  private async download(owner: RunningTask): Promise<void> {
    const task = owner.task;
    let logWrites = Promise.resolve();
    const log = (message: string) => { logWrites = logWrites.then(() => fs.appendFile(task.logPath!, `${new Date().toISOString()} ${redactLog(message)}\n`, 'utf8')).catch(() => {}); };
    try {
      task.status = 'downloading'; task.updatedAt = new Date().toISOString(); task.progress = { detail: '正在连接视频来源' }; task.error = undefined;
      await this.changed();
      if (task.video.mediaContext || /\.mp4$/i.test(new URL(task.video.url).pathname)) assertCompleteMediaResource(task.video.url);
      await this.checkDependencies();
      if (task.video.mediaContext) task.video.mediaContext = await this.prepareMediaContext(task.video.mediaContext);
      else await this.validateCookie();
      await fs.mkdir(task.workDir, { recursive: true });
      await fs.mkdir(task.outputDir, { recursive: true });
      await fs.access(task.outputDir, constants.W_OK);
      log(`开始下载：${task.video.title}；画质：${task.formatLabel}`);
      if (!this.stillRunning(owner)) return;
      let finalPath = '';
      let outputCount = 0;
      let metadata: Record<string, any> = {};
      let lastError = '';
      const args = downloadArgs(this.bin, this.settings, task);
      if (isVimeoPlaylistUrl(task.video.url)) {
        task.progress.detail = '正在读取 Vimeo 总清单和音视频轨道'; this.notify();
        const playlist = await this.loadVimeoPlaylist(task.video.url, task.video.mediaContext, { owner, check: () => this.stillRunning(owner) });
        if (!this.stillRunning(owner)) return;
        args.splice(args.length - 2, 2, '--load-info-json', playlist.file);
      }
      args.splice(args.length - 2, 0, '--cache-dir', path.join(this.root, 'data', 'yt-cache'));
      const result = await this.run(this.executable('yt-dlp'), args, {
        owner, limit: 8 * 1024 * 1024,
        onLine: line => {
          if (!this.stillRunning(owner)) return;
          const progress = parseProgress(line);
          if (progress) { task.progress = progress; if (task.status !== 'merging') task.status = 'downloading'; this.notify(); if (Date.now() - this.lastProgressSave > 1500) { this.lastProgressSave = Date.now(); void this.persist().catch(() => {}); } return; }
          if (line.startsWith(META_PREFIX)) { try { metadata = JSON.parse(line.slice(META_PREFIX.length)); } catch {} return; }
          if (line.startsWith(FILE_PREFIX)) { try { finalPath = JSON.parse(line.slice(FILE_PREFIX.length)); ++outputCount; } catch {} return; }
          if (line.startsWith(POST_PREFIX)) { task.status = 'merging'; task.progress = { detail: '正在合并音视频或封装文件' }; this.notify(); return; }
          if (/ERROR:/.test(line)) lastError = line;
          if (line.trim()) log(line);
        },
      });
      if (!this.stillRunning(owner)) return;
      if (result.code !== 0) {
        if (args.includes('--check-formats') && /DRM protected/i.test(result.stderr) && /Requested format.*not available/i.test(result.stderr)) throw new Error('未找到可用的非 DRM 格式');
        throw new Error(lastError || result.stderr || `下载引擎退出（${result.code}）。`);
      }
      if (outputCount > 1) throw new Error('该页面返回多个视频，无法安全对应所选条目。请使用视频的原始独立播放网址。');
      if (!finalPath || typeof finalPath !== 'string' || !isPathInside(task.workDir, finalPath)) throw new Error('未找到安全、完整的下载成品，请查看任务日志。');
      const stat = await fs.stat(finalPath);
      if (!stat.isFile() || stat.size === 0) throw new Error('下载的文件为空，未标记为完成。');
      task.status = 'verifying'; task.progress = { detail: '正在验证视频、音频和文件时长' }; await this.changed();
      let probe = await this.probe(owner, finalPath);
      if (!this.stillRunning(owner)) return;
      const expectAudio = expectsAudio(metadata) || task.video.formats.some(f => f.audioCodec && f.audioCodec !== 'none');
      verifyProbe(probe, expectAudio, Number(metadata.duration) || task.video.duration);
      const extension = path.extname(finalPath).toLowerCase();
      if (!['.mp4', '.mkv'].includes(extension)) {
        task.status = 'merging'; task.progress = { detail: '正在无损封装完整视频' }; await this.changed();
        const streams = probe.streams as { codec_type: string; codec_name: string }[];
        const mp4Video = new Set(['h264', 'hevc', 'av1', 'mpeg4']);
        const mp4Audio = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);
        const compatibleMp4 = streams.filter(s => s.codec_type === 'video').every(s => mp4Video.has(s.codec_name)) && streams.filter(s => s.codec_type === 'audio').every(s => mp4Audio.has(s.codec_name));
        const remuxed = path.join(task.workDir, `complete-${randomUUID().slice(0, 8)}.${compatibleMp4 ? 'mp4' : 'mkv'}`);
        const remux = await this.run(this.executable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-n', '-i', finalPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', remuxed], { owner });
        if (!this.stillRunning(owner)) return;
        if (remux.code !== 0) throw new Error(`无损封装失败：${remux.stderr}`);
        finalPath = remuxed;
        task.status = 'verifying'; task.progress = { detail: '正在检查封装后的完整文件' }; await this.changed();
        probe = await this.probe(owner, finalPath);
        if (!this.stillRunning(owner)) return;
        verifyProbe(probe, expectAudio, Number(metadata.duration) || task.video.duration);
      }
      if (!this.stillRunning(owner)) return;
      // Copy into an explicitly marked staging area on the OUTPUT volume first.
      // ENOSPC or an interrupted copy can never leave a deceptively complete MP4
      // in the user's output folder. Stage files are retained for consented cleanup.
      const stagingDir = path.join(task.outputDir, '.framecatch-staging', task.id);
      await fs.mkdir(stagingDir, { recursive: true });
      const staged = path.join(stagingDir, `${randomUUID()}.framecatch-partial`);
      if (!this.stillRunning(owner)) return;
      owner.copyAbort = new AbortController();
      try { await pipeline(createReadStream(finalPath), createWriteStream(staged, { flags: 'wx' }), { signal: owner.copyAbort.signal }); }
      finally { owner.copyAbort = undefined; }
      const publishedSize = (await fs.stat(staged)).size;
      if (publishedSize !== (await fs.stat(finalPath)).size) throw new Error('复制成品时文件大小不一致，未发布为完整视频。');
      if (!this.stillRunning(owner)) return;
      const name = `${safeFilename(task.video.title)} [${safeFilename(task.video.id).slice(0, 24)}]-${task.id}`;
      let destination = path.join(task.outputDir, `${name}${path.extname(finalPath).toLowerCase()}`);
      // link() is an atomic exclusive publication on NTFS. Keeping the staging
      // link costs no extra file data and avoids deleting any unapproved files.
      let published = false;
      for (let attempt = 0; attempt < 5 && !published; attempt++) {
        try { await fs.link(staged, destination); published = true; }
        catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') { destination = path.join(task.outputDir, `${name}-${randomUUID()}${path.extname(finalPath).toLowerCase()}`); continue; }
          // FAT/exFAT and certain network shares have no hard-link support. Use
          // a full UUID filename and preflight before the same-volume rename.
          if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EXDEV', 'UNKNOWN', 'ENOSYS', 'EINVAL'].includes(code || '')) throw e;
          destination = path.join(task.outputDir, `${name}-${randomUUID()}${path.extname(finalPath).toLowerCase()}`);
          try { await fs.access(destination); continue; } catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check; }
          await fs.rename(staged, destination); published = true;
        }
      }
      if (!published) throw new Error('成品文件名发生冲突，已有文件已保留，请重试。');
      task.outputPath = destination;
      // Cancelling during the final copy cannot safely remove a finished user
      // file. Preserve it and report the task's terminal cancellation state.
      if (!this.stillRunning(owner)) { log(`取消时文件已完成复制，已保留：${destination}`); await this.changed(); return; }
      task.status = 'completed'; task.progress = { percent: 100, downloadedBytes: publishedSize, totalBytes: publishedSize, detail: '下载与验证完成' }; task.error = undefined;
      log(`完成：${destination}`);
      await this.changed();
    } catch (e) {
      if (this.stillRunning(owner)) { task.status = 'failed'; task.error = friendlyError(e); task.progress.detail = '任务失败，中间文件已保留'; log(`失败：${e instanceof Error ? e.message : String(e)}`); await this.changed().catch(() => {}); }
    } finally { await logWrites; }
  }

  private async loadVimeoPlaylist(url: string, context: MediaContext | undefined, execution: { owner?: RunningTask; analysis?: boolean; check: () => boolean }): Promise<{ info: Record<string, any>; file: string }> {
    const check = () => { if (!execution.check()) throw new Error('已取消播放清单分析。'); };
    check();
    const directory = path.join(this.root, 'data', 'manifests', randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const requestFile = path.join(directory, 'request.json');
    const responseFile = path.join(directory, 'response.json');
    // This descriptor is authored locally. No manifest-supplied options,
    // executable fields, headers or filesystem paths are accepted by yt-dlp.
    await fs.writeFile(requestFile, JSON.stringify({ id: 'vimeo-playlist', title: 'Vimeo 播放清单', url, protocol: 'http', ext: 'json' }), { flag: 'wx' });
    check();
    const args = [...commonArgs(this.bin, this.settings, context), '--cache-dir', path.join(this.root, 'data', 'yt-cache'), '--no-simulate', '--no-playlist', '--no-overwrites', '--no-post-overwrites', '--no-part', '--no-progress', '--no-write-info-json', '--fixup', 'never', '--max-filesize', '8M', '--output', responseFile, '--load-info-json', requestFile];
    const result = await this.run(this.executable('yt-dlp'), args, { ...execution, limit: 1024 * 1024, timeoutMs: 120_000 });
    check();
    if (result.code !== 0) throw new Error(result.stderr || 'Vimeo 播放清单请求未完成，请重新播放并捕获。');
    let size: number;
    try { size = (await fs.stat(responseFile)).size; } catch { throw new Error('未取得完整的 Vimeo 播放清单，请重新播放并发送。'); }
    if (!size || size > 8 * 1024 * 1024) throw new Error('Vimeo 播放清单为空或超过大小限制。');
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(responseFile, 'utf8')); } catch { throw new Error('网站未返回有效的 Vimeo 播放清单，请在 Chrome 刷新并重新捕获。'); }
    check();
    const info = parseVimeoPlaylist(raw, url);
    const file = path.join(directory, 'media.info.json');
    await fs.writeFile(file, JSON.stringify(info), { flag: 'wx' });
    check();
    return { info, file };
  }

  private async probe(owner: RunningTask, file: string): Promise<Record<string, any>> {
    const result = await this.run(this.executable('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { owner, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`成品校验失败：${result.stderr}`);
    try { return JSON.parse(result.stdout); } catch { throw new Error('无法读取下载成品的轨道信息。'); }
  }

  private notify(): void { const tasks = this.getTasks(); this.options.onTasksChanged?.(tasks); this.emit('tasksChanged', tasks); }
  private async changed(): Promise<void> { if (this.active) this.active.task.updatedAt = new Date().toISOString(); this.notify(); await this.persist(); }
  private persist(): Promise<void> {
    const state: SavedState = { version: 1, portableRoot: this.root, settings: copy(this.settings), tasks: copy(this.tasks) };
    const write = async () => {
      const temp = path.join(this.root, 'data', 'state.next.json');
      await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
      await fs.rename(temp, path.join(this.root, 'data', 'state.json'));
    };
    this.persistence = this.persistence.catch(() => {}).then(write);
    return this.persistence;
  }

  private async killTree(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      await new Promise<void>(resolve => {
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill(); } catch {} resolve(); });
        killer.once('close', () => resolve());
      });
    } else { try { child.kill('SIGTERM'); } catch {} }
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const active = this.active;
    if (active) { active.interrupted = true; active.copyAbort?.abort(); }
    for (const task of this.tasks) if (task.status === 'queued' || activeStatuses.has(task.status)) { task.status = 'interrupted'; task.error = '软件退出，任务已中断；重启后点击重试可尝试续传。'; task.updatedAt = new Date().toISOString(); }
    let shutdownError: unknown;
    try { await this.changed(); } catch (error) { shutdownError = error; }
    finally {
      // A full disk must never prevent killing yt-dlp/FFmpeg. Always attempt
      // every termination, and wait for the owner before reporting save errors.
      const stopped = await Promise.allSettled([this.cancelAnalysis(), active?.child ? this.killTree(active.child) : Promise.resolve()]);
      for (const result of stopped) if (result.status === 'rejected' && !shutdownError) shutdownError = result.reason;
      try { await active?.promise; } catch (error) { shutdownError ||= error; }
      try { await this.persistence; } catch (error) { shutdownError ||= error; }
    }
    if (shutdownError) {
      // The window offers a return option after save failure. Processes are
      // already stopped, so allow retrying after the user fixes disk access.
      this.shuttingDown = false;
      throw shutdownError;
    }
  }
}

export async function createEngine(options: EngineOptions): Promise<DownloadEngine> {
  const engine = new DownloadEngine(options);
  await engine.initialize();
  return engine;
}
