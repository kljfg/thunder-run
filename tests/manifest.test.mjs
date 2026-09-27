/**
 * S14 manifest 原型单测（node:test）。
 * 只依赖 tools/publish-content.mjs（源码直读，不 import dist，避免与 S2 搬迁会话耦合）。
 * 覆盖：生成确定性、diff 正确性、sha256 校验、contentVersion 规则、降级链决策（mock FileSource）。
 * 本测试不触碰仓库 config/（全部用临时目录 fixture），满足「config 只读」约束。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_KEYS, HASH_LEN, SCHEMA_VERSION, buildManifest, diffManifests, fileNameOf,
  minClientOk, publish, readManifest, resolveConfigFile, scanConfig, serializeManifest, sha256Hex,
} from '../tools/publish-content.mjs';

const tmpRoot = mkdtempSync(join(tmpdir(), 'tr-manifest-'));

/** 建一个 fixture config 目录，files = { name: object } */
function makeConfigDir(id, files) {
  const dir = join(tmpRoot, id);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data));
  }
  return dir;
}

const FIXTURE_A = { game: { speed: 10 }, items: { coin: { value: 1 } } };
const FIXTURE_B = { game: { speed: 12 }, items: { coin: { value: 1 } }, events: { daily: true } };

// ---------- 哈希 ----------

