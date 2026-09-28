#!/usr/bin/env node
/**
 * 内容发布工具（S14 原型 → 供 S8 CDN/云存储接入，schema 见 docs/manifest-schema.md）
 *
 * 用法：
 *   node tools/publish-content.mjs               生成 manifest.json + 内容寻址产物复制到 out/（本地目录模拟 CDN）
 *   node tools/publish-content.mjs --diff        对比上次 out/manifest.json，仅输出变更清单（不写任何文件）
 *   node tools/publish-content.mjs --upload      预留接口：S8 接云存储时替换 uploadFiles()（当前报未实装，退出码 3）
 * 选项：
 *   --config-dir <dir>   源配置目录，默认 <repo>/config（本工具只读，绝不改写）
 *   --out <dir>          产物目录，默认 <repo>/out
 *   --base-url <url>     manifest 内 url 前缀，默认 './'（本地模拟；S8 换成 CDN 域名）
 *   --min-client <ver>   客户端最低版本要求，默认 '0.0.0'
 *
 * 约束：只用 node 内置模块，零依赖；输出确定性（无时间戳，文件名排序，同内容两次生成字节一致）。
 * 本文件同时是「客户端降级链」的参考实现（resolveConfigFile），S8 移植进 configLoader v2 时以此语义为准。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
/** 内容寻址文件名里使用的 sha256 前缀长度 */
export const HASH_LEN = 12;

/** 缓存键规范（v1）。v0 = 现网 configLoader 的 `thunderrun:config:<name>`，作为降级链倒数第二级保留。 */
export const CACHE_KEYS = {
  manifest: 'thunderrun:config:v1:manifest',
  file: (name, sha256) => `thunderrun:config:v1:${name}:${String(sha256).slice(0, HASH_LEN)}`,
  legacy: (name) => `thunderrun:config:${name}`,
};

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 内容寻址文件名：<name>.<sha256 前 12 位>.json（不可变，可永久缓存） */
export function fileNameOf(name, sha256) {
  return `${name}.${String(sha256).slice(0, HASH_LEN)}.json`;
}

function joinUrl(baseUrl, fileName) {
  const base = String(baseUrl ?? './');
  return base.endsWith('/') ? base + fileName : `${base}/${fileName}`;
}

/** 扫描 config 目录，返回按名称排序的文件清单（确定性） */
export function scanConfig(configDir) {
  if (!existsSync(configDir)) throw new Error(`config 目录不存在: ${configDir}`);
  const names = readdirSync(configDir).filter((f) => f.endsWith('.json')).sort();
  return names.map((f) => {
    const bytes = readFileSync(join(configDir, f));
    return { name: f.replace(/\.json$/, ''), bytes, sha256: sha256Hex(bytes), size: bytes.length };
  });
}

function sameFiles(a = {}, b = {}) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k].sha256 === b[k].sha256 && a[k].size === b[k].size && a[k].url === b[k].url);
}

/**
 * 构建 manifest（纯函数，不写盘）。
 * contentVersion 规则：无 prev → 1；与 prev.files 完全一致 → 沿用 prev.contentVersion；否则 +1。
 */
export function buildManifest({ configDir, baseUrl = './', minClient = '0.0.0', prev = null }) {
  const files = {};
  for (const item of scanConfig(configDir)) {
    files[item.name] = { sha256: item.sha256, size: item.size, url: joinUrl(baseUrl, fileNameOf(item.name, item.sha256)) };
  }
  let contentVersion = 1;
  if (prev) contentVersion = sameFiles(prev.files, files) ? (prev.contentVersion ?? 1) : (prev.contentVersion ?? 0) + 1;
  return { schemaVersion: SCHEMA_VERSION, contentVersion, minClient: String(minClient), baseUrl: String(baseUrl), files };
}

/** 固定 2 空格缩进 + 末尾换行；键序由 buildManifest 的插入序保证 → 字节级确定 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** 对比两份 manifest，输出变更清单。prev 为 null 视为首次发布（全部 added）。 */
export function diffManifests(prev, next) {
  const pf = prev?.files ?? {};
  const nf = next?.files ?? {};
  const added = Object.keys(nf).filter((k) => !(k in pf)).sort();
  const removed = Object.keys(pf).filter((k) => !(k in nf)).sort();
  const changed = Object.keys(nf).filter((k) => k in pf && pf[k].sha256 !== nf[k].sha256).sort();
  const unchanged = Object.keys(nf).filter((k) => k in pf && pf[k].sha256 === nf[k].sha256).sort();
  return { added, removed, changed, unchanged, firstPublish: prev == null };
}

/** 读取上次发布的 manifest；不存在返回 null；损坏则抛错（防止 contentVersion 被静默重置） */
export function readManifest(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`上次 manifest 损坏（${path}）：${err.message}；确认后手动删除再发布`);
  }
}

/** 发布：生成 manifest + 复制内容寻址产物到 outDir。返回 { manifest, prev, diff, written } */
export function publish({ configDir, outDir, baseUrl = './', minClient = '0.0.0' }) {
  const prev = readManifest(join(outDir, 'manifest.json'));
  const manifest = buildManifest({ configDir, baseUrl, minClient, prev });
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, f] of Object.entries(manifest.files)) {
    const dst = join(outDir, fileNameOf(name, f.sha256));
    copyFileSync(join(configDir, `${name}.json`), dst);
    written.push(dst);
  }
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, serializeManifest(manifest));
  written.push(manifestPath);
  return { manifest, prev, diff: diffManifests(prev, manifest), written };
}

