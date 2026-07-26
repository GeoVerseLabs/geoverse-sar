/**
 * 洞族能力组（阶段二 T8）：punchHole / fillHole / openHole / closeHole。
 * 全部为面要素的就地修改（modified before/after，可撤销），实现走 engine-geo
 * 几何桥的 editor-core 纯算子（RFC-0004「非分离切」语义：openHole 通道并湾、
 * closeHole 一键封全部凹湾，与 punch/fill 结构性插环/移环互补）。
 */
import { z } from 'zod';
import type { Capability, Command } from '@geoverse-sar/kernel';
import {
  closeHole,
  fillHoles,
  openHole,
  punchHole,
  type ChangeSet,
  type EditableFeature,
} from '@geoverse-sar/engine-geo';
import type { Geometry, LineString, MultiPolygon, Polygon, Position } from 'geojson';
import { positionSchema as coordSchema } from '@geoverse-sar/geo-profile';

type GeoCapability<I, O> = Capability<I, O, EditableFeature, ChangeSet>;
type GeoCommand = Command<EditableFeature, ChangeSet>;

let txSeq = 0;
const nextTxId = (): string =>
  `hole-tx-${Date.now().toString(36)}-${(++txSeq).toString(36)}`;
const countOutput = z.object({ count: z.number() });
const okOutput = z.object({ ok: z.boolean() });

function requirePolygon(f: EditableFeature, capability: string): Polygon {
  if (f.geometry.type !== 'Polygon') {
    throw new Error(`${capability} 只支持 Polygon，要素 ${f.id} 是 ${f.geometry.type}`);
  }
  return f.geometry as Polygon;
}

/** 单要素就地几何修改的命令骨架。 */
function modifyCommand(
  label: string,
  id: string,
  apply: (f: EditableFeature) => Geometry,
): GeoCommand {
  return {
    label,
    plan: (state) => {
      const f = state.get(id);
      if (!f) throw new Error(`要素不存在: ${id}`);
      return {
        txId: nextTxId(),
        label,
        added: [],
        removed: [],
        modified: [
          {
            id,
            before: structuredClone(f.geometry) as Geometry,
            after: apply(f),
          },
        ],
      };
    },
  };
}

function closedRing(coords: Position[]): Position[] {
  const ring = [...coords];
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  if (ring.length < 4) throw new Error('洞外环闭合后至少 4 个坐标');
  return ring;
}

// ---- features.punchHole（结构性挖洞：洞环插入内环）----

const punchInput = z.object({
  id: z.string().describe('目标面要素 id'),
  hole: z
    .array(coordSchema)
    .min(3)
    .describe('洞的外环顶点 [[x,y],...]（须完全落在面内、不与既有洞相交；自动闭合）'),
});

const punch: GeoCapability<z.infer<typeof punchInput>, z.infer<typeof okOutput>> = {
  id: 'features.punchHole',
  title: '挖洞',
  description:
    '在面要素内部挖一个洞（给洞的外环顶点，须完全落在面内且不碰既有洞）。外边界保持精确不变；写操作、可撤销；填回用 features.fillHole。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'hole'],
  inputSchema: punchInput,
  outputSchema: okOutput,
  handler: async (_ctx, input) => ({
    output: { ok: true },
    commands: [
      modifyCommand('挖洞', input.id, (f) =>
        punchHole(requirePolygon(f, 'features.punchHole'), {
          type: 'Polygon',
          coordinates: [closedRing(input.hole)],
        }),
      ),
    ],
  }),
};

// ---- features.fillHole（填洞：移除全部内环）----

const fillInput = z.object({
  ids: z.array(z.string()).min(1).describe('要填洞的面要素 id（无洞的会报错）'),
});

const fill: GeoCapability<z.infer<typeof fillInput>, z.infer<typeof countOutput>> = {
  id: 'features.fillHole',
  title: '填洞',
  description:
    '移除面要素的全部内环（洞），只留外边界——挖洞的逆操作。要素本身无洞会报错。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'hole'],
  inputSchema: fillInput,
  outputSchema: countOutput,
  handler: async (_ctx, input) => {
    const cmd: GeoCommand = {
      label: '填洞',
      plan: (state) => ({
        txId: nextTxId(),
        label: '填洞',
        added: [],
        removed: [],
        modified: input.ids.map((id) => {
          const f = state.get(id);
          if (!f) throw new Error(`要素不存在: ${id}`);
          if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') {
            throw new Error(
              `features.fillHole 只支持面要素，${id} 是 ${f.geometry.type}`,
            );
          }
          const { geometry, hadHole } = fillHoles(f.geometry as Polygon | MultiPolygon);
          if (!hadHole) throw new Error(`要素 ${id} 没有洞，无需填`);
          return {
            id,
            before: structuredClone(f.geometry) as Geometry,
            after: geometry,
          };
        }),
      }),
    };
    return { output: { count: input.ids.length }, commands: [cmd] };
  },
};

// ---- features.openHole（开洞：切割线把洞连通到外边界成凹湾，洞 -1）----

const openInput = z.object({
  id: z.string().describe('目标面要素 id（须至少有一个洞）'),
  cut: z
    .array(coordSchema)
    .min(2)
    .describe('切割线顶点：从面的外边界外侧进入某个洞内（勿贯穿到对侧外边界）'),
  width: z
    .number()
    .positive()
    .optional()
    .describe('通道宽度（CRS 单位）；缺省按面 bbox 对角线 0.5% 自适应'),
});

const open: GeoCapability<z.infer<typeof openInput>, z.infer<typeof okOutput>> = {
  id: 'features.openHole',
  title: '开洞成湾',
  description:
    '用一条切割线把面内的洞经通道连到外边界，洞变成外边界上的凹湾（面仍是一块、少一个洞）。切割线须从外边界进入洞内。写操作、可撤销；逆操作是 features.closeHole。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'hole'],
  inputSchema: openInput,
  outputSchema: okOutput,
  handler: async (_ctx, input) => ({
    output: { ok: true },
    commands: [
      modifyCommand('开洞成湾', input.id, (f) =>
        openHole(
          requirePolygon(f, 'features.openHole'),
          { type: 'LineString', coordinates: input.cut } as LineString,
          input.width !== undefined ? { width: input.width } : undefined,
        ),
      ),
    ],
  }),
};

// ---- features.closeHole（消洞：一键把全部凹湾封回内环洞）----

const closeInput = z.object({
  id: z.string().describe('目标面要素 id（外边界须有凹湾/缺口）'),
  width: z
    .number()
    .positive()
    .optional()
    .describe('封口墙宽度（CRS 单位）；缺省按面 bbox 对角线 0.5% 自适应'),
});

const close: GeoCapability<z.infer<typeof closeInput>, z.infer<typeof okOutput>> = {
  id: 'features.closeHole',
  title: '封湾成洞',
  description:
    '一键把面外边界上的所有凹湾（缺口）封回成内环洞——features.openHole 的逆操作，无需给任何交互参数。外边界是凸的（无凹湾）会报错；若只是想去掉洞请用 features.fillHole。写操作、可撤销。',
  category: 'edit',
  kind: 'write',
  tags: ['features', 'write', 'hole'],
  inputSchema: closeInput,
  outputSchema: okOutput,
  handler: async (_ctx, input) => ({
    output: { ok: true },
    commands: [
      modifyCommand('封湾成洞', input.id, (f) =>
        closeHole(
          requirePolygon(f, 'features.closeHole'),
          input.width !== undefined ? { width: input.width } : undefined,
        ),
      ),
    ],
  }),
};

/** T8 洞族能力组。 */
export const holeCapabilities = [punch, fill, open, close];
