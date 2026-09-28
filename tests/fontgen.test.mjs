/**
 * fontgen.test.mjs — S12 SDF 字体工具链测试（node:test）。
 * 只 import tools/fontgen/*（纯 ESM 源码），不 import dist。
 * fontgen 依赖（opentype.js）未安装时，生成类用例 skip 并提示安装命令。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = new URL('.', import.meta.url);
const FONTGEN = new URL('../tools/fontgen/', HERE);
const ROOT = fileURLToPath(new URL('../', HERE));

// 依赖探测：以 tools/fontgen/package.json 为锚解析 opentype.js
let depsInstalled = true;
try {
  createRequire(new URL('package.json', FONTGEN)).resolve('opentype.js');
} catch {
  depsInstalled = false;
}
const SKIP_GEN = depsInstalled ? false : 'fontgen 依赖未安装：cd tools/fontgen && npm install';

const { collectCharset, extractChars, formatCharset, parseCharset, isAsciiPrintable, scanTargets } =
  await import(new URL('charset.mjs', FONTGEN));
const pngLib = await import(new URL('lib/png.mjs', FONTGEN)); // 纯 node:zlib，无外部依赖

let gen = null;
if (depsInstalled) gen = await import(new URL('gen.mjs', FONTGEN));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const TEST_CPS = [...new Set([...'AB0雷酷跑霆❤♡·…'].map((c) => c.codePointAt(0)))].sort((a, b) => a - b);
const makeOpts = () => ({ size: 24, spread: 6, padding: 2, gap: 2, maxWidth: 512 });

/** 探测可用系统字体；无字体环境返回 null（相关断言整体跳过）。 */
function fontSource(hint = 'cjk') {
  return gen.loadFontSource('auto', hint);
}

// ---------------- charset（无依赖，恒跑） ----------------

test('charset: ASCII 可打印集完整收录', () => {
  const cps = collectCharset(ROOT);
  for (let c = 0x20; c <= 0x7e; c++) assert.ok(cps.includes(c), `missing ASCII 0x${c.toString(16)}`);
});

test('charset: 覆盖 screens.ts 与 config/*.json 的全部非 ASCII 字符', () => {
  const cps = new Set(collectCharset(ROOT));
  const targets = scanTargets(ROOT);
  assert.ok(targets.length >= 2, 'scan targets too few');
  let nonAsciiFound = 0;
  for (const f of targets) {
    for (const cp of extractChars([readFileSync(f, 'utf8')], { asciiPrintable: false })) {
      if (!isAsciiPrintable(cp)) nonAsciiFound++;
      assert.ok(cps.has(cp), `U+${cp.toString(16)} from ${f} not in charset`);
    }
  }
  assert.ok(nonAsciiFound > 50, `expected substantial CJK, got ${nonAsciiFound}`);
  assert.ok(cps.has('雷'.codePointAt(0)) && cps.has('霆'.codePointAt(0)), '游戏名用字缺失');
});

test('charset: 排序、去重、roundtrip', () => {
  const cps = collectCharset(ROOT);
  assert.deepEqual(cps, [...cps].sort((a, b) => a - b));
  assert.equal(new Set(cps).size, cps.length);
  assert.deepEqual(parseCharset(formatCharset(cps)), cps);
});

test('charset: 与已提交的 assets/fonts/charset.txt 一致（改文案需重新生成）', {
  skip: !existsSync(`${ROOT}assets/fonts/charset.txt`) ? 'charset.txt 尚未生成' : false,
}, () => {
  const committed = parseCharset(readFileSync(`${ROOT}assets/fonts/charset.txt`, 'utf8'));
  assert.deepEqual(committed, collectCharset(ROOT));
});

// ---------------- 生成（依赖 opentype.js，缺失时 skip） ----------------

test('gen: 同输入两次生成，PNG 与 metrics 字节级一致', { skip: SKIP_GEN }, () => {
  const src = fontSource();
  if (!src) return; // 无系统字体的环境不算失败
  const a = gen.generateAtlas({ ...makeOpts(), ...src, codepoints: TEST_CPS });
  const b = gen.generateAtlas({ ...makeOpts(), ...src, codepoints: TEST_CPS });
  assert.equal(sha256(a.png), sha256(b.png), 'PNG hash mismatch');
  assert.equal(sha256(Buffer.from(JSON.stringify(a.metrics))), sha256(Buffer.from(JSON.stringify(b.metrics))), 'metrics hash mismatch');
});