/**
 * 预留：上传 outDir 到云存储（S8 实装，接微信云开发存储或 wx.downloadFile 可达的 CDN）。
 * 约定入参/返回不变，S8 只替换函数体；失败必须 reject，CLI 以退出码 3 区分「未实装/上传失败」。
 */
export async function uploadFiles(/* outDir, manifest */) {
  throw new Error('--upload 未实装：S8 接云存储时替换 tools/publish-content.mjs 的 uploadFiles()');
}

/** 点分数字版本比较：clientVersion >= minClient 才可用（缺段按 0，非数字段按 0） */
export function minClientOk(minClient, clientVersion) {
  const parse = (v) => String(v ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(minClient);
  const b = parse(clientVersion);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y > x;
  }
  return true;
}

/**
 * 客户端降级链参考实现（单文件粒度；语义与 docs/manifest-schema.md §4 决策表一一对应）。
 * deps: { fetchManifest(), fetchText(url), cacheGet(k), cacheSet(k,v), bundleGet(name), validate(data), clientVersion }
 * 返回 { source: 'network'|'cache'|'bundle'|'failed', data }。任何来源的数据都必须过 deps.validate。
 */
export async function resolveConfigFile(name, deps) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const accept = (data, source) => (data != null && deps.validate(data) ? { source, data } : null);

  // 1) manifest：CDN 优先；拉不到或 minClient 不满足 → 用本地缓存的上次 manifest
  let manifest = null;
  try {
    const m = await deps.fetchManifest();
    if (m && minClientOk(m.minClient, deps.clientVersion)) manifest = m;
  } catch { /* 网络失败，走缓存 manifest */ }
  if (!manifest) {
    const m = tryParse(deps.cacheGet(CACHE_KEYS.manifest));
    if (m && minClientOk(m.minClient, deps.clientVersion)) manifest = m;
  }

  const entry = manifest?.files?.[name];
  if (entry?.sha256) {
    // 2a) 哈希缓存命中（键含 sha256 前缀，天然免校验）
    const key = CACHE_KEYS.file(name, entry.sha256);
    const hit = accept(tryParse(deps.cacheGet(key)), 'cache');
    if (hit) return hit;
    // 2b) 下载新哈希 URL → sha256 校验 → schema 校验 → 写缓存
    try {
      const text = await deps.fetchText(entry.url);
      if (sha256Hex(Buffer.from(text, 'utf8')) === entry.sha256) {
        const ok = accept(tryParse(text), 'network');
        if (ok) {
          deps.cacheSet(key, text);
          deps.cacheSet(CACHE_KEYS.manifest, JSON.stringify(manifest));
          return ok;
        }
      }
    } catch { /* 下载失败 → 继续降级 */ }
  }

  // 3) v0 旧缓存（兼容现网 configLoader 的 thunderrun:config:<name>）
  const legacy = accept(tryParse(deps.cacheGet(CACHE_KEYS.legacy(name))), 'cache');
  if (legacy) return legacy;

  // 4) 包内兜底（wx 分包 / web ./config）
  const bundled = accept(deps.bundleGet(name), 'bundle');
  if (bundled) return bundled;

  return { source: 'failed', data: null };
}

function printDiff(diff, prev, next) {
  if (diff.firstPublish) {
    console.log(`首次发布（无上次 manifest）：contentVersion=${next.contentVersion}，共 ${Object.keys(next.files).length} 个文件`);
    return;
  }
  console.log(`contentVersion ${prev.contentVersion} → ${next.contentVersion}`);
  for (const n of diff.added) console.log(`  + 新增   ${n}  ${next.files[n].sha256.slice(0, HASH_LEN)}`);
  for (const n of diff.removed) console.log(`  - 移除   ${n}  ${prev.files[n].sha256.slice(0, HASH_LEN)}`);
  for (const n of diff.changed) console.log(`  ~ 变更   ${n}  ${prev.files[n].sha256.slice(0, HASH_LEN)} → ${next.files[n].sha256.slice(0, HASH_LEN)}  (${prev.files[n].size} → ${next.files[n].size} B)`);
  console.log(`  = 未变   ${diff.unchanged.length ? diff.unchanged.join(', ') : '(无)'}`);
}

function parseArgs(args) {
  const opts = { configDir: null, out: null, baseUrl: './', minClient: '0.0.0', diff: false, upload: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff') opts.diff = true;
    else if (a === '--upload') opts.upload = true;
    else if (a === '--config-dir') opts.configDir = args[++i];
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--base-url') opts.baseUrl = args[++i];
    else if (a === '--min-client') opts.minClient = args[++i];
    else throw new Error(`未知参数: ${a}`);
  }
  return opts;
}

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const configDir = resolve(opts.configDir ?? join(REPO_ROOT, 'config'));
  const outDir = resolve(opts.out ?? join(REPO_ROOT, 'out'));
  if (opts.diff) {
    const prev = readManifest(join(outDir, 'manifest.json'));
    const next = buildManifest({ configDir, baseUrl: opts.baseUrl, minClient: opts.minClient, prev });
    printDiff(diffManifests(prev, next), prev, next);
    return;
  }
  const { manifest, prev, diff, written } = publish({ configDir, outDir, baseUrl: opts.baseUrl, minClient: opts.minClient });
  console.log(`已发布 contentVersion=${manifest.contentVersion}，${written.length} 个产物 → ${outDir}`);
  printDiff(diff, prev, manifest);
  if (opts.upload) {
    uploadFiles(outDir, manifest).catch((err) => {
      console.error(`[预留] ${err.message}`);
      process.exit(3);
    });
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    main();
  } catch (err) {
    console.error(`发布失败: ${err.message}`);
    process.exit(1);
  }
}
