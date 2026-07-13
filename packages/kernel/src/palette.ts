import type { CapabilityKind, EffectDescriptor } from './capability';
import type { CapabilityRegistry, DescribeFilter } from './registry';
import type { JsonSchema } from './schema-utils';

/** 无头命令面板条目：与 AI ToolSpec 同源（同一 inputJsonSchema 驱动表单）。 */
export interface PaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: CapabilityKind;
  /** 效应元数据（G1-2）：UI 据此给"需审批/不可逆/外部副作用"徽章。 */
  effects: EffectDescriptor;
  undoable: boolean;
  inputJsonSchema: JsonSchema;
}

export function toPaletteItems(
  registry: CapabilityRegistry,
  filter: DescribeFilter = {},
): PaletteItem[] {
  return registry.describeAll(filter).map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    kind: d.kind,
    effects: d.effects,
    undoable: d.undoable ?? false,
    inputJsonSchema: d.inputJsonSchema,
  }));
}
