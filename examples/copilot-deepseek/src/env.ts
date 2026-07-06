import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 极简 .env 读取（零依赖）：环境变量优先，缺省回退仓根 sar/.env。 */
export function loadEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const text = readFileSync(resolve(import.meta.dirname, '../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && m[1] === key) return m[2];
    }
  } catch {
    // 无 .env 文件
  }
  return undefined;
}
