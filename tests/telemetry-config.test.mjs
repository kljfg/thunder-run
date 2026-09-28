/**
 * 配置解析/校验与规范序列化测试（spec §5/§8）：
 * - readTelemetryConfig：缺节 → undefined（noop 兜底）、缺省镜像、钳制与 warn、类型错回落；
 * - configValidator.validateTelemetryParams（core 技术段校验，与钳制区间一致）；
 * - canonicalJson/sha256Hex 与 tools/replay/runner.mjs 逐字节对拍（三线一致前提，spec §8）；
 * - S18 对齐导出：digestEventLog / digestInputs / configHash 构造 / runEndFields / configLoadSummaryFields。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TELEMETRY_CONFIG_DEFAULTS, readTelemetryConfig,
  canonicalJson, sha256Hex, utf8Length, truncateUtf8,
  digestEventLog, digestInputs, configHashFromShaList, configHashBundle,
  runEndFields, anticheatRejectFields, configLoadSummaryFields,
} from '../packages/telemetry/dist/index.js';
import { validateFile, validateTelemetryParams } from '../packages/core/dist/config/configValidator.js';
// 对拍基准（内部 import core dist——本套件与其他测试同约定：先 npm run build）
import { canonicalJson as refCanonicalJson, sha256Hex as refSha256Hex } from '../tools/replay/runner.mjs';

// ---------- canonicalJson / sha256：与 runner.mjs 逐字节一致 ----------

test('canonicalJson 与 tools/replay/runner.mjs 对拍（键序/嵌套/unicode/转义）', () => {
  const samples = [
    { b: 1, a: [2, { d: '中文', e: null }], s: 'x"y\\z', n: -0.5, t: true },
    [[0, { type: 'coin', lane: 1 }], [3, { type: 'hit' }]],
    {}, [], '', 'abc', 0, null,
    { z: { y: { x: 1 } }, a: { b: [1, 2, { c: 3, a: 1 }] } },
  ];
  for (const s of samples) assert.equal(canonicalJson(s), refCanonicalJson(s));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}'); // 键字典序、无空白
});

test('sha256Hex 与 node:crypto（runner.mjs 同源）一致：标准向量 + 对拍', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  for (const s of ['', 'abc', '中文🚀 mixed 123', 'x'.repeat(1000), '{"a":[1,2,3]}']) {
    assert.equal(sha256Hex(s), refSha256Hex(s));
  }
});

test('utf8Length / truncateUtf8：多字节不截半', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('中文'), 6);
  assert.equal(utf8Length('🚀'), 4);
  assert.equal(truncateUtf8('中文🚀abc', 6), '中文');   // 6 字节恰好两个汉字
  assert.equal(truncateUtf8('中文🚀abc', 7), '中文');   // 7 字节放不下 🚀（4 字节）
  assert.equal(truncateUtf8('abc', 10), 'abc');
});

// ---------- readTelemetryConfig（spec §5.3） ----------

test('缺节/节非对象 → undefined（noop 兜底）', () => {
  const warns = [];
  assert.equal(readTelemetryConfig(undefined, m => warns.push(m)), undefined);
  assert.equal(readTelemetryConfig({}, m => warns.push(m)), undefined);
  assert.equal(readTelemetryConfig({ telemetry: 'x' }, m => warns.push(m)), undefined);
  assert.equal(warns.length, 1); // 节存在但类型错 → warn 一条
});

test('空节 = 缺省值镜像（与 spec §5 JSON 逐项一致）', () => {
  const c = readTelemetryConfig({ telemetry: {} });
  assert.deepEqual(c, TELEMETRY_CONFIG_DEFAULTS);
  assert.equal(c.enabled, true);
  assert.equal(c.minLevel, 'info');
  assert.deepEqual(c.sampleRates, { default: 100, 'perf.frameDist': 100, 'debug.probe': 0 });
  assert.deepEqual(c.rateLimit, { perNamePerMin: 30, maxBytesPerMin: 65536 });
  assert.deepEqual(c.batch, { maxEvents: 30, maxBytesPerFlush: 16384, maxDelayMs: 5000, flushOnHide: true, retry: 1 });
  assert.deepEqual(c.error, { sample: 100, maxStackBytes: 4096, dedupWindowMs: 60000 });
  assert.deepEqual(c.memory, { sampleEveryS: 10 });
  assert.deepEqual(c.transport, { webEndpoint: '', wxRealtimeLog: true, wxCloudCollection: 'telemetry', mirrorOfficial: false });
});

test('越界钳制且每次钳制 warn 一条：sample 0..100 / maxEvents 1..200 / maxBytesPerFlush ≤64KiB', () => {
  const warns = [];
  const c = readTelemetryConfig({
    telemetry: {
      sampleRates: { default: 150, 'x.y': -3 },
      batch: { maxEvents: 0, maxBytesPerFlush: 999999 },
    },
  }, m => warns.push(m));
  assert.equal(c.sampleRates.default, 100);
  assert.equal(c.sampleRates['x.y'], 0);
  assert.equal(c.batch.maxEvents, 1);
  assert.equal(c.batch.maxBytesPerFlush, 65536);
  assert.equal(warns.length, 4);
  assert.ok(warns.every(w => w.startsWith('game.params.telemetry')));
});

test('error.sample 仅 0|100：非法值归 100 并 warn；0 保留', () => {
  const warns = [];
  assert.equal(readTelemetryConfig({ telemetry: { error: { sample: 50 } } }, m => warns.push(m)).error.sample, 100);
  assert.equal(warns.length, 1);
  assert.equal(readTelemetryConfig({ telemetry: { error: { sample: 0 } } }).error.sample, 0);
});

test('字段类型错回落缺省并 warn（不整节报废）', () => {
  const warns = [];
  const c = readTelemetryConfig({
    telemetry: { enabled: 'yes', minLevel: 'nope', rateLimit: 5, transport: { webEndpoint: 42 } },
  }, m => warns.push(m));
  assert.equal(c.enabled, true);
  assert.equal(c.minLevel, 'info');
  assert.deepEqual(c.rateLimit, TELEMETRY_CONFIG_DEFAULTS.rateLimit);
  assert.equal(c.transport.webEndpoint, '');
  assert.ok(warns.length >= 4);
});

test('config/game.json 的 params.telemetry 节与 spec §5 缺省逐项一致', () => {
  const game = JSON.parse(readFileSync(fileURLToPath(new URL('../config/game.json', import.meta.url)), 'utf8'));
  assert.deepEqual(game.params.telemetry, JSON.parse(JSON.stringify(TELEMETRY_CONFIG_DEFAULTS)));
  const c = readTelemetryConfig(game.params);
  assert.deepEqual(c, TELEMETRY_CONFIG_DEFAULTS);
});

// ---------- configValidator 技术段校验（任务 3） ----------

test('validateTelemetryParams：缺省不报错；合法节通过；非法值逐项报错', () => {
  assert.deepEqual(validateTelemetryParams(undefined), []);
  assert.deepEqual(validateTelemetryParams({}), []);
  assert.deepEqual(validateTelemetryParams(TELEMETRY_CONFIG_DEFAULTS), []);
  assert.deepEqual(validateTelemetryParams('x'), ['game.params.telemetry: 应为对象（技术段，S16）']);
  const errs = validateTelemetryParams({
    minLevel: 'loud',
    sampleRates: { default: 150 },
    batch: { maxEvents: 'many', maxBytesPerFlush: 999999 },
    error: { sample: 50 },
    transport: { webEndpoint: 42, wxRealtimeLog: 'yes' },
  });
  assert.equal(errs.length, 7);
  assert.ok(errs.some(e => e.includes('minLevel')));
  assert.ok(errs.some(e => e.includes('sampleRates.default')));
  assert.ok(errs.some(e => e.includes('batch.maxEvents')));
  assert.ok(errs.some(e => e.includes('batch.maxBytesPerFlush')));
  assert.ok(errs.some(e => e.includes('error.sample') && e.includes('0|100')));
  assert.ok(errs.some(e => e.includes('transport.webEndpoint')));
  assert.ok(errs.some(e => e.includes('transport.wxRealtimeLog')));
});

test('validateFile(game)：telemetry 节走技术段校验，仓库 config 全绿', () => {
  assert.deepEqual(validateFile('game', { configVersion: '1', params: { telemetry: { enabled: true } } }), []);
  const errs = validateFile('game', { configVersion: '1', params: { telemetry: { minLevel: 42 } } });
  assert.equal(errs.length, 1);
  const game = JSON.parse(readFileSync(fileURLToPath(new URL('../config/game.json', import.meta.url)), 'utf8'));
  assert.deepEqual(validateFile('game', game), []);
});

// ---------- S18 对齐导出（spec §8，任务 5） ----------

test('digestEventLog/digestInputs = runner.mjs 的 sha256Hex(canonicalJson(…)) 语义', () => {
  const eventLog = [[0, { type: 'coin', lane: 1 }], [3, { type: 'hit', obstacle: 'obs_low' }]];
  const inputs = [{ frame: 1, type: 'swipe', payload: { dir: 'up' } }];
  assert.equal(digestEventLog(eventLog), refSha256Hex(refCanonicalJson(eventLog)));
  assert.equal(digestInputs(inputs), refSha256Hex(refCanonicalJson(inputs)));
  assert.match(digestEventLog(eventLog), /^[0-9a-f]{64}$/);
});

test('configHash：contentVersion:sha12 与 bundle: 两形态（spec §4.4）', () => {
  const h = configHashFromShaList(3, ['a'.repeat(64), 'b'.repeat(64)]);
  assert.match(h, /^3:[0-9a-f]{12}$/);
  assert.equal(h.slice(0, 2), '3:');
  // 顺序敏感（files 按 CONTENT_NAMES 序）
  assert.notEqual(h, configHashFromShaList(3, ['b'.repeat(64), 'a'.repeat(64)]));
  assert.equal(configHashBundle('1.0.0'), 'bundle:1.0.0');
});

test('runEndFields：嵌套结构 canonicalJson 成串、标量平铺、可选键缺省不出现', () => {
  const payload = {
    runId: 'r1', seed: 777, charId: 'char_volt', frames: 1234,
    summary: { t: 20.5, distance: 300, coins: 12, nearMiss: 2, hits: 1, score: 4200, alive: false, casts: 1, charId: 'char_volt' },
    eventCounts: { coin: 12, hit: 1 },
    eventsSha256: 'e'.repeat(64), inputsSha256: 'i'.repeat(64),
    engineVersion: '0.1.0', configHash: 'bundle:1.0.0',
    frameDist: { frames: 1234, buckets: new Array(12).fill(0), p50Ms: 16.7, p95Ms: 22, longCount: 3, worstMs: 80 },
    revives: 0,
  };
  const f = runEndFields(payload);
  assert.equal(f.runId, 'r1');
  assert.equal(f.seed, 777);
  assert.equal(f.eventsSha256, 'e'.repeat(64));
  assert.equal(f.inputsSha256, 'i'.repeat(64));
  assert.equal(f.revives, 0);
  assert.equal(f.maxUsedMB, undefined); // 可选键缺省不出现
  assert.deepEqual(JSON.parse(f.summary), payload.summary);
  assert.deepEqual(JSON.parse(f.eventCounts), { coin: 12, hit: 1 });
  assert.deepEqual(JSON.parse(f.frameDist), payload.frameDist);
  assert.equal(f.summary, canonicalJson(payload.summary)); // 字节稳定（canonical）
  const withMem = runEndFields({ ...payload, maxUsedMB: 123.4 });
  assert.equal(withMem.maxUsedMB, 123.4);
});

test('anticheatRejectFields / configLoadSummaryFields（命中率 = source 占比）', () => {
  const r = anticheatRejectFields({ reason: 'replay-mismatch', score: 999, eventsSha256: 'e', inputsSha256: 'i' });
  assert.deepEqual(r, { reason: 'replay-mismatch', score: 999, eventsSha256: 'e', inputsSha256: 'i' });
  const s = configLoadSummaryFields({
    countsBySource: { network: 2, cache: 6 },
    manifestSource: 'none',
    contentVersion: 3,
  });
  assert.equal(s.failedCount, 0);
  assert.equal(s.hitRateCache, 75);   // 6/8
  assert.equal(s.hitRateBundle, 0);
  assert.equal(s.manifestSource, 'none');
  assert.equal(s.contentVersion, 3);
  assert.deepEqual(JSON.parse(s.countsBySource), { network: 2, cache: 6, bundle: 0, failed: 0 });
  assert.equal(s.countsBySource, '{"bundle":0,"cache":6,"failed":0,"network":2}'); // 键字典序
  const empty = configLoadSummaryFields({ countsBySource: {}, manifestSource: 'none' });
  assert.equal(empty.hitRateCache, 0); // total=0 不除零
  assert.equal(empty.contentVersion, undefined);
});
