---
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/capabilities-geo': patch
---

几何变换能力组（阶段二 T7）：features.rotate（度，逆时针正，缺省绕所选集合 bbox 中心）/ scale（factor+可选 factorY，0 拒绝）/ mirror（过 a、b 两点直线翻转）——modified before/after 可撤销；features.buffer（点圆/线走廊/面外扩内缩，JSTS）/ offset（线平行偏移，斜接法向）——派生新要素继承属性、原要素保留。engine-geo 几何桥补导出 rotateGeometry/scaleGeometry/mirrorGeometry/bufferGeometry/offsetLine。