test('gen: metrics 字段完备、UV/单元合法、单元互不重叠', { skip: SKIP_GEN }, () => {
  const src = fontSource();
  if (!src) return;
  const { metrics } = gen.generateAtlas({ ...makeOpts(), ...src, codepoints: TEST_CPS });
  assert.equal(metrics.format, 'tr-sdf-atlas/1');
  for (const k of ['fontSize', 'spread', 'padding', 'buffer', 'encoding']) assert.ok(k in metrics.sdf, `sdf.${k}`);
  for (const k of ['width', 'height', 'channels']) assert.ok(k in metrics.atlas, `atlas.${k}`);
  for (const k of ['ascenderPx', 'descenderPx', 'lineHeightPx', 'scalePxPerUnit']) assert.ok(k in metrics.baseline, `baseline.${k}`);
  assert.ok(metrics.baseline.ascenderPx > 0 && metrics.baseline.descenderPx < 0);
  assert.ok(Array.isArray(metrics.missing));
  assert.equal(metrics.glyphs.length + metrics.missing.length, TEST_CPS.length);
  const rects = [];
  for (const g of metrics.glyphs) {
    for (const k of ['char', 'codepoint', 'advance', 'bearingX', 'bearingY', 'inkW', 'inkH', 'cell', 'uv']) {
      assert.ok(k in g, `glyph ${g.char} missing field ${k}`);
    }
    assert.ok(g.advance > 0, `${g.char} advance`);
    const { x, y, w, h } = g.cell;
    assert.ok(w >= 2 * metrics.sdf.buffer && h >= 2 * metrics.sdf.buffer, `${g.char} cell too small`);
    assert.ok(x >= 0 && y >= 0 && x + w <= metrics.atlas.width && y + h <= metrics.atlas.height, `${g.char} cell out of atlas`);
    for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(g.uv[k] >= 0 && g.uv[k] <= 1, `${g.char} uv.${k}`);
    assert.ok(g.uv.x1 > g.uv.x0 && g.uv.y1 > g.uv.y0);
    rects.push({ id: g.char, x, y, w, h });
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `cells overlap: ${a.id} vs ${b.id}`);
    }
  }
});

test('gen: 字符集覆盖——全部字符进入 glyphs 或 missing，missing 均为字体真缺', { skip: SKIP_GEN }, () => {
  const src = fontSource();
  if (!src) return;
  const cps = collectCharset(ROOT);
  const { metrics } = gen.generateAtlas({ ...makeOpts(), ...src, codepoints: cps });
  const covered = new Set(metrics.glyphs.map((g) => g.codepoint));
  for (const cp of cps) {
    assert.ok(covered.has(cp) || metrics.missing.includes(String.fromCodePoint(cp)),
      `U+${cp.toString(16)} neither in glyphs nor missing`);
  }
  for (const ch of metrics.missing) {
    assert.equal(src.font.charToGlyph(ch).index, 0, `${ch} claimed missing but font has it`);
  }
});

test('gen: SDF 编码——墨迹深处接近 255、远外部接近 0、沿行扫过 0.5 边缘', { skip: SKIP_GEN }, () => {
  const src = fontSource();
  if (!src) return;
  const { atlas, metrics, width } = gen.generateAtlas({ ...makeOpts(), ...src, codepoints: ['雷'.codePointAt(0)] });
  const g = metrics.glyphs.find((x) => x.char === '雷');
  assert.ok(g, '雷 not rasterized');
  const at = (dx, dy) => atlas[(g.cell.y + dy) * width + g.cell.x + dx];
  assert.ok(at(0, 0) < 10, 'cell corner should be far outside');
  let mx = 0, my = 0, maxV = -1;
  for (let y = 0; y < g.cell.h; y++) {
    for (let x = 0; x < g.cell.w; x++) {
      const v = at(x, y);
      if (v > maxV) { maxV = v; mx = x; my = y; }
    }
  }
  assert.ok(maxV > 200, `deep-inside value too low: ${maxV}`);
  let crossed = false, prev = at(0, my);
  for (let x = 1; x <= mx; x++) {
    const v = at(x, my);
    if ((prev - 127.5) * (v - 127.5) <= 0 && prev !== v) crossed = true;
    prev = v;
  }
  assert.ok(crossed, 'no 0.5-crossing found along scanline (no edge)');
});

test('assets: 已提交图集可解码且与 metrics 尺寸一致', () => {
  for (const name of ['latin', 'cjk']) {
    const pngPath = `${ROOT}assets/fonts/${name}.png`;
    const metPath = `${ROOT}assets/fonts/${name}.metrics.json`;
    if (!existsSync(pngPath) || !existsSync(metPath)) continue; // 尚未生成时不算失败
    const metrics = JSON.parse(readFileSync(metPath, 'utf8'));
    const { width, height } = pngLib.decodeGray8(readFileSync(pngPath));
    assert.equal(width, metrics.atlas.width, `${name} width`);
    assert.equal(height, metrics.atlas.height, `${name} height`);
    assert.ok(metrics.glyphs.length > 0, `${name} has no glyphs`);
    for (const g of metrics.glyphs) {
      assert.ok(g.cell.x + g.cell.w <= width && g.cell.y + g.cell.h <= height, `${name} ${g.char} cell out of bounds`);
    }
  }
});
