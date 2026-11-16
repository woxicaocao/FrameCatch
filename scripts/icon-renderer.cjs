const { Resvg } = require('@resvg/resvg-js');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const svg = await fs.readFile(path.join(root, 'src/brand.svg'), 'utf8');
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map(size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
  await fs.writeFile(path.join(root, 'resources/icon.png'), pngs.at(-1));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16;
    header[entry] = sizes[i] === 256 ? 0 : sizes[i]; header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += pngs[i].length;
  }
  await fs.writeFile(path.join(root, 'resources/icon.ico'), Buffer.concat([header, ...pngs]));
  console.log('已由矢量品牌图标导出 PNG 与多尺寸 Windows ICO。');
})().catch(error => { console.error(error); process.exitCode = 1; });
