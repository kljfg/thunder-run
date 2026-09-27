/**
 * 生成测试纹理 assets/tex.png（128×128，POT——WebGL1 降级路径也能开 mipmap）。
 * 图案：蓝/深蓝棋盘格 + 白色边框 + 黄色对角条带（旋转/UV 方向肉眼可辨）。
 * 纯 node 实现（zlib + 手写 PNG chunk），无任何依赖。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 128;
const CELL = 16;
const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'assets', 'tex.png');

const C1 = [0x3f, 0x7f, 0xff]; // 电光蓝
const C2 = [0x14, 0x24, 0x4a]; // 深蓝
const WHITE = [0xff, 0xff, 0xff];
const YELLOW = [0xff, 0xd2, 0x3f];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 像素数据：每行前缀 filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let x = 0; x < SIZE; x++) {
    const border = x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3;
    const diag = Math.abs(x - y) < 4 || Math.abs(x - (SIZE - 1 - y)) < 4;
    const checker = ((x / CELL) | 0) % 2 === ((y / CELL) | 0) % 2;
    let c = checker ? C1 : C2;
    if (diag) c = YELLOW;
    if (border) c = WHITE;
    const o = rowStart + 1 + x * 4;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 0xff;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log('written', outPath, png.length, 'bytes', SIZE + 'x' + SIZE);
