import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { createEngine } from '../electron/engine';

async function workspace() { return fs.mkdtemp(path.join(os.tmpdir(), 'framecatch-engine-test-')); }
function fakeProcess(output: string, code = 0, error = ''): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, exitCode: null, pid: undefined });
  queueMicrotask(() => { stdout.end(output); stderr.end(error); child.emit('close', code); });
  return child;
}

describe('任务持久化与恢复', () => {
  it('首次创建配置；重启恢复活动任务且仅重定位软件内部路径', async () => {
    const root = await workspace();
    const oldRoot = path.join(root, 'before');
    const newRoot = path.join(root, 'after');
    await fs.mkdir(path.join(newRoot, 'data'), { recursive: true });
    const external = path.join(root, 'external-output');
    const task = (id: string, status: string, outputDir: string) => ({ id, status, video: { id: 'film', title: '电影', url: 'https://example.com/video', formats: [], platform: 'Generic' }, formatId: 'best', formatLabel: '最高画质', progress: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputDir, workDir: path.join(oldRoot, 'data', 'work', id), outputPath: path.join(outputDir, 'movie.mp4') });
    const captured = { ...task('task1', 'merging', path.join(oldRoot, 'Downloads')), video: { ...task('task1', 'merging', external).video, mediaContext: { referer: 'https://example.com/watch', userAgent: 'Browser/1', cookiePath: path.join(oldRoot, 'data', 'captures', 'capture.cookies.txt'), proxy: '' } } };
    await fs.writeFile(path.join(newRoot, 'data', 'state.json'), JSON.stringify({ version: 1, portableRoot: oldRoot, settings: { outputDir: path.join(oldRoot, 'Downloads'), cookiePath: path.join(oldRoot, 'cookie.txt'), proxy: '' }, tasks: [captured, task('task2', 'queued', external), task('task3', 'completed', external)] }));
    const engine = await createEngine({ portableRoot: newRoot, binDir: path.join(newRoot, 'resources', 'bin') });
    expect(engine.getSettings().outputDir).toBe(path.join(newRoot, 'Downloads'));
    expect(engine.getSettings().cookiePath).toBe(path.join(newRoot, 'cookie.txt'));
    expect(engine.getTasks().map(t => t.status)).toEqual(['interrupted', 'interrupted', 'completed']);
    expect(engine.getTasks()[1].outputDir).toBe(external);
    expect(engine.getTasks()[0].workDir).toBe(path.join(newRoot, 'data', 'work', 'task1'));
    expect(engine.getTasks()[0].video.mediaContext?.cookiePath).toBe(path.join(newRoot, 'data', 'captures', 'capture.cookies.txt'));
    const copy = engine.getTasks(); copy[0].video.title = '篡改副本';
    expect(engine.getTasks()[0].video.title).toBe('电影');
    await engine.stopAll();
    expect(JSON.parse(await fs.readFile(path.join(newRoot, 'data', 'state.json'), 'utf8')).portableRoot).toBe(newRoot);
  });

  it('损坏记录明确失败并保留原文件，不能静默抹掉用户历史', async () => {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    const statePath = path.join(root, 'data', 'state.json');
    await fs.writeFile(statePath, '{broken');
    await expect(createEngine({ portableRoot: root, binDir: root })).rejects.toThrow('原文件已保留');
    expect(await fs.readFile(statePath, 'utf8')).toBe('{broken');
  });
});

