/** 入口类型：同一 Runtime 的不同入口只以此区分（RFC-0008）。 */
export type EntryKind = 'program' | 'ui' | 'ai' | 'mcp' | 'agent';

export interface CallerInfo {
  entry: EntryKind;
  /** 主体标识（会话/用户/agent id），审计用。 */
  id?: string;
  /**
   * 已授权限集。`undefined` = 宿主自身调用、全授；
   * 显式给数组则按白名单裁剪（describeAll 目录裁剪 + invoke 强制同一判定）。
   */
  grantedPermissions?: readonly string[];
}

export const PROGRAM_CALLER: CallerInfo = { entry: 'program' };

export function isGranted(
  required: readonly string[] | undefined,
  caller: CallerInfo,
): boolean {
  if (!required || required.length === 0) return true;
  const granted = caller.grantedPermissions;
  if (granted === undefined) return true;
  return required.every((p) => granted.includes(p));
}
