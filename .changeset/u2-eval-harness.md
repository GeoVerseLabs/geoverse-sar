---
'@geoverse-sar/eval': patch
'@geoverse-sar/capabilities-geo': patch
---

阶段四 U2「评测闭环」（RFC-0011）：新包 `@geoverse-sar/eval`——scenario（装配工厂+脚本化/goal 计划+**声明式断言**，白名单靠构造）+ runner（审计经中间件注入不旁路漏斗；终态规范化 FNV-1a stateHash，跑三遍逐字节相同=确定性判据）+ `createScriptedLlm`。scenario 集 12 个（records 8 + geo 4）；evolution L2 合成 enable 准入门端到端（劣化合成物被判红停 pending）。capabilities-geo 增 geo 域 scenario 集（devDep eval）。