describe('独立浏览器捕获环境', () => {
  it('捕获链接分析和下载重试始终继承来源、UA、域隔离jar与捕获时代理', async () => {
    const root = await workspace();
    const cookiePath = path.join(root, 'data', 'captures', 'capture.cookies.txt');
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(cookiePath, '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsession\tprivate-cookie-value\n');
    const mediaUrl = 'https://cdn.example.com/media/master.m3u8?token=captured';
    const context = { referer: 'https://example.com/watch/film', userAgent: 'Capture Browser/1.0', origin: 'https://example.com', cookiePath, proxy: 'http://127.0.0.1:7890' };
    const commands: string[][] = [];
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: (_file, args) => {
      commands.push([...args]);
      if (args.includes('--dump-single-json')) return fakeProcess(JSON.stringify({ id: 'movie', title: '捕获视频', webpage_url: 'https://example.com/canonical-page', formats: [{ format_id: 'hls-720', height: 720, vcodec: 'h264', acodec: 'aac', ext: 'mp4' }] }));
      return fakeProcess('', 1, 'ERROR: connection timed out');
    } });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    const analysis = await engine.analyze(mediaUrl, context);
    expect(analysis.url).toBe(mediaUrl);
    expect(analysis.entries[0].url).toBe(mediaUrl);
    expect(analysis.entries[0].mediaContext).toEqual(context);
    const [task] = await engine.enqueue([{ video: analysis.entries[0], formatId: 'best', formatLabel: '最高画质' }]);
    async function waitForFailures(count: number) {
      for (let i = 0; i < 100; i++) {
        if (commands.filter(args => args.includes('--no-simulate')).length >= count && engine.getTasks().find(t => t.id === task.id)?.status === 'failed') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('下载任务没有按预期结束');
    }
    await waitForFailures(1);
    await engine.saveSettings({ ...engine.getSettings(), proxy: 'http://127.0.0.1:9999' });
    await engine.retryTask(task.id);
    await waitForFailures(2);
    await engine.stopAll();
    expect(commands).toHaveLength(3);
    for (const args of commands) {
      expect(args.at(-1)).toBe(mediaUrl);
      expect(args[args.indexOf('--referer') + 1]).toBe(context.referer);
      expect(args[args.indexOf('--user-agent') + 1]).toBe(context.userAgent);
      expect(args[args.indexOf('--add-headers') + 1]).toBe('Origin:https://example.com');
      expect(args[args.indexOf('--cookies') + 1]).toBe(cookiePath);
      expect(args[args.indexOf('--proxy') + 1]).toBe(context.proxy);
      expect(args.join(' ')).not.toContain('private-cookie-value');
      expect(args.join(' ')).not.toContain('9999');
    }
    expect(await fs.readFile(task.logPath!, 'utf8')).not.toContain('private-cookie-value');
  });

  it('renderer不能通过捕获context读取软件capture目录之外的Cookie文件', async () => {
    const root = await workspace();
    const outside = path.join(root, 'not-a-capture.cookies.txt');
    await fs.writeFile(outside, '# Netscape HTTP Cookie File\n');
    let spawns = 0;
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => { spawns++; return fakeProcess('{}'); } });
    const open = vi.spyOn(fs, 'open');
    try {
      await expect(engine.analyze('https://cdn.example.com/movie.mp4', { referer: 'https://example.com/watch', userAgent: 'Capture/1', proxy: '', cookiePath: outside })).rejects.toThrow('独立捕获会话');
      expect(open).not.toHaveBeenCalled();
      expect(spawns).toBe(0);
    } finally { open.mockRestore(); }
  });

  it('捕获目录内的符号链接若指向外部文件也被拒绝', async () => {
    const root = await workspace();
    const engine = await createEngine({ portableRoot: root, binDir: root });
    const realpath = vi.spyOn(fs, 'realpath').mockResolvedValueOnce(root).mockResolvedValueOnce(path.join(root, 'outside.cookies.txt'));
    const open = vi.spyOn(fs, 'open');
    try {
      await expect(engine.analyze('https://cdn.example.com/movie.mp4', { referer: 'https://example.com/watch', userAgent: 'Capture/1', proxy: '', cookiePath: path.join(root, 'data', 'captures', 'link.cookies.txt') })).rejects.toThrow('不属于独立捕获会话');
      expect(open).not.toHaveBeenCalled();
    } finally { realpath.mockRestore(); open.mockRestore(); }
  });
});

