/**
 * 占位音频生成（S17 管线打通用；内容侧按 assets/audio/README.md 规范替换后可删）。
 * 用法（lamejs 是临时编码依赖，不入库不进 package.json）：
 *   npm install --no-save @breezystack/lamejs
 *   node assets/audio/gen-placeholders.mjs
 * 输出：44.1kHz 单声道 96kbps MP3，峰值归一到约 -1 dBFS。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const outDir = dirname(fileURLToPath(import.meta.url));

/** 线性插值扫频正弦（phase 连续积分，防爆音）。 */
function sweep(dur, f0, f1, amp = 1) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 + (f1 - f0) * (t / dur);
    phase += (2 * Math.PI * f) / SR;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

/** 确定性噪声（LCG，保证同脚本同产物）。 */
function noise(dur, seed = 12345) {
  const n = Math.round(SR * dur);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 2 ** 32) * 2 - 1;
  }
  return out;
}

const envExp = (a, k) => { for (let i = 0; i < a.length; i++) a[i] *= Math.exp(-(i / SR) * k); return a; };
const attack = (a, ms) => {
  const n = Math.round(SR * ms / 1000);
  for (let i = 0; i < Math.min(n, a.length); i++) a[i] *= i / n;
  return a;
};
const fadeInOut = (a, ms) => {
  const n = Math.min(Math.round(SR * ms / 1000), Math.floor(a.length / 2));
  for (let i = 0; i < n; i++) { a[i] *= i / n; a[a.length - 1 - i] *= i / n; }
  return a;
};
const mix = (...parts) => {
  const n = Math.max(...parts.map(p => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
};

function peakNormalize(a, target = 0.89) {
  let peak = 0;
  for (const v of a) peak = Math.max(peak, Math.abs(v));
  if (peak > 1e-6) for (let i = 0; i < a.length; i++) a[i] *= target / peak;
  return a;
}

function toInt16(a) {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.round(Math.min(1, Math.max(-1, a[i])) * 32767);
  return out;
}

// ---------- 三个占位音色 ----------

function coinSound() { // 两音上跳 blip：1180Hz(50ms) → 1560Hz(90ms)，短促衰减
  const seg1 = attack(envExp(sweep(0.05, 1180, 1180), 22), 2);
  const seg2 = attack(envExp(sweep(0.09, 1560, 1560, 0.9), 28), 1);
  return peakNormalize(concat(seg1, seg2));
}

function hitSound() { // 低频闷响 + 噪声头：160→85Hz 扫频，220ms
  const a = mix(
    envExp(sweep(0.22, 160, 85, 1.0), 14),
    attack(envExp(noise(0.06), 70).slice(0, Math.round(SR * 0.06)), 1),
  );
  return peakNormalize(a);
}

function bgmMenu() { // 8s 循环 pad：A 小调和弦 + 0.4Hz 颤音（首尾 150ms 淡变利于接缝）
  const dur = 8;
  const n = SR * dur;
  const out = new Float32Array(n);
  const notes = [220, 261.63, 329.63, 440];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const lfo = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.4 * t);
    let v = 0;
    for (const f of notes) v += Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * f * 2 * t);
    out[i] = v * 0.1 * lfo;
  }
  return peakNormalize(fadeInOut(out, 150));
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

// ---------- MP3 编码 ----------

async function encodeMp3(samples, kbps = 96) {
  let lamejs;
  try {
    lamejs = await import('@breezystack/lamejs');
  } catch {
    console.error('缺少编码器：先执行 npm install --no-save @breezystack/lamejs');
    process.exit(1);
  }
  const enc = new lamejs.Mp3Encoder(1, SR, kbps);
  const ints = toInt16(samples);
  const block = 1152;
  const chunks = [];
  const push = (r) => { if (r.length) chunks.push(Buffer.from(r.buffer, r.byteOffset, r.byteLength)); }; // lamejs 返回 Int8Array
  for (let i = 0; i < ints.length; i += block) push(enc.encodeBuffer(ints.subarray(i, i + block)));
  push(enc.flush());
  return Buffer.concat(chunks);
}

const targets = [
  ['sfx_coin.mp3', coinSound()],
  ['sfx_hit.mp3', hitSound()],
  ['bgm_menu.mp3', bgmMenu()],
];

for (const [name, samples] of targets) {
  const mp3 = await encodeMp3(samples);
  const path = join(outDir, name);
  writeFileSync(path, mp3);
  console.log(`✓ ${name}  ${(mp3.length / 1024).toFixed(1)} KB  ${(samples.length / SR).toFixed(2)}s`);
}
console.log('占位音频生成完成（内容侧按 README 规范替换）');
