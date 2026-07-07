---
'@geoverse-sar/engine-geo': patch
'@geoverse-sar/capabilities-geo': patch
'@geoverse-sar/planner': patch
---

M2 收尾（二）+ M3：capabilities-geo 新增 features.draw（画线/画面）、features.split（线打断/面按线切分）、features.merge（线相接/面并集）——editor-core 几何算子经 engine-geo 几何桥映射为能力；view.setBase 底图切换（GeoViewService 可选 setBase/listBases）。新包 @geoverse-sar/planner：NL→能力路由 tool-use 循环（describeAll 当目录，内核 NL-free）+ OpenAI 兼容 SSE 流式客户端 + 无头聊天控制器 createChatController。
