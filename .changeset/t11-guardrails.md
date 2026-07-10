---
'@geoverse-sar/kernel': patch
---

guardrails 中间件工厂（阶段二 T11，RFC-0009 F3）：`createGuardrails({ maxWritesPerRun, bboxFence, propertyPolicy })`——read 不拦、write/action 过闸的输入级防线：写预算（reset() 开新窗口、dryRun 不计）、坐标围栏（入参深扫 [x,y] 数组与 {x,y} 对象）、受保护字段（入参深层键名匹配即拒）；拒绝走 permission_denied 同栈可审计；启发式预检定位，不替代权限与领域校验。
