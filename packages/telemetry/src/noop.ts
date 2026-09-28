/**
 * no-op 实现（spec §1.5/D13）：配置缺节/disabled 时的兜底，调用点零分支、零开销——
 * 全部方法空体或常量返回，不分配、不触宿主（measure 仅透传 fn）。draft §10 骨架原样落地。
 */
import type { Telemetry, TelemetryEnvelope } from './types.js';

function noopTelemetry(): Telemetry {
  const nothing = (): void => {};
  const emptyEnvelopes: readonly TelemetryEnvelope[] = [];
  return {
    log: nothing,
    metric: nothing,
    error: nothing,
    withScope: () => noopTelemetry(),
    measure: <T>(_name: string, fn: () => T | Promise<T>): Promise<T> => Promise.resolve(fn()),
    flush: () => Promise.resolve(),
    destroy: nothing,
    recent: () => emptyEnvelopes,
  };
}

export function createNoopTelemetry(): Telemetry {
  return noopTelemetry();
}
