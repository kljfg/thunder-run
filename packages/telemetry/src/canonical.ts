/**
 * 规范序列化与哈希纯函数（spec §8「三线对齐」的前提：与 tools/replay/runner.mjs 逐字节同语义）。
 * canonicalJson：键递归字典序、无空白；sha256Hex：UTF-8 输入的 sha256（纯 TS 实现，
 * node/浏览器/小游戏三端同一份代码，云函数与 CI 可直接复用——S18 上报体同源哈希）。
 * fnv1a32：采样判定用的稳定哈希（spec §3.2/D3）。零宿主依赖（不触 TextEncoder/crypto 全局）。
 */

/** 键序稳定的规范 JSON：同数据在任何机器/语言序列化结果一致（与 tools/replay/runner.mjs:35-44 同款语义）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** 字符串 → UTF-8 字节（自实现，避免 TextEncoder 宿主依赖，保证三端编码一致）。 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // 代理对占两个 code unit
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** UTF-8 字节长度（限流/批量的字节预算按此计，spec §3.3/§3.4）。 */
export function utf8Length(text: string): number {
  return utf8Bytes(text).length;
}

/** 按 UTF-8 字节截断（保留头部），不切断多字节字符（栈/message 截断用，spec §4.5）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // 代理对
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + len > maxBytes) break;
    bytes += len;
    out += String.fromCodePoint(cp);
  }
  return out;
}

// ---------- sha256（FIPS 180-4，纯 TS；测试对拍 node:crypto） ----------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = bytes.length * 8;
  const total = (Math.floor((bytes.length + 8) / 64) + 1) * 64; // 含 0x80 与 8 字节长度
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000)); // 长度高 32 位（实际恒 0）
  dv.setUint32(total - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}

// ---------- FNV-1a 32 位（spec §3.2/D3） ----------

/** FNV-1a 32 位哈希（对 UTF-8 字节；判定式可在服务端重算）。 */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  const bytes = utf8Bytes(text);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 会话级稳定采样判定：fnv1a32(sid + '\u0000' + name) % 100 < rate（同会话同名事件全留或全丢）。 */
export function sampleAccepts(sid: string, name: string, rate: number): boolean {
  if (rate >= 100) return true;
  if (rate <= 0) return false;
  return fnv1a32(sid + '\u0000' + name) % 100 < rate;
}

// ---------- 随机标识（spec §2：bootId 12 hex / sid 16 hex） ----------

/** 随机 hex 串：优先宿主 CSPRNG（web crypto.getRandomValues / wx 基础库同名全局），退化 Math.random。 */
export function randomHex(chars: number): string {
  const n = Math.ceil(chars / 2);
  const bytes = new Uint8Array(n);
  const g = globalThis as { crypto?: { getRandomValues?(a: Uint8Array): unknown } };
  if (typeof g.crypto?.getRandomValues === 'function') g.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = (Math.random() * 256) | 0;
  let out = '';
  for (let i = 0; i < n; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out.slice(0, chars);
}
