/** Download the pinned Windows x64 toolchain. No files are deleted by this script. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'resources', 'bin');
const licenses = join(root, 'resources', 'licenses');
const cache = join(root, '.resources-cache');
const update = process.argv.includes('--refresh');
const headers = { 'User-Agent': 'FrameCatch-portable-build', Accept: 'application/vnd.github+json' };
const specs = [
  { name: 'yt-dlp', repository: 'yt-dlp/yt-dlp', tag: '2026.10.26', asset: 'yt-dlp.exe', checksumAsset: 'SHA2-256SUMS', executables: ['yt-dlp.exe'], license: 'Unlicense; bundled components have their own licenses', sourceUrl: 'https://github.com/yt-dlp/yt-dlp/tree/2026.10.26' },
  { name: 'ffmpeg', repository: 'FFmpeg-Builds/FFmpeg-Builds', tag: 'autobuild-2026-11-14-12-37', asset: 'ffmpeg-n9.0.2-57-gd838f9f9ae-win64-lgpl-shared-9.0.zip', checksumAsset: 'checksums.sha256', executables: ['ffmpeg.exe', 'ffprobe.exe'], license: 'LGPL-3.0-or-later; see accompanying component notices', sourceUrl: 'https://github.com/FFmpeg/FFmpeg/tree/d838f9f9ae', buildSourceUrl: 'https://github.com/FFmpeg-Builds/FFmpeg-Builds' },
  { name: 'deno', repository: 'denoland/deno', tag: 'v2.9.8', asset: 'deno-x86_64-pc-windows-msvc.zip', checksumAsset: 'deno-x86_64-pc-windows-msvc.zip.sha256sum', executables: ['deno.exe'], license: 'MIT; bundled components have their own licenses', sourceUrl: 'https://github.com/denoland/deno/tree/v2.9.8' },
];

// Node does not inherit the Windows browser proxy automatically. Apply it only
// to this dependency-preparation process, without changing machine settings.
if (process.platform === 'win32' && !process.env.FRAMECATCH_DEP_PROXY) {
  let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if($p.ProxyEnable -eq 1){$p.ProxyServer}"], { windowsHide: true, timeout: 10_000 });
      const setting = stdout.trim();
      proxy = setting.includes('=') ? (setting.match(/(?:^|;)https?=([^;]+)/)?.[1]) : setting;
    } catch { /* A system proxy is optional. */ }
  }
  if (proxy) {
    if (!proxy.includes('://')) proxy = `http://${proxy}`;
    if (/^https?:\/\//i.test(proxy)) {
      console.log('组件下载使用当前进程或 Windows 已配置的代理。');
      const child = spawn(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, FRAMECATCH_DEP_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_USE_ENV_PROXY: '1' }, stdio: 'inherit', windowsHide: true });
      const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
      process.exit(code ?? 1);
    }
  }
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function retry(operation) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await operation(); } catch (error) { last = error; if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
  }
  throw last;
}
async function getText(url) {
  return retry(async () => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(40_000) });
    if (!response.ok) throw new Error(`请求失败 ${response.status}: ${url}`);
    return response.text();
  });
}
async function download(url, destination, expected) {
  if (!url.startsWith('https://')) throw new Error('仅允许 HTTPS 下载');
  if (await exists(destination)) {
    const actual = await sha256(destination);
    if (actual === expected) { console.log(`缓存校验通过：${destination.split(/[\\/]/).at(-1)}`); return; }
    throw new Error(`缓存 SHA256 不匹配，已保留文件以供检查：${destination}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await retry(async () => {
    const partial = `${destination}.attempt-${randomUUID()}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    const actual = await sha256(partial);
    if (actual !== expected) throw new Error(`SHA256 不匹配，保留下载文件：${partial}`);
    await copyFile(partial, destination);
  });
}
async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path)); else out.push(path);
  }
  return out;
}
async function installFile(source, destination) {
  if (await exists(destination)) {
    if (await sha256(source) === await sha256(destination)) return;
    if (!update) throw new Error(`目标已存在且内容不同，已保留。确认升级后运行 --refresh：${destination}`);
    const backup = `${destination}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(destination, backup);
    console.log(`升级前备份：${backup.split(/[\\/]/).at(-1)}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
async function toolVersion(name) {
  const { stdout, stderr } = await execute(join(bin, name), name.startsWith('ff') ? ['-version'] : ['--version'], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return (stdout || stderr).trim();
}

await mkdir(bin, { recursive: true });
await mkdir(licenses, { recursive: true });
await mkdir(cache, { recursive: true });
const previousPath = join(root, 'resources', 'dependencies.json');
if (!update && await exists(previousPath)) {
  const previous = JSON.parse(await readFile(previousPath, 'utf8'));
  const all = previous.dependencies?.flatMap(dep => dep.files ?? []) ?? [];
  const noticesReady = (await Promise.all(['yt-dlp-LICENSE.txt', 'yt-dlp-THIRD_PARTY_LICENSES.txt', 'deno-LICENSE.txt', 'ffmpeg-GPL-3.0.txt', 'ffmpeg-LGPL-3.0.txt', 'sources/SHA256SUMS'].map(name => exists(join(licenses, name))))).every(Boolean);
  const pinsMatch = specs.every(spec => previous.dependencies?.some(dep => dep.name === spec.name && dep.release === spec.tag));
  if (pinsMatch && noticesReady && all.length >= 4 && (await Promise.all(all.map(async entry => await exists(join(bin, entry.name)) && await sha256(join(bin, entry.name)) === entry.sha256))).every(Boolean)) {
    for (const name of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe']) console.log(`${name}: ${(await toolVersion(name)).split(/\r?\n/)[0]}`);
    console.log('便携组件校验通过，无需重新下载。');
    process.exit(0);
  }
}

const dependencies = [];
for (const spec of specs) {
  console.log(`准备 ${spec.name} ${spec.tag} …`);
  const releaseUrl = `https://api.github.com/repos/${spec.repository}/releases/tags/${spec.tag}`;
  const releaseText = await getText(releaseUrl);
  const release = JSON.parse(releaseText);
  const asset = release.assets.find(item => item.name === spec.asset);
  const sumsAsset = release.assets.find(item => item.name === spec.checksumAsset);
  if (!asset || !sumsAsset) throw new Error(`官方发布缺少预期文件：${spec.asset}`);
  const sumsText = await getText(sumsAsset.browser_download_url);
  const checksumLine = sumsText.split(/\r?\n/).find(line => line.includes(spec.asset));
  const expected = (checksumLine?.match(/\b[a-fA-F0-9]{64}\b/)?.[0] || (spec.name === 'deno' ? sumsText.match(/Hash\s*:\s*([a-fA-F0-9]{64})/i)?.[1] : undefined))?.toLowerCase();
  if (!expected) throw new Error(`找不到官方 SHA256：${spec.asset}`);
  if (asset.digest && asset.digest !== `sha256:${expected}`) throw new Error(`GitHub API 摘要与官方校验文件不一致：${spec.asset}`);
  const specCache = join(cache, spec.name, spec.tag);
  await mkdir(specCache, { recursive: true });
  await writeFile(join(specCache, 'release.json'), releaseText);
  await writeFile(join(specCache, spec.checksumAsset), sumsText);
  const archive = join(specCache, spec.asset);
  await download(asset.browser_download_url, archive, expected);
  let copied = [];
  if (spec.asset.endsWith('.exe')) {
    await installFile(archive, join(bin, spec.asset));
    copied = [spec.asset];
  } else {
    const extracted = join(specCache, 'extracted');
    if (!await exists(join(extracted, '.complete'))) {
      await mkdir(extracted, { recursive: true });
      // Paths arrive via env variables, not interpolated shell code.
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; $base=[IO.Path]::GetFullPath($env:FRAMECATCH_EXTRACT)+[IO.Path]::DirectorySeparatorChar; $z=[IO.Compression.ZipFile]::OpenRead($env:FRAMECATCH_ARCHIVE); try { foreach($e in $z.Entries){ $out=[IO.Path]::GetFullPath([IO.Path]::Combine($base,$e.FullName)); if(-not $out.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe archive entry'}; if($e.Name -eq ''){[IO.Directory]::CreateDirectory($out)|Out-Null}else{[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))|Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$out,$true)} } } finally { $z.Dispose() }"], {
        env: { ...process.env, FRAMECATCH_ARCHIVE: archive, FRAMECATCH_EXTRACT: extracted }, windowsHide: true, timeout: 240_000, maxBuffer: 1024 * 1024,
      });
      await writeFile(join(extracted, '.complete'), expected);
    }
    const extractedFiles = await filesUnder(extracted);
    const binaryFiles = extractedFiles.filter(path => spec.executables.includes(path.split(/[\\/]/).at(-1)) || spec.name === 'ffmpeg' && path.toLowerCase().endsWith('.dll'));
    if (!spec.executables.every(name => binaryFiles.some(path => path.endsWith(name)))) throw new Error(`压缩包缺少执行文件：${spec.name}`);
    for (const path of binaryFiles) { const name = path.split(/[\\/]/).at(-1); await installFile(path, join(bin, name)); copied.push(name); }
    if (spec.name === 'ffmpeg') {
      const noticeDir = join(licenses, 'ffmpeg');
      for (const path of extractedFiles.filter(path => /[\\/](licenses|doc)[\\/]/i.test(path) && /(?:license|copying|notice|readme)/i.test(path.split(/[\\/]/).at(-1)) || /[\\/](LICENSE|COPYING)(?:\.[^\\/]+)?$/i.test(path))) {
        const relative = path.slice(extracted.length + 1);
        await installFile(path, join(noticeDir, relative));
      }
    }
  }
  const versions = {};
  for (const name of spec.executables) { versions[name] = await toolVersion(name); console.log(`${name}: ${versions[name].split(/\r?\n/)[0]}`); }
  const files = [];
  for (const name of copied) files.push({ name, size: (await stat(join(bin, name))).size, sha256: await sha256(join(bin, name)) });
  dependencies.push({ name: spec.name, release: spec.tag, repository: `https://github.com/${spec.repository}`, releaseUrl: release.html_url, sourceUrl: spec.sourceUrl, buildSourceUrl: spec.buildSourceUrl, downloadUrl: asset.browser_download_url, checksumUrl: sumsAsset.browser_download_url, archiveSha256: expected, archiveSize: asset.size, license: spec.license, versions, files });
}

for (const [name, url] of [
  ['yt-dlp-LICENSE.txt', 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/LICENSE'],
  ['yt-dlp-THIRD_PARTY_LICENSES.txt', 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.10.26/THIRD_PARTY_LICENSES.txt'],
  ['deno-LICENSE.txt', 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/LICENSE.md'],
  ['deno-node-types-LICENSE.txt', 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/cli/tsc/dts/node/LICENSE'],
  ['deno-undici-types-LICENSE.txt', 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/cli/tsc/dts/node/undici/LICENSE'],
  ['deno-webgpu-LICENSE.txt', 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/ext/webgpu/LICENSE.md'],
  ['deno-Cargo.lock', 'https://raw.githubusercontent.com/denoland/deno/v2.9.8/Cargo.lock'],
  ['ffmpeg-build-README.md', 'https://raw.githubusercontent.com/FFmpeg-Builds/FFmpeg-Builds/master/README.md'],
  ['ffmpeg-LGPL-3.0.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/d838f9f9aeb0e09b4d068e2af20a46a12640696f/COPYING.LGPLv3'],
  ['ffmpeg-GPL-3.0.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/d838f9f9aeb0e09b4d068e2af20a46a12640696f/COPYING.GPLv3'],
]) await writeFile(join(licenses, name), await getText(url));

const ffmpegLicense = await execute(join(bin, 'ffmpeg.exe'), ['-L'], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
await writeFile(join(licenses, 'ffmpeg-build-configuration-and-license.txt'), `${ffmpegLicense.stderr}\n${ffmpegLicense.stdout}`);
const sources = [];
const sourceDir = join(licenses, 'sources');
await mkdir(sourceDir, { recursive: true });
for (const [name, url] of [
  ['ffmpeg-d838f9f9aeb0e09b4d068e2af20a46a12640696f.tar.gz', 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/d838f9f9aeb0e09b4d068e2af20a46a12640696f'],
  ['ffmpeg-build-recipes-c9fe5114060e507409f7ee07edfd82efaf25d767.tar.gz', 'https://codeload.github.com/FFmpeg-Builds/FFmpeg-Builds/tar.gz/c9fe5114060e507409f7ee07edfd82efaf25d767'],
]) {
  const destination = join(sourceDir, name);
  if (!await exists(destination)) {
    console.log(`保留匹配源码：${name}`);
    await retry(async () => {
      const partial = join(cache, `${name}.attempt-${randomUUID()}`);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`源码下载失败 ${response.status}: ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
      await copyFile(partial, destination);
    });
  }
  sources.push({ name, url, sha256: await sha256(destination), size: (await stat(destination)).size, checksumNote: 'Upstream provides no detached checksum for generated source archives; this digest records the HTTPS download of the pinned commit.' });
}
await writeFile(join(sourceDir, 'SHA256SUMS'), sources.map(source => `${source.sha256}  ${source.name}`).join('\n') + '\n');
await writeFile(previousPath, JSON.stringify({ schemaVersion: 1, platform: 'win32-x64', preparedAt: new Date().toISOString(), dependencies, sources }, null, 2) + '\n');
console.log('便携组件全部就绪。下载缓存与中间文件已保留在 .resources-cache；没有删除任何文件。');
