/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * runtime 自检（doctor）：对 kernel 装配做启动期体检——
 * 能力目录 / 工具名双射 / schema 可派生 / 服务依赖 / 工作流引用 / 端口冒烟。
 * 定位：doctor 查"装配对不对"（配置期可发现的问题），ErrorMonitor 查"运行中错在哪"。
 * doctor 自身永不抛异常：每项检查独立 try/catch，坏检查记为 error。
 */
import type { SarKernel } from './kernel';
import type { CallerInfo } from './permissions';

export type DoctorLevel = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  /** 检查项 id，如 capability.schema / workflow.step-ref / engine.snapshot。 */
  id: string;
  level: DoctorLevel;
  /** 关联对象（能力 id / 工作流 id / 服务键）。 */
  target?: string;
  message: string;
  /** 修复建议。 */
  hint?: string;
}

export interface DoctorReport {
  /** 无 error 级问题即 true（warn 不拦）。 */
  ok: boolean;
  errors: number;
  warnings: number;
  checks: DoctorCheck[];
  summary: { capabilities: number; workflows: number };
}

export interface DoctorOptions {
  /** 提供时额外报告该调用方经权限裁剪后看不见的能力（info 级 warn）。 */
  caller?: CallerInfo;
}

const TOOL_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function runDoctor(
  kernel: SarKernel<any, any>,
  opts: DoctorOptions = {},
): DoctorReport {
  const checks: DoctorCheck[] = [];
  const push = (c: DoctorCheck) => checks.push(c);
  const guard = (id: string, target: string | undefined, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      push({
        id,
        level: 'error',
        target,
        message: `检查执行本身抛出异常: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const caps = kernel.registry.list();
  const workflows = kernel.workflows.list();

  // ---- 能力目录 ----
  if (caps.length === 0) {
    push({
      id: 'catalog.empty',
      level: 'warn',
      message: '未注册任何能力——runtime 空转',
      hint: 'createKernel({ packs: [...] }) 注入能力包',
    });
  }

  const toolNames = new Map<string, string>();
  for (const cap of caps) {
    guard('capability.id', cap.id, () => {
      if (!TOOL_NAME_RE.test(cap.id)) {
        push({
          id: 'capability.id',
          level: 'error',
          target: cap.id,
          message: `能力 id 含非法字符（允许 [A-Za-z0-9._-]）`,
          hint: 'AI 入口工具名派生自 id，非法字符会被模型侧拒绝',
        });
      }
      if (cap.id.includes('__')) {
        push({
          id: 'capability.id',
          level: 'error',
          target: cap.id,
          message: 'id 含 "__"，会破坏工具名 `.`↔`__` 双射（handleToolCall 反解歧义）',
          hint: '改用单下划线或点分层级',
        });
      }
      const toolName = cap.id.replace(/\./g, '__');
      const clash = toolNames.get(toolName);
      if (clash) {
        push({
          id: 'capability.tool-name-clash',
          level: 'error',
          target: cap.id,
          message: `与能力 ${clash} 派生出相同工具名 ${toolName}`,
          hint: 'AI 入口下两个能力将不可区分，重命名其一',
        });
      }
      toolNames.set(toolName, cap.id);
    });

    guard('capability.description', cap.id, () => {
      if (!cap.description || cap.description.trim().length < 15) {
        push({
          id: 'capability.description',
          level: 'warn',
          target: cap.id,
          message: 'description 过短——它逐字进 AI 工具目录，是模型"何时该调"的唯一依据',
          hint: '写清适用场景、副作用与撤销性（≥15 字）',
        });
      }
    });

    guard('capability.schema', cap.id, () => {
      // describe 内部做 Zod→JSON Schema 派生；不可派生的 schema 在这里暴露而非首次 tools/list 时
      kernel.registry.describe(cap.id);
    });

    guard('capability.kind', cap.id, () => {
      if (cap.kind !== 'write' && cap.undoable === true) {
        push({
          id: 'capability.kind',
          level: 'warn',
          target: cap.id,
          message: `kind=${cap.kind} 却声明 undoable=true（read/action 不产生撤销单元）`,
          hint: '撤销语义只属于 write 能力',
        });
      }
    });

    guard('capability.requires', cap.id, () => {
      for (const key of cap.requires ?? []) {
        if (kernel.services.get(key) === undefined) {
          push({
            id: 'capability.requires',
            level: 'error',
            target: cap.id,
            message: `声明依赖的服务 "${key}" 未注册`,
            hint: `createKernel({ services: { ${key}: ... } }) 注入，否则 invoke 必失败（service_missing）`,
          });
        }
      }
    });
  }

  // ---- 工作流 ----
  for (const wf of workflows) {
    guard('workflow.step-ref', wf.id, () => {
      const seen = new Set<string>();
      for (const step of wf.steps) {
        if (seen.has(step.id)) {
          push({
            id: 'workflow.step-id',
            level: 'error',
            target: wf.id,
            message: `步骤 id 重复: ${step.id}（scope.steps 数据流会被覆盖）`,
          });
        }
        seen.add(step.id);
        if (!kernel.registry.has(step.capability)) {
          push({
            id: 'workflow.step-ref',
            level: 'error',
            target: wf.id,
            message: `步骤 ${step.id} 引用未注册能力: ${step.capability}`,
            hint: '注册对应能力包，或修正 capability id',
          });
        }
      }
    });

    guard('workflow.macro', wf.id, () => {
      if (wf.undo !== 'macro') return;
      const hasWrite = wf.steps.some(
        (s) => kernel.registry.get(s.capability)?.kind === 'write',
      );
      if (!hasWrite) {
        push({
          id: 'workflow.macro',
          level: 'warn',
          target: wf.id,
          message: "undo:'macro' 但无任何 write 步——宏事务组恒为空提交",
          hint: "纯读/action 工作流用 undo:'none'",
        });
      }
    });
  }

  // ---- 端口冒烟（非侵入：不 dispatch）----
  guard('engine.snapshot', undefined, () => {
    const snap = kernel.engine.snapshot();
    if (!snap || typeof snap.entities?.forEach !== 'function') {
      push({
        id: 'engine.snapshot',
        level: 'error',
        message: 'engine.snapshot() 未返回 { entities: ReadonlyMap }',
        hint: '检查 StateEngine 实现是否符合端口契约',
      });
    }
  });

  guard('engine.transaction-hook', undefined, () => {
    const off = kernel.engine.onTransaction(() => {});
    if (typeof off !== 'function') {
      push({
        id: 'engine.transaction-hook',
        level: 'error',
        message: 'engine.onTransaction() 未返回解绑函数',
        hint: 'dispose 依赖它解除事件桥接，泄漏订阅会导致内存增长',
      });
    } else {
      off();
    }
  });

  guard('algebra.merge-empty', undefined, () => {
    try {
      kernel.algebra.merge([], 'doctor-smoke');
    } catch (e) {
      push({
        id: 'algebra.merge-empty',
        level: 'warn',
        message: `DiffAlgebra.merge([]) 抛异常: ${e instanceof Error ? e.message : String(e)}`,
        hint: '空合并应返回空 diff——空工作流 commit 会走到这条路径',
      });
    }
  });

  // ---- 权限裁剪预览（可选）----
  if (opts.caller) {
    guard('permissions.trim-preview', undefined, () => {
      const visible = new Set(
        kernel.describeAll({ caller: opts.caller }).map((d) => d.id),
      );
      const hidden = caps.filter((c) => !visible.has(c.id)).map((c) => c.id);
      if (hidden.length > 0) {
        push({
          id: 'permissions.trim-preview',
          level: 'warn',
          message: `该调用方（entry=${opts.caller!.entry}）看不见 ${hidden.length} 个能力: ${hidden.join(', ')}`,
          hint: '若非预期，检查 grantedPermissions 与能力 permissions 声明',
        });
      }
    });
  }

  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  if (errors === 0 && warnings === 0) {
    push({ id: 'doctor.ok', level: 'ok', message: '装配体检通过：未发现问题' });
  }

  return {
    ok: errors === 0,
    errors,
    warnings,
    checks,
    summary: { capabilities: caps.length, workflows: workflows.length },
  };
}

/** 报告 → 人可读文本（CLI/日志/playground 直接打印）。 */
export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: '✔', warn: '⚠', error: '✘' } as const;
  const lines = [
    `SAR doctor：${report.ok ? '通过' : '未通过'}（${report.errors} 错误 / ${report.warnings} 警告；能力 ${report.summary.capabilities}，工作流 ${report.summary.workflows}）`,
    ...report.checks.map(
      (c) =>
        `${icon[c.level]} [${c.id}]${c.target ? ` ${c.target}` : ''} ${c.message}${c.hint ? `\n    ↳ ${c.hint}` : ''}`,
    ),
  ];
  return lines.join('\n');
}