test('sha256Hex 与标准向量一致', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('manifest 内每文件 sha256/size/url 与独立计算一致', () => {
  const dir = makeConfigDir('hash', FIXTURE_A);
  const m = buildManifest({ configDir: dir, baseUrl: 'https://cdn.test/' });
  for (const [name, f] of Object.entries(m.files)) {
    const bytes = readFileSync(join(dir, `${name}.json`));
    assert.equal(f.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(f.size, bytes.length);
    assert.equal(f.url, `https://cdn.test/${name}.${f.sha256.slice(0, HASH_LEN)}.json`);
  }
});

// ---------- 生成确定性 ----------

test('同一份 config 两次生成 manifest 字节一致（无时间戳/键序稳定）', () => {
  const dir = makeConfigDir('det', FIXTURE_A);
  const s1 = serializeManifest(buildManifest({ configDir: dir, baseUrl: './' }));
  const s2 = serializeManifest(buildManifest({ configDir: dir, baseUrl: './' }));
  assert.equal(s1, s2);
  assert.ok(!/generatedAt|timestamp/i.test(s1), 'manifest 不得含时间字段');
  const m = JSON.parse(s1);
  assert.equal(m.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(m.files), ['game', 'items'], 'files 按名称字典序');
  assert.equal(s1.endsWith('\n'), true);
});

test('scanConfig 结果按名称排序且只收 .json', () => {
  const dir = makeConfigDir('scan', { b: {}, a: {} });
  writeFileSync(join(dir, 'note.txt'), 'x');
  assert.deepEqual(scanConfig(dir).map((i) => i.name), ['a', 'b']);
});

test('config 目录不存在时报错', () => {
  assert.throws(() => scanConfig(join(tmpRoot, 'no-such-dir')), /不存在/);
});

// ---------- contentVersion 规则 ----------

test('contentVersion：首次=1，内容不变沿用，内容变化+1', () => {
  const dir = makeConfigDir('ver', FIXTURE_A);
  const v1 = buildManifest({ configDir: dir });
  assert.equal(v1.contentVersion, 1);
  const again = buildManifest({ configDir: dir, prev: v1 });
  assert.equal(again.contentVersion, 1);
  writeFileSync(join(dir, 'game.json'), JSON.stringify({ speed: 11 }));
  const v2 = buildManifest({ configDir: dir, prev: v1 });
  assert.equal(v2.contentVersion, 2);
  const meta = buildManifest({ configDir: dir, baseUrl: 'https://x/', prev: v2 });
  assert.equal(meta.contentVersion, 3, 'baseUrl 变化不改内容也应升版（url 属于 files）');
});

// ---------- diff ----------

test('diffManifests：新增/移除/变更/未变 分类正确', () => {
  const prev = buildManifest({ configDir: makeConfigDir('diff-a', FIXTURE_A) });
  const next = buildManifest({ configDir: makeConfigDir('diff-b', FIXTURE_B), prev });
  const d = diffManifests(prev, next);
  assert.deepEqual(d.added, ['events']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, ['game']);
  assert.deepEqual(d.unchanged, ['items']);
  assert.equal(d.firstPublish, false);
});

test('diffManifests：prev=null 视为首次发布全部 added', () => {
  const next = buildManifest({ configDir: makeConfigDir('diff-first', FIXTURE_A) });
  const d = diffManifests(null, next);
  assert.equal(d.firstPublish, true);
  assert.deepEqual(d.added, ['game', 'items']);
  assert.deepEqual(d.changed, []);
});

// ---------- publish 端到端 ----------

test('publish：产物内容寻址复制 + manifest 落盘；重复发布幂等', () => {
  const dir = makeConfigDir('pub', FIXTURE_A);
  const out = join(tmpRoot, 'pub-out');
  const r1 = publish({ configDir: dir, outDir: out, baseUrl: './' });
  assert.equal(r1.manifest.contentVersion, 1);
  for (const [name, f] of Object.entries(r1.manifest.files)) {
    const p = join(out, fileNameOf(name, f.sha256));
    assert.ok(existsSync(p), `缺少产物 ${p}`);
    assert.equal(readFileSync(p, 'utf8'), readFileSync(join(dir, `${name}.json`), 'utf8'));
  }
  const manifestBytes = readFileSync(join(out, 'manifest.json'), 'utf8');
  assert.equal(manifestBytes, serializeManifest(r1.manifest));

  const r2 = publish({ configDir: dir, outDir: out });
  assert.equal(r2.manifest.contentVersion, 1, '内容未变不应升版');
  assert.equal(readFileSync(join(out, 'manifest.json'), 'utf8'), manifestBytes, '重复发布字节一致');

  writeFileSync(join(dir, 'game.json'), JSON.stringify({ speed: 99 }));
  const r3 = publish({ configDir: dir, outDir: out });
  assert.equal(r3.manifest.contentVersion, 2);
  assert.deepEqual(r3.diff.changed, ['game']);
  assert.equal(readManifest(join(out, 'manifest.json')).contentVersion, 2);
});

test('readManifest：损坏的上次 manifest 抛错而非静默重置版本', () => {
  const out = join(tmpRoot, 'bad-out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), '{broken');
  assert.throws(() => readManifest(join(out, 'manifest.json')), /损坏/);
  assert.equal(readManifest(join(out, 'nope.json')), null);
});

// ---------- minClient ----------

test('minClientOk：点分数字比较，缺段按 0', () => {
  assert.equal(minClientOk('1.4.0', '1.4.0'), true);
  assert.equal(minClientOk('1.4.0', '1.4.1'), true);
  assert.equal(minClientOk('1.4.0', '1.3.9'), false);
  assert.equal(minClientOk('1.4', '1.4.0'), true);
  assert.equal(minClientOk(undefined, '0.0.1'), true);
});

// ---------- 降级链决策（mock FileSource） ----------

/** 组一份可用于降级链测试的 manifest + CDN 内容映射 */
function makeCdn(id, files, baseUrl = 'https://cdn.test/') {
  const dir = makeConfigDir(id, files);
  const manifest = buildManifest({ configDir: dir, baseUrl });
  const cdn = new Map();
  for (const [name, f] of Object.entries(manifest.files)) {
    cdn.set(f.url, readFileSync(join(dir, `${name}.json`), 'utf8'));
  }
  return { manifest, cdn };
}

function makeDeps(overrides = {}) {
  const store = new Map(overrides.store ?? []);
  const calls = [];
  const deps = {
    clientVersion: '9.9.9',
    validate: (d) => d != null && typeof d === 'object',
    cacheGet: (k) => { calls.push(`get:${k}`); return store.has(k) ? store.get(k) : null; },
    cacheSet: (k, v) => { calls.push(`set:${k}`); store.set(k, v); },
    bundleGet: () => null,
    fetchManifest: async () => { calls.push('fetchManifest'); throw new Error('offline'); },
    fetchText: async () => { calls.push('fetchText'); throw new Error('offline'); },
    ...overrides,
  };
  delete deps.store;
  return { deps, store, calls };
}

const GAME = { speed: 10 };
const gameText = JSON.stringify(GAME);

test('降级链 L2b：CDN manifest + 下载新哈希 + sha256 通过 → network，写 v1 缓存', async () => {
  const { manifest, cdn } = makeCdn('chain-net', { game: GAME });
  const { deps, store, calls } = makeDeps({
    fetchManifest: async () => manifest,
    fetchText: async (url) => { calls.push(`fetchText:${url}`); return cdn.get(url); },
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'network');
  assert.deepEqual(r.data, GAME);
  assert.equal(store.get(CACHE_KEYS.file('game', manifest.files.game.sha256)), gameText);
  assert.equal(store.get(CACHE_KEYS.manifest), JSON.stringify(manifest));
});

test('降级链 L2a：哈希缓存命中 → cache，且不发下载请求', async () => {
  const { manifest } = makeCdn('chain-hit', { game: GAME });
  const key = CACHE_KEYS.file('game', manifest.files.game.sha256);
  const { deps, calls } = makeDeps({
    store: [[key, gameText]],
    fetchManifest: async () => manifest,
    fetchText: async () => { throw new Error('不应被调用'); },
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'cache');
  assert.deepEqual(r.data, GAME);
  assert.ok(!calls.some((c) => c.startsWith('fetchText')));
});

test('降级链 F5：哈希缓存损坏（非 JSON）→ 视为未命中，重新下载 → network', async () => {
  const { manifest, cdn } = makeCdn('chain-corrupt', { game: GAME });
  const key = CACHE_KEYS.file('game', manifest.files.game.sha256);
  const { deps } = makeDeps({
    store: [[key, '{corrupted']],
    fetchManifest: async () => manifest,
    fetchText: async (url) => cdn.get(url),
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'network');
});

test('降级链 F6：下载内容 sha256 不匹配 → 丢弃不写缓存，退到 v0 旧缓存 → cache', async () => {
  const { manifest } = makeCdn('chain-sha', { game: GAME });
  const { deps, store } = makeDeps({
    store: [[CACHE_KEYS.legacy('game'), JSON.stringify({ speed: 8 })]],
    fetchManifest: async () => manifest,
    fetchText: async () => JSON.stringify({ speed: 666, hacked: true }),
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'cache');
  assert.deepEqual(r.data, { speed: 8 });
  assert.equal(store.has(CACHE_KEYS.file('game', manifest.files.game.sha256)), false, '脏数据不得写缓存');
});

test('降级链 F7：sha256 匹配但 schema 校验失败 → 丢弃，退到包内兜底 → bundle', async () => {
  const bad = 'not-json-but-hash-matches';
  const sha = createHash('sha256').update(Buffer.from(bad, 'utf8')).digest('hex');
  const manifest = { schemaVersion: 1, contentVersion: 1, minClient: '0.0.0', baseUrl: './', files: { game: { sha256: sha, size: bad.length, url: './game.x.json' } } };
  const { deps } = makeDeps({
    fetchManifest: async () => manifest,
    fetchText: async () => bad,
    bundleGet: (name) => (name === 'game' ? { speed: 5 } : null),
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'bundle');
  assert.deepEqual(r.data, { speed: 5 });
});

test('降级链 F1：manifest 网络失败 → 用 v1:manifest 缓存副本命中哈希缓存 → cache', async () => {
  const { manifest } = makeCdn('chain-offline', { game: GAME });
  const key = CACHE_KEYS.file('game', manifest.files.game.sha256);
  const { deps } = makeDeps({
    store: [[CACHE_KEYS.manifest, JSON.stringify(manifest)], [key, gameText]],
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'cache');
  assert.deepEqual(r.data, GAME);
});

test('降级链 F2：minClient 不满足 → 新 manifest 整份不可用，退包内兜底 → bundle', async () => {
  const { manifest, cdn } = makeCdn('chain-minc', { game: GAME });
  manifest.minClient = '99.0.0';
  const { deps } = makeDeps({
    fetchManifest: async () => manifest,
    fetchText: async (url) => cdn.get(url),
    bundleGet: () => ({ speed: 1 }),
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'bundle');
});

test('降级链 F3/F9：manifest 全无 + 无缓存 + 包内缺失 → failed', async () => {
  const { deps } = makeDeps({});
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'failed');
  assert.equal(r.data, null);
});

test('降级链 F8：v0 旧缓存校验失败 → 继续包内兜底', async () => {
  const { deps } = makeDeps({
    store: [[CACHE_KEYS.legacy('game'), 'null']],
    bundleGet: () => ({ speed: 2 }),
  });
  const r = await resolveConfigFile('game', deps);
  assert.equal(r.source, 'bundle');
});

test('降级链：manifest 有但缺该文件条目 → 直接走 v0/包内', async () => {
  const { manifest } = makeCdn('chain-missing-entry', { game: GAME });
  const { deps } = makeDeps({
    fetchManifest: async () => manifest,
    bundleGet: () => ({ speed: 3 }),
  });
  const r = await resolveConfigFile('obstacles', deps);
  assert.equal(r.source, 'bundle');
});

test('缓存键规范：v1 键是 v0 前缀超集，file 键含 sha256 前 12 位', () => {
  const k = CACHE_KEYS.file('game', 'a'.repeat(64));
  assert.equal(k, 'thunderrun:config:v1:game:aaaaaaaaaaaa');
  assert.ok(k.startsWith(CACHE_KEYS.legacy('game').replace('game', '')));
  assert.equal(CACHE_KEYS.manifest, 'thunderrun:config:v1:manifest');
});

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
