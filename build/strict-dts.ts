/**
 * d.ts 严格失败门（Gate 0 / G0-2）：vite-plugin-dts 默认只打印诊断不改退出码——
 * 声明生成阶段的 TS 错误会被吞成"假绿构建"（2026-07-11 外部复评 P0-4 实测：
 * kernel build 打印 TS2591/TS2503 仍退出 0）。本包装器让任一 error 级诊断直接抛错，
 * 使 `vite build` 非零退出。所有包统一经此创建 dts 插件，不要直接用裸 dts()。
 */
import ts from 'typescript';
import dts from 'vite-plugin-dts';
import type { PluginOptions } from 'vite-plugin-dts';

export function strictDts(options?: PluginOptions): ReturnType<typeof dts> {
  return dts({
    tsconfigPath: './tsconfig.build.json',
    include: ['src'],
    bundleTypes: false,
    ...options,
    afterDiagnostic(diagnostics) {
      const errors = diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (errors.length === 0) return;
      const lines = errors.map((d) => {
        const loc =
          d.file && d.start !== undefined
            ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
            : '';
        return `  ${loc}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n    ')}`;
      });
      throw new Error(
        `[strict-dts] d.ts 生成存在 ${errors.length} 个类型错误（禁止假绿）：\n${lines.join('\n')}`,
      );
    },
  });
}
