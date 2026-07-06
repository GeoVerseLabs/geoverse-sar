import { SarError } from './errors';

/** 宿主注入的领域服务定位器（如 view 服务）；内核不关心其形状。 */
export interface Services {
  get<T>(key: string): T | undefined;
  require<T>(key: string): T;
}

export function createServices(entries: Record<string, unknown> = {}): Services {
  const map = new Map(Object.entries(entries));
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    require<T>(key: string): T {
      if (!map.has(key)) {
        throw new SarError('handler_error', `服务未注册: ${key}`);
      }
      return map.get(key) as T;
    },
  };
}
