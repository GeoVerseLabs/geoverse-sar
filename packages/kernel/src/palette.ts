import type { CapabilityKind } from './capability';
import type { CapabilityRegistry, DescribeFilter } from './registry';
import type { JsonSchema } from './schema-utils';

/** 无头命令面板条目：与 AI ToolSpec 同源（同一 inputJsonSchema 驱动表单）。 */
export interface PaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: CapabilityKind;
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
    undoable: d.undoable ?? false,
    inputJsonSchema: d.inputJsonSchema,
  }));
}
