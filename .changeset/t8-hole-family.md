---
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/capabilities-geo': patch
---

洞族能力组（阶段二 T8）：features.punchHole（结构性挖洞，外边界精确不变）/ fillHole（移除全部内环，无洞报错）/ openHole（切割线把洞连通到外边界成凹湾，RFC-0004 非分离切）/ closeHole（一键封全部凹湾成洞，凸面明确拒绝）——均为 modified 就地修改可撤销；engine-geo 桥补导出 punchHole/fillHoles/openHole/closeHole。配套跨仓小改：editor-core index 补导出纯函数 punchHole/fillHoles（此前只导出 Command 形态）。