describe('分析取消与长任务输出回归', () => {
  it('成功分析时技术警告仅写解析日志，界面不显示原始英文', async () => {
    const root = await workspace();
    const warning = 'WARNING: [generic] Falling back on generic information extractor';
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => fakeProcess(JSON.stringify({ id: 'ok', title: '示例视频', formats: [{ format_id: '1', vcodec: 'h264', acodec: 'aac', ext: 'mp4' }] }), 0, warning) });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    const result = await engine.analyze('https://example.com/video');
    expect(result.warnings).toEqual([]);
    expect(await fs.readFile(path.join(root, 'data', 'logs', 'analysis.log'), 'utf8')).toContain(warning);
  });

  it('Vimeo回退成功后下载条目仍使用已验证的player网址，不能回到失败原网址', async () => {
    const root = await workspace();
    const requested: string[] = [];
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: (_file, args) => {
      requested.push(args.at(-1)!);
      return requested.length === 1
        ? fakeProcess('null', 0, 'ERROR: The web client only works when logged-in')
        : fakeProcess(JSON.stringify({ id: '76979871', title: '公开视频', webpage_url: 'https://vimeo.com/76979871', formats: [{ format_id: '1', vcodec: 'h264', acodec: 'aac', ext: 'mp4' }] }));
    } });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    const result = await engine.analyze('https://vimeo.com/76979871');
    expect(requested).toEqual(['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871']);
    expect(result.url).toBe('https://player.vimeo.com/video/76979871');
    expect(result.entries[0].url).toBe('https://player.vimeo.com/video/76979871');
  });

  it('提取器输出null时保留真正的原始错误，不能被通用JSON错误掩盖', async () => {
    const root = await workspace();
    const original = 'ERROR: [youtube] movie: Sign in to confirm you are not a bot. Use --cookies to authenticate';
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => fakeProcess('null', 1, original) });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    await expect(engine.analyze('https://www.youtube.com/watch?v=jNQXAC9IVRw')).rejects.toThrow('Cookie');
    expect(await fs.readFile(path.join(root, 'data', 'logs', 'analysis.log'), 'utf8')).toContain('Sign in to confirm you are not a bot');
  });

  it('磁盘满导致状态保存失败时，退出仍会终止真实子进程并报告保存错误', async () => {
    const root = await workspace();
    let resolveStarted!: (child: ChildProcess) => void;
    const started = new Promise<ChildProcess>(resolve => { resolveStarted = resolve; });
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe', windowsHide: true });
      child.once('spawn', () => resolveStarted(child));
      return child;
    } });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    const analysis = engine.analyze('https://example.com/video').catch(error => error as Error);
    const child = await started;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const noSpace = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const write = vi.spyOn(fs, 'writeFile').mockRejectedValue(noSpace);
    try {
      await expect(engine.stopAll()).rejects.toThrow('ENOSPC');
      await closed;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(await analysis).toBeInstanceOf(Error);
      expect(((await analysis) as Error).message).toContain('已取消');
    } finally {
      write.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it('列表某条不可用导致exit1时仍展示有效JSON中的可用视频', async () => {
    const root = await workspace();
    const raw = { title: '合集', entries: [null, { id: 'ok', title: '可访问的视频', webpage_url: 'https://example.com/ok', formats: [{ format_id: '1', vcodec: 'h264', acodec: 'aac', ext: 'mp4' }] }] };
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => fakeProcess(JSON.stringify(raw), 1) });
    engine.getDependencies = async () => [{ name: 'all', available: true, path: root }];
    const result = await engine.analyze('https://example.com/playlist');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('ok');
    expect(result.warnings.some(w => w.includes('部分视频无法解析'))).toBe(true);
  });

  it('依赖检查期间已经持有分析锁；取消后不再启动提取器', async () => {
    const root = await workspace();
    let spawnCount = 0;
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => { spawnCount++; return fakeProcess('{}'); } });
    let release!: () => void;
    engine.getDependencies = async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ name: 'all', available: true, path: root }]; };
    const analysis = engine.analyze('https://example.com/video');
    expect(engine.isBusy()).toBe(true);
    await expect(engine.analyze('https://example.com/second')).rejects.toThrow('正在分析');
    await engine.cancelAnalysis(); release();
    await expect(analysis).rejects.toThrow('已取消');
    expect(spawnCount).toBe(0);
    expect(engine.isBusy()).toBe(false);
  });

  it('下载进度超过缓冲限制时保留尾部，分析JSON超限才报错', async () => {
    const root = await workspace();
    const engine = await createEngine({ portableRoot: root, binDir: root, spawnProcess: () => fakeProcess('x'.repeat(4096) + 'END') });
    const internal = engine as unknown as { run(file: string, args: string[], options: Record<string, unknown>): Promise<{ code: number; stdout: string }> };
    const result = await internal.run('fake', [], { owner: {}, limit: 100 });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(100);
    expect(result.stdout.endsWith('END')).toBe(true);
    await expect(internal.run('fake', [], { limit: 100 })).rejects.toThrow('列表信息过大');
  });
});
