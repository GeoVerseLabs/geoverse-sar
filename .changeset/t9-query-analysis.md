---
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/capabilities-geo': patch
---

查询与分析组（阶段二 T9）：features.query 谓词升级（where 条件数组映射 RFC-0007 eq/neq/gt/lt/range/oneOf/contains + and/or 组合，走 editor-core queryFeatures）；新增 props.schema（inferSchema 字段概览）/ features.validate（按推断 Schema 校验属性）/ measure.length（线长/面周长）/ measure.area（鞋带公式，洞扣除）/ spatial.distance·nearest·within（一期中心点/bbox 级，平面欧氏，description 明示）。engine-geo 桥补导出谓词组合子 + inferSchema/validateValue/lineLength。
