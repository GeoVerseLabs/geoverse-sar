/**
 * guardrails 中间件工厂（阶段二 T11，RFC-0009 F3——借 OpenAI Agents SDK guardrails）：
 * 在权限之上再加一层**输入级防线**，read 不拦、write/action 过闸：
 * - maxWritesPerRun：写预算（reset() 开新窗口，agent 每次 run 前调）；
 * - bboxFence：入参里发现的坐标（[x,y] 数组或 {x,y} 对象）越界即拒；
 * - propertyPolicy.protectedFields：入参深层出现受保护字段名即拒。
 * 均为启发式预检（挡住绝大多数越界/越权尝试），不替代权限与领域校验；
 * 拒绝走 permission_denied，同栈可审计。
 */
import type { Middleware } from './dispatcher';

export interface GuardrailsOptions {
  /** 一个运行窗口内允许的写/action 次数上限（含 dryRun 之外的真实执行）。 */
  maxWritesPerRun?: number;
  /** 坐标围栏 [minX,minY,maxX,maxY]（CRS 单位）：入参坐标越界即拒。 */
  bboxFence?: [number, number, number, number];
  /** 受保护属性字段：写类入参深层出现这些键名即拒（如 ['locked','owner']）。 */
  propertyPolicy?: { protectedFields: string[] };
}

export interface Guardrails {
  middleware: Middleware;
  /** 重置写预算窗口（agent 每次 run 前调用）。 */
  reset(): void;
  readonly writesUsed: number;
}

/** 深层遍历入参：收集坐标点（[x,y] 数组 / {x,y} 对象）与出现过的对象键名。 */
function scan(
  value: unknown,
  onPoint: (x: number, y: number) => void,
  onKey: (key: string) => void,
  depth = 0,
): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      (value.length === 2 || typeof value[2] === 'number')
    ) {
      onPoint(value[0], value[1]);
      return;
    }
    for (const item of value) scan(item, onPoint, onKey, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.x === 'number' && typeof obj.y === 'number') {
    onPoint(obj.x, obj.y);
  }
  for (const [key, v] of Object.entries(obj)) {
    onKey(key);
    scan(v, onPoint, onKey, depth + 1);
  }
}

export function createGuardrails(options: GuardrailsOptions = {}): Guardrails {
  let writes = 0;

  const middleware: Middleware = async (mctx, next) => {
    if (mctx.kind === 'read') return next();
    const deny = (message: string) => ({
      ok: false,
      capabilityId: mctx.capabilityId,
      error: { code: 'permission_denied' as const, message },
      durationMs: 0,
    });

    if (options.maxWritesPerRun !== undefined && !mctx.dryRun) {
      if (writes >= options.maxWritesPerRun) {
        return deny(
          `guardrails：本轮写预算已用尽（maxWritesPerRun=${options.maxWritesPerRun}），需人工确认后 reset() 继续`,
        );
      }
    }

    let violation: string | undefined;
    if (options.bboxFence || options.propertyPolicy) {
      const fence = options.bboxFence;
      const protectedSet = new Set(options.propertyPolicy?.protectedFields ?? []);
      scan(
        mctx.input,
        (x, y) => {
          if (fence && (x < fence[0] || y < fence[1] || x > fence[2] || y > fence[3])) {
            violation ??= `guardrails：坐标 (${x}, ${y}) 越出围栏 [${fence.join(', ')}]`;
          }
        },
        (key) => {
          if (protectedSet.has(key)) {
            violation ??= `guardrails：字段 "${key}" 受保护，禁止经此入口修改`;
          }
        },
      );
    }
    if (violation) return deny(violation);

    const outcome = await next();
    if (outcome.ok && !mctx.dryRun && options.maxWritesPerRun !== undefined) {
      writes += 1;
    }
    return outcome;
  };

  return {
    middleware,
    reset() {
      writes = 0;
    },
    get writesUsed() {
      return writes;
    },
  };
}
