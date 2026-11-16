import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build, Platform, Arch } from 'electron-builder';
const run = (command, args) => new Promise((resolve, reject) => {
  const proc = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true });
  proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`构建失败 (${code})`)));
});
for (const exe of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe']) {
  try { await access(`resources/bin/${exe}`); } catch { throw new Error(`缺少 ${exe}，请先执行 npm run deps:prepare。`); }
}
const manifest = JSON.parse(await readFile('resources/dependencies.json', 'utf8'));
for (const dependency of manifest.dependencies) for (const file of dependency.files) {
  const contents = await readFile(path.join('resources/bin', file.name));
  if (createHash('sha256').update(contents).digest('hex') !== file.sha256) throw new Error(`组件校验不匹配：${file.name}。请更新依赖清单或重新准备官方组件。`);
}
await run(process.execPath, ['scripts/build.mjs']);
await run(process.execPath, ['scripts/licenses.mjs']);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = `releases/build-${stamp}`;
await mkdir(output, { recursive: true });
const target = process.argv.includes('--dir') ? 'dir' : 'zip';
const result = await build({
  targets: Platform.WINDOWS.createTarget(target, Arch.x64),
  config: {
    directories: { output },
    electronDist: path.resolve('node_modules/electron/dist'),
    afterPack: async context => { await copyFile('docs/使用说明.md', path.join(context.appOutDir, '使用说明.md')); },
  },
  publish: 'never',
});
await writeFile('releases/latest-build.json', JSON.stringify({ output, artifacts: result, builtAt: new Date().toISOString() }, null, 2));
console.log(`便携版已生成：${output}`);
