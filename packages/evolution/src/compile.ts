/**
 * 草稿编译（L2 第三步）：声明式 WorkflowDraft（纯 JSON）→ kernel Workflow。
 * 模板引用在**运行时**对 scope 求值：
 *   "$input"              → 整个工作流入参
 *   "$input.a.b"          → 入参字段路径
 *   "$steps.s1"           → 步骤 s1 的完整输出
 *   "$steps.s1.a.b"       → 步骤输出字段路径
 *   路径段 "*"             → 数组投影（如 "$steps.find.records.*.id" → id 数组）
 *   "$$..."               → 字面 "$..."（转义）
 */
import { z } from 'zod';
import type { Workflow, WorkflowScope } from '@geoverse-sar/kernel';
import type { WorkflowDraft } from './types';

function pathGet(value: unknown, path: string[]): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (head === '*') {
    return Array.isArray(value) ? value.map((v) => pathGet(v, rest)) : undefined;
  }
  if (value == null || typeof value !== 'object') return undefined;
  return pathGet((value as Record<string, unknown>)[head], rest);
}

/** 解析单个字符串模板；非模板返回原值。 */
function resolveString(text: string, scope: WorkflowScope): unknown {
  if (text.startsWith('$$')) return text.slice(1);
  if (text === '$input') return scope.input;
  if (text.startsWith('$input.')) {
    return pathGet(scope.input, text.slice('$input.'.length).split('.'));
  }
  if (text.startsWith('$steps.')) {
    const parts = text.slice('$steps.'.length).split('.');
    const [stepId, ...rest] = parts;
    return pathGet(scope.steps[stepId], rest);
  }
  return text;
}

export function resolveTemplate(template: unknown, scope: WorkflowScope): unknown {
  if (typeof template === 'string') return resolveString(template, scope);
  if (Array.isArray(template)) return template.map((v) => resolveTemplate(v, scope));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) out[k] = resolveTemplate(v, scope);
    return out;
  }
  return template;
}

const FIELD_TYPES = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
} as const;

/**
 * 编译成 kernel Workflow：undo 固定 'macro'（合成物的爆炸半径由宏撤销兜住），
 * tags 带 'synthesized' 供目录/UI 识别来源。
 */
export function compileDraft(draft: WorkflowDraft): Workflow {
  const shape: Record<string, z.ZodType> = {};
  for (const [field, type] of Object.entries(draft.inputFields ?? {})) {
    shape[field] = FIELD_TYPES[type]();
  }
  return {
    id: draft.id,
    title: draft.title,
    description: draft.description,
    category: 'workflow',
    inputSchema: z.object(shape),
    steps: draft.steps.map((s) => ({
      id: s.id,
      capability: s.capability,
      input:
        s.input === undefined
          ? undefined
          : (scope: WorkflowScope) => resolveTemplate(s.input, scope),
    })),
    undo: 'macro',
    tags: ['synthesized'],
  };
}

/**
 * 静态引用检查（不跑 LLM 不碰内核）：步 id 唯一、$steps 只引用**更早**的步、
 * $input 字段已在 inputFields 声明。返回问题清单（空=通过）。
 */
export function checkDraftReferences(draft: WorkflowDraft): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const fields = new Set(Object.keys(draft.inputFields ?? {}));

  const walk = (value: unknown, stepId: string): void => {
    if (typeof value === 'string') {
      if (value.startsWith('$$')) return;
      if (value.startsWith('$input.')) {
        const field = value.slice('$input.'.length).split('.')[0];
        if (!fields.has(field)) {
          issues.push(`步 ${stepId}：$input.${field} 未在 inputFields 声明`);
        }
      } else if (value.startsWith('$steps.')) {
        const ref = value.slice('$steps.'.length).split('.')[0];
        if (!seen.has(ref)) {
          issues.push(`步 ${stepId}：$steps.${ref} 引用了不存在或更晚的步`);
        }
      }
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, stepId);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v, stepId);
    }
  };

  for (const step of draft.steps) {
    if (seen.has(step.id)) issues.push(`步 id 重复: ${step.id}`);
    walk(step.input, step.id);
    seen.add(step.id);
  }
  return issues;
}
