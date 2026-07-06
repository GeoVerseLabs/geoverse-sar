import type { Command, ReadonlyEntityState } from '@geoverse-sar/kernel';
import {
  cloneRecord,
  type RecordDiff,
  type RecordEntity,
} from '@geoverse-sar/engine-memory';

/** 纯 planner（ADR-0010）：只算 diff，不改状态；应用/撤销由引擎负责。 */

export class AddRecordsCommand implements Command<RecordEntity, RecordDiff> {
  constructor(
    private readonly records: RecordEntity[],
    readonly label = '新增记录',
  ) {}

  plan(state: ReadonlyEntityState<RecordEntity>): RecordDiff {
    for (const r of this.records) {
      if (state.has(r.id)) throw new Error(`记录 id 已存在: ${r.id}`);
    }
    return {
      label: this.label,
      added: this.records.map(cloneRecord),
      removed: [],
      modified: [],
    };
  }
}

export class TranslateRecordsCommand implements Command<RecordEntity, RecordDiff> {
  constructor(
    private readonly ids: string[],
    private readonly dx: number,
    private readonly dy: number,
    readonly label = '平移记录',
  ) {}

  plan(state: ReadonlyEntityState<RecordEntity>): RecordDiff {
    return {
      label: this.label,
      added: [],
      removed: [],
      modified: this.ids.map((id) => {
        const before = state.get(id);
        if (!before) throw new Error(`记录不存在: ${id}`);
        return {
          id,
          before: cloneRecord(before),
          after: { ...cloneRecord(before), x: before.x + this.dx, y: before.y + this.dy },
        };
      }),
    };
  }
}

export class SetPropsCommand implements Command<RecordEntity, RecordDiff> {
  constructor(
    private readonly ids: string[],
    private readonly props: Record<string, unknown>,
    readonly label = '设置属性',
  ) {}

  plan(state: ReadonlyEntityState<RecordEntity>): RecordDiff {
    return {
      label: this.label,
      added: [],
      removed: [],
      modified: this.ids.map((id) => {
        const before = state.get(id);
        if (!before) throw new Error(`记录不存在: ${id}`);
        return {
          id,
          before: cloneRecord(before),
          after: { ...cloneRecord(before), props: { ...before.props, ...this.props } },
        };
      }),
    };
  }
}

export class RemoveRecordsCommand implements Command<RecordEntity, RecordDiff> {
  constructor(
    private readonly ids: string[],
    readonly label = '删除记录',
  ) {}

  plan(state: ReadonlyEntityState<RecordEntity>): RecordDiff {
    return {
      label: this.label,
      added: [],
      removed: this.ids.map((id) => {
        const before = state.get(id);
        if (!before) throw new Error(`记录不存在: ${id}`);
        return cloneRecord(before);
      }),
      modified: [],
    };
  }
}
