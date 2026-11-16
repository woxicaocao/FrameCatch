import { _electron } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = process.cwd();
const latest = JSON.parse(await readFile('releases/latest-build.json', 'utf8'));
const zip = process.argv[2] || latest.artifacts.find(file => file.endsWith('.zip'));
if (!zip) throw new Error('请先执行 npm run package:portable。');
const artifacts = path.join(root, '.test-artifacts', `portable-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const portable = path.join(artifacts, '映取 便携版');
await mkdir(portable, { recursive: true });
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const cleanEnv = { ...process.env, PATH: `${systemRoot}\\System32;${systemRoot}`, FRAMECATCH_ZIP: path.resolve(zip), FRAMECATCH_DEST: portable };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
delete cleanEnv.FRAMECATCH_DEV_URL;
delete cleanEnv.FRAMECATCH_TEST_ROOT;
function run(executable, args, env = cleanEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd: root, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `进程退出 ${code}`)));
  });
}
const extractScript = '[void][System.Reflection.Assembly]::LoadWithPartialName("System.IO.Compression.FileSystem"); [System.IO.Compression.ZipFile]::ExtractToDirectory($env:FRAMECATCH_ZIP, $env:FRAMECATCH_DEST)';
await run(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(extractScript, 'utf16le').toString('base64')]);
const checks = [];
const passed = name => { checks.push(name); console.log(`通过：${name}`); };
const manifests = JSON.parse(await readFile(path.join(portable, 'resources/dependencies.json'), 'utf8'));
for (const dependency of manifests.dependencies) for (const item of dependency.files) {
  const bytes = await readFile(path.join(portable, 'resources/bin', item.name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.name);
}
await access(path.join(portable, '使用说明.md'));
const extensionManifest = JSON.parse(await readFile(path.join(portable, '浏览器插件/manifest.json'), 'utf8'));
assert.equal(extensionManifest.version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
assert.equal(extensionManifest.manifest_version, 3);
await access(path.join(portable, '浏览器插件/background.js'));
passed('真实 ZIP 解压完整、11个组件文件哈希一致、附中文使用说明及浏览器插件');
const fixture = path.join(artifacts, 'portable-test.mp4');
await run(path.join(portable, 'resources/bin/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'mpeg4', '-c:a', 'aac', fixture]);
const fixtureSize = (await stat(fixture)).size;
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureSize });
  if (request.method === 'HEAD') response.end(); else createReadStream(fixture).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let desktop;
let completedTask;
try {
  desktop = await _electron.launch({ executablePath: path.join(portable, 'FrameCatch.exe'), args: [], env: cleanEnv, timeout: 60000 });
  let page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('url-input').waitFor();
  const snapshot = await page.evaluate(() => window.desktopApi.getSnapshot());
  assert.equal(snapshot.dependencies.filter(item => item.available).length, 4);
  assert.equal(snapshot.portableRoot, portable);
  assert.equal(snapshot.settings.outputDir, path.join(portable, 'Downloads'));
  passed('清空开发工具 PATH 后便携 EXE 正常启动，数据保存在软件旁');
  const url = `http://127.0.0.1:${server.address().port}/portable-test.mp4`;
  await page.getByTestId('url-input').fill(url);
  await page.getByTestId('analyze-button').click();
  await page.getByTestId('download-button').waitFor({ timeout: 45000 });
  await page.getByTestId('download-button').click();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const current = (await page.evaluate(() => window.desktopApi.getSnapshot())).tasks[0];
    if (current?.status === 'completed') { completedTask = current; break; }
    if (current?.status === 'failed') throw new Error(current.error);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(completedTask, '便携版下载没有完成');
  assert.ok(completedTask.outputPath.startsWith(portable));
  const probe = JSON.parse(await run(path.join(portable, 'resources/bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', completedTask.outputPath]));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(artifacts, 'portable-workbench.png'), fullPage: true });
  passed('真实发行 EXE 下载并验证完整音视频，不依赖系统 Python/Node/FFmpeg');

  await desktop.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options) => { globalThis.__cleanupPrompt = options; return { response: 0, checkboxChecked: false }; };
  });
  const cleanup = await page.evaluate(id => window.desktopApi.cleanupTask(id), completedTask.id);
  assert.equal(cleanup.cancelled, true);
  const prompt = await desktop.evaluate(() => globalThis.__cleanupPrompt);
  assert.ok(prompt.detail.includes(completedTask.workDir));
  assert.ok(prompt.detail.includes('.framecatch-staging'));
  await access(completedTask.outputPath); await access(completedTask.workDir);
  passed('临时清理列出两处目录，默认保留且未删除任何文件');
  await desktop.close(); desktop = undefined;

  const relocated = path.join(artifacts, '迁移后 软件');
  await cp(portable, relocated, { recursive: true, force: false, errorOnExist: true });
  desktop = await _electron.launch({ executablePath: path.join(relocated, 'FrameCatch.exe'), args: [], env: cleanEnv, timeout: 60000 });
  page = await desktop.firstWindow();
  await page.getByTestId('url-input').waitFor();
  const moved = await page.evaluate(() => window.desktopApi.getSnapshot());
  assert.equal(moved.settings.outputDir, path.join(relocated, 'Downloads'));
  assert.equal(moved.tasks[0].status, 'completed');
  assert.ok(moved.tasks[0].outputPath.startsWith(relocated));
  await access(moved.tasks[0].outputPath);
  passed('复制迁移便携目录后配置、成品路径和历史正确恢复');
} finally {
  if (desktop) await desktop.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ zip: path.resolve(zip), checkedAt: new Date().toISOString(), checks, completedTask }, null, 2));
  console.log(`便携验证报告：${artifacts}`);
}
