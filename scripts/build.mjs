import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
await viteBuild();
await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/main.cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/preload.cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['electron/helper-preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist-electron/helper-preload.cjs', external: ['electron'], sourcemap: true });
console.log('已完成界面和桌面程序构建。');
