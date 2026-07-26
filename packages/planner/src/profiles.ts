/**
 * prompt profile 拼装（U5-D，RFC-0012）：把能力包随包携带的「用法要点」
 * 在 planner **构造期**渲染进 system——目录/schema 仍由描述符投影负责，
 * profile 只补"何时怎么用"的经验层（细化设计一 B4 边界）。
 *
 * 边界在此强制（作者错误 fail-fast，不静默截断）：
 * - usageNotes ≤ 800 字；fewShot ≤ 3 条；
 * - 不做任何目录复述——渲染只包含作者写的内容。
 */
import type { PackPromptProfile } from '@geoverse-sar/kernel';

export const USAGE_NOTES_MAX = 800;
export const FEW_SHOT_MAX = 3;

/** 校验并渲染 profiles 为 system 附加段；空数组返回空串（system 逐字节不变）。 */
export function renderPromptProfiles(profiles: readonly PackPromptProfile[]): string {
  if (!profiles.length) return '';
  const sections = profiles.map((p) => {
    if (p.usageNotes && p.usageNotes.length > USAGE_NOTES_MAX) {
      throw new Error(
        `prompt profile [${p.packId}] usageNotes 超限（${p.usageNotes.length} > ${USAGE_NOTES_MAX} 字）——精炼要点，别复述目录`,
      );
    }
    if (p.fewShot && p.fewShot.length > FEW_SHOT_MAX) {
      throw new Error(
        `prompt profile [${p.packId}] few-shot 超限（${p.fewShot.length} > ${FEW_SHOT_MAX} 条）`,
      );
    }
    const lines = [`【能力包用法提示 · ${p.packId}】`];
    if (p.usageNotes) lines.push(p.usageNotes.trim());
    for (const shot of p.fewShot ?? []) {
      const note = shot.note ? `（${shot.note}）` : '';
      lines.push(`示例：${shot.capabilityId} ← ${JSON.stringify(shot.input)}${note}`);
    }
    return lines.join('\n');
  });
  return sections.join('\n\n');
}
