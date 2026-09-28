/**
 * 错误序列化与指纹（spec §3.3/§4.5）：message ≤512B、stack ≤maxStackBytes 且保留栈顶
 * （栈字符串头部 = 离抛出点最近），rejection 附 reasonType（typeof + 构造器名）。
 * sourcemap 还原归服务端，客户端不做。
 */
import type { CrashPayload } from './types.js';
import { sha256Hex, truncateUtf8 } from './canonical.js';

/** message 截断上限（spec §4.5 固定 512B）。 */
export const MAX_MESSAGE_BYTES = 512;

interface ErrorLike {
  message?: unknown;
  stack?: unknown;
  name?: unknown;
}

function asErrorLike(err: unknown): ErrorLike | null {
  return err !== null && typeof err === 'object' ? (err as ErrorLike) : null;
}

/** reasonType：typeof + 构造器名（spec §4.5，rejection 排查「抛了个啥」）。 */
export function reasonTypeOf(value: unknown): string {
  const t = typeof value;
  if (value === null) return 'null';
  if (t !== 'object' && t !== 'function') return t;
  const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
  return ctor ? `${t}:${ctor}` : t;
}

/** 栈顶 2 帧（离抛出点最近的两个 "at …" 行；无 at 行则取头部 2 行）。 */
function topFrames(stack: string | undefined): string {
  if (!stack) return '';
  const lines = stack.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const atLines = lines.filter(l => l.startsWith('at '));
  return (atLines.length > 0 ? atLines : lines).slice(0, 2).join('|');
}

/**
 * err（Error | string | 未知值）→ CrashPayload（不含 dupCount，去重在管线）。
 * duck-typing：{message,stack} 形状的对象（wx.onError 的 res）按 Error 同路处理。
 */
export function serializeError(err: unknown, maxStackBytes: number): Omit<CrashPayload, 'dupCount'> {
  const like = asErrorLike(err);
  const out: Omit<CrashPayload, 'dupCount'> & { file?: string; line?: number; col?: number } = {
    message: '',
    fingerprint: '',
  };
  if (like !== null && (typeof like.message === 'string' || typeof like.stack === 'string')) {
    out.message = truncateUtf8(String(like.message ?? like.name ?? 'Error'), MAX_MESSAGE_BYTES);
    if (typeof like.stack === 'string' && like.stack.length > 0) {
      out.stack = truncateUtf8(like.stack, maxStackBytes); // truncateUtf8 保头部 = 保留栈顶
      const frame = out.stack.split('\n').map(l => l.trim()).find(l => l.startsWith('at '));
      const m = frame?.match(/(?:@|\bat\s+.*?\()?(https?:\/\/[^\s):]+|[\w$.\\/-]+\.[\w]+):(\d+):(\d+)/);
      if (m) {
        out.file = m[1];
        out.line = Number(m[2]);
        out.col = Number(m[3]);
      }
    }
    // Error 实例与 duck-typed 错误对象不带 reasonType（栈与 message 已自证）；见下方未知值分支
  } else if (typeof err === 'string') {
    out.message = truncateUtf8(err, MAX_MESSAGE_BYTES);
    out.reasonType = 'string';
  } else {
    // 未知值：安全 stringify（防循环引用抛穿——遥测永不向业务抛异常，spec §1.3）
    let text: string;
    try { text = JSON.stringify(err) ?? String(err); } catch { text = String(err); }
    out.message = truncateUtf8(text, MAX_MESSAGE_BYTES);
    out.reasonType = reasonTypeOf(err);
  }
  out.fingerprint = fingerprintOf(out.message, out.stack);
  return out;
}

/** 指纹 = sha256(ch + name + message + 栈顶2帧) 前 16 hex（spec §3.3；ch 由调用方并入 name 前缀）。 */
export function fingerprintOf(message: string, stack: string | undefined, ch = 'error', name = ''): string {
  return sha256Hex(`${ch}\u0000${name}\u0000${message}\u0000${topFrames(stack)}`).slice(0, 16);
}
