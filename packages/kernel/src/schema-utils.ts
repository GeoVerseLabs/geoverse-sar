import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

/**
 * Zod → JSON Schema（zod v4 内置 toJSONSchema，无需 zod-to-json-schema 依赖）。
 * 这份 JSON Schema 是唯一序列化边界：同一份背 UI 命令面板 / AI tool 规格 /（M2）MCP tools/list。
 */
export function inputJsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

export function outputJsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
}

/** 校验失败时回给调用方（尤其 AI 自纠）的结构化 issue。 */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
}
