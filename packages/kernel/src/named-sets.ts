/**
 * 命名结果集（阶段四 U3-C，RFC-0010 §五）——agent 的"变量系统"：
 * read 能力把命中结果存成会话级句柄（setId），回包只带 {setId, count, summary, sample}；
 * 写能力的 target 用 setId 指代——LLM 以**组合引用**而非幻觉 id/坐标指代对象，
 * token 消耗、审计可追溯性（target 落审计入参）、dryRun diff 体积同时受益。
 *
 * 会话级、不持久（journal 只录 diff；集合是指代不是状态）；跨会话请重新查询。
 * kernel 恒注入内建实现（服务键 runtime.sets，宿主同键可覆写）。
 */

export const SETS_SERVICE_KEY = 'runtime.sets';

export interface NamedSet {
  setId: string;
  ids: string[];
  /** 人可读来历（如「features.query 命中 128 条」）——审计与 UI 展示用。 */
  summary?: string;
}

export interface NamedSetService {
  save(ids: string[], summary?: string): string;
  get(setId: string): NamedSet | undefined;
  list(): NamedSet[];
}

export function createNamedSets(): NamedSetService {
  let seq = 0;
  const sets = new Map<string, NamedSet>();
  return {
    save(ids, summary) {
      const setId = `set_${++seq}`;
      sets.set(setId, { setId, ids: [...ids], ...(summary ? { summary } : {}) });
      return setId;
    },
    get(setId) {
      const s = sets.get(setId);
      return s ? { ...s, ids: [...s.ids] } : undefined;
    },
    list() {
      return [...sets.values()].map((s) => ({ ...s, ids: [...s.ids] }));
    },
  };
}
